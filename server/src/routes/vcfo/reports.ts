/**
 * VCFO Reports — Structured P&L, Balance Sheet, and Cash Flow statements
 * Generates hierarchical financial statements from synced Tally data.
 */
import { Router, Request, Response } from 'express';
import type { DbHelper } from '../../db/connection.js';

const router = Router();

function idPh(ids: number[]): string {
  return ids.map(() => '?').join(',');
}

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

// ── Profit & Loss Statement ──────────────────────────────────────────────────

router.get('/profit-loss', (req: Request, res: Response) => {
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
});

// ── Monthly P&L Comparison ───────────────────────────────────────────────────

router.get('/profit-loss/monthly', (req: Request, res: Response) => {
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
});

// ── Balance Sheet ────────────────────────────────────────────────────────────

router.get('/balance-sheet', (req: Request, res: Response) => {
  const db = req.tenantDb!;
  const asOnDate = req.query.date as string;
  if (!asOnDate) return res.status(400).json({ error: 'date required' });

  const ids = resolveCompanyIds(db, req);
  if (!ids || ids.length === 0) return res.json({ sections: [], noData: true });

  // Get BS group classifications
  const allGroups = db.all(
    `SELECT DISTINCT group_name, parent_group, bs_pl FROM vcfo_account_groups WHERE company_id IN (${idPh(ids)})`,
    ...ids
  );

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
     WHERE company_id IN (${idPh(ids)}) AND as_on_date <= ?
     GROUP BY ledger_name, group_name
     HAVING as_on_date = (SELECT MAX(as_on_date) FROM vcfo_balance_sheet WHERE company_id IN (${idPh(ids)}) AND as_on_date <= ?)
     ORDER BY group_name, ledger_name`,
    ...ids, asOnDate, ...ids, asOnDate
  );

  // If no BS data, fall back to TB closing balances
  if (bsRows.length === 0) {
    bsRows = db.all(
      `SELECT ledger_name, group_name, SUM(closing_balance) as closing_balance
       FROM vcfo_trial_balance
       WHERE company_id IN (${idPh(ids)}) AND period_to <= ?
       GROUP BY ledger_name, group_name
       HAVING period_to = (SELECT MAX(period_to) FROM vcfo_trial_balance WHERE company_id IN (${idPh(ids)}) AND period_to <= ?)
       ORDER BY group_name, ledger_name`,
      ...ids, asOnDate, ...ids, asOnDate
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
});

// ── Bills Outstanding (Receivables & Payables) ───────────────────────────────

router.get('/bills-outstanding', (req: Request, res: Response) => {
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
});

export default router;
