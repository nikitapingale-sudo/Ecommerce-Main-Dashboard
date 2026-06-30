# Product Requirements Document — PW Orders Intelligence Hub

| | |
|---|---|
| **Product** | PW Orders Intelligence Hub |
| **Owner** | Nikita Pingale (PMO / Ecom) |
| **Audience for this doc** | IT / DevOps / Platform team |
| **Status** | Live (interim hosting); requesting permanent backend hosting |
| **Repo** | https://github.com/nikitapingale-sudo/Ecommerce-Main-Dashboard |
| **Frontend (live)** | https://pw-orders-live.vercel.app |

---

## 1. Summary
An internal, leadership-facing analytics dashboard that turns live order data (~890K rows from Trino) into decision-ready insight across revenue, channels, geography, fulfilment, SKUs, coupons and pendency. It includes a built-in AI assistant ("EcomWallah") that answers natural-language questions over the full dataset. The frontend is already hosted on Vercel; this document requests **permanent, always-on hosting for the backend API** inside the PW network.

## 2. Goals
- A single, shareable link giving founders/leaders real-time visibility into the orders business.
- Self-serve answers (KPIs, drill-downs, AI Q&A) without manual data pulls.
- **24×7 availability**, viewable from any device, **no VPN required to view**, independent of any individual's laptop.

## 3. Non-goals
- Not a transactional/OMS system — read-only analytics.
- No public exposure of raw credentials or PII beyond what the existing warehouse already contains.

## 4. Users
- **Primary:** founders, business/leadership, ecom & ops managers (view-only).
- **Secondary:** analysts using search, drill-downs, and full data exports.

## 5. Architecture
```
   Browser (any device)
        │  HTTPS (public)
        ▼
   Vercel  ── static React/Vite frontend
        │  /api/* is proxied server-side to the backend
        ▼
   Backend API  (Python, Dockerized)         ◀── must run inside PW network
        │  Trino SQL + in-memory aggregation (pandas)
        ▼
   Trino  (trino-data-replica-1.penpencil.co, internal)
```
- **Frontend:** React + Vite, static build, hosted on **Vercel** (done). Calls `/api/*` (same origin); Vercel forwards to the backend.
- **Backend:** Python HTTP API (stdlib + pandas/numpy), containerized via the repo's `Dockerfile`. Loads the curated dataset into memory once and serves pre-aggregated JSON; also proxies the AI assistant to Groq.
- **Data source:** Trino (`cdp` catalog), reachable only from inside the PW network.
- **AI:** Groq LLM API (outbound HTTPS), used by the chatbot; key supplied via env var.

## 6. Functional scope (already built)
- Dashboard pages: Overview, Revenue, Channels, Geographic, Fulfilment, Pendency, Operations, Action Center, Products, SKU & SKU-Level Summary, Coupons, Component-Level Summary, Raw Data.
- Global filters (date, channel, state, category, payment, status, courier, etc.).
- AI assistant with live full-dataset querying, streaming, rate limiting, and graceful fallback.
- Global search, per-table search, and full CSV/Excel exports.
- Fully responsive (mobile card layouts).

## 7. Non-functional requirements
- **Availability:** backend up 24×7 (target ≥99%); auto-restart on crash/reboot.
- **Performance:** first dataset load ~60–90s (cold), cached thereafter (default 1h, configurable); aggregated responses typically <10s.
- **Memory:** holds the full dataset in RAM → **≥ 2 GB** required.
- **Security:** all secrets via environment variables; no credentials committed; HTTPS end-to-end.
- **Resilience:** transient Trino/Groq errors are retried; AI falls back to a rule engine if unavailable.

## 8. Infrastructure request (what we need from DevOps)
1. **An always-on Linux VM inside the PW network** with:
   - **≥ 2 GB RAM**, **Docker** installed
   - **network access to Trino** (`trino-data-replica-1.penpencil.co:443`)
   - normal **outbound internet** (for the AI assistant + tunnel/proxy, if used)
2. **Build & run the container** (one `docker build` + `docker run` — see `BACKEND-HOSTING.md`).
3. **Expose over HTTPS at a stable URL** — Cloudflare Tunnel **or** an internal reverse-proxy subdomain (whatever matches PW standards).
4. **Return the HTTPS URL** to the owner; the Vercel frontend is then pointed at it (≈1 min).

### Runtime environment variables
```
API_PREWARM=true
API_ALLOWED_ORIGINS=https://pw-orders-live.vercel.app
TRINO_HOST=trino-data-replica-1.penpencil.co
TRINO_PORT=443
TRINO_USER=<user>
TRINO_PASSWORD=<password>
TRINO_CATALOG=cdp
GROQ_API_KEY=<key for the AI assistant>
```
Full, copy-paste commands and HTTPS options are in **`trial/BACKEND-HOSTING.md`**.

## 9. Security & data
- No secrets in the repo; supplied at runtime as env vars above.
- Read-only access to Trino; the dashboard performs `SELECT`-style queries only.
- Frontend never talks to Trino directly; only the backend (inside the network) does.

## 10. Current status & the ask
- ✅ Frontend live on Vercel; backend + full feature set complete and working.
- ⏳ Backend currently runs on the owner's laptop via a temporary tunnel — **not 24×7**.
- 🎯 **Ask:** host the backend on an always-on internal VM (Section 8) so the dashboard is permanently available to leadership.

## 11. Risks / constraints
- **Trino is internal-only** → the backend cannot be hosted on a public PaaS; it must be inside the PW network (this is the core driver of the request).
- Large data exports are generated on the server; very large ones can take ~60–90s.
- Tunnel-based interim hosting is unreliable (laptop sleep, corporate-network blocks) — hence the permanent-server request.
