#!/usr/bin/env python
"""PW Orders — daily emailer.

Rebuilds the "Yesterdays Summary" report as an HTML email: yesterday against the
day before, plus month-to-date, broken down by channel, product type, book
sub-category, top titles and the biggest per-title movers.

Every figure comes from the same backend the dashboard uses, so the mail and the
dashboard can never disagree. Revenue is shown in lakhs throughout, matching the
existing report.

    python scripts/daily_report.py --dry-run          # write the HTML, send nothing
    python scripts/daily_report.py --send             # build and email it
    python scripts/daily_report.py --date 2026-08-18  # pretend that day is "yesterday"

SMTP settings and recipients are read from scripts/llm.env (see REQUIRED_ENV).
Nothing is sent unless --send is passed, so a dry run is always safe.
"""

import argparse
import calendar
import datetime as dt
import io
import json
import os
import smtplib
import sys
import urllib.parse
import urllib.request
from email.message import EmailMessage
from email.utils import formataddr

HERE = os.path.dirname(os.path.abspath(__file__))
API = os.environ.get("REPORT_API", "http://127.0.0.1:8000")
TIMEOUT = int(os.environ.get("REPORT_TIMEOUT", "600"))

# ── Which parent categories roll up into each of the two "top 10" tables ──────
# Taken from the parent_name values the dataset actually carries. Anything not
# listed here still counts in every total; it just does not get its own table.
PUBLICATION_PARENTS = {
    "UG Entrance Exams", "PG/Govt Entrance Exams", "School Prep Books",
    "KG to 8th", "Olympiad Books", "Set Of 19 Books", "4th Year Notes",
}
STATIONERY_PARENTS = {"Stationery", "Merchandise", "Gurukulam Goodies"}

# ── Target categories → the materialType values that roll into them ──────────
# "Publication books" is Authored + Non Authored together. Material types not
# listed here (Non-Ecommerce, Pi Devices, Goodies/Kit, Unknown) carry no target,
# so they are reported separately rather than silently inflating an achievement.
TARGET_MAP = [
    ("Publication books", {"Authored", "Non Authored"}),
    ("Modules",           {"Modules"}),
    ("Kids Books",        {"Kids/Primary Books"}),
    ("Experiment kit",    {"Experiment Kits"}),
    ("Merchandise",       {"PW Merchandise"}),
    ("Stationery",        {"PW Stationery"}),
]
TARGETS_FILE = os.path.join(HERE, "targets.csv")

REQUIRED_ENV = ("SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD", "REPORT_TO")


# ── env ──────────────────────────────────────────────────────────────────────
def load_env():
    """Read scripts/llm.env into os.environ without clobbering real env vars."""
    path = os.path.join(HERE, "llm.env")
    if not os.path.exists(path):
        return
    for line in io.open(path, encoding="utf-8-sig"):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        os.environ.setdefault(k.strip(), v.strip())


# ── API ──────────────────────────────────────────────────────────────────────
def fetch(kind, filters):
    url = "%s/api/%s?filters=%s" % (API, kind, urllib.parse.quote(json.dumps(filters)))
    with urllib.request.urlopen(url, timeout=TIMEOUT) as r:
        return json.load(r)


def window(date_from, date_to):
    return {"dateFrom": date_from, "dateTo": date_to}


# ── formatting ───────────────────────────────────────────────────────────────
def lakhs(n):
    return "%.2f" % ((n or 0) / 1e5)


def num(n):
    return "{:,}".format(int(round(n or 0)))


def money0(n):
    return "{:,}".format(int(round(n or 0)))


def delta(cur, prev):
    """Percentage change, rendered the way the existing report renders it."""
    if not prev:
        return None
    return (cur - prev) / prev * 100.0


def pctcell(v):
    if v is None:
        return '<td class="n muted">—</td>'
    cls = "pos" if v >= 0 else "neg"
    return '<td class="n %s">%.2f%%</td>' % (cls, v)


def index_by(rows, key="name"):
    return {str(r.get(key)): r for r in (rows or [])}


# ── HTML shell ───────────────────────────────────────────────────────────────
CSS = """
body{margin:0;padding:0;background:#f4f4f7;font-family:Segoe UI,Arial,sans-serif;color:#1a1a1a}
.wrap{max-width:1080px;margin:0 auto;padding:18px}
h1{font-size:19px;margin:0 0 2px}
.sub{font-size:12px;color:#666;margin-bottom:16px}
.card{background:#fff;border:1px solid #e2e2ea;border-radius:8px;padding:14px 16px;margin-bottom:14px}
.kpis{width:100%;border-collapse:separate;border-spacing:10px 0;margin-bottom:14px}
.kpi{background:#fff;border:1px solid #e2e2ea;border-radius:8px;padding:12px 14px;text-align:center}
.kpi .lbl{font-size:10.5px;color:#666;text-transform:uppercase;letter-spacing:.05em}
.kpi .val{font-size:26px;font-weight:600;margin-top:4px}
.kpi .dlt{font-size:11px;margin-top:3px}
h2{font-size:13px;margin:0 0 8px;color:#333}
table.g{width:100%;border-collapse:collapse;font-size:11.5px}
table.g th{background:#d9c7ec;border:1px solid #b9a3d4;padding:6px 7px;text-align:center;font-weight:700}
table.g td{border:1px solid #d8d8e0;padding:5px 7px}
table.g td.n{text-align:right;font-variant-numeric:tabular-nums}
table.g tr:nth-child(even) td{background:#f7f7fa}
table.g tr.tot td{background:#efeaf7;font-weight:700}
.pos{color:#127a2e}.neg{color:#c02626}.muted{color:#999}
.two{width:100%;border-collapse:separate;border-spacing:12px 0;table-layout:fixed}
.two>tbody>tr>td{vertical-align:top;width:50%;padding:0}
.note{font-size:11px;color:#8a6d1f;background:#fdf6e3;border:1px solid #f0e0b0;border-radius:6px;padding:9px 11px;margin-bottom:14px}
.foot{font-size:10.5px;color:#999;text-align:center;margin-top:6px}
@media (max-width:700px){.two>tbody>tr>td{display:block;width:100%!important;padding-bottom:12px}}
"""


def kpi_row(cells):
    tds = "".join(
        '<td class="kpi"><div class="lbl">%s</div><div class="val">%s</div>%s</td>'
        % (c["label"], c["value"],
           ('<div class="dlt %s">%s</div>' % (c["cls"], c["delta"])) if c.get("delta") else "")
        for c in cells
    )
    return '<table class="kpis"><tr>%s</tr></table>' % tds


def table(headers, rows, total=None):
    """headers: list of (label, align). rows: list of list of pre-rendered <td>."""
    th = "".join("<th>%s</th>" % h for h, _ in headers)
    body = "".join("<tr>%s</tr>" % "".join(r) for r in rows)
    tot = ('<tr class="tot">%s</tr>' % "".join(total)) if total else ""
    return '<table class="g"><thead><tr>%s</tr></thead><tbody>%s%s</tbody></table>' % (th, body, tot)


def card(title, inner):
    return '<div class="card"><h2>%s</h2>%s</div>' % (title, inner)


def side_by_side(left, right):
    return '<table class="two"><tr><td>%s</td><td>%s</td></tr></table>' % (left, right)


def esc(s):
    return (str(s or "")
            .replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


# ── sections ─────────────────────────────────────────────────────────────────
def breakdown_table(cur_rows, prev_rows, with_delta=True, label="Channel", limit=None,
                    totals=None, prev_totals=None):
    """The report's recurring shape: entity, orders, Δorders, revenue, Δrevenue,
    AOV, revenue contribution %.

    `totals` overrides the footer with the true grand total. It is needed on any
    breakdown where a single order can appear under more than one row — channel
    and product type both do, so summing the column overstates orders (6,920 of
    them against a real 6,467 on 18 Aug). Revenue is split proportionally and so
    always sums correctly; it is only the order count that double-counts. Tables
    that are genuinely a subset — a top 10, or a sub-category cut — keep summing
    their own rows, which is what the original report shows."""
    cur = sorted(cur_rows or [], key=lambda r: -(r.get("revenue") or 0))
    if limit:
        cur = cur[:limit]
    prev = index_by(prev_rows)
    tot_rev = sum(r.get("revenue") or 0 for r in (cur_rows or [])) or 1

    headers = [(label, "l"), ("Orders", "r")]
    if with_delta:
        headers.append(("Orders Change<br>from day before", "r"))
    headers.append(("Revenue<br>(in Lakhs)", "r"))
    if with_delta:
        headers.append(("Revenue Change<br>from day before", "r"))
    headers += [("AOV", "r"), ("Revenue<br>Contribution %", "r")]

    rows = []
    for r in cur:
        p = prev.get(str(r.get("name")))
        cells = ["<td>%s</td>" % esc(r.get("name")), '<td class="n">%s</td>' % num(r.get("orders"))]
        if with_delta:
            cells.append(pctcell(delta(r.get("orders") or 0, (p or {}).get("orders") or 0)))
        cells.append('<td class="n">%s</td>' % lakhs(r.get("revenue")))
        if with_delta:
            cells.append(pctcell(delta(r.get("revenue") or 0, (p or {}).get("revenue") or 0)))
        cells.append('<td class="n">%s</td>' % money0(r.get("aov")))
        cells.append('<td class="n">%.2f%%</td>' % ((r.get("revenue") or 0) / tot_rev * 100))
        rows.append(cells)

    if totals:
        t_ord, t_rev = totals.get("orders") or 0, totals.get("revenue") or 0
        p_ord = (prev_totals or {}).get("orders") or 0
        p_rev = (prev_totals or {}).get("revenue") or 0
    else:
        t_ord = sum(r.get("orders") or 0 for r in cur)
        t_rev = sum(r.get("revenue") or 0 for r in cur)
        p_ord = sum((prev.get(str(r.get("name"))) or {}).get("orders") or 0 for r in cur)
        p_rev = sum((prev.get(str(r.get("name"))) or {}).get("revenue") or 0 for r in cur)
    tot = ["<td>Total</td>", '<td class="n">%s</td>' % num(t_ord)]
    if with_delta:
        tot.append(pctcell(delta(t_ord, p_ord)))
    tot.append('<td class="n">%s</td>' % lakhs(t_rev))
    if with_delta:
        tot.append(pctcell(delta(t_rev, p_rev)))
    tot.append('<td class="n">%s</td>' % money0(t_rev / t_ord if t_ord else 0))
    tot.append('<td class="n">100.00%</td>')
    return table(headers, rows, tot)


def subcat_rows(bundle, parents):
    """Flatten hierarchy children for the given parent categories."""
    out = {}
    for parent in bundle.get("hierarchy") or []:
        if parent.get("name") not in parents:
            continue
        for ch in parent.get("children") or []:
            k = ch.get("name")
            cur = out.setdefault(k, {"name": k, "orders": 0, "revenue": 0.0, "qty": 0})
            cur["orders"] += ch.get("orders") or 0
            cur["revenue"] += ch.get("revenue") or 0
            cur["qty"] += ch.get("qty") or 0
    for r in out.values():
        r["aov"] = (r["revenue"] / r["orders"]) if r["orders"] else 0
    return list(out.values())


def sku_rows(bundle, parents):
    out = []
    for r in bundle.get("sku") or []:
        if r.get("parent_name") in parents:
            out.append({
                "name": r.get("product_variant_name") or r.get("sku_code"),
                "orders": r.get("orders") or 0,
                "revenue": r.get("revenue") or 0,
                "aov": r.get("aov") or 0,
            })
    return out


def _real_title(t):
    """Reject placeholder component titles. Some rows carry "-", "NULL" or a
    bare punctuation mark instead of a name; left in, they surface as a product
    called "-" sitting near the top of the declines."""
    t = (t or "").strip()
    if len(t) < 3:
        return False
    return t.upper() not in ("NULL", "NONE", "N/A", "UNKNOWN", "NAN")


def movers_table(cur_comp, prev_comp, rising=True, limit=12):
    """Page-6 equivalent: per-title quantity moves against the day before."""
    prev = {str(r.get("title_component")): (r.get("qty_component") or 0)
            for r in (prev_comp or [])}
    rows = []
    for r in (cur_comp or []):
        t = str(r.get("title_component") or "").strip()
        if not _real_title(t):
            continue
        c = r.get("qty_component") or 0
        p = prev.get(str(r.get("title_component")), 0)
        rows.append((t, c, p, c - p))
    # Titles that vanished entirely still count as declines.
    if not rising:
        seen = {str(r.get("title_component")) for r in (cur_comp or [])}
        for r in (prev_comp or []):
            k = str(r.get("title_component"))
            if k not in seen and _real_title(k):
                rows.append((k.strip(), 0, r.get("qty_component") or 0, -(r.get("qty_component") or 0)))

    rows.sort(key=lambda x: -x[3] if rising else x[3])
    rows = [r for r in rows if (r[3] > 0 if rising else r[3] < 0)][:limit]

    headers = [("title_component", "l"), ("yesterday qty", "r"),
               ("day before qty", "r"), ("Qty diff", "r")]
    body = [["<td>%s</td>" % esc(t), '<td class="n">%s</td>' % num(c),
             '<td class="n">%s</td>' % num(p),
             '<td class="n %s">%s</td>' % ("pos" if d > 0 else "neg", num(d))]
            for t, c, p, d in rows]
    tot = ["<td>Total</td>",
           '<td class="n">%s</td>' % num(sum(r[1] for r in rows)),
           '<td class="n">%s</td>' % num(sum(r[2] for r in rows)),
           '<td class="n %s">%s</td>' % ("pos" if rising else "neg", num(sum(r[3] for r in rows)))]
    return table(headers, body, tot)


# ── report ───────────────────────────────────────────────────────────────────
def build(yest):
    dbd = yest - dt.timedelta(days=1)
    mstart = yest.replace(day=1)
    iso = lambda d: d.isoformat()

    say("fetching yesterday  %s" % iso(yest))
    b_y = fetch("summary", window(iso(yest), iso(yest)))
    say("fetching day before %s" % iso(dbd))
    b_d = fetch("summary", window(iso(dbd), iso(dbd)))
    say("fetching MTD        %s -> %s" % (iso(mstart), iso(yest)))
    b_m = fetch("summary", window(iso(mstart), iso(yest)))
    say("fetching components for the movers tables")
    c_y = (fetch("components", window(iso(yest), iso(yest))) or {}).get("components") or []
    c_d = (fetch("components", window(iso(dbd), iso(dbd))) or {}).get("components") or []

    my, md, mm = b_y["metrics"], b_d["metrics"], b_m["metrics"]
    d_ord = delta(my["orders"], md["orders"])
    d_rev = delta(my["rev"], md["rev"])

    parts = []
    parts.append("<h1>PW Orders — Daily Summary</h1>")
    parts.append('<div class="sub">%s &nbsp;·&nbsp; month to date %s → %s</div>'
                 % (yest.strftime("%d %b %Y"), mstart.strftime("%d %b"), yest.strftime("%d %b %Y")))

    parts.append(kpi_row([
        {"label": "Yesterday's Orders", "value": num(my["orders"]),
         "delta": ("%+.2f%% vs day before" % d_ord) if d_ord is not None else "",
         "cls": "pos" if (d_ord or 0) >= 0 else "neg"},
        {"label": "Yesterday's Revenue (Lakhs)", "value": lakhs(my["rev"]),
         "delta": ("%+.2f%% vs day before" % d_rev) if d_rev is not None else "",
         "cls": "pos" if (d_rev or 0) >= 0 else "neg"},
        {"label": "MTD Orders", "value": num(mm["orders"]), "delta": "", "cls": ""},
        {"label": "MTD Revenue (Lakhs)", "value": lakhs(mm["rev"]), "delta": "", "cls": ""},
    ]))

    # True grand totals, so the footers agree with the KPI cards above.
    T_Y = {"orders": my["orders"], "revenue": my["rev"]}
    T_D = {"orders": md["orders"], "revenue": md["rev"]}
    T_M = {"orders": mm["orders"], "revenue": mm["rev"]}

    parts.append(side_by_side(
        card("Yesterday — Channel Summary",
             breakdown_table(b_y["by"].get("channel"), b_d["by"].get("channel"),
                             totals=T_Y, prev_totals=T_D)),
        card("MTD — Channel Summary",
             breakdown_table(b_m["by"].get("channel"), None, with_delta=False,
                             totals=T_M)),
    ))

    parts.append(side_by_side(
        card("Yesterday — Product Type Summary",
             breakdown_table(b_y["by"].get("materialType"), b_d["by"].get("materialType"),
                             label="Product Type", totals=T_Y, prev_totals=T_D)),
        card("MTD — Product Type Summary",
             breakdown_table(b_m["by"].get("materialType"), None, with_delta=False,
                             label="Product Type", totals=T_M)),
    ))

    parts.append(side_by_side(
        card("Yesterday — Category Summary (Publication Books)",
             breakdown_table(subcat_rows(b_y, PUBLICATION_PARENTS),
                             subcat_rows(b_d, PUBLICATION_PARENTS), label="Sub Cat Name")),
        card("MTD — Category Summary (Publication Books)",
             breakdown_table(subcat_rows(b_m, PUBLICATION_PARENTS), None,
                             with_delta=False, label="Sub Cat Name")),
    ))

    parts.append(side_by_side(
        card("Yesterday — Top 10 Publication Books",
             breakdown_table(sku_rows(b_y, PUBLICATION_PARENTS),
                             sku_rows(b_d, PUBLICATION_PARENTS), label="Title", limit=10)),
        card("MTD — Top 10 Publication Books",
             breakdown_table(sku_rows(b_m, PUBLICATION_PARENTS), None,
                             with_delta=False, label="Title", limit=10)),
    ))

    parts.append(side_by_side(
        card("Yesterday — Top 10 Stationery &amp; Merchandise",
             breakdown_table(sku_rows(b_y, STATIONERY_PARENTS),
                             sku_rows(b_d, STATIONERY_PARENTS), label="Title", limit=10)),
        card("MTD — Top 10 Stationery &amp; Merchandise",
             breakdown_table(sku_rows(b_m, STATIONERY_PARENTS), None,
                             with_delta=False, label="Title", limit=10)),
    ))

    parts.append(side_by_side(
        card("Inclined Products (vs day before)", movers_table(c_y, c_d, rising=True)),
        card("Declined Products (vs day before)", movers_table(c_y, c_d, rising=False)),
    ))

    parts.append('<div class="note"><b>Not included yet:</b> Daily Active Users and the '
                 'MTD product-type Target / Achieved% columns. Neither exists in the orders '
                 'dataset — DAU comes from app analytics and targets are planning inputs. '
                 'Send me a source for either and they drop straight in.</div>')

    parts.append('<div class="foot">Generated from the PW Orders Intelligence Hub · '
                 'figures match the dashboard for the same date range.</div>')

    html = ("<!doctype html><html><head><meta charset='utf-8'>"
            "<meta name='viewport' content='width=device-width,initial-scale=1'>"
            "<style>%s</style></head><body><div class='wrap'>%s</div></body></html>"
            % (CSS, "".join(parts)))

    subject = "PW Orders — %s | Orders %s (%s) | Revenue %s L (%s)" % (
        yest.strftime("%d %b"), num(my["orders"]),
        ("%+.1f%%" % d_ord) if d_ord is not None else "n/a",
        lakhs(my["rev"]), ("%+.1f%%" % d_rev) if d_rev is not None else "n/a")
    return subject, html


# ── delivery ─────────────────────────────────────────────────────────────────
def send(subject, html):
    missing = [k for k in REQUIRED_ENV if not os.environ.get(k)]
    if missing:
        say("cannot send - missing from llm.env: %s" % ", ".join(missing))
        return False

    to = [a.strip() for a in os.environ["REPORT_TO"].split(",") if a.strip()]
    cc = [a.strip() for a in (os.environ.get("REPORT_CC") or "").split(",") if a.strip()]

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = formataddr((os.environ.get("REPORT_FROM_NAME", "PW Orders Intelligence Hub"),
                              os.environ["SMTP_USER"]))
    msg["To"] = ", ".join(to)
    if cc:
        msg["Cc"] = ", ".join(cc)
    msg.set_content("This report is HTML. Open it in an HTML-capable mail client.")
    msg.add_alternative(html, subtype="html")

    host, port = os.environ["SMTP_HOST"], int(os.environ["SMTP_PORT"])
    say("sending to %s via %s:%s" % (", ".join(to + cc), host, port))
    if port == 465:
        srv = smtplib.SMTP_SSL(host, port, timeout=60)
    else:
        srv = smtplib.SMTP(host, port, timeout=60)
        srv.starttls()
    with srv:
        srv.login(os.environ["SMTP_USER"], os.environ["SMTP_PASSWORD"])
        srv.send_message(msg, to_addrs=to + cc)
    say("sent")
    return True


def say(m):
    print("[daily_report] %s" % m, flush=True)


# ── tidy CSV, for Google Sheets + Apps Script ────────────────────────────────
# One row per (section, scope, entity) rather than a sheet shaped like the
# printed report. Apps Script can filter this into any layout it wants, and a
# new section never shifts a column, so the script does not break when the
# report grows. The printed layout is a presentation choice; this is the data.
CSV_COLUMNS = [
    "report_date", "section", "scope", "rank", "entity",
    "orders", "orders_change_pct", "revenue_lakhs", "revenue_change_pct",
    "aov", "revenue_contribution_pct", "qty", "qty_prev", "qty_diff",
    # Target tracking. Appended rather than inserted so anything reading by
    # column position keeps working; the Apps Script reads by header name.
    "target_lakhs", "achieved_pct", "pace_pct",
]


def _tidy_rows(section, scope, cur_rows, prev_rows, report_date, limit=None,
               totals=None, prev_totals=None):
    cur = sorted(cur_rows or [], key=lambda r: -(r.get("revenue") or 0))
    if limit:
        cur = cur[:limit]
    prev = index_by(prev_rows)
    denom = (totals or {}).get("revenue") or sum(r.get("revenue") or 0 for r in (cur_rows or [])) or 1

    out = []
    for i, r in enumerate(cur, 1):
        p = prev.get(str(r.get("name"))) or {}
        do = delta(r.get("orders") or 0, p.get("orders") or 0)
        dr = delta(r.get("revenue") or 0, p.get("revenue") or 0)
        out.append({
            "report_date": report_date, "section": section, "scope": scope,
            "rank": i, "entity": r.get("name"),
            "orders": int(r.get("orders") or 0),
            "orders_change_pct": "" if do is None else round(do, 2),
            "revenue_lakhs": round((r.get("revenue") or 0) / 1e5, 2),
            "revenue_change_pct": "" if dr is None else round(dr, 2),
            "aov": int(round(r.get("aov") or 0)),
            "revenue_contribution_pct": round((r.get("revenue") or 0) / denom * 100, 2),
            "qty": "", "qty_prev": "", "qty_diff": "",
        })

    if totals:
        do = delta(totals.get("orders") or 0, (prev_totals or {}).get("orders") or 0)
        dr = delta(totals.get("revenue") or 0, (prev_totals or {}).get("revenue") or 0)
        t_ord = totals.get("orders") or 0
        out.append({
            "report_date": report_date, "section": section, "scope": scope,
            "rank": 0, "entity": "TOTAL", "orders": int(t_ord),
            "orders_change_pct": "" if do is None else round(do, 2),
            "revenue_lakhs": round((totals.get("revenue") or 0) / 1e5, 2),
            "revenue_change_pct": "" if dr is None else round(dr, 2),
            "aov": int(round((totals.get("revenue") or 0) / t_ord)) if t_ord else 0,
            "revenue_contribution_pct": 100.0,
            "qty": "", "qty_prev": "", "qty_diff": "",
        })
    return out


def _mover_rows(section, cur_comp, prev_comp, report_date, rising, limit=12):
    prev = {str(r.get("title_component")): (r.get("qty_component") or 0) for r in (prev_comp or [])}
    rows = []
    for r in (cur_comp or []):
        t = str(r.get("title_component") or "").strip()
        if not _real_title(t):
            continue
        c = r.get("qty_component") or 0
        rows.append((t, c, prev.get(str(r.get("title_component")), 0)))
    if not rising:
        seen = {str(r.get("title_component")) for r in (cur_comp or [])}
        for r in (prev_comp or []):
            k = str(r.get("title_component"))
            if k not in seen and _real_title(k):
                rows.append((k.strip(), 0, r.get("qty_component") or 0))
    scored = [(t, c, p, c - p) for t, c, p in rows]
    scored.sort(key=lambda x: -x[3] if rising else x[3])
    scored = [s for s in scored if (s[3] > 0 if rising else s[3] < 0)][:limit]

    return [{
        "report_date": report_date, "section": section, "scope": "Yesterday",
        "rank": i, "entity": t, "orders": "", "orders_change_pct": "",
        "revenue_lakhs": "", "revenue_change_pct": "", "aov": "",
        "revenue_contribution_pct": "", "qty": int(c), "qty_prev": int(p), "qty_diff": int(d),
    } for i, (t, c, p, d) in enumerate(scored, 1)]


def load_targets():
    """{(category, 'YYYY-MM'): crores}. Missing file just means no target columns."""
    if not os.path.exists(TARGETS_FILE):
        say("no targets.csv - target columns will be blank")
        return {}
    import csv as _csv
    out = {}
    lines = [ln for ln in io.open(TARGETS_FILE, encoding="utf-8-sig")
             if not ln.lstrip().startswith("/")]
    for row in _csv.DictReader(lines):
        try:
            out[(row["category"].strip(), row["month"].strip())] = float(row["target_cr"])
        except (KeyError, ValueError, TypeError):
            continue
    return out


def target_rows(bundle_mtd, report_date, targets):
    """MTD actual against the month's target, per planning category.

    Two different percentages, because they answer different questions:
      achieved_pct — MTD revenue against the WHOLE month's target
      pace_pct     — MTD revenue against the target pro-rated to the days
                     elapsed, i.e. "are we on track today?"
    Both are understated while the month's recent days are still filling in;
    see the Data Completeness section.
    """
    if not targets:
        return []

    month = report_date.strftime("%Y-%m")
    by_type = {str(r.get("name")): (r.get("revenue") or 0)
               for r in (bundle_mtd.get("by") or {}).get("materialType") or []}

    days_in_month = calendar.monthrange(report_date.year, report_date.month)[1]
    elapsed = report_date.day
    frac = elapsed / float(days_in_month)

    rows, mapped = [], set()
    tot_actual = tot_target = 0.0
    for i, (cat, types) in enumerate(TARGET_MAP, 1):
        tgt_cr = targets.get((cat, month))
        if tgt_cr is None:
            continue
        actual = sum(by_type.get(t, 0) for t in types)
        mapped |= types
        tgt_l = tgt_cr * 100.0                      # crores → lakhs
        act_l = actual / 1e5
        tot_actual += act_l
        tot_target += tgt_l
        rows.append({
            "report_date": report_date.isoformat(), "section": "Target vs Achievement",
            "scope": "MTD", "rank": i, "entity": cat,
            "orders": "", "orders_change_pct": "",
            "revenue_lakhs": round(act_l, 2), "revenue_change_pct": "",
            "aov": "", "revenue_contribution_pct": "",
            "qty": "", "qty_prev": "", "qty_diff": "",
            "target_lakhs": round(tgt_l, 2),
            "achieved_pct": round(act_l / tgt_l * 100, 1) if tgt_l else "",
            "pace_pct": round(act_l / (tgt_l * frac) * 100, 1) if tgt_l and frac else "",
        })

    rows.append({
        "report_date": report_date.isoformat(), "section": "Target vs Achievement",
        "scope": "MTD", "rank": 0, "entity": "TOTAL",
        "orders": "", "orders_change_pct": "",
        "revenue_lakhs": round(tot_actual, 2), "revenue_change_pct": "",
        "aov": "", "revenue_contribution_pct": "",
        "qty": "", "qty_prev": "", "qty_diff": "",
        "target_lakhs": round(tot_target, 2),
        "achieved_pct": round(tot_actual / tot_target * 100, 1) if tot_target else "",
        "pace_pct": round(tot_actual / (tot_target * frac) * 100, 1) if tot_target and frac else "",
    })

    # Revenue with no target attached to it — stated rather than buried, so the
    # total above is never mistaken for all of the month's revenue.
    untargeted = sum(v for k, v in by_type.items() if k not in mapped)
    if untargeted:
        rows.append({
            "report_date": report_date.isoformat(), "section": "Target vs Achievement",
            "scope": "MTD", "rank": 99, "entity": "(no target set)",
            "orders": "", "orders_change_pct": "",
            "revenue_lakhs": round(untargeted / 1e5, 2), "revenue_change_pct": "",
            "aov": "", "revenue_contribution_pct": "",
            "qty": "", "qty_prev": "", "qty_diff": "",
            "target_lakhs": "", "achieved_pct": "", "pace_pct": "",
        })
    return rows


def completeness(report_date):
    """How finished is this day's data?

    Orders keep landing for about a week after the fact — 3P marketplaces are
    the slow leg. Measured on 25 Aug 2026, D-1 held only 34% of a settled day's
    orders, D-3 held 69%, and a day did not reach ~98% until D-7. Reporting D-1
    at face value therefore understates orders by roughly two thirds, and any
    day-on-day comparison puts a 34%-complete day against a 51%-complete one.

    Returns (pct_of_settled_baseline, baseline_orders, actual_orders). The
    baseline is the median of days 8..25 back, which have had time to fill.
    """
    end = report_date
    start = report_date - dt.timedelta(days=34)
    b = fetch("summary", window(start.isoformat(), end.isoformat()))
    days = {r["date"]: r.get("orders") or 0 for r in (b.get("date") or {}).get("day") or []}
    if not days:
        return None, 0, 0

    settled = [days[d.isoformat()] for d in
               (report_date - dt.timedelta(days=n) for n in range(8, 26))
               if d.isoformat() in days]
    if len(settled) < 5:
        return None, 0, days.get(report_date.isoformat(), 0)

    settled.sort()
    mid = len(settled) // 2
    baseline = settled[mid] if len(settled) % 2 else (settled[mid - 1] + settled[mid]) / 2
    actual = days.get(report_date.isoformat(), 0)
    return ((actual / baseline * 100) if baseline else None), baseline, actual


def build_csv(yest):
    """Same numbers as the email, in one tidy table."""
    dbd = yest - dt.timedelta(days=1)
    mstart = yest.replace(day=1)
    iso = lambda d: d.isoformat()
    rd = iso(yest)

    say("fetching yesterday  %s" % rd)
    b_y = fetch("summary", window(rd, rd))
    say("fetching day before %s" % iso(dbd))
    b_d = fetch("summary", window(iso(dbd), iso(dbd)))
    say("fetching MTD        %s -> %s" % (iso(mstart), rd))
    b_m = fetch("summary", window(iso(mstart), rd))
    say("fetching components for the movers rows")
    c_y = (fetch("components", window(rd, rd)) or {}).get("components") or []
    c_d = (fetch("components", window(iso(dbd), iso(dbd))) or {}).get("components") or []

    my, md, mm = b_y["metrics"], b_d["metrics"], b_m["metrics"]
    T_Y = {"orders": my["orders"], "revenue": my["rev"]}
    T_D = {"orders": md["orders"], "revenue": md["rev"]}
    T_M = {"orders": mm["orders"], "revenue": mm["rev"]}

    rows = []
    # Headline, as its own section so Apps Script can read the KPI cards directly.
    for scope, m, prev in (("Yesterday", my, md), ("MTD", mm, None)):
        do = delta(m["orders"], (prev or {}).get("orders", 0)) if prev else None
        dr = delta(m["rev"], (prev or {}).get("rev", 0)) if prev else None
        rows.append({
            "report_date": rd, "section": "Headline", "scope": scope, "rank": 1,
            "entity": "All channels", "orders": int(m["orders"]),
            "orders_change_pct": "" if do is None else round(do, 2),
            "revenue_lakhs": round(m["rev"] / 1e5, 2),
            "revenue_change_pct": "" if dr is None else round(dr, 2),
            "aov": int(round(m.get("aov") or 0)), "revenue_contribution_pct": 100.0,
            "qty": int(m.get("qty") or 0), "qty_prev": "", "qty_diff": "",
        })

    rows += _tidy_rows("Channel Summary", "Yesterday", b_y["by"].get("channel"),
                       b_d["by"].get("channel"), rd, totals=T_Y, prev_totals=T_D)
    rows += _tidy_rows("Channel Summary", "MTD", b_m["by"].get("channel"), None, rd, totals=T_M)
    rows += _tidy_rows("Product Type Summary", "Yesterday", b_y["by"].get("materialType"),
                       b_d["by"].get("materialType"), rd, totals=T_Y, prev_totals=T_D)
    rows += _tidy_rows("Product Type Summary", "MTD", b_m["by"].get("materialType"), None, rd, totals=T_M)
    rows += _tidy_rows("Category Summary - Publication Books", "Yesterday",
                       subcat_rows(b_y, PUBLICATION_PARENTS), subcat_rows(b_d, PUBLICATION_PARENTS), rd)
    rows += _tidy_rows("Category Summary - Publication Books", "MTD",
                       subcat_rows(b_m, PUBLICATION_PARENTS), None, rd)
    rows += _tidy_rows("Top 10 Publication Books", "Yesterday",
                       sku_rows(b_y, PUBLICATION_PARENTS), sku_rows(b_d, PUBLICATION_PARENTS), rd, limit=10)
    rows += _tidy_rows("Top 10 Publication Books", "MTD",
                       sku_rows(b_m, PUBLICATION_PARENTS), None, rd, limit=10)
    rows += _tidy_rows("Top 10 Stationery & Merchandise", "Yesterday",
                       sku_rows(b_y, STATIONERY_PARENTS), sku_rows(b_d, STATIONERY_PARENTS), rd, limit=10)
    rows += _tidy_rows("Top 10 Stationery & Merchandise", "MTD",
                       sku_rows(b_m, STATIONERY_PARENTS), None, rd, limit=10)
    rows += _mover_rows("Inclined Products", c_y, c_d, rd, rising=True)
    rows += _mover_rows("Declined Products", c_y, c_d, rd, rising=False)

    tgt = target_rows(b_m, yest, load_targets())
    if tgt:
        say("target tracking for %s: %d categories" % (yest.strftime("%b %Y"), len(tgt) - 1))
        rows += tgt

    # How much of this day has actually landed. The mailer reads this and warns
    # rather than presenting a third of a day as if it were the whole day.
    say("measuring how complete %s is" % rd)
    pct_done, baseline, actual = completeness(yest)
    rows.append({
        "report_date": rd, "section": "Data Completeness", "scope": "Yesterday",
        "rank": 1, "entity": "Estimated completeness",
        "orders": int(actual), "orders_change_pct": "",
        "revenue_lakhs": "", "revenue_change_pct": "",
        "aov": int(round(baseline)),
        "revenue_contribution_pct": "" if pct_done is None else round(pct_done, 1),
        "qty": "", "qty_prev": "", "qty_diff": "",
    })
    if pct_done is not None:
        say("  %s holds %.0f%% of a settled day (%s orders vs a %s baseline)"
            % (rd, pct_done, num(actual), num(baseline)))
    return rows


def rows_to_csv(rows):
    import csv
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=CSV_COLUMNS, lineterminator="\n")
    w.writeheader()
    for r in rows:
        w.writerow(r)
    return buf.getvalue()


def main():
    ap = argparse.ArgumentParser(description="PW Orders daily emailer")
    ap.add_argument("--date", help="treat this YYYY-MM-DD as 'yesterday' (default: actual yesterday)")
    ap.add_argument("--dry-run", action="store_true", help="write the HTML, send nothing")
    ap.add_argument("--send", action="store_true", help="email the report")
    ap.add_argument("--csv", action="store_true", help="write tidy CSV for Google Sheets")
    ap.add_argument("--out", help="where to write the output")
    a = ap.parse_args()

    load_env()
    yest = (dt.date.fromisoformat(a.date) if a.date
            else dt.date.today() - dt.timedelta(days=1))

    if a.csv:
        rows = build_csv(yest)
        csv_text = rows_to_csv(rows)
        out = a.out or os.path.join(HERE, "daily_report_%s.csv" % yest.isoformat())
        io.open(out, "w", encoding="utf-8", newline="").write(csv_text)
        say("wrote %s (%d rows across %d sections)"
            % (out, len(rows), len({r["section"] for r in rows})))
        return 0

    subject, html = build(yest)
    say("subject: %s" % subject)

    if a.send:
        return 0 if send(subject, html) else 1

    out = a.out or os.path.join(HERE, "daily_report_preview.html")
    io.open(out, "w", encoding="utf-8", newline="\n").write(html)
    say("wrote %s (%.0f KB) - nothing sent" % (out, len(html) / 1024.0))
    return 0


if __name__ == "__main__":
    sys.exit(main())
