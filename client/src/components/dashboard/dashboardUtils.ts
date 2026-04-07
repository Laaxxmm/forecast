import { ForecastItem } from '../../pages/ForecastModulePage';

/** Period option for dropdowns */
export interface PeriodOption {
  value: string;
  label: string;
  months: string[]; // actual month strings like "2026-04"
}

/** Build period options for a given FY start */
export function buildPeriodOptions(fyStartDate: string): PeriodOption[] {
  const startYear = parseInt(fyStartDate.slice(0, 4));
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  const allMonths: string[] = [];
  for (let m = 4; m <= 12; m++) allMonths.push(`${startYear}-${String(m).padStart(2, '0')}`);
  for (let m = 1; m <= 3; m++) allMonths.push(`${startYear + 1}-${String(m).padStart(2, '0')}`);

  const mLabel = (m: string) => {
    const [y, mo] = m.split('-');
    const names = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${names[parseInt(mo)]} '${y.slice(-2)}`;
  };

  // Find current month index in FY
  const curIdx = allMonths.indexOf(currentMonth);
  const prevIdx = curIdx > 0 ? curIdx - 1 : 0;

  // Current quarter
  const quarterStart = curIdx >= 0 ? Math.floor(curIdx / 3) * 3 : 0;
  const quarterEnd = Math.min(quarterStart + 2, 11);

  const options: PeriodOption[] = [];

  // Individual months
  allMonths.forEach(m => {
    options.push({
      value: m,
      label: mLabel(m),
      months: [m],
    });
  });

  // Add special options at the beginning
  const specials: PeriodOption[] = [];

  if (curIdx >= 0) {
    specials.push({
      value: 'current_month',
      label: `Current month (${mLabel(allMonths[curIdx])})`,
      months: [allMonths[curIdx]],
    });
  }

  specials.push({
    value: 'current_quarter',
    label: `Current quarter (${mLabel(allMonths[quarterStart])} to ${mLabel(allMonths[quarterEnd])})`,
    months: allMonths.slice(quarterStart, quarterEnd + 1),
  });

  if (curIdx >= 0) {
    specials.push({
      value: 'ytd',
      label: `Year to date (${mLabel(allMonths[0])} to ${mLabel(allMonths[curIdx])})`,
      months: allMonths.slice(0, curIdx + 1),
    });
  }

  specials.push({
    value: 'full_year',
    label: `Full fiscal year (${mLabel(allMonths[0])} to ${mLabel(allMonths[11])})`,
    months: allMonths,
  });

  if (prevIdx >= 0 && prevIdx !== curIdx) {
    specials.push({
      value: 'last_month',
      label: `Last month (${mLabel(allMonths[prevIdx])})`,
      months: [allMonths[prevIdx]],
    });
  }

  return [...specials, ...options];
}

/** Calculate comparison metrics */
export function calcChange(actual: number, forecast: number): { pct: number; direction: 'up' | 'down' | 'neutral' } {
  if (forecast === 0 && actual === 0) return { pct: 0, direction: 'neutral' };
  if (forecast === 0) return { pct: 100, direction: actual > 0 ? 'up' : 'down' };
  const pct = ((actual - forecast) / Math.abs(forecast)) * 100;
  return { pct, direction: pct > 0 ? 'up' : pct < 0 ? 'down' : 'neutral' };
}

/** Sum forecast values for items in a category for given months */
export function sumForecastCat(
  items: ForecastItem[],
  cat: string,
  allValues: Record<number, Record<string, number>>,
  months: string[],
): number {
  return items
    .filter(i => i.category === cat)
    .reduce((sum, item) =>
      sum + months.reduce((s, m) => s + (allValues[item.id]?.[m] || 0), 0), 0
    );
}

/** Sum forecast values for items in a category for a single month */
export function sumForecastCatMonth(
  items: ForecastItem[],
  cat: string,
  allValues: Record<number, Record<string, number>>,
  month: string,
): number {
  return items
    .filter(i => i.category === cat)
    .reduce((sum, item) => sum + (allValues[item.id]?.[month] || 0), 0);
}

/** Sum actuals for a category across months */
export function sumActualsCat(
  actuals: Record<string, Record<string, number>>, // category -> month -> total
  cat: string,
  months: string[],
): number {
  return months.reduce((sum, m) => sum + (actuals[cat]?.[m] || 0), 0);
}

export function sumActualsCatMonth(
  actuals: Record<string, Record<string, number>>,
  cat: string,
  month: string,
): number {
  return actuals[cat]?.[month] || 0;
}

/** Format Rs */
export function fmtRs(v: number): string {
  if (v === 0) return 'Rs0';
  const sign = v < 0 ? '-' : '';
  return sign + 'Rs' + new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.abs(v));
}

/** Format percentage */
export function fmtPct(v: number): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
}

/** Month label */
export function monthLabel(m: string): string {
  if (!m || !m.includes('-')) return '';
  const [y, mo] = m.split('-');
  const names = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${names[parseInt(mo)]} '${y.slice(-2)}`;
}

/** Month full label */
export function monthFullLabel(m: string): string {
  if (!m || !m.includes('-')) return '';
  const [y, mo] = m.split('-');
  const names = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${names[parseInt(mo)]} ${y}`;
}
