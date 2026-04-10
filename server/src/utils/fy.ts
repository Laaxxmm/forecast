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

/**
 * Scan an array of raw date values from a file and detect whether the format
 * is DD/MM/YYYY ('dmy') or MM/DD/YYYY ('mdy'). Works by finding any date
 * where one number is unambiguously > 12 (must be a day).
 * Falls back to 'dmy' (Indian standard) when all dates are ambiguous.
 */
export function detectDateFormat(rawDates: any[], defaultFormat: 'dmy' | 'mdy' = 'dmy'): 'dmy' | 'mdy' {
  for (const raw of rawDates) {
    if (raw == null || raw === '' || typeof raw === 'number' || raw instanceof Date) continue;
    const str = String(raw).trim();
    const match = str.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
    if (!match) continue;
    const a = parseInt(match[1]);
    const b = parseInt(match[2]);
    if (a > 12 && b <= 12) return 'dmy'; // First > 12 must be day → DD/MM/YYYY
    if (b > 12 && a <= 12) return 'mdy'; // Second > 12 must be day → MM/DD/YYYY
  }
  return defaultFormat; // Caller-specified fallback when all dates are ambiguous
}

export function parseExcelDate(raw: any, format: 'dmy' | 'mdy' = 'dmy'): string | null {
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
  // Disambiguate using value ranges first, then fall back to file-level format
  const match = str.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (match) {
    const [, a, b, y] = match;
    const numA = parseInt(a);
    const numB = parseInt(b);

    // If unambiguous from this single value, override file format
    if (numA > 12 && numB <= 12) {
      return `${y}-${b.padStart(2, '0')}-${a.padStart(2, '0')}`; // DD/MM
    }
    if (numB > 12 && numA <= 12) {
      return `${y}-${a.padStart(2, '0')}-${b.padStart(2, '0')}`; // MM/DD
    }

    // Both ≤ 12: use file-level detected format
    if (format === 'mdy') {
      return `${y}-${a.padStart(2, '0')}-${b.padStart(2, '0')}`; // MM/DD/YYYY
    }
    return `${y}-${b.padStart(2, '0')}-${a.padStart(2, '0')}`; // DD/MM/YYYY
  }

  return null;
}

export function dateToMonth(raw: any, format: 'dmy' | 'mdy' = 'dmy'): string | null {
  const date = parseExcelDate(raw, format);
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
