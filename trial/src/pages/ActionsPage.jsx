import React from 'react';
import { recommendations } from '../utils/ecomwallah';

const SEV = {
  high: { label:'Act now',   color:'#e11d48', bg:'var(--red-bg)' },
  med:  { label:'Review',    color:'#d97706', bg:'var(--yellow-bg)' },
  low:  { label:'Opportunity', color:'#16a34a', bg:'var(--green-bg)' },
};

export default function ActionsPage({ data }) {
  const recs = recommendations(data);
  const order = { high: 0, med: 1, low: 2 };
  const sorted = [...recs].sort((a, b) => order[a.sev] - order[b.sev]);
  const counts = recs.reduce((a, r) => (a[r.sev] = (a[r.sev] || 0) + 1, a), {});

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:16, maxWidth:980 }}>
      <div style={{ display:'flex', alignItems:'center', gap:12 }}>
        <div style={{ width:42, height:42, borderRadius:12, background:'var(--accent-grad)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:21 }}>🎯</div>
        <div>
          <div style={{ fontWeight:800, fontSize:18, color:'var(--text)' }}>Action Center</div>
          <div style={{ fontSize:12.5, color:'var(--text3)' }}>
            Prioritised actions from your live data ·
            <b style={{ color:'#e11d48' }}> {counts.high || 0} act-now</b> ·
            <b style={{ color:'#d97706' }}> {counts.med || 0} review</b> ·
            <b style={{ color:'#16a34a' }}> {counts.low || 0} opportunities</b>
          </div>
        </div>
      </div>

      {sorted.map((r, i) => {
        const s = SEV[r.sev] || SEV.low;
        return (
          <div key={i} style={{ display:'flex', gap:14, alignItems:'flex-start', background:'var(--surface)',
                                border:'1px solid var(--border)', borderLeft:`4px solid ${s.color}`,
                                borderRadius:'var(--r2)', padding:'14px 16px', boxShadow:'var(--shadow)' }}>
            <div style={{ width:38, height:38, borderRadius:10, flexShrink:0, fontSize:18, background:s.bg,
                          display:'flex', alignItems:'center', justifyContent:'center' }}>{r.icon}</div>
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
                <span style={{ fontSize:14, fontWeight:700, color:'var(--text)' }}>{r.title}</span>
                <span style={{ fontSize:10, fontWeight:800, color:s.color, background:s.bg, borderRadius:20, padding:'2px 9px', textTransform:'uppercase', letterSpacing:'.04em' }}>{s.label}</span>
              </div>
              <div style={{ fontSize:13, color:'var(--text2)', marginTop:5, lineHeight:1.5 }}>{r.detail}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
