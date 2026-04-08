import { Router } from 'express';
import { branchFilter } from '../utils/branch.js';

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
      res.json(db.all(
        `SELECT bill_month, SUM(transactions) as transactions, SUM(total_qty) as total_qty,
          SUM(total_sales) as total_sales, SUM(total_purchase_cost) as total_purchase_cost,
          SUM(total_profit) as total_profit,
          CASE WHEN SUM(total_sales) > 0 THEN ROUND(SUM(total_profit) * 100.0 / SUM(total_sales), 2) ELSE 0 END as profit_margin_pct,
          SUM(total_sales_tax) as total_sales_tax
        FROM pharmacy_monthly_summary WHERE bill_month >= ? AND bill_month <= ?${bf.where}
        GROUP BY bill_month ORDER BY bill_month`,
        fy.start_date.slice(0, 7), fy.end_date.slice(0, 7), ...bf.params
      ));
      return;
    }
  }
  res.json(db.all(
    `SELECT bill_month, SUM(transactions) as transactions, SUM(total_qty) as total_qty,
      SUM(total_sales) as total_sales, SUM(total_purchase_cost) as total_purchase_cost,
      SUM(total_profit) as total_profit,
      CASE WHEN SUM(total_sales) > 0 THEN ROUND(SUM(total_profit) * 100.0 / SUM(total_sales), 2) ELSE 0 END as profit_margin_pct,
      SUM(total_sales_tax) as total_sales_tax
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

export default router;
