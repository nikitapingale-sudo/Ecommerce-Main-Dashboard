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
import threading
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
API_CACHE_TTL    = int(os.getenv("API_CACHE_TTL", "3600"))

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

# ── Per-IP sliding-window hit log for /chat rate limiting: { ip: [timestamps] } ──
_chat_hits = {}
_chat_rate_lock = threading.Lock()

# ── Simple user store for dashboard login ─────────────────────────────────────
#  Stored at scripts/users.json. NOTE: passwords are kept in PLAINTEXT here
#  because the admin asked to see them — this is fine for an internal tool but
#  is NOT secure. Ask to switch to hashed passwords for anything public-facing.
import secrets
USERS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "users.json")
AUTH_LOG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "auth_log.jsonl")
_users_lock = threading.Lock()
_audit_lock = threading.Lock()


RESET_TTL = 900  # reset code valid for 15 minutes


def send_reset_email(to, code):
    """Email a reset code via SMTP if configured; otherwise log it (fallback).

    Configure with env vars: SMTP_HOST, SMTP_PORT (587), SMTP_USER, SMTP_PASS,
    SMTP_FROM (defaults to SMTP_USER). Returns True if an email was actually sent.
    """
    host = os.getenv("SMTP_HOST")
    if not host:
        # Fallback: no mail server configured — record the code so the admin can relay it.
        dbm.log(f"[RESET CODE] {to} -> {code}  (set SMTP_* env vars to email this automatically)")
        try:
            with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "reset_codes.log"), "a", encoding="utf-8") as f:
                f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')}  {to}  {code}\n")
        except Exception:
            pass
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


def _audit(email, action, result, password=None, ip=""):
    """Append one auth-attempt record (incl. failures) to auth_log.jsonl."""
    rec = {"time": time.strftime("%Y-%m-%d %H:%M:%S"), "email": email,
           "action": action, "result": result, "ip": ip}
    if password is not None:
        rec["password"] = password
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


def get_dataset():
    """Load the full curated dataset into memory once; refresh after TTL.

    The whole window (DATE_FROM..DATE_TO) is fetched a single time and kept
    in memory so /summary and /rows aggregate locally instead of re-scanning
    Trino on every filter change.
    """
    with _dataset_lock:
        if _dataset["ds"] is not None and _dataset["exp"] > _now():
            return _dataset["ds"]
    # Build outside the lock would risk a double-load; keep it simple and
    # load under the lock (first request pays the ~60s cost, others wait).
    with _dataset_lock:
        if _dataset["ds"] is not None and _dataset["exp"] > _now():
            return _dataset["ds"]
        dbm.log("Loading curated dataset into memory (one-time per TTL)...")
        rows, elapsed, _ = run_orders_query(days=0, limit=API_MAX_LIMIT)
        ds = aggregate.Dataset(rows)
        _dataset["ds"] = ds
        _dataset["exp"] = _now() + API_CACHE_TTL
        _summary_cache.clear()  # invalidate stale per-filter bundles
        _component_cache.clear()
        dbm.log(f"Dataset ready: {ds.n} rows in {elapsed:.1f}s (cached {API_CACHE_TTL}s)")
        return ds


def get_bundle_map():
    """Load the bundle→component mapping once (small table); refresh after TTL.

    Returns { product_variant_id(str): [ {cid, title, qb, ratio, sku, ptype, status}, ... ] }.
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
                "qb": float(r.get("quantity_bundle") or 0),
                "ratio": float(r.get("mrp_ratio") or 0),
                "sku": r.get("component_sku_code"),
                "ptype": r.get("component_product_type"),
                "status": r.get("component_status"),
            })
        _bundle_map["map"] = m
        _bundle_map["exp"] = _now() + API_CACHE_TTL
        links = sum(len(v) for v in m.values())
        dbm.log(f"Bundle map ready: {len(m)} variants, {links} component links in {_now()-t0:.1f}s")
        return m


def component_summary(filters, limit=2000):
    """Component-Level Summary: split each filtered SKU's qty/revenue across its
    bundle components (qty*quantity_bundle, revenue*mrp_ratio) and aggregate by
    component_product_variant_id. Respects all dashboard filters via ds._sub()."""
    key = json.dumps(filters or {}, sort_keys=True)
    with _cache_lock:
        hit = _component_cache.get(key)
        if hit and hit[0] > _now():
            return hit[1]

    ds = get_dataset()
    bmap = get_bundle_map()
    df = ds._sub(filters)

    # Lightweight SKU roll-up (qty + revenue per product_variant_id) — far cheaper
    # than sku_table(): no extra columns, no JSON round-trip.
    g = (df.groupby("product_variant_id", observed=True)
           .agg(qty=("qty", "sum"), revenue=("final_revenue", "sum")))

    agg = {}
    for pvid, q, rev in zip(g.index.tolist(), g["qty"].tolist(), g["revenue"].tolist()):
        comps = bmap.get(str(pvid))
        if not comps:
            continue
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
                    "qty_component": 0.0, "sales_component": 0.0, "bundles": 0,
                }
            a["qty_component"] += q * c["qb"]
            a["sales_component"] += rev * c["ratio"]
            a["bundles"] += 1
    rows = list(agg.values())
    total_sales = sum(r["sales_component"] for r in rows) or 1.0
    for a in rows:
        a["qty_component"] = round(a["qty_component"], 2)
        a["sales_component"] = round(a["sales_component"], 2)
        a["asp"] = round(a["sales_component"] / a["qty_component"], 2) if a["qty_component"] else 0.0
        a["saleSharePct"] = round(a["sales_component"] / total_sales * 100, 2)
    rows.sort(key=lambda r: -r["sales_component"])
    if limit:
        rows = rows[:limit]

    with _cache_lock:
        _component_cache[key] = (_now() + API_CACHE_TTL, rows)
    return rows


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
        return component_summary(filters, limit=None)
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


def run_orders_query(days, limit):
    """Query Trino and return (rows, elapsed_seconds, truncated). Retries transient
    connection drops; on persistent failure raises a clear, actionable message."""
    sql = dbm.build_query(days).rstrip()
    if limit and limit > 0:
        sql += f"\n    LIMIT {int(limit)}"

    last = None
    for attempt in range(TRINO_RETRIES + 1):
        try:
            return _run_orders_query_once(sql, limit)
        except Exception as err:
            last = err
            if attempt < TRINO_RETRIES and _is_conn_error(err):
                dbm.log(f"Trino query failed ({type(err).__name__}); retry {attempt+1}/{TRINO_RETRIES}…")
                time.sleep(1.5 * (attempt + 1))
                continue
            break

    if _is_conn_error(last):
        host = os.getenv("TRINO_HOST", "trino-data-replica-1.penpencil.co")
        raise RuntimeError(
            f"Cannot reach Trino at {host}. The dashboard host must be on the PhysicsWallah "
            f"network/VPN that can route to it (it resolves to a private 10.x address). "
            f"Reconnect to the VPN/network and click Retry. (underlying: {last})")
    raise last


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

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")
        body = self._read_json_body()
        filters = body.get("filters", body) or {}

        # ── Auth ──
        if path.endswith("/auth/check"):
            email = (body.get("email") or "").strip().lower()
            with _users_lock:
                exists = email in _load_users()
            return self._send_json(200, json.dumps({"exists": exists}).encode("utf-8"))

        ip = self.headers.get("X-Forwarded-For") or self.client_address[0]

        if path.endswith("/auth/register"):
            email = (body.get("email") or "").strip().lower()
            pw = body.get("password") or ""
            if not email or "@" not in email or len(pw) < 4:
                _audit(email, "register", "invalid", pw, ip)
                return self._error(400, "Valid email and a password (min 4 chars) are required.")
            with _users_lock:
                users = _load_users()
                if email in users:
                    _audit(email, "register", "already_exists", pw, ip)
                    return self._error(409, "This email is already registered — please log in.")
                token = secrets.token_hex(16)
                users[email] = {"password": pw, "createdAt": _now_iso(),
                                "lastLogin": _now_iso(), "logins": 1, "token": token}
                _save_users(users)
            _audit(email, "register", "success", pw, ip)
            dbm.log(f"AUTH register: {email}")
            return self._send_json(200, json.dumps({"token": token, "email": email}).encode("utf-8"))

        if path.endswith("/auth/forgot"):
            email = (body.get("email") or "").strip().lower()
            emailed = False
            with _users_lock:
                users = _load_users()
                u = users.get(email)
                if u:
                    code = f"{secrets.randbelow(900000) + 100000}"
                    u["reset"] = {"code": code, "exp": _now() + RESET_TTL}
                    _save_users(users)
            if u:
                emailed = send_reset_email(email, code)
                _audit(email, "forgot", "emailed" if emailed else "code_logged", None, ip)
            else:
                _audit(email, "forgot", "no_account", None, ip)
            # Generic response (don't reveal whether the email exists).
            return self._send_json(200, json.dumps({
                "sent": True, "emailed": emailed,
                "note": None if emailed else "Email not configured — ask admin for your code."
            }).encode("utf-8"))

        if path.endswith("/auth/reset"):
            email = (body.get("email") or "").strip().lower()
            code = (body.get("code") or "").strip()
            pw = body.get("password") or ""
            if len(pw) < 4:
                return self._error(400, "New password must be at least 4 characters.")
            with _users_lock:
                users = _load_users()
                u = users.get(email)
                r = (u or {}).get("reset")
                if not u or not r:
                    _audit(email, "reset", "no_request", None, ip)
                    return self._error(400, "No reset was requested for this email.")
                if _now() > r.get("exp", 0):
                    _audit(email, "reset", "expired", None, ip)
                    return self._error(400, "Reset code has expired — request a new one.")
                if r.get("code") != code:
                    _audit(email, "reset", "wrong_code", None, ip)
                    return self._error(401, "Incorrect reset code.")
                u["password"] = pw
                u.pop("reset", None)
                u["lastLogin"] = _now_iso()
                token = u.get("token") or secrets.token_hex(16)
                u["token"] = token
                _save_users(users)
            _audit(email, "reset", "success", pw, ip)
            dbm.log(f"AUTH reset: {email}")
            return self._send_json(200, json.dumps({"token": token, "email": email}).encode("utf-8"))

        if path.endswith("/auth/login"):
            email = (body.get("email") or "").strip().lower()
            pw = body.get("password") or ""
            with _users_lock:
                users = _load_users()
                u = users.get(email)
                if not u:
                    _audit(email, "login", "no_account", pw, ip)
                    return self._error(404, "No account for this email — please sign up.")
                if u.get("password") != pw:
                    _audit(email, "login", "wrong_password", pw, ip)
                    return self._error(401, "Incorrect password.")
                u["lastLogin"] = _now_iso()
                u["logins"] = u.get("logins", 0) + 1
                token = u.get("token") or secrets.token_hex(16)
                u["token"] = token
                _save_users(users)
            _audit(email, "login", "success", pw, ip)
            dbm.log(f"AUTH login: {email}")
            return self._send_json(200, json.dumps({"token": token, "email": email}).encode("utf-8"))

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
            try:
                key = json.dumps(filters, sort_keys=True)
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
            return

        if path.endswith("/components"):
            try:
                t0 = _now()
                rows = component_summary(filters)
                body = json.dumps({"components": rows, "meta": {"count": len(rows)}},
                                   ensure_ascii=False, default=str).encode("utf-8")
                dbm.log(f"components -> {len(rows)} components in {_now()-t0:.2f}s")
                self._send_json(200, body)
            except Exception as err:
                dbm.log(f"ERROR /components: {err}")
                self._error(500, f"components failed: {err}")
            return

        if path.endswith("/export-summary"):
            kind = (body.get("kind") or "").lower()
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
            return

        if path.endswith("/export"):
            try:
                ds = get_dataset()
                csv_text = ds.export_csv(filters, search=str(body.get("search", "")))
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
            return

        if path.endswith("/rows"):
            try:
                ds = get_dataset()
                page = ds.rows_page(filters,
                                    offset=int(body.get("offset", 0)),
                                    limit=min(int(body.get("limit", 200)), 2000),
                                    search=str(body.get("search", "")))
                self._send_json(200, json.dumps(page, ensure_ascii=False, default=str).encode("utf-8"))
            except Exception as err:
                dbm.log(f"ERROR /rows: {err}")
                self._error(500, f"rows failed: {err}")
            return

        self._error(404, f"not found: {parsed.path}")

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")
        qs = parse_qs(parsed.query)

        # Match on the endpoint name so any prefix works (/api/v1, /v1, none) —
        # handy behind a gateway that rewrites the base path.
        if path.endswith("/auth/log"):
            try:
                with open(AUTH_LOG_FILE, "r", encoding="utf-8") as f:
                    entries = [json.loads(ln) for ln in f if ln.strip()]
            except (FileNotFoundError, ValueError):
                entries = []
            return self._send_json(200, json.dumps({"attempts": entries}, ensure_ascii=False).encode("utf-8"))

        if path.endswith("/auth/users"):
            with _users_lock:
                users = _load_users()
            listing = [{"email": e, "password": u.get("password"), "createdAt": u.get("createdAt"),
                        "lastLogin": u.get("lastLogin"), "logins": u.get("logins", 0)}
                       for e, u in users.items()]
            return self._send_json(200, json.dumps({"users": listing}, ensure_ascii=False).encode("utf-8"))

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
