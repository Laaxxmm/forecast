/**
 * VCFO Dashboard — KPIs, trends, breakdowns from Tally-synced data
 * Ported from TallyVision's Dynamic TB Engine with in-memory lookups.
 */
import { Router, Request, Response } from 'express';
import type { DbHelper } from '../../db/connection.js';
import { idPh } from '../../services/vcfo/company-resolver.js';
import {
  getGroupTree, buildLedgerGroupMap, buildPLGroupSets,
  computePLFlow, getTopLedgers, getTotalsByGroup,
  getVouchersByLedger, getTBSupplement, getPLFallback,
  getLedgerFlowsTB, getMonthlyFlowsTB, computeKPIData, computeBSClosing
} from '../../services/vcfo/kpi-engine.js';
import {
  getDashboardAllocRules, getEffectiveOverlap
} from '../../services/vcfo/allocation-engine.js';

const router = Router();

// ── Helper ────────────────────────────────────────────────────────────────────

function resolveCompanyIds(db: DbHelper, req: Request): number[] | null {
  const companyId = req.query.companyId ? parseInt(req.query.companyId as string) : null;
  const branchId = req.branchId;

  if (companyId) return [companyId];

  // All active VCFO companies for this branch
  let sql = 'SELECT id FROM vcfo_companies WHERE is_active = 1';
  const params: any[] = [];
  if (branchId) {
    sql += ' AND branch_id = ?';
    params.push(branchId);
  }
  const rows = db.all(sql, ...params);
  return rows.length > 0 ? rows.map((r: any) => r.id) : null;
}

// ── KPI endpoint ─────────────────────────────────────────────────────────────

router.get('/kpi', (req: Request, res: Response) => {
  try {
    const db = req.tenantDb!;
    const from = req.query.from as string;
    const to = req.query.to as string;
    if (!from || !to) return res.status(400).json({ error: 'from and to required' });

    const ids = resolveCompanyIds(db, req);
    if (!ids || ids.length === 0) return res.json({ kpis: {}, noData: true });

    const lgMap = buildLedgerGroupMap(db, ids);
    const vByLedger = getVouchersByLedger(db, ids, from, to);
    const { directCredit, indirectCredit, directDebit, indirectDebit } = buildPLGroupSets(db, ids);
    const salesSet = new Set(getGroupTree(db, ids, 'Sales Accounts'));
    const purchaseSet = new Set(getGroupTree(db, ids, 'Purchase Accounts'));

    const salesFlow = computePLFlow(vByLedger, lgMap, salesSet);
    const purchaseFlow = computePLFlow(vByLedger, lgMap, purchaseSet);
    let allDCFlow = computePLFlow(vByLedger, lgMap, directCredit);
    let allDDFlow = computePLFlow(vByLedger, lgMap, directDebit);
    let allICFlow = computePLFlow(vByLedger, lgMap, indirectCredit);
    let allIDFlow = computePLFlow(vByLedger, lgMap, indirectDebit);

    // TB supplement
    const voucherMap = new Map(vByLedger.map((r: any) => [`${r.company_id}|${r.ledger_name}`, r.total]));
    const tbSupp = getTBSupplement(db, ids, from, to);

    for (const r of tbSupp) {
      if (!r.group_name) continue;
      const dr = r.net_debit || 0;
      const cr = r.net_credit || 0;
      const vs = voucherMap.get(`${r.company_id}|${r.ledger_name}`) || 0;
      if (directDebit.has(r.group_name)) allDDFlow -= Math.max(0, (dr - cr) + vs);
      else if (directCredit.has(r.group_name)) allDCFlow += Math.max(0, (cr - dr) - vs);
      else if (indirectDebit.has(r.group_name)) allIDFlow -= Math.max(0, (dr - cr) + vs);
      else if (indirectCredit.has(r.group_name)) allICFlow += Math.max(0, (cr - dr) - vs);
    }

    // P&L fallback
    let usedPLFallback = false;
    const tbSuppPLCount = tbSupp.filter((r: any) =>
      directCredit.has(r.group_name) || directDebit.has(r.group_name) ||
      indirectCredit.has(r.group_name) || indirectDebit.has(r.group_name)
    ).length;

    if (tbSuppPLCount === 0) {
      const plRows = getPLFallback(db, ids, from, to);
      const plPLRows = plRows.filter((r: any) =>
        directCredit.has(r.group_name) || directDebit.has(r.group_name) ||
        indirectCredit.has(r.group_name) || indirectDebit.has(r.group_name)
      );
      if (plPLRows.length > 0) {
        usedPLFallback = true;
        allDCFlow = 0; allDDFlow = 0; allICFlow = 0; allIDFlow = 0;
        for (const r of plPLRows) {
          const amt = r.amount || 0;
          if (directCredit.has(r.group_name)) allDCFlow += amt;
          else if (directDebit.has(r.group_name)) allDDFlow += amt;
          else if (indirectCredit.has(r.group_name)) allICFlow += amt;
          else if (indirectDebit.has(r.group_name)) allIDFlow += amt;
        }
      }
    }

    // Stock adjustment
    const stockGroups = getGroupTree(db, ids, 'Stock-in-Hand');
    let openingStock = 0, closingStock = 0;
    if (stockGroups.length > 0) {
      const stockPh = stockGroups.map(() => '?').join(',');
      for (const cid of ids) {
        const firstPF = db.get(
          `SELECT MIN(period_from) as pf FROM vcfo_trial_balance WHERE company_id = ? AND group_name IN (${stockPh}) AND period_from >= ?`,
          cid, ...stockGroups, from
        )?.pf;
        if (firstPF) {
          openingStock += db.get(
            `SELECT SUM(opening_balance) as val FROM vcfo_trial_balance WHERE company_id = ? AND group_name IN (${stockPh}) AND period_from = ?`,
            cid, ...stockGroups, firstPF
          )?.val || 0;
        }
        const lastPT = db.get(
          `SELECT MAX(period_to) as pt FROM vcfo_trial_balance WHERE company_id = ? AND group_name IN (${stockPh}) AND period_to <= ?`,
          cid, ...stockGroups, to
        )?.pt;
        if (lastPT) {
          closingStock += db.get(
            `SELECT SUM(closing_balance) as val FROM vcfo_trial_balance WHERE company_id = ? AND group_name IN (${stockPh}) AND period_to = ?`,
            cid, ...stockGroups, lastPT
          )?.val || 0;
        }
      }
    }

    const stockAdjustment = openingStock - closingStock;
    const grossProfit = allDCFlow + allDDFlow + stockAdjustment;
    const netProfit = grossProfit + allICFlow + allIDFlow;

    // Derive sales/purchase for display
    let salesFlowFull = salesFlow;
    let purchaseFlowFull = purchaseFlow;
    if (usedPLFallback) {
      salesFlowFull = 0; purchaseFlowFull = 0;
      const plRows = getPLFallback(db, ids, from, to);
      for (const r of plRows) {
        if (salesSet.has(r.group_name)) salesFlowFull += r.amount || 0;
        else if (purchaseSet.has(r.group_name)) purchaseFlowFull += r.amount || 0;
      }
    } else {
      for (const r of tbSupp) {
        if (!r.group_name) continue;
        const dr = r.net_debit || 0;
        const cr = r.net_credit || 0;
        const vs = voucherMap.get(`${r.company_id}|${r.ledger_name}`) || 0;
        if (salesSet.has(r.group_name)) {
          salesFlowFull += Math.max(0, (cr - dr) - vs);
          salesFlowFull -= Math.max(0, (dr - cr) + vs);
        } else if (purchaseSet.has(r.group_name)) {
          purchaseFlowFull -= Math.max(0, (dr - cr) + vs);
          purchaseFlowFull += Math.max(0, (cr - dr) - vs);
        }
      }
    }

    const rev = salesFlowFull;
    const purchaseVal = -purchaseFlowFull;
    const directExpVal = -(allDDFlow - purchaseFlowFull);
    const indirectExpVal = -allIDFlow;
    const indirectIncVal = allICFlow;
    const directIncVal = allDCFlow - salesFlowFull;

    res.json({
      kpis: {
        revenue: rev,
        purchase: purchaseVal,
        directIncome: directIncVal,
        directExpenses: directExpVal,
        indirectIncome: indirectIncVal,
        indirectExpenses: indirectExpVal,
        grossProfit,
        netProfit,
        grossProfitMargin: rev > 0 ? (grossProfit / rev) * 100 : 0,
        netProfitMargin: rev > 0 ? (netProfit / rev) * 100 : 0,
        stockAdjustment,
        operatingExpenses: directExpVal + indirectExpVal,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Monthly trend ────────────────────────────────────────────────────────────

router.get('/monthly-trend', (req: Request, res: Response) => {
  try {
    const db = req.tenantDb!;
    const from = req.query.from as string;
    const to = req.query.to as string;
    if (!from || !to) return res.status(400).json({ error: 'from and to required' });

    const ids = resolveCompanyIds(db, req);
    if (!ids || ids.length === 0) return res.json([]);

    const lgMap = buildLedgerGroupMap(db, ids);
    const { directCredit, directDebit, indirectCredit, indirectDebit } = buildPLGroupSets(db, ids);

    // TB-based monthly flows
    const monthlyRows = db.all(
      `SELECT company_id, period_from as month, ledger_name,
              SUM(net_credit) - SUM(net_debit) as total
       FROM vcfo_trial_balance
       WHERE company_id IN (${idPh(ids)}) AND period_from >= ? AND period_to <= ? AND group_name IS NOT NULL
       GROUP BY company_id, period_from, ledger_name`,
      ...ids, from, to
    );

    const months: Record<string, { revenue: number; expenses: number; grossProfit: number; netProfit: number }> = {};

    for (const row of monthlyRows) {
      const grp = lgMap[`${row.company_id}|${row.ledger_name}`];
      if (!grp) continue;
      if (!months[row.month]) months[row.month] = { revenue: 0, expenses: 0, grossProfit: 0, netProfit: 0 };
      const m = months[row.month];

      if (directCredit.has(grp)) m.revenue += row.total;
      else if (directDebit.has(grp)) m.expenses += Math.abs(row.total);
      else if (indirectCredit.has(grp)) m.revenue += row.total;
      else if (indirectDebit.has(grp)) m.expenses += Math.abs(row.total);
    }

    // Calculate derived values
    for (const m of Object.values(months)) {
      m.grossProfit = m.revenue - m.expenses;
      m.netProfit = m.grossProfit;
    }

    const result = Object.entries(months)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, data]) => ({ month, ...data }));

    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Top revenue sources ──────────────────────────────────────────────────────

router.get('/top-revenue', (req: Request, res: Response) => {
  try {
    const db = req.tenantDb!;
    const from = req.query.from as string;
    const to = req.query.to as string;
    if (!from || !to) return res.status(400).json({ error: 'from and to required' });

    const ids = resolveCompanyIds(db, req);
    if (!ids || ids.length === 0) return res.json([]);

    const lgMap = buildLedgerGroupMap(db, ids);
    const vByLedger = getVouchersByLedger(db, ids, from, to);
    const { directCredit } = buildPLGroupSets(db, ids);

    res.json(getTopLedgers(vByLedger, lgMap, directCredit, 10, false));
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Top expenses ─────────────────────────────────────────────────────────────

router.get('/top-expenses', (req: Request, res: Response) => {
  try {
    const db = req.tenantDb!;
    const from = req.query.from as string;
    const to = req.query.to as string;
    if (!from || !to) return res.status(400).json({ error: 'from and to required' });

    const ids = resolveCompanyIds(db, req);
    if (!ids || ids.length === 0) return res.json([]);

    const lgMap = buildLedgerGroupMap(db, ids);
    const vByLedger = getVouchersByLedger(db, ids, from, to);
    const { directDebit, indirectDebit } = buildPLGroupSets(db, ids);
    const allExpenses = new Set([...directDebit, ...indirectDebit]);

    res.json(getTopLedgers(vByLedger, lgMap, allExpenses, 10, true));
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Group breakdown (drill-down) ─────────────────────────────────────────────

router.get('/group-breakdown', (req: Request, res: Response) => {
  try {
    const db = req.tenantDb!;
    const from = req.query.from as string;
    const to = req.query.to as string;
    const group = req.query.group as string;
    if (!from || !to || !group) return res.status(400).json({ error: 'from, to, group required' });

    const ids = resolveCompanyIds(db, req);
    if (!ids || ids.length === 0) return res.json([]);

    const lgMap = buildLedgerGroupMap(db, ids);
    const vByLedger = getVouchersByLedger(db, ids, from, to);
    const groupTree = new Set(getGroupTree(db, ids, group));

    res.json(getTotalsByGroup(vByLedger, lgMap, groupTree, false));
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Trial Balance ────────────────────────────────────────────────────────────

router.get('/trial-balance', (req: Request, res: Response) => {
  try {
    const db = req.tenantDb!;
    const from = req.query.from as string;
    const to = req.query.to as string;
    if (!from || !to) return res.status(400).json({ error: 'from and to required' });

    const ids = resolveCompanyIds(db, req);
    if (!ids || ids.length === 0) return res.json([]);

    const rows = db.all(
      `SELECT ledger_name, group_name,
              SUM(opening_balance) as opening_balance,
              SUM(net_debit) as net_debit,
              SUM(net_credit) as net_credit,
              SUM(closing_balance) as closing_balance
       FROM vcfo_trial_balance
       WHERE company_id IN (${idPh(ids)}) AND period_from >= ? AND period_to <= ?
       GROUP BY ledger_name, group_name
       ORDER BY group_name, ledger_name`,
      ...ids, from, to
    );

    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Bills Outstanding ────────────────────────────────────────────────────────

router.get('/bills-outstanding', (req: Request, res: Response) => {
  try {
    const db = req.tenantDb!;
    const nature = req.query.nature as string || 'receivable';

    const ids = resolveCompanyIds(db, req);
    if (!ids || ids.length === 0) return res.json([]);

    const rows = db.all(
      `SELECT party_name, SUM(outstanding_amount) as total, COUNT(*) as bill_count,
              MIN(bill_date) as oldest_bill, MAX(overdue_days) as max_overdue
       FROM vcfo_bills_outstanding
       WHERE company_id IN (${idPh(ids)}) AND nature = ?
       GROUP BY party_name
       ORDER BY total DESC
       LIMIT 20`,
      ...ids, nature
    );

    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Receivable Ageing ───────────────────────────────────────────────────────

router.get('/receivable-ageing', (req: Request, res: Response) => {
  try {
    const db = req.tenantDb!;
    const ids = resolveCompanyIds(db, req);
    if (!ids || ids.length === 0) return res.json([]);

    const rows = db.all(
      `SELECT party_name,
          SUM(CASE WHEN overdue_days <= 30 THEN ABS(outstanding_amount) ELSE 0 END) as "0_30",
          SUM(CASE WHEN overdue_days > 30 AND overdue_days <= 60 THEN ABS(outstanding_amount) ELSE 0 END) as "31_60",
          SUM(CASE WHEN overdue_days > 60 AND overdue_days <= 90 THEN ABS(outstanding_amount) ELSE 0 END) as "61_90",
          SUM(CASE WHEN overdue_days > 90 THEN ABS(outstanding_amount) ELSE 0 END) as "90_plus",
          SUM(ABS(outstanding_amount)) as total
      FROM vcfo_bills_outstanding WHERE company_id IN (${idPh(ids)}) AND nature = 'receivable'
      GROUP BY party_name ORDER BY total DESC LIMIT 15`,
      ...ids
    );
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Payable Ageing ──────────────────────────────────────────────────────────

router.get('/payable-ageing', (req: Request, res: Response) => {
  try {
    const db = req.tenantDb!;
    const ids = resolveCompanyIds(db, req);
    if (!ids || ids.length === 0) return res.json([]);

    const rows = db.all(
      `SELECT party_name,
          SUM(CASE WHEN overdue_days <= 30 THEN ABS(outstanding_amount) ELSE 0 END) as "0_30",
          SUM(CASE WHEN overdue_days > 30 AND overdue_days <= 60 THEN ABS(outstanding_amount) ELSE 0 END) as "31_60",
          SUM(CASE WHEN overdue_days > 60 AND overdue_days <= 90 THEN ABS(outstanding_amount) ELSE 0 END) as "61_90",
          SUM(CASE WHEN overdue_days > 90 THEN ABS(outstanding_amount) ELSE 0 END) as "90_plus",
          SUM(ABS(outstanding_amount)) as total
      FROM vcfo_bills_outstanding WHERE company_id IN (${idPh(ids)}) AND nature = 'payable'
      GROUP BY party_name ORDER BY total DESC LIMIT 15`,
      ...ids
    );
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Stock Summary ───────────────────────────────────────────────────────────

router.get('/stock-summary', (req: Request, res: Response) => {
  try {
    const db = req.tenantDb!;
    const ids = resolveCompanyIds(db, req);
    if (!ids || ids.length === 0) return res.json([]);

    const rows = db.all(
      `SELECT item_name, stock_group, SUM(closing_qty) as closing_qty, SUM(closing_value) as closing_value
       FROM vcfo_stock_summary WHERE company_id IN (${idPh(ids)})
         AND period_to = (SELECT MAX(period_to) FROM vcfo_stock_summary WHERE company_id IN (${idPh(ids)}))
       GROUP BY item_name, stock_group ORDER BY closing_value DESC LIMIT 20`,
      ...ids, ...ids
    );
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GST Summary ─────────────────────────────────────────────────────────────

router.get('/gst-summary', (req: Request, res: Response) => {
  try {
    const db = req.tenantDb!;
    const companyId = req.query.companyId ? Number(req.query.companyId) : null;
    if (!companyId) return res.status(400).json({ error: 'companyId required' });
    const from = (req.query.from as string) || (req.query.fromDate as string) || '2024-04-01';
    const to = (req.query.to as string) || (req.query.toDate as string) || '2025-03-31';

    const byType = db.all(
      `SELECT voucher_type, COUNT(*) as count, SUM(taxable_value) as taxable,
              SUM(igst) as igst, SUM(cgst) as cgst, SUM(sgst) as sgst, SUM(cess) as cess
       FROM vcfo_gst_entries WHERE company_id = ? AND date >= ? AND date <= ?
       GROUP BY voucher_type ORDER BY taxable DESC`,
      companyId, from, to
    );

    const monthly = db.all(
      `SELECT substr(date,1,7) as month, SUM(taxable_value) as taxable,
              SUM(igst+cgst+sgst+cess) as total_tax, COUNT(*) as count
       FROM vcfo_gst_entries WHERE company_id = ? AND date >= ? AND date <= ?
       GROUP BY month ORDER BY month`,
      companyId, from, to
    );

    res.json({ byType, monthly });
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Cost Centre Analysis ────────────────────────────────────────────────────

router.get('/cost-centre-analysis', (req: Request, res: Response) => {
  try {
    const db = req.tenantDb!;
    const companyId = req.query.companyId ? Number(req.query.companyId) : null;
    if (!companyId) return res.status(400).json({ error: 'companyId required' });
    const from = (req.query.from as string) || (req.query.fromDate as string) || '2024-04-01';
    const to = (req.query.to as string) || (req.query.toDate as string) || '2025-03-31';

    const byCentre = db.all(
      `SELECT cost_centre, SUM(ABS(amount)) as total_amount, COUNT(DISTINCT ledger_name) as ledger_count
       FROM vcfo_cost_allocations WHERE company_id = ? AND date >= ? AND date <= ?
       GROUP BY cost_centre ORDER BY total_amount DESC`,
      companyId, from, to
    );
    const centres = db.all(
      'SELECT name, parent, category FROM vcfo_cost_centres WHERE company_id = ?', companyId
    );
    res.json({ byCentre, centres });
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Payroll Summary ─────────────────────────────────────────────────────────

router.get('/payroll-summary', (req: Request, res: Response) => {
  try {
    const db = req.tenantDb!;
    const companyId = req.query.companyId ? Number(req.query.companyId) : null;
    if (!companyId) return res.status(400).json({ error: 'companyId required' });
    const from = (req.query.from as string) || (req.query.fromDate as string) || '2024-04-01';
    const to = (req.query.to as string) || (req.query.toDate as string) || '2025-03-31';

    const byEmployee = db.all(
      `SELECT employee_name, SUM(ABS(amount)) as total, COUNT(DISTINCT date) as payslips
       FROM vcfo_payroll_entries WHERE company_id = ? AND date >= ? AND date <= ? AND employee_name != ''
       GROUP BY employee_name ORDER BY total DESC LIMIT 50`,
      companyId, from, to
    );
    const byPayHead = db.all(
      `SELECT pay_head, SUM(ABS(amount)) as total
       FROM vcfo_payroll_entries WHERE company_id = ? AND date >= ? AND date <= ? AND pay_head != ''
       GROUP BY pay_head ORDER BY total DESC`,
      companyId, from, to
    );
    const monthly = db.all(
      `SELECT substr(date,1,7) as month, SUM(ABS(amount)) as total
       FROM vcfo_payroll_entries WHERE company_id = ? AND date >= ? AND date <= ?
       GROUP BY month ORDER BY month`,
      companyId, from, to
    );
    res.json({ byEmployee, byPayHead, monthly });
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Top Direct Expenses ─────────────────────────────────────────────────────

router.get('/top-direct-expenses', (req: Request, res: Response) => {
  try {
    const db = req.tenantDb!;
    const ids = resolveCompanyIds(db, req);
    if (!ids || ids.length === 0) return res.json([]);
    const from = (req.query.from as string) || (req.query.fromDate as string) || '2024-04-01';
    const to = (req.query.to as string) || (req.query.toDate as string) || '2025-03-31';

    const lgMap = buildLedgerGroupMap(db, ids);
    const tbLedgers = getLedgerFlowsTB(db, ids, from, to);
    const { directDebit } = buildPLGroupSets(db, ids);

    res.json(getTotalsByGroup(tbLedgers, lgMap, directDebit, true).slice(0, 10));
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Top Indirect Expenses ───────────────────────────────────────────────────

router.get('/top-indirect-expenses', (req: Request, res: Response) => {
  try {
    const db = req.tenantDb!;
    const ids = resolveCompanyIds(db, req);
    if (!ids || ids.length === 0) return res.json([]);
    const from = (req.query.from as string) || (req.query.fromDate as string) || '2024-04-01';
    const to = (req.query.to as string) || (req.query.toDate as string) || '2025-03-31';

    const lgMap = buildLedgerGroupMap(db, ids);
    const tbLedgers = getLedgerFlowsTB(db, ids, from, to);
    const { indirectDebit } = buildPLGroupSets(db, ids);

    const results: any[] = getTotalsByGroup(tbLedgers, lgMap, indirectDebit, true);

    // Inject allocation synthetic entries if group context available
    const groupId = req.query.groupId ? Number(req.query.groupId) : 0;
    if (groupId && ids.length > 1) {
      const rules = getDashboardAllocRules(db, groupId);
      if (rules && rules.length) {
        const units = ids.map(cid => {
          const kpi = computeKPIData(db, [cid], from, to);
          return { companyId: cid, ...kpi };
        });
        for (const rule of rules) {
          const config = JSON.parse(rule.config || '{}');
          if (rule.rule_type === 'percent_income') {
            const pct = (Number(config.percentage) || 0) / 100;
            const sourceIds: number[] = config.source_company_ids || [];
            let totalCharge = 0;
            for (const sid of sourceIds) {
              const src = units.find((u: any) => u.companyId === sid);
              if (src) totalCharge += ((src as any).directIncome || (src as any).revenue || 0) * pct;
            }
            if (totalCharge > 0) {
              results.push({ category: config.expense_label || 'HO Charges', total: totalCharge, _allocation: true });
            }
          } else if (rule.rule_type === 'fixed') {
            const overlap = getEffectiveOverlap(config, from, to);
            if (overlap.overlaps) {
              results.push({ category: `Alloc: ${rule.rule_name}`, total: 0, _allocation: true, _note: 'Internal transfer (net zero)' });
            }
          }
        }
      }
    }

    res.json(results.sort((a: any, b: any) => b.total - a.total).slice(0, 10));
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Expense Categories ──────────────────────────────────────────────────────

router.get('/expense-categories', (req: Request, res: Response) => {
  try {
    const db = req.tenantDb!;
    const ids = resolveCompanyIds(db, req);
    if (!ids || ids.length === 0) return res.json([]);
    const from = (req.query.from as string) || (req.query.fromDate as string) || '2024-04-01';
    const to = (req.query.to as string) || (req.query.toDate as string) || '2025-03-31';

    const lgMap = buildLedgerGroupMap(db, ids);
    const tbLedgers = getLedgerFlowsTB(db, ids, from, to);
    const expSet = new Set([
      ...getGroupTree(db, ids, 'Purchase Accounts'),
      ...getGroupTree(db, ids, 'Direct Expenses'),
      ...getGroupTree(db, ids, 'Indirect Expenses')
    ]);

    res.json(getTotalsByGroup(tbLedgers, lgMap, expSet, true));
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Revenue Categories ──────────────────────────────────────────────────────

router.get('/revenue-categories', (req: Request, res: Response) => {
  try {
    const db = req.tenantDb!;
    const ids = resolveCompanyIds(db, req);
    if (!ids || ids.length === 0) return res.json([]);
    const from = (req.query.from as string) || (req.query.fromDate as string) || '2024-04-01';
    const to = (req.query.to as string) || (req.query.toDate as string) || '2025-03-31';

    const lgMap = buildLedgerGroupMap(db, ids);
    const tbLedgers = getLedgerFlowsTB(db, ids, from, to);
    const { directCredit } = buildPLGroupSets(db, ids);

    res.json(getTotalsByGroup(tbLedgers, lgMap, directCredit, false));
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Item Monthly Trend ──────────────────────────────────────────────────────

router.get('/item-monthly-trend', (req: Request, res: Response) => {
  try {
    const db = req.tenantDb!;
    const ids = resolveCompanyIds(db, req);
    const { groupRoot, mode, classType, parentGroup, ledgerName } = req.query;
    if (!ids || (!groupRoot && !classType)) {
      return res.status(400).json({ error: 'companyId/filters and groupRoot or classType required' });
    }

    const from = (req.query.from as string) || (req.query.fromDate as string) || '2024-04-01';
    const to = (req.query.to as string) || (req.query.toDate as string) || '2025-03-31';

    // Resolve groupSet
    let groupSet: Set<string>;
    if (classType) {
      const { directCredit, indirectCredit, directDebit, indirectDebit } = buildPLGroupSets(db, ids);
      const salesGroupSet = new Set(getGroupTree(db, ids, 'Sales Accounts'));
      const purchaseGroupSet = new Set(getGroupTree(db, ids, 'Purchase Accounts'));
      const directExpOnly = new Set(directDebit); purchaseGroupSet.forEach(g => directExpOnly.delete(g));
      const directIncOnly = new Set(directCredit); salesGroupSet.forEach(g => directIncOnly.delete(g));
      const classMap: Record<string, Set<string>> = {
        revenue: salesGroupSet, purchase: purchaseGroupSet,
        directexp: directExpOnly, indirectexp: indirectDebit,
        directinc: directIncOnly, indirectinc: indirectCredit,
      };
      groupSet = classMap[classType as string] || new Set();
    } else {
      const roots = (groupRoot as string).split(',');
      groupSet = new Set(roots.flatMap(r => getGroupTree(db, ids, r.trim())));
    }

    // If parentGroup specified, narrow groupSet
    if (parentGroup) {
      const descendants = new Set(getGroupTree(db, ids, parentGroup as string));
      const narrowed = new Set<string>();
      descendants.forEach(g => { if (groupSet.has(g)) narrowed.add(g); });
      groupSet = narrowed;
    }

    const lgMap = buildLedgerGroupMap(db, ids);

    if (mode === 'balance') {
      const tbRows = db.all(
        `SELECT period_from as month, ledger_name, group_name, SUM(closing_balance) as closing_balance
         FROM vcfo_trial_balance WHERE company_id IN (${idPh(ids)}) AND period_from >= ? AND period_from <= ?
         GROUP BY period_from, ledger_name, group_name ORDER BY period_from`,
        ...ids, from, to
      );
      const months: Record<string, number> = {};
      for (const r of tbRows) {
        if (!r.group_name || !groupSet.has(r.group_name)) continue;
        if (ledgerName && r.ledger_name !== ledgerName) continue;
        if (!months[r.month]) months[r.month] = 0;
        months[r.month] += Math.abs(r.closing_balance || 0);
      }
      return res.json(
        Object.entries(months).sort(([a], [b]) => a.localeCompare(b)).map(([month, amount]) => ({ month, amount }))
      );
    }

    // P&L items: TB-based monthly flows
    const monthlyRows = getMonthlyFlowsTB(db, ids, from, to);
    const months: Record<string, number> = {};
    for (const row of monthlyRows) {
      if (ledgerName) {
        if (row.ledger_name !== ledgerName) continue;
        const grp = lgMap[`${row.company_id}|${row.ledger_name}`];
        if (!grp || !groupSet.has(grp)) continue;
      } else {
        const grp = lgMap[`${row.company_id}|${row.ledger_name}`];
        if (!grp || !groupSet.has(grp)) continue;
      }
      if (!months[row.month]) months[row.month] = 0;
      months[row.month] += Math.abs(row.total);
    }

    res.json(
      Object.entries(months).sort(([a], [b]) => a.localeCompare(b)).map(([month, amount]) => ({ month, amount }))
    );
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
