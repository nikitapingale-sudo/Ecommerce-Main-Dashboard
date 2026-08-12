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
#  2) SOURCE CONFIG   (SKU-level: Viniculum ⋈ product mapping  ∪  3P marketplace)
# ════════════════════════════════════════════════════════════
#  The dashboard's data source is the result of the curated SKU-level query in
#  build_query() below — the data team's "final query for sku_level":
#
#    leg 1 (source='Viniculum') gold_dbt_vinniculum_orders_base_fact
#                               JOIN gold_dbt_pwstore_product_mapping,
#                               restricted to B2B_DC / B2B_BOS / PW_Store
#    leg 2 (source='3P')        gold_dbt_ecom_3p_orders
#                               LEFT JOIN gold_dbt_pwstore_product_mapping
#
#  unioned together. Only the ~40 columns the dashboard consumes are selected
#  (and aliased to the names it expects) — not vc.* — so the payload stays
#  small. Both legs emit the SAME column list in the SAME order (UNION ALL),
#  with NULL/constant fills where the 3P feed has no equivalent.
VC_TABLE = "cdp.mview.gold_dbt_vinniculum_orders_base_fact"
PM_TABLE = "cdp.mview.gold_dbt_pwstore_product_mapping"
TP_TABLE = "cdp.mview.gold_dbt_ecom_3p_orders"

# Label shown in API /health and data.js meta.
ORDERS_TABLE = f"({VC_TABLE} JOIN {PM_TABLE}) UNION ALL {TP_TABLE}"

# Date window owned by the query (vc_order_date is a timestamp). The dashboard
# filters further client-side; the API `days` param is intentionally ignored
# for this source because these fixed dates define the dataset.
DATE_FROM = "2026-01-01"   # inclusive — applied to BOTH legs of the union
DATE_TO   = ""             # exclusive upper bound; "" = open-ended (up to latest data)

# Viniculum channels included. 3P marketplace channels are NOT listed here —
# they arrive through the second leg via gold_dbt_ecom_3p_orders.channel_new.
CHANNELS = ['B2B_DC', 'B2B_BOS', 'PW_Store']


# ════════════════════════════════════════════════════════════
#  3) STATUS GROUPING
# ════════════════════════════════════════════════════════════
#  Both maps are matched CASE-INSENSITIVELY. Viniculum already mixes casing
#  ('delivered', 'confirmed', 'Shipped complete') and the 3P marketplace leg
#  brings a third vocabulary ('Delivered', 'Cancelled', …) — matching on the
#  lower-cased value keeps all of them in the right bucket instead of dumping
#  the 3P rows into "Others".
def _mapping(pairs):
    """[(group, [raw statuses])] -> { lowercased raw status: group }."""
    return {raw.lower(): grp for grp, raws in pairs for raw in raws}


_ORDER_STATUS_MAP = _mapping([
    ("Cancelled",     ["closed", "Cancelled"]),
    ("Delivered",     ["delivered", "Replacement_Requested", "Return_Requested"]),
    ("Shipped",       ["Partially Shipped", "Shipped complete", "Shipped"]),
    ("Packed",        ["Packed", "Manifested"]),
    ("Received",      ["Pending", "Pick complete", "Allocated", "Part Picked", "Part Allocated",
                       "confirmed", "RECEIVED", "Cancellation_Requested", "Closed_By_System",
                       "Created", "Failed"]),
    ("Return/Refund", ["Refund_Failed", "Refund_Initiated", "Refunded", "Redispatch", "Replaced",
                       "Replacement_Initiated", "Return_Failed", "Return_Initiated", "Returned"]),
    ("RTO/Lost",      ["Shipped & Returned", "Lost", "Rto"]),
])

#  Input is `final_item_status`, which the SKU-level query now derives in SQL
#  (new_item_status_conditional) from the line's lifecycle dates rather than
#  from the raw vc_line_status. The first block below is those conditional
#  buckets; the rest are the legacy raw Viniculum + 3P marketplace statuses.
_ITEM_STATUS_MAP = _mapping([
    # ── conditional buckets from new_item_status_conditional ──
    ("Return/Refund", ["Refunded"]),
    ("RTO/Lost",      ["Return/RTO"]),
    # ── raw Viniculum / 3P statuses ──
    ("Cancelled",     ["Cancellation_Requested", "Cancelled", "Closed"]),
    ("Delivered",     ["Delivered"]),
    ("Packed",        ["Packed", "Partially Shipped", "Manifested"]),
    ("Allocated",     ["Allocated", "Part Picked", "Pick Complete", "Closed_By_System",
                       "Created", "Failed", "Received"]),
    ("Confirmed",     ["Part Allocated", "Confirmed"]),
    ("Pending",       ["Pending"]),
    ("Return/Refund", ["Refund_Failed", "Refund_Initiated", "Redispatch", "Replaced",
                       "Replacement_Initiated", "Replacement_Requested", "Return_Failed",
                       "Return_Initiated", "Return_Requested", "Returned"]),
    ("RTO/Lost",      ["Lost", "Rto", "Shipped & Returned"]),
    ("Shipped",       ["Shipped", "Shipped Complete"]),
])


def order_status_group(s):
    return _ORDER_STATUS_MAP.get((s or "").strip().lower(), "Others")


def item_status_group(s):
    return _ITEM_STATUS_MAP.get((s or "").strip().lower(), "Others")


# ════════════════════════════════════════════════════════════
#  4) SQL QUERY  — SKU LEVEL  (Viniculum ⋈ product mapping  ∪  3P marketplace)
# ════════════════════════════════════════════════════════════
#  This is the data team's "final query for sku_level". The business filters
#  are theirs, verbatim; only the output columns are mapped/aliased to the
#  names the dashboard consumes (see dataEngine.js + the status-group helpers
#  above). `days` is accepted for API compatibility but ignored — DATE_FROM /
#  DATE_TO own the window.
#
#  Two legs, UNION ALL'd. Both emit the SAME columns in the SAME order:
#
#  leg 1 — 'Viniculum'  (orders_base -> b2b_pwstore)
#    channels B2B_DC / B2B_BOS / PW_Store, and either
#      · PW_Store : vc_finance_category = 'Ecommerce' AND payment_mode <> 'CASH'
#      · B2B_*    : vc_finance_category = 'Ecommerce' AND vc_payment_method = 'Third Party'
#    No status filter — order/line/item status are dashboard filters instead.
#
#  leg 2 — '3P'  (tp_orders)
#    gold_dbt_ecom_3p_orders as-is, all statuses, LEFT JOIN'd to the product
#    mapping on db_skucode so the marketplace rows pick up the same category
#    hierarchy / variant identity. The feed carries no customer, city, coupon,
#    MRP, warehouse or courier — those columns are NULL for 3P rows and land in
#    the dashboard's "Unknown" bucket.
#
#  Item status: `final_item_status` is no longer the raw vc_line_status. It is
#  new_item_status_conditional — derived in SQL from the line's lifecycle dates
#  (Refunded > Cancelled > Return/RTO > Delivered > Shipped > Packed >
#  Allocated > raw pending/confirmed/closed/returned). The raw line status is
#  still emitted as `line_status` for the Raw Data page. item_status_group()
#  above maps both vocabularies.
#
#  Column mapping (dashboard_name  <-  Viniculum  |  3P):
#    order_date                 <- CAST(vc_order_date AS date)   | CAST(order_date AS date)
#    unique_id (line id)        <- vc.id                         | order_id||'|'||db_skucode
#    vco_external_order_number  <- vc.vc_reference_order_id       | tp.order_id
#    final_order_status         <- vc.vc_order_status             | tp.order_status
#    line_status                <- vc.vc_line_status              | tp.order_status
#    final_item_status          <- new_item_status_conditional    | tp.order_status
#    parent/sub_cat/.../variant <- pm.*                           | pv.* (LEFT JOIN)
#    qty / final_revenue        <- vc_qty / vc_order_item_amount  | tp.quantity / tp.revenue
#    oms  (= query's `source`)  <- 'Viniculum'                    | '3P'
#    purchase_level             <- vc.segment                     | '3P'
#    order_class                <- segment/purchase_type CASE     | '3P Online'
#  Best-effort dimensions (no exact source column — remap if needed):
#    order_category <- vc.vc_order_source | '3P Marketplace'
#    order_type     <- vc.material_type   | NULL
#    marketplace_cat / vco_brand = channel / 'PW'
def build_query(days=0, date_from=None, date_to=None):
    """Build the SKU-level union query.

    `date_from` / `date_to` override the module-level window so the caller can
    fetch the dataset in slices (see api.run_orders_query) — the full pull is
    large enough that a single fetch outlives the network's connection limit.
    `date_to` is EXCLUSIVE; pass None/"" for an open-ended upper bound.
    """
    channels = ", ".join(f"'{c}'" for c in CHANNELS)
    d_from = date_from or DATE_FROM
    d_to = DATE_TO if date_to is None else date_to
    # Open-ended upper bound when d_to is blank. Applied to both legs.
    vc_date_upper = f"\n          AND vc.vc_order_date < DATE '{d_to}'" if d_to else ""
    tp_date_upper = f"\n          AND tp.order_date  < DATE '{d_to}'" if d_to else ""

    return f"""
    WITH orders_base AS (
        SELECT vc.*,
               pm.parent_name,
               pm.sub_cat_name,
               pm.sub_sub_cat_name,
               pm.product_name,
               pm.product_variant_id   AS pm_product_variant_id,
               pm.product_variant_name AS pm_product_variant_name,
               CASE
                   WHEN vc.refunded_date   IS NOT NULL THEN 'Refunded'
                   WHEN vc.cancelled_date  IS NOT NULL THEN 'Cancelled'
                   WHEN vc.rto_date        IS NOT NULL OR vc.return_date      IS NOT NULL THEN 'Return/RTO'
                   WHEN vc.delivery_date   IS NOT NULL OR vc.od_delivery_date IS NOT NULL THEN 'Delivered'
                   WHEN vc.ship_date       IS NOT NULL OR vc.shipped_date     IS NOT NULL THEN 'Shipped'
                   WHEN vc.pack_date       IS NOT NULL OR vc.packed_date      IS NOT NULL THEN 'Packed'
                   WHEN vc.allocation_date IS NOT NULL THEN 'Allocated'
                   WHEN LOWER(vc.vc_line_status) = 'pending'            THEN 'Pending'
                   WHEN LOWER(vc.vc_line_status) = 'confirmed'          THEN 'Confirmed'
                   WHEN LOWER(vc.vc_line_status) = 'closed'             THEN 'Closed'
                   WHEN LOWER(vc.vc_line_status) = 'shipped & returned' THEN 'Returned'
                   ELSE 'Confirmed'
               END AS new_item_status_conditional
        FROM {VC_TABLE} vc
        JOIN {PM_TABLE} pm
            ON vc.vc_sku_code = pm.sku_code
        WHERE vc.vc_channel_name IN ({channels})
          AND vc.vc_order_date >= DATE '{d_from}'{vc_date_upper}
          AND (
                -- 1) PW_Store: Ecommerce + payment not CASH (NULL-safe)
                (vc.vc_channel_name = 'PW_Store'
                    AND vc.vc_finance_category = 'Ecommerce'
                    AND vc.payment_mode IS DISTINCT FROM 'CASH')
                -- 2) B2B: Ecommerce + Third Party
                OR (vc.vc_channel_name IN ('B2B_DC', 'B2B_BOS')
                    AND vc.vc_finance_category = 'Ecommerce'
                    AND vc.vc_payment_method = 'Third Party')
              )
    ),

    -- B2B + PW_Store leg (Viniculum) — all statuses kept
    b2b_pwstore AS (
        SELECT
          CAST(CAST(vc_order_date AS date) AS varchar)       AS order_date,
          CAST(CAST(COALESCE(delivery_date, od_delivery_date) AS date) AS varchar) AS final_delivery_date,
          CAST(CAST(refunded_date AS date) AS varchar)       AS refunded_date,
          CAST(id AS varchar)                                AS unique_id,
          CAST(vc_reference_order_id AS varchar)             AS vco_external_order_number,
          CAST(vc_order_status AS varchar)                   AS final_order_status,
          CAST(vc_line_status AS varchar)                    AS line_status,
          CAST(new_item_status_conditional AS varchar)       AS final_item_status,
          CAST(COALESCE(vc_customer_name, od_customer_name) AS varchar) AS vco_customer_name,
          CAST(vc_channel_name AS varchar)                   AS vco_channel_name,
          CAST('PW' AS varchar)                              AS vco_brand,
          CAST(parent_name AS varchar)                       AS parent_name,
          CAST(sub_cat_name AS varchar)                      AS sub_cat_name,
          CAST(sub_sub_cat_name AS varchar)                  AS sub_sub_cat_name,
          CAST(product_name AS varchar)                      AS product_name,
          CAST(pm_product_variant_id AS varchar)             AS product_variant_id,
          CAST(pm_product_variant_name AS varchar)           AS product_variant_name,
          CAST(vc_sku_code AS varchar)                       AS vco_sku_code,
          CAST(vc_sku_classification AS varchar)             AS sku_type,
          CAST(coupon_code AS varchar)                       AS coupon_code,
          CAST(vc_order_source AS varchar)                   AS order_category,
          CAST(vc_finance_category AS varchar)               AS finance_exam_category,
          CAST(vc_payment_method AS varchar)                 AS payment_sources,
          CAST(segment AS varchar)                           AS purchase_level,
          CAST(CASE
            WHEN segment = '3P'  THEN '3P Online'
            WHEN segment = 'B2B' THEN 'B2B'
            WHEN segment = '1P' AND (vc_purchase_type IN ('FBT','FBT_PACKAGE') OR purchase_type IN ('FBT','FBT_PACKAGE')) THEN 'FBT'
            WHEN segment = '1P' AND (vc_purchase_type = 'BATCH_ADDON' OR purchase_type = 'BATCH_ADDON') THEN 'BATCH ADDON'
            WHEN segment = '1P' AND (batch_order_id IS NULL OR TRIM(batch_order_id) = '') THEN 'Store Purchase'
            WHEN segment = '1P' AND (vc_purchase_type IS NULL OR TRIM(vc_purchase_type) = '')
                 AND (purchase_type IS NULL OR TRIM(purchase_type) = '') AND revenue_attribution = TRUE THEN 'ECOM_BOC'
            ELSE 'Other'
          END AS varchar)                                    AS order_class,
          CASE WHEN cancelled_date IS NOT NULL THEN 1 ELSE 0 END AS has_cancelled_date,
          CASE WHEN refunded_date  IS NOT NULL THEN 1 ELSE 0 END AS has_refunded_date,
          CAST(material_type AS varchar)                     AS order_type,
          CAST('Viniculum' AS varchar)                       AS oms,
          CAST(org_name AS varchar)                          AS organization,
          CAST(vc_channel_name AS varchar)                   AS marketplace_cat,
          CAST(COALESCE(vc_qty, 0)                AS double) AS qty,
          CAST(COALESCE(vc_order_item_amount, 0)  AS double) AS final_revenue,
          CAST(COALESCE(vc_mrp, 0)                AS double) AS mrp,
          CAST(COALESCE(vc_unit_price, 0)         AS double) AS vco_unit_price,
          CAST(COALESCE(vc_mrp, 0)                AS double) AS vco_mrp,
          CAST(COALESCE(vc_order_shipping_charges, 0) AS double) AS delivery_charge,
          CAST(COALESCE(vc_order_amount, 0)       AS double) AS total_amount,
          CAST(COALESCE(vc_order_shipping_charges, 0) AS double) AS vco_shipping_charges,
          CAST(vc_ship_city AS varchar)                      AS city,
          CAST(vc_ship_state AS varchar)                     AS state,
          CAST(source_warehouse AS varchar)                  AS warehouse,
          CAST(COALESCE(delivery_partner, transporter_name) AS varchar) AS delivery_partner
        FROM orders_base
    ),

    -- 3P marketplace leg — as it is, all statuses kept
    tp_orders AS (
        SELECT
          CAST(CAST(tp.order_date AS date) AS varchar)       AS order_date,
          CAST(NULL AS varchar)                              AS final_delivery_date,
          CAST(CAST(tp.refunded_at AS date) AS varchar)      AS refunded_date,
          CAST(tp.order_id AS varchar) || '|' || CAST(tp.db_skucode AS varchar) AS unique_id,
          CAST(tp.order_id AS varchar)                       AS vco_external_order_number,
          CAST(tp.order_status AS varchar)                   AS final_order_status,
          CAST(tp.order_status AS varchar)                   AS line_status,
          CAST(tp.order_status AS varchar)                   AS final_item_status,
          CAST(NULL AS varchar)                              AS vco_customer_name,
          CAST(tp.channel_new AS varchar)                    AS vco_channel_name,
          CAST('PW' AS varchar)                              AS vco_brand,
          CAST(pv.parent_name AS varchar)                    AS parent_name,
          CAST(pv.sub_cat_name AS varchar)                   AS sub_cat_name,
          CAST(pv.sub_sub_cat_name AS varchar)               AS sub_sub_cat_name,
          CAST(COALESCE(pv.product_name, tp.product_name) AS varchar) AS product_name,
          CAST(pv.product_variant_id AS varchar)             AS product_variant_id,
          CAST(pv.product_variant_name AS varchar)           AS product_variant_name,
          CAST(tp.db_skucode AS varchar)                     AS vco_sku_code,
          CAST(NULL AS varchar)                              AS sku_type,
          CAST(NULL AS varchar)                              AS coupon_code,
          CAST('3P Marketplace' AS varchar)                  AS order_category,
          CAST('Ecommerce' AS varchar)                       AS finance_exam_category,
          CAST(NULL AS varchar)                              AS payment_sources,
          CAST('3P' AS varchar)                              AS purchase_level,
          CAST('3P Online' AS varchar)                       AS order_class,
          0                                                  AS has_cancelled_date,
          CASE WHEN tp.refunded_at IS NOT NULL THEN 1 ELSE 0 END AS has_refunded_date,
          CAST(NULL AS varchar)                              AS order_type,
          CAST('3P' AS varchar)                              AS oms,
          CAST(NULL AS varchar)                              AS organization,
          CAST(tp.channel_new AS varchar)                    AS marketplace_cat,
          CAST(COALESCE(tp.quantity, 0) AS double)           AS qty,
          CAST(COALESCE(tp.revenue, 0)  AS double)           AS final_revenue,
          CAST(0 AS double)                                  AS mrp,
          CAST(0 AS double)                                  AS vco_unit_price,
          CAST(0 AS double)                                  AS vco_mrp,
          CAST(0 AS double)                                  AS delivery_charge,
          CAST(COALESCE(tp.revenue, 0) AS double)            AS total_amount,
          CAST(0 AS double)                                  AS vco_shipping_charges,
          CAST(NULL AS varchar)                              AS city,
          CAST(NULL AS varchar)                              AS state,
          CAST(NULL AS varchar)                              AS warehouse,
          CAST(NULL AS varchar)                              AS delivery_partner
        FROM {TP_TABLE} AS tp
        LEFT JOIN {PM_TABLE} AS pv
            ON tp.db_skucode = pv.sku_code
        WHERE tp.order_date >= DATE '{d_from}'{tp_date_upper}
    )

    SELECT * FROM b2b_pwstore
    UNION ALL
    SELECT * FROM tp_orders
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
#  Source tables are the GOLD product-variant + bundle-mapping models (the
#  silver ones are superseded), scoped to the PW store org only. Each component
#  also carries its study-material type (product_material_type), surfaced on the
#  Component-Level page.
PV_TABLE         = "cdp.store.gold_product_variants"
BUNDLE_MAP_TABLE = "cdp.store.gold_bundle_product_variant_mappings"
ORG_IDS          = ['5eb393ee95fab7468a79d189']


def build_bundle_mapping_query():
    orgs = ", ".join(f"'{o}'" for o in ORG_IDS)
    return f"""
    WITH filtered_products AS (
        SELECT id, title, price, status, type, organization_id, sku_code, product_material_type
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
        -- bundle -> each component
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
            comp.sku_code,
            comp.product_material_type
        FROM bundle_components bc
        JOIN filtered_products comp   ON bc.component_product_variant_id = comp.id
        JOIN filtered_products bundle ON bc.bundle_product_variant_id   = bundle.id

        UNION ALL

        -- simple product -> itself (qty 1, ratio 1)
        SELECT
            fp.id    AS product_variant_id,
            fp.id    AS component_product_variant_id,
            fp.title AS title_component,
            1        AS quantity_bundle,
            fp.price AS component_mrp,
            fp.price AS bundle_mrp,
            fp.status,
            fp.type  AS product_type,
            fp.sku_code,
            fp.product_material_type
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
        sku_code             AS component_sku_code,
        product_type         AS component_product_type,
        status               AS component_status,
        product_material_type AS component_product_material_type
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
