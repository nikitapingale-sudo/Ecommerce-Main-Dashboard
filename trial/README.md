# 📦 PW Orders Intelligence Hub

> Real-time orders analytics dashboard for PhysicsWallah — built with React + Vite, deployed on Vercel.

---

## 🗂️ Project Structure

```
pw-dashboard/
├── src/
│   ├── data.js                  # Auto-generated data (DO NOT edit manually)
│   ├── App.jsx                  # Root app, routing, filter state
│   ├── index.css                # Global CSS variables & reset
│   ├── main.jsx                 # React entry point
│   ├── components/
│   │   ├── Sidebar.jsx          # Left navigation
│   │   ├── FilterPanel.jsx      # Filter checkboxes panel
│   │   └── UI.jsx               # KPI, Card, DataTable, FunnelBar, Tabs
│   ├── pages/
│   │   ├── OverviewPage.jsx     # KPIs, trends, funnels, split charts
│   │   ├── RevenuePage.jsx      # Revenue analysis, DoD, MoM, channel
│   │   ├── FulfilmentPage.jsx   # Delivery rate, RTO, status funnels
│   │   ├── ChannelsPage.jsx     # Channel/payment/finance cat breakdown
│   │   ├── ProductsPage.jsx     # Drill-through category → product
│   │   ├── SKUPage.jsx          # SKU & variant level performance
│   │   ├── GeographicPage.jsx   # State/city revenue & orders
│   │   ├── PendencyPage.jsx     # Aging analysis for open orders
│   │   ├── OperationsPage.jsx   # Warehouse, courier, OMS breakdown
│   │   └── RawDataPage.jsx      # Full row-level table with export
│   └── utils/
│       └── dataEngine.js        # All data logic: filter, group, metrics, format
├── scripts/
│   ├── dbm.js                   # Database Manager — refresh src/data.js from DB
│   └── mirror.js                # Mirror/backup all source code
├── backups/                     # Created by mirror.js (gitignored)
├── .env.development             # Dev environment variables (gitignored)
├── .env.production              # Prod environment variables (gitignored)
├── .env.example                 # Template — safe to commit
├── .gitignore
├── index.html
├── package.json
├── vite.config.js
├── vercel.json
└── README.md
```

---

## ⚡ Quick Start

```bash
# 1. Clone / unzip project
cd pw-dashboard

# 2. Set up environment
cp .env.example .env.development
# Edit .env.development with your values

# 3. Install dependencies
npm install

# 4. Run locally
npm run dev
# Opens at http://localhost:5173
```

---

## 🗃️ DBM — Database Manager

The `scripts/dbm.js` script connects to your PostgreSQL DB and regenerates `src/data.js` with fresh data.

```bash
# Full refresh (all dates)
npm run dbm

# Last 7 days only
npm run dbm:7d

# Last 30 days
npm run dbm:30d

# Dry run — query only, no file write
npm run dbm:dry

# Production DB
npm run dbm:prod

# Development DB
npm run dbm:dev
```

**Prerequisites:**
```bash
npm install pg           # PostgreSQL client
npm install dotenv       # Already in devDependencies
```

**What it does:**
1. Reads DB credentials from `.env.development` or `.env.production`
2. Runs the `gold_dbt_store_orders` query
3. Applies `order_status_group` and `item_status_group` transformations
4. Backs up existing `src/data.js` → `src/data.backup.js`
5. Writes new `src/data.js`
6. Ready for `npm run build` or hot-reload in dev

---

## 🪞 Mirror — Code Backup

The `scripts/mirror.js` script creates timestamped backups of all source code.

```bash
# Create a backup
npm run mirror

# List all backups
npm run mirror:list

# Remove backups older than 30 days
npm run mirror:clean
```

**Direct usage:**
```bash
node scripts/mirror.js --dest=/mnt/nas/backups   # custom destination
node scripts/mirror.js --tag=v1.2.0              # named release backup
node scripts/mirror.js --clean --verbose         # clean with details
```

Each backup includes a `MIRROR_MANIFEST.json` with metadata:
- Timestamp, git hash, git branch
- File count and total size
- Included/excluded paths

---

## 🚀 Deploy to Vercel

### Method 1 — Vercel CLI

```bash
npm install -g vercel
vercel login

# Preview deploy
npm run deploy:preview

# Production deploy
npm run deploy
```

### Method 2 — GitHub + Vercel (recommended)

```bash
git init
git add .
git commit -m "Initial PW dashboard"
git branch -M main
git remote add origin https://github.com/your-org/pw-orders-dashboard.git
git push -u origin main
```

Then in Vercel dashboard:
- Import repo → Framework: **Vite** → Build: `npm run build` → Output: `dist`
- Add environment variables from `.env.production`

### Environment Variables in Vercel

Set these in **Vercel Dashboard → Project → Settings → Environment Variables**:

| Variable | Value |
|----------|-------|
| `VITE_APP_ENV` | `production` |
| `VITE_DATA_SOURCE` | `static` |
| `VITE_FEATURE_DEBUG_PANEL` | `false` |

---

## 🔄 Data Refresh Workflow

```
Production DB (PostgreSQL / Snowflake)
        ↓
  npm run dbm:prod          ← runs scripts/dbm.js
        ↓
  src/data.js updated
        ↓
  git commit & push
        ↓
  Vercel auto-deploys
        ↓
  Dashboard live with fresh data ✅
```

**Automate with cron** (run on your server or CI):

```bash
# /etc/cron.d/pw-dashboard
# Run DBM + deploy every day at 2 AM
0 2 * * * cd /var/apps/pw-dashboard && npm run dbm:prod && git add src/data.js && git commit -m "auto: data refresh $(date +%Y-%m-%d)" && git push
```

---

## 📊 Dashboard Pages

| Page | URL Slug | Description |
|------|----------|-------------|
| Overview | `overview` | KPIs, trends, funnel, status split |
| Revenue | `revenue` | Revenue analysis, DoD/MoM/WoW, discount |
| Fulfilment | `fulfilment` | Delivery rate, RTO, cancel, courier |
| Channels | `channels` | Channel/payment/finance category |
| Products | `products` | Drill-through category → product |
| SKU | `sku` | SKU & variant level with discount % |
| Geographic | `geographic` | State/city performance |
| Pendency | `pendency` | Aging buckets for open orders |
| Operations | `operations` | Warehouse, OMS, order type |
| Raw Data | `rawdata` | Full table, search, Excel export |

---

## 🔧 Key Metrics

| Metric | Definition |
|--------|-----------|
| **Orders** | `COUNT DISTINCT vco_external_order_number` |
| **Order Lines** | `COUNT DISTINCT unique_id` |
| **Revenue** | `SUM(final_revenue)` |
| **ASP** | `SUM(final_revenue) / SUM(qty)` |
| **AOV** | `SUM(final_revenue) / COUNT DISTINCT orders` |
| **Delivery Rate** | Delivered orders / Total orders × 100 |
| **RTO Rate** | RTO/Lost orders / Total orders × 100 |
| **Cancel Rate** | Cancelled orders / Total orders × 100 |
| **Discount** | `SUM(MRP × qty) - SUM(final_revenue)` |

---

## 🛠️ Tech Stack

| Layer | Technology |
|-------|-----------|
| UI Framework | React 18 |
| Build Tool | Vite 5 |
| Charts | Recharts 2 |
| Excel Export | SheetJS (xlsx) |
| Icons | Lucide React |
| Date Utils | date-fns |
| DB Client | pg (PostgreSQL) |
| Deployment | Vercel |
| Styling | CSS Variables (no Tailwind, no MUI) |
