// Shared computation primitives for the three financial statements (P&L,
// Balance Sheet, Cash Flow). Originally lived inside DownloadPrintPanel.tsx
// where they were used to generate per-scenario PDFs; now also consumed by
// the Scenario Analysis Compare / What-if / Report views to avoid duplicating
// the math in two places.

import { ForecastItem, getMonthLabel } from '../pages/ForecastModulePage';

/** Metadata flags attached to each row for styling purposes. */
export interface RowMeta {
  isSection?: boolean;
  isTotal?: boolean;
  isPercent?: boolean;
  isSubItem?: boolean;
}

export interface StatementBlock {
  header: string[];
  rows: (string | number)[][];
  meta: RowMeta[];
}

/** Labels that mark a row as a "totals" row (bold + accent background). */
export const TOTAL_ROW_LABELS = [
  'Total Revenue', 'Total Direct Costs', 'Total Operating Expenses',
  'Gross Profit', 'Operating Income', 'Net Profit',
  'Net Cash from Operations', 'Net Cash from Investing', 'Net Cash from Financing',
  'Net Cash Flow', 'Cash Balance', 'Total Current Assets',
  'Total Long-term Assets', 'Total Assets', 'Totals',
  'Cash at End of Period', 'Total Expenses',
];

/** Labels that mark a section header row (bold, slight bg, no indent). */
export const SECTION_HEADER_LABELS = [
  'Revenue', 'Direct Costs', 'Operating Expenses',
  'Cash from Operations', 'Cash from Investing', 'Cash from Financing',
  'Assets', 'Current Assets', 'Long-term Assets',
  'Liabilities', 'Current Liabilities', 'Equity',
];

/** Labels for percentage / margin rows (italic). */
export const PERCENT_ROW_LABELS = [
  'Gross Margin', 'Net Profit Margin',
];

/** Sum the value of every item in `cat` for the given month `m`. */
export function sumCat(
  items: ForecastItem[],
  cat: string,
  allValues: Record<number, Record<string, number>>,
  m: string,
): number {
  return items
    .filter(i => i.category === cat)
    .reduce((s, i) => s + (allValues[i.id]?.[m] || 0), 0);
}

/** Format a numeric value using en-IN locale, with parentheses for negatives. */
export function formatNum(v: string | number, isPercent = false): string {
  if (typeof v === 'string') return v;
  if (v === 0) return '–'; // em dash
  if (isPercent) {
    const sign = v < 0 ? '(' : '';
    const end = v < 0 ? ')' : '';
    return `${sign}${Math.abs(v).toFixed(1)}%${end}`;
  }
  if (v < 0) {
    return '(Rs' + new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.abs(v)) + ')';
  }
  return 'Rs' + new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(v);
}

export function buildPnLRows(
  items: ForecastItem[],
  allValues: Record<number, Record<string, number>>,
  months: string[],
  benefitsPct: number,
): StatementBlock {
  const revenueItems = items.filter(i => i.category === 'revenue');
  const dcItems = items.filter(i => i.category === 'direct_costs');
  const persItems = items.filter(i => i.category === 'personnel');
  const expItems = items.filter(i => i.category === 'expenses');

  const header = ['Profit & Loss', ...months.map(m => getMonthLabel(m)), 'Total'];
  const rows: (string | number)[][] = [];
  const meta: RowMeta[] = [];

  rows.push(['Revenue', ...months.map(() => ''), '']);
  meta.push({ isSection: true });
  revenueItems.forEach(item => {
    const vals = months.map(m => allValues[item.id]?.[m] || 0);
    rows.push([`  ${item.name}`, ...vals, vals.reduce((a, b) => a + b, 0)]);
    meta.push({});
  });
  const revTotals = months.map(m => sumCat(items, 'revenue', allValues, m));
  const revTotal = revTotals.reduce((a, b) => a + b, 0);
  rows.push(['Total Revenue', ...revTotals, revTotal]);
  meta.push({ isTotal: true });

  rows.push(['Direct Costs', ...months.map(() => ''), '']);
  meta.push({ isSection: true });
  dcItems.forEach(item => {
    const vals = months.map(m => allValues[item.id]?.[m] || 0);
    rows.push([`  ${item.name}`, ...vals, vals.reduce((a, b) => a + b, 0)]);
    meta.push({});
  });
  const dcTotals = months.map(m => sumCat(items, 'direct_costs', allValues, m));
  rows.push(['Total Direct Costs', ...dcTotals, dcTotals.reduce((a, b) => a + b, 0)]);
  meta.push({ isTotal: true });

  const gpTotals = months.map((_, i) => revTotals[i] - dcTotals[i]);
  const gpTotal = gpTotals.reduce((a, b) => a + b, 0);
  rows.push(['Gross Profit', ...gpTotals, gpTotal]);
  meta.push({ isTotal: true });

  const gmPctMonths = months.map((_, i) => revTotals[i] !== 0 ? (gpTotals[i] / revTotals[i]) * 100 : 0);
  const gmPctTotal = revTotal !== 0 ? (gpTotal / revTotal) * 100 : 0;
  rows.push(['Gross Margin', ...gmPctMonths, gmPctTotal]);
  meta.push({ isPercent: true });

  rows.push(['Operating Expenses', ...months.map(() => ''), '']);
  meta.push({ isSection: true });
  persItems.forEach(item => {
    const vals = months.map(m => allValues[item.id]?.[m] || 0);
    rows.push([`  ${item.name}`, ...vals, vals.reduce((a, b) => a + b, 0)]);
    meta.push({});
  });
  const persTotals = months.map(m => sumCat(items, 'personnel', allValues, m));
  const empTaxTotals = persTotals.map(p => Math.round(p * benefitsPct / 100));
  rows.push(['  Employee Taxes & Benefits', ...empTaxTotals, empTaxTotals.reduce((a, b) => a + b, 0)]);
  meta.push({});
  expItems.forEach(item => {
    const vals = months.map(m => allValues[item.id]?.[m] || 0);
    rows.push([`  ${item.name}`, ...vals, vals.reduce((a, b) => a + b, 0)]);
    meta.push({});
  });
  const expTotals = months.map(m => sumCat(items, 'expenses', allValues, m));
  const opexTotals = months.map((_, i) => persTotals[i] + empTaxTotals[i] + expTotals[i]);
  rows.push(['Total Operating Expenses', ...opexTotals, opexTotals.reduce((a, b) => a + b, 0)]);
  meta.push({ isTotal: true });

  const oiTotals = months.map((_, i) => gpTotals[i] - opexTotals[i]);
  const oiTotal = oiTotals.reduce((a, b) => a + b, 0);
  rows.push(['Operating Income', ...oiTotals, oiTotal]);
  meta.push({ isTotal: true });

  const taxTotals = months.map(m => sumCat(items, 'taxes', allValues, m));
  rows.push(['Income Taxes', ...taxTotals, taxTotals.reduce((a, b) => a + b, 0)]);
  meta.push({});

  const depTotals = months.map(() => 0);
  rows.push(['Depreciation', ...depTotals, 0]);
  meta.push({});

  const totalExpenses = months.map((_, i) => opexTotals[i] + taxTotals[i] + depTotals[i]);
  rows.push(['Total Expenses', ...totalExpenses, totalExpenses.reduce((a, b) => a + b, 0)]);
  meta.push({ isTotal: true });

  const npTotals = months.map((_, i) => oiTotals[i] - taxTotals[i]);
  const npTotal = npTotals.reduce((a, b) => a + b, 0);
  rows.push(['Net Profit', ...npTotals, npTotal]);
  meta.push({ isTotal: true });

  const npmPctMonths = months.map((_, i) => revTotals[i] !== 0 ? (npTotals[i] / revTotals[i]) * 100 : 0);
  const npmPctTotal = revTotal !== 0 ? (npTotal / revTotal) * 100 : 0;
  rows.push(['Net Profit Margin', ...npmPctMonths, npmPctTotal]);
  meta.push({ isPercent: true });

  return { header, rows, meta };
}

export function buildBalanceSheetRows(
  items: ForecastItem[],
  allValues: Record<number, Record<string, number>>,
  months: string[],
): StatementBlock {
  const currentAssets = items.filter(i => i.category === 'assets' && i.item_type === 'current');
  const ltAssets = items.filter(i => i.category === 'assets' && i.item_type === 'long_term');

  const header = ['Balance Sheet', ...months.map(m => getMonthLabel(m))];
  const rows: (string | number)[][] = [];
  const meta: RowMeta[] = [];

  rows.push(['Assets', ...months.map(() => '')]); meta.push({ isSection: true });
  rows.push(['Current Assets', ...months.map(() => '')]); meta.push({ isSection: true });

  const cashVals = months.map(m => {
    const rev = sumCat(items, 'revenue', allValues, m);
    const costs = sumCat(items, 'direct_costs', allValues, m);
    const opex = sumCat(items, 'expenses', allValues, m) + sumCat(items, 'personnel', allValues, m);
    return Math.max(rev - costs - opex, 0);
  });
  rows.push(['  Cash', ...cashVals]); meta.push({});
  currentAssets.forEach(item => {
    rows.push([`  ${item.name}`, ...months.map(m => allValues[item.id]?.[m] || 0)]);
    meta.push({});
  });
  const caTotal = months.map((m, i) =>
    cashVals[i] + currentAssets.reduce((s, it) => s + (allValues[it.id]?.[m] || 0), 0),
  );
  rows.push(['Total Current Assets', ...caTotal]); meta.push({ isTotal: true });

  rows.push(['Long-term Assets', ...months.map(() => '')]); meta.push({ isSection: true });
  ltAssets.forEach(item => {
    rows.push([`  ${item.name}`, ...months.map(m => allValues[item.id]?.[m] || 0)]);
    meta.push({});
  });
  const ltTotal = months.map(m => ltAssets.reduce((s, it) => s + (allValues[it.id]?.[m] || 0), 0));
  rows.push(['Total Long-term Assets', ...ltTotal]); meta.push({ isTotal: true });

  const totalAssets = months.map((_, i) => caTotal[i] + ltTotal[i]);
  rows.push(['Total Assets', ...totalAssets]); meta.push({ isTotal: true });

  return { header, rows, meta };
}

export function buildCashFlowRows(
  items: ForecastItem[],
  allValues: Record<number, Record<string, number>>,
  months: string[],
): StatementBlock {
  const header = ['Cash Flow', ...months.map(m => getMonthLabel(m)), 'Total'];
  const rows: (string | number)[][] = [];
  const meta: RowMeta[] = [];
  let cumCash = 0;

  const mData = months.map(m => {
    const rev = sumCat(items, 'revenue', allValues, m);
    const dc = sumCat(items, 'direct_costs', allValues, m);
    const pers = sumCat(items, 'personnel', allValues, m);
    const exp = sumCat(items, 'expenses', allValues, m);
    const tax = sumCat(items, 'taxes', allValues, m);
    const assets = sumCat(items, 'assets', allValues, m);
    const div = sumCat(items, 'dividends', allValues, m);
    const cashOps = rev - dc - pers - exp - tax;
    const cashInv = -assets;
    const cashFin = -div;
    const net = cashOps + cashInv + cashFin;
    cumCash += net;
    return { rev, dc, pers, exp, tax, cashOps, assets, cashInv, div, cashFin, net, balance: cumCash };
  });

  rows.push(['Cash from Operations', ...months.map(() => ''), '']); meta.push({ isSection: true });
  rows.push(['  Net Profit', ...mData.map(d => d.rev - d.dc - d.pers - d.exp - d.tax), mData.reduce((s, d) => s + (d.rev - d.dc - d.pers - d.exp - d.tax), 0)]); meta.push({});
  rows.push(['  Depreciation', ...months.map(() => 0), 0]); meta.push({});
  rows.push(['  Cash Receipts', ...mData.map(d => d.rev), mData.reduce((s, d) => s + d.rev, 0)]); meta.push({});
  rows.push(['  Direct Costs Paid', ...mData.map(d => -d.dc), -mData.reduce((s, d) => s + d.dc, 0)]); meta.push({});
  rows.push(['  Personnel Paid', ...mData.map(d => -d.pers), -mData.reduce((s, d) => s + d.pers, 0)]); meta.push({});
  rows.push(['  Expenses Paid', ...mData.map(d => -d.exp), -mData.reduce((s, d) => s + d.exp, 0)]); meta.push({});
  rows.push(['  Taxes Paid', ...mData.map(d => -d.tax), -mData.reduce((s, d) => s + d.tax, 0)]); meta.push({});
  rows.push(['Net Cash from Operations', ...mData.map(d => d.cashOps), mData.reduce((s, d) => s + d.cashOps, 0)]); meta.push({ isTotal: true });

  rows.push(['Cash from Investing', ...months.map(() => ''), '']); meta.push({ isSection: true });
  rows.push(['  Assets Purchased', ...mData.map(d => d.cashInv), mData.reduce((s, d) => s + d.cashInv, 0)]); meta.push({});
  rows.push(['Net Cash from Investing', ...mData.map(d => d.cashInv), mData.reduce((s, d) => s + d.cashInv, 0)]); meta.push({ isTotal: true });

  rows.push(['Cash from Financing', ...months.map(() => ''), '']); meta.push({ isSection: true });
  rows.push(['  Dividends Paid', ...mData.map(d => d.cashFin), mData.reduce((s, d) => s + d.cashFin, 0)]); meta.push({});
  rows.push(['Net Cash from Financing', ...mData.map(d => d.cashFin), mData.reduce((s, d) => s + d.cashFin, 0)]); meta.push({ isTotal: true });

  rows.push(['Net Cash Flow', ...mData.map(d => d.net), mData.reduce((s, d) => s + d.net, 0)]); meta.push({ isTotal: true });
  rows.push(['Cash Balance', ...mData.map(d => d.balance), mData[mData.length - 1]?.balance || 0]); meta.push({ isTotal: true });

  return { header, rows, meta };
}
