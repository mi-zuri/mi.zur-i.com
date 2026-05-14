#!/usr/bin/env node
// Fetch GitHub repos (owned + contributed + org-committed) with preview
// images and language breakdowns. Writes a JSON snapshot atomically
// (tmp + rename) so nginx never serves a half-written file. Designed to
// run hourly via cron.
//
// Env:
//   GH_USER         (default "mi-zuri") — owner of the repo listing
//   GH_CONTRIB_USER (default GH_USER) — login used for the contributions
//                                       query; set when GH_USER is an org
//   OUT_PATH        (default "/var/www/mi.zur-i.com/data/projects.json")
//   GITHUB_TOKEN    required for contributions (GraphQL refuses anonymous);
//                   raises rate limit 60 → 5000/hr. For *private* org
//                   memberships, needs `read:org` (classic PAT) or
//                   "Members: Read" (fine-grained PAT).
//   README_CONCURRENCY  max parallel side-call fetches (default 6)

import { writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const GH_USER = process.env.GH_USER || "mi-zuri";
const GH_CONTRIB_USER = process.env.GH_CONTRIB_USER || GH_USER;
const OUT_PATH = process.env.OUT_PATH || "/var/www/mi.zur-i.com/data/projects.json";
const TOKEN = process.env.GITHUB_TOKEN;
const README_CONCURRENCY = Number(process.env.README_CONCURRENCY) || 6;

const headers = {
  "user-agent": "mi.zur-i-fetch",
  accept: "application/vnd.github+json",
  ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
};
const publicHeaders = {
  "user-agent": "mi.zur-i-fetch",
  accept: "application/vnd.github+json",
};

const PREVIEW_RE = /^preview\.(png|jpe?g|gif|webp|svg|avif)$/i;

// Some orgs forbid PATs that violate their policy (e.g. lifetime cap),
// returning 401/403 on **every** call — even read-only public ones. Retry
// once unauthenticated so we degrade to the anonymous rate limit instead
// of losing the data.
async function fetchPublic(url) {
  const res = await fetch(url, { headers });
  if (res.ok || !TOKEN || (res.status !== 401 && res.status !== 403)) return res;
  return fetch(url, { headers: publicHeaders });
}

async function getJSON(url, fallback) {
  try {
    const res = await fetchPublic(url);
    if (!res.ok) return fallback;
    return await res.json();
  } catch {
    return fallback;
  }
}

// Bounded parallelism — keeps a 100-repo account from fanning out into
// 100 sockets at once.
async function mapWithLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

function slimRepo(r, languages) {
  return {
    name: r.name,
    full_name: r.full_name,
    description: r.description,
    language: r.language,
    languages: languages || [],
    homepage: r.homepage,
    html_url: r.html_url,
    updated_at: r.updated_at,
  };
}

async function fetchLanguages(repo) {
  const data = await getJSON(
    `https://api.github.com/repos/${repo.owner.login}/${repo.name}/languages`,
    {},
  );
  return Object.entries(data)
    .sort((a, b) => b[1] - a[1])
    .map(([lang]) => lang);
}

async function fetchPreviewImage(repo) {
  const data = await getJSON(
    `https://api.github.com/repos/${repo.owner.login}/${repo.name}/contents/docs/images`,
    null,
  );
  if (!Array.isArray(data)) return null;
  return (
    data.find((f) => f.type === "file" && PREVIEW_RE.test(f.name))?.download_url ?? null
  );
}

// GraphQL repositoriesContributedTo — REST has no equivalent and the
// Search API only sees merged PRs. Limited to GitHub's contribution-graph
// window; older contributions fall through to the org sweep below.
async function fetchContributedFullNames() {
  if (!TOKEN) {
    console.warn("no GITHUB_TOKEN; skipping contributions (GraphQL requires auth)");
    return [];
  }
  const query = `
    query($login: String!, $cursor: String) {
      user(login: $login) {
        repositoriesContributedTo(
          first: 100, after: $cursor, privacy: PUBLIC,
          includeUserRepositories: false,
          contributionTypes: [COMMIT, PULL_REQUEST, PULL_REQUEST_REVIEW, ISSUE]
        ) {
          pageInfo { hasNextPage endCursor }
          nodes { nameWithOwner isFork }
        }
      }
    }`;
  const names = [];
  let cursor = null;
  for (let page = 0; page < 10; page++) {
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ query, variables: { login: GH_CONTRIB_USER, cursor } }),
    });
    if (!res.ok) {
      console.warn(`graphql contributions responded ${res.status}; skipping`);
      return names;
    }
    const json = await res.json();
    if (json.errors) {
      console.warn(`graphql errors: ${JSON.stringify(json.errors)}`);
      return names;
    }
    const conn = json.data?.user?.repositoriesContributedTo;
    if (!conn) return names;
    for (const n of conn.nodes) if (!n.isFork) names.push(n.nameWithOwner);
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return names;
}

// Union of two org-listing endpoints: `/users/{login}/orgs` is public but
// only returns memberships marked public; `/user/orgs` (auth) catches
// private memberships but needs `read:org` scope. Either alone has a
// blind spot, so we merge them.
async function fetchUserOrgs() {
  const urls = [
    `https://api.github.com/users/${GH_CONTRIB_USER}/orgs?per_page=100`,
    ...(TOKEN ? [`https://api.github.com/user/orgs?per_page=100`] : []),
  ];
  const lists = await Promise.all(urls.map((u) => getJSON(u, [])));
  const orgs = Array.from(new Set(lists.flat().map((o) => o.login)));
  if (orgs.length === 0) {
    console.warn(
      TOKEN
        ? "no orgs found — token may lack `read:org` AND no public memberships set"
        : "no public orgs — set GITHUB_TOKEN with read:org for private memberships",
    );
  }
  return orgs;
}

// per_page=1 makes this a single-result probe; we only need to know
// whether *any* commit by the user exists.
async function userHasCommittedTo(repo) {
  const data = await getJSON(
    `https://api.github.com/repos/${repo.owner.login}/${repo.name}/commits?author=${encodeURIComponent(GH_CONTRIB_USER)}&per_page=1`,
    [],
  );
  return Array.isArray(data) && data.length > 0;
}

async function main() {
  const [ownedAllRaw, contribFullNamesRaw] = await Promise.all([
    fetch(
      `https://api.github.com/users/${GH_USER}/repos?sort=updated&per_page=100`,
      { headers },
    ).then(async (r) => {
      if (!r.ok) throw new Error(`github repos endpoint responded ${r.status}`);
      return r.json();
    }),
    fetchContributedFullNames(),
  ]);

  const ownRepos = ownedAllRaw.filter((r) => !r.fork);
  const ownFullNames = new Set(ownRepos.map((r) => r.full_name));

  const contribFullNames = contribFullNamesRaw.filter((fn) => !ownFullNames.has(fn));
  const contribReposRaw = await mapWithLimit(contribFullNames, README_CONCURRENCY, (fn) =>
    getJSON(`https://api.github.com/repos/${fn}`, null),
  );
  const contribRepos = contribReposRaw.filter((r) => r && !r.fork);

  // Org sweep catches contributions GraphQL has aged out — most importantly,
  // repos that were transferred from the user to an org.
  const seen = new Set([...ownFullNames, ...contribRepos.map((r) => r.full_name)]);
  const orgs = await fetchUserOrgs();
  const orgRepoLists = await mapWithLimit(orgs, README_CONCURRENCY, (org) =>
    getJSON(
      `https://api.github.com/orgs/${org}/repos?per_page=100&type=public&sort=updated`,
      [],
    ),
  );
  const orgCandidates = orgRepoLists.flat().filter((r) => {
    if (!r || r.fork || seen.has(r.full_name)) return false;
    seen.add(r.full_name);
    return true;
  });
  const orgCommitFlags = await mapWithLimit(
    orgCandidates,
    README_CONCURRENCY,
    userHasCommittedTo,
  );
  const orgRepos = orgCandidates.filter((_, i) => orgCommitFlags[i]);

  const repos = [...ownRepos, ...contribRepos, ...orgRepos].sort(
    (a, b) => new Date(b.updated_at) - new Date(a.updated_at),
  );

  const [images, languages] = await Promise.all([
    mapWithLimit(repos, README_CONCURRENCY, fetchPreviewImage),
    mapWithLimit(repos, README_CONCURRENCY, fetchLanguages),
  ]);

  const payload = {
    fetchedAt: new Date().toISOString(),
    repos: repos.map((r, i) => slimRepo(r, languages[i])),
    images,
  };

  await mkdir(dirname(OUT_PATH), { recursive: true });
  const tmp = `${OUT_PATH}.tmp`;
  await writeFile(tmp, JSON.stringify(payload), "utf8");
  await rename(tmp, OUT_PATH);

  console.log(
    `[${new Date().toISOString()}] wrote ${repos.length} repos (${ownRepos.length} owned + ${contribRepos.length} contributed + ${orgRepos.length} org-committed, ${images.filter(Boolean).length} with images) to ${OUT_PATH}`,
  );
}

main().catch((err) => {
  console.error(`[${new Date().toISOString()}] fetch failed:`, err);
  process.exit(1);
});
