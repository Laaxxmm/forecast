import { DbHelper } from './connection.js';

export function initializeSchema(db: DbHelper) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT DEFAULT 'user',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS financial_years (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT UNIQUE NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      is_active INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS departments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      business_unit TEXT NOT NULL DEFAULT '',
      sort_order INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS doctors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      is_active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS budgets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fy_id INTEGER NOT NULL REFERENCES financial_years(id),
      business_unit TEXT NOT NULL,
      month TEXT NOT NULL,
      department_id INTEGER REFERENCES departments(id),
      metric TEXT NOT NULL,
      amount REAL NOT NULL DEFAULT 0,
      version INTEGER DEFAULT 1,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(fy_id, business_unit, month, department_id, metric, version)
    );

    CREATE TABLE IF NOT EXISTS forecasts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fy_id INTEGER NOT NULL REFERENCES financial_years(id),
      business_unit TEXT NOT NULL,
      month TEXT NOT NULL,
      department_id INTEGER REFERENCES departments(id),
      metric TEXT NOT NULL,
      amount REAL NOT NULL DEFAULT 0,
      forecast_date TEXT NOT NULL,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS import_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      filename TEXT NOT NULL,
      rows_imported INTEGER DEFAULT 0,
      date_range_start TEXT,
      date_range_end TEXT,
      status TEXT DEFAULT 'completed',
      error_message TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS clinic_actuals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      import_id INTEGER NOT NULL REFERENCES import_logs(id),
      bill_date TEXT,
      bill_month TEXT NOT NULL,
      patient_id TEXT,
      patient_name TEXT,
      order_number TEXT,
      billed REAL,
      paid REAL,
      discount REAL,
      tax REAL,
      refund REAL,
      due REAL,
      addl_disc REAL,
      item_price REAL DEFAULT 0,
      item_disc REAL,
      department TEXT,
      service_name TEXT,
      billed_doctor TEXT,
      service_owner TEXT
    );

    CREATE TABLE IF NOT EXISTS pharmacy_sales_actuals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      import_id INTEGER NOT NULL REFERENCES import_logs(id),
      bill_no TEXT,
      bill_date TEXT,
      bill_month TEXT NOT NULL,
      drug_name TEXT,
      batch_no TEXT,
      hsn_code TEXT,
      tax_pct REAL,
      patient_id TEXT,
      patient_name TEXT,
      referred_by TEXT,
      qty REAL DEFAULT 0,
      sales_amount REAL DEFAULT 0,
      purchase_amount REAL DEFAULT 0,
      purchase_tax REAL DEFAULT 0,
      sales_tax REAL DEFAULT 0,
      profit REAL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS pharmacy_purchase_actuals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      import_id INTEGER NOT NULL REFERENCES import_logs(id),
      invoice_no TEXT,
      invoice_date TEXT,
      invoice_month TEXT NOT NULL,
      stockiest_name TEXT,
      mfg_name TEXT,
      drug_name TEXT,
      batch_no TEXT,
      hsn_code TEXT,
      batch_qty REAL,
      free_qty REAL,
      mrp REAL,
      rate REAL,
      discount_amount REAL,
      net_purchase_value REAL DEFAULT 0,
      net_sales_value REAL,
      tax_pct REAL,
      tax_amount REAL DEFAULT 0,
      purchase_qty REAL,
      purchase_value REAL DEFAULT 0,
      sales_value REAL,
      profit REAL,
      profit_pct REAL
    );

    CREATE TABLE IF NOT EXISTS pharmacy_stock_actuals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      import_id INTEGER NOT NULL REFERENCES import_logs(id),
      snapshot_date TEXT NOT NULL,
      drug_name TEXT,
      batch_no TEXT,
      received_date TEXT,
      expiry_date TEXT,
      avl_qty REAL DEFAULT 0,
      strips REAL DEFAULT 0,
      purchase_price REAL DEFAULT 0,
      purchase_tax REAL DEFAULT 0,
      purchase_value REAL DEFAULT 0,
      stock_value REAL DEFAULT 0,
      branch_id INTEGER
    );
  `);

  // Forecast module tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS scenarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fy_id INTEGER NOT NULL REFERENCES financial_years(id),
      name TEXT NOT NULL DEFAULT 'Original Scenario',
      is_default INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS forecast_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scenario_id INTEGER NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
      category TEXT NOT NULL,
      name TEXT NOT NULL,
      item_type TEXT,
      entry_mode TEXT DEFAULT 'constant',
      constant_amount REAL DEFAULT 0,
      constant_period TEXT DEFAULT 'month',
      start_month TEXT,
      annual_raise_pct REAL DEFAULT 0,
      tax_rate_pct REAL DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      parent_id INTEGER REFERENCES forecast_items(id) ON DELETE SET NULL,
      meta TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS forecast_values (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL REFERENCES forecast_items(id) ON DELETE CASCADE,
      month TEXT NOT NULL,
      amount REAL DEFAULT 0,
      UNIQUE(item_id, month)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS forecast_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scenario_id INTEGER NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
      setting_key TEXT NOT NULL,
      setting_value TEXT,
      UNIQUE(scenario_id, setting_key)
    )
  `);

  // Forecast category ↔ Tally group mapping (Step 7 of DB unification).
  // Tenant-scoped: each client can retune which Tally groups feed which
  // forecast category. Drives the Budget vs Actual report (Step 8) by
  // joining forecast_items to vcfo_trial_balance / vcfo_profit_loss
  // through `tally_group_name`. `ledger_filter` holds comma-separated
  // LIKE patterns (e.g. 'Salary%,Wages%') for categories that carve
  // a subset out of a broader Tally group (personnel from Indirect
  // Expenses).
  db.exec(`
    CREATE TABLE IF NOT EXISTS forecast_category_mapping (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      forecast_category TEXT NOT NULL,
      tally_group_name TEXT NOT NULL,
      ledger_filter TEXT,
      UNIQUE(forecast_category, tally_group_name)
    )
  `);

  // Dashboard actuals — manual entry of actual financial results
  db.exec(`
    CREATE TABLE IF NOT EXISTS dashboard_actuals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scenario_id INTEGER NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
      category TEXT NOT NULL,
      item_name TEXT NOT NULL,
      linked_item_id INTEGER REFERENCES forecast_items(id) ON DELETE SET NULL,
      month TEXT NOT NULL,
      amount REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(scenario_id, category, item_name, month)
    )
  `);

  // Turia invoices table (consultancy practice management)
  db.exec(`
    CREATE TABLE IF NOT EXISTS turia_invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      import_id INTEGER NOT NULL REFERENCES import_logs(id),
      invoice_id TEXT,
      billing_org TEXT,
      client_name TEXT,
      gstin TEXT,
      service TEXT,
      sac_code TEXT,
      invoice_date TEXT,
      invoice_month TEXT,
      due_date TEXT,
      total_amount REAL DEFAULT 0,
      status TEXT,
      branch_id INTEGER
    )
  `);

  // ── VCFO (sync-agent) tables ──────────────────────────────────────────────
  // Populated by the Electron VCFO Sync agent via /api/ingest/*. Report
  // builders in `services/vcfo-report-builder.ts` read from these tables.
  // Schema ported from the retired TallyVision_2.0 sub-app (which used to
  // create them at runtime via its own db/tenant.js). Keep CREATE TABLE IF
  // NOT EXISTS statements idempotent so existing tenants who already have
  // these tables from the TallyVision era are not re-initialised.
  db.exec(`
    CREATE TABLE IF NOT EXISTS vcfo_companies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      location TEXT DEFAULT '',
      entity_type TEXT DEFAULT '',
      fy_start_month INTEGER DEFAULT 4,
      is_active INTEGER DEFAULT 1,
      last_full_sync_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS vcfo_ledgers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL REFERENCES vcfo_companies(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      group_name TEXT,
      parent_group TEXT,
      UNIQUE(company_id, name)
    );

    CREATE TABLE IF NOT EXISTS vcfo_account_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL REFERENCES vcfo_companies(id) ON DELETE CASCADE,
      group_name TEXT NOT NULL,
      parent_group TEXT,
      bs_pl TEXT CHECK (bs_pl IN ('BS', 'PL') OR bs_pl IS NULL),
      dr_cr TEXT CHECK (dr_cr IN ('D', 'C') OR dr_cr IS NULL),
      affects_gross_profit TEXT CHECK (affects_gross_profit IN ('Y', 'N') OR affects_gross_profit IS NULL),
      UNIQUE(company_id, group_name)
    );

    CREATE TABLE IF NOT EXISTS vcfo_vouchers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL REFERENCES vcfo_companies(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      voucher_type TEXT,
      voucher_number TEXT,
      ledger_name TEXT NOT NULL,
      amount REAL DEFAULT 0,
      party_name TEXT,
      narration TEXT,
      sync_month TEXT,
      UNIQUE(company_id, date, voucher_type, voucher_number, ledger_name, amount)
    );
    CREATE INDEX IF NOT EXISTS idx_vcfo_vouchers_company_date
      ON vcfo_vouchers(company_id, date);

    CREATE TABLE IF NOT EXISTS vcfo_stock_summary (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL REFERENCES vcfo_companies(id) ON DELETE CASCADE,
      period_from TEXT NOT NULL,
      period_to TEXT NOT NULL,
      item_name TEXT NOT NULL,
      stock_group TEXT,
      opening_qty REAL DEFAULT 0,
      opening_value REAL DEFAULT 0,
      inward_qty REAL DEFAULT 0,
      inward_value REAL DEFAULT 0,
      outward_qty REAL DEFAULT 0,
      outward_value REAL DEFAULT 0,
      closing_qty REAL DEFAULT 0,
      closing_value REAL DEFAULT 0,
      UNIQUE(company_id, period_from, period_to, item_name)
    );

    CREATE TABLE IF NOT EXISTS vcfo_trial_balance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL REFERENCES vcfo_companies(id) ON DELETE CASCADE,
      period_from TEXT NOT NULL,
      period_to TEXT NOT NULL,
      ledger_name TEXT NOT NULL,
      group_name TEXT,
      opening_balance REAL DEFAULT 0,
      net_debit REAL DEFAULT 0,
      net_credit REAL DEFAULT 0,
      closing_balance REAL DEFAULT 0,
      UNIQUE(company_id, period_from, period_to, ledger_name)
    );
    CREATE INDEX IF NOT EXISTS idx_vcfo_trial_balance_period
      ON vcfo_trial_balance(company_id, period_from, period_to);

    -- Voucher-level per-ledger allocations (full double-entry). Feeds the
    -- Dynamic TB service which composes: FY-start opening + pre-period voucher
    -- delta + period voucher delta = closing-as-of-any-date. Unlike
    -- vcfo_vouchers (header-only, one row per voucher against the party
    -- ledger), this table has one row per voucher per ledger allocation — a
    -- sales voucher that hits Sales + Debtors + GST lands as three rows.
    -- debit/credit are magnitudes (>= 0); the sign is carried by the column
    -- choice so SUM(credit) - SUM(debit) yields credit-positive movement.
    -- Including (debit, credit) in the UNIQUE handles Tally's legitimate case
    -- of the same ledger appearing twice in one voucher with different amounts
    -- (e.g. a voucher with two line items that both hit the same GST ledger
    -- at different rates).
    CREATE TABLE IF NOT EXISTS vcfo_voucher_ledger_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL REFERENCES vcfo_companies(id) ON DELETE CASCADE,
      voucher_date TEXT NOT NULL,
      voucher_type TEXT NOT NULL,
      voucher_number TEXT NOT NULL,
      ledger_name TEXT NOT NULL,
      debit REAL NOT NULL DEFAULT 0,
      credit REAL NOT NULL DEFAULT 0,
      is_party_ledger INTEGER DEFAULT 0,
      narration TEXT,
      sync_month TEXT NOT NULL,
      UNIQUE(company_id, voucher_date, voucher_type, voucher_number, ledger_name, debit, credit)
    );
    CREATE INDEX IF NOT EXISTS idx_vle_company_date
      ON vcfo_voucher_ledger_entries(company_id, voucher_date);
    CREATE INDEX IF NOT EXISTS idx_vle_company_ledger_date
      ON vcfo_voucher_ledger_entries(company_id, ledger_name, voucher_date);

    -- FY-start opening balance per ledger. Captured once per FY via a single
    -- TB-style TDL call with fromDate == toDate == fy-start, which makes Tally
    -- return $OpeningBalance evaluated at FY-start (not the company's
    -- book-beginning balance). Credit-positive convention matches
    -- vcfo_trial_balance.opening_balance storage.
    CREATE TABLE IF NOT EXISTS vcfo_fy_opening_balances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL REFERENCES vcfo_companies(id) ON DELETE CASCADE,
      fy_start TEXT NOT NULL,
      ledger_name TEXT NOT NULL,
      group_name TEXT,
      opening_balance REAL DEFAULT 0,
      UNIQUE(company_id, fy_start, ledger_name)
    );
    CREATE INDEX IF NOT EXISTS idx_fyob_company_fystart
      ON vcfo_fy_opening_balances(company_id, fy_start);

    -- Curated master list of compliances. Seeded on tenant DB init (see
    -- seedComplianceCatalog). state = NULL means "applies everywhere";
    -- otherwise two-letter code (KA, MH, etc.) restricts to that state.
    CREATE TABLE IF NOT EXISTS vcfo_compliance_catalog (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      category TEXT NOT NULL,       -- GST | TDS | Labour | Licence | IT | Other
      frequency TEXT NOT NULL,      -- monthly | quarterly | half-yearly | annual
      default_due_day INTEGER,      -- e.g. 20 for GSTR-3B; for annual, day of default_due_month
      default_due_month INTEGER,    -- 1-12 (annual/half-yearly); NULL for monthly/quarterly
      state TEXT,                   -- NULL = all states
      default_scope TEXT DEFAULT 'branch',  -- state | branch | stream (suggested applicability)
      description TEXT
    );

    -- Compliance instances. History-preserving: one row per period.
    -- Applicability is captured by scope_type:
    --   state  — one filing per state (e.g. GSTR-1 for Karnataka); the
    --            state column is populated from the chosen branch at create.
    --   branch — one filing per branch (e.g. Drug Licence renewal at BTM).
    --   stream — one filing per (branch, stream) pair (e.g. pharmacy-only
    --            licence at BTM); stream_id is populated.
    -- branch_id is always set (even for state scope we store a representative
    -- branch) so ownership checks against the client's branches stay trivial.
    CREATE TABLE IF NOT EXISTS vcfo_compliances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch_id INTEGER NOT NULL,
      scope_type TEXT NOT NULL DEFAULT 'branch',  -- state | branch | stream
      state TEXT,                    -- populated when scope_type='state'
      stream_id INTEGER,             -- populated when scope_type='stream'
      catalog_id INTEGER REFERENCES vcfo_compliance_catalog(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      frequency TEXT NOT NULL,
      due_date TEXT NOT NULL,        -- YYYY-MM-DD
      period_label TEXT NOT NULL,    -- e.g. "Apr 2026", "Q1 FY26-27", "FY 25-26"
      status TEXT NOT NULL DEFAULT 'pending',  -- pending | filed | overdue | cancelled (soft-cancel when service disabled)
      amount REAL,
      assignee TEXT,
      notes TEXT,
      filed_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_vcfo_compliances_branch_due
      ON vcfo_compliances(branch_id, due_date);
    CREATE INDEX IF NOT EXISTS idx_vcfo_compliances_status
      ON vcfo_compliances(status, due_date);
    -- NOTE: idx_vcfo_compliances_scope is created AFTER the ALTER TABLE
    -- migrations below, because legacy tenant DBs don't yet have the
    -- scope_type / state / stream_id columns at this point — and SQLite
    -- aborts the entire db.exec() batch on the first failing statement,
    -- which would leave this tenant's schema half-migrated and the
    -- server crashing on the first /api/vcfo/compliances query.

    -- Per-tenant registration of high-level compliance services
    -- (GST / TDS / PF / ESI / PT / IT / licences …). Drives the Settings page
    -- that looks like a service-matrix: each row says "is this service live
    -- for this scope, and what's the registration/filing config". When a row
    -- flips enabled=1 the server spawns tracker rows in vcfo_compliances from
    -- the catalog entries linked to this service (see serviceCatalogKeys in
    -- routes/vcfo-compliance-services.ts). Disabling soft-cancels pending
    -- tracker rows (status='cancelled') so history survives.
    --
    -- Identity is (service_key, scope_type, state, branch_id) — e.g.
    --   ('gst',  'state',  'KA', <representative branch>)  ← GST in Karnataka
    --   ('pf',   'branch', NULL, 12)                       ← PF at branch 12
    CREATE TABLE IF NOT EXISTS vcfo_compliance_services (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service_key TEXT NOT NULL,       -- gst | mca | tds | pt | pf | esi | it | advance_tax | s_e | drug | clinical | lwf | manual
      scope_type TEXT NOT NULL,        -- state | branch
      state TEXT,                      -- populated when scope_type='state'
      branch_id INTEGER NOT NULL,      -- representative branch (always set)
      enabled INTEGER NOT NULL DEFAULT 0,
      registration_no TEXT,            -- GSTIN, TAN, PF code, licence number, etc.
      registration_date TEXT,          -- YYYY-MM-DD
      reg_type TEXT,                   -- e.g. 'Regular', 'Composition' (GST-specific; free-form)
      status_label TEXT,               -- 'Active', 'Cancelled', etc.
      preference TEXT,                 -- GST: 'monthly' | 'quarterly'
      assignee TEXT,
      reviewer TEXT,
      frequency_override TEXT,         -- override the catalog-default frequency
      start_day INTEGER,
      end_day INTEGER,
      amount REAL,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_vcfo_compliance_services_key
      ON vcfo_compliance_services(service_key, scope_type, COALESCE(state,''), branch_id);

    -- Retrofit unique indices for tenants whose vcfo_* tables were created
    -- pre-cutover by the retired TallyVision sub-app. CREATE TABLE IF NOT
    -- EXISTS won't alter an existing table, so any column-level UNIQUE in
    -- the declarations above is a no-op for those tenants. An explicit
    -- unique index fills the gap and lets ON CONFLICT(name) in
    -- routes/ingest.ts resolve against it. Idempotent: if the legacy
    -- table already has the constraint, CREATE UNIQUE INDEX IF NOT EXISTS
    -- is a no-op.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_vcfo_companies_name
      ON vcfo_companies(name);

    -- ── VCFO Accounting Tracker ────────────────────────────────────────────
    -- Month/quarter/year-end close checklist with an accountant → reviewer
    -- approval workflow and a per-task file module for workings and docs.
    -- Four tables:
    --   vcfo_accounting_task_catalog   — curated master list (seeded per tenant)
    --   vcfo_accounting_tasks          — per-period instances (the workable rows)
    --   vcfo_accounting_task_files     — attachments under DATA_DIR/uploads
    --   vcfo_accounting_task_events    — immutable audit log of state changes
    --
    -- Status lifecycle: pending → in_progress → submitted → approved | rejected
    -- (plus a "cancelled" escape hatch). "overdue" is DERIVED at read time
    -- (due_date < today AND status NOT IN ('approved','cancelled')), never
    -- stored — preserves idempotency as the clock advances.
    CREATE TABLE IF NOT EXISTS vcfo_accounting_task_catalog (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      category TEXT NOT NULL,           -- bank | receivables | payables | payroll
                                         --   | tax | fa | inventory | ledger
                                         --   | reporting | governance
      frequency TEXT NOT NULL,           -- monthly | quarterly | half-yearly | annual
      default_due_day INTEGER,
      default_due_month INTEGER,         -- 1–12 for annual/half-yearly
      default_assignee_role TEXT,        -- accountant | senior_accountant | cfo
      description TEXT,
      checklist TEXT,                    -- newline-separated sub-steps (string v1)
      is_active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_vcfo_acct_catalog_cat
      ON vcfo_accounting_task_catalog(category, frequency);

    CREATE TABLE IF NOT EXISTS vcfo_accounting_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      catalog_id INTEGER REFERENCES vcfo_accounting_task_catalog(id) ON DELETE SET NULL,
      branch_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      frequency TEXT NOT NULL,
      period_label TEXT NOT NULL,        -- 'Apr 2026' | 'Q1 FY26-27' | 'FY 25-26'
      period_start TEXT NOT NULL,        -- YYYY-MM-DD
      period_end TEXT NOT NULL,          -- YYYY-MM-DD
      due_date TEXT NOT NULL,            -- YYYY-MM-DD
      assignee_user_id INTEGER,          -- client_users.id (soft FK; no cascade)
      reviewer_user_id INTEGER,          -- client_users.id (soft FK; no cascade)
      status TEXT NOT NULL DEFAULT 'pending',
      priority TEXT DEFAULT 'normal',    -- low | normal | high | critical
      notes TEXT,
      submission_note TEXT,
      rejection_reason TEXT,
      submitted_at TEXT,
      approved_at TEXT,
      rejected_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_vcfo_acct_tasks_branch_due
      ON vcfo_accounting_tasks(branch_id, due_date);
    CREATE INDEX IF NOT EXISTS idx_vcfo_acct_tasks_status
      ON vcfo_accounting_tasks(status, due_date);
    CREATE INDEX IF NOT EXISTS idx_vcfo_acct_tasks_assignee
      ON vcfo_accounting_tasks(assignee_user_id, status);
    -- Partial unique index: prevents double-generating catalog tasks for the
    -- same (branch, catalog, period); lets free-form ad-hoc tasks
    -- (catalog_id IS NULL) coexist without bumping the uniqueness wall.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_vcfo_acct_tasks_unique
      ON vcfo_accounting_tasks(branch_id, catalog_id, period_label)
      WHERE catalog_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS vcfo_accounting_task_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES vcfo_accounting_tasks(id) ON DELETE CASCADE,
      uploaded_by_user_id INTEGER,       -- client_users.id (soft FK; no cascade)
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      storage_path TEXT NOT NULL,        -- relative to DATA_DIR
      size_bytes INTEGER NOT NULL,
      mime_type TEXT,
      uploaded_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_vcfo_acct_files_task
      ON vcfo_accounting_task_files(task_id);

    -- Immutable audit log. Every status-changing endpoint writes a row in
    -- the SAME transaction as the UPDATE so a crashed event insert rolls
    -- back the status change. This log is the CFO's audit trail.
    CREATE TABLE IF NOT EXISTS vcfo_accounting_task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES vcfo_accounting_tasks(id) ON DELETE CASCADE,
      actor_user_id INTEGER,             -- client_users.id or NULL (system)
      event_type TEXT NOT NULL,          -- created | claimed | submitted | approved
                                          --   | rejected | reopened | cancelled
                                          --   | reassigned | file_added | file_removed
                                          --   | status_changed | note_updated
      from_status TEXT,
      to_status TEXT,
      note TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_vcfo_acct_events_task
      ON vcfo_accounting_task_events(task_id, created_at);
  `);

  // Branch-related migrations (add branch_id to data tables)
  const branchMigrations = [
    'ALTER TABLE clinic_actuals ADD COLUMN branch_id INTEGER',
    'ALTER TABLE pharmacy_sales_actuals ADD COLUMN branch_id INTEGER',
    'ALTER TABLE pharmacy_purchase_actuals ADD COLUMN branch_id INTEGER',
    'ALTER TABLE import_logs ADD COLUMN branch_id INTEGER',
    'ALTER TABLE scenarios ADD COLUMN branch_id INTEGER',
    'ALTER TABLE dashboard_actuals ADD COLUMN branch_id INTEGER',
    'ALTER TABLE budgets ADD COLUMN branch_id INTEGER',
    // Doctors are branch-scoped: each doctor belongs to one home branch (the
    // branch their clinic billings are recorded under). NULL means
    // "global / unassigned" so legacy rows stay visible to all branches until
    // the admin assigns them. Revenue-sharing rules inherit branch visibility
    // through the JOIN with doctors — no branch_id needed on the rules table.
    'ALTER TABLE doctors ADD COLUMN branch_id INTEGER',
    // Stream scoping
    'ALTER TABLE scenarios ADD COLUMN stream_id INTEGER',
    'ALTER TABLE dashboard_actuals ADD COLUMN stream_id INTEGER',
    // vcfo_companies column backfills — retrofit tenants whose table was
    // created by an older TallyVision schema version that was missing these
    // columns. CREATE TABLE IF NOT EXISTS is a no-op on existing tables so
    // the declarations above don't help; explicit ALTER is needed. Wrapped
    // in try/catch so it's idempotent (skips if column already exists).
    // Symptom this fixes: "no such column: last_full_sync_at" 500 on
    // GET /api/vcfo/companies immediately after the cutover.
    "ALTER TABLE vcfo_companies ADD COLUMN location TEXT DEFAULT ''",
    "ALTER TABLE vcfo_companies ADD COLUMN entity_type TEXT DEFAULT ''",
    'ALTER TABLE vcfo_companies ADD COLUMN fy_start_month INTEGER DEFAULT 4',
    'ALTER TABLE vcfo_companies ADD COLUMN is_active INTEGER DEFAULT 1',
    'ALTER TABLE vcfo_companies ADD COLUMN last_full_sync_at TEXT',
    "ALTER TABLE vcfo_companies ADD COLUMN created_at TEXT DEFAULT (datetime('now'))",
    // Compliance applicability — tenants created under the initial
    // compliance schema won't have these columns. Idempotent ALTERs bring
    // them up to the current shape.
    "ALTER TABLE vcfo_compliances ADD COLUMN scope_type TEXT NOT NULL DEFAULT 'branch'",
    'ALTER TABLE vcfo_compliances ADD COLUMN state TEXT',
    'ALTER TABLE vcfo_compliances ADD COLUMN stream_id INTEGER',
    "ALTER TABLE vcfo_compliance_catalog ADD COLUMN default_scope TEXT DEFAULT 'branch'",
  ];
  for (const sql of branchMigrations) {
    try { db.exec(sql); } catch { /* column already exists */ }
  }

  // ── Post-ALTER indexes ────────────────────────────────────────────────────
  // Indexes that reference columns added by the branchMigrations loop above
  // must be created AFTER those ALTERs run. Otherwise legacy tenant DBs (whose
  // vcfo_compliances predates the scope_type/state/stream_id columns) hit
  // "no such column: scope_type" during the big CREATE TABLE batch and abort
  // the entire schema initialisation, which then crashes the first request
  // that queries those columns.
  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_vcfo_compliances_scope
        ON vcfo_compliances(scope_type, state, stream_id);
    `);
  } catch (e) {
    console.error('Failed to create idx_vcfo_compliances_scope:', e);
  }

  // ── doctors(branch_id) index + backfill ───────────────────────────────────
  // For each existing doctor, infer their home branch from the clinic billings
  // (sourced from Healthplix). The branch where their name appears in the
  // most clinic_actuals rows wins. Doctors with no clinic match stay NULL,
  // which branchFilter() treats as visible-to-all-branches — admin can
  // reassign in the UI later. Idempotent: only updates rows still NULL.
  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_doctors_branch
        ON doctors(branch_id, is_active);
      UPDATE doctors
      SET branch_id = (
        SELECT il.branch_id
        FROM clinic_actuals ca
        JOIN import_logs il ON ca.import_id = il.id
        WHERE ca.billed_doctor = doctors.name
          AND il.branch_id IS NOT NULL
        GROUP BY il.branch_id
        ORDER BY COUNT(*) DESC
        LIMIT 1
      )
      WHERE branch_id IS NULL;
    `);
  } catch (e) {
    console.error('Failed to create idx_doctors_branch / backfill:', e);
  }

  // ── vcfo_companies.last_full_sync_at backfill ─────────────────────────────
  // The `/api/vcfo/companies` endpoint filters by `last_full_sync_at IS NOT
  // NULL` so the seed/ghost row planted by `ensureVcfoForSlug` (e.g. a
  // placeholder row named after the tenant itself) drops out of the picker.
  // Tenants that were synced before that column started being bumped on
  // every batch still have NULL on real companies — backfill by stamping
  // any company that has at least one row in a child table (ledgers, trial
  // balance, groups, vouchers, stock summary). Safe to re-run: the
  // predicate skips rows that already have a timestamp.
  try {
    db.exec(`
      UPDATE vcfo_companies
      SET last_full_sync_at = datetime('now')
      WHERE last_full_sync_at IS NULL
        AND id IN (
          SELECT DISTINCT company_id FROM vcfo_ledgers
          UNION SELECT DISTINCT company_id FROM vcfo_trial_balance
          UNION SELECT DISTINCT company_id FROM vcfo_account_groups
          UNION SELECT DISTINCT company_id FROM vcfo_vouchers
          UNION SELECT DISTINCT company_id FROM vcfo_stock_summary
        );
    `);
  } catch {
    // Any of the child tables may not exist yet on a fresh tenant; swallow
    // and let the normal ingest path stamp timestamps going forward.
  }

  // ── dashboard_actuals UNIQUE fix ───────────────────────────────────────────
  // The original table definition had UNIQUE(scenario_id, category, item_name,
  // month) — branch_id NOT in the key. Consequence: any multi-branch client's
  // INSERT .. ON CONFLICT DO UPDATE on this table silently overwrites another
  // branch's rollup row for the same (scenario, category, item, month). That
  // bug manifested as "Chennai data disappeared after Ashok Nagar synced"
  // even though the raw clinic_actuals rows were safe post-commit 0f75294.
  //
  // Fix: rebuild the table without the inline UNIQUE and recreate it as an
  // expression-based unique index that normalises NULL branch_id to 0 so the
  // single-branch case still enforces one row per (scenario, cat, item, month)
  // and the multi-branch case allows one row per (scenario, cat, item, month,
  // branch). All INSERT .. ON CONFLICT call sites have been updated to target
  // this same expression list.
  //
  // Idempotent: uses the presence of idx_dashboard_actuals_unique_v2 as the
  // migration flag.
  try {
    const already = db.get(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_dashboard_actuals_unique_v2'"
    );
    if (!already) {
      db.exec(`
        BEGIN;
        CREATE TABLE dashboard_actuals_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          scenario_id INTEGER NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
          category TEXT NOT NULL,
          item_name TEXT NOT NULL,
          linked_item_id INTEGER REFERENCES forecast_items(id) ON DELETE SET NULL,
          month TEXT NOT NULL,
          amount REAL DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          branch_id INTEGER,
          stream_id INTEGER
        );
        INSERT INTO dashboard_actuals_new
          (id, scenario_id, category, item_name, linked_item_id, month, amount, created_at, updated_at, branch_id, stream_id)
          SELECT id, scenario_id, category, item_name, linked_item_id, month, amount, created_at, updated_at, branch_id, stream_id
          FROM dashboard_actuals;
        DROP TABLE dashboard_actuals;
        ALTER TABLE dashboard_actuals_new RENAME TO dashboard_actuals;
        CREATE UNIQUE INDEX idx_dashboard_actuals_unique_v2
          ON dashboard_actuals (scenario_id, category, item_name, month, COALESCE(branch_id, 0));
        COMMIT;
      `);
    }
  } catch (err) {
    // If rebuild fails (unlikely — wrapped in BEGIN/COMMIT), log and move on.
    // App still works; per-branch rollups just remain collapsed until the next
    // deploy retries the migration.
    try { db.exec('ROLLBACK'); } catch {}
    console.warn('[schema] dashboard_actuals unique-key migration skipped:', (err as Error).message);
  }

  // Data migrations — backfill / normalise legacy rows
  // Historical forecast_items rows for assets were written with item_type NULL or ''.
  // BalanceSheet.tsx routes assets by item_type (current / long_term / investment);
  // NULL rows would leak out of every bucket, so we pin legacy rows to 'long_term'
  // (the category's historical default — cash, AR, etc. were always added as such).
  const dataMigrations = [
    "UPDATE forecast_items SET item_type = 'long_term' WHERE category = 'assets' AND (item_type IS NULL OR item_type = '')",
  ];
  for (const sql of dataMigrations) {
    try { db.exec(sql); } catch { /* table may not exist on fresh install */ }
  }

  // Create indexes separately (sql.js doesn't support multiple statements well with CREATE INDEX)
  const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_clinic_month ON clinic_actuals(bill_month)',
    'CREATE INDEX IF NOT EXISTS idx_clinic_dept ON clinic_actuals(department)',
    'CREATE INDEX IF NOT EXISTS idx_clinic_doctor ON clinic_actuals(billed_doctor)',
    'CREATE INDEX IF NOT EXISTS idx_pharma_sales_month ON pharmacy_sales_actuals(bill_month)',
    'CREATE INDEX IF NOT EXISTS idx_pharma_purchase_month ON pharmacy_purchase_actuals(invoice_month)',
    'CREATE INDEX IF NOT EXISTS idx_forecast_items_scenario ON forecast_items(scenario_id)',
    'CREATE INDEX IF NOT EXISTS idx_forecast_items_category ON forecast_items(category)',
    'CREATE INDEX IF NOT EXISTS idx_forecast_values_item ON forecast_values(item_id)',
    'CREATE INDEX IF NOT EXISTS idx_forecast_values_month ON forecast_values(month)',
    'CREATE INDEX IF NOT EXISTS idx_clinic_branch ON clinic_actuals(branch_id)',
    'CREATE INDEX IF NOT EXISTS idx_pharma_sales_branch ON pharmacy_sales_actuals(branch_id)',
    'CREATE INDEX IF NOT EXISTS idx_scenarios_branch ON scenarios(branch_id)',
    'CREATE INDEX IF NOT EXISTS idx_pharma_stock_snapshot ON pharmacy_stock_actuals(snapshot_date)',
    'CREATE INDEX IF NOT EXISTS idx_pharma_stock_branch ON pharmacy_stock_actuals(branch_id)',
  ];
  for (const idx of indexes) {
    try { db.exec(idx); } catch { /* index may already exist */ }
  }

  // Create views
  const views = [
    `DROP VIEW IF EXISTS clinic_monthly_summary`,
    `CREATE VIEW clinic_monthly_summary AS
    SELECT
      branch_id,
      bill_month,
      department,
      COUNT(*) as transaction_count,
      COUNT(DISTINCT COALESCE(NULLIF(patient_id, ''), patient_name)) as unique_patients,
      COALESCE(SUM(item_price), 0) as total_revenue,
      COALESCE(SUM(discount), 0) as total_discount,
      COALESCE(SUM(tax), 0) as total_tax
    FROM clinic_actuals
    GROUP BY branch_id, bill_month, department`,

    `DROP VIEW IF EXISTS clinic_doctor_summary`,
    `CREATE VIEW clinic_doctor_summary AS
    SELECT
      branch_id,
      bill_month,
      billed_doctor,
      department,
      COUNT(*) as transaction_count,
      COALESCE(SUM(item_price), 0) as total_revenue
    FROM clinic_actuals
    WHERE billed_doctor IS NOT NULL AND billed_doctor != '-'
    GROUP BY branch_id, bill_month, billed_doctor, department`,

    `DROP VIEW IF EXISTS pharmacy_monthly_summary`,
    // total_sales       = gross sales (incl. GST) — for GST filing / top-line revenue.
    // total_net_sales   = sales ex-GST — denominator for margin / profitability.
    // total_purchase_cost = COGS (already ex-GST).
    // total_profit      = TRUE gross profit = sales - tax - cogs (NOT the source-system 'profit'
    //                     column, which leaves GST in profit and is overstated by exactly
    //                     the tax collected).
    // profit_margin_pct = gross profit / net sales (ex-GST denominator).
    // reported_profit   = source-system profit, kept ONLY for sanity check:
    //                     reported_profit - total_profit must equal total_sales_tax.
    `CREATE VIEW pharmacy_monthly_summary AS
    SELECT
      branch_id,
      bill_month,
      COUNT(DISTINCT bill_no) as transactions,
      COALESCE(SUM(qty), 0) as total_qty,
      COALESCE(SUM(sales_amount), 0) as total_sales,
      COALESCE(SUM(sales_amount - COALESCE(sales_tax, 0)), 0) as total_net_sales,
      COALESCE(SUM(purchase_amount), 0) as total_purchase_cost,
      COALESCE(SUM(sales_amount - COALESCE(sales_tax, 0) - COALESCE(purchase_amount, 0)), 0) as total_profit,
      CASE WHEN SUM(sales_amount - COALESCE(sales_tax, 0)) > 0
        THEN ROUND(SUM(sales_amount - COALESCE(sales_tax, 0) - COALESCE(purchase_amount, 0)) * 100.0
                   / SUM(sales_amount - COALESCE(sales_tax, 0)), 2)
        ELSE 0
      END as profit_margin_pct,
      COALESCE(SUM(sales_tax), 0) as total_sales_tax,
      COALESCE(SUM(profit), 0) as reported_profit
    FROM pharmacy_sales_actuals
    GROUP BY branch_id, bill_month`,

    `DROP VIEW IF EXISTS pharmacy_purchase_monthly_summary`,
    `CREATE VIEW pharmacy_purchase_monthly_summary AS
    SELECT
      branch_id,
      invoice_month,
      COUNT(DISTINCT invoice_no) as invoice_count,
      COALESCE(SUM(purchase_qty), 0) as total_qty,
      COALESCE(SUM(purchase_value), 0) as total_purchase_value,
      COALESCE(SUM(net_purchase_value), 0) as total_net_purchase,
      COALESCE(SUM(tax_amount), 0) as total_tax,
      COALESCE(SUM(sales_value), 0) as expected_sales_value,
      COALESCE(SUM(profit), 0) as expected_profit
    FROM pharmacy_purchase_actuals
    GROUP BY branch_id, invoice_month`,
  ];

  for (const v of views) {
    db.exec(v);
  }

  // Migration: remove CHECK constraint from import_logs to allow HEALTHPLIX_SYNC source
  try {
    const tableInfo = db.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='import_logs'");
    if (tableInfo?.sql && tableInfo.sql.includes('CHECK(source IN')) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS import_logs_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source TEXT NOT NULL,
          filename TEXT NOT NULL,
          rows_imported INTEGER DEFAULT 0,
          date_range_start TEXT,
          date_range_end TEXT,
          status TEXT DEFAULT 'completed',
          error_message TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          branch_id INTEGER
        );
        INSERT OR IGNORE INTO import_logs_new SELECT *, NULL FROM import_logs;
        DROP TABLE import_logs;
        ALTER TABLE import_logs_new RENAME TO import_logs;
      `);
    }
  } catch { /* migration already done or table is new */ }

  // Migration: add file_path column to import_logs
  try {
    const cols = db.all("PRAGMA table_info('import_logs')");
    if (!cols.find((c: any) => c.name === 'file_path')) {
      db.exec("ALTER TABLE import_logs ADD COLUMN file_path TEXT");
    }
  } catch { /* already exists */ }

  // ── Revenue Sharing tables ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS revenue_sharing_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      source TEXT NOT NULL DEFAULT 'clinic',
      match_department TEXT,
      match_keyword TEXT,
      match_mode TEXT NOT NULL DEFAULT 'contains',
      priority INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS revenue_sharing_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doctor_id INTEGER NOT NULL REFERENCES doctors(id),
      category_id INTEGER NOT NULL REFERENCES revenue_sharing_categories(id) ON DELETE CASCADE,
      doctor_pct REAL NOT NULL DEFAULT 0,
      magna_pct REAL NOT NULL DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      UNIQUE(doctor_id, category_id)
    );
    CREATE INDEX IF NOT EXISTS idx_rs_rules_doctor ON revenue_sharing_rules(doctor_id, is_active);
    CREATE INDEX IF NOT EXISTS idx_rs_rules_category ON revenue_sharing_rules(category_id);
  `);

  // ── Performance indexes for dashboard queries ──
  const perfIndexes = [
    'CREATE INDEX IF NOT EXISTS idx_dashboard_actuals_scenario ON dashboard_actuals(scenario_id)',
    'CREATE INDEX IF NOT EXISTS idx_dashboard_actuals_lookup ON dashboard_actuals(scenario_id, category, month)',
    'CREATE INDEX IF NOT EXISTS idx_dashboard_actuals_stream ON dashboard_actuals(scenario_id, stream_id)',
    'CREATE INDEX IF NOT EXISTS idx_clinic_actuals_bill_date ON clinic_actuals(bill_date)',
    'CREATE INDEX IF NOT EXISTS idx_clinic_actuals_bill_month ON clinic_actuals(bill_month)',
    'CREATE INDEX IF NOT EXISTS idx_pharma_sales_bill_date ON pharmacy_sales_actuals(bill_date)',
    'CREATE INDEX IF NOT EXISTS idx_budgets_fy ON budgets(fy_id)',
    'CREATE INDEX IF NOT EXISTS idx_forecasts_fy ON forecasts(fy_id)',
  ];
  for (const idx of perfIndexes) {
    try { db.exec(idx); } catch { /* index may already exist */ }
  }

  seedComplianceCatalog(db);
  seedAccountingTaskCatalog(db);
}

// Curated compliance catalog. Idempotent via INSERT OR IGNORE on the
// UNIQUE key. state=null applies to every branch; two-letter code restricts
// to branches in that state. default_due_day/month drive the first instance's
// due_date when a user adds from catalog (the UI still lets them override).
// Curated compliance catalog. `default_scope` suggests the natural
// applicability:
//   state  — one filing covers the whole state (GSTIN, TAN, PT, etc.)
//   branch — per-establishment licences and labour filings
//   stream — stream-specific licences (rare; mostly useful for user overrides)
// Users can override in the Add modal.
const COMPLIANCE_CATALOG: Array<{
  key: string;
  name: string;
  category: string;
  frequency: string;
  default_due_day: number | null;
  default_due_month: number | null;
  state: string | null;
  default_scope: 'state' | 'branch' | 'stream';
  description: string;
}> = [
  { key: 'gstr1_monthly',      name: 'GSTR-1 (monthly)',            category: 'GST',     frequency: 'monthly',   default_due_day: 11, default_due_month: null, state: null, default_scope: 'state',  description: 'Monthly outward supplies return — one per state GSTIN' },
  { key: 'gstr3b_monthly',     name: 'GSTR-3B (monthly)',           category: 'GST',     frequency: 'monthly',   default_due_day: 20, default_due_month: null, state: null, default_scope: 'state',  description: 'Monthly summary return & tax payment — one per state GSTIN' },
  { key: 'gstr1_iff_quarterly',name: 'GSTR-1 / IFF (quarterly)',    category: 'GST',     frequency: 'quarterly', default_due_day: 13, default_due_month: null, state: null, default_scope: 'state',  description: 'Quarterly outward supplies (QRMP) — one per state GSTIN' },
  { key: 'gstr3b_quarterly',   name: 'GSTR-3B (quarterly)',         category: 'GST',     frequency: 'quarterly', default_due_day: 22, default_due_month: null, state: null, default_scope: 'state',  description: 'Quarterly summary return (QRMP) — one per state GSTIN' },
  { key: 'gstr9_annual',       name: 'GSTR-9 (annual)',             category: 'GST',     frequency: 'annual',    default_due_day: 31, default_due_month: 12,   state: null, default_scope: 'state',  description: 'Annual GST return — one per state GSTIN' },
  { key: 'tds_payment',        name: 'TDS Payment (monthly)',       category: 'TDS',     frequency: 'monthly',   default_due_day: 7,  default_due_month: null, state: null, default_scope: 'state',  description: 'Monthly TDS deposit — one per state TAN' },
  { key: 'tds_return',         name: 'TDS Return (quarterly)',      category: 'TDS',     frequency: 'quarterly', default_due_day: 31, default_due_month: null, state: null, default_scope: 'state',  description: 'Quarterly TDS statement (Form 24Q/26Q) — one per state TAN' },
  { key: 'advance_tax',        name: 'Advance Tax (quarterly)',     category: 'IT',      frequency: 'quarterly', default_due_day: 15, default_due_month: null, state: null, default_scope: 'state',  description: 'Quarterly advance income tax instalment' },
  { key: 'itr_annual',         name: 'Income Tax Return (annual)',  category: 'IT',      frequency: 'annual',    default_due_day: 31, default_due_month: 10,   state: null, default_scope: 'state',  description: 'Annual income tax return' },
  { key: 'pf_monthly',         name: 'PF Payment & ECR (monthly)',  category: 'Labour',  frequency: 'monthly',   default_due_day: 15, default_due_month: null, state: null, default_scope: 'branch', description: 'Monthly provident fund contribution & ECR filing — per establishment code' },
  { key: 'esi_monthly',        name: 'ESI Payment (monthly)',       category: 'Labour',  frequency: 'monthly',   default_due_day: 15, default_due_month: null, state: null, default_scope: 'branch', description: 'Monthly Employees State Insurance contribution — per establishment' },
  { key: 'pt_monthly',         name: 'Professional Tax (monthly)',  category: 'Labour',  frequency: 'monthly',   default_due_day: 20, default_due_month: null, state: null, default_scope: 'state',  description: 'Monthly professional tax deposit — state registration level' },
  { key: 'shop_est_renewal',   name: 'Shop & Establishment Renewal',category: 'Licence', frequency: 'annual',    default_due_day: 31, default_due_month: 12,   state: null, default_scope: 'branch', description: 'Annual S&E licence renewal — per establishment' },
  { key: 'drug_licence_renewal',name: 'Drug Licence Renewal',       category: 'Licence', frequency: 'annual',    default_due_day: 31, default_due_month: 3,    state: null, default_scope: 'branch', description: 'Retail/wholesale drug licence — per outlet' },
  { key: 'clinical_est_renewal',name: 'Clinical Est. Act Renewal',  category: 'Licence', frequency: 'annual',    default_due_day: 31, default_due_month: 3,    state: null, default_scope: 'branch', description: 'Clinical Establishments Act registration renewal — per clinic' },
  { key: 'pt_annual_ka',       name: 'Professional Tax — Annual Return (KA)', category: 'Labour', frequency: 'annual', default_due_day: 30, default_due_month: 4, state: 'KA', default_scope: 'state',  description: 'Karnataka annual PT return — one per employer' },
  { key: 'labour_welfare_hy',  name: 'Labour Welfare Fund (half-yearly)', category: 'Labour', frequency: 'half-yearly', default_due_day: 31, default_due_month: 1, state: null, default_scope: 'branch', description: 'Half-yearly LWF deposit — per establishment (varies by state)' },
  { key: 'mca_mgt7_annual',    name: 'MCA MGT-7 (Annual Return)',   category: 'MCA',     frequency: 'annual',    default_due_day: 29, default_due_month: 11,   state: null, default_scope: 'state',  description: 'Annual return — due 60 days from AGM (default Nov 29)' },
  { key: 'mca_aoc4_annual',    name: 'MCA AOC-4 (Financial Statements)', category: 'MCA', frequency: 'annual',   default_due_day: 30, default_due_month: 10,   state: null, default_scope: 'state',  description: 'Financials filing — due 30 days from AGM (default Oct 30)' },
];

function seedComplianceCatalog(db: DbHelper) {
  try {
    for (const c of COMPLIANCE_CATALOG) {
      db.run(
        `INSERT OR IGNORE INTO vcfo_compliance_catalog
         (key, name, category, frequency, default_due_day, default_due_month, state, default_scope, description)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [c.key, c.name, c.category, c.frequency, c.default_due_day, c.default_due_month, c.state, c.default_scope, c.description],
      );
      // Backfill default_scope on rows seeded before the column existed.
      db.run(
        `UPDATE vcfo_compliance_catalog SET default_scope = ?
         WHERE key = ? AND (default_scope IS NULL OR default_scope = '' OR default_scope = 'branch')`,
        [c.default_scope, c.key],
      );
    }
  } catch {
    /* table missing on very first init before CREATE ran — should never happen */
  }
}

// ── VCFO Accounting Tracker — catalogue of CFO-grade month-end tasks ─────────
//
// ~50 curated tasks that an in-house accountant typically runs as part of the
// Indian month/quarter/year-end close. Categories loosely follow the CFO's
// close-checklist structure: Bank & Treasury, Receivables, Payables, Payroll,
// Tax (GST/TDS/Income/MCA), Fixed Assets, Inventory, Ledger Scrutiny,
// Reporting & Governance.
//
// Frequency × default_due_day (+ default_due_month for periodic returns) is
// what the /generate endpoint uses to materialise a real task row per branch
// for a given period. `is_active` gives the tenant a soft toggle to hide a
// task from their catalogue without a destructive delete.
const ACCOUNTING_TASK_CATALOG: Array<{
  key: string;
  name: string;
  category: string;
  frequency: 'monthly' | 'quarterly' | 'half-yearly' | 'annual';
  default_due_day: number | null;
  default_due_month: number | null;
  default_assignee_role: string;
  description: string;
  checklist: string | null;
  sort_order: number;
}> = [
  // ── Bank & Treasury ──────────────────────────────────────────────────────
  { key: 'bank_recon_current',          name: 'Bank Reconciliation — Current Account',       category: 'bank', frequency: 'monthly', default_due_day: 7,  default_due_month: null, default_assignee_role: 'accountant',        description: 'Match bank statement vs. book balance; investigate unreconciled items',          checklist: 'Download statement\nImport to Tally/ERP\nMatch each entry\nList unreconciled items\nEscalate >15 day floats', sort_order: 101 },
  { key: 'bank_recon_od_cc',            name: 'Bank Reconciliation — OD/CC Account',         category: 'bank', frequency: 'monthly', default_due_day: 7,  default_due_month: null, default_assignee_role: 'accountant',        description: 'Reconcile overdraft / cash-credit bank account; verify interest accrual',         checklist: null, sort_order: 102 },
  { key: 'petty_cash_count',            name: 'Petty Cash Physical Count',                   category: 'bank', frequency: 'monthly', default_due_day: 5,  default_due_month: null, default_assignee_role: 'accountant',        description: 'Physically count petty cash; reconcile to book; file signed count sheet',         checklist: null, sort_order: 103 },
  { key: 'cash_in_hand_certify',        name: 'Cash in Hand Certification',                  category: 'bank', frequency: 'monthly', default_due_day: 5,  default_due_month: null, default_assignee_role: 'senior_accountant', description: 'Sign-off on closing cash-in-hand across branches',                               checklist: null, sort_order: 104 },
  { key: 'fd_interest_accrual',         name: 'Fixed Deposit Interest Accrual',              category: 'bank', frequency: 'monthly', default_due_day: 7,  default_due_month: null, default_assignee_role: 'accountant',        description: 'Pass interest accrual JV for all live FDs; verify Form 15G/H where applicable',  checklist: null, sort_order: 105 },
  // ── Receivables ──────────────────────────────────────────────────────────
  { key: 'ar_aging_review',             name: 'AR Aging Review',                             category: 'receivables', frequency: 'monthly', default_due_day: 10, default_due_month: null, default_assignee_role: 'senior_accountant', description: 'Review debtors aging buckets; escalate > 90 day balances',                       checklist: null, sort_order: 201 },
  { key: 'debtors_ledger_scrutiny',     name: 'Debtors Ledger Scrutiny',                     category: 'receivables', frequency: 'monthly', default_due_day: 10, default_due_month: null, default_assignee_role: 'accountant',        description: 'Walk every debtor ledger; chase unusual movements, debit notes, write-offs',     checklist: null, sort_order: 202 },
  { key: 'bad_debt_provision',          name: 'Bad Debt / ECL Provision',                    category: 'receivables', frequency: 'quarterly', default_due_day: 15, default_due_month: null, default_assignee_role: 'cfo',           description: 'Ind-AS 109 ECL / provisioning on doubtful debtors',                              checklist: null, sort_order: 203 },
  { key: 'credit_note_reconciliation',  name: 'Credit Note Reconciliation',                  category: 'receivables', frequency: 'monthly', default_due_day: 10, default_due_month: null, default_assignee_role: 'accountant',        description: 'Verify every credit note against original invoice; ensure GST effect recorded', checklist: null, sort_order: 204 },
  { key: 'customer_advance_reconciliation', name: 'Customer Advances Reconciliation',       category: 'receivables', frequency: 'monthly', default_due_day: 10, default_due_month: null, default_assignee_role: 'accountant',        description: 'Match customer advances vs. subsequent invoicing; identify stale advances',      checklist: null, sort_order: 205 },
  // ── Payables ─────────────────────────────────────────────────────────────
  { key: 'ap_aging_review',             name: 'AP Aging Review',                             category: 'payables', frequency: 'monthly', default_due_day: 10, default_due_month: null, default_assignee_role: 'senior_accountant', description: 'Review creditors aging; plan payment run; flag overdues',                       checklist: null, sort_order: 301 },
  { key: 'creditors_ledger_scrutiny',   name: 'Creditors Ledger Scrutiny',                   category: 'payables', frequency: 'monthly', default_due_day: 10, default_due_month: null, default_assignee_role: 'accountant',        description: 'Walk every creditor ledger; verify debit balances, duplicate bookings',         checklist: null, sort_order: 302 },
  { key: 'vendor_advance_reconciliation', name: 'Vendor Advances Reconciliation',            category: 'payables', frequency: 'monthly', default_due_day: 10, default_due_month: null, default_assignee_role: 'accountant',        description: 'Match vendor advances with subsequent bills; identify stale advances',          checklist: null, sort_order: 303 },
  { key: 'msme_due_identification',     name: 'MSME Due Identification (45-day rule)',       category: 'payables', frequency: 'monthly', default_due_day: 7,  default_due_month: null, default_assignee_role: 'senior_accountant', description: 'Identify MSME creditors crossing 45 days; Section 43B(h) IT Act compliance',    checklist: null, sort_order: 304 },
  { key: 'expense_provision_entries',   name: 'Month-End Expense Provisions',                category: 'payables', frequency: 'monthly', default_due_day: 5,  default_due_month: null, default_assignee_role: 'senior_accountant', description: 'Book provisions for rent, utilities, professional fees, audit fees',             checklist: null, sort_order: 305 },
  // ── Payroll ──────────────────────────────────────────────────────────────
  { key: 'payroll_jv_post',             name: 'Payroll JV Posting',                          category: 'payroll', frequency: 'monthly', default_due_day: 5,  default_due_month: null, default_assignee_role: 'accountant',        description: 'Book gross salary, deductions, net payable, PF/ESI/PT contributions',           checklist: null, sort_order: 401 },
  { key: 'pf_esi_pt_challan_post',      name: 'PF / ESI / PT Challan Posting',               category: 'payroll', frequency: 'monthly', default_due_day: 15, default_due_month: null, default_assignee_role: 'accountant',        description: 'Record monthly statutory challans; reconcile vs. payroll register',             checklist: null, sort_order: 402 },
  { key: 'gratuity_provision',          name: 'Gratuity Provision (Ind-AS 19)',              category: 'payroll', frequency: 'annual', default_due_day: 31, default_due_month: 3, default_assignee_role: 'cfo',                   description: 'Actuarial gratuity liability booked as per Ind-AS 19',                          checklist: null, sort_order: 403 },
  { key: 'leave_encashment_provision',  name: 'Leave Encashment Provision',                  category: 'payroll', frequency: 'annual', default_due_day: 31, default_due_month: 3, default_assignee_role: 'cfo',                   description: 'Year-end leave encashment liability; actuarial where material',                 checklist: null, sort_order: 404 },
  { key: 'fnf_settlement_reconciliation', name: 'Full & Final Settlement Reconciliation',     category: 'payroll', frequency: 'monthly', default_due_day: 7,  default_due_month: null, default_assignee_role: 'accountant',        description: 'Verify F&F payouts, gratuity, leave, notice recovery for exits',                checklist: null, sort_order: 405 },
  // ── Tax — GST ────────────────────────────────────────────────────────────
  { key: 'gstr1_data_review',           name: 'GSTR-1 Data Review',                          category: 'tax', frequency: 'monthly', default_due_day: 9,  default_due_month: null, default_assignee_role: 'senior_accountant', description: 'Review outward supplies data before GSTR-1 filing',                              checklist: null, sort_order: 501 },
  { key: 'gstr2b_2a_itc_match',         name: 'GSTR-2B / 2A ITC Match',                      category: 'tax', frequency: 'monthly', default_due_day: 15, default_due_month: null, default_assignee_role: 'senior_accountant', description: 'Match purchase register to 2B; identify mismatches; chase vendors',              checklist: 'Download 2B JSON\nImport to recon tool\nCategorise matched / mismatch / missing\nChase vendor for missing invoices', sort_order: 502 },
  { key: 'rcm_liability_identify',      name: 'RCM Liability Identification',                category: 'tax', frequency: 'monthly', default_due_day: 18, default_due_month: null, default_assignee_role: 'senior_accountant', description: 'Identify reverse charge transactions and book RCM liability',                    checklist: null, sort_order: 503 },
  { key: 'gst_itc_reversal_rule42_43',  name: 'ITC Reversal — Rule 42/43',                   category: 'tax', frequency: 'monthly', default_due_day: 18, default_due_month: null, default_assignee_role: 'senior_accountant', description: 'Compute proportionate ITC reversal for exempt/non-business use',                 checklist: null, sort_order: 504 },
  { key: 'gstr3b_liability_workings',   name: 'GSTR-3B Liability Workings',                  category: 'tax', frequency: 'monthly', default_due_day: 18, default_due_month: null, default_assignee_role: 'senior_accountant', description: 'Prepare GSTR-3B workings — output tax, ITC, cash vs. credit ledger',             checklist: null, sort_order: 505 },
  // ── Tax — TDS/TCS ────────────────────────────────────────────────────────
  { key: 'tds_deduction_review',        name: 'TDS Deduction Review',                        category: 'tax', frequency: 'monthly', default_due_day: 5,  default_due_month: null, default_assignee_role: 'accountant',        description: 'Verify correct TDS section, rate, PAN-based higher-rate application',            checklist: null, sort_order: 601 },
  { key: 'tcs_collection_review',       name: 'TCS Collection Review',                       category: 'tax', frequency: 'monthly', default_due_day: 5,  default_due_month: null, default_assignee_role: 'accountant',        description: 'Verify TCS collection under 206C(1H) and related sections',                      checklist: null, sort_order: 602 },
  { key: 'tds_challan_reconciliation',  name: 'TDS Challan Reconciliation',                  category: 'tax', frequency: 'monthly', default_due_day: 10, default_due_month: null, default_assignee_role: 'accountant',        description: 'Match TDS deposits vs. challans; verify BSR + challan numbers',                 checklist: null, sort_order: 603 },
  { key: 'form_26as_reconciliation',    name: 'Form 26AS Reconciliation',                    category: 'tax', frequency: 'quarterly', default_due_day: 20, default_due_month: null, default_assignee_role: 'senior_accountant', description: 'Match our TDS receipts vs. Form 26AS; follow up deductor mismatches',             checklist: null, sort_order: 604 },
  { key: 'tds_tcs_return_workings',     name: 'TDS / TCS Return Workings (24Q/26Q/27EQ)',    category: 'tax', frequency: 'quarterly', default_due_day: 20, default_due_month: null, default_assignee_role: 'senior_accountant', description: 'Prepare quarterly TDS/TCS e-TDS return workings',                                checklist: null, sort_order: 605 },
  // ── Tax — Income / MCA ──────────────────────────────────────────────────
  { key: 'advance_tax_workings',        name: 'Advance Tax Workings',                        category: 'tax', frequency: 'quarterly', default_due_day: 12, default_due_month: null, default_assignee_role: 'cfo',               description: 'Quarterly advance income tax liability computation',                             checklist: null, sort_order: 701 },
  { key: 'itr_workings_annual',         name: 'ITR Workings (annual)',                       category: 'tax', frequency: 'annual', default_due_day: 30, default_due_month: 9, default_assignee_role: 'cfo',                       description: 'Prepare annual ITR computation; coordinate with tax consultant',                  checklist: null, sort_order: 702 },
  { key: 'tax_audit_3cd_prep',          name: 'Tax Audit 3CD Preparation',                   category: 'tax', frequency: 'annual', default_due_day: 30, default_due_month: 9, default_assignee_role: 'cfo',                       description: 'Prepare 3CD schedules; coordinate with tax auditor',                             checklist: null, sort_order: 703 },
  { key: 'mca_aoc4_workings',           name: 'MCA AOC-4 Workings',                          category: 'tax', frequency: 'annual', default_due_day: 30, default_due_month: 10, default_assignee_role: 'cfo',                      description: 'Prepare AOC-4 financial statement filing workings',                              checklist: null, sort_order: 704 },
  { key: 'mca_mgt7_workings',           name: 'MCA MGT-7 Workings',                          category: 'tax', frequency: 'annual', default_due_day: 28, default_due_month: 11, default_assignee_role: 'cfo',                      description: 'Prepare MGT-7 annual return workings; verify shareholding',                      checklist: null, sort_order: 705 },
  // ── Fixed Assets ────────────────────────────────────────────────────────
  { key: 'fa_additions_capitalisation', name: 'Fixed Asset Additions & Capitalisation',       category: 'fa', frequency: 'monthly', default_due_day: 5,  default_due_month: null, default_assignee_role: 'accountant',        description: 'Capitalise new assets; record vendor invoices, freight, install costs',          checklist: null, sort_order: 801 },
  { key: 'fa_depreciation_run',         name: 'Depreciation Run (Ind-AS / Cos Act)',         category: 'fa', frequency: 'monthly', default_due_day: 5,  default_due_month: null, default_assignee_role: 'senior_accountant', description: 'Run monthly depreciation per Cos Act Sch II / Ind-AS; book JV',                 checklist: null, sort_order: 802 },
  { key: 'fa_disposal_profit_loss',     name: 'Fixed Asset Disposal — P/L Booking',          category: 'fa', frequency: 'monthly', default_due_day: 5,  default_due_month: null, default_assignee_role: 'accountant',        description: 'Retire disposed assets; book profit/loss on sale/scrap',                         checklist: null, sort_order: 803 },
  { key: 'fa_physical_verification',    name: 'Fixed Asset Physical Verification',           category: 'fa', frequency: 'annual', default_due_day: 31, default_due_month: 3, default_assignee_role: 'senior_accountant',         description: 'Annual physical verification of all fixed assets vs. FAR',                      checklist: null, sort_order: 804 },
  { key: 'cwip_review',                 name: 'CWIP Review & Capitalisation',                category: 'fa', frequency: 'monthly', default_due_day: 5,  default_due_month: null, default_assignee_role: 'senior_accountant', description: 'Review CWIP balances; capitalise ready-to-use assets',                          checklist: null, sort_order: 805 },
  // ── Inventory ────────────────────────────────────────────────────────────
  { key: 'stock_valuation_review',      name: 'Stock Valuation Review',                      category: 'inventory', frequency: 'monthly', default_due_day: 7,  default_due_month: null, default_assignee_role: 'senior_accountant', description: 'Verify stock valuation method (FIFO/WAC); lower of cost / NRV per Ind-AS 2',    checklist: null, sort_order: 901 },
  { key: 'slow_moving_obsolete_provision', name: 'Slow-Moving / Obsolete Stock Provision',   category: 'inventory', frequency: 'quarterly', default_due_day: 15, default_due_month: null, default_assignee_role: 'cfo',           description: 'Provision against slow-moving / obsolete / expired inventory',                  checklist: null, sort_order: 902 },
  { key: 'stock_physical_verification', name: 'Stock Physical Verification',                 category: 'inventory', frequency: 'quarterly', default_due_day: 15, default_due_month: null, default_assignee_role: 'senior_accountant', description: 'Quarterly physical stock-take; reconcile vs. book',                             checklist: null, sort_order: 903 },
  { key: 'stock_audit_variance_book',   name: 'Stock Audit Variance Booking',                category: 'inventory', frequency: 'quarterly', default_due_day: 20, default_due_month: null, default_assignee_role: 'accountant',       description: 'Book variances identified in stock audit; investigate > threshold',              checklist: null, sort_order: 904 },
  // ── Ledger scrutiny ──────────────────────────────────────────────────────
  { key: 'gl_scrutiny_suspense',        name: 'GL Scrutiny — Suspense Accounts',             category: 'ledger', frequency: 'monthly', default_due_day: 10, default_due_month: null, default_assignee_role: 'senior_accountant', description: 'Walk every suspense/unclassified account; clear or reclassify',                 checklist: null, sort_order: 1001 },
  { key: 'gl_scrutiny_bank_charges',    name: 'GL Scrutiny — Bank Charges & Interest',       category: 'ledger', frequency: 'monthly', default_due_day: 10, default_due_month: null, default_assignee_role: 'accountant',        description: 'Review bank charges, forex fluctuation, interest expense',                      checklist: null, sort_order: 1002 },
  { key: 'gl_scrutiny_round_off',       name: 'GL Scrutiny — Round-Off & Misc',              category: 'ledger', frequency: 'monthly', default_due_day: 10, default_due_month: null, default_assignee_role: 'accountant',        description: 'Scrutinise round-off, misc income/expense; reclassify if material',              checklist: null, sort_order: 1003 },
  { key: 'intercompany_reconciliation', name: 'Intercompany Reconciliation',                 category: 'ledger', frequency: 'monthly', default_due_day: 10, default_due_month: null, default_assignee_role: 'senior_accountant', description: 'Reconcile intercompany balances across group entities; clear differences',      checklist: null, sort_order: 1004 },
  { key: 'related_party_txn_register',  name: 'Related Party Transactions Register',         category: 'ledger', frequency: 'quarterly', default_due_day: 15, default_due_month: null, default_assignee_role: 'cfo',            description: 'Update RPT register per Cos Act Sec 188 / Ind-AS 24',                           checklist: null, sort_order: 1005 },
  // ── Reporting & Governance ──────────────────────────────────────────────
  { key: 'trial_balance_review',        name: 'Trial Balance Review',                        category: 'reporting', frequency: 'monthly', default_due_day: 10, default_due_month: null, default_assignee_role: 'senior_accountant', description: 'Review finalised TB; tie-out to sub-ledgers',                                    checklist: null, sort_order: 1101 },
  { key: 'pl_balance_sheet_finalise',   name: 'P&L / Balance Sheet Finalisation',            category: 'reporting', frequency: 'monthly', default_due_day: 12, default_due_month: null, default_assignee_role: 'cfo',           description: 'Finalise monthly P&L and BS after all close entries',                            checklist: null, sort_order: 1102 },
  { key: 'mis_pack_prep',               name: 'MIS Pack Preparation',                        category: 'reporting', frequency: 'monthly', default_due_day: 15, default_due_month: null, default_assignee_role: 'cfo',           description: 'Prepare management MIS — P&L, BS, cash flow, KPI dashboard',                     checklist: null, sort_order: 1103 },
  { key: 'cash_flow_statement',         name: 'Cash Flow Statement (Ind-AS 7)',              category: 'reporting', frequency: 'monthly', default_due_day: 15, default_due_month: null, default_assignee_role: 'senior_accountant', description: 'Prepare monthly cash flow statement — operating, investing, financing',         checklist: null, sort_order: 1104 },
  { key: 'budget_vs_actuals_variance',  name: 'Budget vs Actuals Variance Analysis',         category: 'reporting', frequency: 'monthly', default_due_day: 15, default_due_month: null, default_assignee_role: 'cfo',           description: 'Variance analysis vs. budget; narrative on > threshold swings',                  checklist: null, sort_order: 1105 },
  { key: 'board_pack_prep',             name: 'Board Pack Preparation',                      category: 'governance', frequency: 'quarterly', default_due_day: 20, default_due_month: null, default_assignee_role: 'cfo',        description: 'Prepare board meeting financial pack — KPIs, compliance, key risks',             checklist: null, sort_order: 1201 },
  { key: 'statutory_audit_pbc',         name: 'Statutory Audit PBC Preparation',             category: 'governance', frequency: 'annual', default_due_day: 30, default_due_month: 6, default_assignee_role: 'cfo',               description: 'Prepare audit-required schedules (PBC list) for statutory auditors',             checklist: null, sort_order: 1202 },
  { key: 'internal_control_review',     name: 'Internal Financial Controls Review',          category: 'governance', frequency: 'quarterly', default_due_day: 20, default_due_month: null, default_assignee_role: 'cfo',        description: 'IFC testing — walk key controls; document exceptions per Cos Act Sec 143(3)',  checklist: null, sort_order: 1203 },
];

function seedAccountingTaskCatalog(db: DbHelper) {
  try {
    for (const t of ACCOUNTING_TASK_CATALOG) {
      db.run(
        `INSERT OR IGNORE INTO vcfo_accounting_task_catalog
         (key, name, category, frequency, default_due_day, default_due_month, default_assignee_role, description, checklist, is_active, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        [t.key, t.name, t.category, t.frequency, t.default_due_day, t.default_due_month, t.default_assignee_role, t.description, t.checklist, t.sort_order],
      );
    }
  } catch (e) {
    // Table missing on very first init before CREATE ran — should never happen
    // because this is called from the tail of initializeSchema().
    console.error('[seedAccountingTaskCatalog] failed:', (e as Error).message);
  }
}
