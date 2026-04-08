/**
 * VCFO KPI Engine — Ported from TallyVision server.js (lines 344-750)
 * Core financial computation functions for dashboard KPIs, charts, and reports.
 * All table names use vcfo_ prefix for Vision's unified tenant DB.
 */

import { DbHelper } from '../../db/connection.js';
import { idPh } from './company-resolver.js';

// ── Group Tree ──

/** Get all child groups of a parent (recursive tree walk) */
export function getGroupTree(db: DbHelper, ids: number[], parentName: string): string[] {
  const allGroups: any[] = db.all(
    `SELECT DISTINCT group_name, parent_group FROM vcfo_account_groups WHERE company_id IN (${idPh(ids)})`,
    ...ids
  );
  const result = new Set<string>([parentName]);
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

// ── Ledger-Group Mapping ──

/** Build ledger_name → group_name map from trial_balance */
export function buildLedgerGroupMap(db: DbHelper, ids: number[]): Record<string, string> {
  const rows: any[] = db.all(
    `SELECT DISTINCT company_id, ledger_name, group_name FROM vcfo_trial_balance WHERE company_id IN (${idPh(ids)})`,
    ...ids
  );
  const map: Record<string, string> = {};
  rows.forEach(r => { map[`${r.company_id}|${r.ledger_name}`] = r.group_name; });
  return map;
}

// ── P&L Group Sets ──

interface PLGroupSets {
  directCredit: Set<string>;
  indirectCredit: Set<string>;
  directDebit: Set<string>;
  indirectDebit: Set<string>;
}

/** Build P&L group sets using account_groups metadata */
export function buildPLGroupSets(db: DbHelper, ids: number[]): PLGroupSets {
  const groups: any[] = db.all(
    `SELECT group_name, dr_cr, affects_gross_profit, COUNT(*) as cnt
     FROM vcfo_account_groups WHERE company_id IN (${idPh(ids)}) AND bs_pl = 'PL'
     GROUP BY group_name, dr_cr, affects_gross_profit`,
    ...ids
  );
  const best: Record<string, any> = {};
  for (const g of groups) {
    if (!best[g.group_name] || g.cnt > best[g.group_name].cnt) {
      best[g.group_name] = g;
    }
  }
  const sets: PLGroupSets = {
    directCredit: new Set(), indirectCredit: new Set(),
    directDebit: new Set(), indirectDebit: new Set()
  };
  for (const g of Object.values(best)) {
    if      (g.dr_cr === 'C' && g.affects_gross_profit === 'Y') sets.directCredit.add(g.group_name);
    else if (g.dr_cr === 'C' && g.affects_gross_profit === 'N') sets.indirectCredit.add(g.group_name);
    else if (g.dr_cr === 'D' && g.affects_gross_profit === 'Y') sets.directDebit.add(g.group_name);
    else if (g.dr_cr === 'D' && g.affects_gross_profit === 'N') sets.indirectDebit.add(g.group_name);
  }
  return sets;
}

// ── TB Supplement ──

export function getTBSupplement(db: DbHelper, ids: number[], from: string, to: string): any[] {
  return db.all(`
    SELECT company_id, ledger_name, group_name,
           SUM(net_debit) AS net_debit,
           SUM(net_credit) AS net_credit
    FROM vcfo_trial_balance t
    WHERE company_id IN (${idPh(ids)})
      AND period_from >= ?
      AND period_to   <= ?
      AND group_name IS NOT NULL
      AND NOT EXISTS (
          SELECT 1 FROM vcfo_trial_balance t2
          WHERE t2.company_id = t.company_id
            AND t2.ledger_name = t.ledger_name
            AND t2.period_from = t.period_from
            AND t2.period_to < t.period_to
      )
    GROUP BY company_id, ledger_name, group_name
  `, ...ids, from, to);
}

// ── P&L Fallback ──

export function getPLFallback(db: DbHelper, ids: number[], from: string, to: string): any[] {
  return db.all(`
    SELECT company_id, ledger_name, group_name, SUM(amount) as amount
    FROM vcfo_profit_loss
    WHERE company_id IN (${idPh(ids)})
      AND period_from >= ?
      AND period_to   <= ?
      AND group_name IS NOT NULL
    GROUP BY company_id, ledger_name, group_name
  `, ...ids, from, to);
}

// ── Voucher Queries ──

export function getVouchersByLedger(db: DbHelper, ids: number[], fromDate: string, toDate: string): any[] {
  return db.all(`
    SELECT company_id, ledger_name, SUM(amount) as total
    FROM vcfo_vouchers
    WHERE company_id IN (${idPh(ids)}) AND date >= ? AND date <= ? AND ledger_name != ''
    GROUP BY company_id, ledger_name
  `, ...ids, fromDate, toDate);
}

export function getLedgerFlowsTB(db: DbHelper, ids: number[], fromDate: string, toDate: string): any[] {
  return db.all(`
    SELECT company_id, ledger_name,
           SUM(net_credit) - SUM(net_debit) as total
    FROM vcfo_trial_balance t
    WHERE company_id IN (${idPh(ids)})
      AND period_from >= ? AND period_to <= ?
      AND group_name IS NOT NULL
      AND NOT EXISTS (
          SELECT 1 FROM vcfo_trial_balance t2
          WHERE t2.company_id = t.company_id
            AND t2.ledger_name = t.ledger_name
            AND t2.period_from = t.period_from
            AND t2.period_to < t.period_to
      )
    GROUP BY company_id, ledger_name
  `, ...ids, fromDate, toDate);
}

// ── P&L Flow Computation ──

export function computePLFlow(
  vouchersByLedger: any[],
  lgMap: Record<string, string>,
  groupSet: Set<string>
): number {
  let total = 0;
  for (const row of vouchersByLedger) {
    const grp = lgMap[`${row.company_id}|${row.ledger_name}`];
    if (grp && groupSet.has(grp)) {
      total += row.total;
    }
  }
  return total;
}

// ── BS Closing Balance ──

export function computeBSClosing(
  db: DbHelper,
  ids: number[],
  asOfDate: string,
  groupNames: string[],
  balanceFilter: string | null,
  lgMap: Record<string, string>
): number {
  if (!groupNames.length) return 0;
  const groupSet = new Set(groupNames);
  const grPh = groupNames.map(() => '?').join(',');

  const tbMonth: any = db.get(`
    SELECT DISTINCT period_from, period_to FROM vcfo_trial_balance
    WHERE company_id IN (${idPh(ids)}) AND period_from <= ?
    ORDER BY period_from DESC LIMIT 1
  `, ...ids, asOfDate);

  if (!tbMonth) return 0;

  const tbRows: any[] = db.all(`
    SELECT ledger_name, SUM(opening_balance) as opening_balance FROM vcfo_trial_balance
    WHERE company_id IN (${idPh(ids)}) AND period_from = ? AND group_name IN (${grPh})
    GROUP BY ledger_name
  `, ...ids, tbMonth.period_from, ...groupNames);

  const vRows: any[] = db.all(`
    SELECT company_id, ledger_name, SUM(amount) as movement
    FROM vcfo_vouchers
    WHERE company_id IN (${idPh(ids)}) AND date >= ? AND date <= ? AND ledger_name != ''
    GROUP BY company_id, ledger_name
  `, ...ids, tbMonth.period_from, asOfDate);

  const movementMap: Record<string, number> = {};
  for (const r of vRows) {
    const grp = lgMap[`${r.company_id}|${r.ledger_name}`];
    if (grp && groupSet.has(grp)) {
      movementMap[r.ledger_name] = (movementMap[r.ledger_name] || 0) + r.movement;
    }
  }

  let total = 0;
  const ledgersSeen = new Set<string>();

  for (const r of tbRows) {
    ledgersSeen.add(r.ledger_name);
    const closing = r.opening_balance + (movementMap[r.ledger_name] || 0);
    if (balanceFilter === 'debit' && closing < 0) total += closing;
    else if (balanceFilter === 'credit' && closing > 0) total += closing;
    else if (!balanceFilter) total += closing;
  }

  for (const [ledger, movement] of Object.entries(movementMap)) {
    if (!ledgersSeen.has(ledger)) {
      if (balanceFilter === 'debit' && movement < 0) total += movement;
      else if (balanceFilter === 'credit' && movement > 0) total += movement;
      else if (!balanceFilter) total += movement;
    }
  }

  return total;
}

// ── Top Ledgers ──

export function getTopLedgers(
  vouchersByLedger: any[],
  lgMap: Record<string, string>,
  groupSet: Set<string>,
  limit?: number,
  negate?: boolean
): any[] {
  const merged: Record<string, any> = {};
  for (const row of vouchersByLedger) {
    const grp = lgMap[`${row.company_id}|${row.ledger_name}`];
    if (grp && groupSet.has(grp)) {
      const val = negate ? -row.total : row.total;
      if (val > 0) {
        const key = `${grp}||${row.ledger_name}`;
        if (!merged[key]) {
          merged[key] = { ledger_name: row.ledger_name, group_name: grp, total: 0 };
        }
        merged[key].total += val;
      }
    }
  }
  const results = Object.values(merged);
  results.sort((a, b) => b.total - a.total);
  return results.slice(0, limit || 10);
}

// ── Totals by Group ──

export function getTotalsByGroup(
  vouchersByLedger: any[],
  lgMap: Record<string, string>,
  groupSet: Set<string>,
  negate?: boolean
): any[] {
  const groupTotals: Record<string, number> = {};
  for (const row of vouchersByLedger) {
    const grp = lgMap[`${row.company_id}|${row.ledger_name}`];
    if (grp && groupSet.has(grp)) {
      groupTotals[grp] = (groupTotals[grp] || 0) + row.total;
    }
  }
  const results: any[] = [];
  for (const [category, total] of Object.entries(groupTotals)) {
    const val = negate ? -total : total;
    if (val > 0) results.push({ category, total: val });
  }
  results.sort((a, b) => b.total - a.total);
  return results;
}

// ── Monthly Data ──

export function getMonthlyVouchers(db: DbHelper, ids: number[], fromDate: string, toDate: string): any[] {
  return db.all(`
    SELECT company_id, strftime('%Y-%m-01', date) as month, ledger_name, SUM(amount) as total
    FROM vcfo_vouchers
    WHERE company_id IN (${idPh(ids)}) AND date >= ? AND date <= ? AND ledger_name != ''
    GROUP BY company_id, strftime('%Y-%m', date), ledger_name
  `, ...ids, fromDate, toDate);
}

export function getMonthlyFlowsTB(db: DbHelper, ids: number[], fromDate: string, toDate: string): any[] {
  return db.all(`
    SELECT company_id, period_from as month, ledger_name,
           SUM(net_credit) - SUM(net_debit) as total
    FROM vcfo_trial_balance t
    WHERE company_id IN (${idPh(ids)})
      AND period_from >= ? AND period_to <= ?
      AND group_name IS NOT NULL
      AND NOT EXISTS (
          SELECT 1 FROM vcfo_trial_balance t2
          WHERE t2.company_id = t.company_id
            AND t2.ledger_name = t.ledger_name
            AND t2.period_from = t.period_from
            AND t2.period_to < t.period_to
      )
    GROUP BY company_id, period_from, ledger_name
  `, ...ids, fromDate, toDate);
}

// ── Composite KPI Computation ──

export interface KPIData {
  revenue: number;
  directIncome: number;
  purchase: number;
  directExpenses: number;
  indirectExpenses: number;
  indirectIncome: number;
  openingStock: number;
  closingStock: number;
  grossProfit: number;
  netProfit: number;
  cashBankBalance: number;
  receivables: number;
  payables: number;
}

/**
 * Compute full KPI data for a set of company IDs and date range.
 * This is the core function used by the dashboard, CFO review, and reports.
 */
export function computeKPIData(db: DbHelper, ids: number[], from: string, to: string): KPIData {
  const plSets = buildPLGroupSets(db, ids);
  const lgMap = buildLedgerGroupMap(db, ids);

  // Primary: voucher data
  const vbl = getVouchersByLedger(db, ids, from, to);
  let revenue = computePLFlow(vbl, lgMap, plSets.directCredit);
  let directIncome = 0; // Split from revenue if needed
  let purchase = -computePLFlow(vbl, lgMap, plSets.directDebit);
  let directExpenses = 0;
  let indirectExpenses = -computePLFlow(vbl, lgMap, plSets.indirectDebit);
  let indirectIncome = computePLFlow(vbl, lgMap, plSets.indirectCredit);

  // TB supplement for ledgers with no vouchers
  const tbSupp = getTBSupplement(db, ids, from, to);
  const vblLedgerKeys = new Set(vbl.map(r => `${r.company_id}|${r.ledger_name}`));

  for (const tb of tbSupp) {
    const key = `${tb.company_id}|${tb.ledger_name}`;
    if (vblLedgerKeys.has(key)) continue; // Already captured via vouchers
    const net = tb.net_credit - tb.net_debit;
    if (plSets.directCredit.has(tb.group_name)) revenue += net;
    else if (plSets.indirectCredit.has(tb.group_name)) indirectIncome += net;
    else if (plSets.directDebit.has(tb.group_name)) purchase += net; // net is negative for debits
    else if (plSets.indirectDebit.has(tb.group_name)) indirectExpenses += net;
  }

  // P&L fallback if voucher+TB yield near-zero
  const totalFromVouchers = Math.abs(revenue) + Math.abs(purchase) + Math.abs(indirectExpenses) + Math.abs(indirectIncome);
  if (totalFromVouchers < 100) {
    const plRows = getPLFallback(db, ids, from, to);
    revenue = 0; purchase = 0; indirectExpenses = 0; indirectIncome = 0;
    for (const r of plRows) {
      if (plSets.directCredit.has(r.group_name)) revenue += r.amount;
      else if (plSets.indirectCredit.has(r.group_name)) indirectIncome += r.amount;
      else if (plSets.directDebit.has(r.group_name)) purchase += r.amount;
      else if (plSets.indirectDebit.has(r.group_name)) indirectExpenses += r.amount;
    }
    purchase = -purchase;
    indirectExpenses = -indirectExpenses;
  }

  // Stock values
  const stockRow: any = db.get(`
    SELECT
      SUM(CASE WHEN period_from = ? THEN opening_value ELSE 0 END) as opening,
      SUM(CASE WHEN period_to = (SELECT MAX(period_to) FROM vcfo_stock_summary WHERE company_id IN (${idPh(ids)}) AND period_to <= ?) THEN closing_value ELSE 0 END) as closing
    FROM vcfo_stock_summary
    WHERE company_id IN (${idPh(ids)})
  `, from, ...ids, to, ...ids);
  const openingStock = Math.abs(stockRow?.opening || 0);
  const closingStock = Math.abs(stockRow?.closing || 0);

  // Gross profit
  const grossProfit = revenue + directIncome - purchase - directExpenses + closingStock - openingStock;
  const netProfit = grossProfit + indirectIncome - indirectExpenses;

  // BS items: Cash & Bank, Receivables, Payables
  const cashGroups = getGroupTree(db, ids, 'Cash-in-Hand').concat(getGroupTree(db, ids, 'Bank Accounts'));
  const cashBankBalance = computeBSClosing(db, ids, to, cashGroups, null, lgMap);

  const receivableGroups = getGroupTree(db, ids, 'Sundry Debtors');
  const receivables = computeBSClosing(db, ids, to, receivableGroups, 'debit', lgMap);

  const payableGroups = getGroupTree(db, ids, 'Sundry Creditors');
  const payables = computeBSClosing(db, ids, to, payableGroups, 'credit', lgMap);

  return {
    revenue, directIncome, purchase, directExpenses,
    indirectExpenses, indirectIncome, openingStock, closingStock,
    grossProfit, netProfit, cashBankBalance,
    receivables: Math.abs(receivables), payables: Math.abs(payables),
  };
}
