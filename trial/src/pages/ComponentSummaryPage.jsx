import React, { useState, useEffect, useMemo, useRef } from 'react';
import { BarChart, Bar, Cell, ResponsiveContainer, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import { KPI, KPIGrid, Card, DataTable, InsightBar } from '../components/UI';
import { fetchComponents, downloadSummaryCsv, fmt, fmtCr, pct, full, fullMoney, COLORS } from '../utils/dataEngine';

const TT = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:8, padding:'10px 14px', fontSize:11, boxShadow:'var(--shadow2)' }}>
    <div style={{ color:'var(--accent)', fontWeight:700, marginBottom:5 }}>{label}</div>
    {payload.map((p,i) => <div key={i} style={{ color:p.color||'var(--text)' }}>{p.name}: <b>{p.name?.toLowerCase().includes('sale')?fmt(p.value):p.value?.toLocaleString()}</b></div>)}
  </div>;
};

export default function ComponentSummaryPage({ data, filters }) {
  const [rows, setRows] = useState([]);
  const [srvTotals, setSrvTotals] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const reqId = useRef(0);

  // Re-fetch whenever the global filters change.
  useEffect(() => {
    const my = ++reqId.current;
    setLoading(true); setError(null);
    fetchComponents(filters)
      .then(res => {
        if (my !== reqId.current) return;
        setRows(res.components || []);
        setSrvTotals(res.totals || null);
        setLoading(false);
      })
      .catch(err => { if (my === reqId.current) { setError(err.message || String(err)); setLoading(false); } });
  }, [filters]);

  // Headline figures come from the SERVER, computed over every component.
  // `rows` is only the top slice the table renders, so summing it understated
  // component sales by the whole tail and no longer tied to SKU-level revenue.
  const totals = useMemo(() => {
    if (srvTotals) {
      return { sales: srvTotals.sales, qty: srvTotals.qty,
               count: srvTotals.components, asp: srvTotals.asp,
               shown: srvTotals.shown };
    }
    const sales = rows.reduce((s, r) => s + (r.sales_component || 0), 0);
    const qty = rows.reduce((s, r) => s + (r.qty_component || 0), 0);
    return { sales, qty, count: rows.length, asp: qty ? sales / qty : 0, shown: rows.length };
  }, [rows, srvTotals]);

  const top = rows.slice(0, 12).map(r => ({ ...r, short: (r.title_component || r.component_sku_code || '').slice(0, 26) }));

  if (loading) {
    return <div style={{ padding:40, textAlign:'center', color:'var(--text3)' }}>Computing component-level summary…</div>;
  }
  if (error) {
    return <div style={{ padding:40, textAlign:'center', color:'var(--red)' }}>Could not load components — {error}</div>;
  }
  if (!rows.length) {
    return <div style={{ padding:40, textAlign:'center', color:'var(--text3)' }}>No component data for the current filters.</div>;
  }

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
      <InsightBar items={[
        { icon:'🧩', value:totals.count.toLocaleString(), label:'distinct components' },
        { icon:'📦', value:Math.round(totals.qty).toLocaleString(), label:'component units' },
        { icon:'💰', value:fmtCr(totals.sales), label:'component sales' },
        top[0] && { icon:'🏆', value:(top[0].title_component || top[0].component_sku_code || '').slice(0,24), label:`top component · ${fmt(top[0].sales_component)}` },
      ]}/>

      <KPIGrid cols={4}>
        <KPI icon="🧩" label="Components"      value={totals.count.toLocaleString()}
             sub={totals.shown < totals.count ? `top ${totals.shown.toLocaleString()} listed below` : 'distinct SKUs'}
             exact={full(totals.count)} color="#7c3aed"/>
        <KPI icon="📦" label="Component Units" value={Math.round(totals.qty).toLocaleString()}  sub="qty after bundle split" exact={full(totals.qty)} color="#2563eb"/>
        <KPI icon="💰" label="Component Sales" value={fmtCr(totals.sales)}                       sub="all components · ties to SKU revenue" exact={fullMoney(totals.sales)} color="#16a34a"/>
        <KPI icon="🏷️" label="Blended ASP"     value={fmt(totals.asp)}                           sub="sales ÷ units" exact={fullMoney(totals.asp)} color="#d97706"/>
      </KPIGrid>

      <DataTable
        title="Component-Level Summary"
        data={rows}
        searchKeys={['component_product_variant_id','title_component','component_sku_code',
                     'study_material_type','parent_name','sub_cat_name','sub_sub_cat_name','channel']}
        searchPlaceholder="Search component id, name, SKU, material type, category…"
        onExport={() => downloadSummaryCsv({ kind:'components', filters, name:'component_summary' })}
        exportLabel="Export all components"
        columns={[
          { key:'component_product_variant_id', label:'Component ID', bold:true, w:230 },
          { key:'title_component', label:'Component Name', w:300, maxW:300, wrap:true },
          { key:'component_sku_code', label:'SKU Code', w:140 },
          { key:'component_product_type', label:'Type', w:90 },
          // Dimensions from the component-level query: the component's own study
          // material type, plus the category hierarchy / channel it sells most through.
          { key:'study_material_type', label:'Study Material Type', w:170 },
          { key:'parent_name', label:'Category', w:150 },
          { key:'sub_cat_name', label:'Sub Cat', w:140 },
          { key:'sub_sub_cat_name', label:'Sub Sub Cat', w:150 },
          { key:'channel', label:'Channel', w:120 },
          { key:'qty_component', label:'Qty', right:true, render:v=>Math.round(v).toLocaleString() },
          { key:'sales_component', label:'Sales', right:true, render:v=>fmt(v) },
          { key:'saleSharePct', label:'Sales %', right:true, render:v=>`${(v||0).toFixed(1)}%` },
          { key:'asp', label:'ASP', right:true, render:v=>fmt(v) },
        ]}
        filename="component_summary"
        maxH={620}
      />
    </div>
  );
}
