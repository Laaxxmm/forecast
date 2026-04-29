import { Router } from 'express';
import { branchFilter, streamFilter } from '../utils/branch.js';

const router = Router();

router.get('/clinic', async (req, res) => {
  const db = req.tenantDb!;
  const { fy_id } = req.query;
  // Strict isolation: each branch sees only its own actuals. NULL-branch
  // legacy rows (pre-multi-branch / consolidated-mode imports) are
  // hidden until reassigned via POST /actuals/migrate-orphans.
  const bf = branchFilter(req, { strict: true });

  if (fy_id) {
    const fy = db.get('SELECT * FROM financial_years WHERE id = ?', fy_id);
    if (fy) {
      res.json(db.all(
        `SELECT bill_month, department, SUM(transaction_count) as transaction_count,
          SUM(unique_patients) as unique_patients, SUM(total_revenue) as total_revenue,
          SUM(total_discount) as total_discount, SUM(total_tax) as total_tax
        FROM clinic_monthly_summary WHERE bill_month >= ? AND bill_month <= ?${bf.where}
        GROUP BY bill_month, department ORDER BY bill_month, department`,
        fy.start_date.slice(0, 7), fy.end_date.slice(0, 7), ...bf.params
      ));
      return;
    }
  }
  res.json(db.all(
    `SELECT bill_month, department, SUM(transaction_count) as transaction_count,
      SUM(unique_patients) as unique_patients, SUM(total_revenue) as total_revenue,
      SUM(total_discount) as total_discount, SUM(total_tax) as total_tax
    FROM clinic_monthly_summary WHERE 1=1${bf.where}
    GROUP BY bill_month, department ORDER BY bill_month, department`,
    ...bf.params
  ));
});

router.get('/clinic/doctors', async (req, res) => {
  const db = req.tenantDb!;
  const { fy_id, month } = req.query;
  // Strict isolation: each branch sees only its own actuals. NULL-branch
  // legacy rows (pre-multi-branch / consolidated-mode imports) are
  // hidden until reassigned via POST /actuals/migrate-orphans.
  const bf = branchFilter(req, { strict: true });

  if (month) {
    return res.json(db.all(
      `SELECT bill_month, billed_doctor, department, SUM(transaction_count) as transaction_count,
        SUM(total_revenue) as total_revenue
      FROM clinic_doctor_summary WHERE bill_month = ?${bf.where}
      GROUP BY bill_month, billed_doctor, department ORDER BY total_revenue DESC`,
      month, ...bf.params
    ));
  } else if (fy_id) {
    const fy = db.get('SELECT * FROM financial_years WHERE id = ?', fy_id);
    if (fy) {
      res.json(db.all(
        `SELECT bill_month, billed_doctor, department, SUM(transaction_count) as transaction_count,
          SUM(total_revenue) as total_revenue
        FROM clinic_doctor_summary WHERE bill_month >= ? AND bill_month <= ?${bf.where}
        GROUP BY bill_month, billed_doctor, department ORDER BY total_revenue DESC`,
        fy.start_date.slice(0, 7), fy.end_date.slice(0, 7), ...bf.params
      ));
      return;
    }
  }
  res.json(db.all(
    `SELECT bill_month, billed_doctor, department, SUM(transaction_count) as transaction_count,
      SUM(total_revenue) as total_revenue
    FROM clinic_doctor_summary WHERE 1=1${bf.where}
    GROUP BY bill_month, billed_doctor, department ORDER BY total_revenue DESC`,
    ...bf.params
  ));
});

router.get('/pharmacy', async (req, res) => {
  const db = req.tenantDb!;
  const { fy_id } = req.query;
  // Strict isolation: each branch sees only its own actuals. NULL-branch
  // legacy rows (pre-multi-branch / consolidated-mode imports) are
  // hidden until reassigned via POST /actuals/migrate-orphans.
  const bf = branchFilter(req, { strict: true });

  if (fy_id) {
    const fy = db.get('SELECT * FROM financial_years WHERE id = ?', fy_id);
    if (fy) {
      // profit_margin_pct denominator is Net Sales (ex-GST) — gross sales would
      // understate margin because the GST sitting inside the price isn't ours.
      res.json(db.all(
        `SELECT bill_month, SUM(transactions) as transactions, SUM(total_qty) as total_qty,
          SUM(total_sales) as total_sales,
          SUM(total_net_sales) as total_net_sales,
          SUM(total_purchase_cost) as total_purchase_cost,
          SUM(total_profit) as total_profit,
          CASE WHEN SUM(total_net_sales) > 0
            THEN ROUND(SUM(total_profit) * 100.0 / SUM(total_net_sales), 2)
            ELSE 0
          END as profit_margin_pct,
          SUM(total_sales_tax) as total_sales_tax,
          SUM(reported_profit) as reported_profit
        FROM pharmacy_monthly_summary WHERE bill_month >= ? AND bill_month <= ?${bf.where}
        GROUP BY bill_month ORDER BY bill_month`,
        fy.start_date.slice(0, 7), fy.end_date.slice(0, 7), ...bf.params
      ));
      return;
    }
  }
  res.json(db.all(
    `SELECT bill_month, SUM(transactions) as transactions, SUM(total_qty) as total_qty,
      SUM(total_sales) as total_sales,
      SUM(total_net_sales) as total_net_sales,
      SUM(total_purchase_cost) as total_purchase_cost,
      SUM(total_profit) as total_profit,
      CASE WHEN SUM(total_net_sales) > 0
        THEN ROUND(SUM(total_profit) * 100.0 / SUM(total_net_sales), 2)
        ELSE 0
      END as profit_margin_pct,
      SUM(total_sales_tax) as total_sales_tax,
      SUM(reported_profit) as reported_profit
    FROM pharmacy_monthly_summary WHERE 1=1${bf.where}
    GROUP BY bill_month ORDER BY bill_month`,
    ...bf.params
  ));
});

router.get('/pharmacy/purchases', async (req, res) => {
  const db = req.tenantDb!;
  const { fy_id } = req.query;
  // Strict isolation: each branch sees only its own actuals. NULL-branch
  // legacy rows (pre-multi-branch / consolidated-mode imports) are
  // hidden until reassigned via POST /actuals/migrate-orphans.
  const bf = branchFilter(req, { strict: true });

  if (fy_id) {
    const fy = db.get('SELECT * FROM financial_years WHERE id = ?', fy_id);
    if (fy) {
      res.json(db.all(
        `SELECT invoice_month, SUM(invoice_count) as invoice_count, SUM(total_qty) as total_qty,
          SUM(total_purchase_value) as total_purchase_value, SUM(total_net_purchase) as total_net_purchase,
          SUM(total_tax) as total_tax, SUM(expected_sales_value) as expected_sales_value,
          SUM(expected_profit) as expected_profit
        FROM pharmacy_purchase_monthly_summary WHERE invoice_month >= ? AND invoice_month <= ?${bf.where}
        GROUP BY invoice_month ORDER BY invoice_month`,
        fy.start_date.slice(0, 7), fy.end_date.slice(0, 7), ...bf.params
      ));
      return;
    }
  }
  res.json(db.all(
    `SELECT invoice_month, SUM(invoice_count) as invoice_count, SUM(total_qty) as total_qty,
      SUM(total_purchase_value) as total_purchase_value, SUM(total_net_purchase) as total_net_purchase,
      SUM(total_tax) as total_tax, SUM(expected_sales_value) as expected_sales_value,
      SUM(expected_profit) as expected_profit
    FROM pharmacy_purchase_monthly_summary WHERE 1=1${bf.where}
    GROUP BY invoice_month ORDER BY invoice_month`,
    ...bf.params
  ));
});

// Generic stream summary — returns monthly actuals from dashboard_actuals for any stream
router.get('/stream/:streamId/summary', async (req, res) => {
  const db = req.tenantDb!;
  const { fy_id, scenario_id } = req.query;
  // Strict isolation: each branch sees only its own actuals. NULL-branch
  // legacy rows (pre-multi-branch / consolidated-mode imports) are
  // hidden until reassigned via POST /actuals/migrate-orphans.
  const bf = branchFilter(req, { strict: true });
  const sid = parseInt(req.params.streamId);

  let scenarioId = scenario_id;
  if (!scenarioId && fy_id) {
    const scenario = db.get(
      `SELECT id FROM scenarios WHERE fy_id = ? AND is_default = 1${bf.where} LIMIT 1`,
      fy_id, ...bf.params
    );
    scenarioId = scenario?.id;
  }
  if (!scenarioId) return res.json({ monthly: [], totals: {} });

  const monthly = db.all(
    `SELECT month, category, item_name, COALESCE(SUM(amount), 0) as total
     FROM dashboard_actuals
     WHERE scenario_id = ? AND (stream_id = ? OR stream_id IS NULL)${bf.where}
     GROUP BY month, category, item_name
     ORDER BY month`,
    scenarioId, sid, ...bf.params
  );

  const totals = db.get(
    `SELECT COALESCE(SUM(CASE WHEN category = 'revenue' THEN amount ELSE 0 END), 0) as total_revenue,
            COALESCE(SUM(CASE WHEN category = 'direct_costs' THEN amount ELSE 0 END), 0) as total_costs,
            COUNT(DISTINCT month) as months_with_data
     FROM dashboard_actuals
     WHERE scenario_id = ? AND (stream_id = ? OR stream_id IS NULL)${bf.where}`,
    scenarioId, sid, ...bf.params
  );

  res.json({ monthly, totals });
});

// === ORPHAN ACTUALS RECOVERY ===
//
// Strict branch isolation hides every actuals row with `branch_id IS NULL`.
// For tenants who imported clinic / pharmacy data pre-multi-branch (or in
// consolidated mode) those rows still exist but are now invisible. These
// two endpoints surface them and migrate them into a chosen branch — same
// shape as /forecast-module/scenarios/orphans + migrate-orphans.

interface OrphanCounts {
  clinic_actuals:           { rows: number; revenue: number; bill_months: string[] };
  pharmacy_sales_actuals:   { rows: number; sales: number;   bill_months: string[] };
  pharmacy_purchase_actuals:{ rows: number; cost: number;    invoice_months: string[] };
  dashboard_actuals:        { rows: number; amount: number };
}

/** Read-only diagnostic. Lists how much data is parked in NULL-branch
 *  for each actuals table — what the user gets back from the loose
 *  filter that was leaking into every branch's view before strict mode. */
router.get('/orphans', async (req, res) => {
  const db = req.tenantDb!;
  if (!req.isMultiBranch) {
    return res.json({ scopeRequired: false, counts: null as OrphanCounts | null });
  }

  const clinic = db.get(
    `SELECT COUNT(*) as rows, COALESCE(SUM(item_price), 0) as revenue
       FROM clinic_actuals WHERE branch_id IS NULL`
  );
  const clinicMonths = db.all(
    `SELECT DISTINCT bill_month FROM clinic_actuals
      WHERE branch_id IS NULL AND bill_month IS NOT NULL ORDER BY bill_month`
  ).map((r: any) => r.bill_month);

  const pharma = db.get(
    `SELECT COUNT(*) as rows, COALESCE(SUM(sales_amount), 0) as sales
       FROM pharmacy_sales_actuals WHERE branch_id IS NULL`
  );
  const pharmaMonths = db.all(
    `SELECT DISTINCT bill_month FROM pharmacy_sales_actuals
      WHERE branch_id IS NULL AND bill_month IS NOT NULL ORDER BY bill_month`
  ).map((r: any) => r.bill_month);

  const purch = db.get(
    `SELECT COUNT(*) as rows, COALESCE(SUM(purchase_value), 0) as cost
       FROM pharmacy_purchase_actuals WHERE branch_id IS NULL`
  );
  const purchMonths = db.all(
    `SELECT DISTINCT invoice_month FROM pharmacy_purchase_actuals
      WHERE branch_id IS NULL AND invoice_month IS NOT NULL ORDER BY invoice_month`
  ).map((r: any) => r.invoice_month);

  const dash = db.get(
    `SELECT COUNT(*) as rows, COALESCE(SUM(amount), 0) as amount
       FROM dashboard_actuals WHERE branch_id IS NULL`
  );

  const counts: OrphanCounts = {
    clinic_actuals:            { rows: clinic?.rows || 0, revenue: clinic?.revenue || 0, bill_months: clinicMonths },
    pharmacy_sales_actuals:    { rows: pharma?.rows || 0, sales: pharma?.sales || 0,    bill_months: pharmaMonths },
    pharmacy_purchase_actuals: { rows: purch?.rows  || 0, cost:  purch?.cost  || 0,    invoice_months: purchMonths },
    dashboard_actuals:         { rows: dash?.rows   || 0, amount: dash?.amount || 0 },
  };
  const totalRows = counts.clinic_actuals.rows + counts.pharmacy_sales_actuals.rows
                  + counts.pharmacy_purchase_actuals.rows + counts.dashboard_actuals.rows;
  res.json({ scopeRequired: true, totalRows, counts });
});

/** Hard-delete every NULL-branch actuals row across all four tables.
 *  Use this when the orphan rows are confirmed junk (leaked legacy
 *  data) and you don't want them in the database at all. Destructive,
 *  no undo. Admin / super_admin only — operational_head can't delete
 *  tenant-wide data even if it's branch-less. */
router.post('/delete-orphans', async (req, res) => {
  if (req.userType !== 'super_admin' && req.session?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin or super_admin role required to delete orphan actuals' });
  }
  const db = req.tenantDb!;
  const r1 = db.run('DELETE FROM clinic_actuals            WHERE branch_id IS NULL');
  const r2 = db.run('DELETE FROM pharmacy_sales_actuals    WHERE branch_id IS NULL');
  const r3 = db.run('DELETE FROM pharmacy_purchase_actuals WHERE branch_id IS NULL');
  const r4 = db.run('DELETE FROM dashboard_actuals         WHERE branch_id IS NULL');
  res.json({
    deleted: {
      clinic_actuals:            r1.changes,
      pharmacy_sales_actuals:    r2.changes,
      pharmacy_purchase_actuals: r3.changes,
      dashboard_actuals:         r4.changes,
    },
    totalRowsDeleted: r1.changes + r2.changes + r3.changes + r4.changes,
  });
});

/** Reassign every NULL-branch actuals row to `targetBranchId`. After this
 *  the rows show up only on the target branch's view. Idempotent. Admin /
 *  super_admin can target any branch; ops_head must target a branch they
 *  own (mirrors the forecast orphan-migration auth check). */
router.post('/migrate-orphans', async (req, res) => {
  // Same auth gate as the forecast version. Op-heads should not be able
  // to silently absorb the tenant's company-level data into their branch.
  if (req.userType !== 'super_admin' && req.session?.role !== 'admin' && req.session?.role !== 'operational_head') {
    return res.status(403).json({ error: 'Write access required' });
  }
  const targetBranchId = Number(req.body?.targetBranchId);
  if (!Number.isFinite(targetBranchId) || targetBranchId <= 0) {
    return res.status(400).json({ error: 'targetBranchId required (positive integer)' });
  }
  const isPrivileged = req.userType === 'super_admin' || req.session?.role === 'admin';
  if (!isPrivileged && !req.allowedBranchIds?.includes(targetBranchId)) {
    return res.status(403).json({ error: 'Cannot migrate orphans to a branch you do not own' });
  }

  const db = req.tenantDb!;
  const r1 = db.run('UPDATE clinic_actuals            SET branch_id = ? WHERE branch_id IS NULL', targetBranchId);
  const r2 = db.run('UPDATE pharmacy_sales_actuals    SET branch_id = ? WHERE branch_id IS NULL', targetBranchId);
  const r3 = db.run('UPDATE pharmacy_purchase_actuals SET branch_id = ? WHERE branch_id IS NULL', targetBranchId);
  const r4 = db.run('UPDATE dashboard_actuals         SET branch_id = ? WHERE branch_id IS NULL', targetBranchId);

  res.json({
    targetBranchId,
    migrated: {
      clinic_actuals:            r1.changes,
      pharmacy_sales_actuals:    r2.changes,
      pharmacy_purchase_actuals: r3.changes,
      dashboard_actuals:         r4.changes,
    },
    totalRowsMigrated: r1.changes + r2.changes + r3.changes + r4.changes,
  });
});

export default router;
