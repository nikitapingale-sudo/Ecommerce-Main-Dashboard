import React, { useMemo } from 'react';
import { BarChart, Bar, Cell, ResponsiveContainer, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import { KPI, KPIGrid, Card, DataTable, FunnelBar, InsightBar } from '../components/UI';
import { fmt, fmtN, fmtCr, pct, COLORS, STATUS_COLOR } from '../utils/dataEngine';

const TT = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:8, padding:'10px 14px', fontSize:11 }}>
    <div style={{ color:'var(--yellow)', fontWeight:700, marginBottom:5 }}>{label} days</div>
    {payload.map((p,i) => <div key={i} style={{ color:p.color, marginBottom:2 }}>{p.name}: <b>{p.value?.toLocaleString()}</b></div>)}
  </div>;
};

export default function PendencyPage({ data }) {
  const p = (data && data.pendency) || { count:0, avgDays:0, over7:0, over15:0,
    pendingRev:0, pendingQty:0, aging:[], byStatus:[], byChannel:[], byCat:[], table:[] };

  const agingBuckets = p.aging;
  const byStatus = p.byStatus;
  const byChannel = p.byChannel;
  const byCat = p.byCat;
  const pendTable = useMemo(() => [...p.table].sort((a,b)=>b.pendencyDays-a.pendencyDays), [p.table]);

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:18 }}>
      <InsightBar items={[
        { icon:'⏳', value:p.count.toLocaleString(), label:'orders pending' },
        { icon:'📅', value:`${p.avgDays.toFixed(1)}d`, label:'avg pendency', tone: p.avgDays>15?'bad':'neutral' },
        { icon:'🚨', value:p.over15.toLocaleString(), label:'>15 days (critical)', tone: p.over15>0?'bad':'good' },
        { icon:'💰', value:fmt(p.pendingRev), label:'revenue stuck in pipeline' },
      ]}/>
      <KPIGrid cols={3}>
        <KPI icon="⏳" label="Pending Orders"  value={p.count.toLocaleString()} sub="Received/Packed/Shipped" color="#d97706"/>
        <KPI icon="📅" label="Avg Pendency"    value={`${p.avgDays.toFixed(1)} days`}    sub="Average days open"      color="#ea580c"/>
        <KPI icon="⚠️" label=">7 Days"         value={p.over7.toLocaleString()}           sub={pct(p.count?p.over7/p.count*100:0)+' of pending'} color="#dc2626"/>
        <KPI icon="🚨" label=">15 Days"        value={p.over15.toLocaleString()}          sub="Critical aging"          color="#dc2626"/>
        <KPI icon="💰" label="Pending Revenue" value={fmtCr(p.pendingRev)} sub="Stuck in pipeline" color="#7c3aed"/>
        <KPI icon="📦" label="Pending Qty"     value={p.pendingQty.toLocaleString()} sub="Units in transit" color="#2563eb"/>
      </KPIGrid>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 300px', gap:16 }}>
        <Card title="Pendency Aging Distribution" height={220}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={agingBuckets} margin={{ top:4, right:8, bottom:0, left:0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--grid)" vertical={false}/>
              <XAxis dataKey="name" tick={{ fill:'var(--text3)', fontSize:11 }} tickLine={false} axisLine={false}/>
              <YAxis tick={{ fill:'var(--text3)', fontSize:10 }} tickLine={false} axisLine={false} width={30}/>
              <Tooltip content={<TT/>}/>
              <Bar dataKey="count" name="Orders" radius={[3,3,0,0]}>
                {agingBuckets.map((_,i)=><Cell key={i} fill={['var(--green)','var(--blue)','var(--yellow)','var(--orange)','var(--red)'][i]}/>)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Card>
        <Card title="Pending by Status" height={220}>
          <div style={{ paddingTop:8 }}>
            {byStatus.map(s => (
              <FunnelBar key={s.name} label={s.name} value={s.orders} total={p.count} color={STATUS_COLOR[s.name]||'var(--accent)'}/>
            ))}
          </div>
        </Card>
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
        <Card title="Pending by Channel" height={180}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={byChannel} layout="vertical" margin={{ left:4, right:30, top:0, bottom:0 }}>
              <XAxis type="number" tick={{ fill:'var(--text3)', fontSize:10 }} tickLine={false} axisLine={false}/>
              <YAxis type="category" dataKey="name" tick={{ fill:'var(--text2)', fontSize:10 }} width={80} tickLine={false} axisLine={false}/>
              <Tooltip content={<TT/>}/>
              <Bar dataKey="orders" name="Pending Orders" radius={[0,3,3,0]}>
                {byChannel.map((_,i)=><Cell key={i} fill={COLORS[i%COLORS.length]}/>)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Card>
        <Card title="Pending by Category" height={180}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={byCat.slice(0,8)} layout="vertical" margin={{ left:4, right:30, top:0, bottom:0 }}>
              <XAxis type="number" tick={{ fill:'var(--text3)', fontSize:10 }} tickLine={false} axisLine={false}/>
              <YAxis type="category" dataKey="name" tick={{ fill:'var(--text2)', fontSize:10 }} width={100} tickLine={false} axisLine={false}/>
              <Tooltip content={<TT/>}/>
              <Bar dataKey="orders" name="Pending Orders" radius={[0,3,3,0]}>
                {byCat.slice(0,8).map((_,i)=><Cell key={i} fill={COLORS[i%COLORS.length]}/>)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Card>
      </div>

      <DataTable
        title="Pending Order Details"
        data={pendTable.sort((a,b)=>b.pendencyDays-a.pendencyDays)}
        columns={[
          { key:'vco_external_order_number', label:'Order No', bold:true },
          { key:'order_date', label:'Order Date' },
          { key:'pendencyDays', label:'Days Pending', right:true, render:v=><span style={{ color: v>15?'var(--red)':v>7?'var(--orange)':'var(--text)', fontWeight:700 }}>{v}d</span> },
          { key:'order_status_group', label:'Status' },
          { key:'vco_channel_name', label:'Channel' },
          { key:'parent_name', label:'Category' },
          { key:'product_name', label:'Product' },
          { key:'qty', label:'Qty', right:true },
          { key:'final_revenue', label:'Revenue', right:true, render:v=>fmt(v) },
          { key:'city', label:'City' },
          { key:'state', label:'State' },
          { key:'warehouse', label:'Warehouse' },
        ]}
        filename="pending_orders"
        maxH={500}
      />
    </div>
  );
}
