import React, { useState, useMemo, useEffect } from 'react';
import { X, Search, Check, ChevronDown, RotateCcw, SlidersHorizontal } from 'lucide-react';
import { FILTER_OPTIONS } from '../utils/dataEngine';

// Filter sections (Status Group and OMS intentionally removed per request).
const SECTIONS = [
  { key:'orderStatuses',  label:'Order Status',      icon:'🚦', opt:'orderStatuses' },
  { key:'lineStatuses',   label:'Line / Item Status', icon:'📦', opt:'lineStatuses' },
  { key:'channels',       label:'Channel',           icon:'📡', opt:'channels' },
  { key:'categories',     label:'Category',          icon:'📚', opt:'categories' },
  { key:'finCats',        label:'Finance Category',  icon:'🎓', opt:'finCats' },
  { key:'payments',       label:'Payment Mode',      icon:'💳', opt:'payments' },
  { key:'states',         label:'State',             icon:'📍', opt:'states' },
  { key:'warehouses',     label:'Warehouse',         icon:'🏭', opt:'warehouses' },
  { key:'couriers',       label:'Courier',           icon:'🚚', opt:'couriers' },
  { key:'orderTypes',     label:'Order Type',        icon:'🧾', opt:'orderTypes' },
  { key:'orderCats',      label:'Order Category',    icon:'🗂️', opt:'orderCats' },
  { key:'purchaseLevels', label:'Purchase Level',    icon:'🏆', opt:'purchaseLevels' },
  { key:'coupons',        label:'Coupon Code',       icon:'🎟️', opt:'coupons' },
];

function Box({ checked }) {
  return (
    <div style={{ width:16, height:16, flexShrink:0, borderRadius:4,
                  border:`1.5px solid ${checked?'var(--accent)':'var(--border2)'}`,
                  background: checked?'var(--accent)':'var(--surface)',
                  display:'flex', alignItems:'center', justifyContent:'center' }}>
      {checked && <Check size={10} color="#fff"/>}
    </div>
  );
}

function FilterSection({ icon, label, options, selected, onChange }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const filtered = useMemo(
    () => options.filter(o => String(o).toLowerCase().includes(q.toLowerCase())),
    [options, q]);
  const allSel = filtered.length > 0 && filtered.every(o => selected.includes(o));
  const toggle = opt => selected.includes(opt) ? onChange(selected.filter(v => v !== opt)) : onChange([...selected, opt]);
  const toggleAll = () => allSel
    ? onChange(selected.filter(v => !filtered.includes(v)))
    : onChange([...new Set([...selected, ...filtered])]);

  return (
    <div style={{ borderBottom:'1px solid var(--border)' }}>
      <button onClick={() => setOpen(o => !o)} style={{
        width:'100%', display:'flex', alignItems:'center', gap:8, padding:'10px 14px',
        background: selected.length ? 'var(--accent-soft)' : 'transparent', color:'var(--text)',
        fontSize:12.5, fontWeight:600, textAlign:'left' }}>
        <span style={{ fontSize:14 }}>{icon}</span>
        <span style={{ flex:1 }}>{label}</span>
        {selected.length > 0 && <span style={{ background:'var(--accent)', color:'#fff', borderRadius:20, fontSize:10, fontWeight:700, padding:'1px 7px' }}>{selected.length}</span>}
        <ChevronDown size={14} style={{ transform: open?'rotate(180deg)':'none', transition:'transform .18s', color:'var(--text3)' }}/>
      </button>
      {open && (
        <div style={{ padding:'0 12px 12px' }}>
          <div style={{ display:'flex', alignItems:'center', gap:7, background:'var(--surface2)', border:'1px solid var(--border)', borderRadius:8, padding:'6px 10px', marginBottom:6 }}>
            <Search size={13} color="var(--text3)"/>
            <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder={`Search…`}
              style={{ border:'none', background:'transparent', fontSize:12, color:'var(--text)', width:'100%' }}/>
            {q && <X size={12} color="var(--text3)" style={{ cursor:'pointer' }} onClick={() => setQ('')}/>}
          </div>
          <div onClick={toggleAll} style={{ display:'flex', alignItems:'center', gap:8, padding:'5px 4px', cursor:'pointer', fontSize:12, fontWeight:600, color:'var(--accent)' }}>
            <Box checked={allSel}/> Select all ({filtered.length})
          </div>
          <div style={{ maxHeight:190, overflowY:'auto', marginTop:2 }}>
            {filtered.length === 0
              ? <div style={{ padding:'10px', fontSize:12, color:'var(--text3)', textAlign:'center' }}>No matches</div>
              : filtered.map(opt => {
                  const sel = selected.includes(opt);
                  return (
                    <div key={opt} onClick={() => toggle(opt)} style={{ display:'flex', alignItems:'center', gap:8, padding:'5px 4px', cursor:'pointer', fontSize:12, color: sel ? 'var(--accent)' : 'var(--text2)' }}>
                      <Box checked={sel}/>
                      <span style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{opt}</span>
                    </div>
                  );
                })}
          </div>
        </div>
      )}
    </div>
  );
}

function counts(f) {
  let n = (f.dateFrom || f.dateTo) ? 1 : 0;
  Object.entries(f).forEach(([k, v]) => { if (k !== 'dateFrom' && k !== 'dateTo' && v?.length) n++; });
  return n;
}
function blank(filters) {
  const out = { ...filters, dateFrom:'', dateTo:'' };
  Object.keys(out).forEach(k => { if (Array.isArray(out[k])) out[k] = []; });
  return out;
}

/* ── Docked, collapsible left filter panel (beside the pages) ─────────────── */
export default function FilterPanel({ open, onClose, filters, onChange, onReset, dateBounds }) {
  const [draft, setDraft] = useState(filters);
  useEffect(() => { setDraft(filters); }, [filters, open]);
  if (!open) return null;

  const setD = (k, v) => setDraft(d => ({ ...d, [k]: v }));
  const draftCount = counts(draft);
  const apply = () => onChange(draft);
  const reset = () => { const c = blank(filters); setDraft(c); onChange(c); };
  const anchor = (dateBounds && dateBounds.maxDate) || '';
  const minD = (dateBounds && dateBounds.minDate) || '';
  const dirty = JSON.stringify(draft) !== JSON.stringify(filters);

  return (
    <div style={{ position:'fixed', inset:0, zIndex:9500, display:'flex' }}>
      <div onClick={onClose} style={{ position:'absolute', inset:0, background:'rgba(15,23,42,.42)', backdropFilter:'blur(2px)' }}/>
      <div style={{ position:'relative', width:340, maxWidth:'88vw', height:'100%', background:'var(--surface)',
                    borderRight:'1px solid var(--border)', boxShadow:'var(--shadow2)',
                    display:'flex', flexDirection:'column', animation:'pwslide .2s ease' }}>
      <style>{`@keyframes pwslide{from{transform:translateX(-100%)}to{transform:translateX(0)}}`}</style>
      <div style={{ padding:'13px 16px', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', gap:9 }}>
        <SlidersHorizontal size={16} color="var(--accent)"/>
        <div style={{ flex:1, fontWeight:700, fontSize:14, color:'var(--text)' }}>Filters {draftCount>0 && <span style={{ color:'var(--text3)', fontWeight:600, fontSize:12 }}>· {draftCount}</span>}</div>
        <button onClick={onClose} title="Collapse" style={{ background:'var(--surface2)', borderRadius:7, padding:5, color:'var(--text2)', display:'flex' }}><X size={15}/></button>
      </div>

      <div style={{ flex:1, overflowY:'auto' }}>
        {/* Date range */}
        <div style={{ padding:'13px 14px', borderBottom:'1px solid var(--border)' }}>
          <div style={{ fontSize:12, fontWeight:700, color:'var(--text2)', marginBottom:8 }}>📅 Order Date</div>
          <div style={{ display:'flex', alignItems:'center', gap:7 }}>
            <input type="date" value={draft.dateFrom||''} min={minD} max={anchor} onChange={e => setD('dateFrom', e.target.value)}
              style={{ flex:1, minWidth:0, padding:'7px 8px', border:'1px solid var(--border)', borderRadius:8, fontSize:12, color:'var(--text)', background:'var(--surface)' }}/>
            <span style={{ color:'var(--text3)', fontSize:11 }}>to</span>
            <input type="date" value={draft.dateTo||''} min={minD} max={anchor} onChange={e => setD('dateTo', e.target.value)}
              style={{ flex:1, minWidth:0, padding:'7px 8px', border:'1px solid var(--border)', borderRadius:8, fontSize:12, color:'var(--text)', background:'var(--surface)' }}/>
          </div>
          <div style={{ display:'flex', gap:6, marginTop:8, flexWrap:'wrap' }}>
            {[['7D',7],['30D',30],['90D',90],['All',0]].map(([lbl,days]) => (
              <button key={lbl} onClick={() => {
                if (days===0 || !anchor) { setDraft(d=>({...d, dateFrom:'', dateTo:''})); return; }
                const from = new Date(new Date(anchor).getTime() - days*86400000).toISOString().split('T')[0];
                setDraft(d => ({ ...d, dateFrom: from, dateTo: anchor }));
              }} style={{ padding:'4px 11px', borderRadius:7, fontSize:11, fontWeight:600, background:'var(--surface2)', color:'var(--text2)', border:'1px solid var(--border)' }}>{lbl}</button>
            ))}
          </div>
          {anchor && <div style={{ fontSize:10, color:'var(--text3)', marginTop:6 }}>Data: {minD} → {anchor}</div>}
        </div>

        {SECTIONS.map(s => (
          <FilterSection key={s.key} icon={s.icon} label={s.label}
            options={FILTER_OPTIONS[s.opt] || []} selected={draft[s.key] || []} onChange={v => setD(s.key, v)}/>
        ))}
      </div>

      <div style={{ padding:'12px 14px', borderTop:'1px solid var(--border)', display:'flex', gap:10, background:'var(--surface2)' }}>
        <button onClick={reset} style={{ display:'flex', alignItems:'center', gap:6, padding:'9px 13px', borderRadius:9, background:'var(--surface)', border:'1px solid var(--border)', color:'var(--text2)', fontSize:12, fontWeight:700 }}>
          <RotateCcw size={13}/> Reset
        </button>
        <button onClick={apply} style={{ flex:1, padding:'9px 14px', borderRadius:9, border:'none', background: dirty ? 'var(--accent-grad)' : 'var(--surface)', color: dirty ? '#fff' : 'var(--text3)', fontSize:13, fontWeight:800, cursor: dirty?'pointer':'default', boxShadow: dirty?'0 3px 10px rgba(79,70,229,.3)':'none', border: dirty?'none':'1px solid var(--border)' }}>
          {dirty ? 'Apply Filters' : 'Filters applied'}
        </button>
      </div>
      </div>
    </div>
  );
}
