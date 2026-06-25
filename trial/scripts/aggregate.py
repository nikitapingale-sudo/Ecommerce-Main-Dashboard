#!/usr/bin/env python3
# ============================================================
#  PW Orders Intelligence Hub — server-side aggregation engine
#  File: scripts/aggregate.py
#
#  Holds the curated order rows in memory once (pandas DataFrame)
#  and returns small pre-aggregated bundles per filter request.
#
#  Performance: dimension columns are cleaned + cast to `category`
#  and the order/line ids are factorised to int codes ONCE at load
#  time, so each groupby/nunique on ~600k rows stays fast. The
#  category hierarchy is built from 4 flat group-bys (no .xs()).
# ============================================================

import json
import numpy as np
import pandas as pd

FILTER_COLS = {
    "channels": "vco_channel_name", "warehouses": "warehouse", "states": "state",
    "payments": "payment_sources", "oms": "oms", "orderTypes": "order_type",
    "purchaseLevels": "purchase_level", "categories": "parent_name",
    "statuses": "order_status_group", "finCats": "finance_exam_category",
    "orderCats": "order_category", "couriers": "delivery_partner", "coupons": "coupon_code",
    "orderStatuses": "final_order_status", "lineStatuses": "final_item_status",
}
DIM_COLS = {
    "channel": "vco_channel_name", "payment": "payment_sources", "finance": "finance_exam_category",
    "orderCategory": "order_category", "oms": "oms", "purchaseLevel": "purchase_level",
    "orderStatus": "order_status_group", "itemStatus": "item_status_group",
    "courier": "delivery_partner", "warehouse": "warehouse", "state": "state", "city": "city",
    "parent": "parent_name", "orderType": "order_type", "brand": "vco_brand", "coupon": "coupon_code",
    "orderStatusRaw": "final_order_status", "lineStatusRaw": "final_item_status",
}
HIER_LEVELS = ["parent_name", "sub_cat_name", "sub_sub_cat_name", "product_name"]
PENDING_STATUSES = ("Received", "Packed", "Shipped")
PENDENCY_TABLE_COLS = [
    "order_date", "vco_external_order_number", "unique_id", "vco_customer_name",
    "vco_channel_name", "parent_name", "product_name", "order_status_group",
    "item_status_group", "final_order_status", "qty", "final_revenue",
    "city", "state", "warehouse", "delivery_partner",
]
ORDER, LINE = "vco_external_order_number", "unique_id"
NUMERIC = ["qty", "final_revenue", "mrp", "vco_mrp", "vco_unit_price", "delivery_charge", "total_amount"]

# Columns we group/filter on — cleaned + categorised once for fast groupby.
CAT_COLS = sorted(set(DIM_COLS.values()) | set(FILTER_COLS.values())
                  | set(HIER_LEVELS) | {"product_variant_id"})


def _records(df):
    """DataFrame -> list[dict] with JSON-native types (NaN -> null)."""
    return json.loads(df.to_json(orient="records"))


def _enrich(g, total):
    g["asp"] = np.where(g["qty"] > 0, g["revenue"] / g["qty"], 0.0)
    g["aov"] = np.where(g["orders"] > 0, g["revenue"] / g["orders"], 0.0)
    g["revShare"] = (g["revenue"] / total * 100) if total > 0 else 0.0
    return g


class Dataset:
    def __init__(self, rows):
        df = pd.DataFrame(rows)
        self.n = len(df)
        for c in NUMERIC:
            df[c] = pd.to_numeric(df.get(c), errors="coerce").fillna(0.0) if c in df.columns else 0.0
        df["_mrp"] = df["vco_mrp"].where(df["vco_mrp"] > 0, df["mrp"])
        df["order_date"] = df["order_date"].astype("string")
        # Clean + categorise dimension columns once (huge groupby speedup).
        for c in CAT_COLS:
            if c in df.columns:
                df[c] = df[c].fillna("Unknown").replace("", "Unknown").astype("category")
        # Factorise ids to int codes for fast distinct counts.
        df["_oid"] = pd.factorize(df[ORDER])[0]
        df["_lid"] = pd.factorize(df[LINE])[0]
        # Successful order = not cancelled / not RTO-or-lost.
        if "order_status_group" in df.columns:
            df["_succ"] = ~df["order_status_group"].astype("string").isin(["Cancelled", "RTO/Lost"])
        else:
            df["_succ"] = True
        self.df = df
        dates = df["order_date"].dropna()
        self.min_date = str(dates.min()) if len(dates) else ""
        self.max_date = str(dates.max()) if len(dates) else ""

    # ── filtering ──
    def _sub(self, filters):
        df = self.df
        filters = filters or {}
        mask = np.ones(len(df), dtype=bool)
        dfrom, dto = filters.get("dateFrom") or "", filters.get("dateTo") or ""
        if dfrom:
            mask &= (df["order_date"] >= dfrom).to_numpy()
        if dto:
            mask &= (df["order_date"] <= dto).to_numpy()
        for fkey, col in FILTER_COLS.items():
            vals = filters.get(fkey)
            if vals and col in df.columns:
                mask &= df[col].isin(vals).to_numpy()
        return df[mask]

    # ── metrics ──
    def metrics(self, df):
        orders = int(df["_oid"].nunique())
        lines = int(df["_lid"].nunique())
        qty, rev = float(df["qty"].sum()), float(df["final_revenue"].sum())
        mrp_sum = float((df["_mrp"] * df["qty"]).sum())
        so = df.groupby("order_status_group", observed=True)["_oid"].nunique() if len(df) else pd.Series(dtype=int)
        g = lambda k: int(so.get(k, 0))
        delivered, rto, cancelled = g("Delivered"), g("RTO/Lost"), g("Cancelled")
        shipped, packed, received = g("Shipped"), g("Packed"), g("Received")
        returns = g("Return/Refund")
        discount = mrp_sum - rev
        pc = lambda x: (x / orders * 100) if orders else 0
        return {
            "orders": orders, "lines": lines, "qty": qty, "rev": rev, "mrpSum": mrp_sum,
            "discount": discount, "discPct": (discount / mrp_sum * 100) if mrp_sum > 0 else 0,
            "aov": (rev / orders) if orders else 0, "asp": (rev / qty) if qty > 0 else 0,
            "aul": (qty / orders) if orders else 0,
            "delivered": delivered, "rto": rto, "cancelled": cancelled,
            "shipped": shipped, "packed": packed, "received": received, "returns": returns,
            "inTransit": shipped + packed,
            "delivRate": pc(delivered), "rtoRate": pc(rto), "cancelRate": pc(cancelled), "shippedRate": pc(shipped),
            "delCharges": float(df["delivery_charge"].sum()),
            "prepaid": int((df["payment_sources"] == "Prepaid").sum()),
            "cod": int((df["payment_sources"] == "COD").sum()),
        }

    # ── generic group-by ──
    def group(self, df, col, limit=None):
        if len(df) == 0 or col not in df.columns:
            return []
        g = df.groupby(col, observed=True).agg(
            orders=("_oid", "nunique"), lines=("_lid", "nunique"),
            qty=("qty", "sum"), revenue=("final_revenue", "sum"),
        ).reset_index().rename(columns={col: "name"})
        g = _enrich(g, g["revenue"].sum()).sort_values("revenue", ascending=False)
        if limit:
            g = g.head(limit)
        return _records(g)

    # ── time series ──
    def by_date(self, df, gran):
        if len(df) == 0:
            return []
        s = df["order_date"]
        if gran == "month":
            key = s.str.slice(0, 7)
        elif gran == "week":
            dt = pd.to_datetime(s, errors="coerce")
            key = (dt - pd.to_timedelta(dt.dt.weekday, unit="D")).dt.strftime("%Y-%m-%d")
        else:
            key = s
        g = df.assign(_k=key.to_numpy()).groupby("_k", sort=True, observed=True).agg(
            orders=("_oid", "nunique"), lines=("_lid", "nunique"),
            qty=("qty", "sum"), revenue=("final_revenue", "sum"),
        ).reset_index().rename(columns={"_k": "date"})
        return _records(g)

    # ── nested category hierarchy (no .xs(); 4 flat group-bys) ──
    def hierarchy(self, df, cap=60):
        if len(df) == 0 or not all(c in df.columns for c in HIER_LEVELS):
            return []

        def agg_levels(cols):
            return df.groupby(cols, observed=True).agg(
                orders=("_oid", "nunique"), lines=("_lid", "nunique"),
                qty=("qty", "sum"), revenue=("final_revenue", "sum"),
            ).reset_index()

        frames = [agg_levels(HIER_LEVELS[:i + 1]) for i in range(len(HIER_LEVELS))]
        # Index children frames by their parent-prefix tuple for O(1) lookup.
        child_index = []
        for d in range(1, len(HIER_LEVELS)):
            child_index.append({k: v for k, v in frames[d].groupby(HIER_LEVELS[:d], observed=True)})

        def make_nodes(rows, namecol, depth, prefix):
            total = rows["revenue"].sum()
            rows = rows.sort_values("revenue", ascending=False).head(cap)
            out = []
            for _, r in rows.iterrows():
                name = r[namecol]
                node = {"name": name, "orders": int(r["orders"]), "lines": int(r["lines"]),
                        "qty": float(r["qty"]), "revenue": float(r["revenue"]),
                        "asp": float(r["revenue"] / r["qty"]) if r["qty"] > 0 else 0.0,
                        "aov": float(r["revenue"] / r["orders"]) if r["orders"] else 0.0,
                        "revShare": float(r["revenue"] / total * 100) if total > 0 else 0.0}
                if depth + 1 < len(HIER_LEVELS):
                    key = (prefix + [name])
                    lookup = tuple(key) if len(key) > 1 else key[0]
                    sub = child_index[depth].get(lookup)
                    node["children"] = make_nodes(sub, HIER_LEVELS[depth + 1], depth + 1, key) if sub is not None else []
                out.append(node)
            return out
        return make_nodes(frames[0], HIER_LEVELS[0], 0, [])

    # ── SKU table (keyed by product_variant_id = SKU code) ──
    def sku_table(self, df, limit=500):
        if len(df) == 0 or "product_variant_id" not in df.columns:
            return []
        g = df.groupby("product_variant_id", observed=True).agg(
            orders=("_oid", "nunique"), lines=("_lid", "nunique"),
            qty=("qty", "sum"), revenue=("final_revenue", "sum"),
            product_variant_name=("product_variant_name", "first"),
            vco_sku_code=("vco_sku_code", "first"), sku_type=("sku_type", "first"),
            product_name=("product_name", "first"), parent_name=("parent_name", "first"),
            sub_cat_name=("sub_cat_name", "first"), vco_brand=("vco_brand", "first"),
            mrp=("_mrp", "first"), unit_price=("vco_unit_price", "first"),
        ).reset_index().rename(columns={"product_variant_id": "sku_code"})
        g = _enrich(g, g["revenue"].sum())
        g["discount"] = np.where(g["mrp"] > 0, (g["mrp"] - g["unit_price"]) / g["mrp"] * 100, 0.0)
        return _records(g.sort_values("revenue", ascending=False).head(limit))

    # ── pendency ──
    def pendency(self, df, table_limit=500):
        empty = {"count": 0, "avgDays": 0, "over7": 0, "over15": 0, "pendingRev": 0,
                 "pendingQty": 0, "aging": [], "byStatus": [], "byChannel": [], "byCat": [], "table": []}
        if len(df) == 0:
            return empty
        pdf = df[df["order_status_group"].isin(PENDING_STATUSES)].copy()
        if len(pdf) == 0:
            return empty
        anchor = pd.Timestamp(self.max_date) if self.max_date else pd.Timestamp.now().normalize()
        days = (anchor - pd.to_datetime(pdf["order_date"], errors="coerce")).dt.days.fillna(0).astype(int)
        pdf["pendencyDays"] = days.to_numpy()
        labels = ["0-3 days", "4-7 days", "8-15 days", "16-30 days", "30+ days"]
        buckets = pd.cut(days, bins=[-10**9, 3, 7, 15, 30, 10**9], labels=labels)
        aging = [{"name": l, "count": int((buckets == l).sum())} for l in labels]
        cols = [c for c in PENDENCY_TABLE_COLS if c in pdf.columns] + ["pendencyDays"]
        table = _records(pdf.sort_values("pendencyDays", ascending=False).head(table_limit)[cols])
        return {
            "count": int(len(pdf)), "avgDays": float(days.mean()),
            "over7": int((days > 7).sum()), "over15": int((days > 15).sum()),
            "pendingRev": float(pdf["final_revenue"].sum()), "pendingQty": float(pdf["qty"].sum()),
            "aging": aging,
            "byStatus": self.group(pdf, "order_status_group"),
            "byChannel": self.group(pdf, "vco_channel_name"),
            "byCat": self.group(pdf, "parent_name"),
            "table": table,
        }

    # ── top movers: last 30 days vs previous 30 days (within current filters) ──
    def movers(self, df, dim="parent_name", top=6):
        out = {"window": "", "up": [], "down": []}
        if not self.max_date or dim not in df.columns or len(df) == 0:
            return out
        end = pd.Timestamp(self.max_date)
        c_from = (end - pd.Timedelta(days=29)).strftime("%Y-%m-%d")
        p_to = (end - pd.Timedelta(days=30)).strftime("%Y-%m-%d")
        p_from = (end - pd.Timedelta(days=59)).strftime("%Y-%m-%d")
        od = df["order_date"]
        cg = df[od >= c_from].groupby(dim, observed=True)["final_revenue"].sum().to_dict()
        pg = df[(od >= p_from) & (od <= p_to)].groupby(dim, observed=True)["final_revenue"].sum().to_dict()
        rows = []
        for n in set(cg) | set(pg):
            c, p = float(cg.get(n, 0) or 0), float(pg.get(n, 0) or 0)
            if c == 0 and p == 0:
                continue
            delta_pct = ((c - p) / p * 100) if p > 0 else (100.0 if c > 0 else 0.0)
            rows.append({"name": str(n), "cur": c, "prev": p,
                         "deltaPct": delta_pct, "deltaAbs": c - p})
        out["window"] = f"{c_from} → {self.max_date}"
        out["up"] = sorted([r for r in rows if r["deltaAbs"] > 0], key=lambda r: r["deltaAbs"], reverse=True)[:top]
        out["down"] = sorted([r for r in rows if r["deltaAbs"] < 0], key=lambda r: r["deltaAbs"])[:top]
        return out

    # ── coupon analytics: performance + success/fail + top SKU per coupon ──
    def coupon_analysis(self, df, top=40):
        out = {"coupons": [], "couponSku": []}
        if "coupon_code" not in df.columns or len(df) == 0:
            return out
        used = df[df["coupon_code"].astype("string").fillna("Unknown").ne("Unknown")
                  & df["coupon_code"].astype("string").ne("")]
        if len(used) == 0:
            return out
        base = used.groupby("coupon_code", observed=True).agg(
            orders=("_oid", "nunique"), lines=("_lid", "nunique"),
            qty=("qty", "sum"), revenue=("final_revenue", "sum"),
        )
        succ = used[used["_succ"]].groupby("coupon_code", observed=True)["_oid"].nunique()
        base["successOrders"] = succ.reindex(base.index).fillna(0).astype(int)
        base["failOrders"] = (base["orders"] - base["successOrders"]).clip(lower=0)
        base["successRate"] = (base["successOrders"] / base["orders"] * 100).where(base["orders"] > 0, 0)
        base = base.reset_index().rename(columns={"coupon_code": "coupon"})
        base = base.sort_values("revenue", ascending=False).head(top)
        out["coupons"] = _records(base)
        # Top coupon × SKU combinations by revenue
        cs = used.groupby(["coupon_code", "product_variant_name"], observed=True).agg(
            orders=("_oid", "nunique"), qty=("qty", "sum"), revenue=("final_revenue", "sum"),
        ).reset_index().rename(columns={"coupon_code": "coupon", "product_variant_name": "sku"})
        cs = cs.sort_values("revenue", ascending=False).head(40)
        out["couponSku"] = _records(cs)
        return out

    # ── full bundle ──
    def summarize(self, filters):
        df = self._sub(filters)
        by = {k: self.group(df, col, limit=(1000 if k == "coupon" else None))
              for k, col in DIM_COLS.items()}
        return {
            "meta": {"filteredRows": int(len(df)), "totalRows": self.n,
                     "minDate": self.min_date, "maxDate": self.max_date},
            "metrics": self.metrics(df),
            "by": by,
            "date": {g: self.by_date(df, g) for g in ("day", "week", "month")},
            "hierarchy": self.hierarchy(df),
            "sku": self.sku_table(df),
            "pendency": self.pendency(df),
            "movers": {
                "category": self.movers(df, "parent_name"),
                "channel": self.movers(df, "vco_channel_name"),
                "state": self.movers(df, "state"),
                "sku": self.movers(df, "product_variant_name"),
            },
            "couponStats": self.coupon_analysis(df),
        }

    # ── full filtered export (CSV of ALL matching rows) ──
    def export_csv(self, filters, search=""):
        sub = self._sub(filters)
        if search:
            s = search.lower()
            m = np.zeros(len(sub), dtype=bool)
            for c in ["vco_external_order_number", "vco_customer_name", "product_name", "vco_sku_code"]:
                if c in sub.columns:
                    m |= sub[c].astype("string").str.lower().str.contains(s, na=False).to_numpy()
            sub = sub[m]
        sub = sub.drop(columns=["_mrp", "_oid", "_lid", "_succ"], errors="ignore")
        return sub.to_csv(index=False)

    # ── paginated raw rows ──
    def rows_page(self, filters, offset=0, limit=200, search=""):
        sub = self._sub(filters)
        if search:
            s = search.lower()
            m = np.zeros(len(sub), dtype=bool)
            for c in ["vco_external_order_number", "vco_customer_name", "product_name", "vco_sku_code"]:
                if c in sub.columns:
                    m |= sub[c].astype("string").str.lower().str.contains(s, na=False).to_numpy()
            sub = sub[m]
        total = int(len(sub))
        page = sub.iloc[offset:offset + limit].drop(columns=["_mrp", "_oid", "_lid", "_succ"], errors="ignore")
        return {"rows": _records(page), "total": total, "offset": offset, "limit": limit}
