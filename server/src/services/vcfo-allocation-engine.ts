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
}

export interface LoadedRule extends AllocationRuleRow {
  destinations: AllocationRuleDestinationRow[];
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

  return rules.map(r => ({ ...r, destinations: byRule.get(r.id) || [] }));
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
  const section = findSection(statement.sections, sectionKey);
  if (!section) return false;
  if (!(col in section.values)) {
    // Column may legitimately not exist if the destination company isn't in
    // the report (e.g. a rule references a company outside the user's
    // accessible set). Caller decides whether to warn.
    return false;
  }
  section.values[col] = (section.values[col] || 0) + delta;
  // Always update the 'total' column too so aggregates stay coherent.
  if (col !== 'total' && 'total' in section.values) {
    section.values.total = (section.values.total || 0) + delta;
  }
  section.grandTotal = section.grandTotal + delta;
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

  const { amount: sourceAmount, sourceCol, mutateSource } = resolveSourceAmount(
    db,
    rule,
    adjusted,
    period,
  );

  if (sourceAmount === 0) {
    warnings.push(
      `Rule "${rule.name}": source resolved to ₹0; nothing to distribute`,
    );
    return;
  }

  const distribution = distribute(rule, sourceAmount, adjusted, warnings);
  if (distribution.length === 0) return;

  const targetSectionKey = rule.target_pl_section_key;

  // Mutate source side once (subtract the full amount), then apply each
  // destination delta. Doing it in this order means the source cell can be
  // queried by subsequent rules and reflect the post-split state.
  if (mutateSource && sourceCol) {
    // For the source we want to DECREASE the cost (or revenue) that was
    // booked there. The section the source lives in may differ from the
    // target — but we mutate the source ledger's appropriate section.
    //
    // For the ledger source path we don't know which P&L section the
    // ledger lives in without a lookup. Pragmatic choice: subtract from
    // `target_pl_section_key` at the source column too. That's the most
    // common case (rent ledger lives under Indirect Expenses and the
    // target is also Indirect Expenses; the split is intra-section).
    // If the source ledger is in a different section the accountant can
    // model that with a pl_line source instead.
    const sourceSectionKey =
      rule.source_type === 'pl_line' && rule.source_pl_section_key
        ? rule.source_pl_section_key
        : targetSectionKey;

    const ok = applyDeltaToCell(adjusted, sourceSectionKey, sourceCol, -sourceAmount);
    if (!ok) {
      warnings.push(
        `Rule "${rule.name}": could not locate source cell (${sourceSectionKey} @ ${sourceCol})`,
      );
    }
  }

  for (const d of distribution) {
    const destCol = colFor(d.destinationCompanyId);
    if (sourceCol && destCol === sourceCol) {
      warnings.push(
        `Rule "${rule.name}": destination ${destCol} equals source; skipped`,
      );
      // We already subtracted from source for the full amount; add back the
      // would-have-been-allocated portion so the net effect for that
      // destination is zero.
      applyDeltaToCell(adjusted, targetSectionKey, destCol, d.amount);
      continue;
    }
    const ok = applyDeltaToCell(adjusted, targetSectionKey, destCol, d.amount);
    if (!ok) {
      warnings.push(
        `Rule "${rule.name}": destination ${destCol} not in current report; skipped`,
      );
      continue;
    }
    events.push({
      ruleId: rule.id,
      ruleName: rule.name,
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

// ─── Apply: cross_charge ───────────────────────────────────────────────────

function applyCrossCharge(
  rule: LoadedRule,
  adjusted: PLStatement,
  events: AdjustmentEvent[],
  warnings: string[],
): void {
  if (!rule.provider_company_id) {
    warnings.push(`Rule "${rule.name}": missing provider_company_id; skipped`);
    return;
  }
  if (!rule.charge_basis_section_key) {
    warnings.push(`Rule "${rule.name}": missing charge_basis_section_key; skipped`);
    return;
  }
  if (rule.charge_pct == null || rule.charge_pct <= 0 || rule.charge_pct > 100) {
    warnings.push(
      `Rule "${rule.name}": charge_pct (${rule.charge_pct}) must be in (0, 100]; skipped`,
    );
    return;
  }

  const basisSection = findSection(adjusted.sections, rule.charge_basis_section_key);
  if (!basisSection) {
    warnings.push(
      `Rule "${rule.name}": basis section '${rule.charge_basis_section_key}' not found; skipped`,
    );
    return;
  }

  const targetSectionKey = rule.target_pl_section_key || 'directCosts';
  const providerCreditSectionKey =
    rule.provider_credit_section_key || 'directCosts';
  const providerCol = colFor(rule.provider_company_id);
  const pctFrac = rule.charge_pct / 100;

  let totalCharged = 0;

  for (const d of rule.destinations) {
    if (d.destination_company_id === rule.provider_company_id) {
      warnings.push(
        `Rule "${rule.name}": provider appears in destinations list; skipped that row`,
      );
      continue;
    }
    const consumerCol = colFor(d.destination_company_id);
    const basis = basisSection.values[consumerCol] || 0;
    if (basis <= 0) {
      warnings.push(
        `Rule "${rule.name}": consumer ${consumerCol} has zero/negative basis on '${rule.charge_basis_section_key}'; skipped`,
      );
      continue;
    }
    const amount = basis * pctFrac;
    const ok = applyDeltaToCell(adjusted, targetSectionKey, consumerCol, amount);
    if (!ok) {
      warnings.push(
        `Rule "${rule.name}": consumer ${consumerCol} target cell not found; skipped`,
      );
      continue;
    }
    totalCharged += amount;
    events.push({
      ruleId: rule.id,
      ruleName: rule.name,
      ruleKind: 'cross_charge',
      sourceCol: '',
      sourceLabel: '',
      destinationCol: consumerCol,
      destinationLabel: labelFor(adjusted, consumerCol),
      targetSectionKey,
      amount,
      basisNote: `${rule.charge_pct.toFixed(1)}% of ${basisSection.label} (₹${basis.toFixed(2)})`,
    });
  }

  if (totalCharged > 0) {
    // Credit the provider (decrease its booked cost). For an expense
    // section a negative delta is what we want.
    const ok = applyDeltaToCell(
      adjusted,
      providerCreditSectionKey,
      providerCol,
      -totalCharged,
    );
    if (!ok) {
      warnings.push(
        `Rule "${rule.name}": provider credit cell (${providerCreditSectionKey} @ ${providerCol}) not found`,
      );
    }
    events.push({
      ruleId: rule.id,
      ruleName: rule.name,
      ruleKind: 'cross_charge',
      sourceCol: '',
      sourceLabel: '',
      destinationCol: providerCol,
      destinationLabel: `${labelFor(adjusted, providerCol)} (provider credit)`,
      targetSectionKey: providerCreditSectionKey,
      amount: -totalCharged,
      basisNote: `sum of ${rule.destinations.length} consumer charges`,
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
