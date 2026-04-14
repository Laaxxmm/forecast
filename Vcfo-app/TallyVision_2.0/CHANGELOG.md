# TallyVision — Changelog

All notable changes to this project are documented in this file.

---

## [4.0.0] - April 2026

### Removed
- **Forecast module** — removed entirely (FC namespace, forecast tables, forecast endpoints, forecast UI panels)
  - Removed tables: `forecast_items`, `forecast_values`, `forecast_item_details`, `forecast_recurring_details`, `forecast_personnel`, `forecast_assets`, `forecast_notes`, `forecast_initial_balances`, `forecast_scenarios`
  - Removed all `/api/forecast/*` endpoints and variance analysis (`/api/budgets/variance`)
  - Removed forecast and variance panels from dashboard

### Added
- **Per-client database architecture** — each company group gets its own SQLite file
  - `master.db` for global tables (settings, companies, groups, users, audit, vcfo)
  - `clients/group_{id}.db` for company financial data per group
  - `clients/standalone_{id}.db` for ungrouped companies
- **DbManager class** (`db/db-manager.js`) — connection caching, query routing, data migration
- **Auto-migration** on first startup from single `tallyvision.db` to per-client layout
  - Detects legacy DB, creates master + client DBs, backs up original
  - Migration time: ~34 seconds for 15 companies / 193MB
- **Proxy-based query routing** — transparent routing of 226+ `db.prepare()` calls
  - `_isClientQuery(sql)` detects target table from SQL string
  - `/api` middleware sets `_activeClientDb` per request from groupId/companyId
- **Data migration on group changes** — `moveCompanyData()` handles:
  - Adding companies to groups (standalone -> group DB)
  - Removing companies from groups (group -> standalone DB)
  - Deleting groups (all members -> standalone DBs)
  - Replacing group membership (diff-based migration)
  - Deleting companies (data cleanup from correct client DB)
- **UNIQUE constraints (M24)** on `balance_sheet` and `bills_outstanding`
  - Prevents data duplication on re-sync as safety net
- **Graceful shutdown** — closes all cached DB connections on SIGINT/SIGTERM

### Changed
- `server.js` — replaced `const db = initDatabase()` with DbManager + Proxy pattern
- `setup.js` — split into `createMasterSchema()` + `createClientSchema()` + separate migrations
- `data-extractor.js` — receives actual client DB (not Proxy) for async safety
- `data-extractor.js` — `UPDATE companies SET last_full_sync_at` moved to server.js sync handler
- `data-extractor.js` — `INSERT INTO bills_outstanding` changed to `INSERT OR IGNORE`
- Sync endpoint — passes `dbManager.resolveDbForCompany()` result to DataExtractor
- Stock item ledger endpoint — passes actual client DB to DataExtractor
- Company delete endpoint — cleans up data from correct client DB
- Server startup message — shows master DB and client DB paths
- One-time allocation rule migration — iterates all group client DBs

### Fixed
- Sync data going to wrong database when multiple company groups exist
- Potential data duplication on re-sync for balance_sheet and bills_outstanding
- Companies UPDATE failing in DataExtractor (companies table now in masterDb)

---

## [3.0.0] - March 2026

### Added
- **Supplementary Excel Upload System**
  - File Manager with drag-and-drop interface
  - 3 categories: revenue, closing_stock, direct_income
  - Auto-detection of clean vs messy pharma billing formats
- **Closing Stock Analysis Dashboard**
  - Expiry risk analysis (safe / near-expiry / expired tiers)
  - Slow-moving inventory detection (received > 1 year ago)
  - Stockist and manufacturer concentration charts
  - 6 KPI cards + 4 charts + 2 detail tables
- **Pharma Sales Analytics**
  - Drug revenue and profit rankings (top 20)
  - Doctor-wise revenue analysis
  - Monthly sales trend
  - Margin analysis
- **Direct Income Analytics**
  - Branch/doctor income breakdowns from Healthplix/clinic reports
- **Enhanced CFO Report (DOCX)**
  - 6 sections with dynamic numbering
  - Section 2.5: Pharma Sales Insights (drug/doctor tables)
  - Section 3: Inventory & Stock Health (expiry risk, slow-moving, supplier)
  - Section 6: Key Action Items (auto-generated priority flags)
- **Client Portal** — separate login at `/client/login`
  - Read-only access with per-company permissions
  - Feature toggles per client user
- **VCFO Tracker** — virtual CFO action item management
  - Status tracking (In Progress, Completed, Overdue)
  - Bulk actions and summary dashboard
  - Seed templates for common items
- **Audit Compliance** — milestone and observation tracking
  - Milestone management with completion status
  - Observation recording and management
  - Seed templates for audit milestones
- **Company Groups** — organize companies into groups
  - CRUD operations for groups
  - Member management (add/remove)
- **Allocation Rules** — cost centre allocation engine
  - Fixed amount, percentage, and proportional rules
  - Per-group rule sets
- **Budgeting** — budget management
  - Budget upload from Excel template
- **Cloud Publish** — stream data to cloud PostgreSQL instance
- Multi-company geographic filters (Type/State/City/Location)
- KPI card chevron arrows and click-through navigation
- Chart x-axis decimal removal

### Changed
- Dashboard from single-company to multi-company with group support
- Reports adapt sections based on available data (dynamic numbering)
- Excel data table structure (company_id + category + period_month)

---

## [2.1.0] - March 2026 (FIX-23)

### Fixed
- **Bare Collection API** for vouchers — prevents crashes on certain Tally DBs
  - Removed SYSTEM Formulae that caused "Bad formula!" errors
- **TB-based monthly trend** — fixes Purchase amount understating
  - Previous approach used voucher aggregation which missed some entries
- GST/Payroll extraction uses fetch-all-then-filter pattern

### Changed
- Sync now uses 12 monthly requests per year (was single bulk request)
- Stock summary uses quarterly chunks (4 requests/year)

---

## [2.0.0] - March 2026

### Added
- **Dynamic TB Engine** — in-memory ledger-to-group mapping
  - `buildLedgerGroupMap()` — ~8ms query time
  - `buildPLGroupSets()` — classifies groups into 4 P&L categories
  - `computePLFlow()` / `computeBSClosing()` — core KPI computation
- Redesigned dashboard with doughnut charts (Revenue, Direct/Indirect Expenses)
- GP/NP analysis with hierarchical drill-down navigation
- Hybrid TB + voucher KPI computation
- YTD monthly trend chart (bar + line)

### Changed
- Replaced SQL JOIN-based approach with in-memory engine (~8ms vs ~200ms)
- KPI computation now uses voucher data for P&L groups, TB for BS items

---

## [1.0.0] - March 2026

### Added
- Initial Tally data extraction (Chart of Accounts, Ledgers, Trial Balance, Vouchers)
- SQLite database with WAL mode
- Basic dashboard with KPI cards
- Tally connection status monitoring
- Express REST API server
- XML/HTTP communication with Tally Prime (UTF-16LE)

---

*Changelog format based on [Keep a Changelog](https://keepachangelog.com/)*
