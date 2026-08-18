import React, { useMemo, useState } from 'react';
import { AreaChart, Area, BarChart, Bar, ResponsiveContainer, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import { X } from 'lucide-react';
import { Card, StatList, InsightBar, DataTable } from '../components/UI';
import { metrics, groupArr, groupByDate, fmt, fmtCr, pct, full, fullMoney, STATUS_COLOR, COLORS, ORDINAL, FILTER_OPTIONS } from '../utils/dataEngine';

const TT = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  // Same formatting as the axis — the tooltip previously showed the raw ISO
  // string while the axis read "1-Apr", so the two disagreed.
  return <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:8, padding:'10px 14px', fontSize:11, boxShadow:'var(--shadow2)' }}>
    <div style={{ color:'var(--accent)', fontWeight:700, marginBottom:5 }}>{shortDate(label)}</div>
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
/* Axis dates as "1-Aug" / "Aug-26" rather than the raw ISO string, which is
   both long and hard to scan. Handles day (YYYY-MM-DD) and month (YYYY-MM). */
// The Trend chart scrolls horizontally so no period is skipped. Width per point
// varies by granularity — a day label ("18-Aug") needs less room than a month
// one, and 140 days cannot share a card width without dropping labels.
const PX_PER_POINT = { day: 34, week: 58, month: 90 };
const AXIS_W = 46;     // gutter for the pinned y-axis
const PLOT_X_H = 26;   // x-axis band height, identical in both layers so the
                       // pinned axis lines up with the scrolling plot
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function shortDate(v) {
  if (typeof v !== 'string') return v;
  const p = v.split('-');
  if (p.length >= 3) return `${Number(p[2])}-${MON[Number(p[1]) - 1] || p[1]}`;
  if (p.length === 2) return `${MON[Number(p[1]) - 1] || p[1]}-${p[0].slice(2)}`;
  return v;
}

const KROW = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 };
const FROW = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16 };
// Colour follows the ENTITY, not its rank — the bars are sorted by size, so
// a rank-based colour would repaint the segments whenever the order changed.
const SEG_COLORS = { '1P': 'var(--series-1)', '3P': 'var(--series-2)', 'B2B': 'var(--series-7)' };

/* ── Tapered funnel box (the original segment look).
      The three segment cards sit side by side and must line up, so the
      geometry is FIXED rather than derived per card:
        · every card declares the same `unit` sub-line (even when blank), so
          one card carrying a unit does not push its funnel down relative to
          the others — that was the visible misalignment;
        · the widest band is always FUNNEL_TOP_W and the narrowest
          FUNNEL_MIN_W, so all three taper across the same span whatever the
          underlying spread;
        · rows are a fixed height, so the cards end at the same baseline.
      Colored trapezoid layer + a non-clipped text overlay keeps labels
      readable even in the narrow bands. ─────────────────────────────────── */
const FUNNEL_ROW_H = 52;
const FUNNEL_TOP_W = 94;   // % width of the widest band
const FUNNEL_MIN_W = 44;   // % width of the narrowest band (floor, so labels fit)
const FUNNEL_TAIL  = 34;   // % width the last band tapers down to

function FunnelChart({ title, unit = '', rows, format }) {
  const fmtV = format || kmt;
  const list = (rows || []).filter(r => r && (r.value || 0) > 0).sort((a, b) => (b.value || 0) - (a.value || 0));
  const total = list.reduce((s, r) => s + (r.value || 0), 0) || 1;
  const hi = list.length ? (list[0].value || 1) : 1;
  const lo = list.length ? (list[list.length - 1].value || 0) : 0;
  // Map [lo..hi] onto [FUNNEL_MIN_W..FUNNEL_TOP_W] so every card spans the
  // same visual range; without this a card whose values are close together
  // rendered as a near-rectangle beside one that tapered sharply.
  const w = (v) => {
    if (hi <= lo) return FUNNEL_TOP_W;
    const t = ((v || 0) - lo) / (hi - lo);
    return FUNNEL_MIN_W + t * (FUNNEL_TOP_W - FUNNEL_MIN_W);
  };
  return (
    <Card title={title} height="auto">
      {/* Always rendered, even when empty — this is what keeps the three
          funnels on the same baseline. */}
      <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: -8, marginBottom: 8, minHeight: 15 }}>
        {unit || ' '}
      </div>
      {list.length === 0 ? <div style={{ fontSize: 12, color: 'var(--text3)' }}>No data</div> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {list.map((r, i) => {
            const top = w(r.value);
            const bot = i < list.length - 1 ? w(list[i + 1].value) : FUNNEL_TAIL;
            const col = r.color || ORDINAL[Math.min(i, ORDINAL.length - 1)];
            const p = (r.value || 0) / total * 100;
            return (
              <div key={r.name} title={`${r.name}: ${fmtV(r.value || 0)} · ${p.toFixed(1)}%`}
                   style={{ position: 'relative', height: FUNNEL_ROW_H }}>
                <div style={{ position: 'absolute', inset: 0, background: col,
                              clipPath: `polygon(${(100 - top) / 2}% 0, ${(100 + top) / 2}% 0, ${(100 + bot) / 2}% 100%, ${(100 - bot) / 2}% 100%)` }}/>
                <div style={{ position: 'relative', height: '100%', display: 'flex', flexDirection: 'column',
                              alignItems: 'center', justifyContent: 'center', lineHeight: 1.15, color: '#fff',
                              textAlign: 'center', padding: '0 8px', textShadow: '0 1px 2px rgba(0,0,0,.45)' }}>
                  <span style={{ fontSize: 15, fontWeight: 800, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{fmtV(r.value || 0)}</span>
                  <span style={{ fontSize: 9.5, fontWeight: 600, opacity: 0.95, whiteSpace: 'nowrap' }}>{r.name} · {p.toFixed(1)}%</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

/* ── Ranked horizontal breakdown — used for Channel and Payment.
      Rank + swatch + name on one line, bar and figures beneath, so long
      channel names never fight the numbers for space.
      The swatch colour is keyed to the entity's position in the FULL option
      list, not to its rank in this view — filtering to fewer channels must
      not repaint the survivors. ────────────────────────────────────────── */
function RankedBars({ items, format, exactFormat, colorKey, onPick, active }) {
  const fmtV = format || ((v) => (v || 0).toLocaleString('en-IN'));
  const list = (items || []).filter(r => (r.value || 0) > 0).sort((a, b) => b.value - a.value);
  if (!list.length) return <div style={{ fontSize: 12, color: 'var(--text3)' }}>No data</div>;
  const max = list[0].value || 1;
  const total = list.reduce((s, r) => s + (r.value || 0), 0) || 1;
  const slot = (name, i) => {
    const all = (colorKey && FILTER_OPTIONS[colorKey]) || [];
    const idx = all.indexOf(name);
    return COLORS[((idx >= 0 ? idx : i) % COLORS.length)];
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
      {list.map((r, i) => {
        const share = (r.value || 0) / total * 100;
        return (
          <div key={r.name} onClick={() => onPick && onPick(r.name)}
               title={`${r.name}: ${(exactFormat || fmtV)(r.value)} · ${share.toFixed(1)}%`
                      + (onPick ? '\nClick to filter the dashboard to this' : '')}
               style={{ cursor: onPick ? 'pointer' : 'default', borderRadius: 8,
                        padding: onPick ? '4px 6px' : 0, margin: onPick ? '0 -6px' : 0,
                        background: active === r.name ? 'var(--accent-soft)' : 'transparent' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 6 }}>
              <span style={{ fontSize: 10, fontWeight: 800, color: 'var(--text3)', width: 16,
                             fontVariantNumeric: 'tabular-nums' }}>{i + 1}</span>
              <span style={{ width: 9, height: 9, borderRadius: 3, background: slot(r.name, i), flexShrink: 0 }}/>
              <span style={{ flex: 1, fontSize: 12.5, fontWeight: 700, color: 'var(--text)', overflow: 'hidden',
                             textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
              <span style={{ fontSize: 12.5, fontWeight: 800, color: 'var(--text)', whiteSpace: 'nowrap',
                             fontVariantNumeric: 'tabular-nums' }}>{fmtV(r.value)}</span>
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text3)', width: 46, textAlign: 'right',
                             fontVariantNumeric: 'tabular-nums' }}>{share.toFixed(1)}%</span>
            </div>
            <div style={{ height: 7, borderRadius: 4, background: 'var(--surface2)', overflow: 'hidden', marginLeft: 25 }}>
              <div style={{ width: `${Math.max(r.value / max * 100, 1.5)}%`, height: '100%',
                            background: slot(r.name, i), borderRadius: 4 }}/>
            </div>
          </div>
        );
      })}
    </div>
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
  // Compact: 7 columns in one card, so the padding is trimmed and the numbers
  // sit closer together rather than drifting apart across the width.
  // width:1% makes each numeric column shrink to its content; the Metric column
  // has no width and so absorbs the slack. Without it the browser shares the
  // full card width evenly and the figures drift far apart.
  const TH = { textAlign: 'right', fontSize: 9.5, fontWeight: 700, color: 'var(--text3)',
               textTransform: 'uppercase', letterSpacing: '.03em', padding: '0 0 5px 18px',
               whiteSpace: 'nowrap', width: '1%' };
  const TD = { textAlign: 'right', fontSize: 12, fontWeight: 700, color: 'var(--text)',
               padding: '5px 0 5px 18px', fontVariantNumeric: 'tabular-nums',
               borderTop: '1px solid var(--border)', whiteSpace: 'nowrap', width: '1%' };
  return (
    <Card title="📊 DoD & WoW" subtitle="Latest day vs yesterday · last 7 days vs the 7 before" height="auto">
      {!rows ? <div style={{ fontSize: 12, color: 'var(--text3)' }}>Not enough history</div> : (
        <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'auto' }}>
          <thead>
            <tr>
              <th style={{ ...TH, textAlign: 'left', width: 'auto', paddingLeft: 0 }}>Metric</th>
              <th style={TH}>Latest day</th>
              <th style={TH}>Yesterday</th>
              <th style={TH}>DoD</th>
              <th style={TH}>Last 7d</th>
              <th style={TH}>Prior 7d</th>
              <th style={TH}>WoW</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.label}>
                <td style={{ ...TD, textAlign: 'left', fontWeight: 600, color: 'var(--text2)', width: 'auto', paddingLeft: 0 }}>{r.label}</td>
                <td style={TD}>{r.fmt(r.day)}</td>
                <td style={{ ...TD, color: 'var(--text2)', fontWeight: 600 }}>{r.fmt(r.prevDay)}</td>
                <td style={TD}><DeltaCell v={r.dod}/></td>
                <td style={TD}>{r.fmt(r.week)}</td>
                <td style={{ ...TD, color: 'var(--text2)', fontWeight: 600 }}>{r.fmt(r.prevWeek)}</td>
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

        <div style={{ display:'grid', gridTemplateColumns:'minmax(0,1fr) minmax(0,1fr)', gap:16 }}>
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


export default function OverviewPage({ data, filters, goto, drillTo }) {
  const [gran, setGran] = useState('day');
  const [drill, setDrill] = useState(null);            // KPI drill-through modal

  const m       = useMemo(() => metrics(data), [data]);
  // Sorted defensively. The server already returns these ascending (verified
  // for day/week/month), but a chart that silently plots out of order is very
  // hard to spot, and the sort is free at these sizes.
  const trend = useMemo(
    () => [...(groupByDate(data, gran) || [])].sort((a, b) => String(a.date).localeCompare(String(b.date))),
    [data, gran]);
  const byChan  = useMemo(() => groupArr(data, 'vco_channel_name'), [data]);
  const byPay   = useMemo(() => groupArr(data, 'payment_sources'), [data]);
  // Server sends this only when a B2B channel is in the filter.
  const custRows = useMemo(() => (data && data.customers) || [], [data]);
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

  // Prepaid share, computed the same way the server computes codPct: distinct
  // orders on that payment mode over distinct orders overall. by.payment's
  // `orders` is already a distinct count per mode, so the two agree.
  const prepaidOrders = useMemo(
    () => (byPay.find(p => p.name === 'Prepaid') || {}).orders || 0, [byPay]);
  const prepaidPct = m.orders > 0 ? prepaidOrders / m.orders * 100 : 0;

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
    // The comparison bases are shown, not just the percentages — a "-40% DoD"
    // means something different against 12 orders than against 12,000.
    const mk = (key, label, fmtFn) => ({
      label, fmt: fmtFn,
      day:  cur?.[key] || 0, prevDay:  prv?.[key] || 0, dod: pc(cur?.[key] || 0, prv?.[key] || 0),
      week: sum(l7, key),    prevWeek: sum(p7, key),    wow: pc(sum(l7, key), sum(p7, key)),
    });
    const n = (v) => Math.round(v || 0).toLocaleString('en-IN');
    return [mk('orders', 'Orders', n), mk('revenue', 'Revenue', fmtCr), mk('qty', 'Qty', n)];
  }, [data]);

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:14, minWidth:0, maxWidth:'100%' }}>
      <DrillModal drill={drill} data={data} onClose={() => setDrill(null)}/>

      <InsightBar items={[
        wow.revenue !== undefined && { icon:'📈', value:`${wow.revenue>=0?'+':''}${wow.revenue.toFixed(0)}%`, label:'revenue WoW', tone: wow.revenue>=0?'good':'bad' },
        { icon:'✅', value:pct(m.delivRate), label:'delivery rate', tone: m.delivRate>=60?'good':'bad' },
        { icon:'🔁', value:pct(m.rtoRate), label:'RTO/returns', tone: m.rtoRate>8?'bad':'good' },
        byChan[0] && { icon:'🏆', value:byChan[0].name, label:`top channel · ${pct(byChan[0].revShare)}` },
      ]}/>

      {/* ── Overall KPI Section — headline cards + funnel breakdowns (revenue in Cr) ── */}
      <KpiSection title="Overall KPI Section">
        <div style={KROW}>
          <StatCard label="Total Orders"  value={kmt(m.orders)}       accent="#4f46e5" sub={wowSub(wow.orders)} title={`Total Orders
${full(m.orders)}`}/>
          <StatCard label="Total Revenue" value={fmtCr(m.rev)}        accent="#16a34a" sub={wowSub(wow.revenue)} title={`Total Revenue
${fullMoney(m.rev)}`}/>
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
          <StatCard label="Cancelled Amount" value={fmtCr(m.cancelledAmount)} accent="#e11d48" title={`Cancelled Amount
${fullMoney(m.cancelledAmount)}`}/>
          <StatCard label="Refund Amount"    value={fmtCr(m.refundAmount)}    accent="#ea580c" title={`Refund Amount
${fullMoney(m.refundAmount)}`}/>
          <StatCard label="Total Qty"     value={kmt(m.qty)}          accent="#2563eb" sub={wowSub(wow.qty)} title={`Total Qty
${full(m.qty)}`}/>
        </div>
      </KpiSection>

      {/* ── Order economics. Total Qty lives in the headline row above. ── */}
      <KpiSection>
        <div style={KROW}>
          <StatCard label="Total Line Item"   value={kmt(m.lines)} title={`Total Line Item
${full(m.lines)}`}/>
          <StatCard label="ASP"               value={fmtCr(m.asp)} title={`ASP
${fullMoney(m.asp)}`}/>
          <StatCard label="AOV"               value={fmtCr(m.aov)} title={`AOV
${fullMoney(m.aov)}`}/>
          <StatCard label="COD %"             value={pct(m.codPct)} title={`COD %
${full(m.cod)} COD orders`}/>
          <StatCard label="Prepaid %"         value={pct(prepaidPct)} title={`Prepaid %
${full(prepaidOrders)} prepaid orders`}/>
          <StatCard label="Shipping Charges"  value={fmtCr(m.delCharges)} title={`Shipping Charges
${fullMoney(m.delCharges)}`}/>
        </div>
      </KpiSection>

      {/* ── Order lifecycle (horizontal funnel) + segment splits.
             The status KPI cards that used to sit here said the same thing in
             six separate tiles; the funnel shows the same five outcomes with
             their relative size visible at a glance. ── */}
      <LifecycleFunnel stages={lifecycle}
        onPick={(s)=>setDrill({ label:s.drill, field:'orders', icon:(LIFECYCLE_TONE[s.name]||{}).icon || '•' })}/>

      {/* Segment splits — funnel boxes, as originally designed. */}
      {/* All three declare a `unit` line (blank where there is none) so their
          funnels start at the same y and end on the same baseline. */}
      <div style={FROW}>
        <FunnelChart title="🗂️ Orders by Segment"  unit="orders"      format={kmt}   rows={segRows('orders')}/>
        <FunnelChart title="💰 Revenue by Segment" unit="₹ crore"      format={fmtCr} rows={segRows('revenue')}/>
        <FunnelChart title="📦 Qty by Segment"     unit="units"        format={kmt}   rows={segRows('qty')}/>
      </div>

      {/* ── Orders by Channel raised above the DoD/WoW movement table. ── */}
      <div style={{ display:'grid', gridTemplateColumns:'minmax(0,1fr) minmax(0,1fr)', gap:16 }}>
        <Card title="💰 Revenue by Channel" subtitle="Ranked by revenue · click a row to filter the dashboard" height="auto">
          <RankedBars colorKey="channels" format={fmtCr} exactFormat={fullMoney}
            onPick={(n) => drillTo && drillTo({ channels: [n] })}
            active={(filters?.channels || []).length === 1 ? filters.channels[0] : null}
            items={byChan.slice(0, 8).map(c => ({ name: c.name, value: c.revenue }))}/>
        </Card>
        <DeltaTable rows={deltaRows}/>
      </div>

      {/* ── Trend (full width; the Status Funnel beside it was removed, and with
             it the click-to-drill-by-status plumbing it was the only trigger for.
             The Order Lifecycle funnel above covers the same breakdown). ── */}
      <div style={{ display:'grid', gridTemplateColumns:'minmax(0, 1fr)', gap:16, minWidth:0 }}>
        <Card title="📈 Trend"
          subtitle="Orders & qty over time · scroll sideways for every day"
          height={260}
          style={{ minWidth:0, overflow:'hidden' }}
          right={
            <div style={{ display:'flex', gap:4, flexWrap:'wrap' }}>
              {['day','week','month'].map(g=>(
                <button key={g} onClick={()=>setGran(g)} style={{ padding:'3px 10px', borderRadius:5, fontSize:10, fontWeight:700, background:gran===g?'var(--accent)':'var(--surface2)', color:gran===g?'#fff':'var(--text2)', border:'1px solid var(--border)' }}>{g.charAt(0).toUpperCase()+g.slice(1)}</button>
              ))}
            </div>
          }>
          {/* Horizontal scroll so EVERY period gets a label. 140 days cannot
              share a card width without dropping labels, so the plot is given
              the width it needs and the card scrolls. The y-axis is drawn again
              in a pinned layer on the left — otherwise it scrolls out of view
              and the values become unreadable as soon as you move right. */}
          <div style={{ position:'relative', height:'100%' }}>
            <div style={{ position:'absolute', left:0, top:0, bottom:0, width:AXIS_W, zIndex:2,
                          background:'var(--surface)', pointerEvents:'none' }}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={trend} margin={{ top:4, right:0, bottom:0, left:0 }}>
                  <YAxis tick={{ fill:'var(--text3)', fontSize:9.5 }} tickLine={false} axisLine={false} width={AXIS_W}/>
                  <XAxis dataKey="date" tick={false} axisLine={false} tickLine={false} height={PLOT_X_H}/>
                  <Area dataKey="orders" stroke="none" fill="none"/>
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <div style={{ height:'100%', overflowX:'auto', overflowY:'hidden' }}>
              <div style={{ height:'100%', minWidth:'100%',
                            width: trend.length * (PX_PER_POINT[gran] || 34) + AXIS_W }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={trend} margin={{ top:4, right:8, bottom:0, left:0 }}>
              <defs>
                <linearGradient id="ga" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--series-1)" stopOpacity={0.22}/><stop offset="95%" stopColor="var(--series-1)" stopOpacity={0}/>
                </linearGradient>
                <linearGradient id="gb" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--series-3)" stopOpacity={0.22}/><stop offset="95%" stopColor="var(--series-3)" stopOpacity={0}/>
                </linearGradient>
              </defs>
              <CartesianGrid stroke="var(--grid)" vertical={false}/>
              {/* Day granularity packs ~140 labels onto the axis; small type
                  plus a computed interval keeps them from colliding. */}
              {/* interval={0} = every label drawn, none skipped. The scroll
                  container above supplies the width that makes that legible. */}
              <XAxis dataKey="date" tick={{ fill:'var(--text3)', fontSize:9 }} tickLine={false} axisLine={false}
                     interval={0} tickFormatter={shortDate} height={PLOT_X_H}/>
              <YAxis tick={false} axisLine={false} tickLine={false} width={AXIS_W}/>
              <Tooltip content={<TT/>}/>
              <Legend wrapperStyle={{ fontSize:11, paddingTop:6 }} iconType="plainline"/>
              <Area type="monotone" dataKey="orders" name="Orders" stroke="var(--series-1)" strokeWidth={2} fill="url(#ga)" dot={false}/>
              <Area type="monotone" dataKey="qty"    name="Qty"    stroke="var(--series-3)" strokeWidth={2} fill="url(#gb)" dot={false}/>
            </AreaChart>
          </ResponsiveContainer>
              </div>
            </div>
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
              <XAxis dataKey="date" tick={{ fill:'var(--text3)', fontSize:10 }} tickLine={false} axisLine={false} tickFormatter={shortDate}/>
              <YAxis tick={{ fill:'var(--text3)', fontSize:10 }} tickLine={false} axisLine={false} width={80} tickFormatter={fmtCr}/>
              <Tooltip content={<TT/>} cursor={{ fill:'var(--surface2)' }}/>
              <Bar dataKey="revenue" name="Revenue" fill="var(--series-1)" radius={[4,4,0,0]} maxBarSize={64}/>
            </BarChart>
          </ResponsiveContainer>
        </Card>
      </div>

      {/* ── Orders by Payment (Channel moved up, above the DoD/WoW table) ── */}
      <Card title="💳 Revenue by Payment Mode" subtitle="Ranked by revenue · click a row to filter the dashboard" height="auto">
        <RankedBars colorKey="payments" format={fmtCr} exactFormat={fullMoney}
          onPick={(n) => drillTo && drillTo({ payments: [n] })}
          active={(filters?.payments || []).length === 1 ? filters.payments[0] : null}
          items={byPay.map(p => ({ name: p.name, value: p.revenue }))}/>
      </Card>

      {/* ── B2B customers. Rendered only when the view is scoped to a B2B
             channel — PW_Store is retail and the 3P feed carries no customer,
             so the server returns an empty list for those and this disappears. ── */}
      {custRows.length > 0 && (
        <DataTable
          title="🏢 B2B Customers"
          subtitle="Named accounts in the current B2B selection"
          data={custRows}
          searchKeys={['customer']}
          searchPlaceholder="Search customer…"
          columns={[
            { key:'customer', label:'Customer', bold:true, w:320, maxW:320, wrap:true },
            { key:'orders',   label:'Orders',   right:true, render:v=>(v||0).toLocaleString('en-IN') },
            { key:'qty',      label:'Qty',      right:true, render:v=>Math.round(v||0).toLocaleString('en-IN') },
            { key:'revenue',  label:'Revenue',  right:true, render:v=>fmt(v) },
            { key:'revShare', label:'Rev %',    right:true, render:v=>`${(v||0).toFixed(1)}%` },
            { key:'aov',      label:'AOV',      right:true, render:v=>fmt(v) },
          ]}
          filename="b2b_customers"
          maxH={520}
        />
      )}
    </div>
  );
}
