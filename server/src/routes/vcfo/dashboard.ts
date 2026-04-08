/**
 * VCFO Dashboard — KPIs, trends, breakdowns from Tally-synced data
 * Ported from TallyVision's Dynamic TB Engine with in-memory lookups.
 */
import { Router, Request, Response } from 'express';
import type { DbHelper } from '../../db/connection.js';

const router = Router();

// ── Helper functions ──────────────────────────────────────────────────────────

function idPh(ids: number[]): string {
  return ids.map(() => '?').join(',');
}

function getGroupTree(db: DbHelper, ids: number[], parentName: string): string[] {
  const allGroups = db.all(
    `SELECT DISTINCT group_name, parent_group FROM vcfo_account_groups WHERE company_id IN (${idPh(ids)})`,
    ...ids
  );
  const result = new Set([parentName]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const g of allGroups) {
      if (result.has(g.parent_group) && !result.has(g.group_name)) {
        result.add(g.group_name);
        changed = true;
      }
    }
  }
  return [...result];
}

function buildLedgerGroupMap(db: DbHelper, ids: number[]): Record<string, string> {
  const rows = db.all(
    `SELECT DISTINCT company_id, ledger_name, group_name FROM vcfo_trial_balance WHERE company_id IN (${idPh(ids)})`,
    ...ids
  );
  const map: Record<string, string> = {};
  rows.forEach((r: any) => { map[`${r.company_id}|${r.ledger_name}`] = r.group_name; });
  return map;
}

function buildPLGroupSets(db: DbHelper, ids: number[]) {
  const groups = db.all(
    `SELECT group_name, dr_cr, affects_gross_profit, COUNT(*) as cnt
     FROM vcfo_account_groups WHERE company_id IN (${idPh(ids)}) AND bs_pl = 'PL'
     GROUP BY group_name, dr_cr, affects_gross_profit`,
    ...ids
  );
  const best: Record<string, any> = {};
  for (const g of groups) {
    if (!best[g.group_name] || g.cnt > best[g.group_name].cnt) best[g.group_name] = g;
  }
  const sets = {
    directCredit: new Set<string>(), indirectCredit: new Set<string>(),
    directDebit: new Set<string>(), indirectDebit: new Set<string>(),
  };
  for (const g of Object.values(best)) {
    if (g.dr_cr === 'C' && g.affects_gross_profit === 'Y') sets.directCredit.add(g.group_name);
    else if (g.dr_cr === 'C' && g.affects_gross_profit === 'N') sets.indirectCredit.add(g.group_name);
    else if (g.dr_cr === 'D' && g.affects_gross_profit === 'Y') sets.directDebit.add(g.group_name);
    else if (g.dr_cr === 'D' && g.affects_gross_profit === 'N') sets.indirectDebit.add(g.group_name);
  }
  return sets;
}

function getVouchersByLedger(db: DbHelper, ids: number[], fromDate: string, toDate: string) {
  return db.all(
    `SELECT company_id, ledger_name, SUM(amount) as total
     FROM vcfo_vouchers WHERE company_id IN (${idPh(ids)}) AND date >= ? AND date <= ? AND ledger_name != ''
     GROUP BY company_id, ledger_name`,
    ...ids, fromDate, toDate
  );
}

function getTBSupplement(db: DbHelper, ids: number[], from: string, to: string) {
  return db.all(
    `SELECT company_id, ledger_name, group_name,
            SUM(net_debit) AS net_debit, SUM(net_credit) AS net_credit
     FROM vcfo_trial_balance
     WHERE company_id IN (${idPh(ids)}) AND period_from >= ? AND period_to <= ? AND group_name IS NOT NULL
     GROUP BY company_id, ledger_name, group_name`,
    ...ids, from, to
  );
}

function getPLFallback(db: DbHelper, ids: number[], from: string, to: string) {
  return db.all(
    `SELECT company_id, ledger_name, group_name, SUM(amount) as amount
     FROM vcfo_profit_loss
     WHERE company_id IN (${idPh(ids)}) AND period_from >= ? AND period_to <= ? AND group_name IS NOT NULL
     GROUP BY company_id, ledger_name, group_name`,
    ...ids, from, to
  );
}

function computePLFlow(vouchersByLedger: any[], lgMap: Record<string, string>, groupSet: Set<string>): number {
  let total = 0;
  for (const row of vouchersByLedger) {
    const grp = lgMap[`${row.company_id}|${row.ledger_name}`];
    if (grp && groupSet.has(grp)) total += row.total;
  }
  return total;
}

function getTopLedgers(vouchersByLedger: any[], lgMap: Record<string, string>, groupSet: Set<string>, limit: number, negate: boolean) {
  const merged: Record<string, { ledger_name: string; group_name: string; total: number }> = {};
  for (const row of vouchersByLedger) {
    const grp = lgMap[`${row.company_id}|${row.ledger_name}`];
    if (grp && groupSet.has(grp)) {
      const val = negate ? -row.total : row.total;
      if (val > 0) {
        const key = `${grp}||${row.ledger_name}`;
        if (!merged[key]) merged[key] = { ledger_name: row.ledger_name, group_name: grp, total: 0 };
        merged[key].total += val;
      }
    }
  }
  return Object.values(merged).sort((a, b) => b.total - a.total).slice(0, limit);
}

function getTotalsByGroup(vouchersByLedger: any[], lgMap: Record<string, string>, groupSet: Set<string>, negate: boolean) {
  const groupTotals: Record<string, number> = {};
  for (const row of vouchersByLedger) {
    const grp = lgMap[`${row.company_id}|${row.ledger_name}`];
    if (grp && groupSet.has(grp)) groupTotals[grp] = (groupTotals[grp] || 0) + row.total;
  }
  const results: { category: string; total: number }[] = [];
  for (const [category, total] of Object.entries(groupTotals)) {
    const val = negate ? -total : total;
    if (val > 0) results.push({ category, total: val });
  }
  return results.sort((a, b) => b.total - a.total);
}

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
});

// ── Monthly trend ────────────────────────────────────────────────────────────

router.get('/monthly-trend', (req: Request, res: Response) => {
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
});

// ── Top revenue sources ──────────────────────────────────────────────────────

router.get('/top-revenue', (req: Request, res: Response) => {
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
});

// ── Top expenses ─────────────────────────────────────────────────────────────

router.get('/top-expenses', (req: Request, res: Response) => {
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
});

// ── Group breakdown (drill-down) ─────────────────────────────────────────────

router.get('/group-breakdown', (req: Request, res: Response) => {
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
});

// ── Trial Balance ────────────────────────────────────────────────────────────

router.get('/trial-balance', (req: Request, res: Response) => {
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
});

// ── Bills Outstanding ────────────────────────────────────────────────────────

router.get('/bills-outstanding', (req: Request, res: Response) => {
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
});

export default router;
