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
import {
  computeDynamicTB,
  getBalancesAsOf,
  getBalancesBefore,
  fyStartFor,
  type LedgerBalance,
} from './dynamic-tb.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TrialBalanceRow {
  ledgerName: string;
  groupName: string | null;
  opening: number;
  debit: number;
  credit: number;
  closing: number;
}

export interface TrialBalanceGroup {
  key: string;
  groupName: string;
  opening: number;
  debit: number;
  credit: number;
  closing: number;
  children: TrialBalanceRow[];
}

export interface TrialBalanceReport {
  period: { from: string; to: string };
  /** Flat ledger rows — kept for backward compat with exporters (xlsx/pdf/docx). */
  rows: TrialBalanceRow[];
  /** Grouped hierarchical view consumed by the UI expand/collapse feature. */
  groups: TrialBalanceGroup[];
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
    /** Per-column opening stock value (from vcfo_stock_summary). Zero for
     *  service-only tenants with no inventory. Surfaced so the UI can
     *  render an explicit COGS breakdown row. */
    stockOpening: Record<string, number>;
    /** Per-column closing stock value. */
    stockClosing: Record<string, number>;
    /** COGS per column = directCosts + stockOpening − stockClosing. Equal to
     *  what Tally labels "Opening Stock + Purchases + Direct Expenses −
     *  Closing Stock" on the trading account. */
    cogs: Record<string, number>;
  };
  grandTotals: {
    revenue: number;
    directCosts: number;
    indirectIncome: number;
    indirectExpenses: number;
    grossProfit: number;
    netProfit: number;
    stockOpening: number;
    stockClosing: number;
    cogs: number;
  };
  /** Present when callers opt into the management-P&L adjustments layer.
   *  Carries the per-rule event list, warnings, and the post-rule adjusted
   *  PLStatement so downstream renderers (HTTP response, XLSX/PDF/DOCX
   *  exporters) can surface the true-cost view alongside the books. */
  adjustments?: {
    events: any[];
    warnings: string[];
    adjusted: PLStatement;
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
export function getGroupTree(db: DbHelper, companyId: number, parentName: string): string[] {
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
 * Trial Balance — voucher-level composition via `computeDynamicTB`. Works for
 * any arbitrary `[from, to]` window at day precision (no more quarter-boundary
 * approximations). Credit-positive throughout.
 *
 * Opening = FY-start snapshot + net movement from FY-start to `from`.
 * Debit / Credit = magnitudes over [from, to].
 * Closing = opening + (credit - debit).
 */
export function buildTrialBalance(
  db: DbHelper,
  companyId: number,
  from: string,
  to: string,
): TrialBalanceReport {
  const balances = computeDynamicTB(db, companyId, from, to, fyStartFor(from));
  const cleanRows: TrialBalanceRow[] = balances
    .map((b) => ({
      ledgerName: b.ledgerName,
      groupName: b.groupName,
      opening: b.opening,
      debit: b.debit,
      credit: b.credit,
      closing: b.closing,
    }))
    .sort((a, b) => {
      const ga = a.groupName || '';
      const gb = b.groupName || '';
      if (ga !== gb) return ga.localeCompare(gb);
      return a.ledgerName.localeCompare(b.ledgerName);
    });

  const totals = cleanRows.reduce(
    (acc, r) => ({
      opening: acc.opening + r.opening,
      debit: acc.debit + r.debit,
      credit: acc.credit + r.credit,
      closing: acc.closing + r.closing,
    }),
    { opening: 0, debit: 0, credit: 0, closing: 0 },
  );

  return { period: { from, to }, rows: cleanRows, groups: groupTBRows(cleanRows), totals };
}

/**
 * Fold flat TB rows into parent-group buckets so the UI can render each group
 * as a collapsible parent with its constituent ledgers underneath. Ledgers
 * whose group is unknown get a synthetic "Ungrouped" parent.
 */
function groupTBRows(rows: TrialBalanceRow[]): TrialBalanceGroup[] {
  const byGroup = new Map<string, TrialBalanceGroup>();
  for (const r of rows) {
    const gName = r.groupName || 'Ungrouped';
    let g = byGroup.get(gName);
    if (!g) {
      g = {
        key: `grp:${gName}`,
        groupName: gName,
        opening: 0, debit: 0, credit: 0, closing: 0,
        children: [],
      };
      byGroup.set(gName, g);
    }
    g.opening += r.opening;
    g.debit   += r.debit;
    g.credit  += r.credit;
    g.closing += r.closing;
    g.children.push(r);
  }
  const groups = [...byGroup.values()];
  for (const g of groups) {
    g.children.sort((a, b) => a.ledgerName.localeCompare(b.ledgerName));
  }
  groups.sort((a, b) => a.groupName.localeCompare(b.groupName));
  return groups;
}

/**
 * Net movement per ledger over [from, to], joined with its group_name.
 * Movement is credit-positive (credit - debit). Derived from the voucher-level
 * dynamic TB so the result is day-accurate regardless of FY-start alignment.
 */
export function getLedgerMovements(
  db: DbHelper,
  companyId: number,
  from: string,
  to: string,
): Array<{ ledgerName: string; groupName: string; movement: number }> {
  const balances = computeDynamicTB(db, companyId, from, to, fyStartFor(from));
  const out: Array<{ ledgerName: string; groupName: string; movement: number }> = [];
  for (const b of balances) {
    if (!b.groupName) continue;
    // Skip dormant ledgers (zero movement) — original SQL implicitly excluded
    // them by only surfacing rows with SUM(net_credit) - SUM(net_debit) != 0.
    const movement = b.credit - b.debit;
    if (movement === 0) continue;
    out.push({ ledgerName: b.ledgerName, groupName: b.groupName, movement });
  }
  return out;
}

/**
 * Opening + closing stock value for a period, sourced from the
 * `Stock-in-hand` group in `vcfo_trial_balance`. Tenants whose inventory
 * is tracked externally (Excel/separate system) book the month-end
 * closing stock as a manual journal entry — that entry shows up in this
 * ledger group, which is what Tally's own P&L screen also reads. The
 * value updates monthly because the entry is re-booked each month.
 *
 *   opening = stock value at end of (from − 1 day)  ← cumulative TB balance
 *   closing = stock value at end of `to`            ← cumulative TB balance
 *   adjustment = closing − opening
 *
 * Inventory build-up (closing > opening) adds back to GP because the
 * purchases lumped into Direct Costs include stock not yet consumed —
 * matches Tally's trading-account convention exactly.
 *
 * History: an earlier revision read from `vcfo_stock_summary` (Tally's
 * StockItem inventory masters), but the design clients we ship to don't
 * maintain Tally inventory — stock is external-only, with a monthly
 * journal entry. The stock-item rollup produced unrelated numbers
 * (different valuation, phantom items). The TB ledger is the source of
 * truth for these clients, and is what Tally's P&L itself displays.
 *
 * Group-name casing: Tally exports the primary group as `Stock-in-hand`
 * (lowercase 'h'). SQLite string compare is case-sensitive — looking up
 * `'Stock-in-Hand'` returned an empty set across all 15 Magna entities,
 * silently zeroing this whole function. Keep the lowercase 'h' here.
 */
function getStockAdjustment(
  db: DbHelper,
  companyId: number,
  from: string,
  to: string,
): { opening: number; closing: number; adjustment: number } {
  // Preferred source: the dedicated `vcfo_stock_closing_balances` table
  // populated monthly by the sync-agent's stockMonthlyBalances extractor.
  // This captures the manually-set "Closing Balance" field on stock ledgers
  // (the typical entry pattern when stock is tracked externally), which
  // `computeDynamicTB` cannot see because no vouchers correspond to it.
  const dedicated = getStockFromDedicatedTable(db, companyId, from, to);
  if (dedicated.hasData) return dedicated;

  // Fallback: voucher-derived TB lookup, for tenants who DO post month-end
  // Closing Stock journal entries (so the voucher-composed dynamic TB
  // reflects the right balances).
  const stockGroups = new Set(getGroupTree(db, companyId, 'Stock-in-hand'));
  if (stockGroups.size === 0) return { opening: 0, closing: 0, adjustment: 0 };

  const sumStockClosing = (balances: LedgerBalance[]): number => {
    // Assets are debit-side (closing < 0 in credit-positive convention);
    // flip sign so stock values display as positive.
    let total = 0;
    for (const b of balances) {
      if (b.groupName && stockGroups.has(b.groupName)) total += -b.closing;
    }
    return total;
  };

  const opening = sumStockClosing(getBalancesBefore(db, companyId, from));
  const closing = sumStockClosing(getBalancesAsOf(db, companyId, to));

  return { opening, closing, adjustment: closing - opening };
}

/**
 * Look up opening + closing stock from `vcfo_stock_closing_balances`.
 *
 *   opening = ∑ closing_value of latest as_of_date < from, per ledger
 *   closing = ∑ closing_value of latest as_of_date ≤ to, per ledger
 *
 * Storage convention is credit-positive (matches the TB convention from
 * the underlying TDL), so stock values come out negative for the asset
 * side; we flip sign on the way out so the display number is positive.
 *
 * `hasData = false` when the table has no rows for this company at all,
 * which signals the caller to fall back to the legacy TB-ledger path.
 * Returning hasData=true with zero values (a tenant with stock_closing
 * rows but none on or before `to`) is intentional: it means "we know
 * stock is tracked here, the value is just zero for this window".
 */
function getStockFromDedicatedTable(
  db: DbHelper,
  companyId: number,
  from: string,
  to: string,
): { opening: number; closing: number; adjustment: number; hasData: boolean } {
  const haveAny = db.get(
    `SELECT 1 AS x FROM vcfo_stock_closing_balances WHERE company_id = ? LIMIT 1`,
    companyId,
  );
  if (!haveAny) return { opening: 0, closing: 0, adjustment: 0, hasData: false };

  const sumLatest = (cmp: '<' | '<=', boundary: string): number => {
    const row = db.get(
      `SELECT COALESCE(SUM(s.closing_value), 0) AS total
         FROM vcfo_stock_closing_balances s
         INNER JOIN (
           SELECT ledger_name, MAX(as_of_date) AS max_as_of
             FROM vcfo_stock_closing_balances
            WHERE company_id = ? AND as_of_date ${cmp} ?
            GROUP BY ledger_name
         ) latest
           ON latest.ledger_name = s.ledger_name
          AND latest.max_as_of   = s.as_of_date
        WHERE s.company_id = ?`,
      companyId, boundary, companyId,
    );
    // closing_value is stored credit-positive; flip for display.
    return -(Number(row?.total) || 0);
  };

  const opening = sumLatest('<', from);
  const closing = sumLatest('<=', to);
  return { opening, closing, adjustment: closing - opening, hasData: true };
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
/** Parent → immediate children, restricted to PL groups in the company. The
 *  inverse `childToParent` lets a child resolve its parent in O(1). Groups
 *  whose parent_group is NULL, empty, or `Profit & Loss A/c` (Tally's grand
 *  primary) are treated as roots — i.e. they have no parent we care about. */
function loadPLGroupHierarchy(
  db: DbHelper,
  companyId: number,
): { childrenByParent: Map<string, string[]>; parentByChild: Map<string, string | null> } {
  const rows = db.all(
    `SELECT group_name, parent_group FROM vcfo_account_groups
     WHERE company_id = ? AND bs_pl = 'PL'`,
    companyId,
  );
  const childrenByParent = new Map<string, string[]>();
  const parentByChild = new Map<string, string | null>();
  for (const r of rows) {
    const name = r.group_name as string;
    const parent = r.parent_group && r.parent_group !== 'Profit & Loss A/c'
      ? (r.parent_group as string)
      : null;
    parentByChild.set(name, parent);
    if (parent) {
      if (!childrenByParent.has(parent)) childrenByParent.set(parent, []);
      childrenByParent.get(parent)!.push(name);
    }
  }
  return { childrenByParent, parentByChild };
}

/** Per-ledger per-column movement, joined with each ledger's direct group.
 *  Credit-positive. Only ledgers whose group_name is in `groupNames` are
 *  returned, so callers restrict the scan to one P&L section's group set. */
function getLedgerMovementsByColumn(
  db: DbHelper,
  companyId: number,
  groupNames: Set<string>,
  columns: string[],
  columnRange: (col: string) => { from: string; to: string },
): Map<string, { groupName: string; values: Record<string, number> }> {
  const out = new Map<string, { groupName: string; values: Record<string, number> }>();
  if (groupNames.size === 0) return out;
  for (const col of columns) {
    const { from, to } = columnRange(col);
    const balances = computeDynamicTB(db, companyId, from, to, fyStartFor(from));
    for (const b of balances) {
      if (!b.groupName || !groupNames.has(b.groupName)) continue;
      const mv = b.credit - b.debit;
      const existing = out.get(b.ledgerName);
      if (!existing) {
        out.set(b.ledgerName, { groupName: b.groupName, values: { [col]: mv } });
      } else {
        existing.values[col] = (existing.values[col] || 0) + mv;
      }
    }
  }
  return out;
}

/**
 * Build a P&L section as a HIERARCHICAL tree, mirroring Tally's Group Summary
 * view. Each immediate child of the section root becomes a top-level child
 * row; expanding it reveals its own sub-groups and direct ledgers, recursively
 * down to ledger leaves. Replaces the earlier flat-list builder that emitted
 * every descendant group as a sibling and obscured Tally's hierarchy.
 *
 * Sign convention: raw movements are credit-positive (credit − debit). Expense
 * sections pass `displaySign = -1` so costs render as positive numbers on the
 * UI; income sections pass `displaySign = +1` (credit movement is already
 * positive).
 *
 * Roots within the section: a group is a "root" if its parent_group is not
 * itself in `groupSet`. This naturally handles sections that span multiple
 * Tally primaries (e.g. Revenue covers both `Sales Accounts` and
 * `Direct Incomes`) — both surface as top-level children, each with their
 * own sub-tree.
 *
 * Dormant nodes (zero net contribution across all columns) are pruned so
 * the UI doesn't list groups/ledgers that contribute nothing in the window.
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
  const hierarchy = loadPLGroupHierarchy(db, companyId);
  const ledgerMoves = getLedgerMovementsByColumn(db, companyId, groupSet, columns, columnRange);

  // Index ledgers by their direct group_name for O(1) lookup during the walk.
  const ledgersByGroup = new Map<string, Array<{ name: string; values: Record<string, number> }>>();
  for (const [ledgerName, info] of ledgerMoves) {
    if (!ledgersByGroup.has(info.groupName)) ledgersByGroup.set(info.groupName, []);
    ledgersByGroup.get(info.groupName)!.push({ name: ledgerName, values: info.values });
  }

  // Walk a single group sub-tree. Returns a PLSection with nested children
  // (sub-groups + direct-leaf ledgers), or `null` if the entire sub-tree is
  // dormant and should be pruned.
  const walkGroup = (groupName: string, parentKey: string): PLSection | null => {
    const nodeKey = `${parentKey}:${groupName}`;
    const childNodes: PLSection[] = [];

    // Recurse into sub-groups that belong to this section.
    for (const childGroup of hierarchy.childrenByParent.get(groupName) || []) {
      if (!groupSet.has(childGroup)) continue;
      const node = walkGroup(childGroup, nodeKey);
      if (node) childNodes.push(node);
    }

    // Leaf ledgers attached directly to this group.
    for (const ledger of ledgersByGroup.get(groupName) || []) {
      const values: Record<string, number> = {};
      let grand = 0;
      for (const c of columns) {
        const v = (ledger.values[c] || 0) * displaySign;
        values[c] = v;
        grand += v;
      }
      if (Math.abs(grand) < 0.01) continue;
      childNodes.push({
        key: `${nodeKey}::${ledger.name}`,
        label: ledger.name,
        isExpense,
        values,
        grandTotal: grand,
      });
    }

    childNodes.sort((a, b) => Math.abs(b.grandTotal) - Math.abs(a.grandTotal));

    // Aggregate this node from its children.
    const values: Record<string, number> = {};
    for (const c of columns) values[c] = 0;
    for (const ch of childNodes) {
      for (const c of columns) values[c] += ch.values[c] || 0;
    }
    const grandTotal = columns.reduce((s, c) => s + values[c], 0);
    if (Math.abs(grandTotal) < 0.01 && childNodes.length === 0) return null;

    return {
      key: nodeKey,
      label: groupName,
      isExpense,
      values,
      grandTotal,
      children: childNodes.length > 0 ? childNodes : undefined,
    };
  };

  // Find the roots within this section: groups whose parent_group is NOT in
  // the section set (or is null entirely). For Revenue / Direct Costs this
  // typically yields multiple Tally primaries (Sales Accounts + Direct Incomes
  // / Purchase Accounts + Direct Expenses); for Indirect Income / Indirect
  // Expenses it yields a single Tally primary.
  const rootGroupNodes: PLSection[] = [];
  for (const group of groupSet) {
    const parent = hierarchy.parentByChild.get(group);
    if (parent && groupSet.has(parent)) continue; // not a root within this set
    const node = walkGroup(group, key);
    if (node) rootGroupNodes.push(node);
  }
  rootGroupNodes.sort((a, b) => Math.abs(b.grandTotal) - Math.abs(a.grandTotal));

  // When a section has exactly one Tally-primary root (e.g. Indirect Expenses,
  // Indirect Income), the user-facing section row already labels it — showing
  // the root again as the only child duplicates the row visually. Inline its
  // children up to the section level. Multi-root sections (Revenue covering
  // both Sales Accounts and Direct Incomes) keep the roots as separate
  // expandable rows so users can tell them apart.
  const sectionChildren = rootGroupNodes.length === 1
    ? (rootGroupNodes[0].children || [])
    : rootGroupNodes;

  // Section parent aggregates from its effective children.
  const parentValues: Record<string, number> = {};
  for (const c of columns) parentValues[c] = 0;
  for (const rc of sectionChildren) {
    for (const c of columns) parentValues[c] += rc.values[c] || 0;
  }
  const parentGrand = columns.reduce((s, c) => s + parentValues[c], 0);

  return {
    key,
    label,
    isExpense,
    values: parentValues,
    grandTotal: parentGrand,
    children: sectionChildren,
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
  // Stock adjustment (closing - opening) is added to GP: inventory still on
  // hand at period end was paid for via purchases (already in Direct Costs)
  // but not yet consumed, so its cost must be added back. Matches Tally's
  // P&L convention exactly.
  const grossProfit: Record<string, number> = {};
  const grossMargin: Record<string, number> = {};
  const netProfit: Record<string, number> = {};
  const stockOpening: Record<string, number> = {};
  const stockClosing: Record<string, number> = {};
  const cogs: Record<string, number> = {};
  let gpGrand = 0, npGrand = 0;
  let soGrand = 0, scGrand = 0, cogsGrand = 0;

  for (const col of columns) {
    const { from: cf, to: ct } = columnRange(col);
    const stock = getStockAdjustment(db, companyId, cf, ct);
    const rev = revenue.values[col] || 0;
    const dc = directCosts.values[col] || 0;      // positive (expense)
    const ii = indirectIncome.values[col] || 0;
    const ie = indirectExpenses.values[col] || 0; // positive (expense)
    const gp = rev - dc + stock.adjustment;
    const np = gp + ii - ie;
    const colCogs = dc + stock.opening - stock.closing; // = directCosts + (opening - closing)
    grossProfit[col] = gp;
    grossMargin[col] = rev !== 0 ? Math.round((gp / rev) * 10000) / 100 : 0;
    netProfit[col] = np;
    stockOpening[col] = stock.opening;
    stockClosing[col] = stock.closing;
    cogs[col] = colCogs;
    gpGrand += gp;
    npGrand += np;
    soGrand += stock.opening;
    scGrand += stock.closing;
    cogsGrand += colCogs;
  }

  return {
    period: { from, to },
    view,
    columns,
    sections,
    computed: { grossProfit, grossMargin, netProfit, stockOpening, stockClosing, cogs },
    grandTotals: {
      revenue: revenue.grandTotal,
      directCosts: directCosts.grandTotal,
      indirectIncome: indirectIncome.grandTotal,
      indirectExpenses: indirectExpenses.grandTotal,
      grossProfit: gpGrand,
      netProfit: npGrand,
      stockOpening: soGrand,
      stockClosing: scGrand,
      cogs: cogsGrand,
    },
  };
}

// ─── Balance Sheet ──────────────────────────────────────────────────────────

// Tally primary (top-level) groups on the Balance Sheet. Listing only primary
// groups is intentional — getGroupTree recurses into each parent's child
// hierarchy, so siblings like Sundry Creditors / Bank Accounts / Cash-in-Hand
// are picked up *inside* their parent (Current Liabilities / Current Assets).
// Listing them here separately as well would double-count every ledger under
// them (a real bug we just fixed: BS short on liabilities by Loans+Branch and
// over on assets by Bank Accounts).
const BS_SECTIONS: Array<{
  key: string; label: string; parent: string; side: 'asset' | 'liability';
}> = [
  // ── Liabilities ──────────────────────────────────────────────────────────
  { key: 'capital',         label: 'Capital Account',       parent: 'Capital Account',       side: 'liability' },
  { key: 'reserves',        label: 'Reserves & Surplus',    parent: 'Reserves & Surplus',    side: 'liability' },
  { key: 'loans',           label: 'Loans (Liability)',     parent: 'Loans (Liability)',     side: 'liability' },
  { key: 'currentLiab',     label: 'Current Liabilities',   parent: 'Current Liabilities',   side: 'liability' },
  { key: 'branchDivisions', label: 'Branch / Divisions',    parent: 'Branch / Divisions',    side: 'liability' },
  { key: 'suspenseLiab',    label: 'Suspense (Liability)',  parent: 'Suspense (Liability)',  side: 'liability' },
  // ── Assets ───────────────────────────────────────────────────────────────
  { key: 'fixedAssets',     label: 'Fixed Assets',          parent: 'Fixed Assets',          side: 'asset' },
  { key: 'investments',     label: 'Investments',           parent: 'Investments',           side: 'asset' },
  { key: 'currentAssets',   label: 'Current Assets',        parent: 'Current Assets',        side: 'asset' },
  { key: 'miscExp',         label: 'Misc. Expenses (Asset)',parent: 'Misc. Expenses (Asset)',side: 'asset' },
];

/**
 * Closing balance for a set of groups as of a given date. Day-accurate via
 * `getBalancesAsOf`: sums credit-positive closings of every ledger whose
 * group is in `groupNames`. Callers flip sign for asset sides as needed.
 */
export function computeBSClosing(
  db: DbHelper,
  companyId: number,
  asOfDate: string,
  groupNames: string[],
): number {
  if (!groupNames.length) return 0;
  const groupSet = new Set(groupNames);
  const balances = getBalancesAsOf(db, companyId, asOfDate);
  let total = 0;
  for (const b of balances) {
    if (b.groupName && groupSet.has(b.groupName)) total += b.closing;
  }
  return total;
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
export function computeBSClosingByLedger(
  db: DbHelper,
  companyId: number,
  asOfDate: string,
  groupNames: string[],
): Map<string, number> {
  const out = new Map<string, number>();
  if (!groupNames.length) return out;
  const groupSet = new Set(groupNames);
  const balances = getBalancesAsOf(db, companyId, asOfDate);
  for (const b of balances) {
    if (b.groupName && groupSet.has(b.groupName)) {
      out.set(b.ledgerName, (out.get(b.ledgerName) || 0) + b.closing);
    }
  }
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

  // Plug the balancing P&L row. In Tally the "Profit & Loss A/c" line carries
  // BOTH (a) the OPENING balance of the P&L A/c group from prior years (the
  // accumulated retained P&L brought forward), AND (b) the current FY's net
  // profit which hasn't been year-end-closed into P&L A/c yet.
  // Earlier this row only had (b), so the BS was short by (a) — typically a
  // negative for businesses with prior-year losses, making liabilities under-
  // count by exactly that amount and the BS fail to tie out against Tally.
  const plValues: Record<string, number> = {};
  let plGrand = 0;
  let plNonZero = false;
  const plGroups = getGroupTree(db, companyId, 'Profit & Loss A/c');
  for (const col of columns) {
    const colAsOf = asOfByCol[col];
    const opening = plGroups.length ? computeBSClosing(db, companyId, colAsOf, plGroups) : 0;
    const np = computeYTDNetProfit(db, companyId, fyStart(db, companyId, colAsOf), colAsOf);
    const total = opening + np;
    plValues[col] = total;
    plGrand += total;
    totalLiabilities[col] += total;
    if (Math.abs(total) > 0.01) plNonZero = true;
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

  // ── Per-ledger children for each WC line ────────────────────────────────
  // Convention mirrors the parent amount: a DROP in an asset (debtors/stock)
  // is a cash inflow — so we use (opening - closing). For liabilities
  // (creditors/loans), a RISE is a cash inflow — so (closing - opening).
  // `sign` flips the raw BS closing into display-positive before the delta.
  const ledgerDelta = (
    groupNames: string[],
    sign: 1 | -1,
    direction: 'drop-is-inflow' | 'rise-is-inflow',
  ): CFLine[] => {
    const closingByL = computeBSClosingByLedger(db, companyId, to, groupNames);
    const openingByL = computeBSClosingByLedger(db, companyId, openingDate, groupNames);
    const names = new Set<string>([...closingByL.keys(), ...openingByL.keys()]);
    const out: CFLine[] = [];
    for (const name of names) {
      const op = (openingByL.get(name) || 0) * sign;
      const cl = (closingByL.get(name) || 0) * sign;
      const delta = direction === 'drop-is-inflow' ? (op - cl) : (cl - op);
      if (Math.abs(delta) < 0.01) continue;
      out.push({ label: name, amount: delta });
    }
    out.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
    return out;
  };

  const operating: CFLine[] = [
    { label: 'Net Profit', amount: pl.netProfit },
    { label: 'Add: Depreciation (non-cash)', amount: 0 }, // placeholder — full depreciation detection deferred
    {
      label: '(Inc)/Dec in Sundry Debtors',
      amount: openingDebtors - closingDebtors,
      children: ledgerDelta(sdGroups, -1, 'drop-is-inflow'),
    },
    {
      label: 'Inc/(Dec) in Sundry Creditors',
      amount: closingCreditors - openingCreditors,
      children: ledgerDelta(scGroups, +1, 'rise-is-inflow'),
    },
    {
      label: '(Inc)/Dec in Stock',
      amount: openingStockBal - closingStockBal,
      children: ledgerDelta(stockGroups, -1, 'drop-is-inflow'),
    },
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
    {
      label: '(Purchase)/Sale of Fixed Assets',
      amount: openingFA - closingFA,
      children: ledgerDelta(faGroups, -1, 'drop-is-inflow'),
    },
    {
      label: '(Purchase)/Sale of Investments',
      amount: openingInv - closingInv,
      children: ledgerDelta(invGroups, -1, 'drop-is-inflow'),
    },
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
    {
      label: 'Inc/(Dec) in Secured Loans',
      amount: closingSL - openingSL,
      children: ledgerDelta(slGroups, +1, 'rise-is-inflow'),
    },
    {
      label: 'Inc/(Dec) in Unsecured Loans',
      amount: closingUL - openingUL,
      children: ledgerDelta(ulGroups, +1, 'rise-is-inflow'),
    },
    {
      label: 'Inc/(Dec) in Capital',
      amount: closingCap - openingCap,
      children: ledgerDelta(capGroups, +1, 'rise-is-inflow'),
    },
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

export type CompanyRef = {
  id: number;
  name: string;
  branchName?: string | null;
  streamName?: string | null;
};

/**
 * Preferred display label for a bifurcate column.
 *
 * Shape:
 *   - Both branch & stream known  → "Bangalore · Clinic"
 *   - Only branch known           → "Bangalore"
 *   - Only stream known           → "Clinic"
 *   - Neither known               → Tally company name (fallback)
 *
 * Keeps the UI tied to the app's human taxonomy (branches/streams) rather than
 * the raw Tally company names from the sync-agent feed.
 */
function companyColumnLabel(c: CompanyRef): string {
  const b = (c.branchName || '').trim();
  const s = (c.streamName || '').trim();
  if (b && s) return `${b} · ${s}`;
  if (b) return b;
  if (s) return s;
  return c.name;
}

/** Recursively merge several lists of PLSection children by label. Used by
 *  multi-company consolidation: each company's tree may differ slightly (one
 *  has a sub-group the other doesn't, or labels collide at different depths),
 *  so we union by label at each level and recurse into nested `children`. */
function mergeChildrenPL(children: PLSection[][]): PLSection[] {
  // Accumulator holds the merged section plus the raw per-source children
  // arrays so we can merge the next level after this one is keyed.
  const byLabel = new Map<string, { merged: PLSection; nestedSources: PLSection[][] }>();
  for (const list of children) {
    for (const ch of list) {
      const existing = byLabel.get(ch.label);
      if (!existing) {
        byLabel.set(ch.label, {
          merged: {
            key: ch.key,
            label: ch.label,
            isExpense: ch.isExpense,
            values: { ...ch.values },
            grandTotal: ch.grandTotal,
          },
          nestedSources: ch.children ? [ch.children] : [],
        });
      } else {
        for (const [col, v] of Object.entries(ch.values)) {
          existing.merged.values[col] = (existing.merged.values[col] || 0) + v;
        }
        existing.merged.grandTotal += ch.grandTotal;
        if (ch.children) existing.nestedSources.push(ch.children);
      }
    }
  }
  const out: PLSection[] = [];
  for (const { merged, nestedSources } of byLabel.values()) {
    if (nestedSources.length > 0) {
      const mergedChildren = mergeChildrenPL(nestedSources);
      if (mergedChildren.length > 0) merged.children = mergedChildren;
    }
    out.push(merged);
  }
  return out.sort((a, b) => Math.abs(b.grandTotal) - Math.abs(a.grandTotal));
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
      computed: {
        grossProfit: zeros, grossMargin: zeros, netProfit: zeros,
        stockOpening: { ...zeros }, stockClosing: { ...zeros }, cogs: { ...zeros },
      },
      grandTotals: {
        revenue: 0, directCosts: 0, indirectIncome: 0, indirectExpenses: 0,
        grossProfit: 0, netProfit: 0,
        stockOpening: 0, stockClosing: 0, cogs: 0,
      },
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
      stockOpening: {} as Record<string, number>,
      stockClosing: {} as Record<string, number>,
      cogs: {} as Record<string, number>,
    };
    let gpGrand = 0, npGrand = 0, soGrand = 0, scGrand = 0, cogsGrand = 0;
    for (const col of columns) {
      let gp = 0, np = 0, so = 0, sc = 0, cogsCol = 0;
      for (const { report } of perCompany) {
        gp += report.computed.grossProfit[col] || 0;
        np += report.computed.netProfit[col] || 0;
        so += report.computed.stockOpening?.[col] || 0;
        sc += report.computed.stockClosing?.[col] || 0;
        cogsCol += report.computed.cogs?.[col] || 0;
      }
      computed.grossProfit[col] = gp;
      computed.netProfit[col] = np;
      computed.stockOpening[col] = so;
      computed.stockClosing[col] = sc;
      computed.cogs[col] = cogsCol;
      const rev = revenue.values[col] || 0;
      computed.grossMargin[col] = rev !== 0 ? Math.round((gp / rev) * 10000) / 100 : 0;
      gpGrand += gp;
      npGrand += np;
      soGrand += so;
      scGrand += sc;
      cogsGrand += cogsCol;
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
        stockOpening: soGrand,
        stockClosing: scGrand,
        cogs: cogsGrand,
      },
    };
  }

  // Bifurcation: columns become one per company, plus a final 'total' column.
  const compKey = (c: CompanyRef) => `co:${c.id}`;
  const columns = companies.map(compKey).concat('total');
  const columnLabels: Record<string, string> = {};
  for (const c of companies) columnLabels[compKey(c)] = companyColumnLabel(c);
  columnLabels.total = 'Total';

  // For each top-level section, one column per company = that company's
  // grandTotal for that section. Children inherit the same column shape
  // recursively, so a sub-group like "Admin and Other Overhead" gets one
  // column per company and a final `total`. The walk reuses each company's
  // own hierarchical tree (built by `buildPLSectionWithChildren`) and unions
  // nodes across companies by label at every depth.
  const buildBifurcatedSection = (key: string, label: string, isExpense: boolean): PLSection => {
    const values: Record<string, number> = Object.fromEntries(columns.map(c => [c, 0]));
    let grandTotal = 0;

    // Per-company source children lists for this section. We hand these to the
    // recursive walker below so the bifurcated tree matches the depth of the
    // underlying per-company trees.
    const sourceChildren: Array<{ company: CompanyRef; children: PLSection[] }> = [];
    for (const { company, report } of perCompany) {
      const sec = report.sections.find(s => s.key === key);
      if (!sec) continue;
      const total = sec.grandTotal;
      values[compKey(company)] = total;
      values.total += total;
      grandTotal += total;
      sourceChildren.push({ company, children: sec.children || [] });
    }

    return {
      key, label, isExpense, values, grandTotal,
      children: bifurcateChildrenByLabel(sourceChildren, key),
    };
  };

  // Recursively union per-company section trees by label. At each level, a
  // child node's per-company column gets that company's contribution for the
  // node, and the node's own `children` are produced by recursing into the
  // per-company children lists carrying the same label.
  const bifurcateChildrenByLabel = (
    perCompanyChildren: Array<{ company: CompanyRef; children: PLSection[] }>,
    parentKey: string,
  ): PLSection[] => {
    const byLabel = new Map<string, {
      label: string;
      isExpense: boolean;
      values: Record<string, number>;
      grandTotal: number;
      sources: Array<{ company: CompanyRef; children: PLSection[] }>;
    }>();
    for (const { company, children } of perCompanyChildren) {
      for (const ch of children) {
        if (!byLabel.has(ch.label)) {
          byLabel.set(ch.label, {
            label: ch.label,
            isExpense: ch.isExpense,
            values: Object.fromEntries(columns.map(c => [c, 0])),
            grandTotal: 0,
            sources: [],
          });
        }
        const acc = byLabel.get(ch.label)!;
        acc.values[compKey(company)] = (acc.values[compKey(company)] || 0) + ch.grandTotal;
        acc.values.total += ch.grandTotal;
        acc.grandTotal += ch.grandTotal;
        if (ch.children?.length) acc.sources.push({ company, children: ch.children });
      }
    }
    const out: PLSection[] = [];
    for (const [name, v] of byLabel) {
      const nodeKey = `${parentKey}:${name}`;
      const nested = v.sources.length > 0 ? bifurcateChildrenByLabel(v.sources, nodeKey) : undefined;
      out.push({
        key: nodeKey, label: v.label, isExpense: v.isExpense,
        values: v.values, grandTotal: v.grandTotal,
        children: nested && nested.length > 0 ? nested : undefined,
      });
    }
    return out.sort((a, b) => Math.abs(b.grandTotal) - Math.abs(a.grandTotal));
  };

  const revenue = buildBifurcatedSection('revenue', 'Revenue', false);
  const directCosts = buildBifurcatedSection('directCosts', 'Direct Costs', true);
  const indirectIncome = buildBifurcatedSection('indirectIncome', 'Indirect Income', false);
  const indirectExpenses = buildBifurcatedSection('indirectExpenses', 'Indirect Expenses', true);

  const computed = {
    grossProfit: {} as Record<string, number>,
    grossMargin: {} as Record<string, number>,
    netProfit: {} as Record<string, number>,
    stockOpening: {} as Record<string, number>,
    stockClosing: {} as Record<string, number>,
    cogs: {} as Record<string, number>,
  };
  for (const col of columns) {
    computed.grossProfit[col] = 0;
    computed.grossMargin[col] = 0;
    computed.netProfit[col] = 0;
    computed.stockOpening[col] = 0;
    computed.stockClosing[col] = 0;
    computed.cogs[col] = 0;
  }

  let gpGrand = 0, npGrand = 0, soGrand = 0, scGrand = 0, cogsGrand = 0;
  for (const { company, report } of perCompany) {
    const gp = report.grandTotals.grossProfit;
    const np = report.grandTotals.netProfit;
    const so = report.grandTotals.stockOpening || 0;
    const sc = report.grandTotals.stockClosing || 0;
    const coCogs = report.grandTotals.cogs || 0;
    computed.grossProfit[compKey(company)] = gp;
    computed.netProfit[compKey(company)] = np;
    computed.stockOpening[compKey(company)] = so;
    computed.stockClosing[compKey(company)] = sc;
    computed.cogs[compKey(company)] = coCogs;
    computed.grossProfit.total += gp;
    computed.netProfit.total += np;
    computed.stockOpening.total += so;
    computed.stockClosing.total += sc;
    computed.cogs.total += coCogs;
    gpGrand += gp;
    npGrand += np;
    soGrand += so;
    scGrand += sc;
    cogsGrand += coCogs;
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
      stockOpening: soGrand,
      stockClosing: scGrand,
      cogs: cogsGrand,
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
  for (const c of companies) columnLabels[compKey(c)] = companyColumnLabel(c);
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
      const kidsByParent = new Map<string, Map<string, number>>();
      for (const { report } of perCompany) {
        for (const line of getLines(report)) {
          const existing = byLabel.get(line.label);
          if (!existing) byLabel.set(line.label, { label: line.label, amount: line.amount });
          else existing.amount += line.amount;

          if (line.children?.length) {
            if (!kidsByParent.has(line.label)) kidsByParent.set(line.label, new Map());
            const bucket = kidsByParent.get(line.label)!;
            for (const ch of line.children) {
              bucket.set(ch.label, (bucket.get(ch.label) || 0) + ch.amount);
            }
          }
        }
      }
      for (const [label, bucket] of kidsByParent.entries()) {
        const parent = byLabel.get(label);
        if (!parent) continue;
        const kids = [...bucket.entries()]
          .filter(([, v]) => Math.abs(v) >= 0.01)
          .map(([l, v]) => ({ label: l, amount: v }));
        kids.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
        if (kids.length) parent.children = kids;
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
  for (const c of companies) columnLabels[compKey(c)] = companyColumnLabel(c);
  columnLabels.total = 'Total';

  const mergeLinesBifurcated = (getLines: (r: CFStatement) => CFLine[]): CFLine[] => {
    const byLabel = new Map<string, CFLine>();
    // Per-parent → per-child → per-column-key aggregator
    const kidsByParent = new Map<string, Map<string, Record<string, number>>>();
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

        if (line.children?.length) {
          if (!kidsByParent.has(line.label)) kidsByParent.set(line.label, new Map());
          const bucket = kidsByParent.get(line.label)!;
          for (const ch of line.children) {
            if (!bucket.has(ch.label)) bucket.set(ch.label, Object.fromEntries(columns.map(c => [c, 0])));
            const row = bucket.get(ch.label)!;
            row[compKey(company)] = ch.amount;
            row.total += ch.amount;
          }
        }
      }
    }
    for (const [label, bucket] of kidsByParent.entries()) {
      const parent = byLabel.get(label);
      if (!parent) continue;
      const kids: CFLine[] = [];
      for (const [childLabel, values] of bucket.entries()) {
        if (Math.abs(values.total || 0) < 0.01) continue;
        kids.push({ label: childLabel, amount: values.total || 0, values });
      }
      kids.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
      if (kids.length) parent.children = kids;
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
    return { period: { from, to }, rows: [], groups: [], totals: { opening: 0, debit: 0, credit: 0, closing: 0 } };
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
  return { period: { from, to }, rows, groups: groupTBRows(rows), totals };
}
