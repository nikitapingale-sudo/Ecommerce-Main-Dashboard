# Backend Hosting Runbook (24/7) — for PW IT / DevOps

**Goal:** run the dashboard's API (`scripts/api.py`) on an **always-on machine inside
PhysicsWallah's network**, expose it over **HTTPS** with a **stable URL**, so the public
Vercel frontend (`https://pw-orders-live.vercel.app`) shows live data 24/7 — independent
of anyone's laptop.

Why internal: the API queries **Trino at `trino-data-replica-1.penpencil.co` (private
`10.x` IP)**, which is only reachable from inside the PW network. A public PaaS (Render,
etc.) cannot connect — so the host must be a PW-network machine.

---

## 1. Machine requirements
- Linux VM / container host **inside the PW network** (an internal VM, or EC2 in PW's VPC).
- **Always-on**, **≥ 2 GB RAM** (holds the ~860k-row dataset in memory).
- **Docker** installed.
- Can reach Trino — verify: `curl -m5 -k https://trino-data-replica-1.penpencil.co:443` should connect.
- Outbound internet (for the chatbot's Groq calls + the tunnel, if used).

## 2. Get the code & build
```bash
git clone https://github.com/nikitapingale-sudo/Ecommerce-Main-Dashboard.git
cd Ecommerce-Main-Dashboard/trial
docker build -t pw-orders-api .
```

## 3. Run the API (always restart)
```bash
docker run -d --name pw-orders-api --restart=always -p 8000:8000 \
  -e API_PREWARM=true \
  -e API_ALLOWED_ORIGINS="https://pw-orders-live.vercel.app" \
  -e TRINO_HOST="trino-data-replica-1.penpencil.co" \
  -e TRINO_PORT="443" \
  -e TRINO_USER="<trino_user>" \
  -e TRINO_PASSWORD="<trino_password>" \
  -e TRINO_CATALOG="cdp" \
  -e GROQ_API_KEY="<groq_key_for_chatbot>" \
  pw-orders-api
```
Check: `curl http://localhost:8000/api/v1/health` → `{"status":"ok",...}` (first boot
warms the dataset for ~90s; health responds immediately).

## 4. Put a STABLE HTTPS endpoint in front
The Vercel site is HTTPS, so the API must be HTTPS too. Use whichever fits PW's setup:

**Option A — Cloudflare Tunnel (no inbound firewall change; great for internal boxes)**
Needs a Cloudflare account + a domain on Cloudflare. Outbound-only.
```bash
cloudflared tunnel login
cloudflared tunnel create pw-orders-api
cloudflared tunnel route dns pw-orders-api pw-orders-api.<your-domain>
# ingress: service http://localhost:8000  → run as a systemd service:
cloudflared tunnel run pw-orders-api
```
Stable URL: `https://pw-orders-api.<your-domain>`

**Option B — Reverse proxy (if the box has public DNS + can accept inbound 443)**
Caddy auto-provisions a TLS cert:
```
# /etc/caddy/Caddyfile
api.<your-domain> {
    reverse_proxy localhost:8000
}
```
Stable URL: `https://api.<your-domain>`

## 5. Send the URL back
Give Nikita the final public base URL, e.g. `https://pw-orders-api.<your-domain>`.
The frontend calls it at `…/api/v1/...` (the path prefix is flexible).

---

## What Nikita does after that (frontend — already deployed on Vercel)
1. `vercel env rm VITE_API_BASE_URL production`
2. `printf 'https://pw-orders-api.<your-domain>/api/v1' | vercel env add VITE_API_BASE_URL production`
3. `vercel --prod` (redeploy)

Done — `https://pw-orders-live.vercel.app` now serves live data 24/7, no laptop needed.

## Notes
- Secrets are passed as env vars (above) — nothing sensitive is in the repo.
- To update the app later: `git pull && docker build -t pw-orders-api . && docker restart pw-orders-api`.
- Dataset refreshes in memory every hour (configurable via `API_CACHE_TTL`).
