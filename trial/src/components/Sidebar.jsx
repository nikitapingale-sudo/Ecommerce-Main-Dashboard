import React, { useState } from 'react';
import { Menu, X, ChevronDown } from 'lucide-react';

const PAGE = {
  ecomwallah: { emoji:'🤖', label:'EcomWallah' },
  overview:   { emoji:'📊', label:'Overview' },
  revenue:    { emoji:'💰', label:'Revenue' },
  channels:   { emoji:'📡', label:'Channels' },
  geographic: { emoji:'🗺️', label:'Geographic' },
  fulfilment: { emoji:'🚚', label:'Fulfilment' },
  pendency:   { emoji:'⏳', label:'Pendency' },
  operations: { emoji:'⚙️', label:'Operations' },
  actions:    { emoji:'🎯', label:'Action Center' },
  products:   { emoji:'📚', label:'Products' },
  coupons:    { emoji:'🎟️', label:'Coupons' },
  skusummary: { emoji:'🧾', label:'SKU Level Summary' },
  components: { emoji:'🧩', label:'Component Level Summary' },
  rawdata:    { emoji:'📋', label:'Raw Data' },
};

// Grouped, collapsible nav sections.
const GROUPS = [
  { title:'Assistant',        ids:['ecomwallah'] },
  { title:'Analytics',        ids:['overview','revenue','channels','geographic'] },
  { title:'Operations',       ids:['fulfilment','pendency','operations','actions'] },
  { title:'Catalog & Supply', ids:['products','coupons'] },
  { title:'Summaries',        ids:['skusummary','components'] },
  { title:'Data',             ids:['rawdata'] },
];

export default function Sidebar({ page, setPage }) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [closed, setClosed] = useState({});   // collapsed groups

  const NavItem = ({ id, onNav }) => {
    const p = PAGE[id];
    const active = page === id;
    return (
      <button onClick={() => { setPage(id); onNav && onNav(); }}
        style={{
          display:'flex', alignItems:'center', gap:10, width:'100%',
          padding: collapsed ? '9px 0' : '8px 10px', margin: collapsed ? '2px 0' : '1px 8px',
          width: collapsed ? '100%' : 'calc(100% - 16px)',
          justifyContent: collapsed ? 'center' : 'flex-start',
          borderRadius:'var(--r)',
          background: active ? 'var(--accent-soft)' : 'transparent',
          color: active ? 'var(--accent)' : 'var(--text2)',
          fontSize:13, fontWeight: active ? 600 : 500, transition:'all .14s',
        }}
        onMouseEnter={e=>{ if(!active) e.currentTarget.style.background='var(--surface2)'; }}
        onMouseLeave={e=>{ if(!active) e.currentTarget.style.background='transparent'; }}>
        <span style={{ fontSize:15, flexShrink:0 }}>{p.emoji}</span>
        {!collapsed && <span style={{ whiteSpace:'nowrap' }}>{p.label}</span>}
      </button>
    );
  };

  const Group = ({ g, onNav }) => {
    const isClosed = closed[g.title];
    return (
      <div style={{ marginBottom: collapsed ? 4 : 10 }}>
        {!collapsed && (
          <button onClick={() => setClosed(c => ({ ...c, [g.title]: !c[g.title] }))}
            style={{ display:'flex', alignItems:'center', justifyContent:'space-between', width:'calc(100% - 16px)',
                     margin:'0 8px', padding:'6px 8px', background:'transparent', color:'var(--text3)',
                     fontSize:10, fontWeight:700, letterSpacing:'.08em', textTransform:'uppercase' }}>
            {g.title}
            <ChevronDown size={12} style={{ transform: isClosed?'rotate(-90deg)':'none', transition:'transform .15s' }}/>
          </button>
        )}
        {!isClosed && g.ids.map(id => <NavItem key={id} id={id} onNav={onNav}/>)}
      </div>
    );
  };

  const Logo = () => (
    <div style={{ padding: collapsed ? '16px 0' : '18px 16px', borderBottom:'1px solid var(--border)',
                  display:'flex', alignItems:'center', gap:10, justifyContent: collapsed?'center':'flex-start' }}>
      <div style={{ width:30, height:30, borderRadius:8, background:'var(--accent-grad)', display:'flex',
                    alignItems:'center', justifyContent:'center', fontSize:16, flexShrink:0, boxShadow:'0 2px 6px rgba(79,70,229,.35)' }}>📦</div>
      {!collapsed && (
        <div>
          <div style={{ fontWeight:800, fontSize:14, color:'var(--text)', lineHeight:1.1 }}>PW Orders</div>
          <div style={{ fontWeight:500, fontSize:10, color:'var(--text3)', lineHeight:1.2 }}>Intelligence Hub</div>
        </div>
      )}
    </div>
  );

  return (
    <>
      <div className="desktop-sidebar" style={{
        width: collapsed ? 60 : 224, background:'var(--sidebar)', borderRight:'1px solid var(--border)',
        display:'flex', flexDirection:'column', flexShrink:0, transition:'width .22s',
      }}>
        <Logo/>
        <nav style={{ flex:1, overflowY:'auto', overflowX:'hidden', padding:'12px 0' }}>
          {GROUPS.map(g => <Group key={g.title} g={g}/>)}
        </nav>
        <button onClick={() => setCollapsed(c=>!c)} style={{
          padding:'12px', borderTop:'1px solid var(--border)', display:'flex', alignItems:'center',
          justifyContent:'center', color:'var(--text3)', background:'transparent', fontSize:11, gap:6 }}
          onMouseEnter={e=>e.currentTarget.style.color='var(--accent)'}
          onMouseLeave={e=>e.currentTarget.style.color='var(--text3)'}>
          <Menu size={16}/>{!collapsed && <span>Collapse</span>}
        </button>
      </div>

      {/* Mobile hamburger (shown in header via CSS) */}
      <button id="mob-menu-btn" onClick={() => setMobileOpen(true)} style={{
        display:'none', alignItems:'center', justifyContent:'center', width:36, height:36,
        borderRadius:'var(--r)', background:'var(--surface2)', border:'1px solid var(--border)', color:'var(--text)' }}>
        <Menu size={18}/>
      </button>

      {mobileOpen && (
        <div style={{ position:'fixed', inset:0, zIndex:9000, display:'flex' }}>
          <div onClick={() => setMobileOpen(false)} style={{ position:'absolute', inset:0, background:'rgba(15,23,42,.4)' }}/>
          <div style={{ position:'relative', width:230, background:'var(--sidebar)', height:'100%', boxShadow:'var(--shadow2)', display:'flex', flexDirection:'column' }}>
            <div style={{ padding:'16px', borderBottom:'1px solid var(--border)', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
              <div style={{ fontWeight:800, fontSize:14, color:'var(--text)' }}>📦 PW Orders</div>
              <button onClick={() => setMobileOpen(false)} style={{ background:'var(--surface2)', borderRadius:6, padding:4, color:'var(--text2)' }}><X size={18}/></button>
            </div>
            <nav style={{ flex:1, overflowY:'auto', padding:'12px 0' }}>
              {GROUPS.map(g => <Group key={g.title} g={g} onNav={() => setMobileOpen(false)}/>)}
            </nav>
          </div>
        </div>
      )}

      <style>{`@media (max-width:768px){ .desktop-sidebar{display:none!important;} #mob-menu-btn{display:flex!important;} }`}</style>
    </>
  );
}
