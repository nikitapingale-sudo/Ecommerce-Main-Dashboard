import React, { useMemo } from 'react';
import { BarChart, Bar, Cell, ResponsiveContainer, XAxis, YAxis, CartesianGrid, Tooltip, PieChart, Pie, Legend } from 'recharts';
import { KPI, KPIGrid, Card, DataTable, MoversCard, InsightBar } from '../components/UI';
import { groupArr, fmt, fmtN, fmtCr, pct, COLORS } from '../utils/dataEngine';

const TT = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:8, padding:'10px 14px', fontSize:11 }}>
    <div style={{ color:'var(--accent)', fontWeight:700, marginBottom:5 }}>{label}</div>
    {payload.map((p,i) => <div key={i} style={{ color:p.color, marginBottom:2 }}>{p.name}: <b>{p.name?.toLowerCase().includes('rev')?fmt(p.value):p.value?.toLocaleString()}</b></div>)}
  </div>;
};

const cols = [
  { key:'name', label:'Name', bold:true },
  { key:'orders', label:'Orders', right:true },
  { key:'lines', label:'Lines', right:true },
  { key:'qty', label:'Qty', right:true },
  { key:'revenue', label:'Revenue', right:true, render:v=>fmt(v) },
  { key:'revShare', label:'Rev %', right:true, render:v=>`${v.toFixed(1)}%` },
  { key:'aov', label:'AOV', right:true, render:v=>fmt(v) },
];

export default function GeographicPage({ data }) {
  const byState  = useMemo(() => groupArr(data, 'state'), [data]);
  const byCity   = useMemo(() => groupArr(data, 'city'), [data]);

  // Normalize state names (source has mixed case) by merging the pre-aggregated
  // by-state breakdown on an upper-cased key. Each order has a single state, so
  // summing orders/lines across case variants does not double-count.
  const stateNorm = useMemo(() => {
    const map = {};
    let totalRev = 0;
    byState.forEach(s => {
      const k = (s.name || 'Unknown').toUpperCase().trim();
      if (!map[k]) map[k] = { name:k, orders:0, lines:0, qty:0, revenue:0 };
      map[k].orders += s.orders; map[k].lines += s.lines;
      map[k].qty += s.qty; map[k].revenue += s.revenue;
      totalRev += s.revenue;
    });
    return Object.values(map).map(r => ({
      ...r,
      aov: r.orders>0 ? r.revenue/r.orders : 0,
      revShare: totalRev>0 ? r.revenue/totalRev*100 : 0,
    })).sort((a,b)=>b.orders-a.orders);
  }, [byState]);

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:18 }}>
      <InsightBar items={[
        stateNorm[0] && { icon:'📍', value:stateNorm[0].name, label:`top state · ${pct(stateNorm[0].revShare)} rev` },
        byCity[0] && { icon:'🏙️', value:byCity[0].name, label:'top city' },
        data.movers?.state?.up?.[0] && { icon:'🚀', value:data.movers.state.up[0].name, label:'fastest-growing state', tone:'good' },
        data.movers?.state?.down?.[0] && { icon:'📉', value:data.movers.state.down[0].name, label:'declining state', tone:'bad' },
      ]}/>
      <KPIGrid cols={Math.min(stateNorm.length, 5)}>
        {stateNorm.slice(0,5).map((s,i) => (
          <KPI key={s.name} icon="📍" label={s.name} value={s.orders.toLocaleString()} sub={`${fmt(s.revenue)} · ${pct(s.revShare)}`} color={COLORS[i]}/>
        ))}
      </KPIGrid>

      <MoversCard title="🚀 Top Movers — States" movers={data.movers && data.movers.state}/>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
        <Card title="Top States by Orders" height={280}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={stateNorm.slice(0,15)} layout="vertical" margin={{ left:4, right:50, top:0, bottom:0 }}>
              <XAxis type="number" tick={{ fill:'var(--text3)', fontSize:10 }} tickLine={false} axisLine={false}/>
              <YAxis type="category" dataKey="name" tick={{ fill:'var(--text2)', fontSize:10 }} width={110} tickLine={false} axisLine={false}/>
              <Tooltip content={<TT/>}/>
              <Bar dataKey="orders" name="Orders" radius={[0,3,3,0]}>
                {stateNorm.slice(0,15).map((_,i)=><Cell key={i} fill={COLORS[i%COLORS.length]}/>)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Card>

        <Card title="Top States by Revenue" height={280}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={stateNorm.sort((a,b)=>b.revenue-a.revenue).slice(0,15)} layout="vertical" margin={{ left:4, right:60, top:0, bottom:0 }}>
              <XAxis type="number" tick={{ fill:'var(--text3)', fontSize:10 }} tickLine={false} axisLine={false} tickFormatter={fmtCr}/>
              <YAxis type="category" dataKey="name" tick={{ fill:'var(--text2)', fontSize:10 }} width={110} tickLine={false} axisLine={false}/>
              <Tooltip content={<TT/>}/>
              <Bar dataKey="revenue" name="Revenue" radius={[0,3,3,0]}>
                {stateNorm.slice(0,15).map((_,i)=><Cell key={i} fill={COLORS[i%COLORS.length]}/>)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Card>
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
        <Card title="Top Cities by Orders" height={240}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={byCity.slice(0,15)} layout="vertical" margin={{ left:4, right:40, top:0, bottom:0 }}>
              <XAxis type="number" tick={{ fill:'var(--text3)', fontSize:10 }} tickLine={false} axisLine={false}/>
              <YAxis type="category" dataKey="name" tick={{ fill:'var(--text2)', fontSize:10 }} width={80} tickLine={false} axisLine={false}/>
              <Tooltip content={<TT/>}/>
              <Bar dataKey="orders" name="Orders" radius={[0,3,3,0]}>
                {byCity.slice(0,15).map((_,i)=><Cell key={i} fill={COLORS[i%COLORS.length]}/>)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Card>

        <Card title="Revenue Share — Top 10 States" height={240}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={stateNorm.slice().sort((a,b)=>b.revenue-a.revenue).slice(0,10)} layout="vertical" margin={{ left:4, right:55, top:0, bottom:0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--grid)" horizontal={false}/>
              <XAxis type="number" tick={{ fill:'var(--text3)', fontSize:10 }} tickLine={false} axisLine={false} tickFormatter={fmtCr}/>
              <YAxis type="category" dataKey="name" tick={{ fill:'var(--text2)', fontSize:10 }} width={100} tickLine={false} axisLine={false}/>
              <Tooltip content={<TT/>}/>
              <Bar dataKey="revenue" name="Revenue" radius={[0,3,3,0]}>
                {stateNorm.slice(0,10).map((_,i)=><Cell key={i} fill={COLORS[i%COLORS.length]}/>)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Card>
      </div>

      <DataTable title="State-wise Performance" data={stateNorm} columns={cols} filename="state_perf"
        searchKeys={['name']} searchPlaceholder="Search state…"/>
      <DataTable title="City-wise Performance" data={byCity} columns={cols} filename="city_perf"
        searchKeys={['name']} searchPlaceholder="Search any city…"/>
    </div>
  );
}
