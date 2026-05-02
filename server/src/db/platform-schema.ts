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

    -- Sync-agent: map each Tally data file (company) to a (branch, stream)
    -- pair for a client. Slice 4 — gives the operator full manual control
    -- over attribution. Nullable FKs allow partial mappings (picked branch
    -- but not yet stream, etc.); SET NULL on branch/stream delete so the
    -- row survives and shows an "unmapped" badge in the agent UI.
    CREATE TABLE IF NOT EXISTS vcfo_company_mapping (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      tally_company_name TEXT NOT NULL,
      branch_id INTEGER REFERENCES branches(id) ON DELETE SET NULL,
      stream_id INTEGER REFERENCES business_streams(id) ON DELETE SET NULL,
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(client_id, tally_company_name)
    );
    CREATE INDEX IF NOT EXISTS idx_vcm_client ON vcfo_company_mapping(client_id);

    -- Sync-agent authentication keys (Slice 5a — rehomed from TallyVision's
    -- vcfo_agent_keys so all auth state lives in platform.db). Each desktop
    -- agent install authenticates with an opaque Bearer token of the form
    -- "vcfo_live_" + 40 hex chars; only the SHA-256 hash is persisted so a
    -- DB leak does not expose usable credentials. The FK to clients keeps
    -- cross-tenant isolation tight (one key maps to one client), and
    -- ON DELETE CASCADE means deactivating a client auto-revokes its keys.
    CREATE TABLE IF NOT EXISTS agent_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      client_slug TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      key_prefix TEXT NOT NULL,
      label TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      last_used_at TEXT,
      revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_agent_keys_hash ON agent_keys(key_hash);
    CREATE INDEX IF NOT EXISTS idx_agent_keys_client ON agent_keys(client_id);
  `);

  // One-time migration: copy legacy TallyVision `vcfo_agent_keys` rows (if the
  // table exists in this platform.db from the pre-Slice-5 era) into the new
  // `agent_keys` table. Idempotent — rows already migrated are skipped by the
  // UNIQUE(key_hash) constraint. TallyVision's own table is left in place so
  // the existing sub-app keeps working until cutover; the rows are just
  // duplicated here so the new middleware can authenticate the same keys.
  try {
    const legacyTable = db.get(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='vcfo_agent_keys'"
    );
    if (legacyTable) {
      const legacyRows = db.all(
        `SELECT key_hash, key_prefix, client_slug, label, created_at, last_used_at, revoked_at
         FROM vcfo_agent_keys`
      );
      for (const r of legacyRows) {
        const client = db.get('SELECT id FROM clients WHERE slug = ?', r.client_slug);
        if (!client) continue; // orphan row — skip
        db.run(
          `INSERT OR IGNORE INTO agent_keys
             (client_id, client_slug, key_hash, key_prefix, label, created_at, last_used_at, revoked_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [client.id, r.client_slug, r.key_hash, r.key_prefix, r.label || '', r.created_at, r.last_used_at, r.revoked_at],
        );
      }
      if (legacyRows.length > 0) {
        console.log(`[Platform Migration] Copied ${legacyRows.length} row(s) from vcfo_agent_keys → agent_keys`);
      }
    }
  } catch (e: any) {
    console.warn('[Platform Migration] vcfo_agent_keys → agent_keys copy skipped:', e?.message || e);
  }

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

  // Backfill / refresh dashboard_chart_visibility for existing clients.
  // Upsert on (client_id, scope, section, element_key): if a row already
  // exists we update label/description/sort_order/source so renames in
  // the seed flow through to existing tenants on next boot, but we
  // deliberately preserve `is_visible` so the admin's manual toggles
  // aren't reset every restart.
  const seedVis = (clientId: number, scope: string, section: string, key: string, label: string, order: number, desc = '', source = '') => {
    db.run(
      `INSERT INTO dashboard_chart_visibility (client_id, scope, section, element_key, element_label, sort_order, description, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(client_id, scope, section, element_key) DO UPDATE SET
         element_label = excluded.element_label,
         sort_order = excluded.sort_order,
         description = excluded.description,
         source = excluded.source`,
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

      // Clinic-specific items (Healthplix data).
      // The /actuals dashboard was redesigned to consolidate 7 KPI cards
      // and 8 chart cards into a tighter set: 5 Volume + 4 Value KPIs,
      // 3 consolidated chart cards, and 1 table. We delete the legacy
      // toggle rows on each boot so the admin dashboard customiser
      // stays in sync with what the page actually renders. Idempotent:
      // re-runs are no-ops because the rows are already gone.
      if (isClinic) {
        const DEPRECATED_CLINIC_KEYS = [
          'direct_lab_walkins', 'direct_other_walkins', 'repeat_visits',
          'department_overlap', 'patient_dept_donut', 'dept_combination_bars',
          'revenue_per_patient', 'cross_sell_funnel', 'patient_flow_sankey',
          'doctor_cross_sell_rate', 'doctor_stacked_bar',
        ];
        for (const k of DEPRECATED_CLINIC_KEYS) {
          db.run(
            `DELETE FROM dashboard_chart_visibility
              WHERE client_id = ? AND scope = ? AND element_key = ?`,
            [c.id, sid, k]
          );
        }

        // ── KPI Cards: Volume row ──
        seedVis(c.id, sid, 'cards', 'total_unique_patients', 'Unique Patients', 0,
          'Distinct patients across all departments', source);
        seedVis(c.id, sid, 'cards', 'appointment_patients', 'Appointments', 1,
          'Encounter count for appointment visits', source);
        seedVis(c.id, sid, 'cards', 'lab_test_patients', 'Lab Tests', 2,
          'Encounter count for lab tests', source);
        seedVis(c.id, sid, 'cards', 'other_services_patients', 'Other Services', 3,
          'Encounter count for other services', source);
        seedVis(c.id, sid, 'cards', 'walkins_repeat', 'Walk-ins · Repeat', 4,
          'Combined direct walk-ins (lab + other) alongside repeat-visit count', source);

        // ── KPI Cards: Value row ──
        seedVis(c.id, sid, 'cards', 'total_revenue', 'Total Revenue', 5,
          'Sum of paid amount across all patients in the period', source);
        seedVis(c.id, sid, 'cards', 'revenue_per_patient_kpi', 'Revenue per Patient', 6,
          'Total revenue divided by unique patients', source);
        seedVis(c.id, sid, 'cards', 'cross_sell_rate', 'Cross-Sell Rate', 7,
          'Appointment patients with cross-sell divided by all appointment patients', source);
        seedVis(c.id, sid, 'cards', 'multi_dept_share', 'Multi-Dept Share', 8,
          'Share of patients who visited 2 or more departments', source);

        // ── Charts (consolidated) ──
        seedVis(c.id, sid, 'charts', 'cross_sell_hero', 'Why cross-sell matters', 1,
          'Hero card showing average revenue per patient by departments visited (1 / 2 / 3 Depts) with multipliers', source);
        seedVis(c.id, sid, 'charts', 'appointment_flow', 'Where appointment patients went next', 2,
          'Cross-sell breakdown for appointment patients (Appt only / + Lab / + Lab + Other / + Other) with revenue split', source);
        seedVis(c.id, sid, 'charts', 'doctor_performance', 'Doctor performance', 3,
          'Per-doctor cross-sell rate plus patient mix (cross-sold vs appointment-only) on a single row', source);

        // ── Tables ──
        seedVis(c.id, sid, 'tables', 'patient_summary_table', 'Top patients by revenue', 0,
          'Top 5 patients sorted by paid amount with full search across all patients', source);
      }

      // Pharmacy-specific items (OneGlance data)
      const isPharma = nameLower.includes('pharma');
      if (isPharma) {
        // The Stock & Expiry tab redesign drops three KPI cards
        // (Unique SKUs, Near Expiry, Total Batches) and the donut
        // chart (`pharma_expiry_zones`) in favour of a tighter
        // 4-card strip + alert callout + stacked-bar breakdown.
        // Idempotent: re-runs are no-ops because the rows are gone.
        const DEPRECATED_PHARMA_STOCK_KEYS = [
          'pharma_stock_value',   // renamed → pharma_live_stock_value
          'pharma_stock_skus',    // folded into Live stock value sub-line
          'pharma_near_expiry',   // replaced by pharma_at_risk_stock
          'pharma_total_batches', // dropped (was misleading — included expired)
          'pharma_expiry_zones',  // donut replaced by stacked-bar breakdown card
        ];
        for (const k of DEPRECATED_PHARMA_STOCK_KEYS) {
          db.run(
            `DELETE FROM dashboard_chart_visibility
              WHERE client_id = ? AND scope = ? AND element_key = ?`,
            [c.id, sid, k]
          );
        }

        // ── Purchase KPI Cards ──
        // Layout: 5 tinted KPI cards. The "Total Tax" toggle no longer renders
        // its own card — it now controls the "incl. ₹X tax" sub-line shown
        // under "Total purchase".
        seedVis(c.id, sid, 'cards', 'pharma_total_purchase', 'Total Purchase', 0,
          'Sum of all purchase values from OneGlance purchase reports. Sub-line shows tax when "Total Tax" is also enabled.', source);
        seedVis(c.id, sid, 'cards', 'pharma_total_invoices', 'Invoices', 1,
          'Count of distinct purchase invoices. Sub-line shows average invoice value (total purchase ÷ invoice count).', source);
        seedVis(c.id, sid, 'cards', 'pharma_unique_stockists', 'Stockists', 2,
          'Number of distinct stockist/distributors (active suppliers).', source);
        seedVis(c.id, sid, 'cards', 'pharma_unique_products', 'Products', 3,
          'Number of distinct drugs/products purchased (unique SKUs).', source);
        seedVis(c.id, sid, 'cards', 'pharma_total_free_qty', 'Free Quantity', 4,
          'Total free units received this period. Sub-line shows how many stockists provided free goods.', source);
        seedVis(c.id, sid, 'cards', 'pharma_total_tax', 'Tax sub-line on Total Purchase', 5,
          'Toggles the "incl. ₹X tax" annotation under the Total Purchase card. No standalone tax card is rendered.', source);

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
        // The Stock & Expiry tab redesign collapses the 5-card strip
        // (Total Stock Value / Unique SKUs / Near Expiry / Expired
        // Batches / Total Batches) into a 4-card strip framed around
        // live-vs-expired and healthy-vs-at-risk. The dropped keys
        // (pharma_stock_skus, pharma_near_expiry, pharma_total_batches)
        // are deleted on next boot via the cleanup pass below so the
        // admin customiser stays in sync.
        seedVis(c.id, sid, 'cards', 'pharma_live_stock_value', 'Live stock value', 12,
          'Sellable stock value across non-expired batches. Sub-line shows sellable batch count and SKU count.', source);
        seedVis(c.id, sid, 'cards', 'pharma_healthy_stock', 'Healthy stock', 13,
          'Stock value expiring 6 months or more out (Safe + Long term zones).', source);
        seedVis(c.id, sid, 'cards', 'pharma_at_risk_stock', 'At-risk stock', 14,
          'Stock value expiring within 6 months (Critical 0–3m + Warning 3–6m).', source);
        seedVis(c.id, sid, 'cards', 'pharma_expired_items', 'Already expired', 15,
          'Batch count and value already past expiry — written off, surfaced for data-hygiene visibility.', source);

        // ── Cross-Report KPI Cards ──
        seedVis(c.id, sid, 'cards', 'pharma_cross_kpis', 'Cross-Report KPIs', 17,
          'Sell-through rate, purchased-not-sold, sold-not-purchased counts', source);

        // ── Purchase Charts ──
        // The Purchases tab consolidates the old six charts into three cards:
        //   • Sourcing card — driven by `pharma_top_stockists` + `pharma_top_manufacturers`
        //   • Free-quantity callout banner — driven by `pharma_free_qty_analysis`
        //   • Top products card — driven by `pharma_top_purchase_products` + `pharma_profit_margin_dist`
        // The monthly trend only renders when the period spans 3+ months.
        seedVis(c.id, sid, 'charts', 'pharma_monthly_purchase_trend', 'Monthly Purchase Trend', 1,
          'Bar chart of gross and net purchase per month. Only renders when the selected period spans 3+ months — single-month periods hide the chart automatically.', source);
        seedVis(c.id, sid, 'charts', 'pharma_top_stockists', 'Stockists list (Sourcing card)', 2,
          'Stockist list inside the "Where the money is going" sourcing card with progress bars and free-qty annotations.', source);
        seedVis(c.id, sid, 'charts', 'pharma_top_manufacturers', 'Manufacturers list (Sourcing card)', 3,
          'Top manufacturers list inside the "Where the money is going" sourcing card. Top 5 visible by default with a "view all" toggle.', source);
        seedVis(c.id, sid, 'charts', 'pharma_top_purchase_products', 'Top Products list', 4,
          'Top products inside the "Top products by purchase value" card, with margin pill per row.', source);
        seedVis(c.id, sid, 'charts', 'pharma_profit_margin_dist', 'Margin Distribution Bar', 5,
          'Horizontal stacked bar above the products list, showing margin-bracket split across all products.', source);
        seedVis(c.id, sid, 'charts', 'pharma_free_qty_analysis', 'Free Quantity Callout', 6,
          'Soft-green banner under the sourcing card surfacing total rupee value of free goods received and the top stockist providing them.', source);

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
        // The Stock & Expiry tab redesign replaces the donut chart and
        // long legend with a stacked-bar breakdown card, adds an
        // expired-batch alert callout for data-hygiene visibility, and
        // promotes critical-batch action items out of the table into a
        // dedicated card. The deprecated `pharma_expiry_zones` key is
        // deleted via the cleanup pass below.
        seedVis(c.id, sid, 'charts', 'pharma_expired_alert', 'Expired batches alert', 13,
          'Red callout banner that appears when 5%+ of all batches on file have crossed their expiry date. Reframes the figure as a likely data-hygiene issue.', source);
        seedVis(c.id, sid, 'charts', 'pharma_expiry_breakdown', 'When your stock will expire', 14,
          'Horizontal stacked-bar card showing live stock value split across the four sellable expiry zones, with detail tiles per zone.', source);
        seedVis(c.id, sid, 'charts', 'pharma_critical_batches', 'Expires within 3 months — act now', 15,
          'Top 6 batches expiring within 90 days, ranked by stock value, with days-to-expiry pills.', source);
        seedVis(c.id, sid, 'charts', 'pharma_top_stock_products', 'Top products by stock value', 16,
          'Top 7 products by stock value with earliest-expiry pill colour-coded by safety zone (red/amber/green/blue).', source);

        // ── Cross-Report Charts ──
        seedVis(c.id, sid, 'charts', 'pharma_purchase_vs_sales', 'Purchase vs Sales Comparison', 15,
          'Side-by-side bar chart comparing purchase and sales values per product', source);
        seedVis(c.id, sid, 'charts', 'pharma_dead_stock', 'Dead Stock Analysis', 16,
          'Products purchased but not sold, and products sold from old stock', source);

        // ── Tables ──
        seedVis(c.id, sid, 'tables', 'pharma_purchase_table', 'Purchase Details Table', 0,
          'Searchable table: Invoice, Date, Stockist, Drug, Batch Qty, Purchase Value, Tax, Margin. Free-qty rows are tinted green; rows are paginated at 10.', source);
        seedVis(c.id, sid, 'tables', 'pharma_sales_table', 'Sales Details Table', 1,
          'Searchable table: Bill, Date, Patient, Drug, Qty, Sales, COGS, Profit, Referred By. Paginated.', source);
        seedVis(c.id, sid, 'tables', 'pharma_stock_table', 'Stock details', 2,
          'Searchable table of sellable items (expired hidden by default) with at-risk row tinting, Critical-only quick filter, and download. Strips column dropped.', source);
      }
    }
  }

  // ── Pharmacy Purchases tab — May 2026 redesign label refresh ────────────
  // seedVis() above uses INSERT OR IGNORE and so will not update labels or
  // descriptions on rows that already exist for legacy clients. The
  // dashboard customiser reads element_label + description directly from
  // these rows, so we reconcile them here. Idempotent — safe to re-run.
  const PHARMA_PURCHASE_LABEL_REFRESH: Array<[string, string, string]> = [
    ['pharma_total_purchase',
      'Total Purchase',
      'Sum of all purchase values from OneGlance purchase reports. Sub-line shows tax when "Total Tax" is also enabled.'],
    ['pharma_total_invoices',
      'Invoices',
      'Count of distinct purchase invoices. Sub-line shows average invoice value (total purchase ÷ invoice count).'],
    ['pharma_unique_stockists',
      'Stockists',
      'Number of distinct stockist/distributors (active suppliers).'],
    ['pharma_unique_products',
      'Products',
      'Number of distinct drugs/products purchased (unique SKUs).'],
    ['pharma_total_free_qty',
      'Free Quantity',
      'Total free units received this period. Sub-line shows how many stockists provided free goods.'],
    ['pharma_total_tax',
      'Tax sub-line on Total Purchase',
      'Toggles the "incl. ₹X tax" annotation under the Total Purchase card. No standalone tax card is rendered.'],
    ['pharma_monthly_purchase_trend',
      'Monthly Purchase Trend',
      'Bar chart of gross and net purchase per month. Only renders when the selected period spans 3+ months — single-month periods hide the chart automatically.'],
    ['pharma_top_stockists',
      'Stockists list (Sourcing card)',
      'Stockist list inside the "Where the money is going" sourcing card with progress bars and free-qty annotations.'],
    ['pharma_top_manufacturers',
      'Manufacturers list (Sourcing card)',
      'Top manufacturers list inside the "Where the money is going" sourcing card. Top 5 visible by default with a "view all" toggle.'],
    ['pharma_top_purchase_products',
      'Top Products list',
      'Top products inside the "Top products by purchase value" card, with margin pill per row.'],
    ['pharma_profit_margin_dist',
      'Margin Distribution Bar',
      'Horizontal stacked bar above the products list, showing margin-bracket split across all products.'],
    ['pharma_free_qty_analysis',
      'Free Quantity Callout',
      'Soft-green banner under the sourcing card surfacing total rupee value of free goods received and the top stockist providing them.'],
    ['pharma_purchase_table',
      'Purchase Details Table',
      'Searchable table: Invoice, Date, Stockist, Drug, Batch Qty, Purchase Value, Tax, Margin. Free-qty rows are tinted green; rows are paginated at 10.'],
  ];
  for (const [key, label, desc] of PHARMA_PURCHASE_LABEL_REFRESH) {
    try {
      db.run(
        `UPDATE dashboard_chart_visibility
            SET element_label = ?, description = ?
          WHERE element_key = ?`,
        label, desc, key,
      );
    } catch { /* table missing on a freshly created DB — seedVis already covers it */ }
  }
}
