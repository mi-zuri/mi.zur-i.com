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

Hosted on GCP: a Cloud Storage bucket behind a global HTTPS Load Balancer with Cloud CDN.
GitHub Actions (`.github/workflows/deploy.yml`) syncs static files to the bucket and
invalidates the CDN cache on push to `main`, authenticating via Workload Identity
Federation (no service-account keys).

## `/tech` data flow

How are GitHub projects fetched? An hourly **Cloud Scheduler** job pre-fetches and saves
a static JSON file the browser reads.

1. **Cloud Scheduler** triggers a **Cloud Run Job** (built from the root `Dockerfile`)
   hourly. It runs `scripts/fetch-projects.mjs`: queries GitHub for repos, picks a
   non-badge hero image from each README, gets language breakdowns, and uploads the
   snapshot straight to the bucket at `data/projects.json` (`GCS_BUCKET` env var).
2. **Cloud CDN** serves it at `/data/projects.json` (5-minute cache).
3. **Browser** does one `fetch("/data/projects.json")` and renders cards.

**Force-refresh** before the next hour:
`gcloud run jobs execute fetch-projects --region=<region>`.
