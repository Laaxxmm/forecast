/**
 * VCFO Reports — Structured P&L, Balance Sheet, and Cash Flow statements
 * Generates hierarchical financial statements from synced Tally data.
 */
import { Router, Request, Response } from 'express';
import type { DbHelper } from '../../db/connection.js';
import {
  idPh, resolveIds, resolveGroupMemberIds,
  startOfMonth, endOfMonth, subtractMonth, subtractYear, monthLabel,
  buildFilterLabel, fmtLakhs
} from '../../services/vcfo/company-resolver.js';
import {
  getGroupTree, buildLedgerGroupMap, buildPLGroupSets,
  getTopLedgers, getTotalsByGroup, getLedgerFlowsTB,
  computeKPIData, computeBSClosing, getMonthlyFlowsTB
} from '../../services/vcfo/kpi-engine.js';
import { buildPLStatement, computeMonthlyTrendData } from '../../services/vcfo/pl-statement.js';
import { applyAllocationRule } from '../../services/vcfo/allocation-engine.js';

const router = Router();

function resolveCompanyIds(db: DbHelper, req: Request): number[] | null {
  const companyId = req.query.companyId ? parseInt(req.query.companyId as string) : null;
  const branchId = req.branchId;
  if (companyId) return [companyId];
  let sql = 'SELECT id FROM vcfo_companies WHERE is_active = 1';
  const params: any[] = [];
  if (branchId) { sql += ' AND branch_id = ?'; params.push(branchId); }
  const rows = db.all(sql, ...params);
  return rows.length > 0 ? rows.map((r: any) => r.id) : null;
}

// ── Profit & Loss Statement ──────────────────────────────────────────────────

router.get('/profit-loss', (req: Request, res: Response) => {
  try {
  const db = req.tenantDb!;
  const from = req.query.from as string;
  const to = req.query.to as string;
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });

  const ids = resolveCompanyIds(db, req);
  if (!ids || ids.length === 0) return res.json({ sections: [], noData: true });

  // Get all P&L group classifications
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

  // Categorize groups
  const directCredit = new Set<string>();
  const directDebit = new Set<string>();
  const indirectCredit = new Set<string>();
  const indirectDebit = new Set<string>();
  for (const g of Object.values(best)) {
    if (g.dr_cr === 'C' && g.affects_gross_profit === 'Y') directCredit.add(g.group_name);
    else if (g.dr_cr === 'C' && g.affects_gross_profit === 'N') indirectCredit.add(g.group_name);
    else if (g.dr_cr === 'D' && g.affects_gross_profit === 'Y') directDebit.add(g.group_name);
    else if (g.dr_cr === 'D' && g.affects_gross_profit === 'N') indirectDebit.add(g.group_name);
  }

  // Get ledger-level P&L data from profit_loss table
  const plRows = db.all(
    `SELECT ledger_name, group_name, SUM(amount) as amount
     FROM vcfo_profit_loss
     WHERE company_id IN (${idPh(ids)}) AND period_from >= ? AND period_to <= ? AND group_name IS NOT NULL
     GROUP BY ledger_name, group_name
     ORDER BY group_name, ledger_name`,
    ...ids, from, to
  );

  // Fall back to TB if profit_loss is empty
  let dataRows = plRows;
  let source = 'profit_loss';
  if (plRows.length === 0) {
    source = 'trial_balance';
    dataRows = db.all(
      `SELECT ledger_name, group_name, SUM(net_credit) - SUM(net_debit) as amount
       FROM vcfo_trial_balance
       WHERE company_id IN (${idPh(ids)}) AND period_from >= ? AND period_to <= ? AND group_name IS NOT NULL
       GROUP BY ledger_name, group_name
       ORDER BY group_name, ledger_name`,
      ...ids, from, to
    );
  }

  // Build sections
  const buildSection = (title: string, groupSet: Set<string>, negate: boolean) => {
    const items: { ledger_name: string; group_name: string; amount: number }[] = [];
    let total = 0;
    for (const r of dataRows) {
      if (groupSet.has(r.group_name)) {
        const amt = negate ? -(r.amount || 0) : (r.amount || 0);
        if (Math.abs(amt) > 0.5) {
          items.push({ ledger_name: r.ledger_name, group_name: r.group_name, amount: amt });
          total += amt;
        }
      }
    }
    items.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
    return { title, items, total };
  };

  const salesSection = buildSection('Sales / Direct Income', directCredit, false);
  const purchaseSection = buildSection('Purchases / Direct Expenses', directDebit, true);
  const indirectIncomeSection = buildSection('Indirect Income', indirectCredit, false);
  const indirectExpenseSection = buildSection('Indirect Expenses', indirectDebit, true);

  const grossProfit = salesSection.total - purchaseSection.total;
  const netProfit = grossProfit + indirectIncomeSection.total - indirectExpenseSection.total;

  res.json({
    source,
    sections: [salesSection, purchaseSection, indirectIncomeSection, indirectExpenseSection],
    summary: {
      grossProfit,
      netProfit,
      grossProfitMargin: salesSection.total > 0 ? (grossProfit / salesSection.total) * 100 : 0,
      netProfitMargin: salesSection.total > 0 ? (netProfit / salesSection.total) * 100 : 0,
    },
  });
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Monthly P&L Comparison ───────────────────────────────────────────────────

router.get('/profit-loss/monthly', (req: Request, res: Response) => {
  try {
  const db = req.tenantDb!;
  const from = req.query.from as string;
  const to = req.query.to as string;
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });

  const ids = resolveCompanyIds(db, req);
  if (!ids || ids.length === 0) return res.json([]);

  // Get monthly P&L by group classification
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

  const rows = db.all(
    `SELECT period_from as month, group_name, SUM(amount) as amount
     FROM vcfo_profit_loss
     WHERE company_id IN (${idPh(ids)}) AND period_from >= ? AND period_to <= ? AND group_name IS NOT NULL
     GROUP BY period_from, group_name
     ORDER BY period_from`,
    ...ids, from, to
  );

  // Aggregate into monthly summaries
  const months: Record<string, { revenue: number; directExpenses: number; indirectIncome: number; indirectExpenses: number }> = {};
  for (const r of rows) {
    if (!months[r.month]) months[r.month] = { revenue: 0, directExpenses: 0, indirectIncome: 0, indirectExpenses: 0 };
    const cls = best[r.group_name];
    if (!cls) continue;
    const amt = r.amount || 0;
    if (cls.dr_cr === 'C' && cls.affects_gross_profit === 'Y') months[r.month].revenue += amt;
    else if (cls.dr_cr === 'D' && cls.affects_gross_profit === 'Y') months[r.month].directExpenses += Math.abs(amt);
    else if (cls.dr_cr === 'C' && cls.affects_gross_profit === 'N') months[r.month].indirectIncome += amt;
    else if (cls.dr_cr === 'D' && cls.affects_gross_profit === 'N') months[r.month].indirectExpenses += Math.abs(amt);
  }

  const result = Object.entries(months).sort(([a], [b]) => a.localeCompare(b)).map(([month, data]) => ({
    month,
    ...data,
    grossProfit: data.revenue - data.directExpenses,
    netProfit: data.revenue - data.directExpenses + data.indirectIncome - data.indirectExpenses,
  }));

  res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Balance Sheet ────────────────────────────────────────────────────────────

router.get('/balance-sheet', (req: Request, res: Response) => {
  try {
  const db = req.tenantDb!;
  const asOnDate = req.query.date as string;
  if (!asOnDate) return res.status(400).json({ error: 'date required' });

  const ids = resolveCompanyIds(db, req);
  if (!ids || ids.length === 0) return res.json({ sections: [], noData: true });

  // Get BS group classifications
  // Standard BS parent groups
  const assetGroups = new Set(getGroupTree(db, ids, 'Current Assets')
    .concat(getGroupTree(db, ids, 'Fixed Assets'))
    .concat(getGroupTree(db, ids, 'Investments'))
    .concat(getGroupTree(db, ids, 'Loans & Advances (Asset)'))
    .concat(getGroupTree(db, ids, 'Misc. Expenses (ASSET)'))
  );

  const liabilityGroups = new Set(getGroupTree(db, ids, 'Current Liabilities')
    .concat(getGroupTree(db, ids, 'Loans (Liability)'))
    .concat(getGroupTree(db, ids, 'Secured Loans'))
    .concat(getGroupTree(db, ids, 'Unsecured Loans'))
    .concat(getGroupTree(db, ids, 'Branch / Divisions'))
    .concat(getGroupTree(db, ids, 'Suspense A/c'))
  );

  const capitalGroups = new Set(getGroupTree(db, ids, 'Capital Account')
    .concat(getGroupTree(db, ids, 'Reserves & Surplus'))
  );

  // Get balance sheet data — find the closest available date
  let bsRows = db.all(
    `SELECT ledger_name, group_name, SUM(closing_balance) as closing_balance
     FROM vcfo_balance_sheet
     WHERE company_id IN (${idPh(ids)}) AND as_on_date = (SELECT MAX(as_on_date) FROM vcfo_balance_sheet WHERE company_id IN (${idPh(ids)}) AND as_on_date <= ?)
     GROUP BY ledger_name, group_name
     ORDER BY group_name, ledger_name`,
    ...ids, ...ids, asOnDate
  );

  // If no BS data, fall back to TB closing balances
  if (bsRows.length === 0) {
    bsRows = db.all(
      `SELECT ledger_name, group_name, SUM(closing_balance) as closing_balance
       FROM vcfo_trial_balance
       WHERE company_id IN (${idPh(ids)}) AND period_to = (SELECT MAX(period_to) FROM vcfo_trial_balance WHERE company_id IN (${idPh(ids)}) AND period_to <= ?)
       GROUP BY ledger_name, group_name
       ORDER BY group_name, ledger_name`,
      ...ids, ...ids, asOnDate
    );
  }

  const buildBSSection = (title: string, groupSet: Set<string>) => {
    const items: { ledger_name: string; group_name: string; amount: number }[] = [];
    let total = 0;
    for (const r of bsRows) {
      if (groupSet.has(r.group_name)) {
        const amt = r.closing_balance || 0;
        if (Math.abs(amt) > 0.5) {
          items.push({ ledger_name: r.ledger_name, group_name: r.group_name, amount: amt });
          total += amt;
        }
      }
    }
    items.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
    return { title, items, total };
  };

  const assets = buildBSSection('Assets', assetGroups);
  const liabilities = buildBSSection('Liabilities', liabilityGroups);
  const capital = buildBSSection('Capital & Reserves', capitalGroups);

  res.json({
    sections: [assets, liabilities, capital],
    summary: {
      totalAssets: assets.total,
      totalLiabilities: liabilities.total + capital.total,
      netWorth: capital.total,
      currentRatio: liabilities.total !== 0 ? assets.total / Math.abs(liabilities.total) : 0,
    },
  });
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Bills Outstanding (Receivables & Payables) ───────────────────────────────

router.get('/bills-outstanding', (req: Request, res: Response) => {
  try {
  const db = req.tenantDb!;
  const nature = (req.query.nature as string) || 'receivable';

  const ids = resolveCompanyIds(db, req);
  if (!ids || ids.length === 0) return res.json({ rows: [], summary: {} });

  // Summary stats
  const summary = db.get(
    `SELECT COUNT(*) as total_bills, SUM(outstanding_amount) as total_amount,
            SUM(CASE WHEN overdue_days > 0 THEN outstanding_amount ELSE 0 END) as overdue_amount,
            SUM(CASE WHEN overdue_days > 90 THEN outstanding_amount ELSE 0 END) as critical_amount,
            MAX(overdue_days) as max_overdue
     FROM vcfo_bills_outstanding
     WHERE company_id IN (${idPh(ids)}) AND nature = ?`,
    ...ids, nature
  );

  // Aging buckets
  const aging = db.all(
    `SELECT
       CASE
         WHEN overdue_days <= 0 THEN 'Current'
         WHEN overdue_days <= 30 THEN '1-30 days'
         WHEN overdue_days <= 60 THEN '31-60 days'
         WHEN overdue_days <= 90 THEN '61-90 days'
         ELSE '90+ days'
       END as bucket,
       COUNT(*) as count,
       SUM(outstanding_amount) as amount
     FROM vcfo_bills_outstanding
     WHERE company_id IN (${idPh(ids)}) AND nature = ?
     GROUP BY bucket
     ORDER BY MIN(overdue_days)`,
    ...ids, nature
  );

  // Party-wise breakdown
  const parties = db.all(
    `SELECT party_name, COUNT(*) as bill_count, SUM(outstanding_amount) as total,
            MIN(bill_date) as oldest_bill, MAX(overdue_days) as max_overdue,
            SUM(CASE WHEN overdue_days > 0 THEN outstanding_amount ELSE 0 END) as overdue_total
     FROM vcfo_bills_outstanding
     WHERE company_id IN (${idPh(ids)}) AND nature = ?
     GROUP BY party_name
     ORDER BY total DESC`,
    ...ids, nature
  );

  // Individual bills (top 100)
  const bills = db.all(
    `SELECT party_name, reference_number, bill_date, outstanding_amount, overdue_days
     FROM vcfo_bills_outstanding
     WHERE company_id IN (${idPh(ids)}) AND nature = ?
     ORDER BY outstanding_amount DESC
     LIMIT 100`,
    ...ids, nature
  );

  res.json({ summary, aging, parties, bills });
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── CFO Performance Review ──────────────────────────────────────────────────

router.get('/cfo-review/preview', (req: Request, res: Response) => {
  try {
    const db = req.tenantDb!;
    const groupId = Number(req.query.groupId);
    if (!groupId) return res.status(400).json({ error: 'groupId required' });

    const from = (req.query.fromDate as string) || '2024-04-01';
    const to = (req.query.toDate as string) || '2025-03-31';

    const ids = resolveGroupMemberIds(db, groupId);
    if (!ids || !ids.length) return res.json({ noData: true });

    // Filter by geo if params present
    const filteredIds = resolveIds(db, req.query);
    const effectiveIds = filteredIds && filteredIds.length
      ? filteredIds.filter(id => ids.includes(id))
      : ids;
    if (!effectiveIds.length) return res.json({ noData: true });

    const curMonthEnd = to;
    const curMonthStart = startOfMonth(to);
    const priorEnd = endOfMonth(subtractMonth(to, 1));
    const priorStart = startOfMonth(priorEnd);

    // Company details
    const companyRows = db.all(
      `SELECT id, name, city, location, entity_type, state
       FROM vcfo_companies WHERE id IN (${idPh(effectiveIds)}) AND is_active = 1
       ORDER BY entity_type, location, name`,
      ...effectiveIds
    );

    // Compute KPI per company
    const units = companyRows.map((comp: any) => {
      const kpi = computeKPIData(db, [comp.id], curMonthStart, curMonthEnd);
      const totalIncome = (kpi.revenue || 0) + (kpi.directIncome || 0);
      const gpPct = totalIncome ? ((kpi.grossProfit || 0) / totalIncome * 100) : 0;
      const npPct = totalIncome ? ((kpi.netProfit || 0) / totalIncome * 100) : 0;
      let status = 'Healthy';
      if ((kpi.netProfit || 0) < -50000) status = 'Critical';
      else if ((kpi.netProfit || 0) < 0) status = 'Attention';

      return {
        companyId: comp.id, name: comp.name, city: comp.city,
        location: comp.location, entityType: comp.entity_type,
        revenue: kpi.revenue || 0, directIncome: kpi.directIncome || 0,
        purchase: kpi.purchase || 0, directExpenses: kpi.directExpenses || 0,
        indirectExpenses: kpi.indirectExpenses || 0, indirectIncome: kpi.indirectIncome || 0,
        openingStock: kpi.openingStock || 0, closingStock: kpi.closingStock || 0,
        grossProfit: kpi.grossProfit || 0, netProfit: kpi.netProfit || 0,
        cashBankBalance: kpi.cashBankBalance || 0,
        totalExpenses: (kpi.purchase || 0) + (kpi.directExpenses || 0) + (kpi.indirectExpenses || 0),
        gpPct, npPct, status,
      };
    });

    // Apply allocation rules
    const allocRules = db.all(
      'SELECT * FROM vcfo_allocation_rules WHERE group_id = ? AND is_active = 1 ORDER BY sort_order',
      groupId
    );
    for (const rule of allocRules) {
      const config = JSON.parse((rule as any).config || '{}');
      applyAllocationRule(db, units, (rule as any).rule_type, config, from, to);
    }

    // Recompute after allocations
    units.forEach((u: any) => {
      const totalIncome = (u.revenue || 0) + (u.directIncome || 0);
      u.netProfit = (u.grossProfit || 0) + (u.indirectIncome || 0) - (u.indirectExpenses || 0);
      u.totalExpenses = (u.purchase || 0) + (u.directExpenses || 0) + (u.indirectExpenses || 0);
      u.gpPct = totalIncome ? (u.grossProfit / totalIncome * 100) : 0;
      u.npPct = totalIncome ? (u.netProfit / totalIncome * 100) : 0;
      if (u.netProfit < -50000) u.status = 'Critical';
      else if (u.netProfit < 0) u.status = 'Attention';
      else u.status = 'Healthy';
    });

    // Consolidated KPIs
    const consolidated = computeKPIData(db, effectiveIds, curMonthStart, curMonthEnd);
    const priorConsolidated = computeKPIData(db, effectiveIds, priorStart, priorEnd);

    // Stock per unit
    const stockByUnit: any[] = [];
    for (const comp of companyRows) {
      const stockRow: any = db.get(
        `SELECT SUM(closing_value) as cv FROM vcfo_stock_summary
         WHERE company_id = ? AND period_to = (SELECT MAX(period_to) FROM vcfo_stock_summary WHERE company_id = ? AND period_to <= ?)`,
        (comp as any).id, (comp as any).id, curMonthEnd
      );
      if (stockRow && stockRow.cv) {
        stockByUnit.push({ companyId: (comp as any).id, companyName: (comp as any).name, closingValue: Math.abs(stockRow.cv) });
      }
    }
    stockByUnit.sort((a, b) => b.closingValue - a.closingValue);

    // Group info
    const groupInfo: any = db.get('SELECT name FROM vcfo_company_groups WHERE id = ?', groupId);
    const groupName = groupInfo?.name || 'Company Group';
    const cities = [...new Set(companyRows.map((c: any) => c.city).filter(Boolean))];
    const cityLabel = cities.length === 1 ? `${cities[0]} Network` : `${cities.length}-City Network`;

    // Auto narrative
    const narrative: string[] = [];
    const totalRev = (consolidated.revenue || 0) + (consolidated.directIncome || 0);
    const priorRev = (priorConsolidated.revenue || 0) + (priorConsolidated.directIncome || 0);
    const revGrowth = priorRev ? ((totalRev - priorRev) / Math.abs(priorRev) * 100) : 0;
    if (revGrowth) narrative.push(`Total Operating Income: ${fmtLakhs(totalRev)}L (${revGrowth >= 0 ? '+' : ''}${revGrowth.toFixed(1)}% MoM)`);
    const gpPctCons = totalRev ? ((consolidated.grossProfit || 0) / totalRev * 100) : 0;
    narrative.push(`GP Margin: ${gpPctCons.toFixed(1)}%`);
    narrative.push(`Net Profit: ${fmtLakhs(consolidated.netProfit || 0)}L`);
    narrative.push(`Cash & Bank: ${fmtLakhs(consolidated.cashBankBalance || 0)}L`);
    const lossMaking = units.filter((u: any) => u.netProfit < 0);
    if (lossMaking.length) {
      narrative.push(`${lossMaking.length} loss-making unit(s)`);
    }

    // Action items
    const actionItems: string[] = [];
    lossMaking.forEach((u: any) => {
      actionItems.push(`${u.name}: Develop turnaround plan. Current NP: ${fmtLakhs(u.netProfit)}L`);
    });

    // Rating
    const profitableCount = units.filter((u: any) => u.netProfit > 0).length;
    const profitablePct = units.length ? (profitableCount / units.length * 100) : 0;
    const npMargin = totalRev ? ((consolidated.netProfit || 0) / totalRev * 100) : 0;
    let rating = 'Needs Attention';
    if (profitablePct >= 90 && npMargin >= 10) rating = 'Excellent';
    else if (profitablePct >= 75 && npMargin >= 5) rating = 'Good';
    else if (profitablePct >= 50 && npMargin >= 0) rating = 'Fair';

    res.json({
      groupName, cityLabel,
      filterLabel: buildFilterLabel(req.query),
      period: { from: curMonthStart, to: curMonthEnd },
      generatedAt: new Date().toISOString(),
      rating, narrative, actionItems, units,
      consolidated, priorConsolidated,
      stockByUnit,
      allocationsApplied: allocRules.length > 0,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── CFO Insights Report ─────────────────────────────────────────────────────

router.get('/cfo-insights/preview', (req: Request, res: Response) => {
  try {
    const db = req.tenantDb!;
    const groupId = Number(req.query.groupId);
    if (!groupId) return res.status(400).json({ error: 'groupId required' });

    const from = (req.query.fromDate as string) || '2024-04-01';
    const to = (req.query.toDate as string) || '2025-03-31';

    const ids = resolveGroupMemberIds(db, groupId);
    if (!ids || !ids.length) return res.json({ noData: true });

    const filteredIds = resolveIds(db, req.query);
    const effectiveIds = filteredIds && filteredIds.length
      ? filteredIds.filter(id => ids.includes(id))
      : ids;
    if (!effectiveIds.length) return res.json({ noData: true });

    const curMonthEnd = to;
    const curMonthStart = startOfMonth(to);
    const priorEnd = endOfMonth(subtractMonth(to, 1));
    const priorStart = startOfMonth(priorEnd);
    const smlyEnd = endOfMonth(subtractYear(curMonthEnd, 1));
    const smlyStart = startOfMonth(smlyEnd);
    const sixMAgo = startOfMonth(subtractMonth(to, 5));

    // Section 1: Executive Summary
    const currentKPI = computeKPIData(db, effectiveIds, curMonthStart, curMonthEnd);
    const priorKPI = computeKPIData(db, effectiveIds, priorStart, priorEnd);
    const ytdKPI = computeKPIData(db, effectiveIds, from, to);

    // Section 2: P&L Comparison
    const smlyKPI = computeKPIData(db, effectiveIds, smlyStart, smlyEnd);
    const plComparison = {
      currentLabel: monthLabel(curMonthStart),
      priorLabel: monthLabel(priorStart),
      smlyLabel: monthLabel(smlyStart),
      current: currentKPI, prior: priorKPI, smly: smlyKPI
    };

    // Revenue Concentration
    const lgMap = buildLedgerGroupMap(db, effectiveIds);
    const { directCredit, directDebit, indirectDebit } = buildPLGroupSets(db, effectiveIds);
    const tbLedgers = getLedgerFlowsTB(db, effectiveIds, from, to);
    const salesGroupSet = new Set(getGroupTree(db, effectiveIds, 'Sales Accounts'));
    const topRevenue = getTopLedgers(tbLedgers, lgMap, salesGroupSet, 5, false);
    const totalRevForConc = Math.abs(ytdKPI.revenue || 0) || 0;
    const revenueConcentration = totalRevForConc === 0 ? [] : topRevenue.map((r: any) => ({
      name: r.ledger_name, amount: r.total,
      pct: Math.min(100, (r.total / totalRevForConc * 100)).toFixed(1)
    }));

    // Expense Breakdowns
    const directExpByGroup = getTotalsByGroup(tbLedgers, lgMap, directDebit, true);
    const totalDirectExp = directExpByGroup.reduce((s, r) => s + r.total, 0) || 1;
    const directExpenseBreakdown = directExpByGroup.slice(0, 10).map(r => ({
      name: r.category, amount: r.total, pct: (r.total / totalDirectExp * 100).toFixed(1)
    }));

    const indirectExpByGroup = getTotalsByGroup(tbLedgers, lgMap, indirectDebit, true);
    const totalIndirectExp = indirectExpByGroup.reduce((s, r) => s + r.total, 0) || 1;
    const indirectExpenseBreakdown = indirectExpByGroup.slice(0, 10).map(r => ({
      name: r.category, amount: r.total, pct: (r.total / totalIndirectExp * 100).toFixed(1)
    }));

    // Monthly trend data
    const trendData = computeMonthlyTrendData(db, effectiveIds, sixMAgo, to);

    // Section 3: Liquidity
    const cashGroups = getGroupTree(db, effectiveIds, 'Cash-in-Hand');
    const bankGroups = getGroupTree(db, effectiveIds, 'Bank Accounts');
    const priorCashBal = -(computeBSClosing(db, effectiveIds, priorEnd, [...cashGroups, ...bankGroups], null, lgMap));
    const cashPosition = {
      opening: priorCashBal,
      closing: currentKPI.cashBankBalance || 0,
      netChange: (currentKPI.cashBankBalance || 0) - priorCashBal
    };

    // AR/AP Ageing
    const arAgeing = db.all(
      `SELECT party_name,
          SUM(CASE WHEN overdue_days <= 30 THEN ABS(outstanding_amount) ELSE 0 END) as "0_30",
          SUM(CASE WHEN overdue_days > 30 AND overdue_days <= 60 THEN ABS(outstanding_amount) ELSE 0 END) as "31_60",
          SUM(CASE WHEN overdue_days > 60 AND overdue_days <= 90 THEN ABS(outstanding_amount) ELSE 0 END) as "61_90",
          SUM(CASE WHEN overdue_days > 90 THEN ABS(outstanding_amount) ELSE 0 END) as "90_plus",
          SUM(ABS(outstanding_amount)) as total
      FROM vcfo_bills_outstanding WHERE company_id IN (${idPh(effectiveIds)}) AND nature = 'receivable'
      GROUP BY party_name ORDER BY total DESC LIMIT 15`,
      ...effectiveIds
    );

    const apAgeing = db.all(
      `SELECT party_name,
          SUM(CASE WHEN overdue_days <= 30 THEN ABS(outstanding_amount) ELSE 0 END) as "0_30",
          SUM(CASE WHEN overdue_days > 30 AND overdue_days <= 60 THEN ABS(outstanding_amount) ELSE 0 END) as "31_60",
          SUM(CASE WHEN overdue_days > 60 AND overdue_days <= 90 THEN ABS(outstanding_amount) ELSE 0 END) as "61_90",
          SUM(CASE WHEN overdue_days > 90 THEN ABS(outstanding_amount) ELSE 0 END) as "90_plus",
          SUM(ABS(outstanding_amount)) as total
      FROM vcfo_bills_outstanding WHERE company_id IN (${idPh(effectiveIds)}) AND nature = 'payable'
      GROUP BY party_name ORDER BY total DESC LIMIT 15`,
      ...effectiveIds
    );

    // Section 4: GST Summary
    let gstSummary: any = null;
    try {
      const gstRows = db.all(
        `SELECT voucher_type, COUNT(*) as count, SUM(taxable_value) as taxable,
                SUM(igst) as igst, SUM(cgst) as cgst, SUM(sgst) as sgst, SUM(cess) as cess
         FROM vcfo_gst_entries WHERE company_id IN (${idPh(effectiveIds)}) AND date >= ? AND date <= ?
         GROUP BY voucher_type ORDER BY taxable DESC`,
        ...effectiveIds, from, to
      );
      if (gstRows.length > 0) gstSummary = gstRows;
    } catch { /* GST module not synced */ }

    // Compliance Calendar
    const complianceCalendar = buildComplianceCalendar();

    res.json({
      title: 'CFO Insights Report',
      filterLabel: buildFilterLabel(req.query),
      period: { from, to },
      generatedAt: new Date().toISOString(),
      plComparison,
      revenueConcentration,
      directExpenseBreakdown,
      indirectExpenseBreakdown,
      trendData,
      cashPosition,
      arAgeing, apAgeing,
      gstSummary,
      complianceCalendar,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Compliance Calendar (static, next 60 days) ─────────────────────────────

function buildComplianceCalendar() {
  const now = new Date();
  const items = [
    { day: 7, desc: 'TDS/TCS deposit for previous month' },
    { day: 11, desc: 'GSTR-1 filing (monthly filers)' },
    { day: 13, desc: 'GSTR-1 filing (QRMP scheme)' },
    { day: 15, desc: 'Advance Tax installment (Jun 15, Sep 15, Dec 15, Mar 15)' },
    { day: 20, desc: 'GSTR-3B filing (monthly filers)' },
    { day: 25, desc: 'GSTR-3B filing (QRMP scheme)' },
    { day: 30, desc: 'TDS return (Form 24Q/26Q) — quarterly' },
  ];
  const calendar: { date: string; description: string }[] = [];
  for (let m = 0; m < 2; m++) {
    const d = new Date(now.getFullYear(), now.getMonth() + m, 1);
    for (const item of items) {
      const maxDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      const dt = new Date(d.getFullYear(), d.getMonth(), Math.min(item.day, maxDay));
      if (dt >= now && dt <= new Date(now.getTime() + 60 * 86400000)) {
        calendar.push({
          date: dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
          description: item.desc
        });
      }
    }
  }
  return calendar;
}

export default router;
