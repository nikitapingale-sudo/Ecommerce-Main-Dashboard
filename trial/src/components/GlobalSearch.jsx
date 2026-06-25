import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Search, X, CornerDownLeft } from 'lucide-react';
import { fmt } from '../utils/dataEngine';

// Entities we index from the current bundle → which page each jumps to.
const SOURCES = [
  { arr: b => b.by?.channel,   type: 'Channel',   page: 'channels',   icon: '📡', nameKey: 'name' },
  { arr: b => b.by?.parent,    type: 'Category',  page: 'products',   icon: '📚', nameKey: 'name' },
  { arr: b => b.by?.state,     type: 'State',     page: 'geographic', icon: '📍', nameKey: 'name' },
  { arr: b => b.by?.city,      type: 'City',      page: 'geographic', icon: '🏙️', nameKey: 'name' },
  { arr: b => b.by?.brand,     type: 'Brand',     page: 'operations', icon: '🔖', nameKey: 'name' },
  { arr: b => b.by?.courier,   type: 'Courier',   page: 'operations', icon: '🚚', nameKey: 'name' },
  { arr: b => b.by?.warehouse, type: 'Warehouse', page: 'operations', icon: '🏭', nameKey: 'name' },
  { arr: b => b.by?.payment,   type: 'Payment',   page: 'channels',   icon: '💳', nameKey: 'name' },
  { arr: b => b.couponStats?.coupons, type: 'Coupon', page: 'coupons', icon: '🎟️', nameKey: 'coupon' },
  { arr: b => b.sku,           type: 'SKU',       page: 'skusummary', icon: '🏷️', nameKey: 'product_variant_name', alt: 'sku_code', cap: 3000 },
];

const TYPE_COLOR = {
  Channel:'#2563eb', Category:'#7c3aed', State:'#0891b2', City:'#0e7490', Brand:'#db2777',
  Courier:'#d97706', Warehouse:'#65a30d', Payment:'#4f46e5', Coupon:'#16a34a', SKU:'#e11d48',
};

function hl(text, q) {
  const s = String(text);
  const i = s.toLowerCase().indexOf(q.toLowerCase());
  if (!q || i === -1) return s;
  return <>{s.slice(0,i)}<mark style={{ background:'var(--accent-soft)', color:'var(--accent)', borderRadius:3, padding:'0 1px' }}>{s.slice(i,i+q.length)}</mark>{s.slice(i+q.length)}</>;
}

export default function GlobalSearch({ data, goto }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  // Build a flat searchable index from the current bundle.
  const index = useMemo(() => {
    const out = [];
    for (const src of SOURCES) {
      const arr = src.arr(data) || [];
      const slice = src.cap ? arr.slice(0, src.cap) : arr;
      for (const r of slice) {
        const name = r[src.nameKey] || (src.alt && r[src.alt]);
        if (!name || name === 'Unknown') continue;
        out.push({ name: String(name), type: src.type, page: src.page, icon: src.icon,
                   revenue: r.revenue || 0, orders: r.orders || 0 });
      }
    }
    return out;
  }, [data]);

  const results = useMemo(() => {
    const ql = q.trim().toLowerCase();
    if (!ql) return [];
    const hits = index.filter(r => r.name.toLowerCase().includes(ql));
    hits.sort((a, b) => {
      const aS = a.name.toLowerCase().startsWith(ql) ? 0 : 1;
      const bS = b.name.toLowerCase().startsWith(ql) ? 0 : 1;
      if (aS !== bS) return aS - bS;
      return b.revenue - a.revenue;
    });
    return hits.slice(0, 40);
  }, [index, q]);

  // Open with ⌘K / Ctrl+K or "/"; close with Esc.
  useEffect(() => {
    const onKey = (e) => {
      const k = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && k === 'k') { e.preventDefault(); setOpen(o => !o); }
      else if (k === '/' && !open) {
        const t = e.target.tagName;
        if (t !== 'INPUT' && t !== 'TEXTAREA' && !e.target.isContentEditable) { e.preventDefault(); setOpen(true); }
      } else if (k === 'escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => { if (open) { setQ(''); setActive(0); setTimeout(() => inputRef.current?.focus(), 30); } }, [open]);
  useEffect(() => { setActive(0); }, [q]);

  const choose = (r) => { if (!r) return; goto(r.page); setOpen(false); };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(results[active]); }
  };

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-i="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  return (
    <>
      {/* Trigger */}
      <button onClick={() => setOpen(true)} title="Search everything (⌘K)" style={{
        display:'flex', alignItems:'center', gap:8, padding:'7px 12px', borderRadius:11, flexShrink:0,
        background:'var(--surface2)', border:'1px solid var(--border)', color:'var(--text3)', fontSize:12.5, minWidth:170 }}>
        <Search size={15} color="var(--accent)"/>
        <span style={{ flex:1, textAlign:'left' }}>Search anything…</span>
        <kbd style={{ fontSize:10, fontWeight:700, color:'var(--text3)', background:'var(--surface)', border:'1px solid var(--border)', borderRadius:5, padding:'1px 5px' }}>⌘K</kbd>
      </button>

      {/* Overlay */}
      {open && (
        <div onMouseDown={() => setOpen(false)} style={{ position:'fixed', inset:0, zIndex:9700,
              background:'rgba(15,12,10,.45)', backdropFilter:'blur(2px)', display:'flex', justifyContent:'center', alignItems:'flex-start', paddingTop:'10vh' }}>
          <div onMouseDown={e => e.stopPropagation()} style={{ width:560, maxWidth:'92vw', background:'var(--surface)',
                border:'1px solid var(--border)', borderRadius:16, boxShadow:'var(--shadow2)', overflow:'hidden' }}>
            {/* Input */}
            <div style={{ display:'flex', alignItems:'center', gap:10, padding:'14px 16px', borderBottom:'1px solid var(--border)' }}>
              <Search size={18} color="var(--accent)"/>
              <input ref={inputRef} value={q} onChange={e => setQ(e.target.value)} onKeyDown={onKeyDown}
                placeholder="Search coupons, SKUs, channels, states, cities, brands…"
                style={{ flex:1, fontSize:15, background:'transparent', border:'none', outline:'none', color:'var(--text)' }}/>
              <button onClick={() => setOpen(false)} style={{ display:'flex', color:'var(--text3)', background:'transparent', padding:3 }}><X size={16}/></button>
            </div>

            {/* Results */}
            <div ref={listRef} style={{ maxHeight:'52vh', overflowY:'auto', padding:6 }}>
              {!q.trim() ? (
                <div style={{ padding:'26px 16px', textAlign:'center', color:'var(--text3)', fontSize:13 }}>
                  Type to search across every dimension in the current view.<br/>
                  <span style={{ fontSize:11.5 }}>Tip: press <b>⌘K</b> or <b>/</b> anywhere to open this.</span>
                </div>
              ) : results.length === 0 ? (
                <div style={{ padding:'26px 16px', textAlign:'center', color:'var(--text3)', fontSize:13 }}>No matches for “{q.trim()}”.</div>
              ) : results.map((r, i) => (
                <button key={i} data-i={i} onMouseEnter={() => setActive(i)} onClick={() => choose(r)}
                  style={{ display:'flex', alignItems:'center', gap:11, width:'100%', textAlign:'left', padding:'9px 12px', borderRadius:9,
                           background: i===active ? 'var(--surface2)' : 'transparent', border:'none' }}>
                  <span style={{ fontSize:17, flexShrink:0 }}>{r.icon}</span>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:13, color:'var(--text)', fontWeight:600, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{hl(r.name, q.trim())}</div>
                    <div style={{ fontSize:11, color:'var(--text3)' }}>{r.orders.toLocaleString()} orders · {fmt(r.revenue)}</div>
                  </div>
                  <span style={{ fontSize:10, fontWeight:700, color:TYPE_COLOR[r.type]||'var(--text3)', background:(TYPE_COLOR[r.type]||'#888')+'1f', borderRadius:20, padding:'2px 9px', flexShrink:0 }}>{r.type}</span>
                  {i===active && <CornerDownLeft size={13} color="var(--text3)" style={{ flexShrink:0 }}/>}
                </button>
              ))}
            </div>

            {/* Footer */}
            {results.length > 0 && (
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'8px 14px', borderTop:'1px solid var(--border)', background:'var(--surface2)', fontSize:11, color:'var(--text3)' }}>
                <span>{results.length} result{results.length!==1?'s':''}</span>
                <span>↑↓ navigate · ↵ open · esc close</span>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
