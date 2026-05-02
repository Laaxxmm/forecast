// ─────────────────────────────────────────────────────────────────────────────
// Pro-rata month-over-month comparison logic
//
// On day 2 of a 31-day month, the dashboard used to compare the current
// running total against the *full* prior-month total — giving a
// mathematically correct but useless "−96%" reading. The pro-rata baseline
// scales the prior-month total down by the fraction of the current month
// elapsed, so day 2 vs ~6.45% of last month is the apples-to-apples view.
//
// The same helper degenerates correctly for closed periods: when the user
// picks "Last month (Apr '26)" the period is fully elapsed (fraction = 1)
// and the function returns a standard month-over-month delta.
//
// Reference: see addendum brief "Pro-rata month comparison logic".
// ─────────────────────────────────────────────────────────────────────────────

export interface ProRataResult {
  /** Percentage delta vs the pro-rata baseline. null if priorFull is
   *  missing or <= 0, OR if the period hasn't started yet. */
  delta: number | null;
  /** The rupee baseline the current actual is being compared against
   *  (priorFull × fraction). null when priorFull is unavailable. */
  baseline: number | null;
  /** True when the period is mid-flight (fraction < 1). The dashboard
   *  uses this to decide whether to suffix " vs pace" on the delta pill
   *  and surface the day-matched baseline in the sub-line. False for
   *  closed periods where a standard "vs last month" framing applies. */
  isProRata: boolean;
}

/** Compute a pro-rata-aware month-over-month delta.
 *
 *  baseline = priorFullTotal × (daysElapsed / totalDaysInPeriod)
 *  delta    = (currentActual − baseline) / baseline × 100
 *
 *  The fraction is clamped to [0, 1]. When fraction = 1 (closed period)
 *  the result is identical to the legacy full-vs-full comparison — so
 *  this utility can replace the legacy math everywhere without
 *  branching at call sites.
 */
export function calculateProRataDelta(
  currentActual: number,
  priorFullTotal: number | null | undefined,
  daysElapsed: number,
  totalDaysInPeriod: number,
): ProRataResult {
  if (priorFullTotal == null || !isFinite(priorFullTotal) || priorFullTotal <= 0) {
    return { delta: null, baseline: null, isProRata: false };
  }
  const totalDays = totalDaysInPeriod > 0 ? totalDaysInPeriod : 1;
  const rawFraction = daysElapsed / totalDays;
  const fraction = Math.min(1, Math.max(0, rawFraction));
  const isProRata = fraction < 1;
  const baseline = priorFullTotal * fraction;
  if (baseline <= 0) {
    // Period hasn't started yet (fraction = 0). Surfacing a delta would
    // be meaningless — the caller should hide the pill.
    return { delta: null, baseline, isProRata };
  }
  const delta = ((currentActual - baseline) / baseline) * 100;
  return { delta, baseline, isProRata };
}

/** Days in the calendar month identified by `YYYY-MM`. */
export function daysInMonth(yyyyMm: string): number {
  const m = /^(\d{4})-(\d{1,2})$/.exec(yyyyMm);
  if (!m) return 30;
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  // Setting day=0 of the next month gives the last day of the
  // current month (handles 28/29-day Februaries automatically).
  return new Date(year, month, 0).getDate();
}

/** Days elapsed in `monthYYYYMM` as of `today`. Returns the full month
 *  length when `monthYYYYMM` is in the past (closed period), or
 *  today.getDate() when it equals today's month. Returns 0 for future
 *  months so callers can skip the comparison. */
export function daysElapsedInMonth(monthYYYYMM: string, today: Date = new Date()): number {
  const m = /^(\d{4})-(\d{1,2})$/.exec(monthYYYYMM);
  if (!m) return 0;
  const targetYear = parseInt(m[1], 10);
  const targetMonth = parseInt(m[2], 10); // 1-12
  const todayYear = today.getFullYear();
  const todayMonth = today.getMonth() + 1;
  if (targetYear < todayYear || (targetYear === todayYear && targetMonth < todayMonth)) {
    // Past — fully elapsed.
    return daysInMonth(monthYYYYMM);
  }
  if (targetYear === todayYear && targetMonth === todayMonth) {
    // In progress — count today as elapsed since we're using its data.
    return today.getDate();
  }
  // Future — period hasn't started.
  return 0;
}
