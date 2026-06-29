# DevOps Request — Email Template

**To:** <IT / DevOps lead>
**Subject:** Request: small always-on VM to host an internal dashboard's API

---

Hi <name>,

I've built an internal **Orders Intelligence dashboard** for leadership visibility. The frontend is already live on Vercel; I now need a place to run its **backend API 24/7** so the dashboard works for everyone without depending on my laptop.

**Why it needs to run inside our network:** the API reads from **Trino** (`trino-data-replica-1.penpencil.co`, internal IP), which is only reachable from inside the PW network — so a public cloud host can't be used.

**The ask (≈10 minutes for someone with server access):**
1. A small **always-on Linux VM** — **≥ 2 GB RAM**, **Docker** installed, with **network access to Trino** and outbound internet.
2. Run the containerized API from our repo (one `docker build` + `docker run`) and expose it over **HTTPS at a stable URL** (a Cloudflare Tunnel or an internal reverse-proxy subdomain both work).
3. Send me back that **HTTPS URL**.

**Everything is documented step-by-step here:**
- Repo: https://github.com/nikitapingale-sudo/Ecommerce-Main-Dashboard
- Runbook (exact commands, env vars, HTTPS options): **`trial/BACKEND-HOSTING.md`**

Credentials (Trino, etc.) are passed as environment variables at runtime — nothing sensitive is stored in the repo.

Once I have the URL, I'll point the dashboard at it (1 minute) and it'll be permanently available to leadership — no VPN needed to view, no dependency on any individual machine.

Happy to hop on a quick call if useful. Thanks!

<your name>
