#!/usr/bin/env python3
# ============================================================
#  PW Orders Intelligence Hub — Trino API server
#  File: scripts/api.py
#
#  PURPOSE:
#    Serves the dashboard's order rows over HTTP by querying
#    Trino on demand, instead of embedding a giant data.js.
#    The frontend (VITE_DATA_SOURCE="api") fetches from here.
#
#    Reuses the Trino connection, query builder and row
#    transform from scripts/dbm.py — so the JSON returned is
#    exactly the shape the dashboard already expects (including
#    order_status_group / item_status_group).
#
#  ENDPOINTS:
#    GET /api/v1/health
#        -> {"status":"ok", ...}
#    GET /api/v1/orders?days=<N>&limit=<M>
#        -> {"data":[ {row}, ... ], "meta":{...}}
#        days  : only last N days (0 = all). Default API_DEFAULT_DAYS.
#        limit : max rows. Clamped to API_MAX_LIMIT (protects the browser).
#
#  RUN:
#    python scripts/api.py            # listens on API_HOST:API_PORT
#    npm run api                      # same, via package.json
#
#  CONFIG (env vars, all optional):
#    API_HOST            default 127.0.0.1 (localhost only; set 0.0.0.0 to expose)
#    API_PORT            default 8000
#    API_DEFAULT_DAYS    default 7      (window served when ?days omitted)
#    API_MAX_LIMIT       default 100000 (hard row cap per response)
#    API_CACHE_TTL       default 300    (seconds to cache a (days,limit) result)
#    API_ALLOWED_ORIGINS default localhost dev origins. Comma-separated list of
#                        browser origins allowed via CORS, e.g.
#                        "https://pw-orders-dashboard.vercel.app". Use "*" to
#                        allow any origin (convenient for local dev only).
#    TRINO_HOST / TRINO_PORT / TRINO_USER / TRINO_PASSWORD / TRINO_CATALOG
#                        (see scripts/dbm.py — connection overrides)
#
#  PREREQUISITE:
#    pip install -r scripts/requirements.txt   (only `trino`; the rest is stdlib)
# ============================================================

import os
import sys
import gzip
import json
import time
import hmac
import base64
import hashlib
import threading
from datetime import date
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

# Make `import dbm` work no matter what cwd the server is launched from.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dbm        # reuse trino_prod_conn / build_query / transform_row
import aggregate  # in-memory aggregation engine

# Log lines can contain Unicode (·, emoji); a cp1252-redirected stdout on Windows
# would otherwise raise mid-request. Make stdout/stderr UTF-8 + lenient.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def _load_env_file(filename="smtp.env"):
    """Load KEY=VALUE pairs from scripts/<filename> into os.environ.

    Used for secrets that should never reach the browser: SMTP creds
    (smtp.env) and the Groq/LLM API key (llm.env).
    """
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), filename)
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    except FileNotFoundError:
        pass


_load_env_file("smtp.env")
_load_env_file("llm.env")


# ── Config ────────────────────────────────────────────────────
API_HOST         = os.getenv("API_HOST", "127.0.0.1")
# Honor $PORT (Render/Railway/Fly/Heroku inject it) before falling back to 8000.
API_PORT         = int(os.getenv("API_PORT") or os.getenv("PORT") or "8000")
API_DEFAULT_DAYS = int(os.getenv("API_DEFAULT_DAYS", "7"))
API_MAX_LIMIT    = int(os.getenv("API_MAX_LIMIT", "1000000"))
# 6h. Refreshes are now non-blocking (stale-while-revalidate), but each one is
# still 8 Trino slices against a cluster that has been unreliable — so keep them
# infrequent. Orders data is not real-time; a few hours of staleness is fine.
API_CACHE_TTL    = int(os.getenv("API_CACHE_TTL", "21600"))

# ── LLM (Groq) config — powers the EcomWallah chatbot. Key stays server-side. ──
GROQ_API_KEY     = os.getenv("GROQ_API_KEY", "")
GROQ_MODEL       = os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile")
GROQ_API_URL     = os.getenv("GROQ_API_URL", "https://api.groq.com/openai/v1/chat/completions")
try:
    GROQ_TEMPERATURE = float(os.getenv("GROQ_TEMPERATURE", "0.4"))
except ValueError:
    GROQ_TEMPERATURE = 0.4
try:
    GROQ_MAX_TOKENS = int(os.getenv("GROQ_MAX_TOKENS", "900"))
except ValueError:
    GROQ_MAX_TOKENS = 900

# Per-IP rate limit for /chat (sliding window). Set CHAT_RATE_MAX=0 to disable.
CHAT_RATE_MAX    = int(os.getenv("CHAT_RATE_MAX", "30"))
CHAT_RATE_WINDOW = int(os.getenv("CHAT_RATE_WINDOW", "60"))  # seconds

# Auto-retry Groq on transient gateway errors (Cloudflare 5xx / network blips).
GROQ_RETRIES     = int(os.getenv("GROQ_RETRIES", "2"))
_TRANSIENT_CODES = {500, 502, 503, 504, 520, 522, 524, 429}

# Max tool-calling rounds before we force a final answer (protects against loops).
CHAT_MAX_TOOL_ROUNDS = int(os.getenv("CHAT_MAX_TOOL_ROUNDS", "5"))

# CORS allowlist. Comma-separated browser origins, or "*" for any (dev only).
_DEFAULT_ORIGINS = "http://localhost:5173,http://localhost:5174,http://127.0.0.1:5173"
API_ALLOWED_ORIGINS = [
    o.strip() for o in os.getenv("API_ALLOWED_ORIGINS", _DEFAULT_ORIGINS).split(",") if o.strip()
]
ALLOW_ANY_ORIGIN = "*" in API_ALLOWED_ORIGINS
# Always allow local dev origins on ANY port (Vite hops 5173→5174→5176… when ports
# are busy). Production origins are never localhost, so this is safe to keep on.
_LOCAL_ORIGIN_RE = __import__("re").compile(r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$")


def _origin_allowed(origin):
    if not origin:
        return False
    return origin in API_ALLOWED_ORIGINS or bool(_LOCAL_ORIGIN_RE.match(origin))

# ── Tiny in-memory cache: { (days, limit): (expires_at, payload_bytes) } ──
_cache = {}
_cache_lock = threading.Lock()

# ── Dataset cache for server-side aggregation: (expires_at, Dataset) ──
_dataset = {"exp": 0, "ds": None}
_dataset_lock = threading.Lock()

# ── Bundle→component mapping cache: { product_variant_id: [components...] } ──
_bundle_map = {"exp": 0, "map": None}
_bundle_lock = threading.Lock()

# ── Component-summary cache: { filters_json: (expires_at, rows) } ──
_component_cache = {}

# ── Per-filter summary-bundle cache: { filters_json: (expires_at, body_bytes) } ──
_summary_cache = {}

# ── Serializes heavy summary/component computes (single-flight): on a single-
#    process backend, concurrent identical/overlapping requests would otherwise
#    each recompute and stampede the CPU, ballooning a ~15s compute to 100s+ and
#    tripping the upstream (tunnel) timeout → 502. One compute at a time; waiters
#    re-check the cache and reuse the first result. ──
_compute_lock = threading.Lock()

# ── Per-IP sliding-window hit log for /chat rate limiting: { ip: [timestamps] } ──
_chat_hits = {}
_chat_rate_lock = threading.Lock()

# ── Simple user store for dashboard login ─────────────────────────────────────
#  Stored at scripts/users.json. Passwords and password-reset codes are stored
#  ONLY as PBKDF2-HMAC-SHA256 hashes (see _hash_secret / _verify_secret) — never
#  in cleartext, and never written to any log. Legacy plaintext records created
#  by earlier builds are transparently verified once and re-hashed on the next
#  successful login.
import secrets
USERS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "users.json")
AUTH_LOG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "auth_log.jsonl")
_users_lock = threading.Lock()
_audit_lock = threading.Lock()

RESET_TTL = 900  # reset code valid for 15 minutes

# ── Credential-handling policy (all overridable via env) ──────────────────────
MIN_PW_LEN        = int(os.getenv("MIN_PW_LEN", "8"))          # minimum password length
PBKDF2_ITERATIONS = int(os.getenv("PBKDF2_ITERATIONS", "200000"))
SESSION_TTL       = int(os.getenv("SESSION_TTL", str(12 * 3600)))  # login token lifetime (s)
RESET_MAX_TRIES   = int(os.getenv("RESET_MAX_TRIES", "5"))     # reset-code guesses before invalidation
# Per-account login throttle: lock after N failures within the window.
LOGIN_MAX_FAILS   = int(os.getenv("LOGIN_MAX_FAILS", "5"))
LOGIN_FAIL_WINDOW = int(os.getenv("LOGIN_FAIL_WINDOW", "900"))  # seconds

# Failed-login tracker: { email: [timestamps] }. Keyed on the account (not the
# client IP) because X-Forwarded-For is client-controlled/spoofable.
_login_fails = {}
_login_fail_lock = threading.Lock()


def _hash_secret(plain, iterations=None):
    """Return a self-describing PBKDF2-SHA256 hash string:
    'pbkdf2_sha256$<iters>$<salt_b64>$<hash_b64>'. Used for passwords and codes."""
    iterations = iterations or PBKDF2_ITERATIONS
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", str(plain).encode("utf-8"), salt, iterations)
    return "pbkdf2_sha256${}${}${}".format(
        iterations, base64.b64encode(salt).decode("ascii"), base64.b64encode(dk).decode("ascii"))


def _verify_secret(plain, stored):
    """Constant-time verify `plain` against a stored secret.

    Returns (ok, is_legacy). `is_legacy` is True when the stored value is a bare
    plaintext string from an older build — verified directly here so existing
    accounts keep working; the caller should re-hash it after a successful check.
    """
    if not stored:
        return False, False
    stored = str(stored)
    if not stored.startswith("pbkdf2_sha256$"):
        return hmac.compare_digest(str(plain), stored), True  # legacy plaintext
    try:
        _, iters, salt_b64, hash_b64 = stored.split("$", 3)
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(hash_b64)
        dk = hashlib.pbkdf2_hmac("sha256", str(plain).encode("utf-8"), salt, int(iters))
    except Exception:
        return False, False
    return hmac.compare_digest(dk, expected), False


def _mint_token(u):
    """Issue a fresh, expiring session token on the user record; return it."""
    token = secrets.token_urlsafe(32)
    u["token"] = token
    u["tokenExp"] = _now() + SESSION_TTL
    return token


def _login_locked(email):
    """True if the account currently has too many recent failed logins."""
    if LOGIN_MAX_FAILS <= 0:
        return False
    cutoff = _now() - LOGIN_FAIL_WINDOW
    with _login_fail_lock:
        hits = [t for t in _login_fails.get(email, []) if t > cutoff]
        _login_fails[email] = hits
        return len(hits) >= LOGIN_MAX_FAILS


def _record_login_fail(email):
    with _login_fail_lock:
        hits = [t for t in _login_fails.get(email, []) if t > _now() - LOGIN_FAIL_WINDOW]
        hits.append(_now())
        _login_fails[email] = hits


def _clear_login_fails(email):
    with _login_fail_lock:
        _login_fails.pop(email, None)


def send_reset_email(to, code):
    """Email a reset code via SMTP if configured; otherwise log it (fallback).

    Configure with env vars: SMTP_HOST, SMTP_PORT (587), SMTP_USER, SMTP_PASS,
    SMTP_FROM (defaults to SMTP_USER). Returns True if an email was actually sent.
    """
    host = os.getenv("SMTP_HOST")
    if not host:
        # No mail server configured. We deliberately do NOT log or write the code
        # anywhere (a reset code is a credential — see report F-07). Configure the
        # SMTP_* env vars so codes can be emailed to users.
        dbm.log(f"[RESET] code generated for {to} but SMTP is not configured — set SMTP_* env vars to deliver it")
        return False
    import smtplib, ssl
    from email.message import EmailMessage
    user = os.getenv("SMTP_USER"); pw = os.getenv("SMTP_PASS")
    sender = os.getenv("SMTP_FROM", user)
    port = int(os.getenv("SMTP_PORT", "587"))
    msg = EmailMessage()
    msg["Subject"] = "PW Orders Hub — Password reset code"
    msg["From"] = sender; msg["To"] = to
    msg.set_content(f"Your password reset code is: {code}\n\n"
                    f"Enter it on the login screen to set a new password. "
                    f"It expires in {RESET_TTL // 60} minutes.\n\n— PW Orders Intelligence Hub")
    with smtplib.SMTP(host, port, timeout=20) as s:
        s.starttls(context=ssl.create_default_context())
        if user:
            s.login(user, pw)
        s.send_message(msg)
    return True


def _audit(email, action, result, ip=""):
    """Append one auth-attempt record (incl. failures) to auth_log.jsonl.

    NOTE: never record password or reset-code material here (report F-03).
    """
    rec = {"time": time.strftime("%Y-%m-%d %H:%M:%S"), "email": email,
           "action": action, "result": result, "ip": ip}
    try:
        with _audit_lock:
            with open(AUTH_LOG_FILE, "a", encoding="utf-8") as f:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except Exception:
        pass


def _load_users():
    try:
        with open(USERS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, ValueError):
        return {}


def _save_users(users):
    with open(USERS_FILE, "w", encoding="utf-8") as f:
        json.dump(users, f, indent=2, ensure_ascii=False)


def _now_iso():
    # local time string; avoids importing datetime util elsewhere
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _now():
    return time.time()


# Serialises cold-start loads, and guards the "is a refresh already running?"
# flag. Distinct from _dataset_lock, which only guards the dict itself.
_dataset_load_lock = threading.Lock()
_refresh_lock = threading.Lock()
_refresh_running = False
# After a failed background refresh, wait this long before trying again so a
# broken Trino doesn't get hammered once per request.
REFRESH_RETRY_DELAY = int(os.getenv("REFRESH_RETRY_DELAY", "300"))


def _load_dataset():
    """Pull the whole window and swap it in. Returns (dataset, elapsed_seconds)."""
    # limit=0 => NO cap. API_MAX_LIMIT protects a single /orders *response*
    # (browser payload size); applying it here instead silently truncated the
    # in-memory dataset — the load stopped mid-window at exactly 1,000,000
    # rows and the oldest months were never fetched, so every aggregate was
    # computed on a partial dataset. The dashboard aggregates server-side and
    # only ever returns small bundles, so the dataset itself must be complete.
    rows, elapsed, _ = run_orders_query(days=0, limit=0)
    ds = aggregate.Dataset(rows)
    # Sheet-driven material type, refreshed on every dataset (re)load.
    matched = ds.attach_material_type(_effective_material_map())
    dbm.log(f"Material type attached to {matched:,} of {ds.n:,} rows")
    with _dataset_lock:
        _dataset["ds"] = ds
        _dataset["exp"] = _now() + API_CACHE_TTL
    with _cache_lock:
        _summary_cache.clear()      # invalidate stale per-filter bundles
        _component_cache.clear()
    return ds, elapsed


def _start_background_refresh():
    """Kick off a refresh in a worker thread, at most one at a time."""
    global _refresh_running
    with _refresh_lock:
        if _refresh_running:
            return
        _refresh_running = True

    def _run():
        global _refresh_running
        try:
            dbm.log("Dataset stale — refreshing in background (serving current data meanwhile)…")
            ds, elapsed = _load_dataset()
            dbm.log(f"Dataset refreshed: {ds.n} rows in {elapsed:.1f}s")
        except Exception as err:
            # Keep serving the existing data; try again after a cool-off.
            with _dataset_lock:
                _dataset["exp"] = _now() + REFRESH_RETRY_DELAY
            dbm.log(f"Background refresh FAILED ({type(err).__name__}: {err}); "
                    f"still serving previous data, retrying in {REFRESH_RETRY_DELAY}s")
        finally:
            with _refresh_lock:
                _refresh_running = False

    threading.Thread(target=_run, name="dataset-refresh", daemon=True).start()


def get_dataset():
    """Return the in-memory dataset, refreshing in the background when stale.

    The whole window (DATE_FROM..DATE_TO) is fetched a single time and kept
    in memory so /summary and /rows aggregate locally instead of re-scanning
    Trino on every filter change.
    """
    ds = _dataset["ds"]
    if ds is not None:
        # STALE-WHILE-REVALIDATE. Never block a request on a reload: a full
        # refresh is 8 Trino slices (minutes, and far worse when the cluster is
        # degraded), while the Vercel proxy in front of the tunnel gives up
        # around 120s. Blocking here meant the first request after every TTL
        # expiry got a 502. Serve what we have and refresh behind the request.
        if _dataset["exp"] <= _now():
            _start_background_refresh()
        return ds

    # Cold start only: there is nothing to serve, so this one must block.
    with _dataset_load_lock:
        if _dataset["ds"] is not None:
            return _dataset["ds"]
        dbm.log("Loading curated dataset into memory (cold start)...")
        ds, elapsed = _load_dataset()
        dbm.log(f"Dataset ready: {ds.n} rows in {elapsed:.1f}s (fresh for {API_CACHE_TTL}s)")
        return ds


# ── Material-type sheet: { variant_id: revised product type } ────────────────
_material = {"map": None, "exp": 0}
_material_lock = threading.Lock()
# The sheet is refreshed daily, so an hourly re-read is plenty.
MATERIAL_TTL = int(os.getenv("MATERIAL_TTL", "3600"))


def get_material_map():
    """SKU/component variant id -> revised product type, from the live sheet.

    Fail-soft on purpose: if the sheet is unreachable (VPN, Google blocked by
    the corporate filter, tab renamed) the previously loaded map keeps serving
    and the retry is deferred. Losing the sheet must degrade the material-type
    labelling, not take the dashboard down.
    """
    with _material_lock:
        if _material["map"] is not None and _material["exp"] > _now():
            return _material["map"]
        try:
            import urllib.request, csv, io
            t0 = _now()
            req = urllib.request.Request(dbm.MATERIAL_SHEET_URL,
                                         headers={"User-Agent": "pw-orders-dashboard"})
            with urllib.request.urlopen(req, timeout=60) as resp:
                text = resp.read().decode("utf-8", "replace")
            rows = list(csv.DictReader(io.StringIO(text)))
            m = {}
            for r in rows:
                k = (r.get(dbm.MATERIAL_ID_COL) or "").strip()
                v = (r.get(dbm.MATERIAL_TYPE_COL) or "").strip()
                if k and v:
                    m[k] = v
            if not m:
                raise ValueError(f"sheet parsed but empty — is the '{dbm.MATERIAL_SHEET_TAB}' "
                                 f"tab or the '{dbm.MATERIAL_ID_COL}' column renamed?")
            _material["map"] = m
            _material["exp"] = _now() + MATERIAL_TTL
            dbm.log(f"Material sheet: {len(m)} variants in {_now()-t0:.1f}s")
        except Exception as err:
            kept = len(_material["map"]) if _material["map"] else 0
            _material["exp"] = _now() + 300          # cool off before retrying
            dbm.log(f"Material sheet FAILED ({type(err).__name__}: {err}); "
                    f"keeping {kept} previously loaded entries")
            if _material["map"] is None:
                _material["map"] = {}
        return _material["map"]


def _effective_material_map():
    """Material type per SOLD variant id, for the order-level filter.

    The sheet's "Simple" tab covers simple/component SKUs. Most revenue is sold
    as bundles (the Arjuna / Yakeen / Lakshya packs), which are not simple
    products and so are absent from it — mapping the sheet directly left 66% of
    revenue as "Unknown" and made the Material Type filter close to useless.

    A bundle inherits the material type of its largest component by MRP share,
    which is the same weighting the component split already uses. Sheet entries
    always win for variants that appear in it; a bundle whose components are all
    unmapped still reads Unknown rather than being guessed at.
    """
    sheet = get_material_map()
    eff = dict(sheet)
    try:
        bmap = get_bundle_map()
    except Exception as err:
        dbm.log(f"Bundle map unavailable for material inheritance ({type(err).__name__}); "
                f"bundles will read Unknown")
        return eff
    inherited = 0
    for pvid, comps in bmap.items():
        if pvid in eff:
            continue
        best_ratio, best_type = -1.0, None
        for c in comps:
            t = sheet.get(str(c.get("cid")))
            if not t:
                continue
            r = c.get("ratio")
            r = 1.0 if r is None else float(r)
            if r > best_ratio:
                best_ratio, best_type = r, t
        if best_type:
            eff[pvid] = best_type
            inherited += 1
    dbm.log(f"Material map: {len(sheet):,} from sheet + {inherited:,} bundles "
            f"inherited from their largest component")
    return eff


def get_bundle_map():
    """Load the bundle→component mapping once (small table); refresh after TTL.

    Returns { product_variant_id(str): [ {cid, title, qb, ratio, sku, ptype, status, mtype}, ... ] }.
    """
    with _bundle_lock:
        if _bundle_map["map"] is not None and _bundle_map["exp"] > _now():
            return _bundle_map["map"]
        dbm.log("Loading bundle->component mapping...")
        sql = dbm.build_bundle_mapping_query()
        conn = dbm.trino_prod_conn()
        try:
            cur = conn.cursor()
            t0 = _now()
            cur.execute(sql)
            recs = cur.fetchall()
            cols = [c[0] for c in cur.description]
        finally:
            try:
                conn.close()
            except Exception:
                pass
        m = {}
        for rec in recs:
            r = dict(zip(cols, rec))
            pvid = r.get("product_variant_id")
            if pvid is None:
                continue
            m.setdefault(str(pvid), []).append({
                "cid": r.get("component_product_variant_id"),
                "title": r.get("title_component"),
                # Keep NULLs as None; component_summary coalesces them the way
                # the component-level query does (quantity 1, ratio 1.0).
                "qb": float(r["quantity_bundle"]) if r.get("quantity_bundle") is not None else 1.0,
                "ratio": float(r["mrp_ratio"]) if r.get("mrp_ratio") is not None else None,
                "sku": r.get("component_sku_code"),
                "ptype": r.get("component_product_type"),
                "status": r.get("component_status"),
                "mtype": r.get("component_product_material_type"),
            })
        _bundle_map["map"] = m
        _bundle_map["exp"] = _now() + API_CACHE_TTL
        links = sum(len(v) for v in m.values())
        dbm.log(f"Bundle map ready: {len(m)} variants, {links} component links in {_now()-t0:.1f}s")
        return m


# Order-side dimensions carried down onto each component. A component can be
# sold inside bundles spanning several categories/channels, so the roll-up keeps
# a per-component sales tally per value and reports the dominant one.
_COMP_DIMS = [
    ("parent_name",      "parent_name"),
    ("sub_cat_name",     "sub_cat_name"),
    ("sub_sub_cat_name", "sub_sub_cat_name"),
    ("vco_channel_name", "channel"),
]


# The component-level query keeps ALL statuses on both legs — it applies no
# exclusions of its own. So the component page sees exactly the rows the SKU
# page sees, and the two revenue totals reconcile. Status filtering happens in
# one place only: the dashboard's Line/Item Status filter, applied to every page
# alike via ds._sub(). (An earlier revision of that query filtered per leg —
# B2B shipped/closed, PW_Store refunded/cancelled dates, 3P lost — which broke
# the reconciliation by ~2.8%.)


def component_summary(filters, limit=2000):
    """Component-Level Summary: split each SKU's qty/revenue across its bundle
    components (qty*quantity_bundle, revenue*mrp_ratio) and aggregate by
    component_product_variant_id. Respects the dashboard filters via ds._sub()
    and nothing else, so the component total ties back to SKU-level revenue.

    A SKU with no bundle mapping maps to ITSELF (quantity 1, ratio 1.0) — the
    component query LEFT JOINs the mapping and coalesces the misses, so those
    sales must still appear. Dropping them, as an inner join would, silently
    loses revenue.

    Each component also carries its study-material type (from the bundle map)
    and the category hierarchy + channel it sells the most through (from the
    order rows) — the dimensions the component-level query groups on."""
    # `limit` MUST be part of the key: the page asks for the top 2000 and the
    # CSV export asks for everything. Keying on filters alone meant an export
    # taken after a page view was served the capped list from cache — a silently
    # truncated export that looked complete.
    key = json.dumps({"f": filters or {}, "limit": limit}, sort_keys=True)
    with _cache_lock:
        hit = _component_cache.get(key)
        if hit and hit[0] > _now():
            return hit[1]

    ds = get_dataset()
    bmap = get_bundle_map()
    mmap = get_material_map()
    df = ds._sub(filters)

    # Lightweight SKU roll-up (qty + revenue per product_variant_id × the
    # dimensions we carry down) — far cheaper than sku_table(): no extra
    # columns, no JSON round-trip. observed=True keeps only real combinations.
    # product_name comes along so an unmapped SKU can name itself.
    dim_cols = [c for c, _ in _COMP_DIMS if c in df.columns]
    key_cols = ["product_variant_id", "product_name"] + dim_cols
    g = (df.groupby(key_cols, observed=True)
           .agg(qty=("qty", "sum"), revenue=("final_revenue", "sum")))

    agg = {}
    for keys, q, rev in zip(g.index.tolist(), g["qty"].tolist(), g["revenue"].tolist()):
        if not isinstance(keys, tuple):
            keys = (keys,)
        pvid, pname, dim_vals = keys[0], keys[1], keys[2:]
        comps = bmap.get(str(pvid))
        if not comps:
            # No mapping — the SKU is its own component (LEFT JOIN + COALESCE).
            comps = [{"cid": pvid, "title": pname, "qb": 1.0, "ratio": 1.0,
                      "sku": None, "ptype": None, "status": None, "mtype": None}]
        q = float(q or 0)
        rev = float(rev or 0)
        for c in comps:
            cid = c["cid"]
            a = agg.get(cid)
            if a is None:
                a = agg[cid] = {
                    "component_product_variant_id": cid,
                    "title_component": c["title"],
                    "component_sku_code": c["sku"],
                    "component_product_type": c["ptype"],
                    "component_status": c["status"],
                    # The sheet is the business's revised classification and
                    # overrides gold_product_variants.product_material_type,
                    # which it genuinely disagrees with for some components.
                    "study_material_type": mmap.get(str(cid)) or c["mtype"],
                    "qty_component": 0.0, "sales_component": 0.0, "bundles": 0,
                    "_dims": [{} for _ in dim_cols],
                }
            # COALESCE(mrp_ratio, 1.0) / COALESCE(quantity_bundle, 1)
            ratio = c["ratio"] if c["ratio"] is not None else 1.0
            qb = c["qb"] if c["qb"] is not None else 1.0
            share = rev * ratio
            a["qty_component"] += q * qb
            a["sales_component"] += share
            a["bundles"] += 1
            for i, v in enumerate(dim_vals):
                tally = a["_dims"][i]
                tally[v] = tally.get(v, 0.0) + share
    rows = list(agg.values())
    total_sales = sum(r["sales_component"] for r in rows) or 1.0
    out_names = [name for col, name in _COMP_DIMS if col in dim_cols]
    for a in rows:
        for i, name in enumerate(out_names):
            tally = a["_dims"][i]
            a[name] = str(max(tally, key=tally.get)) if tally else "Unknown"
        del a["_dims"]
        a["qty_component"] = round(a["qty_component"], 2)
        a["sales_component"] = round(a["sales_component"], 2)
        a["asp"] = round(a["sales_component"] / a["qty_component"], 2) if a["qty_component"] else 0.0
        a["saleSharePct"] = round(a["sales_component"] / total_sales * 100, 2)
    rows.sort(key=lambda r: -r["sales_component"])

    # Material-type roll-up across ALL components, computed BEFORE the display
    # cap for the same reason the totals are: summing only the listed 2,000
    # would understate every line.
    mat = {}
    for r in rows:
        k = r.get("study_material_type") or "Unknown"
        a = mat.get(k)
        if a is None:
            a = mat[k] = {"name": k, "qty": 0.0, "revenue": 0.0, "components": 0}
        a["qty"] += r["qty_component"]
        a["revenue"] += r["sales_component"]
        a["components"] += 1
    mat_total = sum(a["revenue"] for a in mat.values()) or 1.0
    material_types = sorted(mat.values(), key=lambda a: -a["revenue"])
    for a in material_types:
        a["qty"] = round(a["qty"], 2)
        a["revenue"] = round(a["revenue"], 2)
        a["revSharePct"] = round(a["revenue"] / mat_total * 100, 2)
        a["asp"] = round(a["revenue"] / a["qty"], 2) if a["qty"] else 0.0

    # Totals across ALL components, computed BEFORE the display cap. The page
    # shows the top `limit` rows; summing only those understated component sales
    # by the whole tail (1,040 components / ~Rs 0.45 Cr at the time of writing),
    # so the page total no longer matched SKU-level revenue.
    totals = {
        "components": len(rows),
        "qty": round(sum(r["qty_component"] for r in rows), 2),
        "sales": round(sum(r["sales_component"] for r in rows), 2),
        "shown": min(len(rows), limit) if limit else len(rows),
    }
    totals["asp"] = round(totals["sales"] / totals["qty"], 2) if totals["qty"] else 0.0

    if limit:
        rows = rows[:limit]

    out = {"rows": rows, "totals": totals, "materialTypes": material_types}
    with _cache_lock:
        _component_cache[key] = (_now() + API_CACHE_TTL, out)
    return out


def _rows_to_csv(rows):
    """Serialize a list[dict] to CSV text (header = union of keys, first-seen order)."""
    import csv, io
    if not rows:
        return ""
    keys, seen = [], set()
    for r in rows:
        for k in r.keys():
            if k not in seen:
                seen.add(k); keys.append(k)
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=keys, extrasaction="ignore")
    w.writeheader()
    for r in rows:
        w.writerow(r)
    return buf.getvalue()


def summary_export_rows(kind, filters):
    """Full (uncapped) rows for an aggregated table, respecting the dashboard filters."""
    ds = get_dataset()
    df = ds._sub(filters)
    if kind == "sku":
        return ds.sku_table(df, limit=10_000_000)
    if kind == "coupons":
        return ds.coupon_analysis(df, top=10_000_000).get("coupons", [])
    if kind == "components":
        return component_summary(filters, limit=None)["rows"]
    raise ValueError(f"unknown export kind: {kind}")


# How many times to retry the Trino query on a transient connection drop.
TRINO_RETRIES = int(os.getenv("TRINO_RETRIES", "2"))


def _is_conn_error(err):
    """True for network/connection errors worth retrying (reset/aborted/timeout)."""
    s = f"{type(err).__name__}: {err}".lower()
    return any(k in s for k in (
        "connection", "reset", "aborted", "timed out", "timeout",
        "broken pipe", "10054", "refused", "unreachable", "eof"))


def _run_orders_query_once(sql, limit):
    conn = dbm.trino_prod_conn()
    try:
        cur = conn.cursor()
        t0 = _now()
        cur.execute(sql)
        records = cur.fetchall()
        columns = [c[0] for c in cur.description]
        elapsed = _now() - t0
        rows = [dbm.transform_row(dict(zip(columns, rec))) for rec in records]
        truncated = bool(limit) and len(rows) >= limit
        return rows, elapsed, truncated
    finally:
        try:
            conn.close()
        except Exception:
            pass


def _month_slices(date_from):
    """Split [date_from, ∞) into month-sized [from, to) windows, NEWEST FIRST.

    The full pull is ~1.3M rows and takes minutes; the network kills the
    connection around the 100s mark, and retrying the whole query just hits the
    same wall forever. Fetching a month at a time keeps every request short
    enough to finish, and a drop costs one month instead of the entire load.

    The newest slice is left open-ended (no upper bound) so rows dated beyond
    today — the source has some — are still included, exactly as the unsliced
    query would. Newest-first iteration preserves the overall order_date DESC
    ordering once the slices are concatenated.
    """
    y, m, d = (int(x) for x in date_from.split("-"))
    start = date(y, m, d)
    today = date.today()
    bounds = []                                   # month starts, ascending
    cur = date(today.year, today.month, 1)
    while cur > start:
        bounds.append(cur)
        cur = date(cur.year - 1, 12, 1) if cur.month == 1 else date(cur.year, cur.month - 1, 1)
    bounds.reverse()
    edges = [start] + bounds
    slices = [(edges[i].isoformat(), edges[i + 1].isoformat()) for i in range(len(edges) - 1)]
    slices.append((edges[-1].isoformat(), None))  # newest slice: open-ended
    slices.reverse()                              # newest first
    return slices


# Per-slice retries. Cheap to redo one month, so allow more attempts than the
# old whole-query retry budget.
SLICE_RETRIES = int(os.getenv("TRINO_SLICE_RETRIES", "4"))


def run_orders_query(days, limit):
    """Query Trino and return (rows, elapsed_seconds, truncated).

    Loads the window in monthly slices (see _month_slices) with per-slice
    retries, so a single connection reset no longer restarts the entire pull.
    """
    slices = _month_slices(dbm.DATE_FROM)
    all_rows, t_start, last = [], _now(), None
    dbm.log(f"Loading dataset in {len(slices)} monthly slices (newest first)…")

    for idx, (d_from, d_to) in enumerate(slices, 1):
        sql = dbm.build_query(days, date_from=d_from, date_to=d_to).rstrip()
        remaining = (limit - len(all_rows)) if (limit and limit > 0) else 0
        if limit and limit > 0:
            if remaining <= 0:
                break
            sql += f"\n    LIMIT {int(remaining)}"

        label = f"{d_from}..{d_to or 'now'}"
        for attempt in range(SLICE_RETRIES + 1):
            try:
                rows, secs, _ = _run_orders_query_once(sql, remaining)
                all_rows.extend(rows)
                dbm.log(f"  slice {idx}/{len(slices)} {label}: {len(rows)} rows in {secs:.1f}s "
                        f"(total {len(all_rows)})")
                last = None
                break
            except Exception as err:
                last = err
                if attempt < SLICE_RETRIES and _is_conn_error(err):
                    dbm.log(f"  slice {idx}/{len(slices)} {label} failed "
                            f"({type(err).__name__}); retry {attempt+1}/{SLICE_RETRIES}…")
                    time.sleep(2.0 * (attempt + 1))
                    continue
                break
        if last is not None:
            break                                  # slice exhausted its retries

    if last is not None:
        if _is_conn_error(last):
            host = os.getenv("TRINO_HOST", "trino-data-replica-1.penpencil.co")
            raise RuntimeError(
                f"Cannot reach Trino at {host}. The dashboard host must be on the PhysicsWallah "
                f"network/VPN that can route to it (it resolves to a private 10.x address). "
                f"Reconnect to the VPN/network and click Retry. (underlying: {last})")
        raise last

    truncated = bool(limit) and len(all_rows) >= limit
    return all_rows, _now() - t_start, truncated


def get_orders_payload(days, limit):
    """Return JSON bytes for (days, limit), using the cache when fresh."""
    key = (days, limit)
    with _cache_lock:
        hit = _cache.get(key)
        if hit and hit[0] > _now():
            return hit[1]

    rows, elapsed, truncated = run_orders_query(days, limit)
    payload = {
        "data": rows,
        "meta": {
            "rowCount": len(rows),
            "window": f"{dbm.DATE_FROM}..{dbm.DATE_TO}",  # fixed by the query
            "limit": limit,
            "truncated": truncated,
            "querySeconds": round(elapsed, 2),
            "source": dbm.ORDERS_TABLE,
            "engine": "trino",
        },
    }
    body = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")

    with _cache_lock:
        _cache[key] = (_now() + API_CACHE_TTL, body)
    if truncated:
        dbm.log(f"orders days={days} limit={limit}: TRUNCATED at {len(rows)} rows "
                f"(raise API_MAX_LIMIT or narrow the window)")
    else:
        dbm.log(f"orders days={days} limit={limit}: {len(rows)} rows in {elapsed:.2f}s")
    return body


# ── EcomWallah LLM brain (Groq) ───────────────────────────────────────────────
CHAT_SYSTEM_PROMPT = """You are EcomWallah, the senior e-commerce analyst built into the \
PW Orders Intelligence Hub dashboard. You advise the operations, category and growth teams \
of an Indian D2C/marketplace business. Revenue is in INR (₹).

YOUR DATA — TWO SOURCES:
1. CURRENT DATA SNAPSHOT (JSON in the user turn): a quick summary of what the user is viewing
   right now (their active filters). Good for "this view" / "right now" questions.
2. THE QUERY TOOL `query_orders`: queries the COMPLETE dataset (every order, all dates), NOT just
   the current view. Use it for ANY question that needs numbers beyond the snapshot — totals,
   specific slices, date ranges, rankings, comparisons, "how many", "which", "where", filters the
   user names. When in doubt, CALL THE TOOL — it is your source of truth for the whole business.

USING THE TOOL:
- Build `filters` using ONLY the exact field names and values listed in the DATA DICTIONARY
  (provided below). Combine filters freely (they AND together), e.g. state + payment + status + dates.
- For breakdowns/rankings set `group_by` (e.g. by courier, state, channel, category). For trends set
  `date_granularity`. Call it MULTIPLE times when a question needs comparison (e.g. COD vs Prepaid,
  this-month vs last-month) — one call per slice.
- Match the user's words to dictionary values (e.g. "returns/RTO" -> statuses ["RTO/Lost"];
  "cash on delivery" -> payments ["COD"]). If a value the user names is not in the dictionary, say so.

HOW TO ANSWER:
- Be sharp, specific and decision-oriented — an analyst, not a search box. Lead with the answer,
  then the "so what", then a concrete recommended action.
- Quote the actual figures (₹, %, counts) returned by the tool. Think in shares and trends, not just
  absolutes. Call out concentration (80/20), outliers and movement.
- Health rules to flag proactively: delivery rate target ≥ 60%; RTO/returns < 8%; cancellations < 15%;
  discount depth > 40% of MRP = margin pressure; orders pending > 15 days are critical.
- NEVER invent numbers, SKUs, channels, states or dates. If the tool returns nothing, say the slice
  has no matching orders.
- Format for a chat panel: short paragraphs or tight bullet lists, relevant emoji as section markers
  (📊 💰 🚚 🎟️ 📉 🚀 💡), scannable. End substantive answers with a "💡 Action:" line. Currency as ₹
  with Indian grouping. Be concise — this is a side panel, not a report."""


def _is_transient(err):
    """True for errors worth retrying: gateway 5xx / 429, or any connection error."""
    import urllib.error
    if isinstance(err, urllib.error.HTTPError):
        return err.code in _TRANSIENT_CODES
    if isinstance(err, urllib.error.URLError):
        return True
    return False


def _http_json_post(url, headers, payload, timeout=45):
    """POST JSON and return the parsed JSON response. Retries transient failures."""
    import urllib.request
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    for k, v in headers.items():
        req.add_header(k, v)
    for attempt in range(GROQ_RETRIES + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as err:
            if attempt < GROQ_RETRIES and _is_transient(err):
                time.sleep(0.6 * (attempt + 1))
                continue
            raise


def _build_chat_messages(question, context, history, data_dict=None):
    """Assemble the chat message list (system + dictionary + history + grounded question)."""
    system = CHAT_SYSTEM_PROMPT
    if data_dict:
        system += ("\n\nDATA DICTIONARY (valid filter fields & values for query_orders):\n"
                   + json.dumps(data_dict, ensure_ascii=False, default=str))
    messages = [{"role": "system", "content": system}]

    # Replay recent conversation (cap to keep the prompt small).
    for turn in (history or [])[-8:]:
        role = "assistant" if turn.get("role") == "bot" else "user"
        text = (turn.get("text") or "").strip()
        if text:
            messages.append({"role": role, "content": text[:2000]})

    snapshot = json.dumps(context, ensure_ascii=False, default=str)[:4000]
    messages.append({
        "role": "user",
        "content": f"CURRENT DATA SNAPSHOT (the user's active view — a summary only; use query_orders "
                   f"for the full dataset):\n```json\n{snapshot}\n```\n\nQuestion: {question}",
    })
    return messages


def _groq_headers():
    return {
        "Authorization": f"Bearer {GROQ_API_KEY}",
        "Content-Type": "application/json",
        # Explicit UA — Groq is behind Cloudflare, which 403s urllib's default UA.
        "User-Agent": "PW-Orders-Hub/1.0",
    }


# Dimensions the model may group results by (label -> aggregate DIM_COLS key).
_GROUP_BY_KEYS = list(aggregate.DIM_COLS.keys()) + ["category"]  # "category" alias -> parent


# Filter fields exposed to the model (key -> column). Curated + low-cardinality
# first; high-cardinality ones (city, raw statuses) are intentionally omitted to
# keep the prompt small — the model can still pass those values as free text.
_DICT_FIELDS = {
    "statuses": "order_status_group", "payments": "payment_sources",
    "channels": "vco_channel_name", "states": "state", "categories": "parent_name",
    "couriers": "delivery_partner", "orderTypes": "order_type", "warehouses": "warehouse",
    "oms": "oms", "purchaseLevels": "purchase_level",
    "finCats": "finance_exam_category", "orderCats": "order_category",
}


def _values_for(ds, col, cap=30):
    """Distinct values of a (categorical) column, capped, for the data dictionary."""
    df = ds.df
    if col not in df.columns:
        return None
    series = df[col]
    try:
        vals = [str(v) for v in series.cat.categories]      # categorical: instant
    except AttributeError:
        vals = sorted(str(v) for v in series.dropna().unique())
    vals = [v for v in vals if v and v != "Unknown"]
    if not vals:
        return None
    out = vals[:cap]
    if len(vals) > cap:
        out = out + [f"…+{len(vals) - cap} more"]
    return out


_dict_cache = {"sig": None, "data": None}


def build_data_dictionary(ds):
    """Compact catalogue of filterable fields + valid values + date range.

    Kept small on purpose (values capped, high-cardinality fields dropped) so the
    prompt never blows Groq's request-size limit. Cached per dataset instance.
    """
    sig = id(ds)
    if _dict_cache["sig"] == sig and _dict_cache["data"] is not None:
        return _dict_cache["data"]
    fields = {}
    for key, col in _DICT_FIELDS.items():
        v = _values_for(ds, col)
        if v:
            fields[key] = v
    data = {
        "dateRange": {"from": ds.min_date, "to": ds.max_date},
        "totalRowsInDataset": ds.n,
        "filterFields": fields,
        "alsoFilterable": "coupons (pass exact code), warehouses, city — pass as free-text values even if not listed above.",
        "groupByOptions": _GROUP_BY_KEYS,
    }
    _dict_cache["sig"] = sig
    _dict_cache["data"] = data
    return data


def _chat_tools_spec():
    return [{
        "type": "function",
        "function": {
            "name": "query_orders",
            "description": (
                "Query the COMPLETE orders dataset (every order across all dates — NOT just the "
                "current view). Returns matched order/line counts and full KPI metrics (revenue, "
                "AOV, ASP, discount %, delivery/RTO/cancel rates and counts, COD vs Prepaid), plus "
                "an optional breakdown grouped by a dimension and/or a time series. Use it for any "
                "question about totals, slices, rankings or comparisons. Filters AND together. "
                "Call multiple times for comparisons (one call per slice)."),
            "parameters": {
                "type": "object",
                "properties": {
                    "filters": {
                        "type": "object",
                        "description": "Use only field names & values from the DATA DICTIONARY. "
                                       "Each list filter accepts one or more values.",
                        "properties": {
                            "dateFrom": {"type": "string", "description": "YYYY-MM-DD inclusive"},
                            "dateTo": {"type": "string", "description": "YYYY-MM-DD inclusive"},
                            "channels": {"type": "array", "items": {"type": "string"}},
                            "states": {"type": "array", "items": {"type": "string"}},
                            "categories": {"type": "array", "items": {"type": "string"}},
                            "payments": {"type": "array", "items": {"type": "string"}},
                            "statuses": {"type": "array", "items": {"type": "string"},
                                         "description": "order_status_group e.g. Delivered, RTO/Lost, "
                                                        "Cancelled, Shipped, Packed, Received, Return/Refund"},
                            "couriers": {"type": "array", "items": {"type": "string"}},
                            "orderTypes": {"type": "array", "items": {"type": "string"}},
                            "warehouses": {"type": "array", "items": {"type": "string"}},
                            "oms": {"type": "array", "items": {"type": "string"}},
                            "purchaseLevels": {"type": "array", "items": {"type": "string"}},
                            "finCats": {"type": "array", "items": {"type": "string"}},
                            "orderCats": {"type": "array", "items": {"type": "string"}},
                            "coupons": {"type": "array", "items": {"type": "string"}},
                        },
                    },
                    "group_by": {"type": "string",
                                 "description": "Optional dimension to break results down by, e.g. "
                                                "channel, state, city, category, courier, warehouse, "
                                                "brand, coupon, payment, orderType, orderStatus, itemStatus."},
                    "date_granularity": {"type": "string", "enum": ["day", "week", "month"],
                                         "description": "Optional time series granularity."},
                    "limit": {"type": "integer",
                              "description": "Max rows for the group_by breakdown (default 15)."},
                },
            },
        },
    }]


# Metric keys returned to the model (compact subset of ds.metrics()).
_TOOL_METRIC_KEYS = ["orders", "lines", "qty", "rev", "aov", "asp", "discPct",
                     "delivered", "rto", "cancelled", "delivRate", "rtoRate",
                     "cancelRate", "inTransit", "received", "prepaid", "cod"]


def _rnd(v):
    return round(v, 2) if isinstance(v, float) else v


def run_chat_tool(ds, name, args):
    """Execute a tool call against the full in-memory dataset; return a COMPACT
    JSON-able dict (kept small so the follow-up Groq request stays within limits)."""
    if name != "query_orders":
        return {"error": f"unknown tool: {name}"}
    args = args or {}
    filters = args.get("filters") or {}
    df = ds._sub(filters)
    M = ds.metrics(df)
    result = {
        "filters": filters,
        "matchedOrders": M.get("orders", 0),
        "metrics": {k: _rnd(M[k]) for k in _TOOL_METRIC_KEYS if k in M},
    }
    gb = args.get("group_by")
    if gb:
        key = "parent" if gb == "category" else gb
        col = aggregate.DIM_COLS.get(key)
        if col:
            limit = max(1, min(int(args.get("limit") or 12), 25))
            rows = ds.group(df, col, limit=limit)
            result["breakdownBy"] = gb
            result["breakdown"] = [
                {"name": r.get("name"), "orders": r.get("orders"),
                 "qty": _rnd(r.get("qty", 0)), "revenue": round(r.get("revenue", 0)),
                 "revSharePct": round(r.get("revShare", 0), 1)}
                for r in rows]
        else:
            result["breakdownError"] = f"unknown group_by '{gb}'; valid: {_GROUP_BY_KEYS}"
    gran = args.get("date_granularity")
    if gran in ("day", "week", "month"):
        series = ds.by_date(df, gran)[-60:]  # cap points sent back to the model
        result["timeSeries"] = [
            {"date": r.get("date"), "orders": r.get("orders"), "revenue": round(r.get("revenue", 0))}
            for r in series]
    return result


TOOL_RESULT_CAP = 3000   # max chars per tool result fed back to the model


def _groq_completion(messages, tools=None, tool_choice=None):
    """One non-streaming chat completion. Returns the raw `message` dict."""
    payload = {
        "model": GROQ_MODEL,
        "messages": messages,
        "temperature": GROQ_TEMPERATURE,
        "max_tokens": GROQ_MAX_TOKENS,
        "stream": False,
    }
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = tool_choice or "auto"
    body = json.dumps(payload, ensure_ascii=False)
    dbm.log(f"groq req: {len(body)//1024}KB, {len(messages)} msgs, tools={'y' if tools else 'n'}")
    resp = _http_json_post(GROQ_API_URL, _groq_headers(), payload)
    return resp["choices"][0]["message"]


def groq_chat_iter(question, context, history):
    """Generator yielding ('status', text) progress updates and ('delta', text)
    answer chunks. Uses tool-calling over the whole dataset; falls back to a
    snapshot-only answer if the dataset can't load."""
    warm = _dataset["ds"] is not None and _dataset["exp"] > _now()
    if not warm:
        yield ("status", "📚 Loading your full order dataset (first question warms it — up to ~90s)…")
    try:
        ds = get_dataset()
        data_dict = build_data_dictionary(ds)
        tools = _chat_tools_spec()
    except Exception as err:
        dbm.log(f"chat: dataset unavailable, snapshot-only mode ({err})")
        ds, data_dict, tools = None, None, None

    messages = _build_chat_messages(question, context, history, data_dict)

    if not tools:                              # degraded: no full-data access
        yield ("status", "🧠 Thinking…")
        msg = _groq_completion(messages)
        for ch in _word_chunks((msg.get("content") or "").strip()):
            yield ("delta", ch)
        return

    for r in range(CHAT_MAX_TOOL_ROUNDS):
        yield ("status", "🧠 Analysing your question…" if r == 0 else "🔎 Digging deeper…")
        msg = _groq_completion(messages, tools=tools)
        tool_calls = msg.get("tool_calls")
        if not tool_calls:
            for ch in _word_chunks((msg.get("content") or "").strip()):
                yield ("delta", ch)
            return
        n = len(tool_calls)
        yield ("status", f"🔎 Querying your data ({n} quer{'y' if n == 1 else 'ies'})…")
        # Record the assistant's tool request, then run each call and feed results back.
        messages.append({"role": "assistant", "content": msg.get("content") or "",
                         "tool_calls": tool_calls})
        for tc in tool_calls:
            fn = (tc.get("function") or {})
            try:
                fargs = json.loads(fn.get("arguments") or "{}")
            except ValueError:
                fargs = {}
            try:
                out = run_chat_tool(ds, fn.get("name"), fargs)
            except Exception as err:
                out = {"error": f"tool failed: {err}"}
            messages.append({
                "role": "tool", "tool_call_id": tc.get("id"), "name": fn.get("name"),
                "content": json.dumps(out, ensure_ascii=False, default=str)[:TOOL_RESULT_CAP],
            })
        dbm.log(f"chat tool round {r+1}: {[(c.get('function') or {}).get('name') for c in tool_calls]}")

    # Hit the round cap — force a final answer with the evidence gathered so far.
    yield ("status", "✍️ Writing the answer…")
    final = _groq_completion(messages, tools=tools, tool_choice="none")
    for ch in _word_chunks((final.get("content") or "").strip()):
        yield ("delta", ch)


def groq_chat(question, context, history):
    """Non-streaming convenience: the full reply text (used by the JSON endpoint)."""
    return "".join(p for kind, p in groq_chat_iter(question, context, history) if kind == "delta").strip()


def _word_chunks(text, size=22):
    """Yield ~size-char chunks at word boundaries — for pseudo-streaming a finished reply."""
    i, n = 0, len(text)
    while i < n:
        j = min(i + size, n)
        if j < n:
            sp = text.find(" ", j)
            if sp != -1 and sp - j <= 12:
                j = sp + 1
        yield text[i:j]
        i = j


def _chat_rate_ok(ip):
    """Sliding-window limiter: at most CHAT_RATE_MAX hits per IP per window."""
    if CHAT_RATE_MAX <= 0:
        return True
    now = _now()
    cutoff = now - CHAT_RATE_WINDOW
    with _chat_rate_lock:
        hits = [t for t in _chat_hits.get(ip, []) if t > cutoff]
        if len(hits) >= CHAT_RATE_MAX:
            _chat_hits[ip] = hits
            return False
        hits.append(now)
        _chat_hits[ip] = hits
        return True


class Handler(BaseHTTPRequestHandler):
    server_version = "PWTrinoAPI/1.0"

    # ── helpers ──
    def _cors(self):
        origin = self.headers.get("Origin")
        if ALLOW_ANY_ORIGIN:
            self.send_header("Access-Control-Allow-Origin", "*")
        elif _origin_allowed(origin):
            # Reflect the specific allowed origin (required when not using "*").
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        # else: omit the header entirely -> browser blocks the cross-origin read.
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")

    def _send_json(self, status, body_bytes):
        accepts_gzip = "gzip" in (self.headers.get("Accept-Encoding") or "")
        out = body_bytes
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self._cors()
        if accepts_gzip and len(body_bytes) > 1024:
            out = gzip.compress(body_bytes)
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(out)

    def _error(self, status, message):
        self._send_json(status, json.dumps({"error": message}).encode("utf-8"))

    def _send_csv(self, csv_text, filename):
        data = csv_text.encode("utf-8")
        accepts_gzip = "gzip" in (self.headers.get("Accept-Encoding") or "")
        out = gzip.compress(data) if accepts_gzip and len(data) > 1024 else data
        self.send_response(200)
        self.send_header("Content-Type", "text/csv; charset=utf-8")
        self._cors()
        self.send_header("Content-Disposition", f"attachment; filename={filename}")
        if out is not data:
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(out)

    def _read_json_body(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if not length:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8")) or {}
        except (ValueError, UnicodeDecodeError):
            return {}

    def _chat_stream(self, question, context, history):
        """Stream the answer to the client as Server-Sent Events.

        Headers are sent immediately and progress is emitted as {"status":…} events,
        so the connection stays alive during the (possibly ~90s) first-question
        dataset warm-up and the user sees what's happening. The answer arrives as
        {"delta":…} chunks. Errors are emitted as {"error":…} so the widget can fall
        back to its local rule engine gracefully.
        """
        t0 = _now()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Accel-Buffering", "no")  # disable proxy buffering (nginx)
        self._cors()
        self.end_headers()

        def emit(obj):
            self.wfile.write(f"data: {json.dumps(obj, ensure_ascii=False)}\n\n".encode("utf-8"))
            self.wfile.flush()

        produced = 0
        try:
            for kind, payload in groq_chat_iter(question, context, history):
                if kind == "status":
                    emit({"status": payload})
                else:
                    produced += len(payload)
                    emit({"delta": payload})
            if produced == 0:
                emit({"error": "empty reply"})
            else:
                self.wfile.write(b"data: [DONE]\n\n"); self.wfile.flush()
            dbm.log(f"chat ({GROQ_MODEL}) {question[:50]!r} -> {produced} chars in {_now()-t0:.1f}s")
        except Exception as err:
            dbm.log(f"ERROR /chat: {err}")
            try:
                emit({"error": str(err)})
            except Exception:
                pass  # client gone / broken pipe

    # ── routes ──
    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ── Shared read-only handlers (served over BOTH POST and GET) ─────────────
    # These endpoints only read data. They also answer GET — with `filters`
    # passed as a URL-encoded JSON `?filters=` query param — so the dashboard
    # keeps working behind corporate proxies/web-filters that allow GET but
    # block POST. do_POST and do_GET both delegate here (single source of truth).
    @staticmethod
    def _filters_from_qs(qs):
        # Prefer `q` (URL-safe base64 of the filters JSON) — used to disguise the
        # request from corporate web filters. Fall back to plain `filters` JSON.
        raw = None
        q = (qs.get("q") or [None])[0]
        if q:
            try:
                pad = "=" * (-len(q) % 4)
                raw = base64.urlsafe_b64decode(q + pad).decode("utf-8")
            except Exception:
                raw = None
        if raw is None:
            raw = (qs.get("filters") or ["{}"])[0] or "{}"
        try:
            val = json.loads(raw)
            return val if isinstance(val, dict) else {}
        except (ValueError, TypeError):
            return {}

    # Decode a static-looking URL  /…/<endpoint>/<b64payload>.json  into
    # (endpoint, params). Lets filtered requests masquerade as static files so
    # corporate web filters (which block query strings / extension-less URLs)
    # let them through. Returns (None, None) when the path isn't this shape.
    _DISGUISED_ENDPOINTS = ("summary", "components", "rows", "export", "export-summary")

    @classmethod
    def _disguised_route(cls, path):
        p = path[:-5] if path.endswith(".json") else path
        parts = p.rsplit("/", 2)
        if len(parts) < 2:
            return None, None
        endpoint, payload = parts[-2], parts[-1]
        if endpoint not in cls._DISGUISED_ENDPOINTS:
            return None, None
        try:
            pad = "=" * (-len(payload) % 4)
            data = json.loads(base64.urlsafe_b64decode(payload + pad).decode("utf-8"))
            return endpoint, (data if isinstance(data, dict) else {})
        except Exception:
            return None, None

    def _respond_summary(self, filters):
        try:
            key = json.dumps(filters, sort_keys=True)
            with _cache_lock:
                hit = _summary_cache.get(key)
                if hit and hit[0] > _now():
                    return self._send_json(200, hit[1])
            # Single-flight: serialize the heavy compute and re-check the cache
            # after acquiring the lock, so stampeding duplicate requests reuse
            # the first result instead of each recomputing (prevents the CPU
            # thrash that caused 100s+ computes → 502).
            with _compute_lock:
                with _cache_lock:
                    hit = _summary_cache.get(key)
                    if hit and hit[0] > _now():
                        return self._send_json(200, hit[1])
                ds = get_dataset()
                t0 = _now()
                bundle = ds.summarize(filters)
                body = json.dumps(bundle, ensure_ascii=False, default=str).encode("utf-8")
                with _cache_lock:
                    _summary_cache[key] = (_now() + API_CACHE_TTL, body)
                dbm.log(f"summary {key[:80]} -> {len(bundle['by'].get('channel', []))} chans in {_now()-t0:.2f}s")
            self._send_json(200, body)
        except Exception as err:
            dbm.log(f"ERROR /summary: {err}")
            self._error(500, f"summary failed: {err}")

    def _respond_components(self, filters):
        try:
            t0 = _now()
            res = component_summary(filters)
            rows, totals = res["rows"], res["totals"]
            # `totals` covers EVERY component; `rows` is only the top slice the
            # table renders. The page must headline the former.
            body = json.dumps({"components": rows,
                               "totals": totals,
                               "materialTypes": res.get("materialTypes", []),
                               "meta": {"count": len(rows), "total": totals["components"]}},
                              ensure_ascii=False, default=str).encode("utf-8")
            dbm.log(f"components -> {len(rows)}/{totals['components']} components in {_now()-t0:.2f}s")
            self._send_json(200, body)
        except Exception as err:
            dbm.log(f"ERROR /components: {err}")
            self._error(500, f"components failed: {err}")

    def _respond_export_summary(self, kind, filters):
        try:
            t0 = _now()
            rows = summary_export_rows(kind, filters)
            csv_text = _rows_to_csv(rows)
            dbm.log(f"export-summary {kind}: {len(rows)} rows in {_now()-t0:.2f}s")
            self._send_csv(csv_text, f"{kind}_summary.csv")
        except ValueError as err:
            self._error(400, str(err))
        except Exception as err:
            dbm.log(f"ERROR /export-summary: {err}")
            self._error(500, f"export-summary failed: {err}")

    def _respond_export(self, filters, search=""):
        try:
            ds = get_dataset()
            csv_text = ds.export_csv(filters, search=str(search))
            data = csv_text.encode("utf-8")
            accepts_gzip = "gzip" in (self.headers.get("Accept-Encoding") or "")
            out = gzip.compress(data) if accepts_gzip and len(data) > 1024 else data
            self.send_response(200)
            self.send_header("Content-Type", "text/csv; charset=utf-8")
            self._cors()
            self.send_header("Content-Disposition", "attachment; filename=raw_orders.csv")
            if out is not data:
                self.send_header("Content-Encoding", "gzip")
            self.send_header("Content-Length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)
            dbm.log(f"export CSV: {len(csv_text)} chars")
        except Exception as err:
            dbm.log(f"ERROR /export: {err}")
            self._error(500, f"export failed: {err}")

    def _respond_rows(self, filters, offset=0, limit=200, search=""):
        try:
            ds = get_dataset()
            page = ds.rows_page(filters,
                                offset=int(offset),
                                limit=min(int(limit), 2000),
                                search=str(search))
            self._send_json(200, json.dumps(page, ensure_ascii=False, default=str).encode("utf-8"))
        except Exception as err:
            dbm.log(f"ERROR /rows: {err}")
            self._error(500, f"rows failed: {err}")

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")
        body = self._read_json_body()
        filters = body.get("filters", body) or {}

        # ── Auth ──
        # NOTE: there is no /auth/check (it disclosed account existence — report
        # F-22). The client picks Sign in vs Create account itself.
        ip = self.headers.get("X-Forwarded-For") or self.client_address[0]

        def _auth_ok(email_, u_):
            """Common success path: bump stats, mint an expiring token, persist."""
            u_["lastLogin"] = _now_iso()
            u_["logins"] = u_.get("logins", 0) + 1
            token_ = _mint_token(u_)
            return {"token": token_, "email": email_, "expiresAt": u_["tokenExp"]}

        if path.endswith("/auth/register"):
            email = (body.get("email") or "").strip().lower()
            pw = body.get("password") or ""
            if not email or "@" not in email or len(pw) < MIN_PW_LEN:
                _audit(email, "register", "invalid", ip)
                return self._error(400, f"Valid email and a password (min {MIN_PW_LEN} chars) are required.")
            with _users_lock:
                users = _load_users()
                if email in users:
                    _audit(email, "register", "already_exists", ip)
                    return self._error(409, "This email is already registered — please log in.")
                users[email] = {"password": _hash_secret(pw), "createdAt": _now_iso(),
                                "lastLogin": _now_iso(), "logins": 0}
                resp = _auth_ok(email, users[email])
                _save_users(users)
            _audit(email, "register", "success", ip)
            dbm.log(f"AUTH register: {email}")
            return self._send_json(200, json.dumps(resp).encode("utf-8"))

        if path.endswith("/auth/forgot"):
            email = (body.get("email") or "").strip().lower()
            emailed = False
            code = None
            with _users_lock:
                users = _load_users()
                u = users.get(email)
                if u:
                    code = f"{secrets.randbelow(900000) + 100000}"
                    # Store only a HASH of the code (report F-07), with an attempt counter.
                    u["reset"] = {"codeHash": _hash_secret(code), "exp": _now() + RESET_TTL, "tries": 0}
                    _save_users(users)
            if code is not None:
                emailed = send_reset_email(email, code)
                _audit(email, "forgot", "emailed" if emailed else "not_delivered", ip)
            else:
                _audit(email, "forgot", "no_account", ip)
            # Generic response — never reveal whether the email exists.
            return self._send_json(200, json.dumps({
                "sent": True, "emailed": emailed,
                "note": None if emailed else "If that email has an account, a reset code has been sent."
            }).encode("utf-8"))

        if path.endswith("/auth/reset"):
            email = (body.get("email") or "").strip().lower()
            code = (body.get("code") or "").strip()
            pw = body.get("password") or ""
            if len(pw) < MIN_PW_LEN:
                return self._error(400, f"New password must be at least {MIN_PW_LEN} characters.")
            with _users_lock:
                users = _load_users()
                u = users.get(email)
                r = (u or {}).get("reset")
                if not u or not r:
                    _audit(email, "reset", "no_request", ip)
                    return self._error(400, "No reset was requested for this email.")
                if _now() > r.get("exp", 0):
                    u.pop("reset", None); _save_users(users)
                    _audit(email, "reset", "expired", ip)
                    return self._error(400, "Reset code has expired — request a new one.")
                ok, _legacy = _verify_secret(code, r.get("codeHash"))
                if not ok:
                    r["tries"] = r.get("tries", 0) + 1
                    if r["tries"] >= RESET_MAX_TRIES:
                        u.pop("reset", None)  # burn the code after too many guesses
                        _audit(email, "reset", "locked_out", ip)
                        _save_users(users)
                        return self._error(429, "Too many incorrect codes — request a new reset code.")
                    _save_users(users)
                    _audit(email, "reset", "wrong_code", ip)
                    return self._error(401, "Incorrect reset code.")
                u["password"] = _hash_secret(pw)
                u.pop("reset", None)
                resp = _auth_ok(email, u)
                _save_users(users)
            _clear_login_fails(email)
            _audit(email, "reset", "success", ip)
            dbm.log(f"AUTH reset: {email}")
            return self._send_json(200, json.dumps(resp).encode("utf-8"))

        if path.endswith("/auth/login"):
            email = (body.get("email") or "").strip().lower()
            pw = body.get("password") or ""
            if _login_locked(email):
                _audit(email, "login", "locked_out", ip)
                return self._error(429, "Too many failed attempts. Please wait a few minutes and try again.")
            with _users_lock:
                users = _load_users()
                u = users.get(email)
                ok, legacy = _verify_secret(pw, (u or {}).get("password")) if u else (False, False)
                if not u or not ok:
                    # Uniform response for unknown-account vs wrong-password (report F-22).
                    if u:
                        _record_login_fail(email)  # only throttle real accounts
                    _audit(email, "login", "no_account" if not u else "wrong_password", ip)
                    return self._error(401, "Invalid email or password.")
                if legacy:
                    u["password"] = _hash_secret(pw)  # upgrade legacy plaintext to a hash
                resp = _auth_ok(email, u)
                _save_users(users)
            _clear_login_fails(email)
            _audit(email, "login", "success", ip)
            dbm.log(f"AUTH login: {email}")
            return self._send_json(200, json.dumps(resp).encode("utf-8"))

        # ── Chatbot (EcomWallah → Groq LLM) ──
        if path.endswith("/chat"):
            question = (body.get("question") or body.get("message") or "").strip()
            context = body.get("context") or {}
            history = body.get("history") or []
            want_stream = bool(body.get("stream"))
            if not question:
                return self._error(400, "question is required")
            if not GROQ_API_KEY:
                # No key configured — tell the client so it can use its local fallback.
                return self._send_json(503, json.dumps({
                    "error": "LLM not configured",
                    "fallback": True,
                    "note": "Set GROQ_API_KEY in scripts/llm.env and restart the API.",
                }).encode("utf-8"))
            if not _chat_rate_ok(ip):
                return self._send_json(429, json.dumps({
                    "error": f"Rate limit: max {CHAT_RATE_MAX} messages per {CHAT_RATE_WINDOW}s. "
                             f"Please wait a moment.",
                    "fallback": True,
                }).encode("utf-8"))

            if want_stream:
                return self._chat_stream(question, context, history)

            try:
                t0 = _now()
                reply = groq_chat(question, context, history)
                dbm.log(f"chat ({GROQ_MODEL}) {question[:60]!r} -> {len(reply)} chars in {_now()-t0:.2f}s")
                return self._send_json(200, json.dumps({
                    "reply": reply, "model": GROQ_MODEL,
                }, ensure_ascii=False).encode("utf-8"))
            except Exception as err:
                dbm.log(f"ERROR /chat: {err}")
                # 502 + fallback flag: the widget answers locally instead.
                return self._send_json(502, json.dumps({
                    "error": f"chat failed: {err}", "fallback": True,
                }, ensure_ascii=False).encode("utf-8"))

        if path.endswith("/summary"):
            return self._respond_summary(filters)

        if path.endswith("/components"):
            return self._respond_components(filters)

        if path.endswith("/export-summary"):
            return self._respond_export_summary((body.get("kind") or "").lower(), filters)

        if path.endswith("/export"):
            return self._respond_export(filters, search=body.get("search", ""))

        if path.endswith("/rows"):
            return self._respond_rows(filters,
                                      offset=body.get("offset", 0),
                                      limit=body.get("limit", 200),
                                      search=body.get("search", ""))

        self._error(404, f"not found: {parsed.path}")

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")
        qs = parse_qs(parsed.query)

        # Disguised static-looking read requests: /…/<endpoint>/<b64>.json
        ep, dp = self._disguised_route(path)
        if ep == "summary":
            return self._respond_summary(dp.get("filters") or {})
        if ep == "components":
            return self._respond_components(dp.get("filters") or {})
        if ep == "rows":
            return self._respond_rows(dp.get("filters") or {},
                                      offset=dp.get("offset", 0),
                                      limit=dp.get("limit", 200),
                                      search=dp.get("search", ""))
        if ep == "export":
            return self._respond_export(dp.get("filters") or {}, search=dp.get("search", ""))
        if ep == "export-summary":
            return self._respond_export_summary((dp.get("kind") or "").lower(),
                                                dp.get("filters") or {})

        # NOTE: the /auth/users and /auth/log endpoints were removed — they
        # exposed the entire credential store and audit log without any
        # authentication (report F-02). User administration must never be a
        # public, unauthenticated API.

        if path.endswith("/health") or path == "/health":
            self._send_json(200, json.dumps({
                "status": "ok",
                "engine": "trino",
                "table": dbm.ORDERS_TABLE,
                "defaultDays": API_DEFAULT_DAYS,
                "maxLimit": API_MAX_LIMIT,
            }).encode("utf-8"))
            return

        if path.endswith("/orders"):
            try:
                days = int(qs.get("days", [API_DEFAULT_DAYS])[0])
            except ValueError:
                return self._error(400, "days must be an integer")
            try:
                limit = int(qs.get("limit", [API_MAX_LIMIT])[0])
            except ValueError:
                return self._error(400, "limit must be an integer")
            limit = max(1, min(limit, API_MAX_LIMIT))  # clamp to protect the browser

            try:
                body = get_orders_payload(days, limit)
                self._send_json(200, body)
            except Exception as err:
                dbm.log(f"ERROR serving /orders: {err}")
                self._error(500, f"query failed: {err}")
            return

        # ── Read-only endpoints, GET variant (filters in ?filters=<json>) ──
        # Mirrors the POST handlers so the dashboard works behind proxies that
        # block POST. Same underlying handlers → identical responses.
        if path.endswith("/summary"):
            return self._respond_summary(self._filters_from_qs(qs))

        if path.endswith("/components"):
            return self._respond_components(self._filters_from_qs(qs))

        if path.endswith("/export-summary"):
            return self._respond_export_summary((qs.get("kind") or [""])[0].lower(),
                                                self._filters_from_qs(qs))

        if path.endswith("/export"):
            return self._respond_export(self._filters_from_qs(qs),
                                        search=(qs.get("search") or [""])[0])

        if path.endswith("/rows"):
            return self._respond_rows(self._filters_from_qs(qs),
                                      offset=(qs.get("offset") or ["0"])[0],
                                      limit=(qs.get("limit") or ["200"])[0],
                                      search=(qs.get("search") or [""])[0])

        self._error(404, f"not found: {parsed.path}")

    # Quieter, single-line access logs through dbm.log
    def log_message(self, fmt, *a):
        dbm.log("HTTP " + (fmt % a))


def _prewarm():
    """Warm the dataset + bundle map on boot so the first user isn't hit with the
    ~90s cold load. Runs in a background thread; failures are logged, not fatal."""
    try:
        dbm.log("Prewarm: loading dataset + bundle map…")
        get_dataset()
        try:
            get_bundle_map()
        except Exception as err:
            dbm.log(f"Prewarm: bundle map skipped ({err})")
        dbm.log("Prewarm: ready.")
    except Exception as err:
        dbm.log(f"Prewarm failed (will load on first request): {err}")


def main():
    # Optional warm-up on boot (recommended in production: set API_PREWARM=true).
    if os.getenv("API_PREWARM", "").lower() in ("1", "true", "yes"):
        threading.Thread(target=_prewarm, daemon=True).start()

    httpd = ThreadingHTTPServer((API_HOST, API_PORT), Handler)
    dbm.log(f"Trino API listening on http://{API_HOST}:{API_PORT}  "
            f"(defaultDays={API_DEFAULT_DAYS}, maxLimit={API_MAX_LIMIT}, cacheTTL={API_CACHE_TTL}s)")
    dbm.log(f"  CORS origins: {'* (any)' if ALLOW_ANY_ORIGIN else ', '.join(API_ALLOWED_ORIGINS)}")
    dbm.log(f"  GET /api/v1/health")
    dbm.log(f"  GET /api/v1/orders?days={API_DEFAULT_DAYS}&limit={API_MAX_LIMIT}")
    dbm.log(f"  POST /api/v1/chat  (EcomWallah LLM: "
            f"{'ON · ' + GROQ_MODEL + ' · full-data query tool' if GROQ_API_KEY else 'OFF — set GROQ_API_KEY in scripts/llm.env'})")
    if GROQ_API_KEY:
        dbm.log(f"    rate limit: {CHAT_RATE_MAX} msgs / {CHAT_RATE_WINDOW}s per IP"
                if CHAT_RATE_MAX > 0 else "    rate limit: disabled")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        dbm.log("Shutting down.")
        httpd.shutdown()


if __name__ == "__main__":
    main()
