// ─────────────────────────────────────────────────────────────────────────────
// VCFO P&L Allocation Engine.
//
// Produces the "true" management P&L view that sits below the as-booked table
// at /vcfo/profit-loss. The books table stays the audit trail; this engine
// returns an adjusted PLStatement where costs land where they were actually
// CONSUMED, not where the accountant happened to post them.
//
// Two rule patterns supported:
//
//   pool_split   — one source bucket fanned out across many destinations.
//                  Example: Rent booked entirely at "BTM Clinic" is split
//                  60/40 with "BTM Pharmacy" based on occupied sqft.
//
//   cross_charge — many destinations charged X% of their OWN metric; the
//                  sum is credited back to a single provider. Example:
//                  Jubilee Hills runs central diagnostics for every
//                  Hyderabad branch; each consumer pays 30% of its own
//                  diagnostics revenue, total offsets Jubilee Hills'
//                  lab-consumables expense.
//
// Pure functions, no Express coupling. Called from /profit-loss after
// buildProfitLossMulti when the caller passes ?withAdjustments=1.
//
// Apply order: rules sort by (priority ASC, id ASC), and each rule mutates
// the running adjusted statement — not the baseline. This lets accountants
// stack rules (pull HO costs out first, then redistribute the consolidated
// indirect-expense pool by revenue share, etc.).
//
// Note on signs: P&L sections store amounts as positive numbers regardless
// of dr/cr — Revenue 100 means ₹100 income, Indirect Expenses 30 means ₹30
// of expense. The engine respects this: moving money OUT of an expense
// source decreases the source cell; moving money IN to an expense
// destination increases the destination cell. For income sections the
// physics is opposite but the mechanics are identical (sign is carried by
// the section's isExpense flag).
// ─────────────────────────────────────────────────────────────────────────────

import type { DbHelper } from '../db/connection.js';
import {
  getLedgerMovements,
  type PLStatement,
  type PLSection,
} from './vcfo-report-builder.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AllocationRuleDestinationRow {
  id: number;
  rule_id: number;
  destination_company_id: number;
  weight: number;
  weight_basis_label: string | null;
  sort_order: number | null;
}

export interface AllocationRuleRow {
  id: number;
  name: string;
  description: string | null;
  enabled: number;
  effective_from: string | null;
  effective_to: string | null;
  priority: number;
  rule_kind: 'pool_split' | 'cross_charge';

  // pool_split
  source_type: 'ledger' | 'pl_line' | 'custom_amount' | null;
  source_company_id: number | null;
  source_ledger_name: string | null;
  source_pl_section_key: string | null;
  source_custom_amount: number | null;

  // cross_charge
  provider_company_id: number | null;
  charge_basis_section_key: string | null;
  charge_pct: number | null;
  provider_credit_section_key: string | null;

  alloc_method:
    | 'fixed_pct'
    | 'equal_split'
    | 'revenue_share'
    | 'weighted_ratio'
    | 'manual_amounts'
    | null;
  target_pl_section_key: string | null;

  /** Multi-branch mode: JSON-encoded array of {source, destinations} groups.
   *  When non-null, the engine iterates each entry as an independent pool-split
   *  run sharing only `alloc_method` + `target_pl_section_key` with the rule
   *  envelope. Rule-level `source_*` fields are ignored in this mode. */
  branch_configs: string | null;
}

/** Parsed shape of one entry in `branch_configs`.
 *
 *  Carries BOTH pool_split and cross_charge fields — only the subset matching
 *  the parent rule's `rule_kind` is meaningful. This lets one rule kind use
 *  multi-branch (e.g. Rent Adjustment with branches for each location) and
 *  another rule kind use multi-branch independently (e.g. central diagnostics
 *  with branches for each city's lab provider). The engine dispatches on
 *  rule_kind and reads only the relevant fields. */
export interface BranchConfig {
  label?: string;
  // pool_split fields
  source_type?: 'ledger' | 'pl_line' | 'custom_amount';
  source_company_id?: number | null;
  source_ledger_name?: string | null;
  source_pl_section_key?: string | null;
  source_custom_amount?: number | null;
  // cross_charge fields
  provider_company_id?: number | null;
  charge_basis_section_key?: string | null;
  charge_pct?: number | null;
  provider_credit_section_key?: string | null;
  // common — pool_split destinations OR cross_charge consumers
  destinations: Array<{
    destination_company_id: number;
    weight: number;
    weight_basis_label?: string | null;
  }>;
}

export interface LoadedRule extends AllocationRuleRow {
  destinations: AllocationRuleDestinationRow[];
  /** Parsed branch_configs, populated by loadActiveRules when the column is set. */
  parsedBranchConfigs?: BranchConfig[] | null;
}

export interface AdjustmentEvent {
  ruleId: number;
  ruleName: string;
  ruleKind: 'pool_split' | 'cross_charge';
  /** Source column (e.g. 'co:336'); empty for custom_amount / cross_charge per-consumer events. */
  sourceCol: string;
  /** Friendly label of source company; empty for custom_amount / cross_charge per-consumer events. */
  sourceLabel: string;
  destinationCol: string;
  destinationLabel: string;
  /** Which P&L section key was mutated at the destination. */
  targetSectionKey: string;
  /** Positive rupee amount of the adjustment. Sign is implied by section.isExpense. */
  amount: number;
  /** Optional human-readable note about the basis (e.g. "1200 sqft of 2000"). */
  basisNote?: string;
}

export interface AllocationResult {
  base: PLStatement;
  adjusted: PLStatement;
  events: AdjustmentEvent[];
  warnings: string[];
}

// ─── Rule loading ──────────────────────────────────────────────────────────

/**
 * Load enabled rules whose effective window overlaps [from, to]. A rule with
 * NULL effective_from is "always on from the beginning of time"; NULL
 * effective_to is "always on through eternity". Sort order is (priority ASC,
 * id ASC) so accountants can predict apply order.
 */
function loadActiveRules(
  db: DbHelper,
  from: string,
  to: string,
): LoadedRule[] {
  // Effective window overlap: rule's [from, to] intersects requested [from, to].
  // NULL effective_from → -infinity; NULL effective_to → +infinity.
  const rules = db.all(
    `SELECT * FROM vcfo_allocation_rules
       WHERE enabled = 1
         AND (effective_from IS NULL OR effective_from <= ?)
         AND (effective_to   IS NULL OR effective_to   >= ?)
       ORDER BY priority ASC, id ASC`,
    to,
    from,
  ) as AllocationRuleRow[];

  if (rules.length === 0) return [];

  const destRows = db.all(
    `SELECT * FROM vcfo_allocation_rule_destinations
       WHERE rule_id IN (${rules.map(() => '?').join(',')})
       ORDER BY rule_id ASC, sort_order ASC, id ASC`,
    ...rules.map(r => r.id),
  ) as AllocationRuleDestinationRow[];

  const byRule = new Map<number, AllocationRuleDestinationRow[]>();
  for (const d of destRows) {
    if (!byRule.has(d.rule_id)) byRule.set(d.rule_id, []);
    byRule.get(d.rule_id)!.push(d);
  }

  return rules.map(r => ({
    ...r,
    destinations: byRule.get(r.id) || [],
    parsedBranchConfigs: parseBranchConfigs(r.branch_configs),
  }));
}

/** Defensive JSON parser — returns null on any failure so the engine can fall
 *  back to single-source mode rather than crashing the whole report. */
function parseBranchConfigs(raw: string | null): BranchConfig[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    return parsed as BranchConfig[];
  } catch {
    return null;
  }
}

// ─── PLStatement helpers ───────────────────────────────────────────────────

/** Deep-clone the PLStatement so the engine can mutate freely. */
function cloneStatement(s: PLStatement): PLStatement {
  return {
    period: { ...s.period },
    view: s.view,
    columns: [...s.columns],
    columnLabels: s.columnLabels ? { ...s.columnLabels } : undefined,
    bifurcated: s.bifurcated,
    companies: s.companies ? s.companies.map(c => ({ ...c })) : undefined,
    sections: s.sections.map(cloneSection),
    computed: {
      grossProfit: { ...s.computed.grossProfit },
      grossMargin: { ...s.computed.grossMargin },
      netProfit: { ...s.computed.netProfit },
      stockOpening: { ...s.computed.stockOpening },
      stockClosing: { ...s.computed.stockClosing },
      cogs: { ...s.computed.cogs },
    },
    grandTotals: { ...s.grandTotals },
  };
}

function cloneSection(sec: PLSection): PLSection {
  return {
    key: sec.key,
    label: sec.label,
    isExpense: sec.isExpense,
    values: { ...sec.values },
    grandTotal: sec.grandTotal,
    children: sec.children ? sec.children.map(cloneSection) : undefined,
  };
}

/**
 * Walk a section tree and return the first section whose `key` matches.
 * Supports nested keys like 'revenue:Sales:Diagnostics' that drill into the
 * children array (the bifurcated PL builder uses `${parentKey}:${name}`).
 */
function findSection(
  sections: PLSection[],
  key: string,
): PLSection | null {
  for (const s of sections) {
    if (s.key === key) return s;
    if (s.children) {
      const hit = findSection(s.children, key);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Variant of findSection that returns the FULL ancestor chain from the root
 * of `sections` down to the target. Used by applyDeltaToCell to propagate a
 * cell mutation up through every parent so aggregates stay coherent.
 *
 * Without this, a drain from a child section (e.g. 'indirectExpenses:Rental
 * Expenses') wouldn't update the parent 'indirectExpenses' row, leaving the
 * Net Profit recompute reading a stale parent value and surfacing a wrong
 * delta in the adjusted view.
 */
function findSectionPath(
  sections: PLSection[],
  key: string,
): PLSection[] | null {
  for (const s of sections) {
    if (s.key === key) return [s];
    if (s.children) {
      const sub = findSectionPath(s.children, key);
      if (sub) return [s, ...sub];
    }
  }
  return null;
}

/** Column key for a company in the bifurcated view. */
function colFor(companyId: number): string {
  return `co:${companyId}`;
}

/** Friendly label for a column, falling back to the raw key. */
function labelFor(s: PLStatement, col: string): string {
  return s.columnLabels?.[col] || col;
}

// ─── Source amount resolution (pool_split) ─────────────────────────────────

/**
 * Compute the amount currently held in the rule's "source" for a given
 * adjusted snapshot. Sources can be:
 *   ledger        — net movement of a specific Tally ledger over the period
 *   pl_line       — current value at a P&L section key on the source company's column
 *   custom_amount — literal rupees (synthetic transfer, no source mutation)
 */
function resolveSourceAmount(
  db: DbHelper,
  rule: LoadedRule,
  adjusted: PLStatement,
  period: { from: string; to: string },
): { amount: number; sourceCol: string | null; mutateSource: boolean } {
  if (rule.source_type === 'custom_amount') {
    return {
      amount: rule.source_custom_amount || 0,
      sourceCol: null,
      mutateSource: false,
    };
  }

  if (!rule.source_company_id) {
    return { amount: 0, sourceCol: null, mutateSource: false };
  }
  const sourceCol = colFor(rule.source_company_id);

  if (rule.source_type === 'ledger') {
    if (!rule.source_ledger_name) {
      return { amount: 0, sourceCol, mutateSource: true };
    }
    const movements = getLedgerMovements(
      db,
      rule.source_company_id,
      period.from,
      period.to,
    );
    const hit = movements.find(m => m.ledgerName === rule.source_ledger_name);
    // Credit-positive movement; expenses come out as negative numbers.
    // We surface them as positive rupee amounts so the rest of the engine
    // can stay sign-agnostic — the destination section's isExpense flag
    // determines whether the value is added (expense) or subtracted (income)
    // on the way back in.
    const amount = Math.abs(hit?.movement || 0);
    return { amount, sourceCol, mutateSource: true };
  }

  if (rule.source_type === 'pl_line') {
    if (!rule.source_pl_section_key) {
      return { amount: 0, sourceCol, mutateSource: true };
    }
    const section = findSection(adjusted.sections, rule.source_pl_section_key);
    if (!section) return { amount: 0, sourceCol, mutateSource: true };
    return {
      amount: section.values[sourceCol] || 0,
      sourceCol,
      mutateSource: true,
    };
  }

  return { amount: 0, sourceCol, mutateSource: false };
}

// ─── Pool-split distribution methods ───────────────────────────────────────

/**
 * Given a total source amount and the rule's destinations, return the rupee
 * amount to apply at each destination column. Sums to the source amount
 * within rounding (always within 1 paisa).
 */
function distribute(
  rule: LoadedRule,
  sourceAmount: number,
  adjusted: PLStatement,
  warnings: string[],
): Array<{ destinationCompanyId: number; amount: number; basisNote?: string }> {
  const dests = rule.destinations;
  if (dests.length === 0) return [];

  const fallbackToEqualSplit = (reason: string) => {
    warnings.push(`Rule "${rule.name}": ${reason}; falling back to equal_split`);
    const share = sourceAmount / dests.length;
    return dests.map(d => ({
      destinationCompanyId: d.destination_company_id,
      amount: share,
    }));
  };

  switch (rule.alloc_method) {
    case 'fixed_pct': {
      const sum = dests.reduce((a, d) => a + (d.weight || 0), 0);
      if (sum === 0) {
        return fallbackToEqualSplit('all destination percentages are zero');
      }
      // Renormalise: even if accountant entered 99 or 101 we still distribute
      // 100% of the source. Server-side validation rejects sums off by >0.01
      // at POST/PUT; this is just defensive.
      if (Math.abs(sum - 100) > 0.01) {
        warnings.push(
          `Rule "${rule.name}": fixed_pct destinations sum to ${sum.toFixed(2)}, renormalising to 100`,
        );
      }
      return dests.map(d => ({
        destinationCompanyId: d.destination_company_id,
        amount: sourceAmount * ((d.weight || 0) / sum),
        basisNote: `${((d.weight || 0) / sum * 100).toFixed(1)}%`,
      }));
    }

    case 'equal_split': {
      const share = sourceAmount / dests.length;
      return dests.map(d => ({
        destinationCompanyId: d.destination_company_id,
        amount: share,
        basisNote: `1/${dests.length}`,
      }));
    }

    case 'revenue_share': {
      // Read per-destination revenue from the CURRENT adjusted snapshot,
      // not the baseline. If a previous rule already shifted revenue (rare
      // but possible) we want to honour that.
      const revenueSection = findSection(adjusted.sections, 'revenue');
      if (!revenueSection) {
        return fallbackToEqualSplit("no 'revenue' section in statement");
      }
      const perDest = dests.map(d => ({
        d,
        rev: revenueSection.values[colFor(d.destination_company_id)] || 0,
      }));
      const totalRev = perDest.reduce((a, x) => a + x.rev, 0);
      if (totalRev <= 0) {
        return fallbackToEqualSplit('total revenue across destinations is zero');
      }
      return perDest.map(({ d, rev }) => ({
        destinationCompanyId: d.destination_company_id,
        amount: sourceAmount * (rev / totalRev),
        basisNote: `${(rev / totalRev * 100).toFixed(1)}% revenue share`,
      }));
    }

    case 'weighted_ratio': {
      // Raw basis number (sqft, headcount, anything). Engine normalises.
      // This is the method the Rent rule uses, with sqft typed into each
      // destination's `weight` column.
      const sum = dests.reduce((a, d) => a + (d.weight || 0), 0);
      if (sum === 0) {
        return fallbackToEqualSplit(
          'all destination weights are zero (admin forgot to enter the basis values)',
        );
      }
      const unit = dests[0]?.weight_basis_label || '';
      return dests.map(d => ({
        destinationCompanyId: d.destination_company_id,
        amount: sourceAmount * ((d.weight || 0) / sum),
        basisNote: unit
          ? `${d.weight} ${unit} of ${sum} ${unit}`
          : `${d.weight} of ${sum}`,
      }));
    }

    case 'manual_amounts': {
      // Weights ARE the absolute rupee amounts. We don't normalise — if the
      // sum doesn't match the source, the difference stays at the source
      // (with a warning).
      const sum = dests.reduce((a, d) => a + (d.weight || 0), 0);
      if (sum > sourceAmount + 0.01) {
        warnings.push(
          `Rule "${rule.name}": manual_amounts sum to ${sum.toFixed(2)} > source ${sourceAmount.toFixed(2)}; applied anyway, diff stays at source`,
        );
      }
      return dests.map(d => ({
        destinationCompanyId: d.destination_company_id,
        amount: d.weight || 0,
        basisNote: `manual ₹${(d.weight || 0).toFixed(2)}`,
      }));
    }

    default:
      warnings.push(`Rule "${rule.name}": unknown alloc_method '${rule.alloc_method}'; skipping`);
      return [];
  }
}

// ─── Mutation helpers ──────────────────────────────────────────────────────

/**
 * Add `delta` to the cell at (sectionKey, col). Updates the section's
 * grandTotal too. Returns true on success, false if section/col not found.
 * Negative delta = subtraction.
 */
function applyDeltaToCell(
  statement: PLStatement,
  sectionKey: string,
  col: string,
  delta: number,
): boolean {
  // Use findSectionPath (not findSection) so the delta propagates to every
  // ancestor section, not just the target. This matters for nested-source
  // rules like "drain indirectExpenses:Rental Expenses": without ancestor
  // propagation the parent indirectExpenses keeps its pre-drain value, and
  // the Net Profit recompute reads a stale total — manifesting as an
  // all-negative NP-delta card with no offsetting source drain.
  const path = findSectionPath(statement.sections, sectionKey);
  if (!path || path.length === 0) return false;
  const target = path[path.length - 1];
  if (!(col in target.values)) {
    // Column may legitimately not exist if the destination company isn't in
    // the report (e.g. a rule references a company outside the user's
    // accessible set). Caller decides whether to warn.
    return false;
  }
  for (const section of path) {
    section.values[col] = (section.values[col] || 0) + delta;
    if (col !== 'total' && 'total' in section.values) {
      section.values.total = (section.values.total || 0) + delta;
    }
    section.grandTotal = section.grandTotal + delta;
  }
  return true;
}

/**
 * After all rules have run, recompute computed.{grossProfit, grossMargin,
 * netProfit} and grandTotals.{grossProfit, netProfit} per column from the
 * mutated section values. Stock / COGS aren't touched by the engine so
 * those stay as the baseline.
 *
 * Formula (matches buildProfitLoss):
 *   grossProfit = revenue - directCosts + stockAdjustment  (where
 *                 stockAdjustment is already baked into the baseline's
 *                 directCosts in the multi-builder — stock numbers don't
 *                 shift under reallocation)
 *   netProfit   = grossProfit + indirectIncome - indirectExpenses
 *   grossMargin = grossProfit / revenue × 100
 *
 * Because stock isn't mutated, the cleanest derivation is:
 *   gpDelta = -directCostsDelta
 *   npDelta = gpDelta + indirectIncomeDelta - indirectExpensesDelta
 * — i.e. recompute from the section values directly.
 */
function recomputeTotals(adjusted: PLStatement, base: PLStatement): void {
  const revenue = findSection(adjusted.sections, 'revenue');
  const directCosts = findSection(adjusted.sections, 'directCosts');
  const indirectIncome = findSection(adjusted.sections, 'indirectIncome');
  const indirectExpenses = findSection(adjusted.sections, 'indirectExpenses');

  let gpGrand = 0;
  let npGrand = 0;

  for (const col of adjusted.columns) {
    const rev = revenue?.values[col] || 0;
    const dc = directCosts?.values[col] || 0;
    const ii = indirectIncome?.values[col] || 0;
    const ie = indirectExpenses?.values[col] || 0;
    // Stock adjustment is the COGS line; it's stable across rules so re-use
    // baseline's per-column value.
    const stockOpening = base.computed.stockOpening[col] || 0;
    const stockClosing = base.computed.stockClosing[col] || 0;
    const stockAdj = stockClosing - stockOpening;

    const gp = rev - dc + stockAdj;
    const np = gp + ii - ie;

    adjusted.computed.grossProfit[col] = gp;
    adjusted.computed.netProfit[col] = np;
    adjusted.computed.grossMargin[col] =
      rev !== 0 ? Math.round((gp / rev) * 10000) / 100 : 0;

    if (col !== 'total') {
      gpGrand += gp;
      npGrand += np;
    }
  }

  adjusted.grandTotals.revenue = revenue?.grandTotal || 0;
  adjusted.grandTotals.directCosts = directCosts?.grandTotal || 0;
  adjusted.grandTotals.indirectIncome = indirectIncome?.grandTotal || 0;
  adjusted.grandTotals.indirectExpenses = indirectExpenses?.grandTotal || 0;
  adjusted.grandTotals.grossProfit = gpGrand;
  adjusted.grandTotals.netProfit = npGrand;
  // stockOpening/stockClosing/cogs untouched (engine doesn't move stock).
}

// ─── Apply: pool_split ─────────────────────────────────────────────────────

/** Inputs needed to run a single source→destinations allocation. Shared
 *  shape between rule-level (single-source rules) and branch_config (multi-
 *  branch rules) so the core logic doesn't need to care which it came from. */
interface PoolSplitConfig {
  /** Tag for diagnostics — rule name for single-source, "<rule> · <branch>" for multi. */
  contextLabel: string;
  source_type: 'ledger' | 'pl_line' | 'custom_amount' | null;
  source_company_id: number | null;
  source_ledger_name: string | null;
  source_pl_section_key: string | null;
  source_custom_amount: number | null;
  destinations: Array<{
    destination_company_id: number;
    weight: number;
    weight_basis_label: string | null;
  }>;
}

function applyPoolSplit(
  db: DbHelper,
  rule: LoadedRule,
  adjusted: PLStatement,
  period: { from: string; to: string },
  events: AdjustmentEvent[],
  warnings: string[],
): void {
  if (!rule.target_pl_section_key) {
    warnings.push(`Rule "${rule.name}": missing target_pl_section_key; skipped`);
    return;
  }

  // Multi-branch mode: iterate each config as an independent allocation.
  if (rule.parsedBranchConfigs && rule.parsedBranchConfigs.length > 0) {
    for (const [i, bc] of rule.parsedBranchConfigs.entries()) {
      const branchTag = bc.label || `branch ${i + 1}`;
      applyOneSplit(db, rule, {
        contextLabel: `${rule.name} · ${branchTag}`,
        source_type: bc.source_type ?? null,
        source_company_id: bc.source_company_id ?? null,
        source_ledger_name: bc.source_ledger_name ?? null,
        source_pl_section_key: bc.source_pl_section_key ?? null,
        source_custom_amount: bc.source_custom_amount ?? null,
        destinations: bc.destinations.map(d => ({
          destination_company_id: d.destination_company_id,
          weight: d.weight,
          weight_basis_label: d.weight_basis_label ?? null,
        })),
      }, adjusted, period, events, warnings);
    }
    return;
  }

  // Single-source mode: use the rule-level source + destinations table.
  applyOneSplit(db, rule, {
    contextLabel: rule.name,
    source_type: rule.source_type,
    source_company_id: rule.source_company_id,
    source_ledger_name: rule.source_ledger_name,
    source_pl_section_key: rule.source_pl_section_key,
    source_custom_amount: rule.source_custom_amount,
    destinations: rule.destinations.map(d => ({
      destination_company_id: d.destination_company_id,
      weight: d.weight,
      weight_basis_label: d.weight_basis_label,
    })),
  }, adjusted, period, events, warnings);
}

/** Core pool_split runner. Operates on one (source, destinations) pair.
 *  The rule envelope provides alloc_method + target_pl_section_key, which
 *  apply to every config in a multi-branch rule. */
function applyOneSplit(
  db: DbHelper,
  rule: LoadedRule,
  cfg: PoolSplitConfig,
  adjusted: PLStatement,
  period: { from: string; to: string },
  events: AdjustmentEvent[],
  warnings: string[],
): void {
  const { amount: sourceAmount, sourceCol, mutateSource } = resolveSourceAmountForConfig(
    db, cfg, adjusted, period,
  );

  if (sourceAmount === 0) {
    warnings.push(`${cfg.contextLabel}: source resolved to ₹0; nothing to distribute`);
    return;
  }

  const distribution = distributeForConfig(rule, cfg, sourceAmount, adjusted, warnings);
  if (distribution.length === 0) return;

  const targetSectionKey = rule.target_pl_section_key!;

  if (mutateSource && sourceCol) {
    // Same pragmatic choice as before: pl_line source mutates its own section;
    // ledger source mutates the target section (intra-section split). See the
    // original comment for the reasoning.
    const sourceSectionKey =
      cfg.source_type === 'pl_line' && cfg.source_pl_section_key
        ? cfg.source_pl_section_key
        : targetSectionKey;

    const ok = applyDeltaToCell(adjusted, sourceSectionKey, sourceCol, -sourceAmount);
    if (!ok) {
      warnings.push(`${cfg.contextLabel}: could not locate source cell (${sourceSectionKey} @ ${sourceCol})`);
    }
    // Emit an explicit "source drained" event with the negative pool amount.
    // The UI sums events per (ruleId, destinationCol) to derive the net
    // adjustment per company; without this event the source-side decrement
    // would be invisible to that calculation.
    events.push({
      ruleId: rule.id,
      ruleName: cfg.contextLabel,
      ruleKind: 'pool_split',
      sourceCol: '',
      sourceLabel: '',
      destinationCol: sourceCol,
      destinationLabel: `${labelFor(adjusted, sourceCol)} (pool drained)`,
      targetSectionKey: sourceSectionKey,
      amount: -sourceAmount,
      basisNote: 'full pool subtracted from source',
    });
  }

  for (const d of distribution) {
    const destCol = colFor(d.destinationCompanyId);
    if (sourceCol && destCol === sourceCol) {
      // Source IS one of the destinations — the standard rent-split case
      // ("60% stays at Clinic, 40% moves to Pharmacy"). The full pool was
      // already drained from source above; here we add back the source's
      // allocated share so the net effect for source = -(pool) + (share),
      // i.e. source LOSES the portion that moved to other destinations.
      // No warning — this is the intended path, not an error.
      applyDeltaToCell(adjusted, targetSectionKey, destCol, d.amount);
      events.push({
        ruleId: rule.id,
        ruleName: cfg.contextLabel,
        ruleKind: 'pool_split',
        sourceCol: sourceCol,
        sourceLabel: labelFor(adjusted, sourceCol),
        destinationCol: destCol,
        destinationLabel: `${labelFor(adjusted, destCol)} (kept share)`,
        targetSectionKey,
        amount: d.amount,
        basisNote: d.basisNote ? `${d.basisNote} (stays at source)` : 'stays at source',
      });
      continue;
    }
    const ok = applyDeltaToCell(adjusted, targetSectionKey, destCol, d.amount);
    if (!ok) {
      warnings.push(`${cfg.contextLabel}: destination ${destCol} not in current report; skipped`);
      continue;
    }
    events.push({
      ruleId: rule.id,
      ruleName: cfg.contextLabel,
      ruleKind: 'pool_split',
      sourceCol: sourceCol || '',
      sourceLabel: sourceCol ? labelFor(adjusted, sourceCol) : 'Custom amount',
      destinationCol: destCol,
      destinationLabel: labelFor(adjusted, destCol),
      targetSectionKey,
      amount: d.amount,
      basisNote: d.basisNote,
    });
  }
}

/** Variant of resolveSourceAmount that works off a PoolSplitConfig instead
 *  of the rule fields directly. Same semantics. */
function resolveSourceAmountForConfig(
  db: DbHelper,
  cfg: PoolSplitConfig,
  adjusted: PLStatement,
  period: { from: string; to: string },
): { amount: number; sourceCol: string | null; mutateSource: boolean } {
  if (cfg.source_type === 'custom_amount') {
    return {
      amount: cfg.source_custom_amount || 0,
      sourceCol: null,
      mutateSource: false,
    };
  }
  if (!cfg.source_company_id) {
    return { amount: 0, sourceCol: null, mutateSource: false };
  }
  const sourceCol = colFor(cfg.source_company_id);
  if (cfg.source_type === 'ledger') {
    if (!cfg.source_ledger_name) {
      return { amount: 0, sourceCol, mutateSource: true };
    }
    const movements = getLedgerMovements(db, cfg.source_company_id, period.from, period.to);
    const hit = movements.find(m => m.ledgerName === cfg.source_ledger_name);
    return { amount: Math.abs(hit?.movement || 0), sourceCol, mutateSource: true };
  }
  if (cfg.source_type === 'pl_line') {
    if (!cfg.source_pl_section_key) {
      return { amount: 0, sourceCol, mutateSource: true };
    }
    const section = findSection(adjusted.sections, cfg.source_pl_section_key);
    if (!section) return { amount: 0, sourceCol, mutateSource: true };
    return { amount: section.values[sourceCol] || 0, sourceCol, mutateSource: true };
  }
  return { amount: 0, sourceCol, mutateSource: false };
}

/** Variant of distribute() that takes the rule envelope (for alloc_method)
 *  plus the per-config destinations. */
function distributeForConfig(
  rule: LoadedRule,
  cfg: PoolSplitConfig,
  sourceAmount: number,
  adjusted: PLStatement,
  warnings: string[],
): Array<{ destinationCompanyId: number; amount: number; basisNote?: string }> {
  // Build a synthetic LoadedRule with these destinations so the original
  // distribute() logic can run unchanged.
  const synth: LoadedRule = {
    ...rule,
    destinations: cfg.destinations.map((d, i) => ({
      id: i,
      rule_id: rule.id,
      destination_company_id: d.destination_company_id,
      weight: d.weight,
      weight_basis_label: d.weight_basis_label ?? null,
      sort_order: i,
    })),
  };
  // Reuse the distribute() function we already had — it reads rule.alloc_method
  // and rule.destinations, both of which the synthetic rule provides.
  const result = distribute(synth, sourceAmount, adjusted, warnings);
  return result.map(r => ({
    destinationCompanyId: r.destinationCompanyId,
    amount: r.amount,
    basisNote: r.basisNote,
  }));
}

// ─── Apply: cross_charge ───────────────────────────────────────────────────

/** Inputs needed to run a single cross-charge allocation. Shared shape
 *  between rule-level (single-provider rules) and per-branch_config
 *  (multi-region rules like "Diagnostics" with one lab provider per city). */
interface CrossChargeConfig {
  contextLabel: string;
  provider_company_id: number | null;
  charge_basis_section_key: string | null;
  charge_pct: number | null;
  provider_credit_section_key: string | null;
  target_pl_section_key: string | null;
  consumers: Array<{ destination_company_id: number }>;
}

function applyCrossCharge(
  rule: LoadedRule,
  adjusted: PLStatement,
  events: AdjustmentEvent[],
  warnings: string[],
): void {
  // Multi-branch mode: each branch_config is a self-contained cross-charge
  // (its own provider, consumers, and optional overrides of basis/pct/credit
  // section). Used when one rule covers multiple regional providers — e.g.
  // "Diagnostics" with Jubilee Hills serving Hyderabad, BTM serving BLR.
  if (rule.parsedBranchConfigs && rule.parsedBranchConfigs.length > 0) {
    for (const [i, bc] of rule.parsedBranchConfigs.entries()) {
      const branchTag = bc.label || `branch ${i + 1}`;
      applyOneCrossCharge(rule, {
        contextLabel: `${rule.name} · ${branchTag}`,
        // Each branch CAN override the rule-level defaults; otherwise fall back.
        provider_company_id: bc.provider_company_id ?? rule.provider_company_id,
        charge_basis_section_key: bc.charge_basis_section_key ?? rule.charge_basis_section_key,
        charge_pct: bc.charge_pct ?? rule.charge_pct,
        provider_credit_section_key: bc.provider_credit_section_key ?? rule.provider_credit_section_key,
        target_pl_section_key: rule.target_pl_section_key,
        consumers: bc.destinations.map(d => ({ destination_company_id: d.destination_company_id })),
      }, adjusted, events, warnings);
    }
    return;
  }

  // Single-provider mode: use rule-level fields + destinations table.
  applyOneCrossCharge(rule, {
    contextLabel: rule.name,
    provider_company_id: rule.provider_company_id,
    charge_basis_section_key: rule.charge_basis_section_key,
    charge_pct: rule.charge_pct,
    provider_credit_section_key: rule.provider_credit_section_key,
    target_pl_section_key: rule.target_pl_section_key,
    consumers: rule.destinations.map(d => ({ destination_company_id: d.destination_company_id })),
  }, adjusted, events, warnings);
}

/** Core cross-charge runner. Operates on one (provider, consumers) group. */
function applyOneCrossCharge(
  rule: LoadedRule,
  cfg: CrossChargeConfig,
  adjusted: PLStatement,
  events: AdjustmentEvent[],
  warnings: string[],
): void {
  if (!cfg.provider_company_id) {
    warnings.push(`${cfg.contextLabel}: missing provider_company_id; skipped`);
    return;
  }
  if (!cfg.charge_basis_section_key) {
    warnings.push(`${cfg.contextLabel}: missing charge_basis_section_key; skipped`);
    return;
  }
  if (cfg.charge_pct == null || cfg.charge_pct <= 0 || cfg.charge_pct > 100) {
    warnings.push(`${cfg.contextLabel}: charge_pct (${cfg.charge_pct}) must be in (0, 100]; skipped`);
    return;
  }

  const basisSection = findSection(adjusted.sections, cfg.charge_basis_section_key);
  if (!basisSection) {
    warnings.push(`${cfg.contextLabel}: basis section '${cfg.charge_basis_section_key}' not found; skipped`);
    return;
  }

  const targetSectionKey = cfg.target_pl_section_key || 'directCosts';
  const providerCreditSectionKey = cfg.provider_credit_section_key || 'directCosts';
  const providerCol = colFor(cfg.provider_company_id);
  const pctFrac = cfg.charge_pct / 100;

  let totalCharged = 0;

  for (const d of cfg.consumers) {
    if (d.destination_company_id === cfg.provider_company_id) {
      warnings.push(`${cfg.contextLabel}: provider appears in consumers list; skipped that row`);
      continue;
    }
    const consumerCol = colFor(d.destination_company_id);
    const basis = basisSection.values[consumerCol] || 0;
    if (basis <= 0) {
      warnings.push(`${cfg.contextLabel}: consumer ${consumerCol} has zero/negative basis on '${cfg.charge_basis_section_key}'; skipped`);
      continue;
    }
    const amount = basis * pctFrac;
    const ok = applyDeltaToCell(adjusted, targetSectionKey, consumerCol, amount);
    if (!ok) {
      warnings.push(`${cfg.contextLabel}: consumer ${consumerCol} target cell not found; skipped`);
      continue;
    }
    totalCharged += amount;
    events.push({
      ruleId: rule.id,
      ruleName: cfg.contextLabel,
      ruleKind: 'cross_charge',
      sourceCol: '',
      sourceLabel: '',
      destinationCol: consumerCol,
      destinationLabel: labelFor(adjusted, consumerCol),
      targetSectionKey,
      amount,
      basisNote: `${cfg.charge_pct.toFixed(1)}% of ${basisSection.label} (₹${basis.toFixed(2)})`,
    });
  }

  if (totalCharged > 0) {
    const ok = applyDeltaToCell(adjusted, providerCreditSectionKey, providerCol, -totalCharged);
    if (!ok) {
      warnings.push(`${cfg.contextLabel}: provider credit cell (${providerCreditSectionKey} @ ${providerCol}) not found`);
    }
    events.push({
      ruleId: rule.id,
      ruleName: cfg.contextLabel,
      ruleKind: 'cross_charge',
      sourceCol: '',
      sourceLabel: '',
      destinationCol: providerCol,
      destinationLabel: `${labelFor(adjusted, providerCol)} (provider credit)`,
      targetSectionKey: providerCreditSectionKey,
      amount: -totalCharged,
      basisNote: `sum of ${cfg.consumers.length} consumer charges`,
    });
  }
}

// ─── Public entry point ────────────────────────────────────────────────────

/**
 * Apply all enabled allocation rules to a base PLStatement and return both
 * the unchanged baseline and a deep-cloned adjusted view. Rules apply
 * sequentially against the running adjusted statement (in priority order)
 * so accountants can stack them.
 *
 * Returns events for the UI to render in the AdjustmentsBlock card and
 * warnings to surface as amber callouts.
 */
export function applyAllocationRules(
  db: DbHelper,
  base: PLStatement,
  opts: { effectiveFrom: string; effectiveTo: string; rulesOverride?: LoadedRule[] },
): AllocationResult {
  const adjusted = cloneStatement(base);
  const events: AdjustmentEvent[] = [];
  const warnings: string[] = [];

  // Engine only makes sense for bifurcated PLs (columns = companies).
  // Monthly / single-company views fall through with no adjustments —
  // there's no per-company column to redistribute across.
  if (!base.bifurcated) {
    return { base, adjusted, events, warnings };
  }

  // `rulesOverride` lets the preview endpoint pass an un-saved rule without
  // touching the DB. Otherwise we load the active set as normal.
  const rules = opts.rulesOverride ?? loadActiveRules(db, opts.effectiveFrom, opts.effectiveTo);
  if (rules.length === 0) {
    return { base, adjusted, events, warnings };
  }

  for (const rule of rules) {
    try {
      if (rule.rule_kind === 'pool_split') {
        applyPoolSplit(
          db,
          rule,
          adjusted,
          { from: opts.effectiveFrom, to: opts.effectiveTo },
          events,
          warnings,
        );
      } else if (rule.rule_kind === 'cross_charge') {
        applyCrossCharge(rule, adjusted, events, warnings);
      } else {
        warnings.push(`Rule "${rule.name}": unknown rule_kind '${(rule as any).rule_kind}'; skipped`);
      }
    } catch (err: any) {
      warnings.push(`Rule "${rule.name}": engine error — ${err?.message || err}`);
    }
  }

  recomputeTotals(adjusted, base);

  return { base, adjusted, events, warnings };
}
