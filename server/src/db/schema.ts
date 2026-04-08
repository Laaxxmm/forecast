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
      business_unit TEXT NOT NULL CHECK(business_unit IN ('CLINIC', 'PHARMACY')),
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

  // Branch-related migrations (add branch_id to data tables)
  const branchMigrations = [
    'ALTER TABLE clinic_actuals ADD COLUMN branch_id INTEGER',
    'ALTER TABLE pharmacy_sales_actuals ADD COLUMN branch_id INTEGER',
    'ALTER TABLE pharmacy_purchase_actuals ADD COLUMN branch_id INTEGER',
    'ALTER TABLE import_logs ADD COLUMN branch_id INTEGER',
    'ALTER TABLE scenarios ADD COLUMN branch_id INTEGER',
    'ALTER TABLE dashboard_actuals ADD COLUMN branch_id INTEGER',
    'ALTER TABLE budgets ADD COLUMN branch_id INTEGER',
  ];
  for (const sql of branchMigrations) {
    try { db.exec(sql); } catch { /* column already exists */ }
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
      COUNT(DISTINCT patient_id) as unique_patients,
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
}
