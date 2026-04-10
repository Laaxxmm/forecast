import { DbHelper } from './connection.js';

export function initializePlatformSchema(db: DbHelper) {
  db.exec(`
    -- Super admins (your team)
    CREATE TABLE IF NOT EXISTS team_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT DEFAULT 'super_admin',
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Client organizations
    CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      db_filename TEXT NOT NULL,
      config TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Client users (login for client staff)
    CREATE TABLE IF NOT EXISTS client_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES clients(id),
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT DEFAULT 'admin',
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(client_id, username)
    );

    -- Integration plugins enabled per client
    CREATE TABLE IF NOT EXISTS client_integrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES clients(id),
      integration_key TEXT NOT NULL,
      is_enabled INTEGER DEFAULT 1,
      config TEXT,
      UNIQUE(client_id, integration_key)
    );

    -- Business streams (revenue sources) per client
    CREATE TABLE IF NOT EXISTS business_streams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES clients(id),
      name TEXT NOT NULL,
      icon TEXT DEFAULT 'BarChart3',
      color TEXT DEFAULT 'accent',
      sort_order INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(client_id, name)
    );

    -- Branches (locations/units) per client
    CREATE TABLE IF NOT EXISTS branches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES clients(id),
      name TEXT NOT NULL,
      code TEXT NOT NULL,
      city TEXT,
      manager_name TEXT,
      is_active INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(client_id, code)
    );

    -- User-branch access mapping
    CREATE TABLE IF NOT EXISTS user_branch_access (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES client_users(id),
      branch_id INTEGER NOT NULL REFERENCES branches(id),
      can_view_consolidated INTEGER DEFAULT 0,
      UNIQUE(user_id, branch_id)
    );

    -- Modules enabled per client (super admin controls)
    CREATE TABLE IF NOT EXISTS client_modules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES clients(id),
      module_key TEXT NOT NULL,
      is_enabled INTEGER DEFAULT 0,
      UNIQUE(client_id, module_key)
    );

    -- Team member → client assignments (scoped access for non-owner admins)
    CREATE TABLE IF NOT EXISTS team_member_clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_member_id INTEGER NOT NULL REFERENCES team_members(id),
      client_id INTEGER NOT NULL REFERENCES clients(id),
      assigned_at TEXT DEFAULT (datetime('now')),
      UNIQUE(team_member_id, client_id)
    );

    -- Branch → stream mapping (which streams a branch operates)
    CREATE TABLE IF NOT EXISTS branch_streams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
      stream_id INTEGER NOT NULL REFERENCES business_streams(id) ON DELETE CASCADE,
      is_active INTEGER DEFAULT 1,
      UNIQUE(branch_id, stream_id)
    );

    -- User branch+stream access (fine-grained per-stream control)
    CREATE TABLE IF NOT EXISTS user_branch_stream_access (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES client_users(id) ON DELETE CASCADE,
      branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
      stream_id INTEGER NOT NULL REFERENCES business_streams(id) ON DELETE CASCADE,
      can_view_consolidated INTEGER DEFAULT 0,
      UNIQUE(user_id, branch_id, stream_id)
    );

    -- Dashboard KPI cards per client
    CREATE TABLE IF NOT EXISTS dashboard_cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES clients(id),
      card_type TEXT NOT NULL DEFAULT 'stream',
      stream_id INTEGER REFERENCES business_streams(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      category TEXT DEFAULT 'revenue',
      icon TEXT DEFAULT 'BarChart3',
      color TEXT DEFAULT 'accent',
      is_visible INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(client_id, card_type, stream_id)
    );

    -- Dashboard chart/table visibility per client
    CREATE TABLE IF NOT EXISTS dashboard_chart_visibility (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES clients(id),
      scope TEXT NOT NULL,
      section TEXT NOT NULL DEFAULT 'charts',
      element_key TEXT NOT NULL,
      element_label TEXT NOT NULL,
      is_visible INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      UNIQUE(client_id, scope, section, element_key)
    );
  `);

  // Safe migrations for existing DBs
  const migrations = [
    "ALTER TABLE clients ADD COLUMN industry TEXT DEFAULT 'custom'",
    "ALTER TABLE clients ADD COLUMN is_multi_branch INTEGER DEFAULT 0",
    "ALTER TABLE client_integrations ADD COLUMN branch_id INTEGER REFERENCES branches(id)",
    "ALTER TABLE team_members ADD COLUMN is_owner INTEGER DEFAULT 0",
    "ALTER TABLE branches ADD COLUMN state TEXT DEFAULT ''",
    "ALTER TABLE dashboard_chart_visibility ADD COLUMN description TEXT DEFAULT ''",
    "ALTER TABLE dashboard_chart_visibility ADD COLUMN source TEXT DEFAULT ''",
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch { /* column already exists */ }
  }

  // Auto-promote the first team member to owner if none exist
  const ownerExists = db.get('SELECT id FROM team_members WHERE is_owner = 1');
  if (!ownerExists) {
    const first = db.get('SELECT id FROM team_members ORDER BY id LIMIT 1');
    if (first) {
      db.run('UPDATE team_members SET is_owner = 1 WHERE id = ?', first.id);
    }
  }

  // Backfill dashboard_cards for existing clients that have streams but no cards
  const clientsNeedingCards = db.all(
    `SELECT DISTINCT client_id FROM business_streams
     WHERE client_id NOT IN (SELECT DISTINCT client_id FROM dashboard_cards)`
  );
  for (const c of clientsNeedingCards) {
    db.run('INSERT OR IGNORE INTO dashboard_cards (client_id, card_type, title, icon, color, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
      [c.client_id, 'total', 'Total Revenue', 'IndianRupee', 'accent', 0]);
    const streams = db.all('SELECT * FROM business_streams WHERE client_id = ? ORDER BY sort_order', c.client_id);
    streams.forEach((s: any, i: number) => {
      db.run('INSERT OR IGNORE INTO dashboard_cards (client_id, card_type, stream_id, title, icon, color, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [c.client_id, 'stream', s.id, s.name, s.icon, s.color, i + 1]);
    });
  }

  // Backfill dashboard_chart_visibility for existing clients
  const seedVis = (clientId: number, scope: string, section: string, key: string, label: string, order: number, desc = '', source = '') => {
    db.run(
      `INSERT OR IGNORE INTO dashboard_chart_visibility (client_id, scope, section, element_key, element_label, sort_order, description, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [clientId, scope, section, key, label, order, desc, source]
    );
  };

  const allClients = db.all('SELECT id FROM clients');
  for (const c of allClients) {
    // Total scope charts
    seedVis(c.id, 'total', 'charts', 'monthly_revenue_trend', 'Monthly Revenue Trend', 0, 'Stacked bar chart showing monthly revenue breakdown by stream');
    seedVis(c.id, 'total', 'charts', 'revenue_split', 'Revenue Split', 1, 'Donut chart showing revenue percentage split across streams');

    // Per-stream items
    const streams = db.all('SELECT * FROM business_streams WHERE client_id = ? ORDER BY sort_order', c.id);
    for (const s of streams) {
      const sid = String(s.id);
      const nameLower = (s.name as string).toLowerCase();
      const isClinic = nameLower.includes('clinic') || nameLower.includes('health');
      const source = isClinic ? 'healthplix' : nameLower.includes('pharma') ? 'oneglance' : '';

      // Common: stream in trend chart
      seedVis(c.id, sid, 'charts', 'stream_in_trend', `${s.name} in Trend Chart`, 0, `Whether ${s.name} appears as a bar in the Monthly Revenue Trend chart`, source);

      // Clinic-specific items (Healthplix data)
      if (isClinic) {
        // ── KPI Cards ──
        seedVis(c.id, sid, 'cards', 'total_unique_patients', 'Total Unique Patients', 0,
          'Count of distinct patients across all departments (Appointment, Lab Test, Other Services)', source);
        seedVis(c.id, sid, 'cards', 'appointment_patients', 'Appointment Patients', 1,
          'Number of patients who had at least one appointment visit', source);
        seedVis(c.id, sid, 'cards', 'lab_test_patients', 'Lab Test Patients', 2,
          'Number of patients who had at least one lab test', source);
        seedVis(c.id, sid, 'cards', 'other_services_patients', 'Other Services Patients', 3,
          'Number of patients who used other services (non-appointment, non-lab)', source);
        seedVis(c.id, sid, 'cards', 'direct_lab_walkins', 'Direct Lab Walk-ins', 4,
          'Patients who had lab tests but never an appointment — potential referral or walk-in tracking', source);
        seedVis(c.id, sid, 'cards', 'direct_other_walkins', 'Direct Other Services Walk-ins', 5,
          'Patients who had other services but never an appointment — helps track non-doctor revenue sources', source);

        // ── Charts: Section A — Patient Counts ──
        seedVis(c.id, sid, 'charts', 'department_overlap', 'Department Overlap', 1,
          'Grouped bar chart showing how many patients appear in exactly 1, 2, or all 3 departments with combination labels', source);

        // ── Charts: Section B — Multi-Revenue Stream ──
        seedVis(c.id, sid, 'charts', 'patient_dept_donut', 'Patient Department Split', 2,
          'Donut chart splitting patients by number of departments touched (1 vs 2 vs 3) with total in center', source);
        seedVis(c.id, sid, 'charts', 'dept_combination_bars', 'Department Combinations', 3,
          'Horizontal bar chart showing all department combination breakdowns (e.g. "Appointment Only", "Appointment + Lab Test") with patient counts', source);
        seedVis(c.id, sid, 'charts', 'revenue_per_patient', 'Revenue Per Patient Comparison', 4,
          'Average revenue per patient: single-department vs multi-department vs all-three, with multiplier annotations (e.g. "3x")', source);
        seedVis(c.id, sid, 'charts', 'patient_flow_sankey', 'Patient Flow Analysis', 5,
          'Flow visualization showing patient journey from Appointment to Lab Test, Other Services, Both, or None — reveals cross-sell patterns', source);

        // ── Charts: Section C — Cross-Sell Analysis ──
        seedVis(c.id, sid, 'charts', 'cross_sell_funnel', 'Cross-Sell Funnel', 6,
          'Funnel from total appointment patients through cross-sell stages: to Other Services, Lab Tests, Both, or Appointment Only', source);
        seedVis(c.id, sid, 'charts', 'doctor_cross_sell_rate', 'Doctor Cross-Sell Rate', 7,
          'Per-doctor cross-sell percentage bar chart, sorted descending, color-coded green (high) to red (low)', source);
        seedVis(c.id, sid, 'charts', 'doctor_stacked_bar', 'Doctor Cross-Sell Breakdown', 8,
          'Stacked bar per doctor: cross-sold patients (green) vs appointment-only patients (gray) with percentage labels', source);

        // ── Tables ──
        seedVis(c.id, sid, 'tables', 'patient_summary_table', 'Patient Summary Table', 0,
          'Sortable, searchable table: Patient ID, Name, Departments Used, Total Billed, Total Paid, Discount, Number of Visits. Paginated at 50 rows.', source);
      }

      // Pharmacy-specific items (OneGlance data)
      const isPharma = nameLower.includes('pharma');
      if (isPharma) {
        // ── Purchase KPI Cards ──
        seedVis(c.id, sid, 'cards', 'pharma_total_purchase', 'Total Purchase Value', 0,
          'Sum of all purchase values from OneGlance purchase reports', source);
        seedVis(c.id, sid, 'cards', 'pharma_total_invoices', 'Total Invoices', 1,
          'Count of distinct purchase invoices', source);
        seedVis(c.id, sid, 'cards', 'pharma_unique_stockists', 'Unique Stockists', 2,
          'Number of distinct stockist/distributors', source);
        seedVis(c.id, sid, 'cards', 'pharma_unique_products', 'Unique Products', 3,
          'Number of distinct drugs/products purchased', source);
        seedVis(c.id, sid, 'cards', 'pharma_total_free_qty', 'Free Qty Received', 4,
          'Total free quantity received from stockists', source);
        seedVis(c.id, sid, 'cards', 'pharma_total_tax', 'Total Tax', 5,
          'Total purchase tax amount', source);

        // ── Sales KPI Cards ──
        seedVis(c.id, sid, 'cards', 'pharma_total_sales', 'Total Sales', 6,
          'Sum of all pharmacy sales revenue', source);
        seedVis(c.id, sid, 'cards', 'pharma_total_cogs', 'Cost of Goods', 7,
          'Total cost of goods sold', source);
        seedVis(c.id, sid, 'cards', 'pharma_total_profit', 'Total Profit', 8,
          'Total profit (Sales minus COGS)', source);
        seedVis(c.id, sid, 'cards', 'pharma_profit_margin', 'Profit Margin %', 9,
          'Overall profit margin percentage', source);
        seedVis(c.id, sid, 'cards', 'pharma_total_bills', 'Total Bills', 10,
          'Count of distinct sales bills', source);
        seedVis(c.id, sid, 'cards', 'pharma_unique_patients', 'Unique Patients', 11,
          'Number of distinct pharmacy customers', source);

        // ── Stock KPI Cards ──
        seedVis(c.id, sid, 'cards', 'pharma_stock_value', 'Total Stock Value', 12,
          'Total inventory valuation from latest snapshot', source);
        seedVis(c.id, sid, 'cards', 'pharma_stock_skus', 'Unique SKUs', 13,
          'Number of distinct stock items', source);
        seedVis(c.id, sid, 'cards', 'pharma_near_expiry', 'Near Expiry Batches', 14,
          'Batches expiring within 6 months', source);
        seedVis(c.id, sid, 'cards', 'pharma_expired_items', 'Expired Batches', 15,
          'Batches that have already expired', source);
        seedVis(c.id, sid, 'cards', 'pharma_total_batches', 'Total Batches', 16,
          'Total number of stock batches', source);

        // ── Cross-Report KPI Cards ──
        seedVis(c.id, sid, 'cards', 'pharma_cross_kpis', 'Cross-Report KPIs', 17,
          'Sell-through rate, purchased-not-sold, sold-not-purchased counts', source);

        // ── Purchase Charts ──
        seedVis(c.id, sid, 'charts', 'pharma_monthly_purchase_trend', 'Monthly Purchase Trend', 1,
          'Bar chart showing gross and net purchase values per month', source);
        seedVis(c.id, sid, 'charts', 'pharma_top_stockists', 'Top Stockists', 2,
          'Horizontal bar chart of top 10 stockists by purchase value', source);
        seedVis(c.id, sid, 'charts', 'pharma_top_manufacturers', 'Top Manufacturers', 3,
          'Horizontal bar chart of top 10 manufacturers by purchase value', source);
        seedVis(c.id, sid, 'charts', 'pharma_top_purchase_products', 'Top Purchase Products', 4,
          'Top 15 products by purchase value with progress bars', source);
        seedVis(c.id, sid, 'charts', 'pharma_profit_margin_dist', 'Profit Margin Distribution', 5,
          'Donut chart showing product count by expected profit margin bracket', source);
        seedVis(c.id, sid, 'charts', 'pharma_free_qty_analysis', 'Free Quantity Analysis', 6,
          'Stockists providing free goods with percentage of batch', source);

        // ── Sales Charts ──
        seedVis(c.id, sid, 'charts', 'pharma_monthly_sales_trend', 'Monthly Sales Trend', 7,
          'Grouped bar chart showing sales, COGS, and profit per month', source);
        seedVis(c.id, sid, 'charts', 'pharma_sales_vs_cogs', 'Sales vs COGS Line', 8,
          'Line chart comparing monthly sales and cost of goods', source);
        seedVis(c.id, sid, 'charts', 'pharma_top_drugs_sales', 'Top Drugs by Revenue', 9,
          'Top 15 drugs ranked by sales amount', source);
        seedVis(c.id, sid, 'charts', 'pharma_top_drugs_profit', 'Top Drugs by Profit', 10,
          'Top 15 drugs ranked by profit with margin percentage', source);
        seedVis(c.id, sid, 'charts', 'pharma_referral_analysis', 'Referral Analysis', 11,
          'Revenue breakdown by referral source (doctor, walk-in, etc.)', source);
        seedVis(c.id, sid, 'charts', 'pharma_top_patients', 'Top Patients by Spend', 12,
          'Top 20 pharmacy customers by total purchase amount', source);

        // ── Stock Charts ──
        seedVis(c.id, sid, 'charts', 'pharma_expiry_zones', 'Expiry Zone Distribution', 13,
          'Donut chart showing stock value by expiry timeline (expired, critical, warning, safe, long term)', source);
        seedVis(c.id, sid, 'charts', 'pharma_top_stock_products', 'Top Stock Products', 14,
          'Horizontal bar chart of products with highest inventory value', source);

        // ── Cross-Report Charts ──
        seedVis(c.id, sid, 'charts', 'pharma_purchase_vs_sales', 'Purchase vs Sales Comparison', 15,
          'Side-by-side bar chart comparing purchase and sales values per product', source);
        seedVis(c.id, sid, 'charts', 'pharma_dead_stock', 'Dead Stock Analysis', 16,
          'Products purchased but not sold, and products sold from old stock', source);

        // ── Tables ──
        seedVis(c.id, sid, 'tables', 'pharma_purchase_table', 'Purchase Details Table', 0,
          'Searchable table: Invoice, Date, Stockist, Drug, Batch Qty, Free, MRP, Purchase Value, Tax, Margin%. Paginated.', source);
        seedVis(c.id, sid, 'tables', 'pharma_sales_table', 'Sales Details Table', 1,
          'Searchable table: Bill, Date, Patient, Drug, Qty, Sales, COGS, Profit, Referred By. Paginated.', source);
        seedVis(c.id, sid, 'tables', 'pharma_stock_table', 'Stock Details Table', 2,
          'Searchable table: Drug, Batch, Received, Expiry, Avl Qty, Strips, Purchase Price, Stock Value. Paginated.', source);
      }
    }
  }
}
