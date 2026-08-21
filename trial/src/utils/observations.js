/* ── Observation rules ───────────────────────────────────────────────────────
   Every observation shown on the Observations page is DERIVED here from the
   same filtered bundle the rest of the dashboard renders — none of it is
   written down as prose. That matters: a finding that stops being true once a
   filter is applied stops being displayed, so the page can never drift out of
   agreement with the charts next to it.

   A rule returns null when it has nothing to say. Thresholds are the trigger,
   so "PW_Store is 53% of revenue" appears only while that is actually the case.

   Each rule returns:
     { id, group, severity, title, stat, statSub, detail, why, evidence[], page?, drill? }
   severity is one of critical | watch | info | good, and always renders with an
   icon and a word as well as a colour — never colour alone.
─────────────────────────────────────────────────────────────────────────────── */

import { fmtCr, pct, full } from './dataEngine';

export const GROUPS = [
  'Concentration & dependency',
  'Fulfilment & pendency',
  'Pricing & payments',
  'Data quality',
  'Coverage & recency',
];
const [G_CONC, G_FUL, G_PRICE, G_DQ, G_COV] = GROUPS;

export const SEVERITY = {
  critical: { rank: 0, label: 'Critical', icon: '⛔', color: 'var(--st-critical)' },
  watch:    { rank: 1, label: 'Watch',    icon: '⚠️', color: 'var(--st-serious)' },
  info:     { rank: 2, label: 'Note',     icon: 'ℹ️', color: 'var(--blue)' },
  good:     { rank: 3, label: 'Healthy',  icon: '✅', color: 'var(--st-good)' },
};

/* ── helpers ─────────────────────────────────────────────────────────────── */
const arr  = (x) => (Array.isArray(x) ? x : []);
const byRev = (rows) => arr(rows).slice().sort((a, b) => (b.revenue || 0) - (a.revenue || 0));
const find  = (rows, name) =>
  arr(rows).find(r => String(r.name || '').trim().toLowerCase() === name.toLowerCase());
const share = (v, t) => (t > 0 ? (v / t) * 100 : 0);
const median = (xs) => {
  const s = xs.slice().sort((a, b) => a - b);
  if (!s.length) return 0;
  const h = Math.floor(s.length / 2);
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
};
// "Unknown"-style placeholders, including the literal string NULL that some
// upstream rows carry — those two are different problems and stay separate.
const isBlank = (n) => ['unknown', '', 'none', 'nan', 'n/a', '-'].includes(String(n || '').trim().toLowerCase());
const isNullStr = (n) => String(n || '').trim().toUpperCase() === 'NULL';

/* ── Missing-value rules, one per dimension ──────────────────────────────────
   Each entry carries its own copy, because "no coupon code" and "no delivery
   state" mean completely different things and must not be reported alike. */
const MISSING = [
  {
    col: 'state', label: 'a delivery state', page: 'geographic', warn: 5,
    title: (p) => `${pct(p)} of revenue has no delivery state`,
    why: 'The Geographic page can only place orders that carry a state, so every state total on it is a share of the mapped orders — not of the business. Marketplace orders are the usual cause: the platform keeps the buyer address.',
  },
  {
    col: 'courier', label: 'a courier', page: 'channels', warn: 5,
    title: (p) => `${pct(p)} of revenue has no courier recorded`,
    why: 'Courier-level delivery and RTO comparisons exclude these orders, so a courier league table built on them is only representative of the fulfilment the OMS controls.',
  },
  {
    col: 'parent', label: 'a category', page: 'products', warn: 5,
    title: (p) => `${pct(p)} of revenue sits outside the category tree`,
    why: 'These orders never appear under any parent category, so category mix understates the total by exactly this much.',
  },
  {
    col: 'materialType', label: 'a material type', page: 'components', warn: 10,
    title: (p) => `${pct(p)} of revenue has no product material type`,
    why: 'Material type comes from the mapping sheet plus bundle inheritance. What is left unmapped is genuinely new or mis-keyed SKUs, and it lands in the Unknown row of the material type table.',
  },
];

/* ── The rules ───────────────────────────────────────────────────────────── */
const RULES = [

  /* ══ Concentration & dependency ══════════════════════════════════════════ */

  // Top channel share.
  ({ m, by }) => {
    const rows = byRev(by.channel);
    if (rows.length < 2 || !m.rev) return null;
    const t = rows[0], s = share(t.revenue, m.rev);
    if (s < 35) return null;
    const second = rows[1];
    return {
      id: 'channel-concentration', group: G_CONC,
      severity: s >= 50 ? 'watch' : 'info',
      title: `${t.name} carries ${pct(s)} of all revenue`,
      stat: pct(s), statSub: `${t.name} share`,
      detail: `${fmtCr(t.revenue)} of ${fmtCr(m.rev)} arrives through one channel. The next largest, ${second.name}, is ${pct(share(second.revenue, m.rev))} — a gap of ${pct(s - share(second.revenue, m.rev))}.`,
      why: 'A channel this dominant sets the ceiling on total growth. An outage, a policy change or a ranking drop there moves the whole P&L, and no other channel is large enough to absorb it.',
      evidence: [[t.name, fmtCr(t.revenue)], [second.name, fmtCr(second.revenue)], ['Channels live', String(rows.length)]],
      page: 'channels', drill: { channels: [t.name] },
    };
  },

  // A bulk channel: large revenue from very few orders.
  ({ m, by }) => {
    const rows = byRev(by.channel);
    const b = rows.find(r => share(r.revenue, m.rev) >= 10 && share(r.orders, m.orders) < 2);
    if (!b) return null;
    return {
      id: 'bulk-channel', group: G_CONC, severity: 'watch',
      title: `${b.name} is ${pct(share(b.revenue, m.rev))} of revenue from ${pct(share(b.orders, m.orders))} of orders`,
      stat: full(b.orders), statSub: 'orders carrying that revenue',
      detail: `${full(b.orders)} orders produce ${fmtCr(b.revenue)} — an average order of ${fmtCr(b.aov)} against ${fmtCr(m.aov)} across the business. ${full(b.qty)} units move on those orders.`,
      why: 'Bulk institutional orders behave nothing like retail ones: a handful of buyers decide a third of revenue, and the timing of a single purchase order can make a month look strong or weak. Blended averages that mix them with retail are misleading — read this channel on its own.',
      evidence: [['Orders', full(b.orders)], ['Revenue', fmtCr(b.revenue)], ['AOV', fmtCr(b.aov)], ['Units', full(b.qty)]],
      page: 'channels', drill: { channels: [b.name] },
    };
  },

  // Top SKU share.
  ({ m, sku, meta }) => {
    const rows = byRev(sku);
    if (!rows.length || !m.rev) return null;
    const t = rows[0], s = share(t.revenue, m.rev);
    if (s < 5) return null;
    const top10 = rows.slice(0, 10).reduce((a, r) => a + (r.revenue || 0), 0);
    return {
      id: 'sku-concentration', group: G_CONC,
      severity: s >= 10 ? 'watch' : 'info',
      title: `One SKU is ${pct(s)} of revenue`,
      stat: pct(s), statSub: 'top SKU share',
      detail: `${t.product_variant_name || t.sku_code} alone did ${fmtCr(t.revenue)} across ${full(t.orders)} orders. The top 10 SKUs together are ${pct(share(top10, m.rev))} of revenue, out of ${full(meta.skuTotal || rows.length)} selling SKUs.`,
      why: 'A catalogue this top-heavy means stock-outs on a single title are a revenue event, not an operations detail. It also means the long tail is contributing far less than its shelf space and working capital suggest.',
      evidence: [['Top SKU', fmtCr(t.revenue)], ['Top 10', fmtCr(top10)], ['Selling SKUs', full(meta.skuTotal || rows.length)]],
      page: 'skusummary',
    };
  },

  // Courier / warehouse single-point-of-failure.
  ...['courier', 'warehouse'].map(col => ({ m, by }) => {
    const rows = byRev(by[col]).filter(r => !isBlank(r.name) && !isNullStr(r.name));
    if (rows.length < 2 || !m.rev) return null;
    const t = rows[0], s = share(t.revenue, m.rev);
    if (s < 45) return null;
    return {
      id: `${col}-concentration`, group: G_CONC,
      severity: s >= 60 ? 'watch' : 'info',
      title: `${t.name} handles ${pct(s)} of ${col === 'courier' ? 'shipped revenue' : 'dispatched revenue'}`,
      stat: pct(s), statSub: `top ${col} share`,
      detail: `${fmtCr(t.revenue)} moves through a single ${col}, across ${full(t.orders)} orders. ${rows.length - 1 === 1 ? `Just one other ${col} carries` : `${rows.length - 1} other ${col}s share`} the rest.`,
      why: col === 'courier'
        ? 'One carrier holding this much volume means their service levels are effectively your service levels, and a rate change lands with no negotiating alternative ready.'
        : 'A single warehouse this dominant is a physical single point of failure — a shutdown, a stock-count freeze or a regional disruption stops most dispatches at once.',
      evidence: rows.slice(0, 3).map(r => [r.name, fmtCr(r.revenue)]),
      page: 'channels',
    };
  }),

  // Category concentration.
  ({ m, by }) => {
    const rows = byRev(by.parent).filter(r => !isBlank(r.name));
    if (rows.length < 2 || !m.rev) return null;
    const t = rows[0], s = share(t.revenue, m.rev);
    if (s < 50) return null;
    return {
      id: 'category-concentration', group: G_CONC, severity: 'info',
      title: `${t.name} is ${pct(s)} of revenue`,
      stat: pct(s), statSub: 'top category share',
      detail: `${fmtCr(t.revenue)} of ${fmtCr(m.rev)} sits in one parent category, ahead of ${rows[1].name} at ${pct(share(rows[1].revenue, m.rev))}.`,
      why: 'Demand here follows one exam calendar. Revenue will move with that cycle rather than with anything the team does, so month-on-month comparisons across the cycle boundary will mislead unless the category is read separately.',
      evidence: rows.slice(0, 4).map(r => [r.name, fmtCr(r.revenue)]),
      page: 'products', drill: { categories: [t.name] },
    };
  },

  /* ══ Fulfilment & pendency ═══════════════════════════════════════════════ */

  ({ m }) => {
    if (!m.orders) return null;
    const r = m.delivRate || 0;
    return {
      id: 'delivery-rate', group: G_FUL,
      severity: r >= 85 ? 'good' : r >= 70 ? 'info' : 'watch',
      title: `${pct(r)} of orders reach the customer`,
      stat: pct(r), statSub: 'delivery rate',
      detail: `${full(m.delivered)} of ${full(m.orders)} orders are delivered. ${full(m.inTransit)} are still moving and ${full(m.rto)} came back as RTO or were lost.`,
      why: r >= 85
        ? 'This is a healthy completion rate — the gap that remains is mostly orders still in flight rather than failures.'
        : 'The shortfall is not all failure: a large in-transit block depresses this number simply because recent orders have not landed yet. Read it together with the pendency ageing before treating it as a delivery problem.',
      evidence: [['Delivered', full(m.delivered)], ['In transit', full(m.inTransit)], ['RTO / lost', full(m.rto)]],
      page: 'overview',
    };
  },

  ({ m, by }) => {
    if (!m.orders || !m.rto) return null;
    const r = m.rtoRate || 0;
    // Prefer the RTO bucket's own revenue over any per-order estimate — the
    // status breakdown already carries the exact value that came back.
    const row = find(by.orderStatus, 'RTO/Lost') || find(by.itemStatus, 'RTO/Lost');
    const val = row ? row.revenue : null;
    return {
      id: 'rto-rate', group: G_FUL,
      severity: r >= 6 ? 'critical' : r >= 3 ? 'watch' : 'good',
      title: `RTO and lost shipments run at ${pct(r)}`,
      stat: pct(r), statSub: 'of all orders',
      detail: `${full(m.rto)} orders came back to origin or were lost${val ? `, carrying ${fmtCr(val)} of order value — shipped twice and realised once` : ''}.`,
      why: 'RTO pays for the outbound leg, the return leg and the handling on both, and the stock comes back too late for the demand that triggered it. It concentrates in cash-on-delivery and in specific pin codes, so it responds to targeting rather than to blanket effort.',
      evidence: [['RTO orders', full(m.rto)], ['RTO rate', pct(r)], ...(val ? [['Value returned', fmtCr(val)]] : [])],
      page: 'geographic',
    };
  },

  // Pendency ageing — the single biggest operational finding in this dataset.
  ({ p, m }) => {
    if (!p || !p.count) return null;
    const sh = share(p.over15 || 0, p.count);
    return {
      id: 'pendency-aging', group: G_FUL,
      severity: (p.avgDays || 0) >= 20 || sh >= 40 ? 'critical' : sh >= 20 ? 'watch' : 'info',
      title: `${full(p.over15)} orders have been open longer than 15 days`,
      stat: `${Math.round(p.avgDays || 0)} days`, statSub: 'average age of open orders',
      detail: `${full(p.count)} orders are still open, holding ${fmtCr(p.pendingRev)} and ${full(p.pendingQty)} units. ${full(p.over7)} are past 7 days and ${full(p.over15)} — ${pct(sh)} of the open book — are past 15.`,
      why: 'Ageing pendency is working capital sitting still, and it converts into cancellations and refund requests the longer it runs. An average age near a month means the backlog is structural rather than a spike, so clearing it needs capacity, not a push.',
      evidence: [['Open orders', full(p.count)], ['Value held', fmtCr(p.pendingRev)], ['Past 7 days', full(p.over7)], ['Past 15 days', full(p.over15)]],
      page: 'overview',
    };
  },

  // In-transit block.
  ({ m }) => {
    if (!m.orders || !m.inTransit) return null;
    const s = share(m.inTransit, m.orders);
    if (s < 8) return null;
    return {
      id: 'in-transit', group: G_FUL, severity: s >= 15 ? 'watch' : 'info',
      title: `${pct(s)} of orders are still in transit`,
      stat: full(m.inTransit), statSub: 'orders in flight',
      detail: `${full(m.inTransit)} orders have left the warehouse but have not been marked delivered. ${full(m.shipped)} are shipped and ${full(m.packed)} are packed and waiting to move.`,
      why: 'This block is the reason the delivery rate cannot reach 100% in any recent window — those orders have simply not finished yet. It becomes a problem only when the ageing curve shows them sitting rather than moving.',
      evidence: [['In transit', full(m.inTransit)], ['Shipped', full(m.shipped)], ['Packed', full(m.packed)]],
      page: 'overview',
    };
  },

  /* ══ Pricing & payments ══════════════════════════════════════════════════ */

  // Read the payment split from the payment breakdown itself. The metrics block
  // carries COD/prepaid at line level and codPct at order level, so mixing the
  // two produces a headline that contradicts its own detail line.
  ({ m, by }) => {
    const rows = arr(by.payment);
    const cod = find(rows, 'COD'), pre = find(rows, 'Prepaid');
    if (!cod || !pre) return null;
    const chooser = cod.orders + pre.orders;            // orders that pick a mode
    if (!chooser) return null;
    const ofChooser = share(cod.orders, chooser);
    const ofAll = share(cod.orders, m.orders);
    return {
      id: 'cod-share', group: G_PRICE,
      severity: ofChooser >= 40 ? 'watch' : 'info',
      title: `Cash on delivery is ${pct(ofChooser)} of orders where the customer picks a payment mode`,
      stat: pct(ofChooser), statSub: `COD share — ${pct(ofAll)} of every order`,
      detail: `${full(cod.orders)} COD orders against ${full(pre.orders)} prepaid. The other ${full(m.orders - chooser)} orders are marketplace- or account-settled and never expose a payment mode, which is why COD is only ${pct(ofAll)} when measured against every order.`,
      why: 'COD is where almost all RTO originates and it delays cash by the full delivery cycle. Quote the right denominator: against total orders it looks like a fifth of the business, but on the orders a customer actually chooses for it sits near half — and that is the number a prepaid-nudge campaign moves.',
      evidence: [['COD orders', full(cod.orders)], ['Prepaid orders', full(pre.orders)], ['COD revenue', fmtCr(cod.revenue)], ['Of all orders', pct(ofAll)]],
      page: 'revenue', drill: { payments: ['COD'] },
    };
  },

  // 1P vs 3P price positioning.
  ({ m, by }) => {
    const rows = byRev(by.purchaseLevel);
    const one = find(rows, '1P'), three = find(rows, '3P');
    if (!one || !three || !one.asp || !three.asp) return null;
    const gap = ((one.asp - three.asp) / one.asp) * 100;
    if (Math.abs(gap) < 20) return null;
    return {
      id: 'asp-gap', group: G_PRICE, severity: 'info',
      title: `Marketplace selling price runs ${pct(Math.abs(gap))} below own-store`,
      stat: fmtCr(three.asp), statSub: `3P average selling price vs ${fmtCr(one.asp)} on 1P`,
      detail: `Own-store sells at ${fmtCr(one.asp)} a unit across ${full(one.orders)} orders; marketplaces sell at ${fmtCr(three.asp)} across ${full(three.orders)}.`,
      why: 'Part of this is genuine price positioning and part is mix — marketplaces skew to single cheap titles while the store sells modules and combos. Before treating it as underpricing, compare the two on the same material type, because the gap largely disappears within a like-for-like basket.',
      evidence: [['1P ASP', fmtCr(one.asp)], ['3P ASP', fmtCr(three.asp)], ['1P revenue', fmtCr(one.revenue)], ['3P revenue', fmtCr(three.revenue)]],
      page: 'revenue',
    };
  },

  // Discount depth.
  ({ m }) => {
    if (!m.mrpSum || !m.discount) return null;
    const d = m.discPct || 0;
    return {
      id: 'discount-depth', group: G_PRICE,
      severity: d >= 35 ? 'watch' : 'info',
      title: `${pct(d)} of catalogue value is given away as discount`,
      stat: fmtCr(m.discount), statSub: 'discount against MRP',
      detail: `${fmtCr(m.mrpSum)} of MRP converts to ${fmtCr(m.rev)} of revenue. The gap is ${fmtCr(m.discount)}.`,
      why: 'This is the blended give-away across every channel, including marketplace-funded promotions. It is worth splitting by channel before drawing a pricing conclusion — a discount the marketplace pays for is a different decision from one funded off your own margin.',
      evidence: [['MRP value', fmtCr(m.mrpSum)], ['Realised', fmtCr(m.rev)], ['Discount', fmtCr(m.discount)], ['Rate', pct(d)]],
      page: 'revenue',
    };
  },

  /* ══ Data quality ════════════════════════════════════════════════════════ */

  // One rule per dimension with a meaningful blank share.
  ...MISSING.map(cfg => ({ m, by }) => {
    const rows = arr(by[cfg.col]);
    if (!rows.length || !m.rev) return null;
    const blanks = rows.filter(r => isBlank(r.name));
    if (!blanks.length) return null;
    const rev = blanks.reduce((a, r) => a + (r.revenue || 0), 0);
    const ord = blanks.reduce((a, r) => a + (r.orders || 0), 0);
    const p = share(rev, m.rev);
    if (p < 1) return null;
    return {
      id: `missing-${cfg.col}`, group: G_DQ,
      severity: p >= cfg.warn * 2 ? 'watch' : 'info',
      title: cfg.title(p),
      stat: pct(p), statSub: `revenue without ${cfg.label}`,
      detail: `${full(ord)} orders worth ${fmtCr(rev)} carry no value in this field, out of ${fmtCr(m.rev)} total.`,
      why: cfg.why,
      evidence: [['Orders affected', full(ord)], ['Revenue affected', fmtCr(rev)], ['Share of revenue', pct(p)]],
      page: cfg.page,
    };
  }),

  // A literal "NULL" string is a different defect from a genuine blank.
  ({ m, by }) => {
    const hits = [];
    Object.entries(by || {}).forEach(([col, rows]) => {
      arr(rows).filter(r => isNullStr(r.name)).forEach(r => hits.push({ col, ...r }));
    });
    if (!hits.length) return null;
    const rev = hits.reduce((a, r) => a + (r.revenue || 0), 0);
    const ord = hits.reduce((a, r) => a + (r.orders || 0), 0);
    return {
      id: 'null-string', group: G_DQ, severity: 'watch',
      title: `The text "NULL" is stored as a real value in ${hits.length} field${hits.length > 1 ? 's' : ''}`,
      stat: full(ord), statSub: 'orders carrying a literal NULL',
      detail: `${hits.map(h => `${h.col} (${full(h.orders)} orders, ${fmtCr(h.revenue)})`).join('; ')}. Together ${fmtCr(rev)}.`,
      why: 'This is a genuine pipeline defect, not a missing value. The string "NULL" survives every emptiness check, so it silently becomes its own category — it will appear as a courier in a courier list and be counted as a real one. It needs fixing upstream, not filtering here.',
      evidence: hits.slice(0, 4).map(h => [h.col, `${full(h.orders)} orders`]),
      page: 'rawdata',
    };
  },

  // Cancelled orders with no cancellation date.
  ({ m }) => {
    if (!m.cancelled || (m.cancelledAmount || 0) > 0) return null;
    return {
      id: 'cancel-no-date', group: G_DQ, severity: 'watch',
      title: `${full(m.cancelled)} cancelled orders carry no cancellation date`,
      stat: '₹0', statSub: 'cancelled amount recorded',
      detail: `${full(m.cancelled)} orders sit in a cancelled status, but the Cancelled Amount card reads ₹0 because it counts only orders that carry a cancellation date — and none of these do.`,
      why: 'The KPI is behaving exactly as specified; the source data is the gap. Until the cancellation date is populated upstream, cancelled value cannot be measured or trended, and the cancellation rate is countable while its rupee impact is not.',
      evidence: [['Cancelled orders', full(m.cancelled)], ['Cancelled amount', '₹0'], ['Refund amount', fmtCr(m.refundAmount)]],
      page: 'overview',
    };
  },

  // Dimensions that carry only one value are not filters.
  ({ by }) => {
    const singles = ['finance', 'brand', 'oms', 'warehouse']
      .map(c => ({ c, rows: arr(by[c]) }))
      .filter(x => x.rows.length === 1)
      .map(x => `${x.c} (only "${x.rows[0].name}")`);
    if (!singles.length) return null;
    return {
      id: 'single-valued', group: G_DQ, severity: 'info',
      title: `${singles.length} dimension${singles.length > 1 ? 's carry' : ' carries'} a single value`,
      stat: String(singles.length), statSub: 'constant dimensions',
      detail: `${singles.join(', ')}. A field with one value cannot split anything.`,
      why: 'These add a filter control and a chart slice that can never change the view. Either the upstream field is not being populated with its real variety, or the dimension is genuinely constant for this business and the control is just noise on screen.',
      evidence: singles.map(s => [s.split(' (')[0], s.split('(')[1].replace(')', '')]),
      page: 'rawdata',
    };
  },

  /* ══ Coverage & recency ══════════════════════════════════════════════════ */

  // The most recent day is almost always partial — say so, loudly.
  ({ date }) => {
    const day = arr(date && date.day);
    if (day.length < 10) return null;
    const last = day[day.length - 1];
    const prior = day.slice(-31, -1).map(d => d.orders || 0);
    const med = median(prior);
    if (!med || (last.orders || 0) >= med * 0.5) return null;
    const down = 100 - share(last.orders || 0, med);
    return {
      id: 'partial-last-day', group: G_COV, severity: 'critical',
      title: `The last day in the data is incomplete — read the trend one day short`,
      stat: full(last.orders), statSub: `orders on ${last.date} vs a ${full(med)} median`,
      detail: `${last.date} shows ${full(last.orders)} orders and ${fmtCr(last.revenue)}, which is ${pct(down)} below the median of the previous 30 days. That is a loading artefact, not a collapse in demand.`,
      why: 'The extraction runs partway through the day, so the final point on every trend chart is a partial day. Anyone reading the chart end-to-end will see a cliff and treat it as a crash. Compare like-for-like by ending one day earlier.',
      evidence: [['Last day', last.date], ['Orders that day', full(last.orders)], ['30-day median', full(med)], ['Shortfall', pct(down)]],
      page: 'overview',
    };
  },

  // Week-on-week direction, computed from the daily series.
  ({ date }) => {
    const day = arr(date && date.day);
    if (day.length < 15) return null;
    // Drop the final partial day so the comparison is honest.
    const d = day.slice(0, -1);
    const cur = d.slice(-7).reduce((a, r) => a + (r.revenue || 0), 0);
    const prev = d.slice(-14, -7).reduce((a, r) => a + (r.revenue || 0), 0);
    if (!prev) return null;
    const ch = ((cur - prev) / prev) * 100;
    const up = ch >= 0;
    return {
      id: 'wow', group: G_COV,
      severity: ch <= -15 ? 'watch' : Math.abs(ch) < 15 ? 'info' : 'good',
      title: `Revenue is ${up ? 'up' : 'down'} ${pct(Math.abs(ch))} week on week`,
      stat: `${up ? '▲' : '▼'} ${pct(Math.abs(ch))}`, statSub: 'last 7 complete days vs the 7 before',
      detail: `${fmtCr(cur)} in the last seven complete days against ${fmtCr(prev)} in the seven before. The partial final day is excluded from both sides.`,
      why: 'Seven-day blocks cancel out the weekday pattern, which a day-on-day read cannot. Two consecutive weeks moving the same way is a trend; one is usually a promotion, a payday or a dispatch batch.',
      evidence: [['Last 7 days', fmtCr(cur)], ['Prior 7 days', fmtCr(prev)], ['Change', `${up ? '+' : ''}${ch.toFixed(1)}%`]],
      page: 'overview',
    };
  },

  // Default status exclusions change what every number on screen means.
  ({ filters, m }) => {
    const ex = arr(filters && filters.lineStatusesExclude);
    if (!ex.length) return null;
    const uniq = [...new Set(ex.map(s => s.toLowerCase()))];
    return {
      id: 'default-exclusions', group: G_COV, severity: 'info',
      title: `Cancelled, refunded and returned lines are hidden by default`,
      stat: String(uniq.length), statSub: `statuses excluded, across ${ex.length} spellings`,
      detail: `The view excludes ${ex.join(', ')} — ${uniq.length} distinct statuses written ${ex.length} different ways upstream. That is why the Returns metric reads ${full(m.returns || 0)}: those lines are filtered out before any total is computed, not missing from the source.`,
      why: 'It keeps the headline revenue figure clean, but it is the single most common way to misread this dashboard. To size returns or cancellations you must switch these back on in the Line / Item Status filter — otherwise you are measuring an amount that has been defined to be zero.',
      evidence: uniq.slice(0, 5).map(s => [s, 'excluded']),
      page: 'rawdata',
    };
  },

  // How much of the loaded dataset the current filters are showing.
  ({ meta }) => {
    if (!meta || !meta.totalRows || !meta.filteredRows) return null;
    const s = share(meta.filteredRows, meta.totalRows);
    if (s >= 99.5) return null;
    return {
      id: 'filter-coverage', group: G_COV, severity: 'info',
      title: `You are looking at ${pct(s)} of the loaded rows`,
      stat: pct(s), statSub: 'of all rows in the dataset',
      detail: `${full(meta.filteredRows)} of ${full(meta.totalRows)} rows pass the current filters. The dataset spans ${meta.minDate} to ${meta.maxDate}.`,
      why: 'Every observation on this page is computed from the filtered set, so they describe this slice and not the whole business. Widen the date window or clear the filters to see the rest.',
      evidence: [['Rows shown', full(meta.filteredRows)], ['Rows loaded', full(meta.totalRows)], ['From', meta.minDate], ['To', meta.maxDate]],
    };
  },

  // The material sheet's contribution, stated as a win rather than a gap.
  ({ m, by }) => {
    const raw = arr(by.orderType), mapped = arr(by.materialType);
    if (!raw.length || !mapped.length || !m.rev) return null;
    const blank = (rows) => share(rows.filter(r => isBlank(r.name)).reduce((a, r) => a + (r.revenue || 0), 0), m.rev);
    const before = blank(raw), after = blank(mapped);
    if (before - after < 5) return null;
    return {
      id: 'material-mapping-win', group: G_DQ, severity: 'good',
      title: `The material sheet recovers ${pct(before - after)} of revenue that had no product type`,
      stat: `${pct(before)} → ${pct(after)}`, statSub: 'unclassified revenue, before and after mapping',
      detail: `The raw order-type field is blank on ${pct(before)} of revenue. After the mapping sheet and bundle inheritance are applied, only ${pct(after)} is left unclassified.`,
      why: 'Product-mix analysis would be impossible on the raw field alone. This is worth protecting: the sheet is refreshed daily and a break in it would quietly take the material type table back to a third of revenue unclassified.',
      evidence: [['Raw field blank', pct(before)], ['After mapping', pct(after)], ['Recovered', pct(before - after)]],
      page: 'components',
    };
  },
];

/* ── Runner ──────────────────────────────────────────────────────────────── */
export function buildObservations(bundle, filters) {
  const b = bundle || {};
  const ctx = {
    m: b.metrics || {},
    by: b.by || {},
    date: b.date || {},
    sku: b.sku || [],
    p: b.pendency || null,
    meta: b.meta || {},
    filters: filters || {},
  };
  if (!ctx.m.orders) return [];

  const out = [];
  for (const rule of RULES) {
    try {
      const o = rule(ctx);
      if (o) out.push(o);
    } catch {
      // A rule that cannot evaluate is silently skipped — one bad field must
      // never take the whole page down.
    }
  }
  return out.sort((a, b2) =>
    (SEVERITY[a.severity]?.rank ?? 9) - (SEVERITY[b2.severity]?.rank ?? 9) ||
    GROUPS.indexOf(a.group) - GROUPS.indexOf(b2.group));
}

export const countBySeverity = (obs) =>
  obs.reduce((acc, o) => { acc[o.severity] = (acc[o.severity] || 0) + 1; return acc; }, {});
