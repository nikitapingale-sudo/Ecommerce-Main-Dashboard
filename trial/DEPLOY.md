# Deploying the PW Orders Intelligence Hub

The app is **two pieces**:

| Piece | What it is | Where it runs |
|-------|------------|---------------|
| **Frontend** | React + Vite static site (this folder) | **Vercel** |
| **Backend** | `scripts/api.py` — Trino query + in-memory aggregation + Groq chatbot | **An always-on server** (NOT Vercel) |

> The backend loads ~858k rows into memory and caches them for an hour. Vercel
> serverless functions are stateless and would reload that on every request, so
> the API must run on a persistent host. The chatbot, Component Summary, Raw-Data
> search and all "Export all" buttons require this backend.

---

## 1) Deploy the backend (always-on host)

A `Dockerfile` is included, so the API runs on any container host. **Pick one:**

**Requirements:** ≥ **2 GB RAM** (holds the ~858k-row dataset), **HTTPS** (the Vercel
frontend is HTTPS — a plain-HTTP API would be blocked as mixed content), and
**network access to Trino** (`trino-data-replica-1.penpencil.co:443`). ⚠️ If Trino
is only reachable from inside PhysicsWallah's network, host the API on an internal
VM / EC2 in that network — a public PaaS won't be able to connect.

### Option A — Render (easiest, managed HTTPS) ✅ recommended to start
1. Push this folder to a Git repo.
2. Render → **New → Blueprint** → pick the repo (it reads `render.yaml`), **or**
   **New → Web Service → Docker** and point at the repo.
3. Plan: **Standard** (2 GB) — *not* the free/starter tier (too little RAM, and free
   spins down, which throws away the in-memory cache).
4. Set env vars (below). Deploy → you get `https://pw-orders-api.onrender.com`.

### Option B — Railway / Fly.io
Same Docker image. Railway: New Project → Deploy from repo (uses the Dockerfile);
add env vars. Fly: `fly launch` (detects the Dockerfile), set `internal_port = 8000`,
`fly secrets set GROQ_API_KEY=... API_ALLOWED_ORIGINS=...`.

### Option C — EC2 / internal VM (best for production / internal Trino)
```bash
docker build -t pw-orders-api .
docker run -d --restart=always -p 8000:8000 \
  -e API_ALLOWED_ORIGINS="https://<your-app>.vercel.app" \
  -e GROQ_API_KEY="gsk_..." \
  pw-orders-api
```
Put Nginx/Caddy in front for HTTPS (Caddy auto-provisions a cert).

### Backend environment variables (all hosts)
```bash
API_ALLOWED_ORIGINS="https://<your-app>.vercel.app"   # CORS — your Vercel URL(s), comma-separated
API_PREWARM=true                                       # warm the dataset on boot (set in Dockerfile already)
GROQ_API_KEY=gsk_...                                   # chatbot (server-side only)
# Trino — only if overriding scripts/dbm.py defaults:
TRINO_HOST=...  TRINO_PORT=443  TRINO_USER=...  TRINO_PASSWORD=...  TRINO_CATALOG=cdp
```

Verify: `curl https://<your-api-host>/api/v1/health` → `{"status":"ok",...}`
(First boot takes ~90s to warm the dataset; health responds immediately.)

## 2) Deploy the frontend to Vercel

Two options:

**A. Vercel Dashboard (recommended)**
1. Push this folder to a Git repo (GitHub/GitLab/Bitbucket).
2. In Vercel → **Add New → Project** → import the repo.
3. Framework auto-detects **Vite** (Build `npm run build`, Output `dist`).
4. Add the Environment Variables below (Production scope).
5. **Deploy.**

**B. Vercel CLI**
```bash
npm i -g vercel
vercel login
vercel --prod        # from this folder
```

### Environment Variables to set in Vercel (Project → Settings → Environment Variables)

Only `VITE_`-prefixed vars reach the browser; set at least:

```
VITE_DATA_SOURCE      = api
VITE_API_BASE_URL     = https://api.yourcompany.com/api/v1   # <- your backend from step 1
VITE_API_TIMEOUT_MS   = 60000
VITE_APP_NAME         = PW Orders Intelligence Hub
VITE_APP_ENV          = production
VITE_APP_BASE_URL     = https://<your-app>.vercel.app
```

(`.env.production` is gitignored, so these MUST be set in the Vercel dashboard —
Vite inlines them at build time.)

## 3) Connect the two (CORS)

After the Vercel URL is known, make sure the backend's `API_ALLOWED_ORIGINS`
contains it exactly (scheme + host, no trailing slash), then restart the API.
Open the Vercel URL → the dashboard should load live data and the chatbot should work.

---

### Fully-static fallback (no backend) — not recommended
You *can* deploy frontend-only by running `python scripts/dbm.py` to bake a
snapshot into `src/data.js` and setting `VITE_DATA_SOURCE=static`. But this
**disables the chatbot, Component Summary, server-side Raw-Data search and all
"Export all" features**, and embeds a huge data file in the bundle. Use API mode.
