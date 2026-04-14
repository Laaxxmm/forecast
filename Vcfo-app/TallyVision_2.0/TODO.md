# TallyVision - Project Roadmap & Status

**Last Updated:** April 2026 | **Current Version:** 4.0.0

---

## Feature Completion Overview

```
 FEATURE STATUS DASHBOARD
 ========================

 Core Platform          [####################] 100%  COMPLETE
 Tally Integration      [####################] 100%  COMPLETE
 Dashboard UI           [####################] 100%  COMPLETE
 Per-Client DB Split    [####################] 100%  COMPLETE  (NEW v4.0)
 Excel Upload System    [####################] 100%  COMPLETE
 CFO Report (DOCX)      [####################] 100%  COMPLETE
 Multi-Company          [####################] 100%  COMPLETE
 Pharma Analytics       [####################] 100%  COMPLETE
 Stock Analytics        [####################] 100%  COMPLETE
 VCFO Tracker           [####################] 100%  COMPLETE
 Audit Compliance       [####################] 100%  COMPLETE
 Client Portal          [####################] 100%  COMPLETE
 Company Groups         [####################] 100%  COMPLETE
 Allocation Rules       [####################] 100%  COMPLETE
 Budgeting              [####################] 100%  COMPLETE
 PDF/Excel Reports      [################----]  80%  IN PROGRESS
 Scheduled Sync         [####----------------]  20%  PLANNED
 Cloud Deployment       [########------------]  40%  IN PROGRESS

 Overall Progress:      [#################---]  85%
```

---

## Completed Features

### v4.0.0 (Current Release - April 2026)

```
 +------------------------------------------------------------------+
 |                    v4.0.0 FEATURE MAP                             |
 +------------------------------------------------------------------+
 |                                                                    |
 |  PER-CLIENT DATABASE ARCHITECTURE                                 |
 |  +--------------------+  +---------------------+  +-----------+  |
 |  | master.db          |  | clients/group_N.db  |  | Auto      |  |
 |  | - Settings         |  | - Trial Balance     |  | Migration |  |
 |  | - Companies        |  | - Vouchers          |  | - On 1st  |  |
 |  | - Groups           |  | - Budgets           |  |   startup |  |
 |  | - Users            |  | - Excel data        |  | - Backup  |  |
 |  | - Audit/VCFO       |  |                     |  |   legacy  |  |
 |  +--------------------+  +---------------------+  +-----------+  |
 |                                                                    |
 |  PROXY-BASED QUERY ROUTING          DATA MIGRATION                |
 |  +-------------------------+      +-------------------------+     |
 |  | - Transparent to 226+  |      | - Group add/remove      |     |
 |  |   existing db.prepare  |      | - Company delete        |     |
 |  | - Table name detection  |      | - Group delete          |     |
 |  | - Request-scoped client |      | - Standalone <-> group  |     |
 |  +-------------------------+      +-------------------------+     |
 |                                                                    |
 |  SYNC DUPLICATION PREVENTION                                      |
 |  - UNIQUE constraints (M24) on balance_sheet, bills_outstanding  |
 |  - INSERT OR IGNORE for bills_outstanding sync                   |
 |  - DELETE-then-INSERT pattern preserved as primary safeguard     |
 |  - Graceful shutdown: all cached DB connections closed            |
 +------------------------------------------------------------------+
```

### v3.0.0 (March 2026)
- [x] Supplementary Excel Upload System (File Manager, drag-drop, 3 categories)
- [x] Closing Stock Analysis Dashboard (expiry risk, slow-moving, supplier concentration)
- [x] Pharma Sales Analytics (drug/doctor revenue/profit breakdowns)
- [x] Direct Income Analytics (Healthplix/clinic revenue parsing)
- [x] Enhanced CFO Report (DOCX) — 6 sections with pharma, inventory, action items
- [x] Dynamic section numbering in reports
- [x] Multi-company geographic filters (Type/State/City/Location)
- [x] Client Portal (separate login, read-only, per-company access)
- [x] VCFO Tracker (action items, status tracking, bulk actions)
- [x] Audit Compliance (milestones, observations, seed templates)
- [x] Allocation Rules (cost centre allocation engine)
- [x] Company Groups (CRUD, member management)
- [x] Cloud Publish endpoint (streaming to PostgreSQL)
- [x] KPI card chevron arrows + click-through navigation
- [x] Chart x-axis decimal removal

### v2.1.0 (FIX-23)
- [x] Bare Collection API for vouchers (crash-proof extraction)
- [x] TB-based monthly trend (fixes Purchase understating)
- [x] 12 monthly requests per sync cycle
- [x] GST/Payroll: fetch-all-then-filter pattern

### v2.0.0
- [x] Dynamic TB engine (in-memory, no SQL JOINs, ~8ms queries)
- [x] Redesigned dashboard with doughnut charts
- [x] GP/NP analysis with drill-down navigation
- [x] Hybrid TB + voucher KPI computation

### v1.0.0
- [x] Initial Tally data extraction (Chart of Accounts, Ledgers, TB, Vouchers)
- [x] SQLite database with WAL mode
- [x] Basic dashboard with KPI cards
- [x] Connection status monitoring

---

## Known Issues & Limitations

```
 ISSUE TRACKER
 =============

 PRIORITY   ISSUE                                    STATUS
 --------   -----                                    ------
 [HIGH]     Purchase vouchers lack P&L expansion     WORKAROUND (use TB data)
 [HIGH]     Tally SYSTEM Formulae crash some DBs     WORKAROUND (Bare API)
 [MEDIUM]   PDF report missing supplementary data    TODO
 [MEDIUM]   Excel report missing supplementary data  TODO
 [MEDIUM]   Concurrent dashboard requests may        MITIGATED (single-threaded)
            route to wrong client DB if async
 [LOW]      node-cron imported but not active         DEFERRED
 [LOW]      Licenses table unused                     DEFERRED
 [LOW]      TDS section is placeholder only           DEFERRED
```

### Detail on Workarounds

| # | Issue | Root Cause | Current Workaround |
|---|-------|-----------|-------------------|
| 1 | Purchase vouchers missing P&L groups | Tally API returns BS ledgers (party names) instead of P&L groups | Use Trial Balance data for Purchase amounts |
| 2 | SYSTEM Formulae crashes | Certain Tally company DBs reject formula-based queries | Bare Collection API with no filters |
| 3 | Collection API ignores date filters | `SVFROMDATE`/`SVTODATE` not respected | Post-filter results in JavaScript |
| 4 | UTF-16LE encoding required | Tally silently ignores UTF-8 requests | All XML encoded as UTF-16LE |
| 5 | `_activeClientDb` global for proxy routing | Could theoretically mis-route during concurrent async requests | Sync uses actual clientDb (not proxy); `syncInProgress` prevents concurrent syncs; better-sqlite3 is synchronous |

---

## Pending Tasks (TODO)

### High Priority

```
 +---------------------------------------------------------------+
 |  HIGH PRIORITY TASKS                                          |
 +---------------------------------------------------------------+
 |                                                                 |
 |  1. PDF Report Enhancement                                    |
 |     +-- Add pharma sales section to PDF output                |
 |     +-- Add closing stock section to PDF output               |
 |     +-- Add action items section to PDF output                |
 |     +-- Match DOCX report structure (6 sections)              |
 |                                                                 |
 |  2. Excel Report Enhancement                                  |
 |     +-- Add pharma analytics sheet                            |
 |     +-- Add closing stock analytics sheet                     |
 |     +-- Add action items sheet                                |
 |                                                                 |
 |  3. Direct Income Dashboard Integration                       |
 |     +-- Wire direct_income analytics into CFO report          |
 |     +-- Add Healthplix/clinic revenue section to DOCX         |
 |     +-- Create dashboard supplementary view                   |
 |                                                                 |
 +---------------------------------------------------------------+
```

### Medium Priority

- [ ] **Scheduled Auto-Sync** — Activate `node-cron` for automatic Tally sync at configurable intervals
- [ ] **Data Validation on Upload** — Warn users about missing columns, invalid dates in Excel uploads
- [ ] **Export Dashboard as PDF** — One-click PDF export of current dashboard view
- [ ] **Comparison Reports** — Side-by-side comparison of two periods
- [ ] **Standalone DB Cleanup** — Auto-delete empty standalone_*.db files after company moves to group

### Low Priority

- [ ] **Cloud Deployment** — Docker containerization + cloud hosting support
- [ ] **Email Reports** — Scheduled email delivery of CFO reports
- [ ] **TDS Section** — Complete TDS compliance section in reports
- [ ] **Dark Mode** — Dashboard theme toggle (CSS variables already in place)
- [ ] **Mobile Responsive** — Optimize dashboard for tablet/mobile viewing
- [ ] **Per-Request DB Binding** — Replace global `_activeClientDb` with `req.clientDb` for true async safety

---

## Future Roadmap

```
 ROADMAP TIMELINE
 ================

 Q1 2026 (DONE)
 +------------------------------------------------------------------+
 | v1.0  Basic extraction + dashboard                               |
 | v2.0  Dynamic TB engine + redesigned dashboard                   |
 | v2.1  Bare Collection API + crash-proof extraction               |
 | v3.0  Supplementary uploads + enhanced CFO report + client portal|
 +------------------------------------------------------------------+
                                    |
                                    v
 Q2 2026 (CURRENT)
 +------------------------------------------------------------------+
 | v4.0  Per-client DB architecture                          DONE   |
 | v4.1  PDF/Excel report parity with DOCX                  TODO   |
 | v4.2  Scheduled auto-sync + data validation               TODO   |
 +------------------------------------------------------------------+
                                    |
                                    v
 Q3 2026 (PLANNED)
 +------------------------------------------------------------------+
 | v5.0  Cloud deployment (Docker + CI/CD)                          |
 | v5.1  Email report delivery                                      |
 | v5.2  Comparison reports + dashboard PDF export                  |
 +------------------------------------------------------------------+
                                    |
                                    v
 Q4 2026 (PLANNED)
 +------------------------------------------------------------------+
 | v6.0  Mobile responsive dashboard                                |
 | v6.1  AI-powered insights (trend prediction, anomaly detection)  |
 | v6.2  Multi-tenant cloud with user management                    |
 +------------------------------------------------------------------+
```

---

## Architecture Decisions Log

| Date | Decision | Rationale |
|------|----------|-----------|
| Apr 2026 | Per-client DB split | Data isolation between company groups; no cross-client data leaks |
| Apr 2026 | Proxy-based query routing | 226+ db.prepare() calls — Proxy avoids refactoring every endpoint |
| Apr 2026 | Auto-migration on startup | Zero manual effort; backup preserved as tallyvision_backup.db |
| Apr 2026 | Actual clientDb for sync | Async safety — Proxy's _activeClientDb could change during await |
| Mar 2026 | SQLite over PostgreSQL | Single-user desktop app, no network DB needed |
| Mar 2026 | No frontend framework | Single SPA, complexity doesn't warrant React/Vue |
| Mar 2026 | In-memory TB engine | ~8ms query time vs ~200ms with complex SQL joins |
| Mar 2026 | Bare Collection API | SYSTEM Formulae crash on some Tally DBs |
| Mar 2026 | Dynamic section numbering | Conditional sections; prevents gaps in numbering |

---

## Key Files Reference

```
 src/
 +-- backend/
 |   +-- server.js              # ~6,200 lines - Main API (130+ endpoints)
 |   +-- docx-generator.js      #    794 lines - Word report generator
 |   +-- report-generator.js    #    535 lines - PDF/Excel generators
 |   +-- tally-connector.js     #    178 lines - TCP/XML Tally comms
 |   +-- cfo-review-generator.js#            - CFO review logic
 |   +-- db/
 |   |   +-- setup.js           #   ~700 lines - Split schema + migrations
 |   |   +-- db-manager.js      #   ~330 lines - Per-client DB routing
 |   +-- extractors/
 |       +-- data-extractor.js  #    730 lines - Tally data extraction
 |       +-- xml-templates.js   #    213 lines - TDL XML templates
 +-- frontend/
     +-- dashboard.html         # ~13,000 lines - Single-page dashboard
     +-- client-login.html      #            - Client portal login
```

---

*Document generated: April 2026 — TallyVision v4.0.0*
