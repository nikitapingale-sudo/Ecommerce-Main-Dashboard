import React, { useMemo, useState } from 'react';
import { BarChart, Bar, Cell, ResponsiveContainer, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import { KPI, KPIGrid, Card, DataTable, SectionLabel, InsightBar } from '../components/UI';
import { fmt, fmtCr, pct, COLORS } from '../utils/dataEngine';

const TT = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:8, padding:'10px 14px', fontSize:11, boxShadow:'var(--shadow2)' }}>
    <div style={{ color:'var(--accent)', fontWeight:700, marginBottom:5 }}>{label}</div>
    {payload.map((p,i)=><div key={i} style={{ color:p.color||'var(--text)', marginBottom:2 }}>{p.name}: <b>{p.name?.toLowerCase().includes('rev')?fmt(p.value):p.value?.toLocaleString()}</b></div>)}
  </div>;
};
const COLS = [
  { key:'name', label:'Name', bold:true, maxW:200, wrap:true },
  { key:'orders', label:'Orders', right:true },
  { key:'lines', label:'Lines', right:true },
  { key:'qty', label:'Qty', right:true },
  { key:'revenue', label:'Revenue', right:true, render:v=>fmt(v) },
  { key:'revShare', label:'Rev %', right:true, render:v=>`${v.toFixed(1)}%` },
  { key:'aov', label:'AOV', right:true, render:v=>fmt(v) },
  { key:'asp', label:'ASP', right:true, render:v=>fmt(v) },
];

export default function ProductsPage({ data }) {
  const [selP, setSelP] = useState(null);
  const [selS, setSelS] = useState(null);
  const [selSS, setSelSS] = useState(null);

  // Walk the precomputed category hierarchy (parent → sub → sub-sub → product).
  const parentData = useMemo(() => (data && data.hierarchy) || [], [data]);
  const pNode    = useMemo(() => selP ? parentData.find(x => x.name === selP) : null, [parentData, selP]);
  const subData  = useMemo(() => (pNode && pNode.children) || [], [pNode]);
  const sNode    = useMemo(() => selS ? subData.find(x => x.name === selS) : null, [subData, selS]);
  const subSubData = useMemo(() => (sNode && sNode.children) || [], [sNode]);
  const ssNode   = useMemo(() => selSS ? subSubData.find(x => x.name === selSS) : null, [subSubData, selSS]);
  const prodData = useMemo(() => (ssNode && ssNode.children) || [], [ssNode]);

  const cur   = selSS ? prodData : selS ? subSubData : selP ? subData : parentData;
  const level = selSS ? 'Products' : selS ? 'Sub-Sub Category' : selP ? 'Sub Category' : 'Category';

  const handleClick = e => {
    const name = e?.activePayload?.[0]?.payload?.name;
    if (!name) return;
    if (!selP) setSelP(name);
    else if (!selS) setSelS(name);
    else if (!selSS) setSelSS(name);
  };

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:20 }}>
      <InsightBar items={[
        parentData[0] && { icon:'📚', value:parentData[0].name, label:`top category · ${pct(parentData[0].revShare)} rev` },
        parentData[1] && { icon:'🥈', value:parentData[1].name, label:'2nd category' },
        { icon:'🗂️', value:parentData.length, label:'categories' },
      ]}/>
      {/* Breadcrumb */}
      <div style={{ display:'flex', alignItems:'center', gap:6, fontSize:12, flexWrap:'wrap', padding:'8px 12px', background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--r)', boxShadow:'var(--shadow)' }}>
        <span style={{ fontSize:11, color:'var(--text3)', fontWeight:600, marginRight:4 }}>DRILL:</span>
        <span onClick={()=>{setSelP(null);setSelS(null);setSelSS(null);}} style={{ color:'var(--accent)', cursor:'pointer', fontWeight:600, padding:'2px 8px', background:'rgba(79,70,229,.08)', borderRadius:4 }}>All Categories</span>
        {selP && <><span style={{ color:'var(--text3)' }}>›</span><span onClick={()=>{setSelS(null);setSelSS(null);}} style={{ color:'var(--accent)', cursor:'pointer', fontWeight:600, padding:'2px 8px', background:'rgba(79,70,229,.08)', borderRadius:4 }}>{selP}</span></>}
        {selS && <><span style={{ color:'var(--text3)' }}>›</span><span onClick={()=>setSelSS(null)} style={{ color:'var(--accent)', cursor:'pointer', fontWeight:600, padding:'2px 8px', background:'rgba(79,70,229,.08)', borderRadius:4 }}>{selS}</span></>}
        {selSS && <><span style={{ color:'var(--text3)' }}>›</span><span style={{ color:'var(--text)', fontWeight:600 }}>{selSS}</span></>}
        {(selP||selS||selSS) && <button onClick={()=>{setSelP(null);setSelS(null);setSelSS(null);}} style={{ marginLeft:'auto', padding:'3px 10px', background:'var(--red-bg)', color:'var(--red)', borderRadius:5, fontSize:10, fontWeight:700, border:'1px solid #fca5a5' }}>Reset</button>}
      </div>

      <div>
        <SectionLabel>{level} — Click cards or bars to drill deeper</SectionLabel>
        <KPIGrid cols={Math.min(cur.length, 4)}>
          {cur.slice(0,4).map((d,i)=>(
            <KPI key={d.name} label={d.name} value={d.orders.toLocaleString()} sub={`${fmt(d.revenue)} · ${pct(d.revShare)}`}
              color={COLORS[i%COLORS.length]}
              onClick={!selSS ? ()=>{ if(!selP)setSelP(d.name); else if(!selS)setSelS(d.name); else setSelSS(d.name); } : undefined}/>
          ))}
        </KPIGrid>
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
        <Card title={`${level} — Revenue`} subtitle="Click bar to drill" height={240}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={cur.slice(0,12)} onClick={handleClick} style={{ cursor:'pointer' }} margin={{ top:4, right:8, bottom:30, left:8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--grid)" vertical={false}/>
              <XAxis dataKey="name" tick={{ fill:'var(--text3)', fontSize:9 }} tickLine={false} axisLine={false} angle={-35} textAnchor="end"/>
              <YAxis tick={{ fill:'var(--text3)', fontSize:10 }} tickLine={false} axisLine={false} width={90} tickFormatter={fmtCr}/>
              <Tooltip content={<TT/>}/>
              <Bar dataKey="revenue" name="Revenue" radius={[3,3,0,0]}>
                {cur.slice(0,12).map((_,i)=><Cell key={i} fill={COLORS[i%COLORS.length]}/>)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Card>
        <Card title={`${level} — Orders`} subtitle="Click bar to drill" height={240}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={cur.slice(0,12)} onClick={handleClick} style={{ cursor:'pointer' }} margin={{ top:4, right:8, bottom:30, left:0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--grid)" vertical={false}/>
              <XAxis dataKey="name" tick={{ fill:'var(--text3)', fontSize:9 }} tickLine={false} axisLine={false} angle={-35} textAnchor="end"/>
              <YAxis tick={{ fill:'var(--text3)', fontSize:10 }} tickLine={false} axisLine={false} width={30}/>
              <Tooltip content={<TT/>}/>
              <Bar dataKey="orders" name="Orders" radius={[3,3,0,0]}>
                {cur.slice(0,12).map((_,i)=><Cell key={i} fill={COLORS[i%COLORS.length]}/>)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Card>
      </div>

      <DataTable title={`${level} Performance`} data={cur} columns={COLS} filename={level.toLowerCase().replace(' ','_')}/>
    </div>
  );
}
