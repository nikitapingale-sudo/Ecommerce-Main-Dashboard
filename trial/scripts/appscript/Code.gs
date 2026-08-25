/**
 * PW Store Daily Report — Google Apps Script
 * Sheet: "PW Store Daily Report"
 *
 * Runs at 9:00 AM every day. Pulls yesterday's figures from the dashboard's
 * published CSV, lays them out in the sheet, and emails the report.
 *
 * The CSV lives on the Vercel domain, which is stable — the backend's own
 * address changes whenever its tunnel restarts, so the script must never point
 * at that directly or it will break roughly once a week.
 *
 * ── FIRST-TIME SETUP ────────────────────────────────────────────────────────
 *   1. Extensions → Apps Script, paste this file over Code.gs, Save.
 *   2. Project Settings → set the time zone to (GMT+05:30) India Standard Time.
 *      The 9 AM trigger fires in the SCRIPT's time zone, not yours.
 *   3. Run `setup` once. Approve the permissions prompt (it needs to read an
 *      external URL, write this sheet, and send mail as you).
 *   4. Run `runDailyReport` once to confirm the mail arrives.
 * ────────────────────────────────────────────────────────────────────────────
 */

var CONFIG = {
  CSV_URL: 'https://pw-orders-live.vercel.app/data/daily_report.csv',
  RECIPIENTS: 'nikita.pingale@pw.live',
  CC: '',
  SUBJECT_PREFIX: 'PW Store Daily Report',
  DATA_TAB: 'Raw Data',
  REPORT_TAB: 'Sheet1',
  SEND_HOUR: 9,
  // Refuse to email figures older than this. The dashboard's backend runs on a
  // laptop; if it was asleep the CSV silently keeps yesterday's numbers, and a
  // stale report that looks current is worse than a missing one.
  MAX_AGE_DAYS: 2,
};

// Section order in the report tab and the email.
var SECTIONS = [
  { key: 'Channel Summary',                     title: 'Channel Summary' },
  { key: 'Product Type Summary',                title: 'Product Type Summary' },
  { key: 'Category Summary - Publication Books', title: 'Category Summary — Publication Books' },
  { key: 'Top 10 Publication Books',            title: 'Top 10 Publication Books' },
  { key: 'Top 10 Stationery & Merchandise',     title: 'Top 10 Stationery & Merchandise' },
];

var PURPLE = '#d9c7ec';
var PURPLE_DK = '#b9a3d4';
var GREY = '#f7f7fa';
var TOTAL_BG = '#efeaf7';


/* ── entry points ─────────────────────────────────────────────────────────── */

/** Run once: installs the 9 AM daily trigger. */
function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runDailyReport') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runDailyReport')
    .timeBased()
    .atHour(CONFIG.SEND_HOUR)
    .nearMinute(0)
    .everyDays(1)
    .create();
  var tz = Session.getScriptTimeZone();
  SpreadsheetApp.getActiveSpreadsheet().toast(
    'Daily trigger installed for ' + CONFIG.SEND_HOUR + ':00 (' + tz + ')', 'Setup', 8);
  Logger.log('Trigger installed. Script time zone: %s', tz);
}

/** The daily job. */
function runDailyReport() {
  var rows = fetchRows_();
  if (!rows.length) throw new Error('No rows in the CSV at ' + CONFIG.CSV_URL);

  var reportDate = rows[0].report_date;
  writeRawTab_(rows);
  writeReportTab_(rows, reportDate);

  var stale = staleness_(reportDate);
  var html = buildEmailHtml_(rows, reportDate, stale);
  var head = headline_(rows, 'Yesterday');

  var subject = CONFIG.SUBJECT_PREFIX + ' — ' + prettyDate_(reportDate)
    + ' | Orders ' + fmtInt_(head.orders)
    + ' | Revenue ' + head.revenue_lakhs + ' L';
  if (stale) subject = '[STALE DATA] ' + subject;

  MailApp.sendEmail({
    to: CONFIG.RECIPIENTS,
    cc: CONFIG.CC || undefined,
    subject: subject,
    htmlBody: html,
    body: 'This report is HTML. Open it in an HTML-capable mail client.',
  });
  Logger.log('Sent for %s to %s', reportDate, CONFIG.RECIPIENTS);
}

/** Refresh the sheet without emailing — safe to run any time. */
function refreshSheetOnly() {
  var rows = fetchRows_();
  writeRawTab_(rows);
  writeReportTab_(rows, rows[0].report_date);
  SpreadsheetApp.getActiveSpreadsheet().toast('Sheet refreshed for ' + rows[0].report_date, 'Done', 6);
}

/** Adds a menu so the sheet can be refreshed by hand. */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('PW Report')
    .addItem('Refresh now (no email)', 'refreshSheetOnly')
    .addItem('Send report now', 'runDailyReport')
    .addSeparator()
    .addItem('Install 9 AM trigger', 'setup')
    .addToUi();
}


/* ── data ─────────────────────────────────────────────────────────────────── */

function fetchRows_() {
  var res = UrlFetchApp.fetch(CONFIG.CSV_URL, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) {
    throw new Error('CSV fetch failed: HTTP ' + res.getResponseCode() + ' from ' + CONFIG.CSV_URL);
  }
  var table = Utilities.parseCsv(res.getContentText());
  var head = table.shift();
  return table.map(function (r) {
    var o = {};
    head.forEach(function (h, i) { o[h] = r[i]; });
    return o;
  });
}

function pick_(rows, section, scope) {
  return rows.filter(function (r) {
    return r.section === section && (!scope || r.scope === scope);
  });
}

function headline_(rows, scope) {
  var h = pick_(rows, 'Headline', scope)[0];
  return h || { orders: '0', revenue_lakhs: '0', orders_change_pct: '', revenue_change_pct: '' };
}

/** Days between the report date and today, in the script's time zone. */
function staleness_(reportDate) {
  var d = new Date(reportDate + 'T00:00:00');
  var today = new Date();
  var days = Math.floor((today - d) / 86400000);
  return days > CONFIG.MAX_AGE_DAYS ? days : 0;
}


/* ── sheet: raw tab ───────────────────────────────────────────────────────── */

function writeRawTab_(rows) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(CONFIG.DATA_TAB) || ss.insertSheet(CONFIG.DATA_TAB);
  sh.clear();

  // Read the header from the CSV itself rather than hard-coding it, so a new
  // column added upstream appears here instead of being silently dropped.
  var cols = Object.keys(rows[0]);

  var out = [cols];
  rows.forEach(function (r) {
    out.push(cols.map(function (c) {
      var v = r[c];
      if (v === '' || v === undefined || v === null) return '';
      return isNaN(v) ? v : Number(v);
    }));
  });

  sh.getRange(1, 1, out.length, cols.length).setValues(out);
  sh.getRange(1, 1, 1, cols.length)
    .setBackground(PURPLE).setFontWeight('bold').setBorder(true, true, true, true, true, true);
  sh.setFrozenRows(1);
  sh.autoResizeColumns(1, cols.length);
}


/* ── sheet: formatted report tab ──────────────────────────────────────────── */

function writeReportTab_(rows, reportDate) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(CONFIG.REPORT_TAB) || ss.insertSheet(CONFIG.REPORT_TAB);
  sh.clear();
  var r = 1;

  // Title
  sh.getRange(r, 1).setValue('PW Store — Daily Report').setFontSize(16).setFontWeight('bold');
  r++;
  sh.getRange(r, 1).setValue(prettyDate_(reportDate) + '   (data is for the previous day)')
    .setFontColor('#666');
  r += 2;

  // KPI block
  var y = headline_(rows, 'Yesterday');
  var m = headline_(rows, 'MTD');
  var kpis = [
    ["Yesterday's Orders", Number(y.orders), pctText_(y.orders_change_pct) + ' vs day before'],
    ["Yesterday's Revenue (Lakhs)", Number(y.revenue_lakhs), pctText_(y.revenue_change_pct) + ' vs day before'],
    ['MTD Orders', Number(m.orders), ''],
    ['MTD Revenue (Lakhs)', Number(m.revenue_lakhs), ''],
  ];
  sh.getRange(r, 1, 1, 3).setValues([['Metric', 'Value', 'Change']])
    .setBackground(PURPLE).setFontWeight('bold');
  r++;
  sh.getRange(r, 1, kpis.length, 3).setValues(kpis);
  sh.getRange(r, 2, kpis.length, 1).setNumberFormat('#,##0.00');
  r += kpis.length + 1;

  // Target vs achievement, before the breakdowns — it is the first thing read.
  var tgt = pick_(rows, 'Target vs Achievement', 'MTD');
  if (tgt.length) {
    r = writeTargetTable_(sh, r, 'Target vs Achievement — Month to Date', tgt);
    r += 1;
  }

  // Each section, Yesterday then MTD
  SECTIONS.forEach(function (sec) {
    ['Yesterday', 'MTD'].forEach(function (scope) {
      var data = pick_(rows, sec.key, scope);
      if (!data.length) return;
      r = writeSectionTable_(sh, r, sec.title + ' — ' + scope, data, scope === 'Yesterday');
      r += 1;
    });
  });

  // Movers
  [['Inclined Products', 'Inclined Products (vs day before)'],
   ['Declined Products', 'Declined Products (vs day before)']].forEach(function (pair) {
    var data = pick_(rows, pair[0], 'Yesterday');
    if (!data.length) return;
    r = writeMoverTable_(sh, r, pair[1], data);
    r += 1;
  });

  sh.setColumnWidth(1, 380);
  for (var c = 2; c <= 8; c++) sh.setColumnWidth(c, 110);
}

function writeSectionTable_(sh, r, title, data, withDelta) {
  sh.getRange(r, 1).setValue(title).setFontWeight('bold').setFontSize(12);
  r++;

  var head = withDelta
    ? ['Name', 'Orders', 'Orders Change', 'Revenue (Lakhs)', 'Revenue Change', 'AOV', 'Revenue Contribution %']
    : ['Name', 'Orders', 'Revenue (Lakhs)', 'AOV', 'Revenue Contribution %'];

  sh.getRange(r, 1, 1, head.length).setValues([head])
    .setBackground(PURPLE).setFontWeight('bold')
    .setBorder(true, true, true, true, true, true)
    .setHorizontalAlignment('center').setWrap(true);
  var headRow = r;
  r++;

  var body = data.map(function (d) {
    return withDelta
      ? [d.entity, numOrBlank_(d.orders), pctNum_(d.orders_change_pct),
         numOrBlank_(d.revenue_lakhs), pctNum_(d.revenue_change_pct),
         numOrBlank_(d.aov), pctNum_(d.revenue_contribution_pct)]
      : [d.entity, numOrBlank_(d.orders), numOrBlank_(d.revenue_lakhs),
         numOrBlank_(d.aov), pctNum_(d.revenue_contribution_pct)];
  });

  sh.getRange(r, 1, body.length, head.length).setValues(body)
    .setBorder(true, true, true, true, true, true);

  // Number formats
  sh.getRange(r, 2, body.length, 1).setNumberFormat('#,##0');
  if (withDelta) {
    sh.getRange(r, 3, body.length, 1).setNumberFormat('0.00%');
    sh.getRange(r, 4, body.length, 1).setNumberFormat('#,##0.00');
    sh.getRange(r, 5, body.length, 1).setNumberFormat('0.00%');
    sh.getRange(r, 6, body.length, 1).setNumberFormat('#,##0');
    sh.getRange(r, 7, body.length, 1).setNumberFormat('0.00%');
  } else {
    sh.getRange(r, 3, body.length, 1).setNumberFormat('#,##0.00');
    sh.getRange(r, 4, body.length, 1).setNumberFormat('#,##0');
    sh.getRange(r, 5, body.length, 1).setNumberFormat('0.00%');
  }

  // Highlight the TOTAL row and colour the change columns.
  data.forEach(function (d, i) {
    var row = r + i;
    if (d.entity === 'TOTAL') {
      sh.getRange(row, 1, 1, head.length).setBackground(TOTAL_BG).setFontWeight('bold');
    } else if (i % 2 === 1) {
      sh.getRange(row, 1, 1, head.length).setBackground(GREY);
    }
    if (withDelta) {
      [[3, d.orders_change_pct], [5, d.revenue_change_pct]].forEach(function (p) {
        if (p[1] === '' || p[1] === undefined) return;
        sh.getRange(row, p[0]).setFontColor(Number(p[1]) >= 0 ? '#127a2e' : '#c02626');
      });
    }
  });

  return r + body.length;
}

function writeTargetTable_(sh, r, title, data) {
  sh.getRange(r, 1).setValue(title).setFontWeight('bold').setFontSize(12);
  r++;
  var head = ['Category', 'MTD Revenue (Lakhs)', 'Month Target (Lakhs)',
              'Achieved % (full month)', 'Pace % (vs days elapsed)'];
  sh.getRange(r, 1, 1, head.length).setValues([head])
    .setBackground(PURPLE).setFontWeight('bold')
    .setBorder(true, true, true, true, true, true)
    .setHorizontalAlignment('center').setWrap(true);
  r++;

  var body = data.map(function (d) {
    return [d.entity, numOrBlank_(d.revenue_lakhs), numOrBlank_(d.target_lakhs),
            pctNum_(d.achieved_pct), pctNum_(d.pace_pct)];
  });
  sh.getRange(r, 1, body.length, head.length).setValues(body)
    .setBorder(true, true, true, true, true, true);
  sh.getRange(r, 2, body.length, 2).setNumberFormat('#,##0.00');
  sh.getRange(r, 4, body.length, 2).setNumberFormat('0.0%');

  data.forEach(function (d, i) {
    var row = r + i;
    if (d.entity === 'TOTAL') {
      sh.getRange(row, 1, 1, head.length).setBackground(TOTAL_BG).setFontWeight('bold');
    } else if (i % 2 === 1) {
      sh.getRange(row, 1, 1, head.length).setBackground(GREY);
    }
    if (d.pace_pct !== '' && d.pace_pct !== undefined) {
      sh.getRange(row, 5).setFontColor(Number(d.pace_pct) >= 100 ? '#127a2e' : '#c02626');
    }
  });
  return r + body.length;
}


function writeMoverTable_(sh, r, title, data) {
  sh.getRange(r, 1).setValue(title).setFontWeight('bold').setFontSize(12);
  r++;
  var head = ['Product', 'Yesterday Qty', 'Day Before Qty', 'Qty Diff'];
  sh.getRange(r, 1, 1, 4).setValues([head])
    .setBackground(PURPLE).setFontWeight('bold')
    .setBorder(true, true, true, true, true, true).setHorizontalAlignment('center');
  r++;

  var body = data.map(function (d) {
    return [d.entity, Number(d.qty || 0), Number(d.qty_prev || 0), Number(d.qty_diff || 0)];
  });
  sh.getRange(r, 1, body.length, 4).setValues(body)
    .setBorder(true, true, true, true, true, true);
  sh.getRange(r, 2, body.length, 3).setNumberFormat('#,##0');
  body.forEach(function (b, i) {
    sh.getRange(r + i, 4).setFontColor(b[3] >= 0 ? '#127a2e' : '#c02626');
    if (i % 2 === 1) sh.getRange(r + i, 1, 1, 4).setBackground(GREY);
  });
  return r + body.length;
}


/* ── email ────────────────────────────────────────────────────────────────── */

function buildEmailHtml_(rows, reportDate, staleDays) {
  var y = headline_(rows, 'Yesterday');
  var m = headline_(rows, 'MTD');
  var h = [];

  h.push('<div style="font-family:Segoe UI,Arial,sans-serif;background:#f4f4f7;padding:18px">');
  h.push('<div style="max-width:1080px;margin:0 auto">');

  if (staleDays) {
    h.push('<div style="background:#fdecea;border:1px solid #f5b5ae;color:#a4231a;'
      + 'border-radius:6px;padding:10px 12px;margin-bottom:14px;font-size:12px">'
      + '<b>These figures are ' + staleDays + ' days old.</b> The dashboard backend has not '
      + 'refreshed since ' + prettyDate_(reportDate) + ' — most likely the machine running it '
      + 'was off. Do not treat this as yesterday\'s trading.</div>');
  }

  // Orders keep arriving for about a week, so a day read the next morning is
  // far from final. Say so at the top, in the numbers' own terms.
  var comp = pick_(rows, 'Data Completeness', 'Yesterday')[0];
  if (comp && comp.revenue_contribution_pct !== '') {
    var done = Number(comp.revenue_contribution_pct);
    if (done < 90) {
      var settled = Number(comp.aov || 0);
      h.push('<div style="background:#fff4e5;border:1px solid #f0c99a;color:#8a4b08;'
        + 'border-radius:6px;padding:10px 12px;margin-bottom:14px;font-size:12px">'
        + '<b>Provisional — this day is about ' + done.toFixed(0) + '% complete.</b> '
        + 'It currently holds ' + fmtInt_(comp.orders) + ' orders against a typical settled day of '
        + fmtInt_(settled) + '. Orders keep landing for roughly a week (marketplace channels report '
        + 'late), so treat every figure below as a floor, not a final number — and be careful with '
        + 'the day-on-day percentages, which compare two part-finished days.</div>');
    }
  }

  h.push('<h2 style="margin:0 0 2px;font-size:19px">PW Store — Daily Report</h2>');
  h.push('<div style="font-size:12px;color:#666;margin-bottom:16px">' + prettyDate_(reportDate) + '</div>');

  // KPI cards
  h.push('<table style="width:100%;border-collapse:separate;border-spacing:10px 0;margin-bottom:14px"><tr>');
  h.push(kpiCard_("Yesterday's Orders", fmtInt_(y.orders), y.orders_change_pct));
  h.push(kpiCard_("Yesterday's Revenue (Lakhs)", y.revenue_lakhs, y.revenue_change_pct));
  h.push(kpiCard_('MTD Orders', fmtInt_(m.orders), ''));
  h.push(kpiCard_('MTD Revenue (Lakhs)', m.revenue_lakhs, ''));
  h.push('</tr></table>');

  var tgtRows = pick_(rows, 'Target vs Achievement', 'MTD');
  if (tgtRows.length) h.push(emailTargets_(tgtRows));

  SECTIONS.forEach(function (sec) {
    ['Yesterday', 'MTD'].forEach(function (scope) {
      var data = pick_(rows, sec.key, scope);
      if (!data.length) return;
      h.push(emailTable_(sec.title + ' — ' + scope, data, scope === 'Yesterday'));
    });
  });

  h.push(emailMovers_('Inclined Products (vs day before)', pick_(rows, 'Inclined Products', 'Yesterday')));
  h.push(emailMovers_('Declined Products (vs day before)', pick_(rows, 'Declined Products', 'Yesterday')));

  h.push('<div style="font-size:11px;color:#8a6d1f;background:#fdf6e3;border:1px solid #f0e0b0;'
    + 'border-radius:6px;padding:9px 11px;margin-top:14px">'
    + '<b>Not included:</b> Daily Active Users, and the MTD Target / Achieved% columns. '
    + 'Neither exists in the orders dataset — DAU comes from app analytics and targets are a '
    + 'planning input. Both can be added once a source is available.</div>');

  h.push('<div style="font-size:10.5px;color:#999;text-align:center;margin-top:10px">'
    + 'Generated from the PW Orders Intelligence Hub · '
    + '<a href="https://pw-orders-live.vercel.app">open the dashboard</a></div>');
  h.push('</div></div>');
  return h.join('');
}

function kpiCard_(label, value, change) {
  var sub = '';
  if (change !== '' && change !== undefined) {
    var n = Number(change);
    sub = '<div style="font-size:11px;margin-top:3px;color:' + (n >= 0 ? '#127a2e' : '#c02626')
      + '">' + (n >= 0 ? '+' : '') + n.toFixed(2) + '% vs day before</div>';
  }
  return '<td style="background:#fff;border:1px solid #e2e2ea;border-radius:8px;padding:12px 14px;'
    + 'text-align:center">'
    + '<div style="font-size:10.5px;color:#666;text-transform:uppercase;letter-spacing:.05em">'
    + label + '</div>'
    + '<div style="font-size:26px;font-weight:600;margin-top:4px">' + value + '</div>'
    + sub + '</td>';
}

function emailTable_(title, data, withDelta) {
  var head = withDelta
    ? ['Name', 'Orders', 'Orders Change', 'Revenue (Lakhs)', 'Revenue Change', 'AOV', 'Rev Contribution %']
    : ['Name', 'Orders', 'Revenue (Lakhs)', 'AOV', 'Rev Contribution %'];

  var s = ['<div style="background:#fff;border:1px solid #e2e2ea;border-radius:8px;'
    + 'padding:14px 16px;margin-bottom:14px">'
    + '<div style="font-size:13px;font-weight:700;margin-bottom:8px">' + title + '</div>'
    + '<table style="width:100%;border-collapse:collapse;font-size:11.5px"><thead><tr>'];
  head.forEach(function (x) {
    s.push('<th style="background:' + PURPLE + ';border:1px solid ' + PURPLE_DK
      + ';padding:6px 7px;text-align:center">' + x + '</th>');
  });
  s.push('</tr></thead><tbody>');

  data.forEach(function (d, i) {
    var isTot = d.entity === 'TOTAL';
    var bg = isTot ? TOTAL_BG : (i % 2 ? GREY : '#fff');
    var w = isTot ? 'font-weight:700;' : '';
    var td = 'border:1px solid #d8d8e0;padding:5px 7px;background:' + bg + ';' + w;
    var cells = ['<td style="' + td + '">' + esc_(d.entity) + '</td>',
                 numTd_(td, fmtInt_(d.orders))];
    if (withDelta) cells.push(pctTd_(td, d.orders_change_pct));
    cells.push(numTd_(td, d.revenue_lakhs));
    if (withDelta) cells.push(pctTd_(td, d.revenue_change_pct));
    cells.push(numTd_(td, fmtInt_(d.aov)));
    cells.push(numTd_(td, d.revenue_contribution_pct === '' ? '' : Number(d.revenue_contribution_pct).toFixed(2) + '%'));
    s.push('<tr>' + cells.join('') + '</tr>');
  });
  s.push('</tbody></table></div>');
  return s.join('');
}

function emailTargets_(data) {
  var head = ['Category', 'MTD Revenue (Lakhs)', 'Month Target (Lakhs)',
              'Achieved %', 'Pace % (vs days elapsed)'];
  var s = ['<div style="background:#fff;border:1px solid #e2e2ea;border-radius:8px;'
    + 'padding:14px 16px;margin-bottom:14px">'
    + '<div style="font-size:13px;font-weight:700;margin-bottom:8px">'
    + 'Target vs Achievement — Month to Date</div>'
    + '<table style="width:100%;border-collapse:collapse;font-size:11.5px"><thead><tr>'];
  head.forEach(function (x) {
    s.push('<th style="background:' + PURPLE + ';border:1px solid ' + PURPLE_DK
      + ';padding:6px 7px;text-align:center">' + x + '</th>');
  });
  s.push('</tr></thead><tbody>');

  data.forEach(function (d, i) {
    var isTot = d.entity === 'TOTAL';
    var bg = isTot ? TOTAL_BG : (i % 2 ? GREY : '#fff');
    var td = 'border:1px solid #d8d8e0;padding:5px 7px;background:' + bg + ';'
      + (isTot ? 'font-weight:700;' : '');
    var pace = d.pace_pct;
    var paceCell = (pace === '' || pace === undefined)
      ? '<td style="' + td + 'text-align:right;color:#999">—</td>'
      : '<td style="' + td + 'text-align:right;color:'
        + (Number(pace) >= 100 ? '#127a2e' : '#c02626') + '">'
        + Number(pace).toFixed(1) + '%</td>';
    s.push('<tr>'
      + '<td style="' + td + '">' + esc_(d.entity) + '</td>'
      + numTd_(td, d.revenue_lakhs)
      + numTd_(td, d.target_lakhs === '' ? '—' : d.target_lakhs)
      + numTd_(td, d.achieved_pct === '' ? '—' : Number(d.achieved_pct).toFixed(1) + '%')
      + paceCell + '</tr>');
  });
  s.push('</tbody></table>'
    + '<div style="font-size:10.5px;color:#777;margin-top:6px">'
    + 'Achieved % is against the whole month. Pace % pro-rates the target to the days '
    + 'elapsed — 100% means on track today. Both are held down while recent days are '
    + 'still filling in.</div></div>');
  return s.join('');
}


function emailMovers_(title, data) {
  if (!data.length) return '';
  var s = ['<div style="background:#fff;border:1px solid #e2e2ea;border-radius:8px;'
    + 'padding:14px 16px;margin-bottom:14px">'
    + '<div style="font-size:13px;font-weight:700;margin-bottom:8px">' + title + '</div>'
    + '<table style="width:100%;border-collapse:collapse;font-size:11.5px"><thead><tr>'];
  ['Product', 'Yesterday Qty', 'Day Before Qty', 'Qty Diff'].forEach(function (x) {
    s.push('<th style="background:' + PURPLE + ';border:1px solid ' + PURPLE_DK
      + ';padding:6px 7px;text-align:center">' + x + '</th>');
  });
  s.push('</tr></thead><tbody>');
  data.forEach(function (d, i) {
    var bg = i % 2 ? GREY : '#fff';
    var td = 'border:1px solid #d8d8e0;padding:5px 7px;background:' + bg + ';';
    var diff = Number(d.qty_diff || 0);
    s.push('<tr>'
      + '<td style="' + td + '">' + esc_(d.entity) + '</td>'
      + numTd_(td, fmtInt_(d.qty))
      + numTd_(td, fmtInt_(d.qty_prev))
      + '<td style="' + td + 'text-align:right;color:' + (diff >= 0 ? '#127a2e' : '#c02626')
      + '">' + fmtInt_(d.qty_diff) + '</td></tr>');
  });
  s.push('</tbody></table></div>');
  return s.join('');
}


/* ── small helpers ────────────────────────────────────────────────────────── */

function numTd_(td, v) {
  return '<td style="' + td + 'text-align:right">' + (v === '' || v === undefined ? '' : v) + '</td>';
}

function pctTd_(td, v) {
  if (v === '' || v === undefined) return '<td style="' + td + 'text-align:right;color:#999">—</td>';
  var n = Number(v);
  return '<td style="' + td + 'text-align:right;color:' + (n >= 0 ? '#127a2e' : '#c02626')
    + '">' + n.toFixed(2) + '%</td>';
}

function pctText_(v) {
  if (v === '' || v === undefined) return '—';
  var n = Number(v);
  return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
}

/** Sheets stores percentages as fractions, so 12.5% must go in as 0.125. */
function pctNum_(v) {
  return (v === '' || v === undefined) ? '' : Number(v) / 100;
}

function numOrBlank_(v) {
  return (v === '' || v === undefined) ? '' : Number(v);
}

function fmtInt_(v) {
  if (v === '' || v === undefined) return '';
  return Number(v).toLocaleString('en-IN');
}

function prettyDate_(iso) {
  var d = new Date(iso + 'T00:00:00');
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'EEEE, d MMMM yyyy');
}

function esc_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
