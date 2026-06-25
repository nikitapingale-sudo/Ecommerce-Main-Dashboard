// ─────────────────────────────────────────────────────────────────────────────
//  EcomWallah — rule-based insight & decision engine
//  Answers questions and produces recommendations from the current bundle.
//  Percentage-first, decision-oriented.
// ─────────────────────────────────────────────────────────────────────────────
import { fmt, pct } from './dataEngine';

const r0 = (n) => `${n >= 0 ? '+' : ''}${Math.round(n)}%`;
const nm = (s) => (s == null ? '—' : String(s));

// How many SKUs make up 80% of revenue + the top-10 share.
function pareto(skus, totalRev) {
  const tot = totalRev || skus.reduce((a, s) => a + (s.revenue || 0), 0) || 1;
  let cum = 0, n = 0;
  for (const s of skus) { cum += s.revenue || 0; n++; if (cum / tot >= 0.8) break; }
  const top10 = skus.slice(0, 10).reduce((a, s) => a + (s.revenue || 0), 0) / tot * 100;
  return { n, top10Share: top10, total: skus.length };
}

// ── Recommendations (shared with the Action Center) ──
export function recommendations(b) {
  const m = b.metrics || {}; const recs = [];
  const mv = b.movers || {};
  if (m.delivRate < 60) recs.push({ sev:'high', icon:'✅', title:`Delivery rate below target — ${pct(m.delivRate)}`, detail:`Goal ≥ 60%. ${(m.inTransit||0).toLocaleString()} in transit + ${(m.received||0).toLocaleString()} awaiting processing. Expedite fulfilment to lift the rate.` });
  if (m.rtoRate > 8) recs.push({ sev:'high', icon:'🔁', title:`RTO / returns high — ${pct(m.rtoRate)}`, detail:`${(m.rto||0).toLocaleString()} orders (target < 8%). Audit worst couriers/states and tighten COD verification.` });
  if (m.cancelRate > 15) recs.push({ sev:'high', icon:'❌', title:`Cancellations high — ${pct(m.cancelRate)}`, detail:`${(m.cancelled||0).toLocaleString()} cancelled. Check stock-outs and payment failures.` });
  if (b.pendency && b.pendency.over15 > 0) recs.push({ sev:'high', icon:'🚨', title:`${b.pendency.over15.toLocaleString()} orders pending > 15 days`, detail:`Avg pendency ${(b.pendency.avgDays||0).toFixed(1)} days; ${fmt(b.pendency.pendingRev)} stuck in the pipeline. Clear oldest first.` });
  const cd = mv.category?.down?.[0]; if (cd) recs.push({ sev:'med', icon:'📉', title:`Category "${cd.name}" down ${r0(cd.deltaPct)} (30d)`, detail:`Revenue ${fmt(cd.prev)} → ${fmt(cd.cur)}. Review pricing, stock and listing quality.` });
  const chd = mv.channel?.down?.[0]; if (chd) recs.push({ sev:'med', icon:'📡', title:`Channel "${chd.name}" declining ${r0(chd.deltaPct)}`, detail:`Check listings, buy-box and ad spend on this channel.` });
  if (m.discPct > 40) recs.push({ sev:'med', icon:'💸', title:`Discount deep — ${pct(m.discPct)} of MRP`, detail:`Margin pressure. Review coupon depth and promo mix.` });
  const cg = mv.category?.up?.[0]; if (cg) recs.push({ sev:'low', icon:'🚀', title:`Scale "${cg.name}" — up ${r0(cg.deltaPct)} (30d)`, detail:`Fastest-growing category. Secure stock and push promotion.` });
  const chg = mv.channel?.up?.[0]; if (chg) recs.push({ sev:'low', icon:'📈', title:`"${chg.name}" channel growing ${r0(chg.deltaPct)}`, detail:`Invest more here while momentum is strong.` });
  if (!recs.length) recs.push({ sev:'low', icon:'✅', title:'All key metrics within healthy ranges', detail:'No critical actions right now — keep monitoring.' });
  return recs;
}

export const SUGGESTIONS = [
  'Give me a business summary',
  'Top SKUs & the 80/20 rule',
  'Which SKUs & categories are declining?',
  'How is fulfilment & RTO?',
  'Best performing coupons',
  'Which channels are growing?',
  'This month vs last month',
  'Compare COD vs Prepaid',
  'What actions should the team take?',
  'Pending orders status',
];

// ── Look up a specific entity the user named (coupon / channel / category / state / SKU) ──
function growthOf(mv, dimKey, name) {
  const d = mv[dimKey] || {};
  const hit = [...(d.up || []), ...(d.down || [])].find(x => x.name === name);
  return hit ? ` · 30-day trend ${r0(hit.deltaPct)}` : '';
}
function findEntity(t, b) {
  const by = b.by || {};
  // Coupon codes (short, exact-ish) — check first.
  for (const c of (b.couponStats?.coupons || []))
    if (c.coupon && t.includes(c.coupon.toLowerCase())) return { type: 'coupon', row: c };
  for (const c of (by.channel || []))
    if (c.name && c.name !== 'Unknown' && t.includes(c.name.toLowerCase())) return { type: 'channel', row: c };
  for (const c of (by.parent || []))
    if (c.name && c.name !== 'Unknown' && t.includes(c.name.toLowerCase())) return { type: 'category', row: c };
  for (const c of (by.state || []))
    if (c.name && c.name !== 'Unknown' && t.includes(c.name.toLowerCase())) return { type: 'state', row: c };
  // SKU by a meaningful word in its name (≥5 chars), pick highest-revenue match.
  const words = t.split(/[^a-z0-9]+/).filter(w => w.length >= 5);
  if (words.length) {
    for (const s of (b.sku || [])) {
      const n = (s.product_variant_name || '').toLowerCase();
      if (n && words.some(w => n.includes(w))) return { type: 'sku', row: s };
    }
  }
  return null;
}
function entityAnswer(ent, b) {
  const m = b.metrics || {}; const mv = b.movers || {}; const L = [];
  const r = ent.row;
  if (ent.type === 'coupon') {
    L.push(`🎟️ Coupon ${r.coupon}`);
    L.push(`• Revenue ${fmt(r.revenue)} · ${(r.orders||0).toLocaleString()} orders`);
    L.push(`• Successful ${(r.successOrders||0).toLocaleString()} (${pct(r.successRate)}) · unsuccessful ${(r.failOrders||0).toLocaleString()}`);
    const top = (b.couponStats?.couponSku || []).filter(x => x.coupon === r.coupon)[0];
    if (top) L.push(`• Top SKU on this coupon: ${nm(top.sku).slice(0,38)} (${fmt(top.revenue)})`);
    L.push(`💡 ${r.successRate >= 80 ? 'Strong success rate — scale this coupon.' : r.successRate < 60 ? 'Low success rate — discount is being wasted on RTO/cancels; reconsider.' : 'Decent; watch the unsuccessful share.'}`);
    return L.join('\n');
  }
  const dimKey = ent.type === 'category' ? 'category' : ent.type;
  L.push(`${ent.type === 'channel' ? '📡' : ent.type === 'state' ? '📍' : ent.type === 'sku' ? '🏷️' : '📚'} ${ent.type === 'sku' ? nm(r.product_variant_name).slice(0,40) : r.name}`);
  L.push(`• Revenue ${fmt(r.revenue)} (${pct(r.revShare)} of total) · ${(r.orders||0).toLocaleString()} orders · ${(r.qty||0).toLocaleString()} units`);
  L.push(`• AOV ${fmt(r.aov)} · ASP ${fmt(r.asp)}${growthOf(mv, dimKey, ent.type === 'sku' ? r.product_variant_name : r.name)}`);
  if (ent.type === 'sku') L.push(`• Category ${nm(r.parent_name)} · brand ${nm(r.vco_brand)} · discount ${pct(r.discount)}`);
  L.push(`💡 Contributes ${pct(r.revShare)} of revenue — ${r.revShare > 10 ? 'a key driver; protect stock & visibility.' : 'a smaller contributor.'}`);
  return L.join('\n');
}

// ── Compact data snapshot for the LLM ────────────────────────────────────────
//  Distils the (potentially large) bundle into a small, number-dense JSON object
//  the model can reason over. Kept tight so the prompt stays cheap & fast.
const round1 = (n) => (typeof n === 'number' ? Math.round(n * 10) / 10 : n);
const slimRow = (r) => ({
  name: r.name ?? (r.product_variant_name ? String(r.product_variant_name).slice(0, 48) : r.coupon),
  revenue: Math.round(r.revenue || 0),
  revShare: round1(r.revShare),
  orders: r.orders || 0,
  ...(r.qty != null ? { qty: r.qty } : {}),
  ...(r.successRate != null ? { successRate: round1(r.successRate) } : {}),
});
const slimMover = (m) => ({ name: m.name, deltaPct: Math.round(m.deltaPct || 0), cur: Math.round(m.cur || 0), prev: Math.round(m.prev || 0) });
const movers = (mv, k) => ({ up: (mv[k]?.up || []).slice(0, 5).map(slimMover), down: (mv[k]?.down || []).slice(0, 5).map(slimMover) });

export function buildContext(b) {
  b = b || {};
  const m = b.metrics || {};
  const by = b.by || {};
  const mv = b.movers || {};
  const p = b.pendency || {};
  const months = (b.date?.month || []).slice(-6).map(d => ({ date: d.date, revenue: Math.round(d.revenue || 0), orders: d.orders || 0 }));
  return {
    window: b.meta ? { from: b.meta.minDate, to: b.meta.maxDate, filteredRows: b.meta.filteredRows, totalRows: b.meta.totalRows } : undefined,
    metrics: {
      orders: m.orders, revenue: Math.round(m.rev || 0), aov: Math.round(m.aov || 0), asp: Math.round(m.asp || 0),
      units: m.qty, discountPctOfMRP: round1(m.discPct),
      deliveryRate: round1(m.delivRate), rtoRate: round1(m.rtoRate), cancelRate: round1(m.cancelRate),
      inTransit: m.inTransit, received: m.received, prepaidLines: m.prepaid, codLines: m.cod,
    },
    topChannels:   (by.channel || []).slice(0, 8).map(slimRow),
    topCategories: (by.parent  || []).slice(0, 8).map(slimRow),
    topStates:     (by.state   || []).slice(0, 8).map(slimRow),
    topSKUs:       (b.sku      || []).slice(0, 12).map(slimRow),
    topCoupons:    (b.couponStats?.coupons || []).slice(0, 8).map(slimRow),
    movers: { category: movers(mv, 'category'), channel: movers(mv, 'channel'), sku: movers(mv, 'sku'), state: movers(mv, 'state') },
    pendency: { count: p.count, avgDays: round1(p.avgDays), over15: p.over15, pendingRevenue: Math.round(p.pendingRev || 0) },
    monthlyTrend: months,
    recommendations: recommendations(b).slice(0, 5).map(r => `${r.title} — ${r.detail}`),
  };
}

// ── Main answer engine (rule-based fallback) ──
export function answer(q, b) {
  const m = b.metrics || {};
  const t = (q || '').toLowerCase();
  const has = (...ks) => ks.some(k => t.includes(k));
  const by = b.by || {};
  const mv = b.movers || {};
  const L = [];

  const isCompare = has('compare', 'versus', ' vs ', 'vs.', ' vs');

  // ── Comparisons ──
  if (isCompare || has('month over month', 'mom', 'week over week', 'wow', 'this month', 'last month')) {
    // Payment: COD vs Prepaid
    if (has('cod') && has('prepaid')) {
      const tot = (m.prepaid || 0) + (m.cod || 0) || 1;
      L.push(`💳 COD vs Prepaid`);
      L.push(`• COD: ${pct((m.cod||0)/tot*100)} (${(m.cod||0).toLocaleString()} lines)`);
      L.push(`• Prepaid: ${pct((m.prepaid||0)/tot*100)} (${(m.prepaid||0).toLocaleString()} lines)`);
      L.push(`💡 COD usually drives higher RTO — your RTO is ${pct(m.rtoRate)}. Nudging prepaid up would cut returns.`);
      return L.join('\n');
    }
    // Period: month-over-month
    if (has('month') || has('mom')) {
      const mo = b.date?.month || [];
      if (mo.length >= 2) {
        const a = mo[mo.length - 1], p = mo[mo.length - 2];
        const dRev = p.revenue ? (a.revenue - p.revenue) / p.revenue * 100 : 0;
        const dOrd = p.orders ? (a.orders - p.orders) / p.orders * 100 : 0;
        L.push(`📅 ${a.date} vs ${p.date} (month-over-month)`);
        L.push(`• Revenue ${fmt(p.revenue)} → ${fmt(a.revenue)} (${r0(dRev)})`);
        L.push(`• Orders ${(p.orders||0).toLocaleString()} → ${(a.orders||0).toLocaleString()} (${r0(dOrd)})`);
        L.push(`💡 ${dRev >= 0 ? 'Growth — keep momentum on the top categories/channels.' : 'Decline — see the Top Movers decliners and Action Center.'}`);
        return L.join('\n');
      }
    }
    // Period: week-over-week
    if (has('week') || has('wow')) {
      const d = b.date?.day || [];
      if (d.length >= 14) {
        const sum = (arr, k) => arr.reduce((s, r) => s + (r[k] || 0), 0);
        const rev = (sum(d.slice(-7), 'revenue') - sum(d.slice(-14, -7), 'revenue')) / (sum(d.slice(-14, -7), 'revenue') || 1) * 100;
        const ord = (sum(d.slice(-7), 'orders') - sum(d.slice(-14, -7), 'orders')) / (sum(d.slice(-14, -7), 'orders') || 1) * 100;
        L.push(`📆 Last 7 days vs prior 7 (week-over-week)`);
        L.push(`• Revenue ${r0(rev)} · Orders ${r0(ord)}`);
        L.push(`💡 ${rev >= 0 ? 'Up week-on-week — momentum positive.' : 'Down week-on-week — check decliners.'}`);
        return L.join('\n');
      }
    }
    // Entity vs entity
    const parts = t.split(/\bvs\b|versus|\bcompare\b|\band\b/).map(s => s.trim()).filter(Boolean);
    const ents = [];
    for (const part of parts) { const e = findEntity(part, b); if (e && !ents.find(x => x.type === e.type && JSON.stringify(x.row) === JSON.stringify(e.row))) ents.push(e); }
    if (ents.length >= 2) {
      const [a, c] = ents;
      const lab = (e) => e.type === 'coupon' ? e.row.coupon : e.type === 'sku' ? nm(e.row.product_variant_name).slice(0,22) : e.row.name;
      const rev = (e) => e.type === 'coupon' ? e.row.revenue : e.row.revenue;
      const ord = (e) => e.row.orders || 0;
      L.push(`⚖️ ${lab(a)} vs ${lab(c)}`);
      L.push(`• ${lab(a)}: ${fmt(rev(a))} · ${ord(a).toLocaleString()} orders`);
      L.push(`• ${lab(c)}: ${fmt(rev(c))} · ${ord(c).toLocaleString()} orders`);
      const diff = rev(c) ? (rev(a) - rev(c)) / rev(c) * 100 : 0;
      L.push(`💡 ${lab(a)} does ${r0(diff)} ${diff >= 0 ? 'more' : 'less'} revenue than ${lab(c)}.`);
      return L.join('\n');
    }
  }

  // Specific entity named? (coupon code, channel, category, state, SKU)
  // Skip when the user clearly wants a generic list ("top/all/list ...").
  if (!isCompare && !has('top ', 'all ', 'list ', 'best ', 'summary', 'overview')) {
    const ent = findEntity(t, b);
    if (ent) return entityAnswer(ent, b);
  }

  // Business summary / overview
  if (has('summary', 'overview', 'how are we', 'business', 'everything', 'snapshot', 'kpi')) {
    L.push(`📊 Business snapshot`);
    L.push(`• Orders: ${(m.orders||0).toLocaleString()} · Revenue: ${fmt(m.rev)} · AOV: ${fmt(m.aov)}`);
    L.push(`• Delivered ${pct(m.delivRate)} · RTO/returns ${pct(m.rtoRate)} · Cancelled ${pct(m.cancelRate)}`);
    if (by.channel?.[0]) L.push(`• Top channel: ${by.channel[0].name} (${pct(by.channel[0].revShare)} of revenue)`);
    if (by.parent?.[0]) L.push(`• Top category: ${by.parent[0].name} (${pct(by.parent[0].revShare)})`);
    if (mv.category?.up?.[0]) L.push(`• Fastest-growing category: ${mv.category.up[0].name} (${r0(mv.category.up[0].deltaPct)} in 30d)`);
    L.push(`💡 ${m.rtoRate > 8 ? `Priority: RTO at ${pct(m.rtoRate)} is above the 8% line — act now.` : `Health looks stable; focus on growing the top channels.`}`);
    return L.join('\n');
  }

  // Top SKUs / Pareto
  if (has('top sku', 'best sku', 'top product', 'best product', 'pareto', '80%', '80/20', 'concentration')) {
    const p = pareto(b.sku || [], m.rev);
    L.push(`🏷️ Top SKUs by revenue`);
    (b.sku || []).slice(0, 5).forEach((s, i) => L.push(`${i+1}. ${nm(s.product_variant_name).slice(0,42)} — ${fmt(s.revenue)} (${pct(s.revShare)})`));
    L.push(`📊 Top 10 SKUs = ${pct(p.top10Share)} of revenue. About ${p.n} SKUs drive 80% of revenue.`);
    L.push(`💡 Decision: protect stock & ad-spend on these few SKUs; the long tail (${Math.max(p.total - p.n, 0)}+ SKUs) contributes little — consider rationalising.`);
    return L.join('\n');
  }

  // Declining
  if (has('declin', 'drop', 'fall', 'losing', 'worst', 'down')) {
    L.push(`📉 Biggest decliners (last 30 days vs prior 30)`);
    (mv.sku?.down || []).slice(0, 5).forEach((s, i) => L.push(`${i+1}. SKU ${nm(s.name).slice(0,38)} — ${r0(s.deltaPct)} (${fmt(s.prev)}→${fmt(s.cur)})`));
    (mv.category?.down || []).slice(0, 3).forEach(c => L.push(`• Category ${c.name}: ${r0(c.deltaPct)}`));
    L.push(`💡 Decision: investigate pricing, stock-outs and listing issues for these; they are dragging revenue.`);
    return L.join('\n');
  }

  // Growing / movers
  if (has('grow', 'gain', 'rising', 'mover', 'increas', 'best perform')) {
    L.push(`🚀 Fastest growers (last 30 days)`);
    (mv.category?.up || []).slice(0, 4).forEach(c => L.push(`• Category ${c.name}: ${r0(c.deltaPct)} (${fmt(c.cur)})`));
    (mv.channel?.up || []).slice(0, 3).forEach(c => L.push(`• Channel ${c.name}: ${r0(c.deltaPct)}`));
    L.push(`💡 Decision: shift inventory & marketing toward these — momentum is on your side.`);
    return L.join('\n');
  }

  // Coupons
  if (has('coupon', 'promo', 'discount code', 'voucher')) {
    const cs = (b.couponStats && b.couponStats.coupons) || [];
    L.push(`🎟️ Coupon performance`);
    cs.slice(0, 5).forEach((c, i) => L.push(`${i+1}. ${c.coupon} — ${fmt(c.revenue)} · ${(c.orders||0).toLocaleString()} orders · ${pct(c.successRate)} success`));
    if (b.couponStats?.couponSku?.[0]) { const cx = b.couponStats.couponSku[0]; L.push(`• Top coupon×SKU: ${cx.coupon} on ${nm(cx.sku).slice(0,30)} (${fmt(cx.revenue)})`); }
    L.push(`💡 Decision: scale the high-success coupons; pause low-success ones (high orders but poor delivery = wasted discount).`);
    return L.join('\n');
  }

  // Fulfilment / RTO / cancellations
  if (has('deliver', 'fulfil', 'rto', 'cancel', 'return', 'ship')) {
    L.push(`🚚 Fulfilment health`);
    L.push(`• Delivery rate: ${pct(m.delivRate)} ${m.delivRate < 60 ? '(⚠ below 60% target)' : '(on target)'}`);
    L.push(`• RTO/returns: ${pct(m.rtoRate)} (${(m.rto||0).toLocaleString()}) ${m.rtoRate > 8 ? '⚠ high' : ''}`);
    L.push(`• Cancellations: ${pct(m.cancelRate)} (${(m.cancelled||0).toLocaleString()})`);
    L.push(`• In transit ${(m.inTransit||0).toLocaleString()} · Received ${(m.received||0).toLocaleString()}`);
    L.push(`💡 Decision: ${m.rtoRate > 8 ? 'attack RTO first — audit worst couriers/states.' : 'push in-transit orders to delivered to raise the rate.'}`);
    return L.join('\n');
  }

  // Pending
  if (has('pending', 'pendency', 'aging', 'stuck')) {
    const p = b.pendency || {};
    L.push(`⏳ Pendency`);
    L.push(`• ${(p.count||0).toLocaleString()} orders pending · avg ${(p.avgDays||0).toFixed(1)} days`);
    L.push(`• > 15 days: ${(p.over15||0).toLocaleString()} (critical) · revenue stuck: ${fmt(p.pendingRev)}`);
    if (p.byChannel?.[0]) L.push(`• Worst channel: ${p.byChannel[0].name} (${(p.byChannel[0].orders||0).toLocaleString()} pending)`);
    L.push(`💡 Decision: clear the >15-day backlog first — it's the biggest revenue & CX risk.`);
    return L.join('\n');
  }

  // Channels
  if (has('channel', 'marketplace')) {
    L.push(`📡 Channels by revenue`);
    (by.channel || []).slice(0, 6).forEach((c, i) => L.push(`${i+1}. ${c.name} — ${fmt(c.revenue)} (${pct(c.revShare)})`));
    if (mv.channel?.up?.[0]) L.push(`🚀 Growing: ${mv.channel.up[0].name} (${r0(mv.channel.up[0].deltaPct)})`);
    L.push(`💡 Decision: defend the top channel's share and invest behind the fastest grower.`);
    return L.join('\n');
  }

  // Categories / products
  if (has('category', 'categories', 'product')) {
    L.push(`📚 Categories by revenue`);
    (by.parent || []).slice(0, 6).forEach((c, i) => L.push(`${i+1}. ${c.name} — ${fmt(c.revenue)} (${pct(c.revShare)})`));
    L.push(`💡 Decision: the top 2–3 categories carry most revenue — keep them in stock above all.`);
    return L.join('\n');
  }

  // Geography
  if (has('state', 'region', 'geograph', 'city', 'location')) {
    L.push(`🗺️ Top states by revenue`);
    (by.state || []).slice(0, 6).forEach((c, i) => L.push(`${i+1}. ${c.name} — ${fmt(c.revenue)} (${pct(c.revShare)})`));
    if (mv.state?.up?.[0]) L.push(`🚀 Growing: ${mv.state.up[0].name} (${r0(mv.state.up[0].deltaPct)})`);
    L.push(`💡 Decision: position stock near the top demand states to cut delivery time & RTO.`);
    return L.join('\n');
  }

  // Payments
  if (has('payment', 'cod', 'prepaid')) {
    const tot = (m.prepaid || 0) + (m.cod || 0) || 1;
    L.push(`💳 Payment mix`);
    L.push(`• Prepaid: ${pct((m.prepaid||0)/tot*100)} · COD: ${pct((m.cod||0)/tot*100)}`);
    L.push(`💡 Decision: COD drives RTO — nudge prepaid with small incentives to cut returns.`);
    return L.join('\n');
  }

  // Revenue
  if (has('revenue', 'sales', 'gmv', 'aov', 'income')) {
    L.push(`💰 Revenue`);
    L.push(`• Gross revenue: ${fmt(m.rev)} · AOV: ${fmt(m.aov)} · Units: ${(m.qty||0).toLocaleString()}`);
    L.push(`• Avg discount: ${pct(m.discPct)} of MRP`);
    if (by.parent?.[0]) L.push(`• Top category: ${by.parent[0].name} (${pct(by.parent[0].revShare)})`);
    L.push(`💡 Decision: ${m.discPct > 40 ? 'discounts are deep — trim to protect margin.' : 'discount level is reasonable; push AOV with bundles.'}`);
    return L.join('\n');
  }

  // Actions
  if (has('action', 'should', 'recommend', 'improve', 'decision', 'do next', 'fix', 'priorit')) {
    L.push(`🎯 Recommended actions`);
    recommendations(b).slice(0, 5).forEach(rc => L.push(`${rc.icon} ${rc.title}\n   → ${rc.detail}`));
    return L.join('\n');
  }

  // Fallback
  return [
    `🤖 I'm EcomWallah — ask me about revenue, top/declining SKUs, channels, categories, coupons, fulfilment/RTO, pending orders, or "what actions should we take".`,
    `Quick reads:`,
    `• Revenue ${fmt(m.rev)} · ${(m.orders||0).toLocaleString()} orders · delivery ${pct(m.delivRate)} · RTO ${pct(m.rtoRate)}.`,
  ].join('\n');
}
