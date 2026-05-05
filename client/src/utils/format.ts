export function formatINR(amount: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(amount);
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat('en-IN').format(n);
}

/**
 * Compact label for chart axes / KPI badges, Indian numbering.
 *
 *   < 1k     → 999
 *   < 1L     → 12k, 99k        (1k = 1,000)
 *   < 1Cr    → 1.5L, 12L, 99L  (1L = 1,00,000)
 *   ≥ 1Cr    → 1.5Cr, 12Cr     (1Cr = 1,00,00,000)
 *
 * Single-digit values get one decimal (e.g. 1.5L) so adjacent ticks like
 * "1L / 1.5L / 2L" stay distinguishable. Two-or-more digit values are
 * rounded ("12L" not "12.3L") to keep axis labels short.
 */
export function formatCompact(n: number): string {
  if (!isFinite(n)) return '-';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs < 1000) return `${sign}${Math.round(abs)}`;

  const fmt = (val: number, suffix: string) =>
    `${sign}${val < 10 ? val.toFixed(1).replace(/\.0$/, '') : Math.round(val)}${suffix}`;

  if (abs < 100_000)     return fmt(abs / 1_000,    'k');   // 1k–99k
  if (abs < 10_000_000)  return fmt(abs / 100_000,  'L');   // 1L–99L
  return                        fmt(abs / 10_000_000, 'Cr');// 1Cr+
}

export function formatPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
}

export function getMonthLabel(month: string): string {
  const [y, m] = month.split('-');
  const months = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[parseInt(m)]}-${y.slice(-2)}`;
}

export function ragColor(rag: string): string {
  switch (rag) {
    case 'GREEN': return 'text-emerald-400 bg-emerald-500/15';
    case 'AMBER': return 'text-amber-400 bg-amber-500/15';
    case 'RED': return 'text-red-400 bg-red-500/15';
    default: return 'text-theme-muted bg-dark-500';
  }
}

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Smart formatter for an import-log date range. Inputs are typed as
 * stored in `import_logs` — either YYYY-MM (when the upstream parser
 * aggregates by month, e.g. OneGlance Sales/Purchase) or YYYY-MM-DD
 * (when it reports specific days, e.g. Stock snapshots).
 *
 * Output:
 *   YYYY-MM only:
 *     start === end          →  "May 2026"
 *     start !== end          →  "Apr 2026 → May 2026"
 *   YYYY-MM-DD:
 *     start === end          →  "4 May 2026"
 *     same month, range      →  "1–31 May 2026"
 *     cross-month range      →  "1 Apr 2026 → 31 May 2026"
 */
export function formatImportRange(start: string | null | undefined, end: string | null | undefined): string {
  if (!start) return '-';

  const isMonthly = (s: string): boolean => /^\d{4}-\d{2}$/.test(s);
  const monthLabel = (s: string): string => {
    const [y, m] = s.split('-');
    const idx = Math.max(1, Math.min(12, parseInt(m, 10))) - 1;
    return `${SHORT_MONTHS[idx]} ${y}`;
  };
  const dayLabel = (s: string): string => {
    const [y, m, d] = s.split('-');
    const idx = Math.max(1, Math.min(12, parseInt(m, 10))) - 1;
    return `${parseInt(d, 10)} ${SHORT_MONTHS[idx]} ${y}`;
  };

  if (isMonthly(start)) {
    if (!end || start === end) return monthLabel(start);
    return `${monthLabel(start)} → ${monthLabel(end)}`;
  }

  // Daily form
  if (!end || start === end) return dayLabel(start);
  const [sy, sm, sd] = start.split('-');
  const [ey, em, ed] = end.split('-');
  if (sy === ey && sm === em) {
    const idx = Math.max(1, Math.min(12, parseInt(sm, 10))) - 1;
    return `${parseInt(sd, 10)}–${parseInt(ed, 10)} ${SHORT_MONTHS[idx]} ${sy}`;
  }
  return `${dayLabel(start)} → ${dayLabel(end)}`;
}

/**
 * Format an import-log timestamp as IST. SQLite `datetime('now')`
 * stores UTC in "YYYY-MM-DD HH:MM:SS" form (no timezone marker), which
 * `new Date()` mis-parses as local time on most browsers. We append a
 * `Z` to force UTC parsing, then format with `timeZone: 'Asia/Kolkata'`
 * so the displayed time is unambiguously IST regardless of the user's
 * machine timezone.
 *
 * Output: "4 May 2026, 5:32 PM IST"
 */
export function formatIstTimestamp(dateStr: string | null | undefined): string {
  if (!dateStr) return '-';
  // Already-marked timezone? Leave as-is. Otherwise treat as UTC.
  const hasTz = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(dateStr);
  const iso = hasTz ? dateStr.replace(' ', 'T') : (dateStr.replace(' ', 'T') + 'Z');
  const d = new Date(iso);
  if (isNaN(d.getTime())) return dateStr;
  const formatted = d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  return `${formatted} IST`;
}
