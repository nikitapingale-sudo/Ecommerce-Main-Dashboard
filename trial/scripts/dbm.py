#!/usr/bin/env python3
# ============================================================
#  PW Orders Intelligence Hub — DBM (Trino edition)
#  File: scripts/dbm.py
#
#  PURPOSE:
#    Connects to Trino, runs the gold_dbt_store_orders query
#    (joined with your extra SQL table), applies status
#    groupings, and writes src/data.js so the dashboard always
#    has fresh data on next build/deploy.
#
#    This REPLACES the old PostgreSQL generator (scripts/dbm.js)
#    and the dummy/Excel data that used to live in src/data.js.
#
#  USAGE:
#    python scripts/dbm.py                # full refresh
#    python scripts/dbm.py --days=7       # last 7 days only
#    python scripts/dbm.py --days=30      # last 30 days
#    python scripts/dbm.py --dry-run      # query only, no file write
#    python scripts/dbm.py --verbose      # also print the SQL
#
#  PREREQUISITE:
#    pip install trino
#    (see scripts/requirements.txt)
# ============================================================

import os
import sys
import json
import math
import time
import shutil
import argparse
from datetime import datetime, date
from decimal import Decimal

from trino.dbapi import connect
from trino.auth import BasicAuthentication


# ════════════════════════════════════════════════════════════
#  1) TRINO CONNECTION   ← PASTE YOUR REAL VALUES HERE
# ════════════════════════════════════════════════════════════
#  These are intentionally left blank, exactly like the snippet
#  you shared. Fill them in inside VS Code before running.
def _load_secrets_env():
    """Load scripts/llm.env (TRINO_* / GROQ_* etc.) into os.environ if present.

    Credentials live ONLY in this gitignored file — never hardcoded in source.
    api.py also loads it; this makes `python scripts/dbm.py` work standalone too.
    """
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "llm.env")
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


def trino_prod_conn():
    # Connection settings come from env vars (see scripts/llm.env — gitignored).
    # No credentials are stored in source. Copy scripts/llm.env.example and fill in.
    _load_secrets_env()
    host     = os.getenv("TRINO_HOST", "")
    port     = int(os.getenv("TRINO_PORT", "443"))
    user     = os.getenv("TRINO_USER", "")
    password = os.getenv("TRINO_PASSWORD", "")
    catalog  = os.getenv("TRINO_CATALOG", "cdp")
    if not host or not user or not password:
        raise RuntimeError(
            "Trino credentials missing. Copy scripts/llm.env.example to scripts/llm.env "
            "and set TRINO_HOST / TRINO_USER / TRINO_PASSWORD (or export them as env vars).")

    trino_conn = connect(
        host=host,
        port=port,
        user=user,
        catalog=catalog,
        auth=BasicAuthentication(user, password),
        http_scheme="https",                # "https" (use "http" only for non-TLS)
    )
    print("trino connection established")
    return trino_conn


# ════════════════════════════════════════════════════════════
#  2) SOURCE CONFIG   (Vinniculum orders base fact ⋈ product mapping)
# ════════════════════════════════════════════════════════════
#  The dashboard's data source is the result of the curated query in
#  build_query() below: gold_dbt_vinniculum_orders_base_fact joined to
#  gold_dbt_pwstore_product_mapping, with the business filters supplied
#  by the data team. Only the ~35 columns the dashboard consumes are
#  selected (and aliased to the names it expects) — not vc.* — so the
#  payload stays small.
VC_TABLE = "cdp.mview.gold_dbt_vinniculum_orders_base_fact"
PM_TABLE = "cdp.mview.gold_dbt_pwstore_product_mapping"

# Label shown in API /health and data.js meta.
ORDERS_TABLE = f"{VC_TABLE} JOIN {PM_TABLE}"

# Date window owned by the query (vc_order_date is a timestamp). The dashboard
# filters further client-side; the API `days` param is intentionally ignored
# for this source because these fixed dates define the dataset.
DATE_FROM = "2026-01-01"   # inclusive
DATE_TO   = ""             # exclusive upper bound; "" = open-ended (up to latest data)

# Channels included in the dataset.
CHANNELS = [
    'Flipkart_SKD', 'B2B_DC', 'B2B_BOS', 'FirstCry', 'PW_Store',
    'Flipkart_Patna', 'Meesho', 'Cloudtail DF', 'Amazon EasyShip',
]

# Order statuses kept (line statuses excluded are handled in build_query).
ORDER_STATUSES = [
    'Shipped complete', 'Partially Shipped', 'Pending', 'Pick complete',
    'Allocated', 'Part Picked', 'delivered', 'confirmed',
    'Part Allocated', 'Packed',
]
LINE_STATUS_EXCLUDE = ['closed', 'Shipped & Returned', 'Cancelled']


# ════════════════════════════════════════════════════════════
#  3) STATUS GROUPING  (mirrors scripts/dbm.js exactly)
# ════════════════════════════════════════════════════════════
def order_status_group(s):
    s = s or ""
    if s in ("closed", "Cancelled"):
        return "Cancelled"
    if s in ("delivered", "Replacement_Requested", "Return_Requested"):
        return "Delivered"
    if s in ("Partially Shipped", "Shipped complete", "Shipped"):
        return "Shipped"
    if s in ("Packed", "Manifested"):
        return "Packed"
    if s in ("Pending", "Pick complete", "Allocated", "Part Picked", "Part Allocated",
             "confirmed", "RECEIVED", "Cancellation_Requested", "Closed_By_System",
             "Created", "Failed"):
        return "Received"
    if s in ("Refund_Failed", "Refund_Initiated", "Refunded", "Redispatch", "Replaced",
             "Replacement_Initiated", "Return_Failed", "Return_Initiated", "Returned"):
        return "Return/Refund"
    if s in ("Shipped & Returned", "Lost", "Rto"):
        return "RTO/Lost"
    return "Others"


def item_status_group(s):
    # Vinniculum vc_line_status uses mixed casing (e.g. 'delivered',
    # 'Shipped complete', 'confirmed', 'Pick complete'); handle both casings.
    s = s or ""
    if s in ("Cancellation_Requested", "Cancelled", "Closed"):
        return "Cancelled"
    if s in ("Delivered", "delivered"):
        return "Delivered"
    if s in ("Packed", "Partially Shipped", "Manifested"):
        return "Packed"
    if s in ("Allocated", "Part Picked", "Pick Complete", "Pick complete", "Closed_By_System",
             "Created", "Failed", "Received"):
        return "Allocated"
    if s in ("Part Allocated", "Confirmed", "confirmed"):
        return "Confirmed"
    if s == "Pending":
        return "Pending"
    if s in ("Refund_Failed", "Refund_Initiated", "Refunded", "Redispatch", "Replaced",
             "Replacement_Initiated", "Replacement_Requested", "Return_Failed",
             "Return_Initiated", "Return_Requested", "Returned"):
        return "Return/Refund"
    if s in ("Lost", "Rto", "Shipped & Returned"):
        return "RTO/Lost"
    if s in ("Shipped", "Shipped Complete", "Shipped complete"):
        return "Shipped"
    return "Others"


# ════════════════════════════════════════════════════════════
#  4) SQL QUERY  (Vinniculum base fact ⋈ product mapping)
# ════════════════════════════════════════════════════════════
#  The business filters below are the data team's query, verbatim. Only the
#  output columns are mapped/aliased to the names the dashboard consumes
#  (see dataEngine.js + the status-group helpers above). `days` is accepted
#  for API compatibility but ignored — DATE_FROM/DATE_TO own the window.
#
#  Column mapping (dashboard_name  <-  source):
#    order_date                 <- CAST(vc.vc_order_date AS date)
#    unique_id (line id)        <- vc.id
#    vco_external_order_number  <- vc.vc_reference_order_id  (distinct order count;
#                                                       populated across all channels)
#    final_order_status         <- vc.vc_order_status  (drives order_status_group)
#    final_item_status          <- vc.vc_line_status   (drives item_status_group)
#    vco_customer_name          <- vc.vc_customer_name / od_customer_name
#    vco_channel_name           <- vc.vc_channel_name
#    parent/sub_cat/.../variant <- pm.*  (product mapping)
#    vco_sku_code (WMS sku code)<- vc.vc_sku_code
#    sku_type                   <- vc.vc_sku_classification
#    coupon_code                <- vc.coupon_code   (global filter)
#    SKU identity (SKU page)    <- product_variant_id = SKU code, product_variant_name = SKU name
#    finance_exam_category      <- vc.vc_finance_category
#    payment_sources            <- vc.vc_payment_method (clean COD/Prepaid/Third Party)
#    purchase_level             <- vc.segment           (1P / 3P)
#    organization               <- vc.org_name
#    qty                        <- vc.vc_qty
#    final_revenue              <- vc.vc_order_item_amount (line net amount)
#    total_amount               <- vc.vc_order_amount      (incl. shipping)
#    mrp / vco_mrp              <- vc.vc_mrp
#    vco_unit_price             <- vc.vc_unit_price
#    delivery/shipping charges  <- vc.vc_order_shipping_charges
#    city / state               <- vc.vc_ship_city / vc_ship_state
#    warehouse                  <- vc.source_warehouse
#    delivery_partner           <- vc.delivery_partner / transporter_name
#  Best-effort dimensions (no exact legacy equivalent — remap if needed):
#    order_category <- vc.vc_order_source · order_type <- vc.material_type
#    oms = 'VC' (constant) · marketplace_cat <- vc.vc_channel_name · vco_brand = 'PW'
def build_query(days=0):
    channels = ", ".join(f"'{c}'" for c in CHANNELS)
    # Open-ended upper bound when DATE_TO is blank.
    date_upper = f"\n      AND vc.vc_order_date < DATE '{DATE_TO}'" if DATE_TO else ""

    return f"""
    SELECT
      CAST(CAST(vc.vc_order_date AS date) AS varchar)   AS order_date,
      vc.id                                             AS unique_id,
      vc.vc_reference_order_id                          AS vco_external_order_number,
      vc.vc_order_status                                AS final_order_status,
      vc.vc_line_status                                 AS final_item_status,
      COALESCE(vc.vc_customer_name, vc.od_customer_name) AS vco_customer_name,
      vc.vc_channel_name                                AS vco_channel_name,
      'PW'                                              AS vco_brand,
      pm.parent_name                                    AS parent_name,
      pm.sub_cat_name                                   AS sub_cat_name,
      pm.sub_sub_cat_name                               AS sub_sub_cat_name,
      pm.product_name                                   AS product_name,
      pm.product_variant_id                             AS product_variant_id,
      pm.product_variant_name                           AS product_variant_name,
      vc.vc_sku_code                                    AS vco_sku_code,
      vc.vc_sku_classification                          AS sku_type,
      vc.coupon_code                                    AS coupon_code,
      vc.vc_order_source                                AS order_category,
      vc.vc_finance_category                            AS finance_exam_category,
      vc.vc_payment_method                              AS payment_sources,
      vc.segment                                        AS purchase_level,
      vc.material_type                                  AS order_type,
      'VC'                                              AS oms,
      vc.org_name                                       AS organization,
      vc.vc_channel_name                                AS marketplace_cat,
      COALESCE(vc.vc_qty, 0)                            AS qty,
      COALESCE(vc.vc_order_item_amount, 0)              AS final_revenue,
      COALESCE(vc.vc_mrp, 0)                            AS mrp,
      COALESCE(vc.vc_unit_price, 0)                     AS vco_unit_price,
      COALESCE(vc.vc_mrp, 0)                            AS vco_mrp,
      COALESCE(vc.vc_order_shipping_charges, 0)         AS delivery_charge,
      COALESCE(vc.vc_order_amount, 0)                   AS total_amount,
      COALESCE(vc.vc_order_shipping_charges, 0)         AS vco_shipping_charges,
      vc.vc_ship_city                                   AS city,
      vc.vc_ship_state                                  AS state,
      vc.source_warehouse                               AS warehouse,
      COALESCE(vc.delivery_partner, vc.transporter_name) AS delivery_partner
    FROM {VC_TABLE} vc
    JOIN {PM_TABLE} pm
      ON vc.vc_sku_code = pm.sku_code
    WHERE vc.vc_channel_name IN ({channels})
      AND vc.vc_order_date >= DATE '{DATE_FROM}'{date_upper}
      AND (
            (vc.vc_channel_name IN ('B2B_DC', 'B2B_BOS')
              AND vc.vc_payment_method = 'Third Party'
              AND vc.vc_finance_category = 'Ecommerce')
            OR (vc.vc_channel_name NOT IN ('B2B_DC', 'B2B_BOS'))
          )
      -- (order/line status are NOT filtered here — exposed as dashboard filters instead)
      -- Condition 1: if batch present, exclude PLAN_ITEM purchase_type
      AND (
            (vc.batch_order_id IS NULL OR TRIM(vc.batch_order_id) = '')
            OR vc.purchase_type IS DISTINCT FROM 'PLAN_ITEM'
          )
      -- Condition 2: same rule for vc_purchase_type
      AND (
            (vc.batch_order_id IS NULL OR TRIM(vc.batch_order_id) = '')
            OR vc.vc_purchase_type IS DISTINCT FROM 'PLAN_ITEM'
          )
      -- Condition 2b: if batch present AND vc_purchase_type blank, require revenue_attribution
      AND (
            (vc.batch_order_id IS NULL OR TRIM(vc.batch_order_id) = '')
            OR NOT (vc.vc_purchase_type IS NULL OR TRIM(vc.vc_purchase_type) = '')
            OR vc.revenue_attribution = TRUE
          )
      -- Condition 3: PW_Store -> only Physicswallah org
      AND (vc.vc_channel_name <> 'PW_Store' OR vc.org_name = 'Physicswallah')
      AND pm.parent_name <> 'Gurukulam Goodies'
    ORDER BY order_date DESC
    """


# ════════════════════════════════════════════════════════════
#  4b) BUNDLE → COMPONENT MAPPING  (for Component-Level Summary)
# ════════════════════════════════════════════════════════════
#  A product the customer buys (product_variant_id) may be a BUNDLE made of
#  several component SKUs. This query returns one row per (bundle, component)
#  with the share each component takes of the bundle's MRP (mrp_ratio) and how
#  many units of the component sit inside one bundle (quantity_bundle). SIMPLE
#  products map to themselves (ratio 1, qty 1).
#
#  The dashboard loads this small table once and, to build the Component-Level
#  Summary, splits each sold SKU's qty/revenue across its components:
#     component_qty   = sku_qty     * quantity_bundle
#     component_sales = sku_revenue * mrp_ratio
#  Because the mrp_ratios of a bundle sum to 1, component sales sum back to the
#  SKU's revenue — so no double counting.
PV_TABLE         = "cdp.store.silver_product_variants"
BUNDLE_MAP_TABLE = "cdp.store.silver_bundle_product_variant_mappings"
ORG_IDS          = ['5eb393ee95fab7468a79d189', '63b52963e72e8b00186c11f3']


def build_bundle_mapping_query():
    orgs = ", ".join(f"'{o}'" for o in ORG_IDS)
    return f"""
    WITH filtered_products AS (
        SELECT id, title, price, status, type, organization_id, sku_code
        FROM {PV_TABLE}
        WHERE organization_id IN ({orgs})
          AND type <> 'SUPERBUNDLE'
    ),
    bundle_components AS (
        SELECT bundle_product_variant_id, component_product_variant_id, quantity
        FROM {BUNDLE_MAP_TABLE}
        WHERE deleted_at IS NULL
    ),
    bundle_child_mapping AS (
        SELECT
            bc.bundle_product_variant_id           AS product_variant_id,
            bc.component_product_variant_id,
            comp.title                             AS title_component,
            bc.quantity                            AS quantity_bundle,
            (comp.price * bc.quantity)             AS component_mrp,
            SUM(comp.price * bc.quantity)
                OVER (PARTITION BY bc.bundle_product_variant_id) AS bundle_mrp,
            comp.status,
            comp.type                              AS product_type,
            comp.sku_code
        FROM bundle_components bc
        JOIN filtered_products comp   ON bc.component_product_variant_id = comp.id
        JOIN filtered_products bundle ON bc.bundle_product_variant_id   = bundle.id

        UNION ALL

        SELECT
            fp.id    AS product_variant_id,
            fp.id    AS component_product_variant_id,
            fp.title AS title_component,
            1        AS quantity_bundle,
            fp.price AS component_mrp,
            fp.price AS bundle_mrp,
            fp.status,
            fp.type  AS product_type,
            fp.sku_code
        FROM filtered_products fp
        WHERE fp.type = 'SIMPLE'
    )
    SELECT
        product_variant_id,
        component_product_variant_id,
        title_component,
        quantity_bundle,
        CASE WHEN bundle_mrp IS NULL OR bundle_mrp = 0 THEN 0.0
             ELSE CAST(component_mrp AS DOUBLE) / bundle_mrp END AS mrp_ratio,
        sku_code     AS component_sku_code,
        product_type AS component_product_type,
        status       AS component_status
    FROM bundle_child_mapping
    """


# ════════════════════════════════════════════════════════════
#  5) HELPERS
# ════════════════════════════════════════════════════════════
def log(msg):
    print(f"[DBM {datetime.utcnow().isoformat()}Z] {msg}")


def sanitize(v):
    """Make a value JSON-safe and consistent with what the dashboard expects."""
    if v is None:
        return None
    if isinstance(v, float):
        return None if math.isnan(v) or math.isinf(v) else v
    if isinstance(v, Decimal):
        f = float(v)
        return None if math.isnan(f) or math.isinf(f) else f
    if isinstance(v, (datetime, date)):
        return v.isoformat()
    return v


def transform_row(row):
    row = {k: sanitize(v) for k, v in row.items()}
    row["order_status_group"] = order_status_group(row.get("final_order_status"))
    row["item_status_group"] = item_status_group(row.get("final_item_status"))
    return row


def write_data_file(rows, root, source_label, days_label):
    out_path = os.path.join(root, "src", "data.js")
    backup_path = os.path.join(root, "src", "data.backup.js")

    if os.path.exists(out_path):
        shutil.copyfile(out_path, backup_path)
        log("Backed up existing data.js -> data.backup.js")

    now = datetime.utcnow().isoformat() + "Z"
    meta = {
        "generatedAt": now,
        "rowCount": len(rows),
        "source": source_label,
        "engine": "trino",
        "daysFilter": days_label,
    }

    # null (not NaN) for missing values — valid JS *and* valid JSON.
    data_json = json.dumps(rows, ensure_ascii=False)
    meta_json = json.dumps(meta, ensure_ascii=False)

    content = "\n".join([
        f"// Auto-generated by DBM (Trino) — {now}",
        f"// Rows: {len(rows)} | Source: {source_label}",
        "// DO NOT EDIT MANUALLY",
        f"export const DATA = {data_json};",
        f"export const META = {meta_json};",
        "",
    ])

    with open(out_path, "w", encoding="utf-8") as f:
        f.write(content)

    kb = os.path.getsize(out_path) / 1024
    log(f"Written src/data.js ({kb:.1f} KB, {len(rows)} rows)")


# ════════════════════════════════════════════════════════════
#  6) MAIN
# ════════════════════════════════════════════════════════════
def main():
    parser = argparse.ArgumentParser(description="PW Dashboard — Trino data refresh")
    parser.add_argument("--days", type=int, default=0, help="only last N days (0 = all)")
    parser.add_argument("--dry-run", action="store_true", help="query only, do not write file")
    parser.add_argument("--verbose", action="store_true", help="print the SQL query")
    args = parser.parse_args()

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    source_label = ORDERS_TABLE

    log(f"Starting — days={args.days or 'all'}, dryRun={args.dry_run}, engine=trino")

    sql = build_query(args.days)
    if args.verbose:
        log("Query:\n" + sql)
    log(f"Source: {ORDERS_TABLE}  window {DATE_FROM} .. {DATE_TO}")

    try:
        log("Connecting to Trino...")
        conn = trino_prod_conn()
        cur = conn.cursor()

        log("Running query...")
        t0 = time.time()
        cur.execute(sql)
        records = cur.fetchall()
        columns = [c[0] for c in cur.description]
        elapsed = time.time() - t0
        log(f"Query complete — {len(records)} rows in {elapsed:.2f}s")

        rows = [transform_row(dict(zip(columns, rec))) for rec in records]
        log(f"Transformed {len(rows)} rows (added status groups)")

        if args.dry_run:
            log("DRY RUN — skipping file write. Sample row:")
            print(json.dumps(rows[0] if rows else {}, indent=2, ensure_ascii=False))
        else:
            write_data_file(rows, root, source_label,
                            args.days if args.days else "all")
    except Exception as err:
        log(f"ERROR: {err}")
        if args.verbose:
            raise
        sys.exit(1)
    finally:
        try:
            conn.close()
        except Exception:
            pass

    log("DBM complete.")


if __name__ == "__main__":
    main()
