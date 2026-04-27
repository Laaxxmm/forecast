import { Router } from 'express';
import { branchFilter, streamFilter } from '../utils/branch.js';

const router = Router();

router.get('/clinic', async (req, res) => {
  const db = req.tenantDb!;
  const { fy_id } = req.query;
  const bf = branchFilter(req);

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
  const bf = branchFilter(req);

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
  const bf = branchFilter(req);

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
  const bf = branchFilter(req);

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
  const bf = branchFilter(req);
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

export default router;
