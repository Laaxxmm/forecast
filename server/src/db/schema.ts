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
      description TEXT
    );

    -- Per-branch compliance instances. History-preserving: one row per period.
    -- branch_id references platform-DB branches(id) (no FK — cross-DB).
    CREATE TABLE IF NOT EXISTS vcfo_compliances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch_id INTEGER NOT NULL,
      catalog_id INTEGER REFERENCES vcfo_compliance_catalog(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      frequency TEXT NOT NULL,
      due_date TEXT NOT NULL,        -- YYYY-MM-DD
      period_label TEXT NOT NULL,    -- e.g. "Apr 2026", "Q1 FY26-27", "FY 25-26"
      status TEXT NOT NULL DEFAULT 'pending',  -- pending | filed | overdue
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
  ];
  for (const sql of branchMigrations) {
    try { db.exec(sql); } catch { /* column already exists */ }
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
    `CREATE VIEW pharmacy_monthly_summary AS
    SELECT
      branch_id,
      bill_month,
      COUNT(DISTINCT bill_no) as transactions,
      COALESCE(SUM(qty), 0) as total_qty,
      COALESCE(SUM(sales_amount), 0) as total_sales,
      COALESCE(SUM(purchase_amount), 0) as total_purchase_cost,
      COALESCE(SUM(profit), 0) as total_profit,
      CASE WHEN SUM(sales_amount) > 0
        THEN ROUND(SUM(profit) * 100.0 / SUM(sales_amount), 2)
        ELSE 0
      END as profit_margin_pct,
      COALESCE(SUM(sales_tax), 0) as total_sales_tax
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
}

// Curated compliance catalog. Idempotent via INSERT OR IGNORE on the
// UNIQUE key. state=null applies to every branch; two-letter code restricts
// to branches in that state. default_due_day/month drive the first instance's
// due_date when a user adds from catalog (the UI still lets them override).
const COMPLIANCE_CATALOG: Array<{
  key: string;
  name: string;
  category: string;
  frequency: string;
  default_due_day: number | null;
  default_due_month: number | null;
  state: string | null;
  description: string;
}> = [
  { key: 'gstr1_monthly',      name: 'GSTR-1 (monthly)',            category: 'GST',     frequency: 'monthly',   default_due_day: 11, default_due_month: null, state: null, description: 'Monthly outward supplies return' },
  { key: 'gstr3b_monthly',     name: 'GSTR-3B (monthly)',           category: 'GST',     frequency: 'monthly',   default_due_day: 20, default_due_month: null, state: null, description: 'Monthly summary return & tax payment' },
  { key: 'gstr1_iff_quarterly',name: 'GSTR-1 / IFF (quarterly)',    category: 'GST',     frequency: 'quarterly', default_due_day: 13, default_due_month: null, state: null, description: 'Quarterly outward supplies (QRMP scheme)' },
  { key: 'gstr3b_quarterly',   name: 'GSTR-3B (quarterly)',         category: 'GST',     frequency: 'quarterly', default_due_day: 22, default_due_month: null, state: null, description: 'Quarterly summary return (QRMP)' },
  { key: 'gstr9_annual',       name: 'GSTR-9 (annual)',             category: 'GST',     frequency: 'annual',    default_due_day: 31, default_due_month: 12,   state: null, description: 'Annual GST return' },
  { key: 'tds_payment',        name: 'TDS Payment (monthly)',       category: 'TDS',     frequency: 'monthly',   default_due_day: 7,  default_due_month: null, state: null, description: 'Monthly TDS deposit to government' },
  { key: 'tds_return',         name: 'TDS Return (quarterly)',      category: 'TDS',     frequency: 'quarterly', default_due_day: 31, default_due_month: null, state: null, description: 'Quarterly TDS statement (Form 24Q/26Q)' },
  { key: 'advance_tax',        name: 'Advance Tax (quarterly)',     category: 'IT',      frequency: 'quarterly', default_due_day: 15, default_due_month: null, state: null, description: 'Quarterly advance income tax instalment' },
  { key: 'itr_annual',         name: 'Income Tax Return (annual)',  category: 'IT',      frequency: 'annual',    default_due_day: 31, default_due_month: 10,   state: null, description: 'Annual income tax return' },
  { key: 'pf_monthly',         name: 'PF Payment & ECR (monthly)',  category: 'Labour',  frequency: 'monthly',   default_due_day: 15, default_due_month: null, state: null, description: 'Monthly provident fund contribution & ECR filing' },
  { key: 'esi_monthly',        name: 'ESI Payment (monthly)',       category: 'Labour',  frequency: 'monthly',   default_due_day: 15, default_due_month: null, state: null, description: 'Monthly Employees State Insurance contribution' },
  { key: 'pt_monthly',         name: 'Professional Tax (monthly)',  category: 'Labour',  frequency: 'monthly',   default_due_day: 20, default_due_month: null, state: null, description: 'Monthly professional tax deposit (varies by state)' },
  { key: 'shop_est_renewal',   name: 'Shop & Establishment Renewal',category: 'Licence', frequency: 'annual',    default_due_day: 31, default_due_month: 12,   state: null, description: 'Annual S&E licence renewal (varies by state)' },
  { key: 'drug_licence_renewal',name: 'Drug Licence Renewal',       category: 'Licence', frequency: 'annual',    default_due_day: 31, default_due_month: 3,    state: null, description: 'Retail/wholesale drug licence — periodicity varies by state' },
  { key: 'clinical_est_renewal',name: 'Clinical Est. Act Renewal',  category: 'Licence', frequency: 'annual',    default_due_day: 31, default_due_month: 3,    state: null, description: 'Clinical Establishments Act registration renewal' },
  { key: 'pt_annual_ka',       name: 'Professional Tax — Annual Return (KA)', category: 'Labour', frequency: 'annual', default_due_day: 30, default_due_month: 4, state: 'KA', description: 'Karnataka annual PT return (employers)' },
  { key: 'labour_welfare_hy',  name: 'Labour Welfare Fund (half-yearly)', category: 'Labour', frequency: 'half-yearly', default_due_day: 31, default_due_month: 1, state: null, description: 'Half-yearly LWF deposit (varies by state)' },
];

function seedComplianceCatalog(db: DbHelper) {
  try {
    for (const c of COMPLIANCE_CATALOG) {
      db.run(
        `INSERT OR IGNORE INTO vcfo_compliance_catalog
         (key, name, category, frequency, default_due_day, default_due_month, state, description)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [c.key, c.name, c.category, c.frequency, c.default_due_day, c.default_due_month, c.state, c.description],
      );
    }
  } catch {
    /* table missing on very first init before CREATE ran — should never happen */
  }
}
