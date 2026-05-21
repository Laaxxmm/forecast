// ─────────────────────────────────────────────────────────────────────────────
// Zoho → vCFO normalizer (the crux that makes BOTH vCFO + Forecast work).
//
// Zoho Books classifies every account by `account_type` (income, expense,
// cost_of_goods_sold, accounts_receivable, bank, …). Our reporting layer
// instead expects a Tally-style account-GROUP hierarchy where:
//   • every group's parent chain terminates at the 'Primary' root sentinel
//     (the Forecast budget-vs-actual CTE walks parent_group up to 'Primary'),
//   • each group carries bs_pl ('BS'|'PL'), dr_cr ('D'|'C') and
//     affects_gross_profit ('Y'|'N') — what the vCFO P&L / Balance-Sheet
//     builder reads (see ingest.ts ingestGroups CHECK constraints).
//
// v1 deliberately FLATTENS Zoho's own (often shallow / custom) sub-account
// tree into a fixed 2-level hierarchy: Primary → <canonical group> → ledger.
// This guarantees correct P&L/BS classification regardless of how the client
// named their Zoho groups. The operator can refine Forecast category mappings
// per-tenant afterwards, exactly as they do for Tally companies.
//
// Pure module — no I/O, no deps. Trivially unit-testable.
// ─────────────────────────────────────────────────────────────────────────────

/** Tally's root-group sentinel; parent_group of every top-level group. */
export const PRIMARY_GROUP = 'Primary';

export interface GroupClassification {
  groupName: string;
  parentGroup: string; // always PRIMARY_GROUP in v1
  bsPl: 'BS' | 'PL';
  drCr: 'D' | 'C'; // natural balance side: assets/expenses=D, liabilities/income/equity=C
  affectsGrossProfit: 'Y' | 'N';
}

type GroupDef = Omit<GroupClassification, 'parentGroup'>;

// Keyed by Zoho's `account_type`. Covers the full documented enum plus a few
// aliases Zoho uses in practice (inventory ≈ stock).
const ACCOUNT_TYPE_MAP: Record<string, GroupDef> = {
  // ── P&L ──
  income: { groupName: 'Sales Accounts', bsPl: 'PL', drCr: 'C', affectsGrossProfit: 'Y' },
  other_income: { groupName: 'Indirect Incomes', bsPl: 'PL', drCr: 'C', affectsGrossProfit: 'N' },
  cost_of_goods_sold: { groupName: 'Direct Expenses', bsPl: 'PL', drCr: 'D', affectsGrossProfit: 'Y' },
  expense: { groupName: 'Indirect Expenses', bsPl: 'PL', drCr: 'D', affectsGrossProfit: 'N' },
  other_expense: { groupName: 'Indirect Expenses', bsPl: 'PL', drCr: 'D', affectsGrossProfit: 'N' },

  // ── Balance Sheet — assets (debit nature) ──
  accounts_receivable: { groupName: 'Sundry Debtors', bsPl: 'BS', drCr: 'D', affectsGrossProfit: 'N' },
  cash: { groupName: 'Cash-in-Hand', bsPl: 'BS', drCr: 'D', affectsGrossProfit: 'N' },
  bank: { groupName: 'Bank Accounts', bsPl: 'BS', drCr: 'D', affectsGrossProfit: 'N' },
  fixed_asset: { groupName: 'Fixed Assets', bsPl: 'BS', drCr: 'D', affectsGrossProfit: 'N' },
  stock: { groupName: 'Stock-in-Hand', bsPl: 'BS', drCr: 'D', affectsGrossProfit: 'N' },
  inventory: { groupName: 'Stock-in-Hand', bsPl: 'BS', drCr: 'D', affectsGrossProfit: 'N' },
  other_current_asset: { groupName: 'Current Assets', bsPl: 'BS', drCr: 'D', affectsGrossProfit: 'N' },
  other_asset: { groupName: 'Current Assets', bsPl: 'BS', drCr: 'D', affectsGrossProfit: 'N' },

  // ── Balance Sheet — liabilities & equity (credit nature) ──
  accounts_payable: { groupName: 'Sundry Creditors', bsPl: 'BS', drCr: 'C', affectsGrossProfit: 'N' },
  credit_card: { groupName: 'Bank OD & Credit Cards', bsPl: 'BS', drCr: 'C', affectsGrossProfit: 'N' },
  other_current_liability: { groupName: 'Current Liabilities', bsPl: 'BS', drCr: 'C', affectsGrossProfit: 'N' },
  long_term_liability: { groupName: 'Loans (Liability)', bsPl: 'BS', drCr: 'C', affectsGrossProfit: 'N' },
  other_liability: { groupName: 'Current Liabilities', bsPl: 'BS', drCr: 'C', affectsGrossProfit: 'N' },
  equity: { groupName: 'Capital Account', bsPl: 'BS', drCr: 'C', affectsGrossProfit: 'N' },
};

// Unknown / unmapped types land in a clearly-named BS bucket rather than being
// silently dropped or mis-posted into the P&L. Surfaced for the operator to
// reclassify; keeps gross profit honest.
const FALLBACK: GroupDef = {
  groupName: 'Suspense A/c',
  bsPl: 'BS',
  drCr: 'D',
  affectsGrossProfit: 'N',
};

/** Map a Zoho `account_type` to its Tally-style group classification. */
export function classifyAccountType(accountType: string | null | undefined): GroupClassification {
  const key = String(accountType || '').trim().toLowerCase();
  const def = ACCOUNT_TYPE_MAP[key] || FALLBACK;
  return { ...def, parentGroup: PRIMARY_GROUP };
}

/** True when the type isn't in our map (caller may want to log it). */
export function isUnmappedAccountType(accountType: string | null | undefined): boolean {
  const key = String(accountType || '').trim().toLowerCase();
  return !(key in ACCOUNT_TYPE_MAP);
}
