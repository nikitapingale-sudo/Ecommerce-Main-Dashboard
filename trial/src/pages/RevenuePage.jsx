import React, { useMemo, useState } from 'react';
import { AreaChart, Area, BarChart, Bar, ComposedChart, Line, Cell, ResponsiveContainer, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine } from 'recharts';
import { KPI, KPIGrid, Card, DataTable, SectionLabel, InsightBar } from '../components/UI';
import { metrics, groupArr, groupByDate, fmt, fmtN, fmtCr, pct, COLORS } from '../utils/dataEngine';

const TT = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:8, padding:'10px 14px', fontSize:11, boxShadow:'var(--shadow2)' }}>
    <div style={{ color:'var(--accent)', fontWeight:700, marginBottom:5 }}>{label}</div>
    {payload.map((p,i) => <div key={i} style={{ color:p.color||'var(--text)', marginBottom:2 }}>{p.name}: <b>{['rev','mrp','asp','aov'].some(k=>p.name?.toLowerCase().includes(k))?fmt(p.value):p.value?.toLocaleString()}</b></div>)}
  </div>;
};

const COLS = [
  { key:'name',     label:'Name',    bold:true },
  { key:'orders',   label:'Orders',  right:true },
  { key:'lines',    label:'Lines',   right:true },
  { key:'qty',      label:'Qty',     right:true },
  { key:'revenue',  label:'Revenue', right:true, render:v=>fmt(v) },
  { key:'revShare', label:'Rev %',   right:true, render:v=>`${v.toFixed(1)}%` },
  { key:'aov',      label:'AOV',     right:true, render:v=>fmt(v) },
  { key:'asp',      label:'ASP',     right:true, render:v=>fmt(v) },
];

export default function RevenuePage({ data }) {
  const [gran, setGran] = useState('day');
  const m        = useMemo(() => metrics(data), [data]);
  const trend    = useMemo(() => groupByDate(data, gran), [data, gran]);
  const wowRev = useMemo(() => {
    const d = groupByDate(data, 'day');
    if (d.length < 14) return undefined;
    const sum = a => a.reduce((s, r) => s + (r.revenue || 0), 0);
    const p = sum(d.slice(-14, -7));
    return p ? (sum(d.slice(-7)) - p) / p * 100 : undefined;
  }, [data]);
  const dodData  = useMemo(() => {
    const d = groupByDate(data,'day');
    return d.map((r,i) => ({ ...r, revChg: i>0?((r.revenue-d[i-1].revenue)/(d[i-1].revenue||1))*100:0, ordChg: i>0?((r.orders-d[i-1].orders)/(d[i-1].orders||1))*100:0 }));
  }, [data]);

  const byChan   = useMemo(() => groupArr(data, 'vco_channel_name'), [data]);
  const byCat    = useMemo(() => groupArr(data, 'parent_name'), [data]);
  const byPay    = useMemo(() => groupArr(data, 'payment_sources'), [data]);
  const byFin    = useMemo(() => groupArr(data, 'finance_exam_category'), [data]);
  const byOC     = useMemo(() => groupArr(data, 'order_category'), [data]);
  const monthly  = useMemo(() => groupByDate(data,'month'), [data]);

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
      <InsightBar items={[
        { icon:'💰', value:fmtCr(m.rev), label:'gross revenue' },
        wowRev !== undefined && { icon:'📈', value:`${wowRev>=0?'+':''}${wowRev.toFixed(0)}%`, label:'WoW', tone: wowRev>=0?'good':'bad' },
        { icon:'💸', value:pct(m.discPct), label:'avg discount' },
        byCat[0] && { icon:'📚', value:byCat[0].name, label:`top category · ${pct(byCat[0].revShare)}` },
        byChan[0] && { icon:'📡', value:byChan[0].name, label:'top channel' },
      ]}/>
      <KPIGrid cols={4}>
        <KPI icon="💰" label="Gross Revenue"    value={fmtCr(m.rev)}        sub={`AOV ${fmt(m.aov)}`}  color="#16a34a" trend={wowRev}/>
        <KPI icon="🚚" label="Shipping Charges" value={fmtCr(m.delCharges)} sub="Collected"            color="#7c3aed"/>
        <KPI icon="💲" label="ASP / Unit"       value={fmt(m.asp)}        sub="Avg selling price"    color="#2563eb"/>
        <KPI icon="🛒" label="AOV"              value={fmt(m.aov)}        sub="Avg order value"      color="#0891b2"/>
      </KPIGrid>

      <Card title="Revenue Trend" height={230}
        right={
          <div style={{ display:'flex', gap:4 }}>
            {['day','week','month'].map(g=>(
              <button key={g} onClick={()=>setGran(g)} style={{ padding:'3px 10px', borderRadius:5, fontSize:10, fontWeight:700, background:gran===g?'var(--accent)':'var(--surface2)', color:gran===g?'#fff':'var(--text2)', border:'1px solid var(--border)' }}>{g.charAt(0).toUpperCase()+g.slice(1)}</button>
            ))}
          </div>
        }>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={trend} margin={{ top:4, right:8, bottom:0, left:8 }}>
            <defs><linearGradient id="revg" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#059669" stopOpacity={0.2}/><stop offset="95%" stopColor="#059669" stopOpacity={0}/></linearGradient></defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--grid)" vertical={false}/>
            <XAxis dataKey="date" tick={{ fill:'var(--text3)', fontSize:10 }} tickLine={false} axisLine={false}/>
            <YAxis tick={{ fill:'var(--text3)', fontSize:10 }} tickLine={false} axisLine={false} width={90} tickFormatter={fmtCr}/>
            <Tooltip content={<TT/>}/>
            <Area type="monotone" dataKey="revenue" name="Revenue" stroke="#059669" strokeWidth={2} fill="url(#revg)" dot={false}/>
          </AreaChart>
        </ResponsiveContainer>
      </Card>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
        <Card title="Day-on-Day Orders (% change)" height={200}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={dodData.slice(-30)} margin={{ top:4, right:35, bottom:0, left:0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--grid)" vertical={false}/>
              <XAxis dataKey="date" tick={{ fill:'var(--text3)', fontSize:9 }} tickLine={false} axisLine={false}/>
              <YAxis yAxisId="l" tick={{ fill:'var(--text3)', fontSize:10 }} tickLine={false} axisLine={false} width={30}/>
              <YAxis yAxisId="r" orientation="right" tick={{ fill:'var(--text3)', fontSize:10 }} tickLine={false} axisLine={false} tickFormatter={v=>`${v.toFixed(0)}%`} width={35}/>
              <Tooltip content={<TT/>}/>
              <Bar yAxisId="l" dataKey="orders" name="Orders" fill="#4f46e5" opacity={0.8} radius={[2,2,0,0]}/>
              <Line yAxisId="r" type="monotone" dataKey="ordChg" name="DoD %" stroke="#d97706" strokeWidth={2} dot={false}/>
              <ReferenceLine yAxisId="r" y={0} stroke="var(--grid)"/>
            </ComposedChart>
          </ResponsiveContainer>
        </Card>
        <Card title="Day-on-Day Revenue (% change)" height={200}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={dodData.slice(-30)} margin={{ top:4, right:35, bottom:0, left:8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--grid)" vertical={false}/>
              <XAxis dataKey="date" tick={{ fill:'var(--text3)', fontSize:9 }} tickLine={false} axisLine={false}/>
              <YAxis yAxisId="l" tick={{ fill:'var(--text3)', fontSize:10 }} tickLine={false} axisLine={false} width={90} tickFormatter={fmtCr}/>
              <YAxis yAxisId="r" orientation="right" tick={{ fill:'var(--text3)', fontSize:10 }} tickLine={false} axisLine={false} tickFormatter={v=>`${v.toFixed(0)}%`} width={35}/>
              <Tooltip content={<TT/>}/>
              <Bar yAxisId="l" dataKey="revenue" name="Revenue" fill="#059669" opacity={0.8} radius={[2,2,0,0]}/>
              <Line yAxisId="r" type="monotone" dataKey="revChg" name="DoD %" stroke="#dc2626" strokeWidth={2} dot={false}/>
              <ReferenceLine yAxisId="r" y={0} stroke="var(--grid)"/>
            </ComposedChart>
          </ResponsiveContainer>
        </Card>
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
        <Card title="Monthly Revenue" height={190}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={monthly} margin={{ top:4, right:8, bottom:0, left:8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--grid)" vertical={false}/>
              <XAxis dataKey="date" tick={{ fill:'var(--text3)', fontSize:10 }} tickLine={false} axisLine={false}/>
              <YAxis tick={{ fill:'var(--text3)', fontSize:10 }} tickLine={false} axisLine={false} width={90} tickFormatter={fmtCr}/>
              <Tooltip content={<TT/>}/>
              <Bar dataKey="revenue" name="Revenue" fill="#4f46e5" radius={[4,4,0,0]}/>
            </BarChart>
          </ResponsiveContainer>
        </Card>
        <Card title="Revenue by Channel" height={190}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={byChan} layout="vertical" margin={{ left:4, right:60, top:0, bottom:0 }}>
              <XAxis type="number" tick={{ fill:'var(--text3)', fontSize:10 }} tickLine={false} axisLine={false} tickFormatter={fmtCr}/>
              <YAxis type="category" dataKey="name" tick={{ fill:'var(--text2)', fontSize:10 }} width={90} tickLine={false} axisLine={false}/>
              <Tooltip content={<TT/>}/>
              <Bar dataKey="revenue" name="Revenue" radius={[0,3,3,0]}>
                {byChan.map((_,i)=><Cell key={i} fill={COLORS[i%COLORS.length]}/>)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Card>
      </div>

      <DataTable title="Revenue by Channel"          data={byChan}  columns={COLS} filename="rev_channel"/>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
        <DataTable title="Revenue by Finance Category" data={byFin} columns={COLS} filename="rev_fin_cat"/>
        <DataTable title="Revenue by Order Category"   data={byOC}  columns={COLS} filename="rev_order_cat"/>
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
        <DataTable title="Revenue by Payment Mode"  data={byPay}  columns={COLS} filename="rev_payment"/>
        <DataTable title="Revenue by Category"      data={byCat}  columns={COLS} filename="rev_category"/>
      </div>
    </div>
  );
}
