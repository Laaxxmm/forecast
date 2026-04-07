export function getFYMonths(startYear: number): string[] {
  const months: string[] = [];
  for (let m = 4; m <= 12; m++) {
    months.push(`${startYear}-${String(m).padStart(2, '0')}`);
  }
  for (let m = 1; m <= 3; m++) {
    months.push(`${startYear + 1}-${String(m).padStart(2, '0')}`);
  }
  return months;
}

export function getFYLabel(startYear: number): string {
  return `FY ${startYear}-${String(startYear + 1).slice(-2)}`;
}

export function monthToFY(month: string): { startYear: number; label: string } {
  const [year, m] = month.split('-').map(Number);
  const startYear = m >= 4 ? year : year - 1;
  return { startYear, label: getFYLabel(startYear) };
}

export function parseExcelDate(raw: any): string | null {
  if (raw == null || raw === '') return null;

  // Excel serial number
  if (typeof raw === 'number') {
    const date = new Date((raw - 25569) * 86400 * 1000);
    return formatDate(date);
  }

  const str = String(raw).trim();

  // ISO format or Date object string
  if (str.match(/^\d{4}-\d{2}-\d{2}/)) {
    return str.slice(0, 10);
  }

  // DD-MM-YYYY or DD/MM/YYYY
  const match = str.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (match) {
    const [, d, m, y] = match;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  return null;
}

export function dateToMonth(raw: any): string | null {
  const date = parseExcelDate(raw);
  if (!date) return null;
  return date.slice(0, 7);
}

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function getMonthLabel(month: string): string {
  const [y, m] = month.split('-');
  const months = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[parseInt(m)]}-${y.slice(-2)}`;
}

export function formatINR(amount: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(amount);
}
