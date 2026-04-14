# TallyVision — Developer Handoff Document

**Version:** 4.0.0
**Date:** April 2026
**Repo:** https://github.com/Laaxxmm/Merger-Tally
**Stack:** Node.js + Express, better-sqlite3, Chart.js, Tailwind CSS, docx/pdfkit/exceljs
**Dashboard:** http://localhost:3456
**Tally Port:** 9000 (default)
**Total Source:** ~20,000+ lines across 10 files

---

## 1. System Architecture (End-to-End)

```
+-------------------+                    +--------------------+
|   TALLY PRIME     |                    |   EXCEL FILES      |
|   (ERP System)    |                    |  (User Uploads)    |
+--------+----------+                    +---------+----------+
         |                                         |
   XML/HTTP:9000                           POST /api/upload
   UTF-16LE encoded                        (multer + xlsx)
         |                                         |
         v                                         v
+----------------------------------------------------------+
|                  server.js (~6,200 lines)                 |
|                                                           |
|   TALLY PIPELINE              UPLOAD PIPELINE             |
|   +-----------------+         +---------------------+     |
|   | DataExtractor   |         | Excel Parser        |     |
|   | 12 monthly TB   |         | Revenue / Stock /   |     |
|   | Bare Collection |         | Billing / Direct    |     |
|   +---------+-------+         | Income categories   |     |
|             |                 +----------+----------+     |
|             v                            v                |
|   +--------------------------------------------+         |
|   |     Per-Client SQLite Databases (WAL)       |         |
|   |  master.db: companies, settings, users      |         |
|   |  clients/group_N.db: company financial data  |         |
|   +--------------------------------------------+         |
|             |                            |                |
|   +---------v----------+   +-------------v-----------+    |
|   | Dynamic TB Engine  |   | Upload Analytics        |    |
|   | buildLedgerGroupMap|   | pharma-analytics        |    |
|   | buildPLGroupSets   |   | closing-stock-analytics |    |
|   | computePLFlow      |   | direct-income-analytics |    |
|   +--------------------+   +-------------------------+    |
|             |                            |                |
|   +---------v----------------------------v-----------+    |
|   |           REPORT GENERATORS                      |    |
|   |  docx-generator.js  |  report-generator.js       |    |
|   |  (Word DOCX 794 ln) |  (PDF+Excel 535 ln)        |    |
|   +------------------------------------------------------+
|                          |                                |
+--------------------------v--------------------------------+
                           |
              +------------v-----------+
              |    dashboard.html      |
              |    (~13,000 lines SPA) |
              |    Chart.js + Tailwind |
              +------------------------+
```

---

## 2. Per-Client Database Architecture (NEW in v4.0)

### Overview

```
data/
  master.db                    <-- Global tables only
  clients/
    group_2.db                 <-- Financial data for all companies in group 2
    group_7.db                 <-- Financial data for all companies in group 7
    standalone_42.db           <-- Ungrouped company 42's data
    standalone_55.db           <-- Ungrouped company 55's data
  tallyvision_backup.db        <-- Pre-migration backup of original single DB
```

### Master DB Tables
`app_settings`, `license`, `companies`, `company_groups`, `company_group_members`,
`client_users`, `client_company_access`, `writeoff_rules`,
`vcfo_tracker_items`, `vcfo_tracker_status`,
`audit_milestones`, `audit_milestone_status`, `audit_observations`

### Client DB Tables
`account_groups`, `ledgers`, `trial_balance`, `profit_loss`, `balance_sheet`,
`vouchers`, `stock_summary`, `stock_item_ledger`, `bills_outstanding`,
`cost_centres`, `cost_allocations`, `gst_entries`, `payroll_entries`, `sync_log`,
`excel_uploads`, `excel_data`, `upload_categories`,
`budgets`, `allocation_rules`

### How Query Routing Works

```
                     db.prepare("SELECT * FROM vouchers WHERE ...")
                                       |
                                       v
                              +------------------+
                              |   Proxy Object   |
                              |   (const db)     |
                              +--------+---------+
                                       |
                          _isClientQuery(sql)?
                         /                     \
                       YES                      NO
                        |                        |
                        v                        v
               _activeClientDb              masterDb
          (set by /api middleware)     (always the same)
```

**Key files:**
- `db/db-manager.js` — `DbManager` class: connection caching, routing, migration
- `db/setup.js` — Split schema: `createMasterSchema()` + `createClientSchema()`
- `server.js` lines 93-160 — Proxy definition, middleware, helper functions

### Auto-Migration on First Startup

When `master.db` doesn't exist but `tallyvision.db` does:

1. Creates `master.db` with master schema
2. Copies master-only tables from legacy DB
3. For each company group: creates `clients/group_{id}.db`, copies company-scoped + group-scoped data
4. For ungrouped companies: creates `clients/standalone_{id}.db`
5. Sets `db_architecture = 'per_client'` in app_settings
6. Renames `tallyvision.db` to `tallyvision_backup.db`

### Data Migration on Group Changes

| Action | What Happens |
|--------|-------------|
| Create group with companies | Company data moves from standalone DBs to new group DB |
| Add company to group | Data moves from current DB (standalone or other group) to group DB |
| Remove company from group | Data moves from group DB to new standalone DB |
| Delete group | All member data moves to individual standalone DBs |
| Delete company | Data deleted from the relevant client DB |

---

## 3. File-by-File Guide

### `src/backend/server.js` (~6,200 lines)

The main Express API server. Contains **eight major subsystems:**

```
server.js
+-- Database Initialization & Proxy (~70 lines)
|   DbManager, masterDb, Proxy-based query routing
|
+-- Auth & Client Portal (~80 lines)
|   /client/login, session management, read-only enforcement
|
+-- Tally Sync & Connection (~200 lines)
|   POST /api/sync/start, GET /api/sync/progress, /api/status
|   DataExtractor receives actual clientDb (not proxy) for async safety
|
+-- Dynamic TB Engine (~400 lines)
|   buildLedgerGroupMap(), buildPLGroupSets(), getGroupTree()
|   computePLFlow(), computeBSClosing(), getTBSupplement()
|
+-- Dashboard API Endpoints (~500 lines)
|   /api/dashboard/kpi, /monthly-trend, /group-breakdown
|   /trial-balance, /receivable-ageing, /payable-ageing
|
+-- Multi-Company & Geographic Filtering (~200 lines)
|   Company type/state/city/location filters on all endpoints
|   resolveCompanyIds(), geographic P&L rollups
|
+-- Budgeting (~200 lines)
|   /api/budgets, /budgets/upload
|
+-- Company Groups & Data Migration (~200 lines)
|   CRUD for groups, members with dbManager.moveCompanyData()
|
+-- Excel Upload System (~600 lines)
|   POST /api/upload/excel (multer + xlsx parser)
|   pharma-analytics, closing-stock-analytics, direct-income-analytics
|
+-- CFO Report Data Builder (~500 lines)
|   buildCFOInsightsData(), buildPharmaInsightsData()
|   buildClosingStockInsightsData(), buildCFOActionItems()
|
+-- VCFO Tracker & Audit (~400 lines)
|   /api/vcfo/items, /status, /summary
|   /api/audit/milestones, /observations, /summary
|
+-- Cloud Publish (~200 lines)
|   POST /api/cloud/publish — streams data to cloud PostgreSQL
|
+-- Allocation & Write-off Rules (~200 lines)
    /api/allocation-rules, /api/writeoff-rules
```

**Key engine functions:**
| Function | Purpose | Performance |
|----------|---------|-------------|
| `buildLedgerGroupMap(ids)` | Maps ledger names to groups from TB | ~8ms |
| `buildPLGroupSets(ids)` | Classifies P&L groups into 4 sets | Uses account_groups metadata |
| `getGroupTree(ids, parent)` | Recursive group descendants | For drill-down navigation |
| `computePLFlow()` | Sums voucher amounts for a P&L group set | Core KPI computation |
| `computeBSClosing()` | TB opening + voucher movements for BS | Cash, Receivables, etc. |
| `resolveCompanyIds()` | Geographic filter resolution | Uses masterDb |
| `resolveGroupMemberIds()` | Group member lookup | Uses masterDb |

### `src/backend/db/db-manager.js` (~330 lines)

```
DbManager class
+-- constructor(dataDir)          # Opens master, runs auto-migration
+-- getMasterDb()                 # Returns master.db connection
+-- getClientDb(groupId)          # Returns/creates clients/group_{id}.db
+-- getStandaloneDb(companyId)    # Returns/creates clients/standalone_{id}.db
+-- resolveDbForCompany(cid)      # Looks up group membership, returns correct DB
+-- moveCompanyData(cid, src, tgt)  # Migrates company rows between DBs
+-- copyGroupData(gid, src, tgt)    # Migrates group-scoped data (budgets, etc.)
+-- closeAll()                    # Closes all cached connections
+-- _autoMigrate()                # One-time migration from single DB
```

### `src/backend/db/setup.js` (~700 lines)

```
Split Schema:
+-- createMasterSchema(db)        # 13 tables (settings, companies, groups, users, audit, vcfo)
+-- createClientSchema(db)        # 20 tables (financial data, budgets, uploads)
+-- runMasterMigrations(db)       # M1-M23 for master tables
+-- runClientMigrations(db)       # M1-M24 for client tables
+-- initMasterDatabase(dbPath)    # Create + schema + migrations
+-- initClientDatabase(dbPath)    # Create + schema + migrations
+-- openDb(dbPath)                # Standard pragmas (WAL, FK, 64MB cache, 5s busy)

M24 (client): UNIQUE constraints for sync duplication prevention
  idx_bs_unique ON balance_sheet(company_id, as_on_date, ledger_name)
  idx_bills_unique ON bills_outstanding(company_id, as_on_date, nature, party_name, reference_number)
```

### `src/backend/extractors/data-extractor.js` (730 lines)

```
Extraction Flow (receives actual clientDb, not proxy):
  extractChartOfAccounts()  --> 1 request   --> account_groups
  extractLedgers()          --> 1 request   --> ledgers
  extractTrialBalance()     --> 12 requests --> trial_balance (monthly)
  extractVouchers()         --> 12 requests --> vouchers (monthly, bare API)
  extractStockSummary()     --> 4 requests  --> stock_summary (quarterly)
  extractBillsOutstanding() --> 2 requests  --> bills_outstanding
  [optional] extractGstEntries()        --> 12 requests
  [optional] extractCostAllocations()   --> 1 request
  [optional] extractPayroll()           --> 12 requests

  Total: ~32 requests per full sync (+ optional modules)

  NOTE: companies table UPDATE (last_full_sync_at) is done in server.js
        sync handler, NOT in DataExtractor (companies is in masterDb)
```

### `src/backend/docx-generator.js` (794 lines)

Word document generator for CFO Insights Report.

```
docx-generator.js
+-- generateDocx(cfoData)          # Main entry, assembles all sections
+-- buildTitleSection()            # Report header with period/date
+-- buildExecutiveSummary()        # Section 1: KPIs + narrative bullets
+-- buildPLComparison()            # Section 2.1: P&L MoM/YoY table
+-- buildColumnarPL()              # Section 2.2: Geographic P&L
+-- buildRevenueConcentration()    # Section 2.3: Top revenue ledgers
+-- buildOpExTrend()               # Section 2.4: 6-month expense trend
+-- buildPharmaInsights()          # Section 2.5: Drug/doctor tables
+-- buildStockHealth()             # Section 3: Full inventory section
+-- buildCashPosition()            # Section 4.1: Cash & bank
+-- buildAgeingTable()             # Section 4.2/4.3: AR/AP ageing
+-- buildGSTSummary()              # Section 5.1: GST breakdown
+-- buildComplianceCalendar()      # Section 5.3: Upcoming deadlines
+-- buildActionItemsSection()      # Section 6: Priority action items
```

Dynamic section numbering: Sections auto-renumber based on available data.

### `src/frontend/dashboard.html` (~13,000 lines)

Single-page application with **4 main panels:**

```
Panel: overview     - KPIs, charts, trend, supplementary analytics
Panel: tableView    - Trial Balance, AR/AP Ageing, Stock Summary
Panel: vcfo         - Virtual CFO action item tracker
Panel: audit        - Compliance milestones & observations
```

---

## 4. P&L / KPI Formulas

```
                                          Sign in DB
Revenue (Sales Accounts)               =  credit (positive)
Direct Incomes                         =  credit
Purchases                              =  debit  (negative)
Direct Expenses                        =  debit

Gross Profit  = Revenue + Direct Incomes + Purchases + Direct Expenses
Net Profit    = Gross Profit + Indirect Incomes + Indirect Expenses

Group Classification (buildPLGroupSets):
  account_groups WHERE bs_pl = 'PL'
  +-- dr_cr='C' + affects_gross_profit='Y' --> directCredit  (Revenue, Direct Income)
  +-- dr_cr='D' + affects_gross_profit='Y' --> directDebit   (Purchases, Direct Expenses)
  +-- dr_cr='C' + affects_gross_profit='N' --> indirectCredit (Indirect Income)
  +-- dr_cr='D' + affects_gross_profit='N' --> indirectDebit  (Indirect Expenses)
```

---

## 5. Critical Tally API Behaviors

| # | Behavior | Impact | Workaround |
|---|----------|--------|-----------|
| 1 | Collection API ignores `SVFROMDATE/SVTODATE` | Returns all-period data | Post-filter in JS by date |
| 2 | Purchase vouchers lack `AllLedgerEntries` expansion | Party names (BS) instead of P&L groups | Use TB data for Purchase amounts |
| 3 | SYSTEM Formulae crash certain companies | "Bad formula!" error | Bare Collection API (no filters) |
| 4 | UTF-16LE encoding mandatory | UTF-8 silently ignored | All requests/responses in UTF-16LE |
| 5 | Tally is single-threaded | HTTP blocks during exports | Suppress "offline" badge during sync |

---

## 6. Excel Upload Data Formats

### Pharma Revenue (category: `revenue`)
Two formats handled automatically:

**Clean format** (Bangalore/Chennai):
```
Bill No | Bill Date | Drug Name | Drug Mfg | Doctor Name | Qty | MRP | Amount | Cost | Profit
```

**Messy format** (Hyderabad):
```
Bill Date | Bill No | ... | Drug Name | Drug Mfg | HSN | Batch | Expiry | Pack | Qty | Free | Gross | Disc | Tax | Net
```

### Closing Stock (category: `closing_stock`)
```
Product Name | Manufacturer | Stockist | Batch | Expiry | Received | Qty | MRP Amount | Purchase Amount
```

### Direct Income (category: `direct_income`)
```
Doctor Name | Amount | Date | ...
```

---

## 7. Async Safety in Sync

The sync endpoint (`POST /api/sync/start`) is async. The `_activeClientDb` global could be changed by concurrent requests during `await`. To prevent this:

1. **DataExtractor receives the actual client DB** (not the Proxy) via `dbManager.resolveDbForCompany(company.id)`
2. **`syncInProgress` flag** prevents concurrent syncs
3. **Companies table update** happens in server.js `.then()` callback using `masterDb` directly

```javascript
// server.js sync handler
const clientDb = dbManager.resolveDbForCompany(company.id);  // actual DB, not proxy
const extractor = new DataExtractor(clientDb, { host, port, onProgress });
// ...
extractor.runFullSync(...).then(results => {
    if (results.success) {
        masterDb.prepare('UPDATE companies SET last_full_sync_at=?...').run(...);
    }
});
```

---

## 8. Version History

### v4.0.0 — April 2026 (Current)
- **Per-client database architecture** — master.db + clients/group_*.db + standalone_*.db
- **Auto-migration** from single tallyvision.db on first startup
- **Proxy-based query routing** — 226+ db.prepare() calls work unchanged
- **Data migration on group changes** — moveCompanyData() handles add/remove
- **UNIQUE constraints (M24)** — balance_sheet + bills_outstanding duplication prevention
- **INSERT OR IGNORE** on bills_outstanding sync
- **Graceful shutdown** — closes all cached DB connections

### v3.0.0 — March 2026
- **Supplementary Excel Upload System** — File Manager with drag-drop
- **Closing Stock Analysis Dashboard** — Expiry risk, slow-moving, supplier concentration
- **Pharma Sales Analytics** — Drug/doctor revenue/profit breakdowns
- **Enhanced CFO Report (DOCX)** — 6 sections with pharma, inventory, action items
- **Client Portal** — Separate login with read-only access
- **VCFO Tracker** — Action item tracking with status management
- **Audit Compliance** — Milestone and observation tracking
- **Multi-company geographic filters** (Type/State/City/Location)
- **Allocation rules** — Cost centre allocation engine
- **Cloud publish** — Stream data to cloud PostgreSQL

### v2.1.0 (FIX-23) — March 2026
- Bare Collection API for vouchers (crash-proof)
- TB-based monthly trend (fixes Purchase understating)
- 12 monthly requests per sync

### v2.0.0 — March 2026
- Dynamic TB engine (in-memory, ~8ms queries)
- Redesigned dashboard with doughnut charts
- GP/NP analysis with drill-down navigation

### v1.0.0 — March 2026
- Initial release with basic extraction and dashboard

---

## 9. Environment & Configuration

| Setting | Default | Location |
|---------|---------|----------|
| Tally host | `localhost` | `app_settings.tally_host` |
| Tally port | `9000` | `app_settings.tally_port` |
| Dashboard port | `3456` | `server.js` PORT constant |
| Master DB | `data/master.db` | `setup.js getMasterDbPath()` |
| Client DBs | `data/clients/` | `setup.js getClientDbDir()` |
| Upload dir | `data/uploads/` | `server.js` (multer config) |

---

## 10. Dependencies

| Package | Purpose |
|---------|---------|
| `express` | HTTP server + REST API |
| `better-sqlite3` | Synchronous SQLite (WAL mode) |
| `fast-xml-parser` | Tally XML parsing |
| `cors` | Cross-origin requests |
| `multer` | File upload handling |
| `bcryptjs` | Password hashing (client portal) |
| `express-session` | Session management |
| `docx` | Word document generation |
| `pdfkit` | PDF generation |
| `exceljs` | Excel report generation |
| `uuid` | UUID generation |
| `node-cron` | Scheduled tasks (imported, not yet active) |

**Frontend (CDN):** Chart.js v4, Tailwind CSS, Litepicker (date range), Google Fonts (Inter)

---

## 11. Development Tips

### Running locally
```bash
npm start                    # Start server on port 3456
node src/backend/server.js   # Same thing
```

### Adding a new client table
1. Add CREATE TABLE to `createClientSchema()` in `setup.js`
2. Add table name to `CLIENT_TABLE_NAMES` set in `server.js` (line ~106)
3. Add to `CLIENT_TABLES` in `db-manager.js` if it has `company_id`
4. Add to `COMPANY_SCOPED_TABLES` or `GROUP_SCOPED_TABLES` in `db-manager.js`
5. All existing `db.prepare()` calls will auto-route via the Proxy

### Adding a new upload category
1. Add category constant in `server.js` POST `/api/upload/excel` handler
2. Add row parser for the new Excel format
3. Add analytics endpoint (e.g., `/api/upload/new-category-analytics`)
4. Add section builder in `docx-generator.js` if needed for CFO report

### Moving a table from client to master (or vice versa)
1. Update `createMasterSchema()` / `createClientSchema()` in `setup.js`
2. Update `CLIENT_TABLE_NAMES` set in `server.js`
3. Update `CLIENT_TABLES` / `COMPANY_SCOPED_TABLES` / `GROUP_SCOPED_TABLES` in `db-manager.js`
4. Add migration logic if existing data needs to be moved

---

*Document generated: April 2026 — covers v1.0.0 through v4.0.0*
