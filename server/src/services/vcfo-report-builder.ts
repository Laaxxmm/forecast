// ─────────────────────────────────────────────────────────────────────────────
// VCFO Report Builder (Slice 5b).
//
// Pure, testable functions that derive the four core financial reports from
// the sync-agent tables (vcfo_trial_balance, vcfo_account_groups, vcfo_vouchers)
// in a tenant DB. Single-company scope — multi-company consolidation is an
// explicit non-goal (per the Slice 5 plan).
//
// Calculation approach (simplified from TallyVision's hybrid voucher+TB logic):
//   - Source of truth is `vcfo_trial_balance`. Each row is one ledger's
//     opening/debit/credit/closing for a (company, period_from, period_to)
//     window. The sync-agent writes one row per ledger per month.
//   - For a date range [from, to] we aggregate across all TB periods that
//     fall within it, per ledger:
//         net_movement = SUM(net_credit) - SUM(net_debit)
//     Credit-positive convention: income/liabilities come out positive,
//     expenses/assets come out negative.
//   - Group classification uses `vcfo_account_groups`:
//         bs_pl  → 'BS' (balance sheet) | 'PL' (profit & loss)
//         dr_cr  → 'D' (debit)           | 'C' (credit)
//         affects_gross_profit → 'Y'     | 'N'
//     directCredit  = PL+C+Y (Sales, Direct Income)
//     directDebit   = PL+D+Y (Purchase, Direct Expenses)
//     indirectCredit= PL+C+N (Indirect Income)
//     indirectDebit = PL+D+N (Indirect Expenses)
//
// Sign conventions (display-facing):
//   - Revenue, Direct Income, Indirect Income → positive
//   - Purchase, Direct Exp, Indirect Exp      → positive (abs of debit movement)
//   - Gross Profit, Net Profit                → positive if profitable
//   - Balance Sheet assets                    → positive on asset side
//   - Cash Flow deltas                        → positive = inflow
// ─────────────────────────────────────────────────────────────────────────────

import type { DbHelper } from '../db/connection.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TrialBalanceRow {
  ledgerName: string;
  groupName: string | null;
  opening: number;
  debit: number;
  credit: number;
  closing: number;
}

export interface TrialBalanceReport {
  period: { from: string; to: string };
  rows: TrialBalanceRow[];
  totals: { opening: number; debit: number; credit: number; closing: number };
}

export interface PLSection {
  key: string;
  label: string;
  isExpense: boolean;
  /** Per-column values for monthly view, or a single key 'total' for yearly. */
  values: Record<string, number>;
  grandTotal: number;
  /** If present, this is a parent row — the UI renders an expand toggle and
   *  shows these child rows (one per Tally account group, own ledgers under
   *  that category). Leaf sections omit this field. */
  children?: PLSection[];
}

export interface PLStatement {
  period: { from: string; to: string };
  view: 'yearly' | 'monthly';
  columns: string[]; // e.g. ['total'] for yearly, ['2025-04', '2025-05', …] monthly
  /** Human-friendly column labels. Same keys as `columns`; used by UI so that
   *  bifurcated views can show company names instead of "co:72". */
  columnLabels?: Record<string, string>;
  /** If true, columns represent companies (bifurcation). Otherwise periods. */
  bifurcated?: boolean;
  /** Which companies were rolled into this statement. Empty → single-company. */
  companies?: Array<{ id: number; name: string }>;
  sections: PLSection[];
  computed: {
    grossProfit: Record<string, number>;
    grossMargin: Record<string, number>;
    netProfit: Record<string, number>;
  };
  grandTotals: {
    revenue: number;
    directCosts: number;
    indirectIncome: number;
    indirectExpenses: number;
    grossProfit: number;
    netProfit: number;
  };
}

export interface BSSection {
  key: string;
  label: string;
  side: 'asset' | 'liability';
  /** Per-column closing balances. 'total' for yearly / 'YYYY-MM' for monthly. */
  values: Record<string, number>;
  grandTotal: number;
  /** Optional per-ledger (or per-sub-group) breakdown. The UI expands each
   *  parent on click to reveal children, same pattern as P&L. */
  children?: BSSection[];
}

export interface BSStatement {
  asOfDate: string;
  view: 'yearly' | 'monthly';
  columns: string[];
  columnLabels?: Record<string, string>;
  bifurcated?: boolean;
  companies?: Array<{ id: number; name: string }>;
  sections: BSSection[];
  totals: {
    totalAssets: Record<string, number>;
    totalLiabilities: Record<string, number>;
  };
}

export interface CFLine {
  label: string;
  amount: number;
  /** Per-column values when the statement is multi-column (bifurcated). */
  values?: Record<string, number>;
  /** Per-ledger contribution breakdown (expandable in the UI). */
  children?: CFLine[];
}

export interface CFStatement {
  period: { from: string; to: string };
  /** Optional column keys when bifurcation is enabled. Single-column mode omits. */
  columns?: string[];
  columnLabels?: Record<string, string>;
  bifurcated?: boolean;
  companies?: Array<{ id: number; name: string }>;
  operating: CFLine[];
  operatingTotal: number;
  operatingTotalValues?: Record<string, number>;
  investing: CFLine[];
  investingTotal: number;
  investingTotalValues?: Record<string, number>;
  financing: CFLine[];
  financingTotal: number;
  financingTotalValues?: Record<string, number>;
  netChange: number;
  netChangeValues?: Record<string, number>;
  openingCash: number;
  openingCashValues?: Record<string, number>;
  closingCash: number;
  closingCashValues?: Record<string, number>;
}

// ─── Group classification helpers ───────────────────────────────────────────

interface GroupSets {
  directCredit: Set<string>;
  directDebit: Set<string>;
  indirectCredit: Set<string>;
  indirectDebit: Set<string>;
}

/**
 * Classify every PL group in this company's chart-of-accounts by its
 * (dr_cr, affects_gross_profit) metadata. Catches custom groups — not
 * just the reserved Tally names.
 */
function buildPLGroupSets(db: DbHelper, companyId: number): GroupSets {
  const groups = db.all(
    `SELECT group_name, dr_cr, affects_gross_profit
     FROM vcfo_account_groups
     WHERE company_id = ? AND bs_pl = 'PL'`,
    companyId,
  );
  const sets: GroupSets = {
    directCredit: new Set(),
    directDebit: new Set(),
    indirectCredit: new Set(),
    indirectDebit: new Set(),
  };
  for (const g of groups) {
    if (g.dr_cr === 'C' && g.affects_gross_profit === 'Y') sets.directCredit.add(g.group_name);
    else if (g.dr_cr === 'D' && g.affects_gross_profit === 'Y') sets.directDebit.add(g.group_name);
    else if (g.dr_cr === 'C' && g.affects_gross_profit === 'N') sets.indirectCredit.add(g.group_name);
    else if (g.dr_cr === 'D' && g.affects_gross_profit === 'N') sets.indirectDebit.add(g.group_name);
  }
  return sets;
}

/**
 * Walk the group tree starting at `parentName` and return every descendant
 * (inclusive). Tally's chart is hierarchical — "Sundry Debtors" is itself a
 * group under which users nest sub-groups like "Debtors > Domestic".
 */
function getGroupTree(db: DbHelper, companyId: number, parentName: string): string[] {
  const allGroups = db.all(
    'SELECT group_name, parent_group FROM vcfo_account_groups WHERE company_id = ?',
    companyId,
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

// ─── Month helpers ──────────────────────────────────────────────────────────

/**
 * Split a [from, to] date range into monthly buckets: ["YYYY-MM", …].
 * Returns months whose start is within the range.
 */
function monthsInRange(from: string, to: string): string[] {
  const months: string[] = [];
  const start = new Date(from + 'T00:00:00');
  const end = new Date(to + 'T00:00:00');
  let y = start.getFullYear();
  let m = start.getMonth(); // 0-based
  while (y < end.getFullYear() || (y === end.getFullYear() && m <= end.getMonth())) {
    months.push(`${y}-${String(m + 1).padStart(2, '0')}`);
    m++;
    if (m > 11) { m = 0; y++; }
  }
  return months;
}

/** "2025-04" → {from: "2025-04-01", to: "2025-04-30"} */
function monthRange(monthStr: string): { from: string; to: string } {
  const [y, m] = monthStr.split('-').map(Number);
  const from = `${y}-${String(m).padStart(2, '0')}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const to = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return { from, to };
}

/** Previous day as YYYY-MM-DD (used for "opening" BS snapshot in cash flow). */
function dayBefore(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

// ─── Core builders ──────────────────────────────────────────────────────────

/**
 * Trial Balance — direct read from `vcfo_trial_balance`. For a multi-month
 * range we sum opening/debit/credit/closing across all the TB rows that fall
 * in the window. One row per ledger.
 *
 * Opening = earliest period's opening_balance
 * Closing = latest period's closing_balance
 * Debit/Credit = summed across all periods
 */
export function buildTrialBalance(
  db: DbHelper,
  companyId: number,
  from: string,
  to: string,
): TrialBalanceReport {
  // For each ledger, pick the earliest period's opening and latest period's
  // closing. Use SQL window-style aggregation emulated via MIN/MAX per ledger.
  const rows = db.all(
    `SELECT
       tb.ledger_name AS ledgerName,
       tb.group_name  AS groupName,
       SUM(tb.net_debit)  AS debit,
       SUM(tb.net_credit) AS credit,
       (SELECT opening_balance FROM vcfo_trial_balance
          WHERE company_id = tb.company_id AND ledger_name = tb.ledger_name
            AND period_from >= ? AND period_to <= ?
          ORDER BY period_from ASC LIMIT 1) AS opening,
       (SELECT closing_balance FROM vcfo_trial_balance
          WHERE company_id = tb.company_id AND ledger_name = tb.ledger_name
            AND period_from >= ? AND period_to <= ?
          ORDER BY period_to DESC LIMIT 1) AS closing
     FROM vcfo_trial_balance tb
     WHERE tb.company_id = ? AND tb.period_from >= ? AND tb.period_to <= ?
     GROUP BY tb.ledger_name, tb.group_name
     ORDER BY tb.group_name, tb.ledger_name`,
    [from, to, from, to, companyId, from, to],
  );

  const cleanRows: TrialBalanceRow[] = rows.map((r: any) => ({
    ledgerName: r.ledgerName,
    groupName: r.groupName || null,
    opening: Number(r.opening) || 0,
    debit: Number(r.debit) || 0,
    credit: Number(r.credit) || 0,
    closing: Number(r.closing) || 0,
  }));

  const totals = cleanRows.reduce(
    (acc, r) => ({
      opening: acc.opening + r.opening,
      debit: acc.debit + r.debit,
      credit: acc.credit + r.credit,
      closing: acc.closing + r.closing,
    }),
    { opening: 0, debit: 0, credit: 0, closing: 0 },
  );

  return { period: { from, to }, rows: cleanRows, totals };
}

/**
 * Net movement per ledger over [from, to], joined with its group_name.
 * Movement is credit-positive (net_credit - net_debit). Stock groups are
 * excluded — their effect is captured via the stock adjustment in GP.
 */
function getLedgerMovements(
  db: DbHelper,
  companyId: number,
  from: string,
  to: string,
): Array<{ ledgerName: string; groupName: string; movement: number }> {
  return db.all(
    `SELECT ledger_name AS ledgerName,
            group_name  AS groupName,
            SUM(net_credit) - SUM(net_debit) AS movement
     FROM vcfo_trial_balance
     WHERE company_id = ? AND period_from >= ? AND period_to <= ?
       AND group_name IS NOT NULL
     GROUP BY ledger_name, group_name`,
    companyId, from, to,
  );
}

/**
 * Opening + closing stock for a period (from earliest TB opening to latest
 * TB closing over Stock-in-Hand groups). Used for COGS correction in GP.
 */
function getStockAdjustment(
  db: DbHelper,
  companyId: number,
  from: string,
  to: string,
): { opening: number; closing: number; adjustment: number } {
  const stockGroups = getGroupTree(db, companyId, 'Stock-in-Hand');
  if (stockGroups.length === 0) return { opening: 0, closing: 0, adjustment: 0 };
  const ph = stockGroups.map(() => '?').join(',');

  const firstPF = db.get(
    `SELECT MIN(period_from) AS pf FROM vcfo_trial_balance
     WHERE company_id = ? AND group_name IN (${ph}) AND period_from >= ?`,
    [companyId, ...stockGroups, from],
  )?.pf;
  const openingRow = firstPF
    ? db.get(
        `SELECT SUM(opening_balance) AS v FROM vcfo_trial_balance
         WHERE company_id = ? AND group_name IN (${ph}) AND period_from = ?`,
        [companyId, ...stockGroups, firstPF],
      )
    : null;
  const opening = Number(openingRow?.v) || 0;

  const lastPT = db.get(
    `SELECT MAX(period_to) AS pt FROM vcfo_trial_balance
     WHERE company_id = ? AND group_name IN (${ph}) AND period_to <= ?`,
    [companyId, ...stockGroups, to],
  )?.pt;
  const closingRow = lastPT
    ? db.get(
        `SELECT SUM(closing_balance) AS v FROM vcfo_trial_balance
         WHERE company_id = ? AND group_name IN (${ph}) AND period_to = ?`,
        [companyId, ...stockGroups, lastPT],
      )
    : null;
  const closing = Number(closingRow?.v) || 0;

  // opening - closing: when closing stock > opening, stockAdjustment is negative
  // (more inventory on hand = less COGS consumed = better GP).
  return { opening, closing, adjustment: opening - closing };
}

/**
 * Compute one column's worth of P&L numbers for a date window.
 */
function computePLForPeriod(
  db: DbHelper,
  companyId: number,
  from: string,
  to: string,
  sets: GroupSets,
  salesGroups: Set<string>,
  purchaseGroups: Set<string>,
): {
  revenue: number; directIncome: number;
  purchase: number; directExpenses: number;
  indirectExpenses: number; indirectIncome: number;
  grossProfit: number; netProfit: number;
} {
  const movements = getLedgerMovements(db, companyId, from, to);
  let salesFlow = 0, purchaseFlow = 0;
  let dcFlow = 0, ddFlow = 0, icFlow = 0, idFlow = 0;

  for (const r of movements) {
    const grp = r.groupName;
    const mv = Number(r.movement) || 0;
    if (sets.directCredit.has(grp))  dcFlow += mv;
    if (sets.directDebit.has(grp))   ddFlow += mv;
    if (sets.indirectCredit.has(grp)) icFlow += mv;
    if (sets.indirectDebit.has(grp)) idFlow += mv;
    if (salesGroups.has(grp))    salesFlow += mv;
    if (purchaseGroups.has(grp)) purchaseFlow += mv;
  }

  const stock = getStockAdjustment(db, companyId, from, to);
  const grossProfit = dcFlow + ddFlow + stock.adjustment;
  const netProfit = grossProfit + icFlow + idFlow;

  // Card-friendly positive displays:
  //   revenue      = salesFlow (credit-positive)
  //   directIncome = dcFlow − salesFlow (other credit-PL-gp groups)
  //   purchase     = -purchaseFlow (debit is negative; flip to positive)
  //   directExp    = -(ddFlow − purchaseFlow)
  //   indirectExp  = -idFlow
  //   indirectInc  = icFlow
  return {
    revenue: salesFlow,
    directIncome: dcFlow - salesFlow,
    purchase: -purchaseFlow,
    directExpenses: -(ddFlow - purchaseFlow),
    indirectExpenses: -idFlow,
    indirectIncome: icFlow,
    grossProfit,
    netProfit,
  };
}

/**
 * Per-column group movements for a given group set. Returns
 * `{ [groupName]: { [col]: movement } }` in credit-positive convention —
 * callers apply display sign (flip for expense sides).
 */
function getGroupMovementsByColumn(
  db: DbHelper,
  companyId: number,
  groupNames: Set<string>,
  columns: string[],
  columnRange: (col: string) => { from: string; to: string },
): Map<string, Record<string, number>> {
  const out = new Map<string, Record<string, number>>();
  if (groupNames.size === 0) return out;
  const ph = [...groupNames].map(() => '?').join(',');
  for (const col of columns) {
    const { from, to } = columnRange(col);
    const rows = db.all(
      `SELECT group_name,
              SUM(net_credit) - SUM(net_debit) AS movement
       FROM vcfo_trial_balance
       WHERE company_id = ? AND period_from >= ? AND period_to <= ?
         AND group_name IN (${ph})
       GROUP BY group_name`,
      [companyId, from, to, ...groupNames],
    );
    for (const r of rows) {
      const mv = Number(r.movement) || 0;
      if (!out.has(r.group_name)) out.set(r.group_name, {});
      out.get(r.group_name)![col] = mv;
    }
  }
  return out;
}

/**
 * Build a parent P&L section from a set of Tally account groups. Emits one
 * child row per group that had nonzero movement in the window, sorted by
 * absolute contribution desc. Applies display sign (expense sides flip so
 * costs show as positive on screen).
 */
function buildPLSectionWithChildren(
  db: DbHelper,
  companyId: number,
  key: string,
  label: string,
  isExpense: boolean,
  displaySign: 1 | -1,
  groupSet: Set<string>,
  columns: string[],
  columnRange: (col: string) => { from: string; to: string },
): PLSection {
  const parentValues: Record<string, number> = {};
  for (const c of columns) parentValues[c] = 0;

  const raw = getGroupMovementsByColumn(db, companyId, groupSet, columns, columnRange);
  const children: PLSection[] = [];
  for (const [groupName, perCol] of raw.entries()) {
    const values: Record<string, number> = {};
    let grandTotal = 0;
    for (const c of columns) {
      const v = (perCol[c] || 0) * displaySign;
      values[c] = v;
      grandTotal += v;
      parentValues[c] += v;
    }
    if (Math.abs(grandTotal) < 0.01) continue; // skip dormant groups
    children.push({
      key: `${key}:${groupName}`,
      label: groupName,
      isExpense,
      values,
      grandTotal,
    });
  }
  children.sort((a, b) => Math.abs(b.grandTotal) - Math.abs(a.grandTotal));

  const parentGrandTotal = columns.reduce((s, c) => s + parentValues[c], 0);
  return {
    key,
    label,
    isExpense,
    values: parentValues,
    grandTotal: parentGrandTotal,
    children,
  };
}

export function buildProfitLoss(
  db: DbHelper,
  companyId: number,
  from: string,
  to: string,
  view: 'yearly' | 'monthly' = 'yearly',
): PLStatement {
  const sets = buildPLGroupSets(db, companyId);
  const columns = view === 'monthly' ? monthsInRange(from, to) : ['total'];
  const columnRange = (col: string): { from: string; to: string } =>
    view === 'monthly' ? monthRange(col) : { from, to };

  // Four top-level sections. Revenue + Direct Costs are gross-profit drivers;
  // Indirect Income + Indirect Expenses cascade into net profit.
  //
  // displaySign flips the credit-positive raw movement into a display-positive
  // number for expense sections (so "Direct Costs" and "Indirect Expenses"
  // show as positive on screen, matching mgmt-reporting convention).
  const revenue = buildPLSectionWithChildren(
    db, companyId, 'revenue', 'Revenue', false, +1,
    sets.directCredit, columns, columnRange,
  );
  const directCosts = buildPLSectionWithChildren(
    db, companyId, 'directCosts', 'Direct Costs', true, -1,
    sets.directDebit, columns, columnRange,
  );
  const indirectIncome = buildPLSectionWithChildren(
    db, companyId, 'indirectIncome', 'Indirect Income', false, +1,
    sets.indirectCredit, columns, columnRange,
  );
  const indirectExpenses = buildPLSectionWithChildren(
    db, companyId, 'indirectExpenses', 'Indirect Expenses', true, -1,
    sets.indirectDebit, columns, columnRange,
  );

  const sections: PLSection[] = [revenue, directCosts, indirectIncome, indirectExpenses];

  // Gross Profit / Margin / Net Profit per column.
  // Stock adjustment (opening - closing) is folded into GP the same way as
  // the pre-refactor builder — closing stock still on hand reduces COGS.
  const grossProfit: Record<string, number> = {};
  const grossMargin: Record<string, number> = {};
  const netProfit: Record<string, number> = {};
  let gpGrand = 0, npGrand = 0;

  for (const col of columns) {
    const { from: cf, to: ct } = columnRange(col);
    const stock = getStockAdjustment(db, companyId, cf, ct);
    const rev = revenue.values[col] || 0;
    const dc = directCosts.values[col] || 0;      // positive (expense)
    const ii = indirectIncome.values[col] || 0;
    const ie = indirectExpenses.values[col] || 0; // positive (expense)
    const gp = rev - dc + stock.adjustment;
    const np = gp + ii - ie;
    grossProfit[col] = gp;
    grossMargin[col] = rev !== 0 ? Math.round((gp / rev) * 10000) / 100 : 0;
    netProfit[col] = np;
    gpGrand += gp;
    npGrand += np;
  }

  return {
    period: { from, to },
    view,
    columns,
    sections,
    computed: { grossProfit, grossMargin, netProfit },
    grandTotals: {
      revenue: revenue.grandTotal,
      directCosts: directCosts.grandTotal,
      indirectIncome: indirectIncome.grandTotal,
      indirectExpenses: indirectExpenses.grandTotal,
      grossProfit: gpGrand,
      netProfit: npGrand,
    },
  };
}

// ─── Balance Sheet ──────────────────────────────────────────────────────────

const BS_SECTIONS: Array<{
  key: string; label: string; parent: string; side: 'asset' | 'liability';
}> = [
  { key: 'capital',         label: 'Capital Account',      parent: 'Capital Account',     side: 'liability' },
  { key: 'reserves',        label: 'Reserves & Surplus',   parent: 'Reserves & Surplus',  side: 'liability' },
  { key: 'currentLiab',     label: 'Current Liabilities',  parent: 'Current Liabilities', side: 'liability' },
  { key: 'securedLoans',    label: 'Secured Loans',        parent: 'Secured Loans',       side: 'liability' },
  { key: 'unsecuredLoans',  label: 'Unsecured Loans',      parent: 'Unsecured Loans',     side: 'liability' },
  { key: 'sundryCreditors', label: 'Sundry Creditors',     parent: 'Sundry Creditors',    side: 'liability' },
  { key: 'fixedAssets',     label: 'Fixed Assets',         parent: 'Fixed Assets',        side: 'asset' },
  { key: 'investments',     label: 'Investments',          parent: 'Investments',         side: 'asset' },
  { key: 'currentAssets',   label: 'Current Assets',       parent: 'Current Assets',      side: 'asset' },
  { key: 'cashInHand',      label: 'Cash-in-Hand',         parent: 'Cash-in-Hand',        side: 'asset' },
  { key: 'bankAccounts',    label: 'Bank Accounts',        parent: 'Bank Accounts',       side: 'asset' },
  { key: 'sundryDebtors',   label: 'Sundry Debtors',       parent: 'Sundry Debtors',      side: 'asset' },
  { key: 'stockInHand',     label: 'Stock-in-Hand',        parent: 'Stock-in-Hand',       side: 'asset' },
];

/**
 * Closing balance for a set of groups as of a given date. Uses the TB row
 * whose period_to is closest to (but not after) asOf — the sync-agent
 * typically stores monthly snapshots, so there's one row per ledger per month.
 */
function computeBSClosing(
  db: DbHelper,
  companyId: number,
  asOfDate: string,
  groupNames: string[],
): number {
  if (!groupNames.length) return 0;
  const ph = groupNames.map(() => '?').join(',');

  // Find the latest TB window that ends on/before asOf for this company.
  const tbMonth = db.get(
    `SELECT period_to FROM vcfo_trial_balance
     WHERE company_id = ? AND period_to <= ?
     ORDER BY period_to DESC LIMIT 1`,
    companyId, asOfDate,
  );
  if (!tbMonth) return 0;

  const row = db.get(
    `SELECT SUM(closing_balance) AS total FROM vcfo_trial_balance
     WHERE company_id = ? AND period_to = ? AND group_name IN (${ph})`,
    [companyId, tbMonth.period_to, ...groupNames],
  );
  return Number(row?.total) || 0;
}

/** Quick net profit YTD (fy-start → asOf) — used to plug the BS balancing row. */
function computeYTDNetProfit(
  db: DbHelper,
  companyId: number,
  fyStartDate: string,
  asOfDate: string,
): number {
  const sets = buildPLGroupSets(db, companyId);
  const salesGroups = new Set(getGroupTree(db, companyId, 'Sales Accounts'));
  const purchaseGroups = new Set(getGroupTree(db, companyId, 'Purchase Accounts'));
  const pl = computePLForPeriod(db, companyId, fyStartDate, asOfDate, sets, salesGroups, purchaseGroups);
  return pl.netProfit;
}

function fyStart(db: DbHelper, companyId: number, asOf: string): string {
  const co = db.get('SELECT fy_start_month FROM vcfo_companies WHERE id = ?', companyId);
  const startMonth = Math.max(1, Math.min(12, Number(co?.fy_start_month) || 4));
  const d = new Date(asOf + 'T00:00:00');
  const m = d.getMonth() + 1;
  const y = m >= startMonth ? d.getFullYear() : d.getFullYear() - 1;
  return `${y}-${String(startMonth).padStart(2, '0')}-01`;
}

/**
 * Per-ledger closing balances for a set of groups, keyed by ledger name, as of
 * a particular date. Used to build expandable children under each BS parent.
 */
function computeBSClosingByLedger(
  db: DbHelper,
  companyId: number,
  asOfDate: string,
  groupNames: string[],
): Map<string, number> {
  const out = new Map<string, number>();
  if (!groupNames.length) return out;
  const ph = groupNames.map(() => '?').join(',');

  const tbMonth = db.get(
    `SELECT period_to FROM vcfo_trial_balance
     WHERE company_id = ? AND period_to <= ?
     ORDER BY period_to DESC LIMIT 1`,
    companyId, asOfDate,
  );
  if (!tbMonth) return out;

  const rows = db.all(
    `SELECT ledger_name AS ledgerName, SUM(closing_balance) AS total
     FROM vcfo_trial_balance
     WHERE company_id = ? AND period_to = ? AND group_name IN (${ph})
     GROUP BY ledger_name`,
    [companyId, tbMonth.period_to, ...groupNames],
  );
  for (const r of rows) out.set(r.ledgerName, Number(r.total) || 0);
  return out;
}

export function buildBalanceSheet(
  db: DbHelper,
  companyId: number,
  asOf: string,
  view: 'yearly' | 'monthly' = 'yearly',
  rangeFrom?: string,
): BSStatement {
  // Columns: yearly = single "total" keyed by asOf; monthly = last-day-of-month
  // snapshots from rangeFrom..asOf.
  const columns: string[] = view === 'monthly'
    ? monthsInRange(rangeFrom || asOf, asOf)
    : ['total'];
  const asOfByCol: Record<string, string> = {};
  if (view === 'monthly') {
    for (const m of columns) asOfByCol[m] = monthRange(m).to;
  } else {
    asOfByCol.total = asOf;
  }

  const sections: BSSection[] = [];
  const totalAssets: Record<string, number> = {};
  const totalLiabilities: Record<string, number> = {};
  for (const col of columns) { totalAssets[col] = 0; totalLiabilities[col] = 0; }

  for (const sec of BS_SECTIONS) {
    const groups = getGroupTree(db, companyId, sec.parent);
    if (!groups.length) continue;

    const values: Record<string, number> = {};
    let grandTotal = 0;
    let nonZero = false;

    // Per-ledger aggregate across all columns — keyed by ledgerName → Record<col, amount>.
    const perLedger = new Map<string, Record<string, number>>();

    for (const col of columns) {
      const closing = computeBSClosing(db, companyId, asOfByCol[col], groups);
      // Convention: assets are debit (negative in TB sign), liabilities credit.
      // Flip asset side to positive for display.
      const amount = sec.side === 'asset' ? -closing : closing;
      values[col] = amount;
      grandTotal += amount;
      if (Math.abs(amount) > 0.01) nonZero = true;

      if (sec.side === 'asset') totalAssets[col] += amount;
      else totalLiabilities[col] += amount;

      // Build children breakdown per column (same sign flip as parent).
      const byLedger = computeBSClosingByLedger(db, companyId, asOfByCol[col], groups);
      for (const [ledger, raw] of byLedger.entries()) {
        const childAmount = sec.side === 'asset' ? -raw : raw;
        if (!perLedger.has(ledger)) perLedger.set(ledger, {});
        perLedger.get(ledger)![col] = (perLedger.get(ledger)![col] || 0) + childAmount;
      }
    }

    if (!nonZero) continue; // skip sections with all-zero columns

    // Emit one child per ledger with material closing balance. Dormant
    // ledgers (all-zero) are dropped so the expanded view stays readable.
    const children: BSSection[] = [];
    for (const [ledger, perCol] of perLedger.entries()) {
      let childTotal = 0;
      const childValues: Record<string, number> = {};
      for (const col of columns) {
        childValues[col] = perCol[col] || 0;
        childTotal += childValues[col];
      }
      if (Math.abs(childTotal) < 0.01) continue;
      children.push({
        key: `${sec.key}:${ledger}`,
        label: ledger,
        side: sec.side,
        values: childValues,
        grandTotal: childTotal,
      });
    }
    children.sort((a, b) => Math.abs(b.grandTotal) - Math.abs(a.grandTotal));

    sections.push({
      key: sec.key, label: sec.label, side: sec.side, values, grandTotal,
      children: children.length ? children : undefined,
    });
  }

  // Plug the balancing P&L row (current-year profit accumulates as equity).
  const plValues: Record<string, number> = {};
  let plGrand = 0;
  let plNonZero = false;
  for (const col of columns) {
    const colAsOf = asOfByCol[col];
    const np = computeYTDNetProfit(db, companyId, fyStart(db, companyId, colAsOf), colAsOf);
    plValues[col] = np;
    plGrand += np;
    totalLiabilities[col] += np;
    if (Math.abs(np) > 0.01) plNonZero = true;
  }
  if (plNonZero) {
    sections.push({
      key: 'pnl', label: 'Profit & Loss A/c', side: 'liability',
      values: plValues, grandTotal: plGrand,
    });
  }

  return {
    asOfDate: asOf,
    view,
    columns,
    sections,
    totals: { totalAssets, totalLiabilities },
  };
}

// ─── Cash Flow (indirect method) ────────────────────────────────────────────

export function buildCashFlow(
  db: DbHelper,
  companyId: number,
  from: string,
  to: string,
): CFStatement {
  const openingDate = dayBefore(from);

  // Cash + bank closing (as of `to`) and opening (day before `from`)
  const cashGroups = getGroupTree(db, companyId, 'Cash-in-Hand');
  const bankGroups = getGroupTree(db, companyId, 'Bank Accounts');
  const allCashGroups = [...cashGroups, ...bankGroups];

  const closingCashRaw = computeBSClosing(db, companyId, to, allCashGroups);
  const openingCashRaw = computeBSClosing(db, companyId, openingDate, allCashGroups);
  const closingCash = -closingCashRaw; // assets flip sign for display
  const openingCash = -openingCashRaw;

  // Operating: net profit + working-capital changes
  const sets = buildPLGroupSets(db, companyId);
  const salesGroups = new Set(getGroupTree(db, companyId, 'Sales Accounts'));
  const purchaseGroups = new Set(getGroupTree(db, companyId, 'Purchase Accounts'));
  const pl = computePLForPeriod(db, companyId, from, to, sets, salesGroups, purchaseGroups);

  const sdGroups = getGroupTree(db, companyId, 'Sundry Debtors');
  const scGroups = getGroupTree(db, companyId, 'Sundry Creditors');
  const stockGroups = getGroupTree(db, companyId, 'Stock-in-Hand');

  const closingDebtors = -computeBSClosing(db, companyId, to, sdGroups);
  const openingDebtors = -computeBSClosing(db, companyId, openingDate, sdGroups);
  const closingCreditors = computeBSClosing(db, companyId, to, scGroups);
  const openingCreditors = computeBSClosing(db, companyId, openingDate, scGroups);
  const closingStockBal = -computeBSClosing(db, companyId, to, stockGroups);
  const openingStockBal = -computeBSClosing(db, companyId, openingDate, stockGroups);

  const operating: CFLine[] = [
    { label: 'Net Profit', amount: pl.netProfit },
    { label: 'Add: Depreciation (non-cash)', amount: 0 }, // placeholder — full depreciation detection deferred
    { label: '(Inc)/Dec in Sundry Debtors', amount: openingDebtors - closingDebtors },
    { label: 'Inc/(Dec) in Sundry Creditors', amount: closingCreditors - openingCreditors },
    { label: '(Inc)/Dec in Stock', amount: openingStockBal - closingStockBal },
  ];
  const operatingTotal = operating.reduce((s, r) => s + r.amount, 0);

  // Investing: fixed assets + investments
  const faGroups = getGroupTree(db, companyId, 'Fixed Assets');
  const invGroups = getGroupTree(db, companyId, 'Investments');
  const closingFA = -computeBSClosing(db, companyId, to, faGroups);
  const openingFA = -computeBSClosing(db, companyId, openingDate, faGroups);
  const closingInv = -computeBSClosing(db, companyId, to, invGroups);
  const openingInv = -computeBSClosing(db, companyId, openingDate, invGroups);

  const investing: CFLine[] = [
    { label: '(Purchase)/Sale of Fixed Assets', amount: openingFA - closingFA },
    { label: '(Purchase)/Sale of Investments',  amount: openingInv - closingInv },
  ];
  const investingTotal = investing.reduce((s, r) => s + r.amount, 0);

  // Financing: loans + capital changes
  const slGroups = getGroupTree(db, companyId, 'Secured Loans');
  const ulGroups = getGroupTree(db, companyId, 'Unsecured Loans');
  const capGroups = getGroupTree(db, companyId, 'Capital Account');
  const closingSL = computeBSClosing(db, companyId, to, slGroups);
  const openingSL = computeBSClosing(db, companyId, openingDate, slGroups);
  const closingUL = computeBSClosing(db, companyId, to, ulGroups);
  const openingUL = computeBSClosing(db, companyId, openingDate, ulGroups);
  const closingCap = computeBSClosing(db, companyId, to, capGroups);
  const openingCap = computeBSClosing(db, companyId, openingDate, capGroups);

  const financing: CFLine[] = [
    { label: 'Inc/(Dec) in Secured Loans',   amount: closingSL - openingSL },
    { label: 'Inc/(Dec) in Unsecured Loans', amount: closingUL - openingUL },
    { label: 'Inc/(Dec) in Capital',         amount: closingCap - openingCap },
  ];
  const financingTotal = financing.reduce((s, r) => s + r.amount, 0);

  const netChange = operatingTotal + investingTotal + financingTotal;

  return {
    period: { from, to },
    operating, operatingTotal,
    investing, investingTotal,
    financing, financingTotal,
    netChange,
    openingCash,
    closingCash,
  };
}

// ─── Multi-company wrappers (consolidation + bifurcation) ───────────────────
//
// These take a list of companyIds and either:
//   (a) consolidate — sum per-column values across companies (single set of
//       period/total columns, same as single-company mode). Used when the
//       sidebar maps to multiple companies (e.g. "All Branches" or a branch
//       that contains both clinic + pharmacy).
//   (b) bifurcate — emit one column per company plus a "total" column, so
//       the user can compare branches side-by-side.
//
// Implementation is intentionally loop-and-merge: reuses the single-company
// builders as-is, then post-processes. Chart-of-accounts group names don't
// need to match across companies — children are merged by label, non-matches
// appear as separate rows.

type CompanyRef = { id: number; name: string };

function mergeChildrenPL(children: PLSection[][]): PLSection[] {
  const byLabel = new Map<string, PLSection>();
  for (const list of children) {
    for (const ch of list) {
      const existing = byLabel.get(ch.label);
      if (!existing) {
        byLabel.set(ch.label, {
          key: ch.key,
          label: ch.label,
          isExpense: ch.isExpense,
          values: { ...ch.values },
          grandTotal: ch.grandTotal,
        });
      } else {
        for (const [col, v] of Object.entries(ch.values)) {
          existing.values[col] = (existing.values[col] || 0) + v;
        }
        existing.grandTotal += ch.grandTotal;
      }
    }
  }
  return [...byLabel.values()].sort((a, b) => Math.abs(b.grandTotal) - Math.abs(a.grandTotal));
}

function mergeChildrenBS(children: BSSection[][]): BSSection[] {
  const byLabel = new Map<string, BSSection>();
  for (const list of children) {
    for (const ch of list) {
      const existing = byLabel.get(ch.label);
      if (!existing) {
        byLabel.set(ch.label, {
          key: ch.key,
          label: ch.label,
          side: ch.side,
          values: { ...ch.values },
          grandTotal: ch.grandTotal,
        });
      } else {
        for (const [col, v] of Object.entries(ch.values)) {
          existing.values[col] = (existing.values[col] || 0) + v;
        }
        existing.grandTotal += ch.grandTotal;
      }
    }
  }
  return [...byLabel.values()].sort((a, b) => Math.abs(b.grandTotal) - Math.abs(a.grandTotal));
}

export function buildProfitLossMulti(
  db: DbHelper,
  companies: CompanyRef[],
  from: string,
  to: string,
  view: 'yearly' | 'monthly',
  bifurcate: boolean,
): PLStatement {
  if (companies.length === 0) {
    // Empty set — return an empty but valid shape so the UI can render "no data".
    const emptyCols = view === 'monthly' ? monthsInRange(from, to) : ['total'];
    const zeros = Object.fromEntries(emptyCols.map(c => [c, 0]));
    return {
      period: { from, to }, view, columns: emptyCols, bifurcated: bifurcate,
      companies: [], sections: [],
      computed: { grossProfit: zeros, grossMargin: zeros, netProfit: zeros },
      grandTotals: { revenue: 0, directCosts: 0, indirectIncome: 0, indirectExpenses: 0, grossProfit: 0, netProfit: 0 },
    };
  }

  // Build each company's statement with the normal period-based columns — we'll
  // reshape into bifurcated columns post-hoc if requested.
  const perCompany = companies.map(c => ({
    company: c,
    report: buildProfitLoss(db, c.id, from, to, view),
  }));

  if (!bifurcate) {
    // Consolidation: sum period columns across companies.
    // All reports share the same `columns` array (same period), so we can merge
    // section-by-section.
    const first = perCompany[0].report;
    const columns = first.columns;

    const mergeParentSections = (key: string, label: string, isExpense: boolean): PLSection => {
      const values: Record<string, number> = Object.fromEntries(columns.map(c => [c, 0]));
      let grandTotal = 0;
      const allChildren: PLSection[][] = [];
      for (const { report } of perCompany) {
        const sec = report.sections.find(s => s.key === key);
        if (!sec) continue;
        for (const col of columns) values[col] += sec.values[col] || 0;
        grandTotal += sec.grandTotal;
        if (sec.children?.length) allChildren.push(sec.children);
      }
      return {
        key, label, isExpense, values, grandTotal,
        children: mergeChildrenPL(allChildren),
      };
    };

    const revenue = mergeParentSections('revenue', 'Revenue', false);
    const directCosts = mergeParentSections('directCosts', 'Direct Costs', true);
    const indirectIncome = mergeParentSections('indirectIncome', 'Indirect Income', false);
    const indirectExpenses = mergeParentSections('indirectExpenses', 'Indirect Expenses', true);

    const computed = {
      grossProfit: {} as Record<string, number>,
      grossMargin: {} as Record<string, number>,
      netProfit: {} as Record<string, number>,
    };
    let gpGrand = 0, npGrand = 0;
    for (const col of columns) {
      let gp = 0, np = 0;
      for (const { report } of perCompany) {
        gp += report.computed.grossProfit[col] || 0;
        np += report.computed.netProfit[col] || 0;
      }
      computed.grossProfit[col] = gp;
      computed.netProfit[col] = np;
      const rev = revenue.values[col] || 0;
      computed.grossMargin[col] = rev !== 0 ? Math.round((gp / rev) * 10000) / 100 : 0;
      gpGrand += gp;
      npGrand += np;
    }

    return {
      period: { from, to }, view, columns,
      bifurcated: false,
      companies,
      sections: [revenue, directCosts, indirectIncome, indirectExpenses],
      computed,
      grandTotals: {
        revenue: revenue.grandTotal,
        directCosts: directCosts.grandTotal,
        indirectIncome: indirectIncome.grandTotal,
        indirectExpenses: indirectExpenses.grandTotal,
        grossProfit: gpGrand,
        netProfit: npGrand,
      },
    };
  }

  // Bifurcation: columns become one per company, plus a final 'total' column.
  const compKey = (c: CompanyRef) => `co:${c.id}`;
  const columns = companies.map(compKey).concat('total');
  const columnLabels: Record<string, string> = {};
  for (const c of companies) columnLabels[compKey(c)] = c.name;
  columnLabels.total = 'Total';

  // For each top-level section, one column per company = that company's
  // grandTotal for that section. Children get the same treatment (by label).
  const buildBifurcatedSection = (key: string, label: string, isExpense: boolean): PLSection => {
    const values: Record<string, number> = Object.fromEntries(columns.map(c => [c, 0]));
    let grandTotal = 0;
    const childrenAcc = new Map<string, { label: string; isExpense: boolean; values: Record<string, number>; grandTotal: number }>();

    for (const { company, report } of perCompany) {
      const sec = report.sections.find(s => s.key === key);
      if (!sec) continue;
      const total = sec.grandTotal;
      values[compKey(company)] = total;
      values.total += total;
      grandTotal += total;

      for (const ch of sec.children || []) {
        if (!childrenAcc.has(ch.label)) {
          childrenAcc.set(ch.label, {
            label: ch.label, isExpense: ch.isExpense,
            values: Object.fromEntries(columns.map(c => [c, 0])),
            grandTotal: 0,
          });
        }
        const acc = childrenAcc.get(ch.label)!;
        acc.values[compKey(company)] = ch.grandTotal;
        acc.values.total += ch.grandTotal;
        acc.grandTotal += ch.grandTotal;
      }
    }

    const children: PLSection[] = [...childrenAcc.entries()].map(([name, v]) => ({
      key: `${key}:${name}`, label: v.label, isExpense: v.isExpense,
      values: v.values, grandTotal: v.grandTotal,
    }));
    children.sort((a, b) => Math.abs(b.grandTotal) - Math.abs(a.grandTotal));

    return { key, label, isExpense, values, grandTotal, children };
  };

  const revenue = buildBifurcatedSection('revenue', 'Revenue', false);
  const directCosts = buildBifurcatedSection('directCosts', 'Direct Costs', true);
  const indirectIncome = buildBifurcatedSection('indirectIncome', 'Indirect Income', false);
  const indirectExpenses = buildBifurcatedSection('indirectExpenses', 'Indirect Expenses', true);

  const computed = {
    grossProfit: {} as Record<string, number>,
    grossMargin: {} as Record<string, number>,
    netProfit: {} as Record<string, number>,
  };
  for (const col of columns) computed.grossProfit[col] = 0;
  for (const col of columns) computed.grossMargin[col] = 0;
  for (const col of columns) computed.netProfit[col] = 0;

  let gpGrand = 0, npGrand = 0;
  for (const { company, report } of perCompany) {
    const gp = report.grandTotals.grossProfit;
    const np = report.grandTotals.netProfit;
    computed.grossProfit[compKey(company)] = gp;
    computed.netProfit[compKey(company)] = np;
    computed.grossProfit.total += gp;
    computed.netProfit.total += np;
    gpGrand += gp;
    npGrand += np;
    const rev = report.grandTotals.revenue;
    computed.grossMargin[compKey(company)] = rev !== 0 ? Math.round((gp / rev) * 10000) / 100 : 0;
  }
  const revTotal = revenue.values.total || 0;
  computed.grossMargin.total = revTotal !== 0 ? Math.round((computed.grossProfit.total / revTotal) * 10000) / 100 : 0;

  return {
    period: { from, to }, view: 'yearly', // bifurcated always yearly per-company
    columns, columnLabels, bifurcated: true,
    companies,
    sections: [revenue, directCosts, indirectIncome, indirectExpenses],
    computed,
    grandTotals: {
      revenue: revenue.grandTotal,
      directCosts: directCosts.grandTotal,
      indirectIncome: indirectIncome.grandTotal,
      indirectExpenses: indirectExpenses.grandTotal,
      grossProfit: gpGrand,
      netProfit: npGrand,
    },
  };
}

export function buildBalanceSheetMulti(
  db: DbHelper,
  companies: CompanyRef[],
  asOf: string,
  view: 'yearly' | 'monthly',
  rangeFrom: string | undefined,
  bifurcate: boolean,
): BSStatement {
  if (companies.length === 0) {
    const columns = view === 'monthly' ? monthsInRange(rangeFrom || asOf, asOf) : ['total'];
    const zeros = Object.fromEntries(columns.map(c => [c, 0]));
    return {
      asOfDate: asOf, view, columns, bifurcated: bifurcate, companies: [],
      sections: [], totals: { totalAssets: zeros, totalLiabilities: zeros },
    };
  }

  const perCompany = companies.map(c => ({
    company: c,
    report: buildBalanceSheet(db, c.id, asOf, view, rangeFrom),
  }));

  if (!bifurcate) {
    const first = perCompany[0].report;
    const columns = first.columns;
    const totalAssets: Record<string, number> = Object.fromEntries(columns.map(c => [c, 0]));
    const totalLiabilities: Record<string, number> = Object.fromEntries(columns.map(c => [c, 0]));

    const byKey = new Map<string, BSSection>();
    const childrenByKey = new Map<string, BSSection[][]>();

    for (const { report } of perCompany) {
      for (const sec of report.sections) {
        const existing = byKey.get(sec.key);
        if (!existing) {
          byKey.set(sec.key, {
            key: sec.key, label: sec.label, side: sec.side,
            values: { ...sec.values }, grandTotal: sec.grandTotal,
          });
        } else {
          for (const col of columns) existing.values[col] = (existing.values[col] || 0) + (sec.values[col] || 0);
          existing.grandTotal += sec.grandTotal;
        }
        if (sec.children?.length) {
          if (!childrenByKey.has(sec.key)) childrenByKey.set(sec.key, []);
          childrenByKey.get(sec.key)!.push(sec.children);
        }
      }
      for (const col of columns) {
        totalAssets[col] += report.totals.totalAssets[col] || 0;
        totalLiabilities[col] += report.totals.totalLiabilities[col] || 0;
      }
    }

    const sections: BSSection[] = [];
    for (const [key, sec] of byKey.entries()) {
      const merged = mergeChildrenBS(childrenByKey.get(key) || []);
      sections.push({ ...sec, children: merged.length ? merged : undefined });
    }
    // Preserve a sensible order: same as first company's.
    const orderKeys = perCompany[0].report.sections.map(s => s.key);
    sections.sort((a, b) => {
      const ai = orderKeys.indexOf(a.key);
      const bi = orderKeys.indexOf(b.key);
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    });

    return {
      asOfDate: asOf, view, columns, bifurcated: false, companies,
      sections,
      totals: { totalAssets, totalLiabilities },
    };
  }

  // Bifurcate — one column per company + total.
  const compKey = (c: CompanyRef) => `co:${c.id}`;
  const columns = companies.map(compKey).concat('total');
  const columnLabels: Record<string, string> = {};
  for (const c of companies) columnLabels[compKey(c)] = c.name;
  columnLabels.total = 'Total';

  const totalAssets: Record<string, number> = Object.fromEntries(columns.map(c => [c, 0]));
  const totalLiabilities: Record<string, number> = Object.fromEntries(columns.map(c => [c, 0]));

  const byKey = new Map<string, BSSection>();
  const childrenAcc = new Map<string, Map<string, BSSection>>();

  for (const { company, report } of perCompany) {
    for (const sec of report.sections) {
      if (!byKey.has(sec.key)) {
        byKey.set(sec.key, {
          key: sec.key, label: sec.label, side: sec.side,
          values: Object.fromEntries(columns.map(c => [c, 0])),
          grandTotal: 0,
        });
      }
      const acc = byKey.get(sec.key)!;
      acc.values[compKey(company)] = sec.grandTotal;
      acc.values.total += sec.grandTotal;
      acc.grandTotal += sec.grandTotal;

      if (sec.children?.length) {
        if (!childrenAcc.has(sec.key)) childrenAcc.set(sec.key, new Map());
        const kids = childrenAcc.get(sec.key)!;
        for (const ch of sec.children) {
          if (!kids.has(ch.label)) {
            kids.set(ch.label, {
              key: `${sec.key}:${ch.label}`, label: ch.label, side: sec.side,
              values: Object.fromEntries(columns.map(c => [c, 0])),
              grandTotal: 0,
            });
          }
          const childAcc = kids.get(ch.label)!;
          childAcc.values[compKey(company)] = ch.grandTotal;
          childAcc.values.total += ch.grandTotal;
          childAcc.grandTotal += ch.grandTotal;
        }
      }
    }
    totalAssets[compKey(company)] = Object.values(report.totals.totalAssets).reduce((s, v) => s + v, 0);
    totalLiabilities[compKey(company)] = Object.values(report.totals.totalLiabilities).reduce((s, v) => s + v, 0);
    totalAssets.total += totalAssets[compKey(company)];
    totalLiabilities.total += totalLiabilities[compKey(company)];
  }

  const sections: BSSection[] = [];
  for (const [key, sec] of byKey.entries()) {
    const children = [...(childrenAcc.get(key)?.values() || [])];
    children.sort((a, b) => Math.abs(b.grandTotal) - Math.abs(a.grandTotal));
    sections.push({ ...sec, children: children.length ? children : undefined });
  }
  const orderKeys = perCompany[0].report.sections.map(s => s.key);
  sections.sort((a, b) => {
    const ai = orderKeys.indexOf(a.key);
    const bi = orderKeys.indexOf(b.key);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });

  return {
    asOfDate: asOf, view: 'yearly', columns, columnLabels, bifurcated: true,
    companies,
    sections,
    totals: { totalAssets, totalLiabilities },
  };
}

export function buildCashFlowMulti(
  db: DbHelper,
  companies: CompanyRef[],
  from: string,
  to: string,
  bifurcate: boolean,
): CFStatement {
  if (companies.length === 0) {
    return {
      period: { from, to },
      operating: [], operatingTotal: 0,
      investing: [], investingTotal: 0,
      financing: [], financingTotal: 0,
      netChange: 0, openingCash: 0, closingCash: 0,
      bifurcated: bifurcate, companies: [],
    };
  }

  const perCompany = companies.map(c => ({
    company: c,
    report: buildCashFlow(db, c.id, from, to),
  }));

  if (!bifurcate) {
    const mergeLines = (getLines: (r: CFStatement) => CFLine[]): CFLine[] => {
      const byLabel = new Map<string, CFLine>();
      for (const { report } of perCompany) {
        for (const line of getLines(report)) {
          const existing = byLabel.get(line.label);
          if (!existing) byLabel.set(line.label, { label: line.label, amount: line.amount });
          else existing.amount += line.amount;
        }
      }
      return [...byLabel.values()];
    };
    const operating = mergeLines(r => r.operating);
    const investing = mergeLines(r => r.investing);
    const financing = mergeLines(r => r.financing);
    const sum = (arr: CFLine[]): number => arr.reduce((s, r) => s + r.amount, 0);
    const operatingTotal = sum(operating);
    const investingTotal = sum(investing);
    const financingTotal = sum(financing);

    return {
      period: { from, to },
      operating, operatingTotal,
      investing, investingTotal,
      financing, financingTotal,
      netChange: operatingTotal + investingTotal + financingTotal,
      openingCash: perCompany.reduce((s, p) => s + p.report.openingCash, 0),
      closingCash: perCompany.reduce((s, p) => s + p.report.closingCash, 0),
      bifurcated: false, companies,
    };
  }

  // Bifurcate — each line has a values map with per-company breakdown.
  const compKey = (c: CompanyRef) => `co:${c.id}`;
  const columns = companies.map(compKey).concat('total');
  const columnLabels: Record<string, string> = {};
  for (const c of companies) columnLabels[compKey(c)] = c.name;
  columnLabels.total = 'Total';

  const mergeLinesBifurcated = (getLines: (r: CFStatement) => CFLine[]): CFLine[] => {
    const byLabel = new Map<string, CFLine>();
    for (const { company, report } of perCompany) {
      for (const line of getLines(report)) {
        if (!byLabel.has(line.label)) {
          byLabel.set(line.label, {
            label: line.label, amount: 0,
            values: Object.fromEntries(columns.map(c => [c, 0])),
          });
        }
        const acc = byLabel.get(line.label)!;
        acc.values![compKey(company)] = line.amount;
        acc.values!.total += line.amount;
        acc.amount += line.amount;
      }
    }
    return [...byLabel.values()];
  };

  const operating = mergeLinesBifurcated(r => r.operating);
  const investing = mergeLinesBifurcated(r => r.investing);
  const financing = mergeLinesBifurcated(r => r.financing);
  const perColSum = (arr: CFLine[]) => {
    const out: Record<string, number> = Object.fromEntries(columns.map(c => [c, 0]));
    for (const line of arr) {
      for (const col of columns) out[col] += (line.values?.[col] || 0);
    }
    return out;
  };
  const operatingTotalValues = perColSum(operating);
  const investingTotalValues = perColSum(investing);
  const financingTotalValues = perColSum(financing);
  const netChangeValues: Record<string, number> = Object.fromEntries(columns.map(c => [c, 0]));
  const openingCashValues: Record<string, number> = Object.fromEntries(columns.map(c => [c, 0]));
  const closingCashValues: Record<string, number> = Object.fromEntries(columns.map(c => [c, 0]));
  for (const { company, report } of perCompany) {
    const key = compKey(company);
    netChangeValues[key] = report.netChange;
    netChangeValues.total += report.netChange;
    openingCashValues[key] = report.openingCash;
    openingCashValues.total += report.openingCash;
    closingCashValues[key] = report.closingCash;
    closingCashValues.total += report.closingCash;
  }

  return {
    period: { from, to },
    columns, columnLabels, bifurcated: true, companies,
    operating,
    operatingTotal: Object.values(operatingTotalValues).reduce((s, v) => s + v, 0) - (operatingTotalValues.total || 0),
    operatingTotalValues,
    investing,
    investingTotal: Object.values(investingTotalValues).reduce((s, v) => s + v, 0) - (investingTotalValues.total || 0),
    investingTotalValues,
    financing,
    financingTotal: Object.values(financingTotalValues).reduce((s, v) => s + v, 0) - (financingTotalValues.total || 0),
    financingTotalValues,
    netChange: netChangeValues.total || 0,
    netChangeValues,
    openingCash: openingCashValues.total || 0,
    openingCashValues,
    closingCash: closingCashValues.total || 0,
    closingCashValues,
  };
}

export function buildTrialBalanceMulti(
  db: DbHelper,
  companies: CompanyRef[],
  from: string,
  to: string,
): TrialBalanceReport {
  if (companies.length === 0) {
    return { period: { from, to }, rows: [], totals: { opening: 0, debit: 0, credit: 0, closing: 0 } };
  }
  if (companies.length === 1) {
    return buildTrialBalance(db, companies[0].id, from, to);
  }
  const perCompany = companies.map(c => buildTrialBalance(db, c.id, from, to));
  const byKey = new Map<string, TrialBalanceRow>();
  for (const report of perCompany) {
    for (const r of report.rows) {
      const key = `${r.groupName || ''}::${r.ledgerName}`;
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, { ...r });
      } else {
        existing.opening += r.opening;
        existing.debit += r.debit;
        existing.credit += r.credit;
        existing.closing += r.closing;
      }
    }
  }
  const rows = [...byKey.values()].sort((a, b) => {
    const g = (a.groupName || '').localeCompare(b.groupName || '');
    return g !== 0 ? g : a.ledgerName.localeCompare(b.ledgerName);
  });
  const totals = rows.reduce(
    (acc, r) => ({
      opening: acc.opening + r.opening,
      debit: acc.debit + r.debit,
      credit: acc.credit + r.credit,
      closing: acc.closing + r.closing,
    }),
    { opening: 0, debit: 0, credit: 0, closing: 0 },
  );
  return { period: { from, to }, rows, totals };
}
