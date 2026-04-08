import { Router } from 'express';
import { branchFilter } from '../utils/branch.js';

const router = Router();

router.get('/overview', async (req, res) => {
  const db = req.tenantDb!;
  const { fy_id } = req.query;
  const bf = branchFilter(req);
  const fy = fy_id
    ? db.get('SELECT * FROM financial_years WHERE id = ?', fy_id)
    : db.get('SELECT * FROM financial_years WHERE is_active = 1');

  if (!fy) return res.json({ fy: null, clinic: {}, pharmacy: {}, combined: { total_revenue: 0, total_budget: 0 } });

  const startMonth = fy.start_date.slice(0, 7);
  const endMonth = fy.end_date.slice(0, 7);

  const clinicSummary = db.get(
    `SELECT COUNT(*) as total_transactions, COUNT(DISTINCT patient_id) as unique_patients,
      COALESCE(SUM(item_price), 0) as total_revenue, COALESCE(SUM(discount), 0) as total_discount
    FROM clinic_actuals WHERE bill_month >= ? AND bill_month <= ?${bf.where}`,
    startMonth, endMonth, ...bf.params
  ) || { total_transactions: 0, unique_patients: 0, total_revenue: 0, total_discount: 0 };

  const clinicByDept = db.all(
    `SELECT bill_month, department, COUNT(*) as transaction_count, COUNT(DISTINCT patient_id) as unique_patients,
      COALESCE(SUM(item_price), 0) as total_revenue, COALESCE(SUM(discount), 0) as total_discount,
      COALESCE(SUM(tax), 0) as total_tax
    FROM clinic_actuals WHERE bill_month >= ? AND bill_month <= ?${bf.where}
    GROUP BY bill_month, department ORDER BY bill_month, department`,
    startMonth, endMonth, ...bf.params
  );

  const pharmaSummary = db.get(
    `SELECT COUNT(DISTINCT bill_no) as total_transactions, COALESCE(SUM(qty), 0) as total_qty,
      COALESCE(SUM(sales_amount), 0) as total_sales, COALESCE(SUM(purchase_amount), 0) as total_purchase_cost,
      COALESCE(SUM(profit), 0) as total_profit
    FROM pharmacy_sales_actuals WHERE bill_month >= ? AND bill_month <= ?${bf.where}`,
    startMonth, endMonth, ...bf.params
  ) || { total_transactions: 0, total_qty: 0, total_sales: 0, total_purchase_cost: 0, total_profit: 0 };

  const pharmaMonthly = db.all(
    `SELECT bill_month, COUNT(DISTINCT bill_no) as transactions, COALESCE(SUM(qty), 0) as total_qty,
      COALESCE(SUM(sales_amount), 0) as total_sales, COALESCE(SUM(purchase_amount), 0) as total_purchase_cost,
      COALESCE(SUM(profit), 0) as total_profit,
      CASE WHEN SUM(sales_amount) > 0 THEN ROUND(SUM(profit) * 100.0 / SUM(sales_amount), 2) ELSE 0 END as profit_margin_pct,
      COALESCE(SUM(sales_tax), 0) as total_sales_tax
    FROM pharmacy_sales_actuals WHERE bill_month >= ? AND bill_month <= ?${bf.where}
    GROUP BY bill_month ORDER BY bill_month`,
    startMonth, endMonth, ...bf.params
  );

  const clinicBudget = db.get(
    `SELECT COALESCE(SUM(amount), 0) as total FROM budgets WHERE fy_id = ? AND business_unit = 'CLINIC' AND metric = 'revenue'${bf.where}`,
    fy.id, ...bf.params
  );
  const pharmaBudget = db.get(
    `SELECT COALESCE(SUM(amount), 0) as total FROM budgets WHERE fy_id = ? AND business_unit = 'PHARMACY' AND metric = 'sales_amount'${bf.where}`,
    fy.id, ...bf.params
  );

  res.json({
    fy,
    clinic: { ...clinicSummary, budget_total: clinicBudget?.total || 0, monthly: clinicByDept },
    pharmacy: {
      ...pharmaSummary,
      profit_margin: pharmaSummary.total_sales > 0
        ? ((pharmaSummary.total_profit / pharmaSummary.total_sales) * 100).toFixed(2) : 0,
      budget_total: pharmaBudget?.total || 0,
      monthly: pharmaMonthly,
    },
    combined: {
      total_revenue: (clinicSummary.total_revenue || 0) + (pharmaSummary.total_sales || 0),
      total_budget: (clinicBudget?.total || 0) + (pharmaBudget?.total || 0),
    },
  });
});

router.get('/variance', async (req, res) => {
  const db = req.tenantDb!;
  const { fy_id, business_unit } = req.query;
  const bf = branchFilter(req);
  if (!fy_id) return res.status(400).json({ error: 'fy_id required' });

  const fy = db.get('SELECT * FROM financial_years WHERE id = ?', fy_id);
  if (!fy) return res.json([]);

  const startMonth = fy.start_date.slice(0, 7);
  const endMonth = fy.end_date.slice(0, 7);

  // Build budget rows from forecast module (scenarios → forecast_items → meta.stepValues)
  // Find the default scenario for this FY (branch-scoped if applicable)
  const scenario = db.get(
    `SELECT id FROM scenarios WHERE fy_id = ? AND is_default = 1${bf.where} LIMIT 1`,
    fy_id, ...bf.params
  );

  let budgetRows: any[] = [];

  if (scenario) {
    // Get revenue forecast items for this scenario
    const revenueItems = db.all(
      "SELECT * FROM forecast_items WHERE scenario_id = ? AND category = 'revenue'",
      scenario.id
    );

    // Generate 12 months for the FY
    const months: string[] = [];
    const [startY, startM] = fy.start_date.split('-').map(Number);
    for (let i = 0; i < 12; i++) {
      const m = ((startM - 1 + i) % 12) + 1;
      const y = startY + Math.floor((startM - 1 + i) / 12);
      months.push(`${y}-${String(m).padStart(2, '0')}`);
    }

    // For each revenue item, extract monthly budget amounts from meta.stepValues
    for (const item of revenueItems) {
      const meta = typeof item.meta === 'string' ? JSON.parse(item.meta) : item.meta;
      const stepValues = meta?.stepValues || {};

      for (const month of months) {
        let budgetAmount = 0;

        if (item.item_type === 'unit_sales') {
          // Revenue = units × price
          const units = stepValues.units?.[month] || 0;
          const price = stepValues.prices?.[month] || 0;
          budgetAmount = units * price;
        } else if (item.item_type === 'recurring') {
          budgetAmount = stepValues.amount?.[month] || 0;
        } else {
          // Fallback: look for any amount-like step
          const amountKey = Object.keys(stepValues).find(k => stepValues[k]?.[month] !== undefined);
          budgetAmount = amountKey ? (stepValues[amountKey][month] || 0) : 0;
        }

        if (budgetAmount > 0) {
          budgetRows.push({
            month,
            metric: 'revenue',
            business_unit: 'CLINIC',
            dept_name: null,
            amount: budgetAmount,
            item_name: item.name,
          });
        }
      }
    }
  }

  // Also check old budgets table as fallback
  if (budgetRows.length === 0) {
    const oldBudgets = business_unit
      ? db.all(
          `SELECT b.*, d.name as dept_name FROM budgets b LEFT JOIN departments d ON b.department_id = d.id
           WHERE b.fy_id = ? AND b.business_unit = ?${bf.where} ORDER BY b.month`,
          fy_id, business_unit, ...bf.params
        )
      : db.all(
          `SELECT b.*, d.name as dept_name FROM budgets b LEFT JOIN departments d ON b.department_id = d.id
           WHERE b.fy_id = ?${bf.where} ORDER BY b.month`,
          fy_id, ...bf.params
        );
    budgetRows = oldBudgets;
  }

  // Filter by business_unit if specified
  if (business_unit) {
    budgetRows = budgetRows.filter((b: any) => !b.business_unit || b.business_unit === business_unit);
  }

  // Get actuals
  const clinicActuals = db.all(
    `SELECT bill_month as month, department as dept_name, 'revenue' as metric,
      SUM(item_price) as actual_amount, COUNT(*) as actual_count
    FROM clinic_actuals WHERE bill_month >= ? AND bill_month <= ?${bf.where}
    GROUP BY bill_month, department`,
    startMonth, endMonth, ...bf.params
  );

  const pharmaActuals = db.all(
    `SELECT bill_month as month, NULL as dept_name, 'sales_amount' as metric,
      SUM(sales_amount) as actual_amount, COUNT(DISTINCT bill_no) as actual_count
    FROM pharmacy_sales_actuals WHERE bill_month >= ? AND bill_month <= ?${bf.where}
    GROUP BY bill_month`,
    startMonth, endMonth, ...bf.params
  );

  const allActuals = [...clinicActuals, ...pharmaActuals];

  // For forecast-sourced budgets, aggregate actuals by month (all departments combined)
  const clinicMonthlyTotals = db.all(
    `SELECT bill_month as month, 'revenue' as metric,
      SUM(item_price) as actual_amount, COUNT(*) as actual_count
    FROM clinic_actuals WHERE bill_month >= ? AND bill_month <= ?${bf.where}
    GROUP BY bill_month`,
    startMonth, endMonth, ...bf.params
  );

  const variance = budgetRows.map((b: any) => {
    let actualAmount = 0;

    if (b.dept_name) {
      // Old budget system: match by department
      const actual = allActuals.find((a: any) =>
        a.month === b.month && a.metric === b.metric &&
        (a.dept_name === b.dept_name || (!a.dept_name && !b.dept_name))
      );
      actualAmount = actual?.actual_amount || 0;
    } else {
      // Forecast module: match total actuals for the month
      const actual = clinicMonthlyTotals.find((a: any) => a.month === b.month);
      actualAmount = actual?.actual_amount || 0;
    }

    const varianceAmt = actualAmount - b.amount;
    const variancePct = b.amount !== 0 ? (varianceAmt / b.amount) * 100 : 0;
    const absVar = Math.abs(variancePct);
    let rag = 'GREEN';
    if (absVar > 15) rag = 'RED';
    else if (absVar > 5) rag = 'AMBER';

    return {
      ...b,
      actual_amount: actualAmount,
      variance_amount: varianceAmt,
      variance_pct: Math.round(variancePct * 100) / 100,
      rag,
    };
  });

  res.json(variance);
});

export default router;
