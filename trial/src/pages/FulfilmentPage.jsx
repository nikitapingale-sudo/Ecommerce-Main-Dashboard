import React, { useMemo, useState, useEffect } from 'react';
import { BarChart, Bar, Cell, ResponsiveContainer, XAxis, YAxis, CartesianGrid, Tooltip, PieChart, Pie, Legend } from 'recharts';
import { KPI, KPIGrid, Card, FunnelBar, DataTable, SectionLabel, Pill, InsightBar } from '../components/UI';
import { metrics, groupArr, groupByDate, fetchSummary, fmt, fmtN, pct, STATUS_COLOR, ITEM_STATUS_COLOR, COLORS } from '../utils/dataEngine';

const statusCols = (colorMap) => [
  { key:'name', label:'Status', render:(v)=><Pill color={colorMap[v]||'#64748b'}>{v}</Pill> },
  { key:'orders', label:'Orders', right:true },
  { key:'lines', label:'Lines', right:true },
  { key:'qty', label:'Qty', right:true },
  { key:'revenue', label:'Revenue', right:true, render:v=>fmt(v) },
  { key:'revShare', label:'Rev %', right:true, render:v=>`${v.toFixed(1)}%` },
];

const TT = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:8, padding:'10px 14px', fontSize:11, boxShadow:'var(--shadow2)' }}>
    <div style={{ color:'var(--accent)', fontWeight:700, marginBottom:5 }}>{label}</div>
    {payload.map((p,i) => <div key={i} style={{ color:p.color||'var(--text)', marginBottom:2 }}>{p.name}: <b>{p.value?.toLocaleString()}</b></div>)}
  </div>;
};

const COLS = [
  { key:'name',     label:'Status',  bold:true },
  { key:'orders',   label:'Orders',  right:true },
  { key:'lines',    label:'Lines',   right:true },
  { key:'qty',      label:'Qty',     right:true },
  { key:'revenue',  label:'Revenue', right:true, render:v=>fmt(v) },
  { key:'revShare', label:'Rev %',   right:true, render:v=>`${v.toFixed(1)}%` },
];

export default function FulfilmentPage({ data, filters }) {
  const [drillStatus, setDrillStatus] = useState(null);
  const m              = useMemo(() => metrics(data), [data]);
  const byOrderStatus  = useMemo(() => groupArr(data, 'order_status_group'), [data]);
  const byItemStatus   = useMemo(() => groupArr(data, 'item_status_group'), [data]);
  const byCourier      = useMemo(() => groupArr(data, 'delivery_partner'), [data]);
  const byWarehouse    = useMemo(() => groupArr(data, 'warehouse'), [data]);
  const weekly         = useMemo(() => groupByDate(data,'week'), [data]);
  const monthly        = useMemo(() => groupByDate(data,'month'), [data]);

  // Drill — fetch a status-scoped bundle from the server.
  const [drillBundle, setDrillBundle] = useState(null);
  useEffect(() => {
    if (!drillStatus) { setDrillBundle(null); return; }
    let alive = true;
    fetchSummary({ ...filters, statuses: [drillStatus] })
      .then(b => { if (alive) setDrillBundle(b); }).catch(() => {});
    return () => { alive = false; };
  }, [drillStatus, filters]);
  const dm = metrics(drillBundle || data);

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:20 }}>
      <InsightBar items={[
        { icon:'✅', value:pct(m.delivRate), label:'delivery rate', tone: m.delivRate>=60?'good':'bad' },
        { icon:'🔁', value:pct(m.rtoRate), label:'RTO rate', tone: m.rtoRate>8?'bad':'good' },
        { icon:'❌', value:pct(m.cancelRate), label:'cancel rate', tone: m.cancelRate>15?'bad':'neutral' },
        { icon:'🚚', value:m.inTransit.toLocaleString(), label:'in transit' },
        { icon:'📥', value:m.received.toLocaleString(), label:'awaiting processing' },
      ]}/>
      <div>
        <SectionLabel>Fulfilment KPIs</SectionLabel>
        <KPIGrid cols={3}>
          <KPI icon="✅" label="Delivery Rate"  value={pct(m.delivRate)}
               sub={m.delivRate >= 60 ? `✓ on target · ${m.delivered.toLocaleString()} delivered` : `⚠ below 60% target`}
               color={m.delivRate >= 60 ? '#16a34a' : m.delivRate >= 45 ? '#d97706' : '#e11d48'}/>
          <KPI icon="🔁" label="RTO Rate"       value={pct(m.rtoRate)}
               sub={m.rtoRate > 8 ? `⚠ above 8% · ${m.rto.toLocaleString()} RTOs` : `✓ ${m.rto.toLocaleString()} RTOs`}
               color={m.rtoRate > 8 ? '#e11d48' : '#16a34a'}/>
          <KPI icon="❌" label="Cancel Rate"    value={pct(m.cancelRate)}
               sub={m.cancelRate > 15 ? `⚠ high · ${m.cancelled.toLocaleString()} cancelled` : `${m.cancelled.toLocaleString()} cancelled`}
               color={m.cancelRate > 15 ? '#e11d48' : '#ea580c'}/>
          <KPI icon="🚚" label="In Transit"     value={m.inTransit.toLocaleString()}       sub={pct(m.inTransit/m.orders*100)}      color="#2563eb"/>
          <KPI icon="📦" label="Packed"         value={m.packed.toLocaleString()}          sub={pct(m.packed/m.orders*100)}         color="#7c3aed"/>
          <KPI icon="📥" label="Received"       value={m.received.toLocaleString()}         sub="Pending"                            color="#d97706"/>
        </KPIGrid>
      </div>

      {drillStatus && (
        <div style={{ background:'#eef2ff', border:'1px solid #c7d2fe', borderRadius:'var(--r2)', padding:'12px 16px', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <div>
            <span style={{ fontWeight:700, color:'var(--accent)' }}>Drill: {drillStatus}</span>
            <span style={{ marginLeft:12, fontSize:12, color:'var(--text2)' }}>{dm.orders} orders · {fmt(dm.rev)} revenue · {pct(dm.delivRate)} delivery</span>
          </div>
          <button onClick={()=>setDrillStatus(null)} style={{ padding:'4px 12px', background:'var(--accent)', color:'#fff', borderRadius:6, fontSize:11, fontWeight:700 }}>✕ Reset</button>
        </div>
      )}

      <div style={{ display:'grid', gridTemplateColumns:'1fr 300px', gap:16 }}>
        <Card title="WoW Orders" height={220}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={weekly.slice(-12)} margin={{ top:4, right:8, bottom:0, left:0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--grid)" vertical={false}/>
              <XAxis dataKey="date" tick={{ fill:'var(--text3)', fontSize:9 }} tickLine={false} axisLine={false}/>
              <YAxis tick={{ fill:'var(--text3)', fontSize:10 }} tickLine={false} axisLine={false} width={30}/>
              <Tooltip content={<TT/>}/>
              <Bar dataKey="orders" name="Orders" fill="#4f46e5" radius={[3,3,0,0]}/>
              <Bar dataKey="lines"  name="Lines"  fill="#0891b2" radius={[3,3,0,0]}/>
            </BarChart>
          </ResponsiveContainer>
        </Card>
        <Card title="Order Status Funnel" subtitle="Click to drill" height={220}>
          <div style={{ paddingTop:4 }}>
            {byOrderStatus.map(s=>(
              <FunnelBar key={s.name} label={s.name} value={s.orders} total={m.orders}
                color={STATUS_COLOR[s.name]||'var(--accent)'}
                onClick={()=>setDrillStatus(drillStatus===s.name?null:s.name)}/>
            ))}
          </div>
        </Card>
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
        <Card title="Item Status Breakdown" height={220}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={byItemStatus} layout="vertical" margin={{ left:4, right:40, top:0, bottom:0 }}>
              <XAxis type="number" tick={{ fill:'var(--text3)', fontSize:10 }} tickLine={false} axisLine={false}/>
              <YAxis type="category" dataKey="name" tick={{ fill:'var(--text2)', fontSize:10 }} width={100} tickLine={false} axisLine={false}/>
              <Tooltip content={<TT/>}/>
              <Bar dataKey="lines" name="Order Lines" radius={[0,3,3,0]}>
                {byItemStatus.map((s,i)=><Cell key={i} fill={ITEM_STATUS_COLOR[s.name]||COLORS[i]}/>)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Card>
        <Card title="Monthly Orders" height={220}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={monthly} margin={{ top:4, right:8, bottom:0, left:0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--grid)" vertical={false}/>
              <XAxis dataKey="date" tick={{ fill:'var(--text3)', fontSize:10 }} tickLine={false} axisLine={false}/>
              <YAxis tick={{ fill:'var(--text3)', fontSize:10 }} tickLine={false} axisLine={false} width={30}/>
              <Tooltip content={<TT/>}/>
              <Bar dataKey="orders" name="Orders" fill="#059669" radius={[3,3,0,0]}/>
            </BarChart>
          </ResponsiveContainer>
        </Card>
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
        <DataTable title="Order Status Summary"   data={byOrderStatus} columns={statusCols(STATUS_COLOR)} filename="order_status"/>
        <DataTable title="Item Status Summary"    data={byItemStatus}
          columns={[{ key:'name', label:'Item Status', render:(v)=><Pill color={ITEM_STATUS_COLOR[v]||'#64748b'}>{v}</Pill> },
                    { key:'lines', label:'Lines', right:true }, { key:'qty', label:'Qty', right:true },
                    { key:'revenue', label:'Revenue', right:true, render:v=>fmt(v) },
                    { key:'revShare', label:'Rev %', right:true, render:v=>`${v.toFixed(1)}%` }]}
          filename="item_status"/>
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
        <DataTable title="Courier Performance"    data={byCourier.filter(r=>r.name!=='Unknown')} columns={COLS} filename="courier_perf"/>
        <DataTable title="Warehouse Performance"  data={byWarehouse} columns={COLS} filename="warehouse_perf"/>
      </div>
    </div>
  );
}
