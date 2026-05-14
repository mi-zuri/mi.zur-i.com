# [mi.zur-i.com](https://mi.zur-i.com)

Personal website of Michał Żurawski.

---

![mi.zur-i landing page](docs/images/preview.png)

---

## Run locally

```bash
bunx serve .
```

Update projects list:

```
GITHUB_TOKEN=xxx OUT_PATH="./data/projects.json" bun scripts/fetch-projects.mjs
```

## Structure

Plain HTML/CSS/JS — no build step.

```
index.html      home
tech.html       projects (reads /data/projects.json)
music.html      music
css/  js/       per-page modules
scripts/        server-side fetch script
.github/        deploy workflow
```

## Deploy

GitHub Actions (`.github/workflows/deploy.yml`) rsyncs to the EC2 host on push to `main`.

## `/tech` data flow

How are GitHub projects fetched? An hourly cron on the host pre-fetches and saves a static JSON file the browser reads.

1. **Cron** runs `scripts/fetch-projects.mjs`: queries GitHub for repos, picks a non-badge hero image from each README, gets language breakdowns, and atomically writes `/var/www/mi.zur-i.com/data/projects.json`.
2. **nginx** serves it at `/data/projects.json`.
3. **Browser** does one `fetch("/data/projects.json")` and renders cards.

**Force-refresh** before the next hour: SSH in and run `bun /var/www/mi.zur-i.com/scripts/fetch-projects.mjs` with `/etc/mi.zur-i.com/env` sourced.
