import React, { useMemo } from 'react';
import { BarChart, Bar, Cell, ResponsiveContainer, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import { KPI, KPIGrid, Card, DataTable, InsightBar, Pill } from '../components/UI';
import { fmt, fmtCr, pct, COLORS, downloadSummaryCsv } from '../utils/dataEngine';

const TT = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:8, padding:'10px 14px', fontSize:11, boxShadow:'var(--shadow2)' }}>
    <div style={{ color:'var(--accent)', fontWeight:700, marginBottom:5 }}>{label}</div>
    {payload.map((p,i) => <div key={i} style={{ color:p.color||'var(--text)' }}>{p.name}: <b>{p.name?.toLowerCase().includes('rev')?fmt(p.value):p.value?.toLocaleString()}</b></div>)}
  </div>;
};

const rateColor = (r) => r >= 80 ? '#16a34a' : r >= 60 ? '#d97706' : '#e11d48';

export default function CouponsPage({ data, filters }) {
  const cs = (data.couponStats && data.couponStats.coupons) || [];
  const csku = (data.couponStats && data.couponStats.couponSku) || [];

  const totals = useMemo(() => {
    const orders = cs.reduce((s, c) => s + (c.orders || 0), 0);
    const succ = cs.reduce((s, c) => s + (c.successOrders || 0), 0);
    const rev = cs.reduce((s, c) => s + (c.revenue || 0), 0);
    return { orders, succ, rev, rate: orders ? succ / orders * 100 : 0 };
  }, [cs]);

  const best = cs[0];
  const bestRate = [...cs].filter(c => c.orders >= 50).sort((a, b) => b.successRate - a.successRate)[0];

  if (!cs.length) {
    return <div style={{ padding:40, textAlign:'center', color:'var(--text3)' }}>No coupon-coded orders in the current filter.</div>;
  }

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
      <InsightBar items={[
        best && { icon:'🏆', value:best.coupon, label:`top coupon · ${fmt(best.revenue)}` },
        bestRate && { icon:'✅', value:bestRate.coupon, label:`best success rate · ${pct(bestRate.successRate)}`, tone:'good' },
        { icon:'🎟️', value:cs.length, label:'active coupons' },
        { icon:'📦', value:totals.orders.toLocaleString(), label:`coupon orders · ${pct(totals.rate)} successful` },
      ]}/>

      <KPIGrid cols={4}>
        <KPI icon="🎟️" label="Coupon Revenue"   value={fmtCr(totals.rev)}            sub={`${cs.length} coupons`} color="#4f46e5"/>
        <KPI icon="📦" label="Coupon Orders"     value={totals.orders.toLocaleString()} sub="with a coupon" color="#2563eb"/>
        <KPI icon="✅" label="Success Rate"      value={pct(totals.rate)}             sub={`${totals.succ.toLocaleString()} successful`} color={rateColor(totals.rate)}/>
        <KPI icon="🏆" label="Top Coupon"        value={best?.coupon || '—'}          sub={best ? fmt(best.revenue) : ''} color="#16a34a"/>
      </KPIGrid>

      <Card title="🎟️ Top Coupons by Revenue" height={240}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={cs.slice(0, 12)} layout="vertical" margin={{ left:4, right:55, top:0, bottom:0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--grid)" horizontal={false}/>
            <XAxis type="number" tick={{ fill:'var(--text3)', fontSize:10 }} tickLine={false} axisLine={false} tickFormatter={fmtCr}/>
            <YAxis type="category" dataKey="coupon" tick={{ fill:'var(--text2)', fontSize:10 }} width={110} tickLine={false} axisLine={false}/>
            <Tooltip content={<TT/>}/>
            <Bar dataKey="revenue" name="Revenue" radius={[0,3,3,0]}>
              {cs.slice(0, 12).map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]}/>)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </Card>

      <DataTable
        title="Coupon Performance — success vs unsuccessful"
        data={cs}
        searchKeys={['coupon']}
        searchPlaceholder="Search coupon code…"
        onExport={() => downloadSummaryCsv({ kind:'coupons', filters, name:'coupon_summary' })}
        exportLabel="Export all coupons"
        columns={[
          { key:'coupon', label:'Coupon', bold:true },
          { key:'orders', label:'Orders', right:true },
          { key:'successOrders', label:'Successful', right:true, render:(v)=><span style={{ color:'var(--green)', fontWeight:600 }}>{(v||0).toLocaleString()}</span> },
          { key:'failOrders', label:'Unsuccessful', right:true, render:(v)=><span style={{ color:'var(--red)', fontWeight:600 }}>{(v||0).toLocaleString()}</span> },
          { key:'successRate', label:'Success %', right:true, render:(v)=><Pill color={rateColor(v)}>{pct(v)}</Pill> },
          { key:'qty', label:'Qty', right:true },
          { key:'revenue', label:'Revenue', right:true, render:v=>fmt(v) },
        ]}
        filename="coupon_performance"
        maxH={460}
      />

      <DataTable
        title="Top SKUs by Coupon"
        data={csku}
        searchKeys={['coupon','sku']}
        searchPlaceholder="Search coupon or SKU…"
        columns={[
          { key:'coupon', label:'Coupon', bold:true, w:120 },
          { key:'sku', label:'SKU Name', w:320, maxW:320, wrap:true },
          { key:'orders', label:'Orders', right:true },
          { key:'qty', label:'Qty', right:true },
          { key:'revenue', label:'Revenue', right:true, render:v=>fmt(v) },
        ]}
        filename="coupon_sku"
        maxH={460}
      />
    </div>
  );
}
