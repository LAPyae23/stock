# INVENTO — warehouse inventory MVP (PRD v1.1)

Mobile-first inventory app for small Myanmar warehouses: React + Vite frontend, Elysia API, **MongoDB** database.
Built against `references/INVENTO-PRD-v1.1.pdf`.

## Features (PRD Phase 1)
- **Typing input (5.1)** — name, description, FDA code, supplier name/phone/email, QR/barcode (camera scan), up to 4 photos, stock-in date, expiry date, remarks, quantity
- **Push-to-talk (5.2)** — scan code → hold button and speak (English or Burmese, browser speech recognition) → review transcript, retry → confirm into a review table → add expiry/remarks → save. Existing codes update the product; new codes become the product's unique ID. Typing the phrase works when speech is unavailable.
- **Ship out (5.3)** — category filter, product dropdown, quantity; cannot exceed stock (atomic check)
- **Item status & supplier reorder (5.4)** — In stock / Low / Out of stock / Pending / Confirm shipping; Received adds stock automatically
- **Alerts & settings (5.5)** — low stock, out of stock, expiry; configurable expiry reminder days and per-product thresholds
- **History (5.6)** — every movement with before/after quantities, actor and time
- **Smart restock forecast** — average daily ship-out over 30 days predicts "runs out in ~N days" and a suggested order quantity (3 weeks of cover); "Running out soon" alerts fire before stock hits the threshold
- **One-tap supplier order** — order message written in Burmese/English, sent through the phone's share sheet, Viber, Telegram or SMS
- **QR label printing** — sticker sheet for products without barcodes; scanning a label finds the product
- Physical count with required reason on variance
- `npm --prefix api run reset-demo` rebuilds only the demo account with 30 days of history (set `MONGODB_URI` to target Atlas)
- Full English / Burmese UI — all text lives in `web/src/text.ts` (`npm --prefix web run check` fails if a Burmese string is missing)

## Run locally (Windows)
MongoDB Server runs as the Windows service **MongoDB** (auto-start) at `mongodb://127.0.0.1:27017`, database `invento`.

The API uses Elysia 2 (`2.0.0-rc.0`) and needs Node.js 22.18+ for its Node adapter, or Bun 1.4+. Run the API with Bun instead of Node with `bun --watch api/server.js`.

```bash
npm run setup
```
```bash
npm run dev
```
Open http://localhost:5173 — demo login `demo@invento.local` / `InventoDemo!2026` (created automatically on an empty database).

`api/.env` (copy from `api/.env.example`): `MONGODB_URI`, `MONGODB_DB`, `JWT_SECRET`, `WEB_ORIGIN`, `SEED_DEMO`; optional `LOG_LEVEL` and `SLOW_REQUEST_MS`.

Tests: `npm test` (voice parser, expiry parser, API route tests, and translation type check). Inspect data with `mongosh` → `use invento`.

## Logging
Every request logs one line with its status, duration and a request id. The same id is returned in the `X-Request-Id` response header, so a browser error can be matched to a server log.

- Locally the line is compact and colorized when the terminal supports it.
- On Vercel (or with `LOG_FORMAT=json`) each line is a JSON object for log drains.
- `LOG_LEVEL=debug|info|warn|error|silent` sets the minimum level (`info` by default).
- Requests slower than `SLOW_REQUEST_MS` (default `1000`; `0` disables) log at warn level and are tagged `SLOW`.
- Startup, database connection and graceful shutdown are logged too.
- MongoDB connection strings are redacted before they are logged.

## Deploy to Vercel
`vercel.json` builds `web/` as static files and serves the API from `api/index.js` as a serverless function.
Vercel cannot reach the MongoDB on your PC, so use a MongoDB Atlas cluster (free tier works) and allow access from `0.0.0.0/0` in Atlas Network Access.

```bash
vercel login
```
```bash
vercel link
```
Set environment variables (Production): `MONGODB_URI` (Atlas `mongodb+srv://…` string), `MONGODB_DB=invento`, `JWT_SECRET` (long random), `SEED_DEMO` (`true` for a demo, `false` for real use). Then:
```bash
vercel deploy --prod
```

## API
`GET /api/docs` lists every endpoint. Main ones: `/v1/auth/*`, `/v1/products`, `/v1/products/lookup/:code`, `/v1/stock/in`, `/v1/stock/in/batch` (push-to-talk save), `/v1/stock/out`, `/v1/stock/counts`, `/v1/voice/parse`, `/v1/reorders`, `/v1/alerts`, `/v1/movements`, `/v1/warehouse`.

## Known limits
- Elysia 2 is pinned at `2.0.0-rc.0`; review the release notes before upgrading to the final 2.0 release.
- Speech recognition uses the browser (best in Chrome/Android); Burmese accuracy depends on Google's `my-MM` model — the review step is the safeguard.
- Camera scanning needs HTTPS (Vercel) or localhost.
- Local MongoDB is standalone, so multi-document transactions only run on Atlas; locally writes are ordered and stock changes use atomic conditional updates.
- Local MongoDB has no authentication and only listens on 127.0.0.1.
- With `SEED_DEMO=true` the public demo password is known — turn it off before real data.
- No rate limiting or refresh-token rotation yet.
