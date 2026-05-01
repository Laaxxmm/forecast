import { ForecastItem } from '../pages/ForecastModulePage';

/** Parametric tweaks applied transiently to a base scenario's forecast values.
 *  All multipliers are expressed in percent-from-baseline (so 0 = no change,
 *  +20 = 20% higher, -10 = 10% lower). */
export interface WhatIfTweaks {
  revenuePct?: number;
  directCostsPct?: number;
  personnelPct?: number;
  expensesPct?: number;
  taxesPct?: number;
  benefitsPctOverride?: number; // absolute % to override the scenario's stored employee_benefits_pct
}

/** Categories whose values get scaled by the matching slider. Tax slider scales
 *  the `taxes` category; benefits is handled separately because it's a single
 *  setting, not per-item values. */
const CATEGORY_TO_TWEAK: Record<string, keyof WhatIfTweaks> = {
  revenue: 'revenuePct',
  direct_costs: 'directCostsPct',
  personnel: 'personnelPct',
  expenses: 'expensesPct',
  taxes: 'taxesPct',
};

/** Apply transient tweaks to a snapshot of items + values. Returns NEW objects
 *  so the caller's state stays pristine — the result plugs into the existing
 *  buildPnLRows / buildBalanceSheetRows / buildCashFlowRows pipeline.
 *
 *  We never mutate `items` since the row builders read item attributes (name,
 *  category, etc.); we only adjust the per-month `allValues` lookup. */
export function applyTweaks(
  items: ForecastItem[],
  allValues: Record<number, Record<string, number>>,
  tweaks: WhatIfTweaks,
): {
  items: ForecastItem[];
  allValues: Record<number, Record<string, number>>;
} {
  const out: Record<number, Record<string, number>> = {};
  for (const item of items) {
    const tweakKey = CATEGORY_TO_TWEAK[item.category];
    const pct = tweakKey ? Number(tweaks[tweakKey] || 0) : 0;
    const factor = 1 + (pct / 100);
    const monthMap = allValues[item.id];
    if (!monthMap) continue;
    const next: Record<string, number> = {};
    for (const [m, v] of Object.entries(monthMap)) {
      next[m] = factor === 1 ? v : v * factor;
    }
    out[item.id] = next;
  }
  return { items, allValues: out };
}

/** Convenience: returns the effective benefits % to feed into buildPnLRows
 *  given the scenario's stored value and the optional override. */
export function effectiveBenefitsPct(stored: number, override: number | undefined): number {
  if (override == null) return stored;
  if (Number.isNaN(override)) return stored;
  return override;
}
