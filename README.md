# Search Intent Shift Interceptor (live)

Enter any site URL. The server finds its sitemap, scrapes the newest blog or guide posts, extracts their core technical topics, searches live developer conversations from the last 30 days (Reddit, GitHub issues, Hacker News, and X when a token is set), and scores how far each post has drifted from what developers are struggling with right now. Progress streams to the browser over Server-Sent Events.

## Run locally
```bash
npm install
cp .env.example .env    # optional: add keys
npm run build           # builds the React UI into dist/
npm start               # http://localhost:8787 (UI + API on one port)
```
Dev mode with hot reload: `npm start` in one terminal and `npm run dev` in another (Vite proxies `/api` to 8787).

## Pipeline
1. Sitemap ingestion and scraping of the newest posts (MAX_POSTS, default 15).
2. Topics: corpus TF-IDF keyphrases (or Grok when XAI_API_KEY is set).
3. Competitors: the optional "Competitors" input (comma-separated domains), else auto-discovered from web search (Brave, DuckDuckGo fallback), HN and Reddit ("brand alternatives / vs"), verified by homepage vocabulary. Their sitemaps are crawled (COMP_PAGES_PER_SITE, SSRF-guarded, low concurrency).
4. Social listening: web via Brave Search API when BRAVE_API_KEY is set (throttled to ~1 req/s, cached per scan, capped by BRAVE_MAX_QUERIES_PER_SCAN and BRAVE_MONTHLY_CAP, usage logged; the monthly counter resets on restart), else DuckDuckGo (polite, rate-limited); Stack Exchange API, dev.to, Reddit, GitHub, HN and X (if X_BEARER_TOKEN; capped by X_MAX_POSTS_PER_SCAN). Queries include competitor brands.
5. Strict relevance: hiring/Show HN/weekly-thread/spam blocklist, 90-day window, at least 2 topic-term hits, a product-context term, and a BM25 cosine threshold (MIN_SIMILARITY). Competitor pages need MIN_COMP_SIMILARITY.
6. Gap = 0.7 × competitor gap + 0.3 × social gap. Relevancy = 100 − gap. With nothing surviving, the post is marked "No active gap". Reasons and Markdown are extractive and cite the surviving URLs. Labelled "heuristic" unless Grok wrote them.

## API
- `GET /api/config`: which sources/keys are configured (never the values).
- `GET /api/scan?url=...&reddit=0&github=0&hn=0&x=0` is an SSE stream with these events: `log`, `step`, `meta`, `post` (one matrix row), `done`, `fail` (`code`: NO_SITEMAP, BLOCKED, RATE_LIMITED, SSRF_BLOCKED, BAD_URL, BUSY, CANCELLED).

## Public-use protections
Per-IP rate limit (`SCANS_PER_15MIN`, 1 concurrent scan per IP), global concurrency cap, 9 MB response cap, connect/header/body timeouts, a 4-minute scan timeout, cancel on client disconnect, http(s) only, and SSRF protection: every hostname is resolved and private, loopback, link-local, CGNAT, multicast and reserved IPs are refused at connect time (redirects are re-checked hop by hop).

## Deploy
- **Docker**: `docker build -t intent-interceptor . && docker run -p 8787:8787 --env-file .env intent-interceptor`
- **Render**: New Web Service from the repo → Runtime *Docker* (or Node with build `npm ci && npm run build`, start `npm start`). Add env vars. Render sets `PORT` automatically.
- **Railway**: New project from the repo. It detects the Dockerfile. Add variables. A public domain comes from Settings → Networking.
- **Fly.io**: `fly launch` (uses the Dockerfile, set internal port 8787), `fly secrets set XAI_API_KEY=... GITHUB_TOKEN=...`, `fly deploy`.
SSE needs a host that doesn't buffer responses. The server sends `X-Accel-Buffering: no` and a 15 s heartbeat.

## Limits
- Reddit often blocks or rate limits datacenter IPs (403/429). The app falls back to RSS and logs it when the source is skipped.
- Unauthenticated GitHub search allows 10 requests/min per IP. Set `GITHUB_TOKEN` for 30/min.
- Sites behind bot protection (Cloudflare challenges and similar) or without a sitemap can't be scanned. The UI shows a clear error.
- The heuristic mode is keyword-based. Grok mode gives much sharper topics, queries and gap copy.
