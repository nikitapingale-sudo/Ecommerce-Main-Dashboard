import React, { useMemo, useState, useEffect } from 'react';
import { AreaChart, Area, BarChart, Bar, ResponsiveContainer, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import { X, Plus, Minus } from 'lucide-react';
import { Card, FunnelBar, StatList, MoversCard, InsightBar } from '../components/UI';
import { metrics, groupArr, groupByDate, fetchSummary, fmt, fmtCr, pct, STATUS_COLOR, COLORS, ORDINAL } from '../utils/dataEngine';

const TT = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:8, padding:'10px 14px', fontSize:11, boxShadow:'var(--shadow2)' }}>
    <div style={{ color:'var(--accent)', fontWeight:700, marginBottom:5 }}>{label}</div>
    {payload.map((p,i) => <div key={i} style={{ color:p.color||'var(--text)', marginBottom:2 }}>{p.name}: <b>{p.name?.toLowerCase().includes('rev')?fmt(p.value):p.value?.toLocaleString()}</b></div>)}
  </div>;
};

/* ── Compact number formats for the KPI grids (K / M style, ₹ for money) ──── */
const kmt = (n) => {
  n = Number(n) || 0;
  // Counts in K (thousands) only — never M. e.g. 1,600,000 -> "1,600K".
  if (Math.abs(n) >= 1e3) return (n / 1e3).toLocaleString('en-IN', { maximumFractionDigits: 2 }) + 'K';
  return Math.round(n).toLocaleString('en-IN');
};
const KROW = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 };
const FROW = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16 };
// Colour follows the ENTITY, not its rank — the bars are sorted by size, so
// a rank-based colour would repaint the segments whenever the order changed.
const SEG_COLORS = { '1P': 'var(--series-1)', '3P': 'var(--series-2)', 'B2B': 'var(--series-7)' };

/* ── Plain horizontal breakdown — replaces the tapered trapezoid funnels.
      The trapezoids implied a sequential drop-off between rows that does not
      exist (1P/3P/B2B are parallel segments, not funnel stages), and clipped
      their own labels. A thin bar against a recessive track reads the same
      magnitude honestly. Ordered by size, so the ordinal ramp applies.
      Every row is direct-labelled, which is also the relief the mid-lightness
      slots need to clear the contrast check. ─────────────────────────────── */
function BarBreakdown({ title, subtitle, rows, format, palette }) {
  const fmtV = format || kmt;
  const list = (rows || []).filter(r => r && (r.value || 0) > 0).sort((a, b) => (b.value || 0) - (a.value || 0));
  const max = list.length ? (list[0].value || 1) : 1;
  const total = list.reduce((s, r) => s + (r.value || 0), 0) || 1;
  const ramp = palette || ORDINAL;
  return (
    <Card title={title} subtitle={subtitle} height="auto">
      {list.length === 0 ? <div style={{ fontSize: 12, color: 'var(--text3)' }}>No data</div> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 11, paddingTop: 2 }}>
          {list.map((r, i) => {
            const share = (r.value || 0) / total * 100;
            const w = Math.max((r.value || 0) / max * 100, 1.5);
            const col = r.color || ramp[Math.min(i, ramp.length - 1)];
            return (
              <div key={r.name}>
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginBottom: 5 }}>
                  <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text2)', overflow: 'hidden',
                                 textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
                  <span style={{ fontSize: 12, fontWeight: 800, color: 'var(--text)', whiteSpace: 'nowrap',
                                 fontVariantNumeric: 'tabular-nums' }}>
                    {fmtV(r.value || 0)}
                    <span style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text3)', marginLeft: 6 }}>{share.toFixed(1)}%</span>
                  </span>
                </div>
                <div style={{ height: 8, borderRadius: 4, background: 'var(--surface2)', overflow: 'hidden' }}>
                  <div style={{ width: `${w}%`, height: '100%', background: col, borderRadius: 4 }}/>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

/* ── Horizontal order-lifecycle funnel.
      These five outcomes carry good/bad MEANING, so they wear the reserved
      status colours rather than series hues — each with an icon and a written
      label, so the colour never carries the meaning on its own. Rows are
      widest-first; the width is the share of all orders. ─────────────────── */
const LIFECYCLE_TONE = {
  Delivered:      { icon: '✅', color: 'var(--st-good)' },
  'In Transit':   { icon: '🚚', color: 'var(--ord-2)' },
  Received:       { icon: '📥', color: 'var(--ord-1)' },
  'RTO / Returns':{ icon: '🔁', color: 'var(--st-serious)' },
  Cancelled:      { icon: '❌', color: 'var(--st-critical)' },
};

function LifecycleFunnel({ stages, onPick }) {
  const list = (stages || []).slice().sort((a, b) => (b.value || 0) - (a.value || 0));
  const max = list.length ? Math.max(list[0].value || 1, 1) : 1;
  return (
    <Card title="🚦 Order Lifecycle" subtitle="Share of all orders · click a stage to drill through" height="auto">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 2 }}>
        {list.map((s) => {
          const tone = LIFECYCLE_TONE[s.name] || { icon: '•', color: 'var(--ord-3)' };
          const w = Math.max((s.value || 0) / max * 100, 1.5);
          return (
            <div key={s.name} onClick={() => onPick && onPick(s)}
                 title={`${s.name}: ${(s.value || 0).toLocaleString('en-IN')} orders · ${s.pct.toFixed(1)}%`}
                 style={{ display: 'grid', gridTemplateColumns: '150px 1fr 120px', alignItems: 'center',
                          gap: 12, cursor: onPick ? 'pointer' : 'default' }}>
              <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text2)', display: 'flex',
                             alignItems: 'center', gap: 7, whiteSpace: 'nowrap' }}>
                <span style={{ fontSize: 13 }}>{tone.icon}</span>{s.name}
              </span>
              <div style={{ height: 22, borderRadius: 5, background: 'var(--surface2)', overflow: 'hidden' }}>
                <div style={{ width: `${w}%`, height: '100%', background: tone.color, borderRadius: 5 }}/>
              </div>
              <span style={{ fontSize: 12, fontWeight: 800, color: 'var(--text)', textAlign: 'right',
                             fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                {s.pct.toFixed(1)}%
                <span style={{ display: 'block', fontSize: 10, fontWeight: 600, color: 'var(--text3)' }}>
                  {(s.value || 0).toLocaleString('en-IN')}
                </span>
              </span>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/* ── Day-on-day / week-on-week movement table. A table, not a chart: six
      numbers with their deltas is reading work, not shape work. ─────────── */
function DeltaCell({ v }) {
  if (v === null || v === undefined || Number.isNaN(v)) {
    return <span style={{ color: 'var(--text3)' }}>—</span>;
  }
  const up = v >= 0;
  return (
    <span style={{ color: up ? 'var(--green)' : 'var(--red)', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
      {up ? '▲' : '▼'} {Math.abs(v).toFixed(1)}%
    </span>
  );
}

function DeltaTable({ rows }) {
  const TH = { textAlign: 'right', fontSize: 10, fontWeight: 700, color: 'var(--text3)',
               textTransform: 'uppercase', letterSpacing: '.04em', padding: '0 0 8px' };
  const TD = { textAlign: 'right', fontSize: 12.5, fontWeight: 700, color: 'var(--text)',
               padding: '9px 0', fontVariantNumeric: 'tabular-nums', borderTop: '1px solid var(--border)' };
  return (
    <Card title="📊 DoD & WoW" subtitle="Latest day vs previous · last 7 days vs prior 7" height="auto">
      {!rows ? <div style={{ fontSize: 12, color: 'var(--text3)' }}>Not enough history</div> : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ ...TH, textAlign: 'left' }}>Metric</th>
              <th style={TH}>Latest day</th>
              <th style={TH}>DoD</th>
              <th style={TH}>Last 7d</th>
              <th style={TH}>WoW</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.label}>
                <td style={{ ...TD, textAlign: 'left', fontWeight: 600, color: 'var(--text2)' }}>{r.label}</td>
                <td style={TD}>{r.fmt(r.day)}</td>
                <td style={TD}><DeltaCell v={r.dod}/></td>
                <td style={TD}>{r.fmt(r.week)}</td>
                <td style={TD}><DeltaCell v={r.wow}/></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

/* ── Plain stat card (label on top, big value) — matches the KPI-section mock ─ */
function StatCard({ label, value, accent, sub, title, emphasis }) {
  return (
    <div title={title} style={{ background: 'var(--surface)',
                  border: emphasis ? `1.5px solid ${accent || 'var(--accent)'}` : '1px solid var(--border)',
                  borderRadius: 'var(--r2)',
                  boxShadow: 'var(--shadow)', padding: '12px 14px', textAlign: 'center', minWidth: 0,
                  cursor: title ? 'help' : undefined }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase',
                    letterSpacing: '.03em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</div>
      <div style={{ fontFamily: 'var(--serif)', fontSize: 20, fontWeight: 800, color: accent || 'var(--text)',
                    marginTop: 4, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{value}</div>
      {sub && <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text3)', marginTop: 2,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sub}</div>}
    </div>
  );
}

// Week-on-week delta shown under the headline cards. The sparkline KPIs that
// used to carry this signal were removed as duplicates, so surface it here.
function wowSub(v) {
  if (v === undefined || v === null || Number.isNaN(v)) return null;
  return `${v >= 0 ? '▲' : '▼'} ${Math.abs(v).toFixed(0)}% WoW`;
}

function KpiSection({ title, children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {title && <div style={{ background: 'var(--accent-soft)', color: 'var(--accent)', fontWeight: 800,
                    fontSize: 12.5, textAlign: 'center', padding: '7px', borderRadius: 8, letterSpacing: '.04em' }}>{title}</div>}
      {children}
    </div>
  );
}

/* ── KPI drill-through modal: breaks the clicked metric down by Channel,
      Category and Order Status, and shows its daily trend. ─────────────────── */
function DrillModal({ drill, data, onClose }) {
  if (!drill) return null;
  const { label, field, icon } = drill;         // field ∈ 'orders' | 'revenue' | 'qty'
  const isMoney = field === 'revenue';
  const format = isMoney ? fmt : (v) => (v || 0).toLocaleString('en-IN');
  const rows = (arr) => arr.map(x => ({ name: x.name, value: x[field] || 0 })).filter(r => r.value);
  const byChan   = rows(groupArr(data, 'vco_channel_name')).slice(0, 10);
  const byCat    = rows(groupArr(data, 'parent_name')).slice(0, 10);
  const byStatus = rows(groupArr(data, 'order_status_group'));
  const trend    = groupByDate(data, 'day').slice(-30);

  return (
    <div onClick={onClose} style={{ position:'fixed', inset:0, zIndex:9600, display:'flex', alignItems:'center', justifyContent:'center', padding:20,
                                    background:'rgba(15,23,42,.5)', backdropFilter:'blur(3px)' }}>
      <div onClick={e => e.stopPropagation()} style={{ width:720, maxWidth:'96vw', maxHeight:'90vh', overflowY:'auto',
        background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--r2)', boxShadow:'var(--shadow2)', padding:'18px 20px' }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:14 }}>
          <div style={{ display:'flex', alignItems:'center', gap:10 }}>
            <span style={{ fontSize:22 }}>{icon}</span>
            <div>
              <div style={{ fontFamily:'var(--serif)', fontWeight:700, fontSize:17, color:'var(--text)' }}>{label} — drill-through</div>
              <div style={{ fontSize:11, color:'var(--text3)', marginTop:1 }}>Breakdown for the current filters</div>
            </div>
          </div>
          <button onClick={onClose} title="Close" style={{ background:'var(--surface2)', borderRadius:8, padding:6, color:'var(--text2)', display:'flex' }}><X size={16}/></button>
        </div>

        <div style={{ height:150, marginBottom:16 }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={trend} margin={{ top:4, right:8, bottom:0, left:0 }}>
              <defs><linearGradient id="dg" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#4f46e5" stopOpacity={0.25}/><stop offset="95%" stopColor="#4f46e5" stopOpacity={0}/>
              </linearGradient></defs>
              <CartesianGrid stroke="var(--grid)" vertical={false}/>
              <XAxis dataKey="date" tick={{ fill:'var(--text3)', fontSize:10 }} tickLine={false} axisLine={false}/>
              <YAxis tick={{ fill:'var(--text3)', fontSize:10 }} tickLine={false} axisLine={false} width={40} tickFormatter={isMoney ? fmtCr : undefined}/>
              <Tooltip content={<TT/>}/>
              <Area type="monotone" dataKey={field === 'qty' ? 'qty' : field === 'revenue' ? 'revenue' : 'orders'}
                    name={label} stroke="#4f46e5" strokeWidth={2} fill="url(#dg)" dot={false}/>
            </AreaChart>
          </ResponsiveContainer>
        </div>

        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
          <div><div style={{ fontSize:11, fontWeight:800, color:'var(--text3)', textTransform:'uppercase', letterSpacing:'.05em', marginBottom:8 }}>By Channel</div>
            <StatList items={byChan} format={format} colors={COLORS}/></div>
          <div><div style={{ fontSize:11, fontWeight:800, color:'var(--text3)', textTransform:'uppercase', letterSpacing:'.05em', marginBottom:8 }}>By Order Status</div>
            <StatList items={byStatus.map(s => ({ ...s, color: STATUS_COLOR[s.name] }))} format={format} colors={COLORS}/></div>
          <div style={{ gridColumn:'1 / -1' }}><div style={{ fontSize:11, fontWeight:800, color:'var(--text3)', textTransform:'uppercase', letterSpacing:'.05em', marginBottom:8 }}>By Category</div>
            <StatList items={byCat} format={format} colors={COLORS}/></div>
        </div>
      </div>
    </div>
  );
}

/* ── Category hierarchy drill-down row: parent → sub_cat → sub_sub → product ── */
function HierRow({ node, depth, maxRev }) {
  const [open, setOpen] = useState(false);
  const kids = node.children || [];
  const hasKids = kids.length > 0;
  const barW = maxRev > 0 ? (node.revenue || 0) / maxRev * 100 : 0;
  const col = COLORS[depth % COLORS.length];
  return (
    <div>
      <div style={{ display:'flex', alignItems:'center', gap:8, padding:'6px 4px 6px 0', paddingLeft: depth * 20,
                    borderBottom:'1px solid var(--border)', boxSizing:'border-box' }}>
        {hasKids ? (
          <button onClick={() => setOpen(o => !o)} title={open ? 'Collapse' : 'Expand'}
            style={{ width:18, height:18, flexShrink:0, display:'flex', alignItems:'center', justifyContent:'center',
                     background:'var(--surface2)', border:'1px solid var(--border)', borderRadius:5, color:'var(--accent)' }}>
            {open ? <Minus size={12}/> : <Plus size={12}/>}
          </button>
        ) : <span style={{ width:18, flexShrink:0 }}/>}
        <span style={{ width:9, height:9, borderRadius:3, background:col, flexShrink:0 }}/>
        <span style={{ flex:1, minWidth:60, fontSize:12.5, color:'var(--text)', fontWeight: depth === 0 ? 600 : 500,
                       overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{node.name || '—'}</span>
        <div className="hide-mobile" style={{ width:90, height:6, background:'var(--surface2)', borderRadius:4, overflow:'hidden', flexShrink:0 }}>
          <div style={{ height:'100%', width:`${barW}%`, background:col, borderRadius:4 }}/>
        </div>
        <b style={{ width:120, textAlign:'right', flexShrink:0, fontSize:12.5, color:'var(--text)', fontVariantNumeric:'tabular-nums', whiteSpace:'nowrap' }}>{fmt(node.revenue || 0)}</b>
        <span style={{ width:48, textAlign:'right', flexShrink:0, fontSize:11, color:'var(--text3)', fontVariantNumeric:'tabular-nums', whiteSpace:'nowrap' }}>{(node.revShare || 0).toFixed(1)}%</span>
      </div>
      {open && hasKids && kids.map((c, i) => (
        <HierRow key={i} node={c} depth={depth + 1} maxRev={maxRev}/>
      ))}
    </div>
  );
}

function HierTree({ nodes }) {
  const list = nodes || [];
  const maxRev = Math.max(...list.map(n => n.revenue || 0), 1);
  if (!list.length) return <div style={{ fontSize:12, color:'var(--text3)' }}>No data</div>;
  return (
    <div style={{ display:'flex', flexDirection:'column' }}>
      {list.slice(0, 15).map((n, i) => <HierRow key={i} node={n} depth={0} maxRev={maxRev}/>)}
    </div>
  );
}

export default function OverviewPage({ data, filters, goto }) {
  const [gran, setGran] = useState('day');
  const [drillStatus, setDrillStatus] = useState(null);
  const [drill, setDrill] = useState(null);            // KPI drill-through modal

  const m       = useMemo(() => metrics(data), [data]);
  const trend   = useMemo(() => groupByDate(data, gran), [data, gran]);
  const byStatus= useMemo(() => groupArr(data, 'order_status_group'), [data]);
  const byChan  = useMemo(() => groupArr(data, 'vco_channel_name'), [data]);
  const byPay   = useMemo(() => groupArr(data, 'payment_sources'), [data]);
  // Segment breakdown (orders/lines/qty/revenue per 1P/3P/B2B) — for the funnels.
  const bySeg = useMemo(() => ((data.by && data.by.purchaseLevel) || []).filter(r => ['1P', '3P', 'B2B'].includes(r.name)), [data]);
  const segRows = (measure) => bySeg.map(r => ({ name: r.name, value: r[measure] || 0, color: SEG_COLORS[r.name] }));

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

  // Share of total orders for a status count (for "% above, number below").
  const share = (n) => m.orders > 0 ? (n / m.orders * 100) : 0;

  // Order-lifecycle stages for the horizontal funnel.
  const lifecycle = useMemo(() => ([
    { name: 'Delivered',     value: m.delivered, pct: m.delivRate,        drill: 'Delivered' },
    { name: 'In Transit',    value: m.inTransit, pct: share(m.inTransit), drill: 'In Transit' },
    { name: 'Received',      value: m.received,  pct: share(m.received),  drill: 'Received' },
    { name: 'RTO / Returns', value: m.rto,       pct: m.rtoRate,          drill: 'RTO / Returns' },
    { name: 'Cancelled',     value: m.cancelled, pct: m.cancelRate,       drill: 'Cancelled' },
  ]), [m]);

  // Day-on-day and week-on-week movement for the table.
  const deltaRows = useMemo(() => {
    const d = groupByDate(data, 'day');
    if (d.length < 3) return null;
    const sum = (arr, k) => arr.reduce((s, r) => s + (r[k] || 0), 0);
    const pc = (a, b) => (b ? (a - b) / b * 100 : null);
    const cur = d[d.length - 1], prv = d[d.length - 2];
    const l7 = d.slice(-7), p7 = d.slice(-14, -7);
    const mk = (key, label, fmtFn) => ({
      label, fmt: fmtFn,
      day: cur?.[key] || 0, dod: pc(cur?.[key] || 0, prv?.[key] || 0),
      week: sum(l7, key),   wow: pc(sum(l7, key), sum(p7, key)),
    });
    const n = (v) => Math.round(v || 0).toLocaleString('en-IN');
    return [mk('orders', 'Orders', n), mk('revenue', 'Revenue', fmtCr), mk('qty', 'Qty', n)];
  }, [data]);

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
      <DrillModal drill={drill} data={data} onClose={() => setDrill(null)}/>

      <InsightBar items={[
        wow.revenue !== undefined && { icon:'📈', value:`${wow.revenue>=0?'+':''}${wow.revenue.toFixed(0)}%`, label:'revenue WoW', tone: wow.revenue>=0?'good':'bad' },
        { icon:'✅', value:pct(m.delivRate), label:'delivery rate', tone: m.delivRate>=60?'good':'bad' },
        { icon:'🔁', value:pct(m.rtoRate), label:'RTO/returns', tone: m.rtoRate>8?'bad':'good' },
        byChan[0] && { icon:'🏆', value:byChan[0].name, label:`top channel · ${pct(byChan[0].revShare)}` },
        data.movers?.category?.up?.[0] && { icon:'🚀', value:data.movers.category.up[0].name, label:'fastest-growing category' },
      ]}/>

      {/* ── Overall KPI Section — headline cards + funnel breakdowns (revenue in Cr) ── */}
      <KpiSection title="Overall KPI Section">
        <div style={KROW}>
          <StatCard label="Total Orders"  value={kmt(m.orders)}       accent="#4f46e5" sub={wowSub(wow.orders)}/>
          <StatCard label="Total Revenue" value={fmtCr(m.rev)}        accent="#16a34a" sub={wowSub(wow.revenue)}/>
          {/* Net realisable revenue — already excludes cancelled + refunded /
              returned lines, so no status filtering is needed by hand.
              Return/RTO is intentionally still counted. */}
          <StatCard label="Final Revenue" value={fmtCr(m.netRevenue)} accent="#0d9488" emphasis
                    sub={`${pct(m.netRevPct)} of gross · −${fmtCr(m.excludedRevenue)}`}
                    title={"Revenue excluding cancelled and refunded/returned money.\n\n"
                         + "Excludes any line that:\n"
                         + "  • has a refunded date\n"
                         + "  • has a cancelled date\n"
                         + "  • is Cancelled (incl. 3P 'cancelled')\n"
                         + "  • is Refunded or Returned (incl. Shipped & Returned,\n"
                         + "    3P 'returned', 'returned_failed')\n\n"
                         + "Return/RTO and Lost are NOT excluded — that revenue still counts."}/>
          {/* "Order Amount" removed — it is the same sum as Total Revenue
              (both are SUM(vc_order_item_amount)), so it only duplicated it. */}
          <StatCard label="Cancelled Amount" value={fmtCr(m.cancelledAmount)} accent="#e11d48"/>
          <StatCard label="Refund Amount"    value={fmtCr(m.refundAmount)}    accent="#ea580c"/>
          <StatCard label="Total Qty"     value={kmt(m.qty)}          accent="#2563eb" sub={wowSub(wow.qty)}/>
        </div>
      </KpiSection>

      {/* ── Order economics. Total Qty lives in the headline row above. ── */}
      <KpiSection>
        <div style={KROW}>
          <StatCard label="Total Line Item"   value={kmt(m.lines)}/>
          <StatCard label="ASP"               value={fmtCr(m.asp)}/>
          <StatCard label="AOV"               value={fmtCr(m.aov)}/>
          <StatCard label="COD %"             value={pct(m.codPct)}/>
          <StatCard label="Shipping Charges"  value={fmtCr(m.delCharges)}/>
        </div>
      </KpiSection>

      {/* ── Order lifecycle (horizontal funnel) + segment splits.
             The status KPI cards that used to sit here said the same thing in
             six separate tiles; the funnel shows the same five outcomes with
             their relative size visible at a glance. ── */}
      <div style={{ display:'grid', gridTemplateColumns:'minmax(0,1.35fr) minmax(0,1fr)', gap:16 }}>
        <LifecycleFunnel stages={lifecycle}
          onPick={(s)=>setDrill({ label:s.drill, field:'orders', icon:(LIFECYCLE_TONE[s.name]||{}).icon || '•' })}/>
        <BarBreakdown title="🧾 Amount Flow" subtitle="Gross → deductions → realised (Cr)" format={fmtCr} rows={[
          { name:'Total Revenue',    value:m.rev,             color:'var(--ord-2)' },
          { name:'Cancelled Amount', value:m.cancelledAmount, color:'var(--st-critical)' },
          { name:'Refund Amount',    value:m.refundAmount,    color:'var(--st-serious)' },
          { name:'Final Revenue',    value:m.netRevenue,      color:'var(--st-good)' },
        ]}/>
      </div>

      <div style={FROW}>
        <BarBreakdown title="🗂️ Orders by Segment"  format={kmt}   rows={segRows('orders')}/>
        <BarBreakdown title="💰 Revenue by Segment" subtitle="Cr" format={fmtCr} rows={segRows('revenue')}/>
        <BarBreakdown title="📦 Qty by Segment"     format={kmt}   rows={segRows('qty')}/>
      </div>

      {/* ── Orders by Channel raised above the DoD/WoW movement table. ── */}
      <div style={{ display:'grid', gridTemplateColumns:'minmax(0,1fr) minmax(0,1fr)', gap:16 }}>
        <Card title="📡 Orders by Channel" subtitle="Orders & share of total" height="auto">
          <StatList items={byChan.slice(0, 8).map(c => ({ name: c.name, value: c.orders }))} colors={COLORS}/>
        </Card>
        <DeltaTable rows={deltaRows}/>
      </div>

      {/* ── Trend + Funnel ── */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 320px', gap:16 }}>
        <Card title={`${drillStatus ? `📌 Drill: ${drillStatus}` : '📈 Trend'}`}
          subtitle={drillStatus ? `Click funnel bar to change · Click again to reset` : 'Orders & qty over time'}
          height={260}
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
              <CartesianGrid stroke="var(--grid)" vertical={false}/>
              <XAxis dataKey="date" tick={{ fill:'var(--text3)', fontSize:10 }} tickLine={false} axisLine={false}/>
              <YAxis tick={{ fill:'var(--text3)', fontSize:10 }} tickLine={false} axisLine={false} width={35}/>
              <Tooltip content={<TT/>}/>
              <Legend wrapperStyle={{ fontSize:11, paddingTop:6 }} iconType="plainline"/>
              <Area type="monotone" dataKey="orders" name="Orders" stroke="#4f46e5" strokeWidth={2} fill="url(#ga)" dot={false}/>
              <Area type="monotone" dataKey="qty"    name="Qty"    stroke="#059669" strokeWidth={2} fill="url(#gb)" dot={false}/>
            </AreaChart>
          </ResponsiveContainer>
        </Card>

        <Card title="🚦 Status Funnel" subtitle="Click to drill into status" height={260}>
          <div style={{ paddingTop:6 }}>
            {byStatus.map(s => (
              <FunnelBar key={s.name} label={s.name} value={s.orders} total={m.orders}
                color={STATUS_COLOR[s.name]||'var(--accent)'}
                onClick={()=>setDrillStatus(drillStatus===s.name ? null : s.name)}/>
            ))}
          </div>
        </Card>
      </div>

      {/* ── Monthly Revenue (the Order Status Detail list that sat beside it was
             removed — the Status Funnel above already breaks orders down by
             status, and it is clickable). ── */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr', gap:16 }}>
        <Card title="📅 Monthly Revenue" height={220}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={groupByDate(data,'month')} margin={{ top:4, right:8, bottom:0, left:8 }} barCategoryGap="12%">
              <CartesianGrid stroke="var(--grid)" vertical={false}/>
              <XAxis dataKey="date" tick={{ fill:'var(--text3)', fontSize:10 }} tickLine={false} axisLine={false}/>
              <YAxis tick={{ fill:'var(--text3)', fontSize:10 }} tickLine={false} axisLine={false} width={80} tickFormatter={fmtCr}/>
              <Tooltip content={<TT/>} cursor={{ fill:'var(--surface2)' }}/>
              <Bar dataKey="revenue" name="Revenue" fill="#4f46e5" radius={[4,4,0,0]} maxBarSize={64}/>
            </BarChart>
          </ResponsiveContainer>
        </Card>
      </div>

      {/* ── Orders by Payment (Channel moved up, above the DoD/WoW table) ── */}
      <Card title="💳 Orders by Payment" subtitle="Orders & share of total" height="auto">
        <StatList items={byPay.map(p => ({ name: p.name, value: p.orders }))} colors={COLORS}/>
      </Card>

      {/* ── Top Categories by Revenue — click + to drill parent → sub-cat → sub-sub → product ── */}
      <Card title="📚 Top Categories by Revenue" subtitle="Click + to drill down: parent → sub-category → sub-sub → product" height="auto">
        <HierTree nodes={data.hierarchy}/>
      </Card>

      {/* ── Top Movers, last — closing note on the page rather than a mid-page
             interruption between the KPIs and the charts. ── */}
      <MoversCard title="🚀 Top Movers — Categories" movers={data.movers && data.movers.category}/>
    </div>
  );
}
