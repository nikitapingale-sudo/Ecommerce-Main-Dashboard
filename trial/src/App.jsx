import React, { useState, useEffect, useCallback, useRef } from 'react';
import { SlidersHorizontal, ChevronDown } from 'lucide-react';
import Sidebar from './components/Sidebar';
import FilterPanel from './components/FilterPanel';
import GlobalSearch from './components/GlobalSearch';
import OverviewPage from './pages/OverviewPage';
import RevenuePage from './pages/RevenuePage';
import FulfilmentPage from './pages/FulfilmentPage';
import ChannelsPage from './pages/ChannelsPage';
import ProductsPage from './pages/ProductsPage';
import SKUPage from './pages/SKUPage';
import GeographicPage from './pages/GeographicPage';
import PendencyPage from './pages/PendencyPage';
import OperationsPage from './pages/OperationsPage';
import RawDataPage from './pages/RawDataPage';
import EcomWallahPage from './pages/EcomWallahPage';
import CouponsPage from './pages/CouponsPage';
import ComponentSummaryPage from './pages/ComponentSummaryPage';
import ActionsPage from './pages/ActionsPage';
import ChatWidget from './components/ChatWidget';
import { fetchSummary, buildFilterOptions, EMPTY_BUNDLE } from './utils/dataEngine';

const DEFAULT_FILTERS = {
  dateFrom:'', dateTo:'',
  channels:[], warehouses:[], states:[], payments:[],
  oms:[], orderTypes:[], purchaseLevels:[], categories:[],
  statuses:[], finCats:[], orderCats:[], couriers:[], coupons:[],
  orderStatuses:[], lineStatuses:[],
};

const PAGE_LABELS = {
  ecomwallah:'🤖 EcomWallah', overview:'📊 Overview', revenue:'💰 Revenue', fulfilment:'🚚 Fulfilment',
  channels:'📡 Channels', products:'📚 Products', coupons:'🎟️ Coupons',
  skusummary:'🧾 SKU Level Summary', components:'🧩 Component Level Summary',
  geographic:'🗺️ Geographic', pendency:'⏳ Pendency',
  operations:'⚙️ Operations', actions:'🎯 Action Center', rawdata:'📋 Raw Data',
};

const PAGE_EYEBROW = {
  ecomwallah:'AI ASSISTANT', overview:'EXECUTIVE SUMMARY', revenue:'REVENUE & DISCOUNTS',
  channels:'CHANNELS & PAYMENTS', geographic:'STATES & CITIES', fulfilment:'DELIVERY & RTO',
  pendency:'OPEN ORDERS', operations:'WAREHOUSE & COURIER', actions:'WHAT TO DO NEXT',
  products:'CATEGORY DRILL-DOWN', coupons:'PROMO PERFORMANCE', rawdata:'ORDER-LEVEL DATA',
  skusummary:'SKU-LEVEL SUMMARY', components:'BUNDLE COMPONENT BREAKDOWN',
};

function StateMsg({ title, sub, spinner, action, tone }) {
  return (
    <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center',
                  height:'100%', textAlign:'center', color:'var(--text3)', gap:10 }}>
      {spinner && (
        <div style={{ width:32, height:32, border:'3px solid #e2e6f0',
                      borderTopColor:'var(--accent)', borderRadius:'50%',
                      animation:'pwspin 0.8s linear infinite' }}/>
      )}
      <div style={{ fontSize:16, fontWeight:700, color: tone === 'error' ? '#dc2626' : 'var(--text)' }}>{title}</div>
      {sub && <div style={{ fontSize:12, maxWidth:520 }}>{sub}</div>}
      {action && (
        <button onClick={action.onClick}
          style={{ marginTop:6, padding:'7px 16px', borderRadius:8, cursor:'pointer',
                   background:'var(--accent)', color:'#fff', border:'none', fontSize:12, fontWeight:700 }}>
          {action.label}
        </button>
      )}
      <style>{`@keyframes pwspin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

export default function App({ userEmail, onLogout }) {
  const [page, setPage] = useState('overview');
  const [menuOpen, setMenuOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [theme, setTheme] = useState(() => localStorage.getItem('pw_theme') || 'warm');

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('pw_theme', theme);
  }, [theme]);
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [lastUpdated, setLastUpdated] = useState(null);

  // Server-side aggregation: each filter change fetches a small summary bundle.
  const [bundle, setBundle] = useState(EMPTY_BUNDLE);
  const [loading, setLoading] = useState(true);     // true until first bundle arrives
  const [busy, setBusy] = useState(false);          // background re-fetch on filter change
  const [error, setError] = useState(null);
  const [totalOrders, setTotalOrders] = useState(0); // unfiltered order count (for header)
  const reqId = useRef(0);
  const firstLoad = useRef(true);

  const load = useCallback((flt) => {
    const myReq = ++reqId.current;
    setError(null);
    if (firstLoad.current) setLoading(true); else setBusy(true);
    fetchSummary(flt)
      .then(b => {
        if (myReq !== reqId.current) return;           // ignore stale responses
        setBundle(b);
        setLastUpdated(new Date());
        if (firstLoad.current) {
          buildFilterOptions(b);                       // options from unfiltered set
          setTotalOrders(b.metrics.orders);
          firstLoad.current = false;
        }
        setLoading(false); setBusy(false);
      })
      .catch(err => {
        if (myReq !== reqId.current) return;
        setError(err.message || String(err)); setLoading(false); setBusy(false);
      });
  }, []);

  // Initial load (unfiltered) — also populates the filter dropdowns.
  useEffect(() => { load(DEFAULT_FILTERS); }, [load]);

  // Re-fetch whenever filters change (skip the very first render).
  useEffect(() => {
    if (firstLoad.current) return;
    load(filters);
  }, [filters, load]);

  const filtOrders = bundle.metrics.orders;
  const TOTAL = totalOrders;
  const activeFilters = (() => {
    let n = (filters.dateFrom || filters.dateTo) ? 1 : 0;
    Object.entries(filters).forEach(([k, v]) => { if (k !== 'dateFrom' && k !== 'dateTo' && v?.length) n++; });
    return n;
  })();
  const updatedAt = lastUpdated
    ? lastUpdated.toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit', hour12:false })
    : '--:--';

  const renderPage = () => {
    const p = { data: bundle, filters, goto: setPage };
    switch(page) {
      case 'revenue':    return <RevenuePage    {...p}/>;
      case 'fulfilment': return <FulfilmentPage {...p}/>;
      case 'channels':   return <ChannelsPage   {...p}/>;
      case 'products':   return <ProductsPage   {...p}/>;
      case 'skusummary': return <SKUPage        {...p}/>;
      case 'components': return <ComponentSummaryPage {...p}/>;
      case 'geographic': return <GeographicPage {...p}/>;
      case 'pendency':   return <PendencyPage   {...p}/>;
      case 'operations': return <OperationsPage {...p}/>;
      case 'actions':    return <ActionsPage    {...p}/>;
      case 'coupons':    return <CouponsPage    {...p}/>;
      case 'ecomwallah': return <EcomWallahPage {...p}/>;
      case 'rawdata':    return <RawDataPage    {...p}/>;
      default:           return <OverviewPage   {...p}/>;
    }
  };

  return (
    <div style={{ display:'flex', height:'100vh', overflow:'hidden', background:'var(--bg)' }}>
      <Sidebar page={page} setPage={setPage}/>

      <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden', minWidth:0 }}>
        {/* ── Top header ── */}
        <div style={{
          background:'var(--surface)', borderBottom:'1px solid var(--border)',
          padding:'12px 20px', display:'flex', alignItems:'center',
          gap:14, flexShrink:0,
        }}>
          {/* Mobile hamburger (Sidebar renders the actual button, but we need space for it) */}
          <div id="mob-menu-placeholder" style={{ display:'none' }}>
            <div id="mob-menu-btn"/>
          </div>

          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontSize:10, fontWeight:700, color:'var(--text3)', letterSpacing:'.12em', textTransform:'uppercase', marginBottom:1 }}>{PAGE_EYEBROW[page]}</div>
            <div style={{ fontFamily:'var(--serif)', fontWeight:700, fontSize:20, color:'var(--text)', letterSpacing:'-0.01em' }}>{PAGE_LABELS[page]}</div>
            <div style={{ fontSize:11.5, color:'var(--text3)', marginTop:2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
              <b style={{ color:'var(--accent)', fontWeight:700 }}>{filtOrders.toLocaleString()}</b> of {TOTAL.toLocaleString()} orders
            </div>
          </div>

          {/* Global search (⌘K) */}
          {!loading && <GlobalSearch data={bundle} goto={setPage}/>}

          {/* Theme switcher */}
          <div style={{ display:'flex', gap:2, background:'var(--surface2)', border:'1px solid var(--border)', borderRadius:8, padding:3, flexShrink:0 }}>
            {[['light','☀️','Day'],['dark','🌙','Night'],['warm','🔥','Warm']].map(([t,ic,lbl]) => (
              <button key={t} onClick={() => setTheme(t)} title={lbl} style={{
                padding:'4px 9px', borderRadius:6, fontSize:12, lineHeight:1,
                background: theme===t ? 'var(--surface)' : 'transparent',
                boxShadow: theme===t ? 'var(--shadow)' : 'none',
                border: theme===t ? '1px solid var(--border)' : '1px solid transparent' }}>{ic}</button>
            ))}
          </div>

          {/* Updated timestamp */}
          <div style={{ display:'flex', alignItems:'center', gap:6, fontSize:11.5, color:'var(--text3)', flexShrink:0 }}>
            <span style={{ width:7, height:7, borderRadius:'50%', background: busy ? 'var(--yellow)' : 'var(--green)', boxShadow: busy?'0 0 0 3px rgba(217,119,6,.15)':'0 0 0 3px rgba(22,163,74,.15)' }}/>
            {busy ? 'Updating…' : <>Updated <b style={{ color:'var(--text2)', fontWeight:600 }}>{updatedAt}</b></>}
          </div>

          {/* FILTERS & PERIOD pill (opens the filter drawer) */}
          <button onClick={() => setFilterOpen(true)} style={{
            display:'flex', alignItems:'center', gap:10, padding:'7px 13px', borderRadius:11, flexShrink:0,
            background:'var(--surface)', border:'1px solid var(--border)', boxShadow:'var(--shadow)', color:'var(--text)' }}>
            <SlidersHorizontal size={16} color="var(--accent)"/>
            <div style={{ textAlign:'left', lineHeight:1.2 }}>
              <div style={{ fontSize:9, fontWeight:700, color:'var(--text3)', letterSpacing:'.08em' }}>FILTERS & PERIOD</div>
              <div style={{ fontSize:12.5, fontWeight:700, color:'var(--text)' }}>
                {(filters.dateFrom || filters.dateTo) ? `${filters.dateFrom||'…'} → ${filters.dateTo||'…'}` : 'All dates'}
                {activeFilters > 0 && <span style={{ color:'var(--accent)' }}> · {activeFilters} active</span>}
              </div>
            </div>
            <ChevronDown size={15} color="var(--text3)"/>
          </button>
          <span style={{ fontSize:11, color:'var(--text3)', whiteSpace:'nowrap', flexShrink:0 }}>
            <b style={{ color:'var(--text)' }}>{(bundle.meta.filteredRows||0).toLocaleString()}</b> / {(bundle.meta.totalRows||0).toLocaleString()} rows
          </span>

          {/* Avatar + logout menu */}
          <div style={{ position:'relative', flexShrink:0 }}>
            <button onClick={() => setMenuOpen(o=>!o)} title={userEmail}
              style={{ width:34, height:34, borderRadius:'50%', background:'var(--accent-grad)', display:'flex', alignItems:'center', justifyContent:'center', fontWeight:800, fontSize:12, color:'#fff', textTransform:'uppercase' }}>
              {(userEmail || 'PW').slice(0,2)}
            </button>
            {menuOpen && (
              <>
                <div onClick={() => setMenuOpen(false)} style={{ position:'fixed', inset:0, zIndex:40 }}/>
                <div style={{ position:'absolute', right:0, top:42, zIndex:41, width:220, background:'var(--surface)', border:'1px solid var(--border)', borderRadius:10, boxShadow:'var(--shadow2)', overflow:'hidden' }}>
                  <div style={{ padding:'12px 14px', borderBottom:'1px solid var(--border)' }}>
                    <div style={{ fontSize:11, color:'var(--text3)' }}>Signed in as</div>
                    <div style={{ fontSize:13, fontWeight:600, color:'var(--text)', overflow:'hidden', textOverflow:'ellipsis' }}>{userEmail}</div>
                  </div>
                  <button onClick={onLogout} style={{ width:'100%', textAlign:'left', padding:'10px 14px', background:'transparent', color:'var(--red)', fontSize:13, fontWeight:600 }}
                    onMouseEnter={e=>e.currentTarget.style.background='var(--surface2)'} onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
                    Log out
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        {/* ── Docked filters + page content ── */}
        <div style={{ flex:1, display:'flex', overflow:'hidden', minHeight:0 }}>
          <FilterPanel
            open={filterOpen}
            onClose={() => setFilterOpen(false)}
            filters={filters}
            onChange={setFilters}
            onReset={() => setFilters(DEFAULT_FILTERS)}
            dateBounds={{ minDate: bundle.meta.minDate, maxDate: bundle.meta.maxDate }}
          />
          <div style={{ flex:1, overflowY:'auto', padding:'16px 18px', position:'relative', minWidth:0 }}>
            {loading
              ? <StateMsg title="Loading orders from Trino…" sub="First load fetches the full dataset into the API (can take ~a minute); filtering after that is fast." spinner/>
              : error
                ? <StateMsg title="Could not load data" sub={error} action={{ label:'Retry', onClick: () => load(filters) }} tone="error"/>
                : renderPage()}
          </div>
        </div>
      </div>

      {/* Floating EcomWallah assistant (hidden while on its full page) */}
      {!loading && page !== 'ecomwallah' && <ChatWidget data={bundle}/>}

      <style>{`
        @media (max-width: 768px) {
          #mob-menu-placeholder { display: flex !important; }
        }
      `}</style>
    </div>
  );
}
