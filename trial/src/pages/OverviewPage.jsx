import React, { useMemo, useState, useEffect } from 'react';
import { AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell, ResponsiveContainer, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import { KPI, KPIGrid, Card, FunnelBar, StatList, SectionLabel, Tabs, MoversCard, InsightBar } from '../components/UI';
import { metrics, groupArr, groupByDate, fetchSummary, fmt, fmtN, fmtCr, pct, STATUS_COLOR, COLORS } from '../utils/dataEngine';

const TT = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:8, padding:'10px 14px', fontSize:11, boxShadow:'var(--shadow2)' }}>
    <div style={{ color:'var(--accent)', fontWeight:700, marginBottom:5 }}>{label}</div>
    {payload.map((p,i) => <div key={i} style={{ color:p.color||'var(--text)', marginBottom:2 }}>{p.name}: <b>{p.name?.toLowerCase().includes('rev')?fmt(p.value):p.value?.toLocaleString()}</b></div>)}
  </div>;
};

export default function OverviewPage({ data, filters, goto }) {
  const [gran, setGran] = useState('day');
  const [drillStatus, setDrillStatus] = useState(null);

  const m       = useMemo(() => metrics(data), [data]);
  const trend   = useMemo(() => groupByDate(data, gran), [data, gran]);
  const byStatus= useMemo(() => groupArr(data, 'order_status_group'), [data]);
  const byChan  = useMemo(() => groupArr(data, 'vco_channel_name'), [data]);
  const byPay   = useMemo(() => groupArr(data, 'payment_sources'), [data]);
  const byCat   = useMemo(() => groupArr(data, 'parent_name'), [data]);
  const byOStat = useMemo(() => groupArr(data, 'final_order_status'), [data]);

  // Daily series (last 30 pts) for the KPI sparklines.
  const spark = useMemo(() => {
    const d = groupByDate(data, 'day').slice(-30);
    return {
      orders:  d.map(r => r.orders  || 0),
      revenue: d.map(r => r.revenue || 0),
      qty:     d.map(r => r.qty     || 0),
    };
  }, [data]);

  // Week-over-week % (last 7 days vs the prior 7) — robust to partial months.
  const wow = useMemo(() => {
    const d = groupByDate(data, 'day');
    if (d.length < 14) return {};
    const sum = (arr, k) => arr.reduce((s, r) => s + (r[k] || 0), 0);
    const l = d.slice(-7), p = d.slice(-14, -7);
    const pct2 = (a, b) => (b ? (a - b) / b * 100 : undefined);
    return { orders: pct2(sum(l,'orders'), sum(p,'orders')), revenue: pct2(sum(l,'revenue'), sum(p,'revenue')),
             qty: pct2(sum(l,'qty'), sum(p,'qty')) };
  }, [data]);

  // Drill — fetch a status-scoped bundle from the server.
  const [drillBundle, setDrillBundle] = useState(null);
  useEffect(() => {
    if (!drillStatus) { setDrillBundle(null); return; }
    let alive = true;
    fetchSummary({ ...filters, statuses: [drillStatus] })
      .then(b => { if (alive) setDrillBundle(b); }).catch(() => {});
    return () => { alive = false; };
  }, [drillStatus, filters]);
  const drillTrend = useMemo(() => groupByDate(drillBundle || data, gran), [drillBundle, data, gran]);

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
      <InsightBar items={[
        wow.revenue !== undefined && { icon:'📈', value:`${wow.revenue>=0?'+':''}${wow.revenue.toFixed(0)}%`, label:'revenue WoW', tone: wow.revenue>=0?'good':'bad' },
        { icon:'✅', value:pct(m.delivRate), label:'delivery rate', tone: m.delivRate>=60?'good':'bad' },
        { icon:'🔁', value:pct(m.rtoRate), label:'RTO/returns', tone: m.rtoRate>8?'bad':'good' },
        byChan[0] && { icon:'🏆', value:byChan[0].name, label:`top channel · ${pct(byChan[0].revShare)}` },
        data.movers?.category?.up?.[0] && { icon:'🚀', value:data.movers.category.up[0].name, label:'fastest-growing category' },
      ]}/>

      {/* ── Key KPIs ── */}
      <KPIGrid cols={5}>
        <KPI icon="🗂️" label="Total Orders"     value={m.orders.toLocaleString()} sub={`${m.lines.toLocaleString()} lines`}          color="#4f46e5" trend={wow.orders}  spark={spark.orders}/>
        <KPI icon="💰" label="Gross Revenue"    value={fmtCr(m.rev)}              sub={`AOV ${fmt(m.aov)}`}                          color="#16a34a" trend={wow.revenue} spark={spark.revenue}/>
        <KPI icon="📦" label="Units Sold"       value={m.qty.toLocaleString()}    sub={`${m.aul.toFixed(1)} / order`}               color="#2563eb" trend={wow.qty}     spark={spark.qty}/>
        <KPI icon="🚚" label="Shipping Charges" value={fmtCr(m.delCharges)}       sub="Collected"                                    color="#7c3aed"/>
        <KPI icon="✅" label="Delivery Rate"    value={pct(m.delivRate)}
             sub={m.delivRate >= 60 ? `✓ on target · ${m.delivered.toLocaleString()} delivered` : `⚠ below 60% target`}
             color={m.delivRate >= 60 ? '#16a34a' : m.delivRate >= 45 ? '#d97706' : '#e11d48'}/>
      </KPIGrid>
      <KPIGrid cols={4}>
        <KPI icon="❌" label="Cancelled"     value={m.cancelled.toLocaleString()} sub={m.cancelRate > 15 ? `⚠ ${pct(m.cancelRate)} of orders` : `${pct(m.cancelRate)} of orders`} color={m.cancelRate > 15 ? '#e11d48' : '#ea580c'}/>
        <KPI icon="🔁" label="RTO / Returns" value={m.rto.toLocaleString()}       sub={m.rtoRate > 8 ? `⚠ ${pct(m.rtoRate)} of orders` : `${pct(m.rtoRate)} of orders`} color={m.rtoRate > 8 ? '#e11d48' : '#db2777'}/>
        <KPI icon="🚚" label="In Transit"    value={m.inTransit.toLocaleString()} sub="Shipped + packed"                 color="#2563eb"/>
        <KPI icon="📥" label="Received"      value={m.received.toLocaleString()}  sub="Pending processing"               color="#d97706"/>
      </KPIGrid>

      {/* ── Top Movers (last 30d vs prior 30d) ── */}
      <MoversCard title="🚀 Top Movers — Categories" movers={data.movers && data.movers.category}/>

      {/* ── Trend + Funnel ── */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 320px', gap:16 }}>
        <Card title={`${drillStatus ? `📌 Drill: ${drillStatus}` : '📈 Trend'}`}
          subtitle={drillStatus ? `Click funnel bar to change · Click again to reset` : 'Orders & qty over time'}
          height={240}
          right={
            <div style={{ display:'flex', gap:4, flexWrap:'wrap' }}>
              {drillStatus && <button onClick={()=>setDrillStatus(null)} style={{ padding:'3px 10px', borderRadius:5, fontSize:10, fontWeight:700, background:'var(--red-bg)', color:'var(--red)', border:'1px solid #fca5a5' }}>✕ Clear</button>}
              {['day','week','month'].map(g=>(
                <button key={g} onClick={()=>setGran(g)} style={{ padding:'3px 10px', borderRadius:5, fontSize:10, fontWeight:700, background:gran===g?'var(--accent)':'var(--surface2)', color:gran===g?'#fff':'var(--text2)', border:'1px solid var(--border)' }}>{g.charAt(0).toUpperCase()+g.slice(1)}</button>
              ))}
            </div>
          }>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={drillTrend} margin={{ top:4, right:8, bottom:0, left:0 }}>
              <defs>
                <linearGradient id="ga" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#4f46e5" stopOpacity={0.2}/><stop offset="95%" stopColor="#4f46e5" stopOpacity={0}/>
                </linearGradient>
                <linearGradient id="gb" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#059669" stopOpacity={0.2}/><stop offset="95%" stopColor="#059669" stopOpacity={0}/>
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--grid)" vertical={false}/>
              <XAxis dataKey="date" tick={{ fill:'var(--text3)', fontSize:10 }} tickLine={false} axisLine={false}/>
              <YAxis tick={{ fill:'var(--text3)', fontSize:10 }} tickLine={false} axisLine={false} width={35}/>
              <Tooltip content={<TT/>}/>
              <Area type="monotone" dataKey="orders" name="Orders" stroke="#4f46e5" strokeWidth={2} fill="url(#ga)" dot={false}/>
              <Area type="monotone" dataKey="qty"    name="Qty"    stroke="#059669" strokeWidth={2} fill="url(#gb)" dot={false}/>
            </AreaChart>
          </ResponsiveContainer>
        </Card>

        <Card title="🚦 Status Funnel" subtitle="Click to drill into status" height={240}>
          <div style={{ paddingTop:6 }}>
            {byStatus.map(s => (
              <FunnelBar key={s.name} label={s.name} value={s.orders} total={m.orders}
                color={STATUS_COLOR[s.name]||'var(--accent)'}
                onClick={()=>setDrillStatus(drillStatus===s.name ? null : s.name)}/>
            ))}
          </div>
        </Card>
      </div>

      {/* ── Monthly Revenue + Order Status Detail (count + share) ── */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
        <Card title="📅 Monthly Revenue" height={200}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={groupByDate(data,'month')} margin={{ top:4, right:8, bottom:0, left:8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--grid)" vertical={false}/>
              <XAxis dataKey="date" tick={{ fill:'var(--text3)', fontSize:10 }} tickLine={false} axisLine={false}/>
              <YAxis tick={{ fill:'var(--text3)', fontSize:10 }} tickLine={false} axisLine={false} width={80} tickFormatter={fmtCr}/>
              <Tooltip content={<TT/>}/>
              <Bar dataKey="revenue" name="Revenue" fill="#4f46e5" radius={[4,4,0,0]}/>
            </BarChart>
          </ResponsiveContainer>
        </Card>
        <Card title="🏷️ Order Status Detail" subtitle="Orders & share of total" height="auto">
          <StatList
            items={byOStat.slice(0, 10).map(s => ({ name: s.name, value: s.orders, color: STATUS_COLOR[s.name] }))}
            colors={COLORS}/>
        </Card>
      </div>

      {/* ── Orders by Channel + Payment (count + share) ── */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
        <Card title="📡 Orders by Channel" subtitle="Orders & share of total" height="auto">
          <StatList items={byChan.slice(0, 8).map(c => ({ name: c.name, value: c.orders }))} colors={COLORS}/>
        </Card>
        <Card title="💳 Orders by Payment" subtitle="Orders & share of total" height="auto">
          <StatList items={byPay.map(p => ({ name: p.name, value: p.orders }))} colors={COLORS}/>
        </Card>
      </div>

      {/* ── Top Categories by Revenue (revenue + share) ── */}
      <Card title="📚 Top Categories by Revenue" subtitle="Revenue & share of total" height="auto">
        <StatList items={byCat.slice(0, 10).map(c => ({ name: c.name, value: c.revenue }))} format={fmt} colors={COLORS}/>
      </Card>
    </div>
  );
}
