import React, { useMemo } from 'react';
import { DataTable, SectionLabel, InsightBar, KPI, KPIGrid } from '../components/UI';
import { metrics, fmt, fmtCr, fmtN, pct, full, fullMoney, COLORS, downloadSummaryCsv } from '../utils/dataEngine';

/* Plain grouped integer — counts on this page are read as exact figures,
   so they are not abbreviated to K. */
const num = (n) => Math.round(Number(n) || 0).toLocaleString('en-IN');

export default function SKUPage({ data, filters }) {
  // Top SKUs come pre-aggregated from the server (sorted by revenue).
  // SKU identity = product_variant_id (SKU Code); vco_sku_code is the WMS code.
  const skuData = useMemo(() => (data && data.sku) || [], [data]);

  // Headline figures come from the SERVER metrics, which cover EVERY row in the
  // current filter — not from skuData, which is only the top slice the table
  // renders. Summing the visible rows would understate every card.
  const m = useMemo(() => metrics(data), [data]);
  const skuTotal = (data && data.meta && data.meta.skuTotal) || skuData.length;

  // Pareto: top-10 share + how many SKUs make up 80% of revenue.
  const pareto = useMemo(() => {
    const tot = (data.metrics && data.metrics.rev) || skuData.reduce((a, s) => a + (s.revenue || 0), 0) || 1;
    const top10 = skuData.slice(0, 10).reduce((a, s) => a + (s.revenue || 0), 0) / tot * 100;
    let cum = 0, n = 0;
    for (const s of skuData) { cum += s.revenue || 0; n++; if (cum / tot >= 0.8) break; }
    return { top10: top10, n80: n };
  }, [skuData, data]);

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:18 }}>
      <InsightBar items={[
        { icon:'📊', value:pct(pareto.top10), label:'revenue from top 10 SKUs', tone:'good' },
        { icon:'🎯', value:`~${pareto.n80}`, label:'SKUs drive 80% of revenue' },
        skuData[0] && { icon:'🏷️', value:(skuData[0].product_variant_name || skuData[0].sku_code || '').slice(0,28), label:`top SKU · ${fmt(skuData[0].revenue)}` },
      ]}/>

      <KPIGrid cols={4}>
        {/* Counts in full, not abbreviated — these are read as exact figures. */}
        <KPI icon="🗂️" label="Orders"        value={num(m.orders)}
             sub={`${num(m.lines)} line items`} exact={full(m.orders)}   color="var(--series-1)"/>
        {/* One revenue card. Gross is the headline because it is what the
            Revenue column in the table below sums to; the realised figure
            rides along as the sub-line rather than a second card. */}
        <KPI icon="💰" label="Revenue"       value={fmtCr(m.rev)}
             sub={`final ${fmtCr(m.netRevenue)} · ${pct(m.netRevPct)} of gross`}
             exact={`gross ${fullMoney(m.rev)}\nfinal ${fullMoney(m.netRevenue)}`}
             color="var(--series-3)"/>
        <KPI icon="📦" label="Qty"           value={num(m.qty)}
             sub={`${(m.aul || 0).toFixed(1)} units / order`} exact={full(m.qty)} color="var(--series-7)"/>
        {/* Count comes from the server and covers every matching row; skuData
            is only the top slice the table renders, so its length is just the
            cap. */}
        <KPI icon="🔖" label="Distinct SKUs" value={num(skuTotal)}
             sub={skuData.length < skuTotal ? `top ${num(skuData.length)} listed below` : 'all listed below'}
             color="var(--series-5)"/>
      </KPIGrid>

      <KPIGrid cols={3}>
        <KPI icon="🏷️" label="ASP"           value={fmt(m.asp)}
             sub="revenue ÷ qty" exact={fullMoney(m.asp)}                color="var(--series-2)"/>
        <KPI icon="🧾" label="AOV"           value={fmt(m.aov)}
             sub="revenue ÷ orders" exact={fullMoney(m.aov)}             color="var(--series-4)"/>
      </KPIGrid>

      <DataTable
        title="SKU-Level Performance"
        data={skuData}
        searchKeys={['sku_code','product_variant_name']}
        searchPlaceholder="Search SKU code or name…"
        onExport={() => downloadSummaryCsv({ kind:'sku', filters, name:'sku_summary' })}
        exportLabel="Export all SKUs"
        columns={[
          { key:'sku_code', label:'SKU Code', bold:true, w:230 },
          { key:'product_variant_name', label:'SKU Name', w:340, maxW:340, wrap:true },
          { key:'orders', label:'Orders', right:true },
          { key:'lines', label:'Lines', right:true },
          { key:'qty', label:'Qty', right:true },
          { key:'revenue', label:'Revenue', right:true, render:v=>fmt(v) },
          { key:'revShare', label:'Rev %', right:true, render:v=>`${v.toFixed(1)}%` },
          { key:'asp', label:'ASP', right:true, render:v=>fmt(v) },
          { key:'aov', label:'AOV', right:true, render:v=>fmt(v) },
          { key:'mrp', label:'MRP', right:true, render:v=>fmt(v) },
        ]}
        filename="sku_performance"
        maxH={620}
      />
    </div>
  );
}
