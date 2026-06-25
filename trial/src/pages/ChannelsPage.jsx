import React, { useMemo } from 'react';
import { BarChart, Bar, PieChart, Pie, Cell, ResponsiveContainer, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import { KPI, KPIGrid, Card, DataTable, SectionLabel, MoversCard, InsightBar } from '../components/UI';
import { groupArr, fmt, fmtCr, pct, COLORS } from '../utils/dataEngine';

const TT = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:8, padding:'10px 14px', fontSize:11, boxShadow:'var(--shadow2)' }}>
    <div style={{ color:'var(--accent)', fontWeight:700, marginBottom:5 }}>{label}</div>
    {payload.map((p,i) => <div key={i} style={{ color:p.color||'var(--text)', marginBottom:2 }}>{p.name}: <b>{p.name?.toLowerCase().includes('rev')?fmt(p.value):p.value?.toLocaleString()}</b></div>)}
  </div>;
};
const COLS = [
  { key:'name', label:'Name', bold:true },
  { key:'orders', label:'Orders', right:true },
  { key:'lines', label:'Lines', right:true },
  { key:'qty', label:'Qty', right:true },
  { key:'revenue', label:'Revenue', right:true, render:v=>fmt(v) },
  { key:'revShare', label:'Rev %', right:true, render:v=>`${v.toFixed(1)}%` },
  { key:'aov', label:'AOV', right:true, render:v=>fmt(v) },
  { key:'asp', label:'ASP', right:true, render:v=>fmt(v) },
];

export default function ChannelsPage({ data }) {
  const byChan  = useMemo(() => groupArr(data,'vco_channel_name'), [data]);
  const byPay   = useMemo(() => groupArr(data,'payment_sources'), [data]);
  const byFin   = useMemo(() => groupArr(data,'finance_exam_category'), [data]);
  const byOC    = useMemo(() => groupArr(data,'order_category'), [data]);
  const byOMS   = useMemo(() => groupArr(data,'oms'), [data]);
  const byPurch = useMemo(() => groupArr(data,'purchase_level'), [data]);

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:20 }}>
      <InsightBar items={[
        byChan[0] && { icon:'🏆', value:byChan[0].name, label:`top channel · ${pct(byChan[0].revShare)} rev` },
        byPay[0] && { icon:'💳', value:byPay[0].name, label:`top payment · ${pct(byPay[0].revShare)}` },
        data.movers?.channel?.up?.[0] && { icon:'🚀', value:data.movers.channel.up[0].name, label:'fastest-growing channel', tone:'good' },
        data.movers?.channel?.down?.[0] && { icon:'📉', value:data.movers.channel.down[0].name, label:'declining channel', tone:'bad' },
      ]}/>
      <div>
        <SectionLabel>Channel KPIs</SectionLabel>
        <KPIGrid cols={Math.min(byChan.length, 4)}>
          {byChan.slice(0,4).map((c,i)=>(
            <KPI key={c.name} icon="📡" label={c.name} value={c.orders.toLocaleString()} sub={`${fmt(c.revenue)} · ${pct(c.revShare)}`} color={COLORS[i]}/>
          ))}
        </KPIGrid>
      </div>

      <MoversCard title="🚀 Top Movers — Channels" movers={data.movers && data.movers.channel}/>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
        <Card title="Channel Revenue Split" height={220}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={byChan} layout="vertical" margin={{ left:4, right:50, top:0, bottom:0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--grid)" horizontal={false}/>
              <XAxis type="number" tick={{ fill:'var(--text3)', fontSize:10 }} tickLine={false} axisLine={false} tickFormatter={fmtCr}/>
              <YAxis type="category" dataKey="name" tick={{ fill:'var(--text2)', fontSize:10 }} width={95} tickLine={false} axisLine={false}/>
              <Tooltip content={<TT/>}/>
              <Bar dataKey="revenue" name="Revenue" radius={[0,3,3,0]}>
                {byChan.map((_,i)=><Cell key={i} fill={COLORS[i%COLORS.length]}/>)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Card>
        <Card title="Channel Orders Count" height={220}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={byChan} margin={{ top:4, right:8, bottom:20, left:0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--grid)" vertical={false}/>
              <XAxis dataKey="name" tick={{ fill:'var(--text3)', fontSize:9 }} tickLine={false} axisLine={false} angle={-25} textAnchor="end"/>
              <YAxis tick={{ fill:'var(--text3)', fontSize:10 }} tickLine={false} axisLine={false} width={30}/>
              <Tooltip content={<TT/>}/>
              <Bar dataKey="orders" name="Orders" radius={[3,3,0,0]}>
                {byChan.map((_,i)=><Cell key={i} fill={COLORS[i%COLORS.length]}/>)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Card>
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
        <Card title="Payment Mode" height={190}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={byPay} layout="vertical" margin={{ left:4, right:40, top:0, bottom:0 }}>
              <XAxis type="number" tick={{ fill:'var(--text3)', fontSize:10 }} tickLine={false} axisLine={false}/>
              <YAxis type="category" dataKey="name" tick={{ fill:'var(--text2)', fontSize:10 }} width={80} tickLine={false} axisLine={false}/>
              <Tooltip content={<TT/>}/>
              <Bar dataKey="orders" name="Orders" radius={[0,3,3,0]}>
                {byPay.map((_,i)=><Cell key={i} fill={COLORS[i%COLORS.length]}/>)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Card>
        <Card title="Finance Category" height={190}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={byFin.slice(0,8)} layout="vertical" margin={{ left:4, right:40, top:0, bottom:0 }}>
              <XAxis type="number" tick={{ fill:'var(--text3)', fontSize:10 }} tickLine={false} axisLine={false}/>
              <YAxis type="category" dataKey="name" tick={{ fill:'var(--text2)', fontSize:10 }} width={110} tickLine={false} axisLine={false}/>
              <Tooltip content={<TT/>}/>
              <Bar dataKey="orders" name="Orders" radius={[0,3,3,0]}>
                {byFin.slice(0,8).map((_,i)=><Cell key={i} fill={COLORS[i%COLORS.length]}/>)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Card>
      </div>

      <DataTable title="Channel Detail" data={byChan} columns={COLS} filename="channel"/>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
        <DataTable title="Order Category"   data={byOC}    columns={COLS} filename="order_cat"/>
        <DataTable title="Payment Mode"     data={byPay}   columns={COLS} filename="payment"/>
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
        <DataTable title="Finance Category" data={byFin}   columns={COLS} filename="fin_cat"/>
        <DataTable title="OMS"              data={byOMS}   columns={COLS} filename="oms"/>
      </div>
    </div>
  );
}
