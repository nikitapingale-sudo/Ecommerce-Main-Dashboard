import React, { useMemo } from 'react';
import { BarChart, Bar, Cell, PieChart, Pie, Legend, ResponsiveContainer, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import { KPI, KPIGrid, Card, DataTable, InsightBar } from '../components/UI';
import { groupArr, fmt, pct, COLORS } from '../utils/dataEngine';

const TT = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:8, padding:'10px 14px', fontSize:11 }}>
    <div style={{ color:'var(--accent)', fontWeight:700, marginBottom:5 }}>{label}</div>
    {payload.map((p,i) => <div key={i} style={{ color:p.color, marginBottom:2 }}>{p.name}: <b>{p.name?.toLowerCase().includes('rev')?fmt(p.value):p.value?.toLocaleString()}</b></div>)}
  </div>;
};

const COLS = [
  { key:'name', label:'Name', bold:true },
  { key:'orders', label:'Orders', right:true },
  { key:'lines', label:'Lines', right:true },
  { key:'qty', label:'Qty', right:true },
  { key:'revenue', label:'Revenue', right:true, render:v=>fmt(v) },
  { key:'revShare', label:'Rev %', right:true, render:v=>`${v.toFixed(1)}%` },
];

export default function OperationsPage({ data }) {
  const byWH      = useMemo(() => groupArr(data, 'warehouse'), [data]);
  const byCourier = useMemo(() => groupArr(data, 'delivery_partner'), [data]);
  const byOMS     = useMemo(() => groupArr(data, 'oms'), [data]);
  const byOT      = useMemo(() => groupArr(data, 'order_type'), [data]);
  const byPL      = useMemo(() => groupArr(data, 'purchase_level'), [data]);
  const byBrand   = useMemo(() => groupArr(data, 'vco_brand'), [data]);

  // Courier short names for chart
  const courierChart = useMemo(() => byCourier.filter(r=>r.name!=='Unknown').map(r => ({
    ...r, shortName: r.name.length>20 ? r.name.slice(0,20)+'…' : r.name
  })), [byCourier]);

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:18 }}>
      <InsightBar items={[
        byWH[0] && { icon:'🏭', value:byWH[0].name, label:`top warehouse · ${pct(byWH[0].revShare)}` },
        byCourier.filter(r=>r.name!=='Unknown')[0] && { icon:'🚚', value:byCourier.filter(r=>r.name!=='Unknown')[0].name, label:'top courier' },
        byOMS[0] && { icon:'💻', value:byOMS[0].name, label:'OMS' },
      ]}/>
      <KPIGrid cols={4}>
        {[...byWH.slice(0,2).map((w,i)=>({...w,icon:'🏭',col:COLORS[i]})), ...byOMS.slice(0,2).map((o,i)=>({...o,name:`OMS: ${o.name}`,icon:'💻',col:COLORS[i+3]}))].map(w=>(
          <KPI key={w.name} icon={w.icon} label={w.name} value={w.orders.toLocaleString()} sub={`${fmt(w.revenue)} · ${pct(w.revShare)}`} color={w.col}/>
        ))}
      </KPIGrid>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
        <Card title="Warehouse Order Distribution" height={200}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={byWH} layout="vertical" margin={{ left:4, right:40, top:0, bottom:0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--grid)" horizontal={false}/>
              <XAxis type="number" tick={{ fill:'var(--text3)', fontSize:10 }} tickLine={false} axisLine={false}/>
              <YAxis type="category" dataKey="name" tick={{ fill:'var(--text2)', fontSize:10 }} width={100} tickLine={false} axisLine={false}/>
              <Tooltip content={<TT/>}/>
              <Bar dataKey="orders" name="Orders" radius={[0,3,3,0]}>
                {byWH.map((_,i) => <Cell key={i} fill={COLORS[i%COLORS.length]}/>)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Card>
        <Card title="Order Type Distribution" height={200}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={byOT} margin={{ top:4, right:8, bottom:0, left:0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--grid)" vertical={false}/>
              <XAxis dataKey="name" tick={{ fill:'var(--text3)', fontSize:11 }} tickLine={false} axisLine={false}/>
              <YAxis tick={{ fill:'var(--text3)', fontSize:10 }} tickLine={false} axisLine={false} width={30}/>
              <Tooltip content={<TT/>}/>
              <Bar dataKey="orders" name="Orders" radius={[3,3,0,0]}>
                {byOT.map((_,i) => <Cell key={i} fill={COLORS[i%COLORS.length]}/>)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Card>
      </div>

      <Card title="Delivery Partner Performance" height={220}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={courierChart} layout="vertical" margin={{ left:4, right:50, top:0, bottom:0 }}>
            <XAxis type="number" tick={{ fill:'var(--text3)', fontSize:10 }} tickLine={false} axisLine={false}/>
            <YAxis type="category" dataKey="shortName" tick={{ fill:'var(--text2)', fontSize:10 }} width={160} tickLine={false} axisLine={false}/>
            <Tooltip content={<TT/>}/>
            <Bar dataKey="orders" name="Orders" radius={[0,3,3,0]}>
              {courierChart.map((_,i) => <Cell key={i} fill={COLORS[i%COLORS.length]}/>)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </Card>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
        <DataTable title="Warehouse Breakdown" data={byWH} columns={COLS} filename="warehouse"/>
        <DataTable title="Delivery Partner Breakdown" data={byCourier.filter(r=>r.name!=='Unknown')} columns={COLS} filename="courier"/>
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:16 }}>
        <DataTable title="OMS Breakdown" data={byOMS} columns={COLS} filename="oms"/>
        <DataTable title="Order Type Breakdown" data={byOT} columns={COLS} filename="order_type"/>
        <DataTable title="Purchase Level Breakdown" data={byPL} columns={COLS} filename="purchase_level"/>
      </div>
      <DataTable title="Brand Breakdown" data={byBrand} columns={COLS} filename="brand"/>
    </div>
  );
}
