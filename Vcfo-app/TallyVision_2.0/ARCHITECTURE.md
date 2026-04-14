# TallyVision — Database & System Architecture

**Version:** 4.0.0 | **Date:** April 2026

---

## 1. Database Architecture

### Overview

TallyVision uses a **per-client SQLite architecture** where each company group gets its own database file, completely isolating client data.

```
data/
+-- master.db                          Global tables (139 KB)
+-- clients/
|   +-- group_2.db                     Magnacode group - 15 companies (85 MB)
|   +-- group_7.db                     Another group
|   +-- standalone_42.db               Ungrouped company 42
|   +-- standalone_55.db               Ungrouped company 55
+-- tallyvision_backup.db              Pre-migration backup (193 MB)
+-- uploads/                           Uploaded Excel files
```

### Why Per-Client Databases?

| Problem | Solution |
|---------|----------|
| Single DB mixed all client data | Each group gets its own .db file |
| Risk of cross-client data leaks | Physical file separation |
| Large DB slowed backup/restore | Smaller per-client files |
| Sync duplication on re-sync | UNIQUE constraints + INSERT OR IGNORE |

---

## 2. Table Distribution

### Master DB (13 tables)

These tables are global — shared across all companies.

```
+-----------------------------------------------+
| MASTER DATABASE (master.db)                   |
+-----------------------------------------------+
| app_settings           Key-value config store |
| license                License stub           |
| companies              Company profiles       |
| company_groups         Group definitions      |
| company_group_members  Group membership       |
| client_users           Portal login accounts  |
| client_company_access  User-company perms     |
| writeoff_rules         Inventory write-offs   |
| vcfo_tracker_items     vCFO action items      |
| vcfo_tracker_status    vCFO status tracking   |
| audit_milestones       Audit milestones       |
| audit_milestone_status Milestone completion   |
| audit_observations     Audit findings         |
+-----------------------------------------------+
```

### Client DB (20 tables)

Each company group (or standalone company) has these tables in their own .db file.

```
+-----------------------------------------------+
| CLIENT DATABASE (group_N.db / standalone_N.db)|
+-----------------------------------------------+
| TALLY DATA (synced from Tally)                |
|   account_groups       CoA hierarchy          |
|   ledgers              GL master list         |
|   trial_balance        Monthly balances       |
|   profit_loss          P&L snapshots          |
|   balance_sheet        BS snapshots           |
|   vouchers             Transaction details    |
|   stock_summary        Inventory snapshot     |
|   stock_item_ledger    Stock movements        |
|   bills_outstanding    AR/AP with ageing      |
|   cost_centres         Cost centre master     |
|   cost_allocations     Cost centre data       |
|   gst_entries          GST tax breakdown      |
|   payroll_entries      Payroll data           |
|   sync_log             Sync audit trail       |
+-----------------------------------------------+
| UPLOAD DATA (from Excel files)                |
|   excel_uploads        File metadata          |
|   excel_data           Parsed row data        |
|   upload_categories    Category definitions   |
+-----------------------------------------------+
| BUDGETING                                     |
|   budgets              Budget records         |
|   allocation_rules     Cost allocation rules  |
+-----------------------------------------------+
```

### Table Scoping Categories

```
COMPANY_SCOPED_TABLES (16 tables with company_id column):
  Used when migrating individual companies between DBs.
  account_groups, ledgers, trial_balance, profit_loss, balance_sheet,
  vouchers, stock_summary, stock_item_ledger, bills_outstanding,
  cost_centres, cost_allocations, gst_entries, payroll_entries, sync_log,
  excel_uploads, excel_data

GROUP_SCOPED_TABLES (2 tables with group_id or item_id):
  Used when migrating group-level data (budgets).
  budgets, allocation_rules
```

---

## 3. Query Routing (Proxy Pattern)

### How It Works

All existing `db.prepare()` calls (226+ across server.js) are routed transparently through a JavaScript Proxy.

```
                        db.prepare(sql)
                              |
                              v
                     +------------------+
                     |   Proxy Object   |
                     +--------+---------+
                              |
                    _isClientQuery(sql)?
                   /                     \
                 YES                      NO
                  |                        |
                  v                        v
         _activeClientDb              masterDb
    (set per-request by           (always the same
     /api middleware)              global connection)
```

### `_isClientQuery(sql)` Logic

Checks if the SQL string contains any client table name:
```javascript
const CLIENT_TABLE_NAMES = new Set([
    'account_groups', 'ledgers', 'trial_balance', ...
]);

function _isClientQuery(sql) {
    const normalized = sql.toLowerCase().replace(/[\r\n]+/g, ' ');
    for (const t of CLIENT_TABLE_NAMES) {
        if (normalized.includes(t)) return true;
    }
    return false;
}
```

### Middleware: Setting `_activeClientDb`

```javascript
app.use('/api', (req, res, next) => {
    _activeClientDb = null;  // reset each request
    const groupId = Number(req.query.groupId || req.body?.groupId);
    if (groupId) { _activeClientDb = dbManager.getClientDb(groupId); return next(); }
    const companyId = Number(req.query.companyId || req.body?.companyId);
    if (companyId) { _activeClientDb = dbManager.resolveDbForCompany(companyId); return next(); }
    // CSV company IDs — use first company's DB
    const csvIds = req.query.companyIds || req.body?.companyIds;
    if (csvIds) {
        const first = Number(String(csvIds).split(',')[0]);
        if (first) _activeClientDb = dbManager.resolveDbForCompany(first);
    }
    next();
});
```

### Async Safety

For async handlers (like sync), the Proxy approach has a risk: `_activeClientDb` could change between `await` points. Mitigation:

| Handler | Approach |
|---------|----------|
| Sync endpoint | Passes actual `clientDb` to DataExtractor, not the Proxy |
| Stock item ledger | Passes actual `clientDb` to DataExtractor |
| Dashboard endpoints | Synchronous (better-sqlite3) — completes before yielding |
| Report endpoints | Synchronous DB queries within the handler |

---

## 4. Connection Management

### DbManager Class

```
DbManager
  _cache: Map<string, Database>     Connection pool (path -> DB connection)
  masterDb: Database                 Master DB connection

  getMasterDb()                      Always returns the same connection
  getClientDb(groupId)               Returns/creates group_N.db
  getStandaloneDb(companyId)         Returns/creates standalone_N.db
  resolveDbForCompany(companyId)     Looks up group membership -> correct DB
  closeAll()                         Closes all connections on shutdown
```

### Connection Lifecycle

```
Startup:
  1. DbManager constructor runs _autoMigrate() if needed
  2. Opens masterDb, caches it
  3. Client DBs opened on-demand and cached

Request:
  1. Middleware resolves groupId/companyId
  2. Sets _activeClientDb (from cache or opens new)
  3. Proxy routes queries to correct DB

Shutdown:
  SIGINT/SIGTERM -> dbManager.closeAll() -> process.exit(0)
```

---

## 5. Auto-Migration

### Trigger Conditions

```
if (master.db exists)           -> Already migrated, skip
if (tallyvision.db NOT exists)  -> Fresh install, create master.db
if (tallyvision.db exists AND master.db NOT exists) -> RUN MIGRATION
```

### Migration Steps

```
Step 1: Open legacy tallyvision.db
Step 2: Create master.db with master schema
Step 3: Copy master-only tables (companies, settings, groups, users, audit, vcfo)
Step 4: For each company_group:
          Create clients/group_{id}.db
          Copy company-scoped data for each member
          Copy group-scoped data (budgets)
Step 5: For each ungrouped company:
          Create clients/standalone_{id}.db
          Copy company-scoped data
Step 6: Set app_settings.db_architecture = 'per_client'
Step 7: Rename tallyvision.db -> tallyvision_backup.db
```

### Performance

Tested with 15 companies, ~193MB legacy DB:
- Migration time: ~34 seconds
- Master DB: 139 KB
- Client DB (1 group, 15 companies): 85 MB
- Backup preserved: 193 MB

---

## 6. Data Migration on Group Changes

### Company Added to Group

```
POST /api/company-groups/:id/members/add

1. Resolve source DB (standalone_{cid}.db or another group's DB)
2. Get target group DB (group_{id}.db)
3. moveCompanyData(companyId, sourceDb, targetDb):
   a. Copy all rows WHERE company_id = ? from COMPANY_SCOPED_TABLES
   b. DELETE copied rows from source
4. INSERT INTO company_group_members in masterDb
```

### Company Removed from Group

```
DELETE /api/company-groups/members/company/:companyId

1. Get source group DB
2. Create standalone_{cid}.db
3. moveCompanyData(companyId, groupDb, standaloneDb)
4. DELETE FROM company_group_members in masterDb
```

### Group Deleted

```
DELETE /api/company-groups/:id

1. For each member: moveCompanyData to standalone DB
2. DELETE FROM company_groups in masterDb
```

### Group Membership Replaced

```
PUT /api/company-groups/:id/members

1. Compute added/removed companies (set diff)
2. Removed companies -> moveCompanyData to standalone
3. Added companies -> moveCompanyData from source to group
4. Update company_group_members in masterDb
```

---

## 7. Sync Duplication Prevention

### Primary Safeguard: DELETE-then-INSERT

Most sync methods use this pattern:
```sql
DELETE FROM trial_balance WHERE company_id = ? AND period = ?;
INSERT INTO trial_balance (...) VALUES (...);
```

### Secondary Safeguard: UNIQUE Constraints (M24)

Added in migration M24 for tables where DELETE-then-INSERT isn't granular enough:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_bs_unique
  ON balance_sheet(company_id, as_on_date, ledger_name);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bills_unique
  ON bills_outstanding(company_id, as_on_date, nature, party_name,
                       COALESCE(reference_number, ''));
```

### Tertiary Safeguard: INSERT OR IGNORE

```sql
-- bills_outstanding uses INSERT OR IGNORE instead of INSERT INTO
INSERT OR IGNORE INTO bills_outstanding (...) VALUES (...);

-- balance_sheet already uses INSERT OR IGNORE
INSERT OR IGNORE INTO balance_sheet (...) VALUES (...);
```

---

## 8. SQLite Configuration

All databases use these pragmas (set by `openDb()` in setup.js):

```sql
PRAGMA journal_mode = WAL;          -- Write-Ahead Logging for concurrent reads
PRAGMA synchronous = NORMAL;        -- Balance between safety and speed
PRAGMA cache_size = -64000;         -- 64 MB page cache
PRAGMA foreign_keys = ON;           -- Enforce FK constraints
PRAGMA busy_timeout = 5000;         -- 5 second retry on lock contention
```

---

*Document generated: April 2026 — TallyVision v4.0.0*
