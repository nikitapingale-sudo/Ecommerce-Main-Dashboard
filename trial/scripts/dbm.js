#!/usr/bin/env node
// ============================================================
//  PW Orders Intelligence Hub — DBM (Database Manager)
//  File: scripts/dbm.js
//
//  PURPOSE:
//    Connects to your production DB, runs the gold_dbt_store_orders
//    query, applies status groupings, and writes src/data.js
//    so the dashboard always has fresh data on next build/deploy.
//
//  USAGE:
//    node scripts/dbm.js              # full refresh
//    node scripts/dbm.js --days 7     # last 7 days only
//    node scripts/dbm.js --dry-run    # query only, no write
//    node scripts/dbm.js --env prod   # use .env.production
//
//  SCHEDULE (cron example — run daily at 2 AM):
//    0 2 * * * cd /app && node scripts/dbm.js >> logs/dbm.log 2>&1
// ============================================================

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ── Load env ────────────────────────────────────────────────
const args = process.argv.slice(2);
const envFlag = args.find(a => a.startsWith('--env='))?.split('=')[1] || 'development';
const daysFlag = parseInt(args.find(a => a.startsWith('--days='))?.split('=')[1] || '0');
const dryRun   = args.includes('--dry-run');
const verbose  = args.includes('--verbose');

config({ path: path.resolve(ROOT, `.env.${envFlag}`) });

const {
  DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD,
  DB_SCHEMA = 'mview', DB_TABLE = 'gold_dbt_store_orders', DB_SSL,
} = process.env;

// ── Status Grouping Functions ────────────────────────────────
function orderStatusGroup(s = '') {
  if (['closed','Cancelled'].includes(s)) return 'Cancelled';
  if (['delivered','Replacement_Requested','Return_Requested'].includes(s)) return 'Delivered';
  if (['Partially Shipped','Shipped complete','Shipped'].includes(s)) return 'Shipped';
  if (['Packed','Manifested'].includes(s)) return 'Packed';
  if (['Pending','Pick complete','Allocated','Part Picked','Part Allocated',
       'confirmed','RECEIVED','Cancellation_Requested','Closed_By_System',
       'Created','Failed'].includes(s)) return 'Received';
  if (['Refund_Failed','Refund_Initiated','Refunded','Redispatch','Replaced',
       'Replacement_Initiated','Return_Failed','Return_Initiated','Returned'].includes(s)) return 'Return/Refund';
  if (['Shipped & Returned','Lost','Rto'].includes(s)) return 'RTO/Lost';
  return 'Others';
}

function itemStatusGroup(s = '') {
  if (['Cancellation_Requested','Cancelled','Closed'].includes(s)) return 'Cancelled';
  if (s === 'Delivered') return 'Delivered';
  if (['Packed','Partially Shipped','Manifested'].includes(s)) return 'Packed';
  if (['Allocated','Part Picked','Pick Complete','Closed_By_System',
       'Created','Failed','Received'].includes(s)) return 'Allocated';
  if (['Part Allocated','Confirmed'].includes(s)) return 'Confirmed';
  if (s === 'Pending') return 'Pending';
  if (['Refund_Failed','Refund_Initiated','Refunded','Redispatch','Replaced',
       'Replacement_Initiated','Replacement_Requested','Return_Failed',
       'Return_Initiated','Return_Requested','Returned'].includes(s)) return 'Return/Refund';
  if (['Lost','Rto','Shipped & Returned'].includes(s)) return 'RTO/Lost';
  if (['Shipped','Shipped Complete'].includes(s)) return 'Shipped';
  return 'Others';
}

// ── SQL Query ────────────────────────────────────────────────
function buildQuery(days = 0) {
  const dateFilter = days > 0
    ? `WHERE order_date >= CURRENT_DATE - INTERVAL '${days} days'`
    : '';
  return `
    SELECT
      order_date::text,
      unique_id,
      vco_external_order_number,
      final_order_status,
      final_item_status,
      vco_customer_name,
      vco_channel_name,
      vco_brand,
      parent_name,
      sub_cat_name,
      sub_sub_cat_name,
      product_name,
      product_variant_id,
      product_variant_name,
      vco_sku_code,
      order_category,
      finance_exam_category,
      payment_sources,
      purchase_level,
      order_type,
      oms,
      organization,
      marketplace_cat,
      COALESCE(qty, 0)            AS qty,
      COALESCE(final_revenue, 0)  AS final_revenue,
      COALESCE(mrp, 0)            AS mrp,
      COALESCE(vco_unit_price, 0) AS vco_unit_price,
      COALESCE(vco_mrp, 0)        AS vco_mrp,
      COALESCE(delivery_charge,0) AS delivery_charge,
      COALESCE(total_amount, 0)   AS total_amount,
      COALESCE(vco_shipping_charges,0) AS vco_shipping_charges,
      city,
      state,
      warehouse,
      delivery_partner
    FROM ${DB_SCHEMA}.${DB_TABLE}
    ${dateFilter}
    ORDER BY order_date DESC
  `;
}

// ── Transform Row ─────────────────────────────────────────────
function transformRow(row) {
  return {
    ...row,
    order_status_group: orderStatusGroup(row.final_order_status),
    item_status_group:  itemStatusGroup(row.final_item_status),
  };
}

// ── Write data.js ─────────────────────────────────────────────
function writeDataFile(rows) {
  const outPath = path.resolve(ROOT, 'src/data.js');
  const backupPath = path.resolve(ROOT, 'src/data.backup.js');

  // Backup existing
  if (fs.existsSync(outPath)) {
    fs.copyFileSync(outPath, backupPath);
    log(`📦 Backed up existing data.js → data.backup.js`);
  }

  const content = [
    `// Auto-generated by DBM — ${new Date().toISOString()}`,
    `// Rows: ${rows.length} | Source: ${DB_SCHEMA}.${DB_TABLE}`,
    `// DO NOT EDIT MANUALLY`,
    `export const DATA = ${JSON.stringify(rows)};`,
    `export const META = ${JSON.stringify({
      generatedAt: new Date().toISOString(),
      rowCount: rows.length,
      source: `${DB_SCHEMA}.${DB_TABLE}`,
      env: envFlag,
      daysFilter: daysFlag || 'all',
    })};`,
  ].join('\n');

  fs.writeFileSync(outPath, content, 'utf8');
  const kb = (fs.statSync(outPath).size / 1024).toFixed(1);
  log(`✅ Written src/data.js (${kb} KB, ${rows.length} rows)`);
}

// ── Logger ───────────────────────────────────────────────────
function log(msg) { console.log(`[DBM ${new Date().toISOString()}] ${msg}`); }

// ── Main ─────────────────────────────────────────────────────
async function main() {
  log(`🚀 DBM starting — env=${envFlag}, days=${daysFlag||'all'}, dryRun=${dryRun}`);

  if (!DB_HOST || !DB_NAME || !DB_USER) {
    log('❌ Missing DB config. Check your .env file has DB_HOST, DB_NAME, DB_USER, DB_PASSWORD.');
    process.exit(1);
  }

  // Dynamic import of pg (install: npm install pg)
  let pg;
  try {
    pg = await import('pg');
  } catch {
    log('❌ pg not installed. Run: npm install pg');
    process.exit(1);
  }

  const { Pool } = pg.default || pg;
  const pool = new Pool({
    host:     DB_HOST,
    port:     parseInt(DB_PORT || '5432'),
    database: DB_NAME,
    user:     DB_USER,
    password: DB_PASSWORD,
    ssl:      DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    max:      5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });

  const sql = buildQuery(daysFlag);
  if (verbose) { log('📝 Query:\n' + sql); }

  try {
    log('🔌 Connecting to database...');
    const client = await pool.connect();
    log(`✅ Connected to ${DB_HOST}:${DB_PORT||5432}/${DB_NAME}`);

    log('⏳ Running query...');
    const t0 = Date.now();
    const result = await client.query(sql);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(2);

    client.release();
    log(`✅ Query complete — ${result.rows.length} rows in ${elapsed}s`);

    const rows = result.rows.map(transformRow);
    log(`🔄 Transformed ${rows.length} rows (added status groups)`);

    if (dryRun) {
      log('🧪 DRY RUN — skipping file write. Sample row:');
      console.log(JSON.stringify(rows[0], null, 2));
    } else {
      writeDataFile(rows);
    }
  } catch (err) {
    log(`❌ DB Error: ${err.message}`);
    if (verbose) console.error(err);
    process.exit(1);
  } finally {
    await pool.end();
  }

  log('🏁 DBM complete.');
}

main();
