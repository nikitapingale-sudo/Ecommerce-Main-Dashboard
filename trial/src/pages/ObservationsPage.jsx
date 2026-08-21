import React, { useMemo, useState } from 'react';
import { SectionLabel } from '../components/UI';
import { downloadExcel } from '../utils/dataEngine';
import { buildObservations, countBySeverity, GROUPS, SEVERITY } from '../utils/observations';

/* ── Observations ────────────────────────────────────────────────────────────
   Everything here is computed from the same filtered bundle the charts use, so
   the page cannot contradict them and cannot go stale. Findings that stop being
   true under a filter simply stop appearing. See utils/observations.js for the
   rules themselves — this file only renders them.
─────────────────────────────────────────────────────────────────────────────── */

/* Severity chip — colour is never the only cue; the icon and the word carry it
   for anyone reading in greyscale or with a colour-vision deficiency. */
function SevChip({ sev, active, count, onClick }) {
  const s = SEVERITY[sev];
  if (!s) return null;
  return (
    <button
      onClick={onClick}
      style={{
        display:'inline-flex', alignItems:'center', gap:6,
        padding:'5px 11px', borderRadius:999, fontSize:11.5, fontWeight:600,
        background: active ? s.color : 'var(--surface)',
        color: active ? '#fff' : 'var(--text2)',
        border:`1px solid ${active ? s.color : 'var(--border)'}`,
        transition:'all .12s',
      }}>
      <span aria-hidden>{s.icon}</span>{s.label}
      {count !== undefined && (
        <span style={{
          fontSize:10.5, fontWeight:700, padding:'1px 5px', borderRadius:999,
          background: active ? 'rgba(255,255,255,.25)' : 'var(--surface2)',
          color: active ? '#fff' : 'var(--text3)',
        }}>{count}</span>
      )}
    </button>
  );
}

function ObsCard({ o, goto, drillTo }) {
  const s = SEVERITY[o.severity] || SEVERITY.info;
  return (
    <div style={{
      background:'var(--surface)', border:'1px solid var(--border)',
      borderRadius:'var(--r2)', boxShadow:'var(--shadow)',
      borderLeft:`3px solid ${s.color}`, padding:'14px 16px',
      display:'flex', flexDirection:'column', gap:10, minWidth:0,
    }}>
      {/* severity + group */}
      <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
        <span style={{
          display:'inline-flex', alignItems:'center', gap:5, fontSize:10,
          fontWeight:700, textTransform:'uppercase', letterSpacing:'.07em',
          color:s.color,
        }}>
          <span aria-hidden>{s.icon}</span>{s.label}
        </span>
        <span style={{ fontSize:10, color:'var(--text3)' }}>· {o.group}</span>
      </div>

      <div style={{ fontFamily:'var(--serif)', fontWeight:700, fontSize:15.5, lineHeight:1.35, color:'var(--text)' }}>
        {o.title}
      </div>

      {/* the headline figure */}
      {o.stat && (
        <div style={{ display:'flex', alignItems:'baseline', gap:9, flexWrap:'wrap' }}>
          <span style={{ fontFamily:'var(--serif)', fontSize:26, fontWeight:700, color:s.color, fontVariantNumeric:'tabular-nums' }}>
            {o.stat}
          </span>
          {o.statSub && <span style={{ fontSize:11, color:'var(--text3)' }}>{o.statSub}</span>}
        </div>
      )}

      <div style={{ fontSize:12.5, lineHeight:1.6, color:'var(--text2)' }}>{o.detail}</div>

      {o.why && (
        <div style={{
          fontSize:12, lineHeight:1.6, color:'var(--text2)',
          background:'var(--surface2)', border:'1px solid var(--border)',
          borderRadius:'var(--r)', padding:'9px 11px',
        }}>
          <span style={{ fontWeight:700, color:'var(--text)' }}>Why it matters · </span>{o.why}
        </div>
      )}

      {!!(o.evidence || []).length && (
        <div style={{ display:'flex', flexWrap:'wrap', gap:6 }}>
          {o.evidence.map(([k, v], i) => (
            <span key={i} style={{
              fontSize:10.5, padding:'3px 8px', borderRadius:'var(--r)',
              background:'var(--surface2)', border:'1px solid var(--border)', color:'var(--text2)',
            }}>
              {k} <b style={{ color:'var(--text)', fontVariantNumeric:'tabular-nums' }}>{v}</b>
            </span>
          ))}
        </div>
      )}

      {(o.page || o.drill) && (
        <div style={{ display:'flex', gap:8, flexWrap:'wrap', marginTop:2 }}>
          {o.page && (
            <button onClick={() => goto && goto(o.page)} style={btn(false)}>
              Open {o.page === 'skusummary' ? 'SKU summary' : o.page === 'components' ? 'component summary' : o.page} →
            </button>
          )}
          {o.drill && (
            <button onClick={() => drillTo && drillTo(o.drill)} style={btn(true)}>
              Filter the dashboard to this
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const btn = (primary) => ({
  fontSize:11, fontWeight:600, padding:'6px 11px', borderRadius:'var(--r)',
  background: primary ? 'var(--accent-soft)' : 'transparent',
  color: primary ? 'var(--accent)' : 'var(--text2)',
  border:`1px solid ${primary ? 'var(--accent)' : 'var(--border)'}`,
});

export default function ObservationsPage({ data, filters, goto, drillTo }) {
  const obs = useMemo(() => buildObservations(data, filters), [data, filters]);
  const counts = useMemo(() => countBySeverity(obs), [obs]);
  const [sev, setSev] = useState(null);       // null = show every severity

  const shown = sev ? obs.filter(o => o.severity === sev) : obs;
  const groups = GROUPS.filter(g => shown.some(o => o.group === g));

  const exportAll = () => downloadExcel(obs.map(o => ({
    Severity: SEVERITY[o.severity]?.label || o.severity,
    Area: o.group,
    Observation: o.title,
    Figure: o.stat,
    'Figure means': o.statSub,
    Detail: o.detail,
    'Why it matters': o.why,
  })), 'observations');

  if (!obs.length) {
    return (
      <div style={{ padding:'40px 20px', textAlign:'center', color:'var(--text3)' }}>
        <div style={{ fontSize:34, marginBottom:10 }}>🔍</div>
        <div style={{ fontFamily:'var(--serif)', fontSize:17, fontWeight:700, color:'var(--text)', marginBottom:6 }}>
          Nothing to report on this slice
        </div>
        <div style={{ fontSize:12.5, maxWidth:460, margin:'0 auto', lineHeight:1.6 }}>
          Observations are computed from whatever the filters currently return. This
          selection is either empty or too small for any rule to trigger — widen the
          date window or clear a filter.
        </div>
      </div>
    );
  }

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:16, minWidth:0, maxWidth:'100%' }}>

      {/* ── What this page is ── */}
      <div style={{
        background:'var(--surface)', border:'1px solid var(--border)',
        borderRadius:'var(--r2)', padding:'14px 16px', boxShadow:'var(--shadow)',
      }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap:12, flexWrap:'wrap' }}>
          <div style={{ minWidth:0 }}>
            <div style={{ fontFamily:'var(--serif)', fontWeight:700, fontSize:16, color:'var(--text)' }}>
              {obs.length} observations from the current view
            </div>
            <div style={{ fontSize:11.5, color:'var(--text3)', marginTop:3, lineHeight:1.55, maxWidth:640 }}>
              Each one is recalculated from the same filtered data the charts use — nothing here is
              written down in advance. Change a filter and this page changes with it.
            </div>
          </div>
          <button onClick={exportAll} style={btn(false)}>⬇ Export all</button>
        </div>

        <div style={{ display:'flex', gap:7, flexWrap:'wrap', marginTop:12 }}>
          <button
            onClick={() => setSev(null)}
            style={{
              display:'inline-flex', alignItems:'center', gap:6, padding:'5px 11px',
              borderRadius:999, fontSize:11.5, fontWeight:600,
              background: sev === null ? 'var(--accent)' : 'var(--surface)',
              color: sev === null ? '#fff' : 'var(--text2)',
              border:`1px solid ${sev === null ? 'var(--accent)' : 'var(--border)'}`,
            }}>
            All <span style={{
              fontSize:10.5, fontWeight:700, padding:'1px 5px', borderRadius:999,
              background: sev === null ? 'rgba(255,255,255,.25)' : 'var(--surface2)',
              color: sev === null ? '#fff' : 'var(--text3)',
            }}>{obs.length}</span>
          </button>
          {Object.keys(SEVERITY)
            .filter(k => counts[k])
            .map(k => (
              <SevChip key={k} sev={k} count={counts[k]} active={sev === k}
                       onClick={() => setSev(sev === k ? null : k)}/>
            ))}
        </div>
      </div>

      {/* ── The observations, grouped ── */}
      {groups.map(g => (
        <div key={g}>
          <SectionLabel>{g}</SectionLabel>
          <div style={{
            display:'grid', gap:12,
            gridTemplateColumns:'repeat(auto-fit, minmax(min(100%, 340px), 1fr))',
          }}>
            {shown.filter(o => o.group === g).map(o => (
              <ObsCard key={o.id} o={o} goto={goto} drillTo={drillTo}/>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
