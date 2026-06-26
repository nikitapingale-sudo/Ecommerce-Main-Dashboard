import React, { useState, useMemo } from 'react';
import { Download, ChevronUp, ChevronDown, ChevronsUpDown, TrendingUp, TrendingDown, Search, X, Loader2 } from 'lucide-react';
import { downloadExcel, fmt } from '../utils/dataEngine';

/* ── Reusable search box (used by tables & pages) ─────────────────────────── */
export function SearchBox({ value, onChange, placeholder = 'Search…', width = 240, autoFocus }) {
  const [focus, setFocus] = useState(false);
  return (
    <div style={{ position:'relative', width, maxWidth:'100%' }}>
      <Search size={14} style={{ position:'absolute', left:10, top:'50%', transform:'translateY(-50%)', color: focus ? 'var(--accent)' : 'var(--text3)', pointerEvents:'none' }}/>
      <input
        value={value}
        autoFocus={autoFocus}
        onChange={e => onChange(e.target.value)}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        placeholder={placeholder}
        style={{
          width:'100%', padding:'7px 28px 7px 30px', fontSize:12.5,
          background:'var(--surface)', color:'var(--text)',
          border:`1px solid ${focus ? 'var(--accent)' : 'var(--border)'}`,
          borderRadius:8, outline:'none',
          boxShadow: focus ? '0 0 0 3px var(--accent-soft)' : 'none',
          transition:'border-color .15s, box-shadow .15s',
        }}/>
      {value && (
        <button onClick={() => onChange('')} title="Clear"
          style={{ position:'absolute', right:6, top:'50%', transform:'translateY(-50%)', display:'flex',
                   background:'transparent', color:'var(--text3)', padding:2, borderRadius:6 }}>
          <X size={13}/>
        </button>
      )}
    </div>
  );
}

/* ── Top Movers card (gainers / decliners, period-over-period) ─────────────── */
function MoverList({ title, rows, positive }) {
  const col = positive ? 'var(--green)' : 'var(--red)';
  return (
    <div>
      <div style={{ fontSize:11, fontWeight:800, color:col, letterSpacing:'.04em', marginBottom:8 }}>{title}</div>
      {(!rows || rows.length === 0) ? <div style={{ fontSize:12, color:'var(--text3)' }}>No data</div> : rows.map((r,i) => (
        <div key={i} style={{ display:'flex', alignItems:'center', gap:8, padding:'6px 0', borderBottom:'1px solid var(--border)' }}>
          <span style={{ flex:1, minWidth:0, fontSize:12.5, color:'var(--text)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{r.name}</span>
          <span style={{ fontSize:11, color:'var(--text3)', fontVariantNumeric:'tabular-nums' }}>{fmt(r.cur)}</span>
          <span style={{ fontSize:11, fontWeight:700, color:col, fontVariantNumeric:'tabular-nums', minWidth:50, textAlign:'right' }}>
            {r.deltaPct >= 0 ? '+' : ''}{Math.abs(r.deltaPct) > 999 ? '999+' : r.deltaPct.toFixed(0)}%
          </span>
        </div>
      ))}
    </div>
  );
}

export function MoversCard({ title, subtitle, movers }) {
  if (!movers || ((movers.up || []).length === 0 && (movers.down || []).length === 0)) return null;
  return (
    <Card title={title} subtitle={subtitle || `Revenue change · last 30 days vs previous 30 (${movers.window || ''})`} height="auto">
      <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
        <MoverList title="▲ Gainers" rows={movers.up} positive/>
        <div style={{ borderTop:'1px solid var(--border)' }}/>
        <MoverList title="▼ Decliners" rows={movers.down}/>
      </div>
    </Card>
  );
}

/* ── KPI Grid: responsive — fits as many equal cards as the width allows,
      shows all `cols` on desktop, and gracefully drops to 2 (then 1) on phones. */
export function KPIGrid({ children, cols = 3 }) {
  return (
    <div className="kpi-grid" style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 168px), 1fr))',
      gap: 12,
    }}>
      {children}
    </div>
  );
}

/* ── Sparkline — tiny inline trend chart (no deps) ────────────────────────────
   full=true  → stretches to the container width (used as a strip under a KPI).
   full=false → fixed pixel width (inline use).                                */
export function Sparkline({ data, color = '#4f46e5', width = 120, height = 26, full = false }) {
  const vals = (data || []).map(Number).filter(v => !isNaN(v));
  if (vals.length < 2) return null;
  const W = full ? 200 : width;            // viewBox width; scales when full
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = (max - min) || 1;
  const stepX = W / (vals.length - 1);
  const pad = 2;
  const pts = vals.map((v, i) => [i * stepX, height - pad - ((v - min) / span) * (height - pad * 2)]);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const area = `${line} L${W},${height} L0,${height} Z`;
  const last = pts[pts.length - 1];
  if (full) {
    return (
      <svg width="100%" height={height} viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" style={{ display: 'block' }} aria-hidden>
        <path d={area} fill={color} opacity={0.1} />
        <path d={line} fill="none" stroke={color} strokeWidth={1.6} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" opacity={0.9} />
      </svg>
    );
  }
  return (
    <svg width={width} height={height} style={{ flexShrink: 0, overflow: 'visible' }} aria-hidden>
      <path d={area} fill={color} opacity={0.1} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" opacity={0.9} />
      <circle cx={last[0]} cy={last[1]} r={2} fill={color} />
    </svg>
  );
}

/* ── KPI Card — compact tile: tinted icon + label + big number ────────────── */
export function KPI({ label, value, sub, color = '#4f46e5', icon, onClick, trend, spark, sparkColor }) {
  const [hov, setHov] = useState(false);
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--r2)',
        padding: '13px 15px',
        display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 9,
        cursor: onClick ? 'pointer' : 'default',
        boxShadow: hov ? 'var(--shadow2)' : 'var(--shadow)',
        transform: hov && onClick ? 'translateY(-1px)' : 'none',
        transition: 'all 0.16s ease',
        minWidth: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 13, minWidth: 0 }}>
        {icon && (
          <div style={{ width: 40, height: 40, borderRadius: 11, flexShrink: 0, fontSize: 19,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        background: color + '18', color }}>{icon}</div>
        )}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 11, color: 'var(--text3)', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</div>
          {/* Full-width line — number never gets clipped now */}
          <div style={{ fontFamily:'var(--serif)', fontSize: 22, fontWeight: 700, color: 'var(--text)', lineHeight: 1.2, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{value}</div>
          <div style={{ display:'flex', alignItems:'center', gap:6, marginTop:2, minWidth:0 }}>
            {trend !== undefined && trend !== null && (
              <span style={{ display:'inline-flex', alignItems:'center', gap:2, fontSize:10.5, fontWeight:700, flexShrink:0,
                             color: trend >= 0 ? 'var(--green)' : 'var(--red)',
                             background: trend >= 0 ? 'var(--green-bg)' : 'var(--red-bg)', borderRadius:5, padding:'1px 5px' }}>
                {trend >= 0 ? <TrendingUp size={10}/> : <TrendingDown size={10}/>}{trend >= 0 ? '+' : ''}{trend.toFixed(1)}%
              </span>
            )}
            {sub && <span style={{ fontSize: 10.5, color: 'var(--text3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sub}</span>}
          </div>
        </div>
      </div>
      {spark && spark.length > 1 && (
        <div style={{ marginTop: 1 }}><Sparkline data={spark} color={sparkColor || color} full height={24}/></div>
      )}
    </div>
  );
}

/* ── Highlight the matched part of a cell value while searching ────────────── */
function highlightMatch(value, query) {
  const s = value == null ? '—' : String(value);
  const q = (query || '').trim();
  if (!q) return s;
  const idx = s.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return s;
  return (
    <>
      {s.slice(0, idx)}
      <mark style={{ background:'var(--accent-soft)', color:'var(--accent)', borderRadius:3, padding:'0 1px', fontWeight:700 }}>
        {s.slice(idx, idx + q.length)}
      </mark>
      {s.slice(idx + q.length)}
    </>
  );
}

/* ── Alert banner (top-of-page risk callout, like "₹X stuck — chase first") ── */
export function AlertBanner({ icon = '⚠️', title, detail, actionLabel, onAction, tone = 'bad' }) {
  if (!title) return null;
  const col = tone === 'bad' ? 'var(--red)' : tone === 'warn' ? 'var(--yellow)' : 'var(--accent)';
  const bg = tone === 'bad' ? 'var(--red-bg)' : tone === 'warn' ? 'var(--yellow-bg)' : 'var(--accent-soft)';
  return (
    <div style={{ display:'flex', alignItems:'center', gap:14, background:bg, border:`1px solid ${col}33`,
                  borderLeft:`4px solid ${col}`, borderRadius:'var(--r2)', padding:'12px 16px' }}>
      <span style={{ fontSize:20, flexShrink:0 }}>{icon}</span>
      <div style={{ flex:1, minWidth:0 }}>
        <span style={{ fontSize:13.5, fontWeight:700, color:'var(--text)' }}>{title}</span>
        {detail && <span style={{ fontSize:12.5, color:'var(--text2)', marginLeft:8 }}>{detail}</span>}
      </div>
      {actionLabel && (
        <button onClick={onAction} style={{ flexShrink:0, padding:'8px 14px', borderRadius:9, border:'none',
          background:col, color:'#fff', fontSize:12, fontWeight:700, whiteSpace:'nowrap' }}>{actionLabel} →</button>
      )}
    </div>
  );
}

/* ── Insights bar: auto-generated key takeaways at the top of a page ──────── */
export function InsightBar({ items }) {
  const list = (items || []).filter(Boolean);
  if (!list.length) return null;
  const toneColor = t => t === 'bad' ? 'var(--red)' : t === 'good' ? 'var(--green)' : 'var(--accent)';
  return (
    <div style={{ display:'flex', gap:9, flexWrap:'wrap', alignItems:'center',
                  background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--r2)',
                  padding:'10px 14px', boxShadow:'var(--shadow)' }}>
      <span style={{ fontSize:11, fontWeight:800, color:'var(--text3)', textTransform:'uppercase', letterSpacing:'.06em' }}>💡 Insights</span>
      {list.map((it, i) => (
        <span key={i} style={{ display:'inline-flex', alignItems:'center', gap:6, fontSize:12, color:'var(--text2)',
                               background:'var(--surface2)', border:'1px solid var(--border)', borderRadius:20, padding:'5px 12px' }}>
          {it.icon && <span>{it.icon}</span>}
          <b style={{ color: toneColor(it.tone), fontVariantNumeric:'tabular-nums' }}>{it.value}</b>
          <span>{it.label}</span>
        </span>
      ))}
    </div>
  );
}

/* ── Status pill (colored badge for tables) ───────────────────────────────── */
export function Pill({ children, color = '#64748b' }) {
  return (
    <span style={{ display:'inline-block', padding:'2px 9px', borderRadius:20, fontSize:11,
                   fontWeight:600, color, background:`${color}1f`, whiteSpace:'nowrap' }}>
      {children ?? '—'}
    </span>
  );
}

/* ── Section label ────────────────────────────────────────────────────────── */
export function SectionLabel({ children }) {
  return (
    <div style={{ fontSize:10, fontWeight:700, color:'var(--text3)', textTransform:'uppercase', letterSpacing:'0.09em', marginBottom:10, paddingLeft:2 }}>
      {children}
    </div>
  );
}

/* ── Chart Card ──────────────────────────────────────────────────────────── */
export function Card({ title, subtitle, children, height=260, style={}, right }) {
  return (
    <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--r2)', padding:'14px 16px', boxShadow:'var(--shadow)', ...style }}>
      {(title||right) && (
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:10, flexWrap:'wrap', gap:8 }}>
          <div>
            {title && <div style={{ fontFamily:'var(--serif)', fontWeight:700, fontSize:15, color:'var(--text)' }}>{title}</div>}
            {subtitle && <div style={{ fontSize:11, color:'var(--text3)', marginTop:2 }}>{subtitle}</div>}
          </div>
          {right}
        </div>
      )}
      <div style={{ height }}>{children}</div>
    </div>
  );
}

/* ── Funnel Bar ──────────────────────────────────────────────────────────── */
export function FunnelBar({ label, value, total, color, onClick }) {
  const p = total > 0 ? value / total * 100 : 0;
  return (
    <div onClick={onClick} style={{ marginBottom:9, cursor: onClick ? 'pointer' : 'default' }}>
      <div style={{ display:'flex', justifyContent:'space-between', marginBottom:4, fontSize:12 }}>
        <span style={{ color:'var(--text2)', fontWeight:500 }}>{label}</span>
        <span style={{ fontWeight:700, color:'var(--text)' }}>{value.toLocaleString()} <span style={{ color:'var(--text3)', fontWeight:400, fontSize:10 }}>· {p.toFixed(1)}%</span></span>
      </div>
      <div style={{ height:6, background:'var(--surface2)', borderRadius:3 }}>
        <div style={{ height:'100%', width:`${p}%`, background:color, borderRadius:3, transition:'width 0.5s' }}/>
      </div>
    </div>
  );
}

/* ── Stat List — ranked rows with a subtle share-bar, the number AND the % ──
   A cleaner alternative to bar/pie charts: each row shows name · value · share%. */
export function StatList({ items = [], total, format = (v) => (v || 0).toLocaleString('en-IN'), colors, height }) {
  const list = (items || []).filter(Boolean);
  const sum = total || list.reduce((s, x) => s + (x.value || 0), 0) || 1;
  const maxV = Math.max(...list.map(x => x.value || 0), 1);
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:11, overflowY:'auto', maxHeight: height || 'none', paddingRight:2 }}>
      {list.length === 0 && <div style={{ fontSize:12, color:'var(--text3)' }}>No data</div>}
      {list.map((it, i) => {
        const pct  = (it.value || 0) / sum * 100;
        const barW = (it.value || 0) / maxV * 100;
        const col  = it.color || (colors && colors[i % colors.length]) || 'var(--accent)';
        return (
          <div key={i}>
            <div style={{ display:'flex', alignItems:'baseline', justifyContent:'space-between', gap:10, marginBottom:5 }}>
              <span style={{ display:'flex', alignItems:'center', gap:8, minWidth:0 }}>
                <span style={{ width:9, height:9, borderRadius:3, background:col, flexShrink:0 }}/>
                <span style={{ fontSize:12.5, color:'var(--text)', fontWeight:500, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{it.name}</span>
              </span>
              <span style={{ flexShrink:0, fontVariantNumeric:'tabular-nums', whiteSpace:'nowrap' }}>
                <b style={{ fontSize:12.5, color:'var(--text)' }}>{format(it.value || 0)}</b>
                <span style={{ fontSize:11, color:'var(--text3)', marginLeft:6 }}>{pct.toFixed(1)}%</span>
              </span>
            </div>
            <div style={{ height:6, background:'var(--surface2)', borderRadius:4, overflow:'hidden' }}>
              <div style={{ height:'100%', width:`${barW}%`, background:col, borderRadius:4, transition:'width .5s' }}/>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── Tabs ────────────────────────────────────────────────────────────────── */
export function Tabs({ tabs, value, onChange }) {
  return (
    <div style={{ display:'flex', gap:0, background:'var(--surface2)', borderRadius:'var(--r)', padding:3, marginBottom:14, width:'fit-content' }}>
      {tabs.map(t => (
        <button key={t.id} onClick={() => onChange(t.id)} style={{
          padding:'5px 14px', borderRadius:6, fontSize:12, fontWeight:600,
          background: value===t.id ? 'var(--surface)' : 'transparent',
          color: value===t.id ? 'var(--accent)' : 'var(--text2)',
          boxShadow: value===t.id ? 'var(--shadow)' : 'none',
          transition:'all 0.15s',
        }}>{t.label}</button>
      ))}
    </div>
  );
}

/* ── Data Table ──────────────────────────────────────────────────────────── */
//  searchable : show the in-table search box (default true)
//  searchKeys : which column keys to match (default: every column key)
//  searchPlaceholder : custom placeholder text
//  onExport   : async () => {} — when set, the Export button calls this instead
//               of the client-side Excel export (use for full server-side CSV of
//               ALL filtered rows, not just what's loaded on screen).
//  exportLabel: button text override (e.g. "Download all (12,345)")
//  totalRows  : show this instead of data.length in the header (when the table
//               only holds a page of a larger server-side result)
export function DataTable({ title, data, columns, filename='export', maxH=420,
                            searchable=true, searchKeys, searchPlaceholder,
                            onExport, exportLabel, totalRows }) {
  const [sk, setSk] = useState(null);
  const [sd, setSd] = useState('desc');
  const [page, setPage] = useState(0);
  const [q, setQ] = useState('');
  const [exporting, setExporting] = useState(false);
  const PS = 15;

  const keys = useMemo(() => searchKeys || columns.map(c => c.key), [searchKeys, columns]);

  // 1) search → 2) sort → 3) paginate. Export respects the search filter.
  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase();
    if (!ql) return data;
    return data.filter(row => keys.some(k => String(row[k] ?? '').toLowerCase().includes(ql)));
  }, [data, keys, q]);

  const handleSort = k => { if (sk===k) setSd(d=>d==='asc'?'desc':'asc'); else { setSk(k); setSd('desc'); } setPage(0); };
  const sorted = sk ? [...filtered].sort((a,b) => {
    const v1=a[sk], v2=b[sk];
    const c = typeof v1==='number' ? v1-v2 : String(v1||'').localeCompare(String(v2||''));
    return sd==='asc' ? c : -c;
  }) : filtered;
  const totalP = Math.max(1, Math.ceil(sorted.length / PS));
  const curPage = Math.min(page, totalP - 1);
  const paged  = sorted.slice(curPage*PS, (curPage+1)*PS);
  const searching = q.trim().length > 0;

  const onSearch = (v) => { setQ(v); setPage(0); };

  const SI = ({ k }) => {
    if (sk!==k) return <ChevronsUpDown size={10} color="var(--text3)" style={{flexShrink:0}}/>;
    return sd==='asc' ? <ChevronUp size={10} color="var(--accent)" style={{flexShrink:0}}/> : <ChevronDown size={10} color="var(--accent)" style={{flexShrink:0}}/>;
  };

  return (
    <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--r2)', overflow:'hidden', boxShadow:'var(--shadow)' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:12, padding:'12px 16px', borderBottom:'1px solid var(--border)', background:'var(--surface2)', flexWrap:'wrap' }}>
        <div style={{ minWidth:0 }}>
          <div style={{ fontWeight:700, fontSize:13, color:'var(--text)' }}>{title}</div>
          <div style={{ fontSize:10, color:'var(--text3)', marginTop:1, fontVariantNumeric:'tabular-nums' }}>
            {searching
              ? <><b style={{ color:'var(--accent)' }}>{sorted.length.toLocaleString()}</b> of {data.length.toLocaleString()} rows match “{q.trim()}”</>
              : <>{(totalRows ?? data.length).toLocaleString()} rows{totalRows && totalRows > data.length ? ` · ${data.length.toLocaleString()} loaded` : ''}</>}
          </div>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:10, flex:'1 1 auto', justifyContent:'flex-end' }}>
          {searchable && (
            <SearchBox value={q} onChange={onSearch} placeholder={searchPlaceholder || 'Search this table…'} width={260}/>
          )}
          <button
            onClick={async () => {
              if (onExport) {
                if (exporting) return;
                setExporting(true);
                try { await onExport(); } catch (e) { alert(e?.message || 'Export failed'); }
                finally { setExporting(false); }
              } else {
                downloadExcel(sorted, filename);   // client-side Excel of loaded rows
              }
            }}
            disabled={exporting}
            title={onExport ? 'Download ALL matching rows (server, respects filters)'
                            : (searching ? 'Exports the filtered rows' : 'Export to Excel')}
            style={{
              display:'flex', alignItems:'center', gap:5, padding:'7px 14px', flexShrink:0,
              background:'var(--accent)', borderRadius:6, color:'#fff', fontSize:11, fontWeight:700,
              boxShadow:'0 1px 3px rgba(79,70,229,.3)', opacity: exporting ? 0.75 : 1,
            }}>
            {exporting ? <Loader2 size={12} className="spin"/> : <Download size={12}/>}
            {exporting ? 'Preparing…' : (exportLabel || 'Export')}
          </button>
        </div>
      </div>

      <div className="dt-desktop" style={{ overflowX:'auto', maxHeight:maxH, overflowY:'auto' }}>
        <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
          <thead style={{ position:'sticky', top:0, zIndex:1 }}>
            <tr style={{ background:'var(--surface2)' }}>
              {columns.map(c => (
                <th key={c.key} onClick={() => handleSort(c.key)} style={{
                  padding:'9px 12px', textAlign:c.right?'right':'left',
                  color:'var(--text2)', fontSize:10, fontWeight:700, textTransform:'uppercase',
                  letterSpacing:'0.07em', cursor:'pointer', whiteSpace:'nowrap',
                  borderBottom:'1px solid var(--border)', userSelect:'none',
                  minWidth:c.w||'auto', width:c.w||'auto',
                }}>
                  <div style={{ display:'inline-flex', alignItems:'center', gap:3 }}>{c.label}<SI k={c.key}/></div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {paged.length === 0 ? (
              <tr>
                <td colSpan={columns.length} style={{ padding:'34px 12px', textAlign:'center', color:'var(--text3)', fontSize:12.5 }}>
                  {searching ? <>No rows match “<b style={{ color:'var(--text2)' }}>{q.trim()}</b>”. <button onClick={() => onSearch('')} style={{ color:'var(--accent)', background:'transparent', fontWeight:600 }}>Clear search</button></> : 'No data'}
                </td>
              </tr>
            ) : paged.map((row,i) => (
              <tr key={i} style={{ borderBottom:'1px solid var(--border)' }}
                onMouseEnter={e => e.currentTarget.style.background='var(--surface2)'}
                onMouseLeave={e => e.currentTarget.style.background='transparent'}>
                {columns.map(c => (
                  <td key={c.key} style={{
                    padding:'8px 12px', textAlign:c.right?'right':'left',
                    color:c.bold?'var(--text)':'var(--text2)', fontWeight:c.bold?600:400,
                    whiteSpace:c.wrap?'normal':'nowrap', maxWidth:c.maxW||'none',
                    minWidth:c.w||'auto', width:c.w||'auto',
                    verticalAlign:'top',
                  }}>
                    {c.render
                      ? c.render(row[c.key], row)
                      : (typeof row[c.key]==='number'
                          ? row[c.key].toLocaleString('en-IN',{maximumFractionDigits:2})
                          : highlightMatch(row[c.key], searching ? q : ''))}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile: render each row as a card (label → value) instead of a wide scroll */}
      <div className="dt-mobile" style={{ maxHeight:maxH, overflowY:'auto' }}>
        {paged.length === 0 ? (
          <div style={{ padding:'28px 14px', textAlign:'center', color:'var(--text3)', fontSize:12.5 }}>
            {searching ? <>No rows match “{q.trim()}”. <button onClick={() => onSearch('')} style={{ color:'var(--accent)', background:'transparent', fontWeight:600 }}>Clear search</button></> : 'No data'}
          </div>
        ) : paged.map((row,i) => (
          <div key={i} style={{ borderBottom:'1px solid var(--border)', padding:'10px 14px' }}>
            {columns.map((c, ci) => (
              <div key={c.key} style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline', gap:12, padding:'3px 0',
                                        borderTop: ci===0 ? 'none' : '1px dashed var(--border)' }}>
                <span style={{ fontSize:10.5, color:'var(--text3)', fontWeight:700, textTransform:'uppercase', letterSpacing:'.04em', flexShrink:0 }}>{c.label}</span>
                <span style={{ fontSize:12.5, color: ci===0 ? 'var(--text)' : 'var(--text2)', fontWeight: ci===0 ? 700 : 500, textAlign:'right', wordBreak:'break-word', minWidth:0 }}>
                  {c.render
                    ? c.render(row[c.key], row)
                    : (typeof row[c.key]==='number'
                        ? row[c.key].toLocaleString('en-IN',{maximumFractionDigits:2})
                        : highlightMatch(row[c.key], searching ? q : ''))}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>

      {totalP > 1 && (
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'8px 16px', borderTop:'1px solid var(--border)', background:'var(--surface2)' }}>
          <span style={{ fontSize:11, color:'var(--text3)' }}>Page {curPage+1} of {totalP}</span>
          <div style={{ display:'flex', gap:4 }}>
            <button onClick={() => setPage(p=>Math.max(0,p-1))} disabled={curPage===0}
              style={{ padding:'4px 12px', borderRadius:5, background:'var(--surface)', border:'1px solid var(--border)', color:curPage===0?'var(--text3)':'var(--text)', fontSize:11 }}>←</button>
            <button onClick={() => setPage(p=>Math.min(totalP-1,p+1))} disabled={curPage===totalP-1}
              style={{ padding:'4px 12px', borderRadius:5, background:'var(--surface)', border:'1px solid var(--border)', color:curPage===totalP-1?'var(--text3)':'var(--text)', fontSize:11 }}>→</button>
          </div>
        </div>
      )}
    </div>
  );
}
