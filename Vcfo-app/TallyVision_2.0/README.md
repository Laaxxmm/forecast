# TallyVision

**MIS Dashboard & Analytics Platform for Tally Prime**

TallyVision combines real-time Tally financial data with supplementary Excel uploads (pharma billing, closing stock, revenue reports) to deliver a comprehensive MIS dashboard, interactive analytics, and automated CFO-grade reports — all running locally on your machine.

---

## How It Works

```
 +------------------+          +---------------------+
 |   Tally Prime    |          |   Excel Uploads     |
 |   (XML/HTTP)     |          |  (Drag & Drop UI)   |
 +--------+---------+          +---------+-----------+
          |                              |
    XML over port 9000          File Manager (categories)
          |                              |
          v                              v
 +------------------------------------------------+
 |              TallyVision Server                 |
 |                                                 |
 |  +------------------+  +---------------------+  |
 |  | Tally Sync Engine|  | Excel Parser Engine |  |
 |  | (12 monthly      |  | (Revenue, Stock,    |  |
 |  |  TB chunks)      |  |  Billing, Direct    |  |
 |  +--------+---------+  |  Income)            |  |
 |           |             +---------+-----------+  |
 |           v                       v              |
 |  +------------------------------------------+   |
 |  |     Per-Client SQLite Databases           |   |
 |  |  master.db  +  clients/group_*.db         |   |
 |  +------------------------------------------+   |
 |           |                                      |
 |  +------------------------------------------+   |
 |  |     Dynamic TB Engine + Analytics         |   |
 |  |  (In-memory P&L, KPIs, Drill-downs)      |   |
 |  +------------------------------------------+   |
 |           |                                      |
 |  +------------------------------------------+   |
 |  |     Report Generator                      |   |
 |  |  (Word DOCX / Excel / PDF)               |   |
 |  +------------------------------------------+   |
 +------------------------+------------------------+
                          |
                          v
            +----------------------------+
            |   Web Dashboard (SPA)      |
            |   http://localhost:3456     |
            +----------------------------+
```

---

## Dashboard Layout

```
+------------------------------------------------------------------------+
|  SIDEBAR:  TallyVision  |  Overview  Table  VCFO                       |
+------------------------------------------------------------------------+
|  HEADER:  Tally Status  |  Group  Type  State  City  Location  |  Date |
+------------------------------------------------------------------------+
|                                                                        |
|  +----------+  +----------+  +----------+  +----------+  +----------+ |
|  | TOTAL    |  | GROSS    |  | NET      |  | CASH &   |  | CLOSING  | |
|  | REVENUE  |  | PROFIT   |  | PROFIT   |  | BANK     |  | STOCK    | |
|  | 19.25 Cr |  | 5.22 Cr  |  | 90.16 L  |  | 2.27 Cr  |  | 1.04 Cr | |
|  +----+-----+  +----------+  +----------+  +----------+  +----+-----+ |
|       |                                                        |       |
|  +----+-----+  +----------+  +----------+  +----------+       |       |
|  | SALES    |  | DIRECT   |  | INDIRECT |  | PURCHASE |       |       |
|  | 8.24 Cr  |  | INCOME   |  | INCOME   |  | 7.53 Cr  |       |       |
|  +----------+  | 11.01 Cr |  | 11.83 L  |  +----------+       |       |
|                +----------+  +----------+                      |       |
|  +----------+  +----------+                                    |       |
|  | DIRECT   |  | INDIRECT |    Click any KPI card              |       |
|  | EXPENSES |  | EXPENSES |    to drill down into              |       |
|  | 6.93 Cr  |  | 4.44 Cr  |    detailed analysis               |       |
|  +----------+  +----------+                                    |       |
|                                                                |       |
|  +-----------------------+  +--------------------+             |       |
|  | Top Revenue           |  | Top Direct Expenses|             |       |
|  | [===== Doughnut =====]|  | [=== Doughnut ====]|             |       |
|  +-----------------------+  +--------------------+             |       |
|                                                                |       |
|  +-----------------------------------------------------+      |       |
|  | YTD Monthly Trend (Revenue vs Expenses + GP/NP)      |      |       |
|  | [============== Bar + Line Chart =================]  |      |       |
|  +-----------------------------------------------------+      |       |
+----------------------------------------------------------------+-------+
```

---

## Features

### Core Financial Dashboard
| Feature | Description |
|---------|-------------|
| **12 KPI Cards** | Revenue, GP, NP, Cash, Sales, Purchases, Direct/Indirect Income & Expenses, Closing Stock |
| **Interactive Charts** | Doughnut charts for Revenue, Direct & Indirect Expenses with click-through |
| **YTD Trend** | Monthly bar chart with Revenue vs Expenses + GP/NP trend lines |
| **Drill-Down** | Click any KPI or chart segment for pie + table with breadcrumb group navigation |
| **Multi-Company** | Company groups + geographic filters (Type, State, City, Location) |
| **Date Range** | Flexible period selector with year-to-date and custom date ranges |

### Per-Client Database Architecture (v4.0)

```
data/
  master.db                    <-- Global: settings, companies, groups, users
  clients/
    group_2.db                 <-- All company data for group "Magnacode"
    group_7.db                 <-- All company data for group "ABC Corp"
    standalone_42.db           <-- Ungrouped company 42's data
```

| Feature | Description |
|---------|-------------|
| **Data Isolation** | Each company group gets its own SQLite database file |
| **Auto-Migration** | Seamlessly splits existing single-DB on first startup |
| **Transparent Routing** | Proxy-based query routing — existing code unchanged |
| **Group Data Migration** | Moving companies between groups auto-migrates data |
| **UNIQUE Constraints** | Prevents data duplication on re-sync |

### Virtual CFO (vCFO) Tracker
| Feature | Description |
|---------|-------------|
| **Action Items** | Track compliance, filings, and advisory tasks |
| **Status Tracking** | In Progress, Completed, Overdue states |
| **Bulk Actions** | Mass-update statuses |
| **Summary Dashboard** | KPI metrics for tracker progress |

### Audit & Compliance
| Feature | Description |
|---------|-------------|
| **Milestones** | Track audit milestones with completion status |
| **Observations** | Record and manage audit findings |
| **Seed Templates** | Pre-built milestone templates |

### Supplementary Analytics (Excel Uploads)

| Module | Data Source | Analytics Provided |
|--------|-----------|-------------------|
| **Pharma Revenue** | Monthly billing Excel files | Drug revenue/profit rankings, doctor revenue, bill analysis |
| **Closing Stock** | Stock inventory Excel files | Expiry risk, slow-moving inventory, stockist/manufacturer concentration |
| **Direct Income** | Healthplix/clinic reports | Revenue per branch, doctor-wise income |

### CFO Insights Report (Word DOCX)

One-click download of a professional CFO-grade report with 6 sections:

```
+------------------------------------------------------------------+
|                    CFO Insights Report                            |
+------------------------------------------------------------------+
|  1. EXECUTIVE SUMMARY         KPIs + narrative bullets            |
|  2. PROFITABILITY & OPS       P&L comparison, geographic, pharma  |
|  3. INVENTORY & STOCK HEALTH  Expiry risk, slow-moving, supplier  |
|  4. LIQUIDITY & WORKING CAP   Cash, AR/AP ageing                  |
|  5. STATUTORY & TAX           GST summary, compliance calendar    |
|  6. KEY ACTION ITEMS          Auto-generated priority flags       |
+------------------------------------------------------------------+
```

### Financial Reports & Statements
| Report | Formats | Description |
|--------|---------|-------------|
| **CFO Insights** | DOCX / PDF / XLSX | Full narrative report with tables and action items |
| **Trial Balance** | View + Excel | Monthly period-end balances |
| **AR Ageing** | View + Excel/PDF | Debtor bills with 0-30/31-60/61-90/90+ day buckets |
| **AP Ageing** | View + Excel/PDF | Creditor bills with ageing |
| **Stock Summary** | View | Inventory with opening/closing quantities |
| **P&L Statement** | Excel/PDF | Columnar P&L by geography |

### Data Sync Engine
- **One-click sync** from the Settings panel
- **Smart chunking** — TB extracted month-by-month (12 requests/year)
- **Bare Collection API** — No SYSTEM Formulae (crash-proof)
- **Incremental sync** — Skips historical months already synced
- **Force Resync** option for full re-extraction
- **Live progress bar** with status updates

### Client Portal
- **Separate login** at `/client/login`
- **Read-only access** — clients can view dashboards, not modify data
- **Per-company access control** — each client user sees only their assigned companies
- **Feature toggles** — control which features each client can access

---

## Requirements

- **Node.js** v18 or later
- **Tally Prime** running with XML/HTTP server enabled (port 9000)
- Both Tally and TallyVision on the same machine (or LAN-accessible)

### Tally Configuration
1. Open Tally Prime
2. Press **F12** > **Connectivity**
3. Set **Enable ODBC / XML Server** to **Yes**
4. Default port: **9000**

---

## Installation

```bash
# Clone the repository
git clone https://github.com/Laaxxmm/Merger-Tally.git
cd Merger-Tally

# Install dependencies
npm install

# Start the server (auto-creates database on first run)
npm start
```

Dashboard opens at **http://localhost:3456**

---

## Quick Start

```
Step 1                Step 2              Step 3              Step 4
+----------+         +----------+        +-----------+       +----------+
| Start    |  --->   | Open     | --->   | Click     | --->  | Explore  |
| Tally    |         | Dashboard|        | Sync in   |       | KPIs,    |
| Prime    |         | :3456    |        | Settings  |       | Charts,  |
+----------+         +----------+        +-----------+       | Reports  |
                                                              +----------+
```

1. **Start Tally Prime** with companies open
2. **Run** `npm start` — server on port 3456
3. **Open** http://localhost:3456
4. **Configure & Sync** via Settings (Tally host, port, fiscal dates, company)
5. **Upload Excel files** via File Manager for supplementary analytics
6. **Download Reports** — CFO Insights (Word), Excel, PDF from the Reports dropdown

---

## Project Structure

```
TallyVision_2.0/
+-- package.json
+-- README.md                          # This file
+-- HANDOFF.md                         # Developer handoff document
+-- TODO.md                            # Roadmap & status tracker
+-- ARCHITECTURE.md                    # Database & system architecture
+-- CHANGELOG.md                       # Version history & release notes
+-- src/
|   +-- backend/
|   |   +-- server.js                  # Express API server (~6,200 lines)
|   |   +-- docx-generator.js          # CFO Word report builder (794 lines)
|   |   +-- report-generator.js        # PDF + Excel report engine (535 lines)
|   |   +-- tally-connector.js         # TCP/XML Tally communication (178 lines)
|   |   +-- cfo-review-generator.js    # CFO review report logic
|   |   +-- db/
|   |   |   +-- setup.js              # SQLite schema — master + client (split)
|   |   |   +-- db-manager.js         # Per-client DB routing & migration
|   |   +-- extractors/
|   |       +-- data-extractor.js      # Chunked extraction engine (730 lines)
|   |       +-- xml-templates.js       # TDL XML templates for Tally (213 lines)
|   +-- frontend/
|       +-- dashboard.html             # Single-page app (~13,000 lines)
|       +-- client-login.html          # Client portal login page
+-- data/
|   +-- master.db                      # Global tables (auto-created)
|   +-- clients/
|   |   +-- group_*.db                 # Per-group company data
|   |   +-- standalone_*.db            # Ungrouped company data
|   +-- tallyvision_backup.db          # Pre-migration backup (if migrated)
|   +-- uploads/                       # Uploaded Excel files
+-- .claude/
    +-- launch.json                    # Dev server config
```

---

## Architecture

```
+-----------------+        +------------------+
|  TALLY PRIME    |        |  EXCEL FILES     |
|  (ERP System)   |        |  (User Uploads)  |
+--------+--------+        +--------+---------+
         |                          |
   XML/HTTP:9000            POST /api/upload
         |                          |
+--------v--------------------------v---------+
|            EXPRESS REST API (130+ endpoints) |
|                                              |
|  +----------------------------------------+ |
|  |     Proxy-Based DB Routing             | |
|  |  SQL query --> detect table name -->   | |
|  |  route to masterDb or clientDb         | |
|  +----------------------------------------+ |
|                                              |
|  +----------------------------------------+ |
|  |     DYNAMIC TB ENGINE                  | |
|  |  buildLedgerGroupMap() (~8ms)          | |
|  |  buildPLGroupSets()                    | |
|  |  computePLFlow() / computeBSClosing()  | |
|  +----------------------------------------+ |
|                                              |
|  +----------------------------------------+ |
|  |     REPORT GENERATORS                  | |
|  |  CFO Word (docx-generator.js)          | |
|  |  PDF / Excel (report-generator.js)     | |
|  +----------------------------------------+ |
+---------------------+-----------------------+
                      |
         +------------v-----------+
         |  Per-Client SQLite DBs |
         |                        |
         |  master.db:            |
         |    companies           |
         |    company_groups      |
         |    app_settings        |
         |    client_users        |
         |    vcfo_tracker_*      |
         |    audit_*             |
         |                        |
         |  clients/group_N.db:   |
         |    trial_balance       |
         |    vouchers            |
         |    account_groups      |
         |    bills_outstanding   |
         |    stock_summary       |
         |    budgets             |
         |    excel_data          |
         +------------------------+
```

---

## API Reference

### Dashboard KPIs & Trends
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/dashboard/kpi` | All KPIs: GP, NP, Revenue, Cash, Margins |
| GET | `/api/dashboard/monthly-trend` | Monthly Revenue vs Expenses (TB-based) |
| GET | `/api/dashboard/top-revenue` | Top 10 revenue sources |
| GET | `/api/dashboard/top-direct-expenses` | Top direct expense ledgers |
| GET | `/api/dashboard/top-indirect-expenses` | Top indirect expense ledgers |

### Drill-Down & Breakdown
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/dashboard/group-breakdown` | Hierarchical group drill-down |
| GET | `/api/dashboard/ledger-breakdown` | Drill-down by classType or groupRoot |
| GET | `/api/dashboard/item-monthly-trend` | Per-item YTD monthly trend |

### Financial Statements
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/dashboard/trial-balance` | Period trial balance |
| GET | `/api/dashboard/receivable-ageing` | Debtor ageing with day buckets |
| GET | `/api/dashboard/payable-ageing` | Creditor ageing |
| GET | `/api/dashboard/stock-summary` | Inventory valuation |
| GET | `/api/dashboard/gst-summary` | GST breakdown by rate |
| GET | `/api/dashboard/cost-centre-analysis` | Cost centre profitability |
| GET | `/api/dashboard/payroll-summary` | Payroll data aggregation |

### Excel Upload & Analytics
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/upload/excel` | Upload Excel file with company/category/period |
| GET | `/api/upload/list` | List uploaded files with metadata |
| GET | `/api/upload/grid` | Uploaded files grid view |
| DELETE | `/api/upload/:uploadId` | Delete an uploaded file |
| GET | `/api/upload/pharma-analytics` | Drug/doctor revenue & profit analytics |
| GET | `/api/upload/closing-stock-analytics` | Expiry, slow-moving, supplier analysis |

### Company Groups
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/company-groups` | List company groups with members |
| POST | `/api/company-groups` | Create group (auto-migrates data) |
| PUT | `/api/company-groups/:id` | Update group name/description |
| DELETE | `/api/company-groups/:id` | Delete group (migrates data to standalone) |
| POST | `/api/company-groups/:id/members/add` | Add company (migrates data) |
| DELETE | `/api/company-groups/members/company/:id` | Remove company (migrates data) |

### Budgeting
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET/POST | `/api/budgets` | Budget management |

### Reports
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/reports/download?format=docx` | CFO Insights Word report |
| GET | `/api/reports/download?format=xlsx` | Excel report |
| GET | `/api/reports/download?format=pdf` | PDF report |
| GET | `/api/reports/profit-loss` | P&L statement |
| GET | `/api/reports/balance-sheet` | Balance sheet |
| GET | `/api/reports/cash-flow` | Cash flow statement |

### Sync & Settings
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/sync/start` | Start Tally data extraction |
| GET | `/api/sync/progress` | Poll sync progress |
| GET | `/api/status` | Tally connection status |
| GET/POST | `/api/settings` | Read/write app settings |
| GET | `/api/companies` | List synced companies |

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Backend | Node.js + Express |
| Database | SQLite via better-sqlite3 (WAL mode, per-client split) |
| XML Parsing | fast-xml-parser |
| Reports | docx (Word), pdfkit (PDF), exceljs (Excel) |
| Frontend | Vanilla JS, Tailwind CSS (CDN) |
| Charts | Chart.js v4 (CDN) |
| File Upload | multer + xlsx parser |
| Auth | bcryptjs + express-session |

---

## Data Privacy

All data stays on your local machine:
- Per-client SQLite databases (`data/master.db` + `data/clients/`)
- No outbound internet connections (except CDN for frontend libs)
- No cloud accounts or API keys required
- Runs entirely offline after `npm install`

---

## Supported Tally Versions

| Version | Status |
|---------|--------|
| Tally Prime (Release 4+) | Fully supported |
| Tally Prime Gold | Fully supported |
| Tally ERP 9 | Basic support |

---

## License

MIT
