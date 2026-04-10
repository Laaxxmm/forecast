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

  // Handle JavaScript Date objects (e.g. from XLSX cellDates option)
  if (raw instanceof Date) {
    if (isNaN(raw.getTime())) return null;
    return formatDate(raw);
  }

  // Excel serial number — unambiguous, always correct
  if (typeof raw === 'number') {
    const date = new Date((raw - 25569) * 86400 * 1000);
    return formatDate(date);
  }

  const str = String(raw).trim();

  // ISO format: YYYY-MM-DD...
  if (str.match(/^\d{4}-\d{2}-\d{2}/)) {
    return str.slice(0, 10);
  }

  // Two-part date: A/B/YYYY or A-B-YYYY
  // Could be DD/MM/YYYY (Indian) or MM/DD/YYYY (US Excel default)
  // Disambiguate using value ranges
  const match = str.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (match) {
    const [, a, b, y] = match;
    const numA = parseInt(a);
    const numB = parseInt(b);

    // If first number > 12, it MUST be a day → DD/MM/YYYY
    if (numA > 12 && numB <= 12) {
      return `${y}-${b.padStart(2, '0')}-${a.padStart(2, '0')}`;
    }
    // If second number > 12, it MUST be a day → MM/DD/YYYY
    if (numB > 12 && numA <= 12) {
      return `${y}-${a.padStart(2, '0')}-${b.padStart(2, '0')}`;
    }
    // Both ≤ 12: ambiguous — default to DD/MM/YYYY (Indian standard)
    return `${y}-${b.padStart(2, '0')}-${a.padStart(2, '0')}`;
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
