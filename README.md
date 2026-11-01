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
1. **Sitemap discovery**: the URL you entered (if it is a sitemap), `robots.txt` `Sitemap:` lines, `/sitemap.xml`, `/sitemap_index.xml`, `/blog/sitemap.xml`. Sitemap indexes are followed, with blog/post child sitemaps first. Keeps `/blog/ /posts/ /guides/ /articles/ /tutorials/ /learn/ /docs/guides/...` URLs (or all URLs if none match), sorted newest first by `lastmod`, capped at `MAX_POSTS`.
2. **Scrape** (cheerio, 4 at a time, 15 s timeout): title, meta description, H2/H3 subheaders, published/modified date, body text.
3. **Topics**: Grok (`XAI_API_KEY`, model `XAI_MODEL`) or a keyword heuristic (title/header weighting, stopwords, tech-term boost, the site's own brand removed). The log says which mode ran.
4. **Friction tracing**: Reddit `search.json` (falls back to the public RSS search if the JSON endpoint returns 403), GitHub issue search (`created:>30 days ago`), HN Algolia `search_by_date`, X API v2 recent search (only with `X_BEARER_TOKEN`). Results are cached for 10 minutes per query.
5. **Scoring**: each harvested item is weighted by on-topic overlap, friction wording (error, timeout, leak...), how much of its vocabulary the post does **not** cover, recency (12-day decay) and engagement. Relevancy = 100 − pressure of the top 8 items − an age penalty for posts older than 90 days. Severity: <45 critical, <60 high, <75 medium, else healthy.
6. **Narrative**: Grok writes the gap reason + Markdown injection from the harvested evidence only. Without a key, the copy is a labelled template built from the real top discussion titles and links.

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
