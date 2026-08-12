# High-Level Design (HLD) — PW Orders Intelligence Hub

| | |
|---|---|
| **Product** | PW Orders Intelligence Hub |
| **Owner** | Nikita Pingale (PMO / Ecom) |
| **Audience** | IT / Security / DevOps (Secure Architecture Review) |
| **Status** | Live (interim hosting); permanent backend hosting requested |
| **Repo** | https://github.com/nikitapingale-sudo/Ecommerce-Main-Dashboard |
| **Frontend (live)** | https://pw-orders-live.vercel.app |
| **Related docs** | `PRD.md`, `LLD.md`, `BACKEND-HOSTING.md`, `DEPLOY.md` |

---

## 1. Purpose & scope
An internal, leadership-facing **read-only analytics dashboard** over PhysicsWallah order data (~0.95M rows sourced from Trino). It renders KPIs, trends, drill-downs, and exports across revenue, channels, geography, fulfilment, SKUs, coupons and pendency, plus an AI assistant (“EcomWallah”) that answers natural-language questions over the dataset.

**Non-goals:** not a transactional/OMS system; no writes to any source system; no new PII beyond what the warehouse already holds.

## 2. System context
```
        ┌─────────────────────────── Public Internet ───────────────────────────┐
        │                                                                        │
   [ Browser / any device ]                                                      │
        │  HTTPS (TLS)                                                           │
        ▼                                                                        │
   [ Vercel Edge/CDN ]  ── serves static SPA + static JSON snapshots            │
        │   • /api/v1/*  and  /data/live/*  → reverse-proxied (rewrite)          │
        │   HTTPS                                                                │
        ▼                                                                        │
   [ Ingress: HTTPS reverse-proxy / Cloudflare Tunnel ]  ◀── target: PW-hosted   │
        │                                                                        │
        └──────────────────────── PW Internal Network ──────────────────────────┘
             │
        [ Backend API ]  Python, containerized (Dockerfile)
             │  read-only SELECT (Trino protocol, TLS)         │  HTTPS (outbound)
             ▼                                                  ▼
        [ Trino  cdp catalog ]                            [ Groq LLM API ]
        trino-data-replica-1.penpencil.co (internal)      (AI assistant only)
```

## 3. Components (high level)
| Component | Tech | Responsibility | Hosting |
|---|---|---|---|
| **Frontend SPA** | React 18, Vite, Recharts, XLSX | UI, charts, filters, client rendering of pre-aggregated data; CSV/Excel export | Vercel (static) |
| **Edge proxy** | Vercel `rewrites` (`vercel.json`) | Same-origin reverse proxy of `/api/*` & `/data/live/*` to the backend; serves static snapshots for the default view | Vercel |
| **Backend API** | Python stdlib `http.server` + pandas/numpy + `trino` | Runs the curated Trino query, holds dataset in memory, returns pre-aggregated JSON “bundles”; proxies AI chat to Groq | Container (interim: laptop+tunnel; target: PW VM) |
| **Data source** | Trino (`cdp` catalog) | System of record (read-only) | PW internal |
| **AI provider** | Groq LLM API | NL answers for the assistant | External SaaS (outbound) |

## 4. Data flow (request lifecycle)
1. Browser loads the SPA (static assets) from Vercel over HTTPS.
2. **Default view:** SPA fetches a **static pre-aggregated JSON snapshot** (`/data/summary.json`) from Vercel's CDN — no backend needed.
3. **Filtered/interactive view:** SPA issues read-only requests (`/data/live/v1/<endpoint>/<params>.json`); Vercel reverse-proxies them to the backend.
4. Backend applies filters against the **in-memory** dataset (pandas) and returns a small aggregated JSON bundle. The raw dataset is fetched from Trino **once** and cached (default TTL 1h).
5. **AI assistant:** SPA posts a question to `/api/v1/chat`; backend attaches a compact data snapshot and calls the Groq API, streaming the answer back. Falls back to a local rule engine if Groq is unavailable.
6. **Exports:** backend generates CSV server-side for the current filter set.

## 5. Trust boundaries
- **B1 — Public ↔ Vercel:** untrusted clients reach only the Vercel edge (static assets + reverse proxy). TLS enforced; security headers set (`X-Content-Type-Options`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy`, HSTS via Vercel).
- **B2 — Vercel ↔ Backend:** ingress to the backend (reverse proxy / Cloudflare Tunnel). Only the backend is exposed, not Trino.
- **B3 — Backend ↔ Trino:** inside the PW network only; **read-only** credentials; the frontend never contacts Trino directly.
- **B4 — Backend ↔ Groq (egress):** outbound HTTPS to a third-party LLM for the assistant feature only.

## 6. Technology stack
- **Frontend:** React 18.3, Vite 5, Recharts 2, `xlsx`, `lucide-react`; built to static assets; Node ≥18 build toolchain.
- **Backend:** Python ≥3.10, standard-library `http.server` (`ThreadingHTTPServer`); `trino`, `pandas`, `numpy`. No web framework.
- **Infra:** Vercel (frontend + edge proxy); Docker for the backend; Trino (data); Groq (AI).

## 7. Security model (summary; details in LLD §8)
- **AuthN/AuthZ:** **currently none** — the dashboard is open to anyone with the link (view-only). *Access control is a known gap; SSO/role-based access to be added if required before go-live (see LLD §8.1).*
- **Secrets:** all credentials (Trino, Groq) provided at **runtime as environment variables** (`scripts/llm.env`, git-ignored); **no secrets committed** to the repo.
- **Data classification:** the dataset contains **business PII** already present in the warehouse (customer name, ship city/state). No card/payment-instrument data. No new PII is created.
- **Data egress:** the AI assistant sends a **compact aggregated snapshot** (not the full row set) to Groq (external). This is the only third-party data egress and is feature-gated by `GROQ_API_KEY`.
- **Transport:** HTTPS end-to-end (browser→Vercel→backend→Trino/Groq).
- **Least privilege:** backend uses a **read-only** Trino account; no write paths to any system.
- **Abuse controls:** AI endpoint is IP rate-limited; CORS restricted to the dashboard origin in production (`API_ALLOWED_ORIGINS`).

## 8. Deployment topology
- **Interim (current):** backend runs on the owner's laptop, exposed via a temporary **Cloudflare quick tunnel**; Vercel proxies to it. **Not 24×7** (laptop/VPN/tunnel dependent).
- **Target (requested):** backend containerized on an **always-on Linux VM inside the PW network** (≥2 GB RAM, Docker, Trino reachability), exposed at a **stable HTTPS URL** (Cloudflare Tunnel or internal reverse-proxy subdomain). Vercel is repointed to that URL. See `PRD.md §8` and `BACKEND-HOSTING.md`.

## 9. Non-functional requirements
- **Availability:** target ≥99% for the backend once on the PW VM; auto-restart on crash/reboot.
- **Performance:** cold dataset load ~60–150s; cached thereafter (TTL 1h); aggregated responses typically <10s.
- **Capacity:** full dataset held in RAM → **≥2 GB** required.
- **Resilience:** transient Trino/Groq errors retried; AI falls back to a local rule engine; default view is a static snapshot that survives backend downtime.

## 10. Known risks / review focus areas
1. **No authentication** on the dashboard today (open link) — primary item for the review.
2. **Interim hosting** on a laptop + ephemeral tunnel is not production-grade (drives the DevOps hosting request).
3. **PII in exports** — row-level CSV/Excel exports include customer name / city / state.
4. **Third-party LLM egress** (Groq) — confirm this is acceptable per PW data-handling policy.
5. **CORS / origin** must be locked to the production origin in the deployed config.
6. Repo currently on a **personal GitHub account** — recommend moving under a PW org / mirroring to PW GitLab.

*See `LLD.md` for endpoint-level detail, data models, the exact Trino queries, config, and per-control implementation.*
