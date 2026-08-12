# Low-Level Design (LLD) — PW Orders Intelligence Hub

Companion to `HLD.md`. Endpoint-, module-, and control-level detail for the Secure Architecture Review.

| | |
|---|---|
| **Repo** | https://github.com/nikitapingale-sudo/Ecommerce-Main-Dashboard |
| **Frontend** | Vercel — `https://pw-orders-live.vercel.app` |
| **Backend** | Python `http.server` (`trial/scripts/api.py`) |
| **Data** | Trino `cdp` catalog (read-only) |

---

## 1. Repository layout (relevant paths)
```
trial/
├─ src/                         # React SPA
│  ├─ App.jsx, main.jsx         # shell; NOTE: login removed (open access)
│  ├─ pages/*.jsx               # Overview, Revenue, Channels, Geographic, Fulfilment,
│  │                            #   Pendency, Operations, Actions, Products, Coupons,
│  │                            #   SKU, ComponentSummary, RawData, EcomWallah
│  ├─ components/*.jsx          # UI, FilterPanel, Sidebar, ChatWidget, GlobalSearch
│  └─ utils/dataEngine.js       # API client + client-side formatting/helpers
├─ scripts/
│  ├─ api.py                    # HTTP API server (all endpoints)
│  ├─ dbm.py                    # Trino connection + SQL query builders
│  ├─ aggregate.py              # in-memory aggregation (pandas Dataset class)
│  ├─ requirements.txt          # trino, pandas, numpy
│  └─ llm.env                   # secrets at runtime (GIT-IGNORED)
├─ public/data/*.json           # static pre-aggregated snapshots (default view)
├─ vercel.json                  # edge proxy rewrites + security headers
├─ Dockerfile, render.yaml      # backend containerization
└─ docs/ (HLD.md, LLD.md)
```

## 2. Frontend (SPA)
- **Build:** Vite → static assets on Vercel CDN. No server-side rendering.
- **API client:** `src/utils/dataEngine.js`. Read endpoints are called over **GET** with parameters encoded into a base64 path segment ending in `.json` (e.g. `/data/live/v1/summary/<base64>.json`). Rationale: keeps requests same-origin and static-file-shaped so they traverse restrictive corporate web filters. The backend also accepts standard `POST` (JSON body) and `?filters=`/`?q=` query forms.
- **Default view:** loads `/data/summary.json` + `/data/components.json` (static snapshots) directly from the CDN — functions even if the backend is down.
- **No client-side secrets.** `VITE_*` build vars contain only non-secret config (API base path). The frontend never holds Trino/Groq credentials and never contacts Trino.

## 3. Edge proxy (`vercel.json`)
- `rewrites` (evaluated in order):
  1. `/data/live/(.*)` → `https://<backend-host>/api/$1`
  2. `/api/(.*)` → `https://<backend-host>/api/$1`
  3. `/(.*)` → `/index.html` (SPA fallback)
- `headers`: `Cache-Control` for assets/HTML; global `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: strict-origin-when-cross-origin`. HSTS added by Vercel.
- The `<backend-host>` is the ingress URL (target: stable PW-hosted HTTPS endpoint; interim: Cloudflare quick-tunnel hostname).

## 4. Backend API (`scripts/api.py`)
Single-process `ThreadingHTTPServer`. Endpoint match is by path suffix so any base prefix (`/api/v1`, `/data/live/v1`) works behind the proxy.

| Method | Path (suffix) | Auth | Purpose | Notes |
|---|---|---|---|---|
| GET | `/health` | none | Liveness + source metadata | no data |
| GET | `/orders` | none | Raw order payload (capped) | `days`, `limit` clamped to `API_MAX_LIMIT` |
| GET/POST | `/summary` | none | Aggregated KPI bundle for filters | cached per-filter (TTL) |
| GET/POST | `/rows` | none | Paged raw rows for current filters | `offset`,`limit`(≤2000),`search` |
| GET/POST | `/components` | none | Component-level summary | uses bundle-mapping table |
| GET/POST | `/export` | none | CSV of all filtered rows | server-generated, gzip |
| GET/POST | `/export-summary` | none | CSV of an aggregated table | `kind` |
| POST | `/chat` | none | AI assistant → Groq (SSE stream) | IP rate-limited; feature-gated |
| POST | `/auth/*` | n/a | register/login/reset/log | **module present but NOT wired to the live UI** |

- **Input handling:** filters arrive as JSON (POST body), URL-encoded `?filters=`, base64 `?q=`, or a base64 path segment. All are parsed to a dict and used only as pandas filter values (no string concatenation into SQL — see §5).
- **Concurrency:** thread-per-request; shared dataset guarded by locks; per-filter result cache.

## 5. Data access & queries (`scripts/dbm.py`, `aggregate.py`)
- **Connection:** Trino over TLS (`TRINO_HOST:443`), credentials from env. **Read-only** account expected.
- **Two SQL statements only, both `SELECT`, both static templates** (no user input concatenated into SQL — dashboard filters are applied in pandas, not SQL):
  1. `build_query()` — curated SKU-level orders dataset, a `UNION ALL` of two legs: **Viniculum** (`gold_dbt_vinniculum_orders_base_fact ⋈ gold_dbt_pwstore_product_mapping`, channels B2B_DC/B2B_BOS/PW_Store, Ecommerce finance category, PW_Store excl. CASH / B2B Third Party) and **3P marketplace** (`gold_dbt_ecom_3p_orders` LEFT JOIN the same product mapping). Window `>= DATE '2026-01-01'`. Item status is derived in SQL from the line's lifecycle dates (`new_item_status_conditional`), not the raw line status.
  2. `build_bundle_mapping_query()` — bundle→component mapping (`gold_product_variants` + `gold_bundle_product_variant_mappings`, PW store org) with each component's MRP ratio, bundle quantity and study-material type, for the Component-Level Summary.
- **Injection surface:** none via the app — the SQL is fixed; the only interpolated values are **server-side constants** (channel list, org IDs, dates), never client input. (Full SQL available in `dbm.py` and shared separately for review.)
- **Aggregation:** `aggregate.Dataset` (pandas) computes metrics, group-bys, time series, the category hierarchy (parent→sub-cat→sub-sub→product), SKU/coupon/pendency tables — all in memory. Responses are small pre-aggregated bundles, not raw rows (except `/rows` and exports).

## 6. Data model & classification
- **Dimensions:** channel, warehouse, state, city, category hierarchy, payment method, order/line status, courier, coupon, finance category, order type.
- **Measures:** orders (distinct `vc_reference_order_id`), lines, qty, revenue, MRP, discount, delivery charges, delivery/RTO/cancel rates.
- **PII present (from warehouse):** `vco_customer_name`, ship `city`/`state`. Surfaced only in **Raw Data** and **exports** (row-level); all charts/KPIs are aggregated. **No** card/UPI/bank data; **no** passwords/tokens in the dataset.

## 7. Configuration & secrets
Runtime env vars (backend), loaded from `scripts/llm.env` (git-ignored) — never committed:
```
API_HOST, API_PORT, API_PREWARM
API_ALLOWED_ORIGINS=https://pw-orders-live.vercel.app   # CORS allow-list (prod)
API_MAX_LIMIT, API_CACHE_TTL
TRINO_HOST, TRINO_PORT, TRINO_USER, TRINO_PASSWORD, TRINO_CATALOG   # read-only
GROQ_API_KEY, GROQ_MODEL                                # AI assistant
CHAT_RATE_MAX, CHAT_RATE_WINDOW                         # rate limiting
```
Frontend build var (non-secret): `VITE_API_BASE_URL` (API base path).

## 8. Security controls & known gaps
### 8.1 Authentication / authorization — **GAP**
- Current state: **no login**; anyone with the URL can view (read-only). `src/main.jsx` renders the app directly.
- A backend email/password module exists (`/auth/*`, `users.json`) but is **not wired to the UI**, and (if ever enabled) currently stores **plaintext passwords** — must be replaced with SSO / hashed credentials before any use. **Recommendation:** front the app with PW SSO (or Vercel access control / IP allow-listing) prior to go-live.

### 8.2 Transport & headers
- HTTPS end-to-end. Security headers via `vercel.json` (§3). Backend sets permissive CORS in dev; **production must set `API_ALLOWED_ORIGINS` to the dashboard origin only.**

### 8.3 Secrets management
- No secrets in repo (`.env*`, `llm.env`, `users.json` are git-ignored). Supplied at runtime. Recommend a secrets manager on the target VM.

### 8.4 Data egress (third party)
- `/chat` sends a **compact aggregated snapshot + the user question** to **Groq** (external LLM). No raw PII rows are sent by design. Feature is disabled if `GROQ_API_KEY` is unset. Confirm acceptability per PW policy; consider an internal/approved LLM if required.

### 8.5 Abuse / DoS
- AI endpoint IP rate-limited (`CHAT_RATE_MAX`/`WINDOW`). Row/export sizes bounded (`API_MAX_LIMIT`, `/rows` limit ≤2000). No auth means no per-user throttling on read endpoints → consider WAF / edge rate-limiting on the proxy.

### 8.6 Least privilege & blast radius
- Backend holds a **read-only** Trino credential; no write path to any source system. Compromise exposes read access to the curated order dataset only.

### 8.7 Logging
- Backend logs request lines + auth attempts (`scripts/auth_log.jsonl`); ensure logs avoid sensitive values and are rotated on the VM.

## 9. Availability & failure modes
- Dataset cached in RAM (TTL 1h); reload requires Trino reachability (PW network).
- Default dashboard view is a **static CDN snapshot** → survives backend/Trino/tunnel outages (filters degrade until backend is back).
- Transient Trino/Groq errors retried; AI falls back to a local rule engine.

## 10. Target hardening (pre/at go-live)
1. Add **authentication** (SSO) + authorization; remove/replace the plaintext auth module.
2. Host backend on the **PW internal VM** (stable HTTPS, not laptop/tunnel).
3. Lock **CORS** to the production origin; add edge **rate-limiting/WAF**.
4. Move repo to a **PW org / GitLab**; run SAST/SCA (this engagement).
5. Review **export/PII** access; gate exports behind auth once added.
6. Confirm **LLM egress** policy for the AI assistant.
