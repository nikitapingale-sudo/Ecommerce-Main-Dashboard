import React, { useState, useEffect, useMemo, useRef } from 'react';
import { BarChart, Bar, Cell, ResponsiveContainer, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import { KPI, KPIGrid, Card, DataTable, InsightBar } from '../components/UI';
import { fetchComponents, downloadSummaryCsv, fmt, fmtCr, pct, COLORS } from '../utils/dataEngine';

const TT = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:8, padding:'10px 14px', fontSize:11, boxShadow:'var(--shadow2)' }}>
    <div style={{ color:'var(--accent)', fontWeight:700, marginBottom:5 }}>{label}</div>
    {payload.map((p,i) => <div key={i} style={{ color:p.color||'var(--text)' }}>{p.name}: <b>{p.name?.toLowerCase().includes('sale')?fmt(p.value):p.value?.toLocaleString()}</b></div>)}
  </div>;
};

export default function ComponentSummaryPage({ data, filters }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const reqId = useRef(0);

  // Re-fetch whenever the global filters change.
  useEffect(() => {
    const my = ++reqId.current;
    setLoading(true); setError(null);
    fetchComponents(filters)
      .then(res => { if (my === reqId.current) { setRows(res.components || []); setLoading(false); } })
      .catch(err => { if (my === reqId.current) { setError(err.message || String(err)); setLoading(false); } });
  }, [filters]);

  const totals = useMemo(() => {
    const sales = rows.reduce((s, r) => s + (r.sales_component || 0), 0);
    const qty = rows.reduce((s, r) => s + (r.qty_component || 0), 0);
    return { sales, qty, count: rows.length, asp: qty ? sales / qty : 0 };
  }, [rows]);

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
        <KPI icon="🧩" label="Components"      value={totals.count.toLocaleString()}            sub="distinct SKUs" color="#7c3aed"/>
        <KPI icon="📦" label="Component Units" value={Math.round(totals.qty).toLocaleString()}  sub="qty after bundle split" color="#2563eb"/>
        <KPI icon="💰" label="Component Sales" value={fmtCr(totals.sales)}                       sub="MRP-weighted split" color="#16a34a"/>
        <KPI icon="🏷️" label="Blended ASP"     value={fmt(totals.asp)}                           sub="sales ÷ units" color="#d97706"/>
      </KPIGrid>

      <Card title="🧩 Top Components by Sales" subtitle="Bundle revenue split across components by MRP ratio" height={300}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={top} layout="vertical" margin={{ left:4, right:60, top:0, bottom:0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--grid)" horizontal={false}/>
            <XAxis type="number" tick={{ fill:'var(--text3)', fontSize:10 }} tickLine={false} axisLine={false} tickFormatter={fmtCr}/>
            <YAxis type="category" dataKey="short" tick={{ fill:'var(--text2)', fontSize:10 }} width={170} tickLine={false} axisLine={false}/>
            <Tooltip content={<TT/>}/>
            <Bar dataKey="sales_component" name="Sales" radius={[0,3,3,0]}>
              {top.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]}/>)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </Card>

      <DataTable
        title="Component-Level Summary"
        data={rows}
        searchKeys={['component_product_variant_id','title_component','component_sku_code']}
        searchPlaceholder="Search component id, name, SKU…"
        onExport={() => downloadSummaryCsv({ kind:'components', filters, name:'component_summary' })}
        exportLabel="Export all components"
        columns={[
          { key:'component_product_variant_id', label:'Component ID', bold:true, w:230 },
          { key:'title_component', label:'Component Name', w:300, maxW:300, wrap:true },
          { key:'component_sku_code', label:'SKU Code', w:140 },
          { key:'component_product_type', label:'Type', w:90 },
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
