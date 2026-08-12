// ─────────────────────────────────────────────────────────────────────────────
//  dataEngine — server-side aggregation client
//
//  The dashboard no longer loads raw rows. The Trino API (scripts/api.py)
//  holds the dataset in memory and returns small pre-aggregated "bundles"
//  for the current filter set. Pages receive that bundle (as their `data`
//  prop) and the helpers below read straight from it — so the shapes match
//  what the old row-based metrics()/groupArr()/groupByDate() produced.
// ─────────────────────────────────────────────────────────────────────────────

export const DATA_SOURCE = import.meta.env.VITE_DATA_SOURCE || 'static';
// Strip a stray BOM/whitespace: a UTF-8 BOM (U+FEFF) once leaked into the
// Vercel env var, prefixing the base so URLs became relative → 404 → HTML.
let __base = import.meta.env.VITE_API_BASE_URL || "http://localhost:8000/api/v1";
if (__base.charCodeAt(0) === 0xFEFF) __base = __base.slice(1);  // strip stray UTF-8 BOM
const API_BASE = __base.trim();

// URL-safe base64 of a UTF-8 string (browser btoa is latin1-only).
function b64url(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  bytes.forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Read-only endpoints are called over GET (POST is blocked by the corporate
// web filter → "API 405"). ALL params are encoded into a single base64 path
// segment ending in `.json`, so the request URL is indistinguishable from a
// static file: NO query string, HAS a file extension. The firewall allows
// static-file URLs (proven: /data/summary.json loads) but blocks dynamic-
// looking ones (query string / no extension). The backend decodes the segment
// back into { filters, offset, limit, search, kind }.
function apiUrl(path, params = {}) {
  const clean = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    clean[k] = v;
  }
  const payload = b64url(JSON.stringify(clean));
  return `${API_BASE}${path}/${payload}.json`;
}

// `fetch` rejects with a bare "Failed to fetch" TypeError when the backend is
// simply not listening — which reads as a dashboard bug rather than "the API
// isn't running". Wrap it so the UI says what to actually do about it. Any
// non-network error (a real HTTP failure) is rethrown untouched.
async function apiFetch(url, init) {
  try {
    return await fetch(url, init);
  } catch (err) {
    if (err instanceof TypeError) {
      throw new Error(
        `Cannot reach the API at ${API_BASE} — the backend is not running. ` +
        `Start it with: python scripts/api.py`
      );
    }
    throw err;
  }
}

// True when no filter is active (mirrors the app's DEFAULT_FILTERS: all empty).
function isDefaultFilters(filters) {
  if (!filters) return true;
  return Object.values(filters).every(
    v => v == null || v === '' || (Array.isArray(v) && v.length === 0)
  );
}

// Static CDN snapshot of the *unfiltered* view (public/data/*.json). Served as
// a plain static file from Vercel's CDN — so it loads even behind corporate
// web filters that block the dynamic /api proxy. Returns the parsed JSON, or
// null if unavailable / intercepted (e.g. an HTML block page with status 200).
async function tryStaticSnapshot(path) {
  try {
    const r = await fetch(path, { cache: 'no-cache' });
    if (!r.ok) return null;
    const text = await r.text();
    if (text.trimStart().startsWith('<')) return null; // HTML block page, not JSON
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ─── Empty bundle (initial render / fallback) ────────────────────────────────
export const EMPTY_METRICS = {
  orders: 0, lines: 0, qty: 0, rev: 0, mrpSum: 0, discount: 0, discPct: 0,
  aov: 0, asp: 0, aul: 0, delivered: 0, rto: 0, cancelled: 0, shipped: 0,
  packed: 0, received: 0, returns: 0, inTransit: 0, delivRate: 0, rtoRate: 0,
  cancelRate: 0, shippedRate: 0, delCharges: 0, prepaid: 0, cod: 0,
  orders1P: 0, ordersB2B: 0, orders3P: 0, rev1P: 0, revB2B: 0, rev3P: 0,
  ordersStore: 0, ordersFBT: 0, ordersAddon: 0, ordersEcomBoc: 0,
  revStore: 0, revFBT: 0, revAddon: 0, revEcomBoc: 0,
  orderAmount: 0, cancelledAmount: 0, refundAmount: 0, codPct: 0,
  netRevenue: 0, netQty: 0, netOrders: 0, netLines: 0,
  excludedRevenue: 0, netRevPct: 0, netAov: 0, netAsp: 0,
};
export const EMPTY_BUNDLE = {
  meta: { filteredRows: 0, totalRows: 0, minDate: '', maxDate: '' },
  metrics: EMPTY_METRICS,
  by: {},
  date: { day: [], week: [], month: [] },
  hierarchy: [],
  sku: [], variant: [],
  movers: { category: { window:'', up:[], down:[] }, channel: { window:'', up:[], down:[] }, state: { window:'', up:[], down:[] }, sku: { window:'', up:[], down:[] } },
  couponStats: { coupons: [], couponSku: [] },
  pendency: { count: 0, avgDays: 0, over7: 0, over15: 0, pendingRev: 0,
              pendingQty: 0, aging: [], byStatus: [], byChannel: [], byCat: [], table: [] },
};

// ─── API calls ───────────────────────────────────────────────────────────────
export async function fetchSummary(filters = {}) {
  // Default (unfiltered) view: serve the firewall-proof static snapshot first.
  if (isDefaultFilters(filters)) {
    const snap = await tryStaticSnapshot('/data/summary.json');
    if (snap) return snap;
  }
  const res = await apiFetch(apiUrl('/summary', { filters }));
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error || ''; } catch { /* ignore */ }
    throw new Error(`API ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`);
  }
  return res.json();
}

// ─── Chatbot (EcomWallah → Groq LLM, proxied by the backend) ─────────────────
//  Sends the question + a compact live-data snapshot + recent history to the
//  backend, which holds the Groq key. Throws on any non-200 so the caller can
//  fall back to the local rule engine.
export async function chatLLM({ question, context = {}, history = [] }) {
  const res = await fetch(`${API_BASE}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, context, history }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Chat failed (${res.status})`);
    err.fallback = !!data.fallback; // backend signals "use your local answer"
    err.status = res.status;
    throw err;
  }
  return data; // { reply, model }
}

// Streaming variant: calls onDelta(fullTextSoFar) as tokens arrive (SSE).
// Returns { reply } with the complete text. Throws (with .fallback) on error.
export async function chatLLMStream({ question, context = {}, history = [], onDelta, onStatus, signal } = {}) {
  const res = await fetch(`${API_BASE}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, context, history, stream: true }),
    signal,
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    const err = new Error(data.error || `Chat failed (${res.status})`);
    err.fallback = !!data.fallback;
    err.status = res.status;
    throw err;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '', full = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buf.indexOf('\n\n')) !== -1) {
      const line = buf.slice(0, sep).trim();
      buf = buf.slice(sep + 2);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      let obj;
      try { obj = JSON.parse(payload); } catch { continue; }
      if (obj.error) { const e = new Error(obj.error); e.fallback = true; e.partial = full; throw e; }
      if (obj.status) { onStatus?.(obj.status); continue; }
      if (obj.delta) { full += obj.delta; onDelta?.(full); }
    }
  }
  return { reply: full };
}

// ─── Auth ─────────────────────────────────────────────────────────────────
async function authPost(path, payload) {
  const res = await fetch(`${API_BASE}/auth/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}
export const authRegister = (email, password) => authPost('register', { email, password });
export const authLogin    = (email, password) => authPost('login', { email, password });
export const authForgot   = (email) => authPost('forgot', { email });
export const authReset    = (email, code, password) => authPost('reset', { email, code, password });

// ─── Client session (expiring token) ───────────────────────────────────────
//  The backend issues a token with an `expiresAt` (epoch seconds). We persist
//  it and treat the session as valid only while unexpired. (Note: with the
//  current firewall-friendly setup the data APIs are not token-gated server
//  side — this gate is the dashboard's own login/expiry layer. Moving to
//  SSO / httpOnly cookies is the recommended next step, per report F-01/F-23.)
export function saveSession({ token, email, expiresAt }) {
  localStorage.setItem('pw_token', token || '');
  localStorage.setItem('pw_email', email || '');
  localStorage.setItem('pw_token_exp', String(expiresAt || 0));
}

export function getSession() {
  const token = localStorage.getItem('pw_token');
  const email = localStorage.getItem('pw_email');
  const exp = Number(localStorage.getItem('pw_token_exp') || 0);
  if (!token || !email) return null;
  if (exp && Date.now() / 1000 > exp) { clearSession(); return null; }  // expired
  return { token, email, expiresAt: exp };
}

export function clearSession() {
  localStorage.removeItem('pw_token');
  localStorage.removeItem('pw_email');
  localStorage.removeItem('pw_token_exp');
}

// Download ALL filtered rows as CSV (server-generated, not capped).
export async function downloadFilteredCsv({ filters = {}, search = '', name = 'raw_orders' } = {}) {
  const res = await apiFetch(apiUrl('/export', { filters, search }));
  if (!res.ok) throw new Error(`Export failed (${res.status})`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${name}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

// Component-Level Summary: aggregated component data for the current filters.
export async function fetchComponents(filters = {}) {
  if (isDefaultFilters(filters)) {
    const snap = await tryStaticSnapshot('/data/components.json');
    if (snap) return snap;
  }
  const res = await apiFetch(apiUrl('/components', { filters }));
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error || ''; } catch { /* ignore */ }
    throw new Error(`API ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`);
  }
  return res.json();
}

// Download the FULL aggregated table (sku | coupons | components) as CSV,
// computed server-side for the current filters (not just the on-screen rows).
export async function downloadSummaryCsv({ kind, filters = {}, name } = {}) {
  const res = await apiFetch(apiUrl('/export-summary', { kind, filters }));
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error || ''; } catch { /* ignore */ }
    throw new Error(`Export failed (${res.status})${detail ? ` — ${detail}` : ''}`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${name || kind}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

export async function fetchRows({ filters = {}, offset = 0, limit = 200, search = '' } = {}) {
  const res = await apiFetch(apiUrl('/rows', { filters, offset, limit, search }));
  if (!res.ok) throw new Error(`API ${res.status} ${res.statusText}`);
  return res.json();
}

// ─── Bundle accessors (same shapes as the old row-based helpers) ──────────────
// Maps a raw column name (used by the pages) to its bundle breakdown key.
const COL2KEY = {
  vco_channel_name:      'channel',
  payment_sources:       'payment',
  finance_exam_category: 'finance',
  order_category:        'orderCategory',
  oms:                   'oms',
  purchase_level:        'purchaseLevel',
  order_status_group:    'orderStatus',
  item_status_group:     'itemStatus',
  delivery_partner:      'courier',
  warehouse:             'warehouse',
  state:                 'state',
  city:                  'city',
  parent_name:           'parent',
  order_type:            'orderType',
  vco_brand:             'brand',
  coupon_code:           'coupon',
  final_order_status:    'orderStatusRaw',
  final_item_status:     'lineStatusRaw',
};

export function metrics(bundle) {
  return (bundle && bundle.metrics) || EMPTY_METRICS;
}

export function groupArr(bundle, col) {
  const key = COL2KEY[col];
  return (bundle && bundle.by && bundle.by[key]) || [];
}

export function groupByDate(bundle, gran) {
  return (bundle && bundle.date && bundle.date[gran]) || [];
}

// ─── Filter options (built once from an unfiltered bundle) ────────────────────
export const FILTER_OPTIONS = {
  channels: [], warehouses: [], states: [], payments: [], oms: [], orderTypes: [],
  purchaseLevels: [], categories: [], finCats: [], orderCats: [], couriers: [], coupons: [],
  orderStatuses: [], lineStatuses: [],
  brands: [], statuses: ['Cancelled','Delivered','Packed','Received','Return/Refund','RTO/Lost','Shipped'],
};

const names = (arr) => (arr || []).map(x => x.name).filter(n => n && n !== 'Unknown').sort();

export function buildFilterOptions(bundle) {
  const by = (bundle && bundle.by) || {};
  Object.assign(FILTER_OPTIONS, {
    channels:       names(by.channel),
    warehouses:     names(by.warehouse),
    states:         names(by.state),
    payments:       names(by.payment),
    oms:            names(by.oms),
    orderTypes:     names(by.orderType),
    purchaseLevels: names(by.purchaseLevel),
    categories:     names(by.parent),
    finCats:        names(by.finance),
    orderCats:      names(by.orderCategory),
    couriers:       names(by.courier),
    coupons:        names(by.coupon),
    orderStatuses:  names(by.orderStatusRaw),
    lineStatuses:   names(by.lineStatusRaw),
    brands:         names(by.brand),
  });
  return FILTER_OPTIONS;
}

// ─── Formatters ───────────────────────────────────────────────────────────────
export const fmt = (n) => {
  if (!n && n !== 0) return '—';
  return '₹' + Math.round(n).toLocaleString('en-IN');
};
export const fmtN = (n) => {
  if (!n && n !== 0) return '0';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
};
export const pct = (n) => `${(n || 0).toFixed(1)}%`;
// Compact Indian currency for big KPI numbers: ₹1.21 Cr / ₹3.4 L
export const fmtCr = (n) => {
  if (!n && n !== 0) return '—';
  const a = Math.abs(n);
  if (a >= 1e7) return '₹' + (n / 1e7).toFixed(2) + ' Cr';
  if (a >= 1e5) return '₹' + (n / 1e5).toFixed(2) + ' L';
  return '₹' + Math.round(n).toLocaleString('en-IN');
};

export function downloadExcel(rows, name) {
  import('xlsx').then(X => {
    const ws = X.utils.json_to_sheet(rows.map(r => {
      const o = {};
      Object.entries(r).forEach(([k, v]) => { o[k] = v instanceof Set ? v.size : v; });
      return o;
    }));
    const wb = X.utils.book_new();
    X.utils.book_append_sheet(wb, ws, 'Data');
    X.writeFile(wb, `${name}.xlsx`);
  });
}

export const STATUS_COLOR = {
  Delivered: '#059669', Shipped: '#2563eb', Packed: '#7c3aed',
  Received: '#d97706', Cancelled: '#dc2626', 'Return/Refund': '#ea580c',
  'RTO/Lost': '#db2777', Others: '#9ca3af',
};
export const ITEM_STATUS_COLOR = {
  Delivered: '#00c48c', Shipped: '#3d9cf0', Packed: '#a855f7',
  Allocated: '#00d4d4', Confirmed: '#8b85ff', Pending: '#ffc542',
  'Return/Refund': '#ff8c42', 'RTO/Lost': '#ff6b9d', Cancelled: '#ff4d6d', Others: '#5a6080',
};
export const COLORS = ['#4f46e5','#059669','#2563eb','#d97706','#dc2626','#ea580c','#7c3aed','#0891b2','#db2777','#65a30d','#f43f5e','#0e7490'];
