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
  const [matTypes, setMatTypes] = useState([]);
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
        setMatTypes(res.materialTypes || []);
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

  // Totals for the material-type table. Every column here is additive — qty
  // and revenue are component-level sums — so unlike the order-level version
  // this total is simply the column sum and reconciles with the KPI cards.
  const matTotal = useMemo(() => {
    if (!matTypes.length) return null;
    const qty = matTypes.reduce((a, r) => a + (r.qty || 0), 0);
    const revenue = matTypes.reduce((a, r) => a + (r.revenue || 0), 0);
    return { name: 'Total', qty, revenue, revSharePct: 100, asp: qty > 0 ? revenue / qty : 0 };
  }, [matTypes]);

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

      {/* Material type at COMPONENT level: qty and revenue after the bundle
          split, rolled up server-side across every component (not just the
          2,000 rendered below). Totals reconcile with the KPI cards. */}
      {matTypes.length > 0 && (
        <DataTable
          title="🧱 Product Material Type — component qty & revenue"
          data={matTypes}
          searchable={false}
          columns={[
            { key:'name',        label:'Material Type', bold:true, w:240 },
            { key:'qty',         label:'Qty',       right:true, render:v=>Math.round(v||0).toLocaleString('en-IN') },
            { key:'revenue',     label:'Revenue',   right:true, render:v=>fmt(v) },
            { key:'revSharePct', label:'Revenue %', right:true, render:v=>`${(v||0).toFixed(1)}%` },
            { key:'asp',         label:'ASP',       right:true, render:v=>fmt(v) },
          ]}
          footer={matTotal}
          filename="material_type_component_summary"
          maxH={420}
        />
      )}

      <DataTable
        title="Component-Level Summary"
        data={rows}
        searchKeys={['component_product_variant_id','title_component','channel']}
        searchPlaceholder="Search component id, name or channel…"
        onExport={() => downloadSummaryCsv({ kind:'components', filters, name:'component_summary' })}
        exportLabel="Export all components"
        columns={[
          { key:'component_product_variant_id', label:'Component ID', bold:true, w:230 },
          { key:'title_component', label:'Component Name', w:300, maxW:300, wrap:true },
          { key:'component_product_type', label:'Type', w:90 },
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
