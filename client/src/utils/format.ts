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
    case 'GREEN': return 'text-emerald-600 bg-emerald-50';
    case 'AMBER': return 'text-amber-600 bg-amber-50';
    case 'RED': return 'text-red-600 bg-red-50';
    default: return 'text-slate-600 bg-slate-50';
  }
}
