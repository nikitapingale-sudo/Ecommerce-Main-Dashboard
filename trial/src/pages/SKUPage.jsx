import React, { useMemo } from 'react';
import { DataTable, SectionLabel, InsightBar, MoversCard } from '../components/UI';
import { fmt, fmtN, pct, COLORS, downloadSummaryCsv } from '../utils/dataEngine';

export default function SKUPage({ data, filters }) {
  // Top SKUs come pre-aggregated from the server (sorted by revenue).
  // SKU identity = product_variant_id (SKU Code); vco_sku_code is the WMS code.
  const skuData = useMemo(() => (data && data.sku) || [], [data]);

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

      <MoversCard title="🚀 Top Movers — SKUs" movers={data.movers && data.movers.sku}/>

      <DataTable
        title="SKU-Level Performance"
        data={skuData}
        searchKeys={['sku_code','vco_sku_code','product_name','product_variant_name','parent_name','sub_cat_name','vco_brand']}
        searchPlaceholder="Search SKU code, name, brand, category…"
        onExport={() => downloadSummaryCsv({ kind:'sku', filters, name:'sku_summary' })}
        exportLabel="Export all SKUs"
        columns={[
          { key:'sku_code', label:'SKU Code', bold:true, w:230 },
          { key:'product_variant_name', label:'SKU Name', w:340, maxW:340, wrap:true },
          { key:'vco_sku_code', label:'WMS SKU', w:130 },
          { key:'sku_type', label:'SKU Type', w:90 },
          { key:'parent_name', label:'Category', w:150 },
          { key:'sub_cat_name', label:'Sub Cat', w:140 },
          { key:'vco_brand', label:'Brand', w:70 },
          { key:'orders', label:'Orders', right:true },
          { key:'lines', label:'Lines', right:true },
          { key:'qty', label:'Qty', right:true },
          { key:'revenue', label:'Revenue', right:true, render:v=>fmt(v) },
          { key:'revShare', label:'Rev %', right:true, render:v=>`${v.toFixed(1)}%` },
          { key:'asp', label:'ASP', right:true, render:v=>fmt(v) },
          { key:'aov', label:'AOV', right:true, render:v=>fmt(v) },
          { key:'mrp', label:'MRP', right:true, render:v=>fmt(v) },
          { key:'discount', label:'Disc%', right:true, render:v=>`${v.toFixed(1)}%` },
        ]}
        filename="sku_performance"
        maxH={620}
      />
    </div>
  );
}
