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
