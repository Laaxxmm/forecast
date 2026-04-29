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
