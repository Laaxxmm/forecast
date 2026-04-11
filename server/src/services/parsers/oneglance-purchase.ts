import * as XLSX from 'xlsx';
import { parseExcelDate, dateToMonth, detectDateFormat } from '../../utils/fy.js';

interface PurchaseRow {
  invoice_no: string | null;
  invoice_date: string | null;
  invoice_month: string;
  stockiest_name: string | null;
  mfg_name: string | null;
  drug_name: string | null;
  batch_no: string | null;
  hsn_code: string | null;
  batch_qty: number;
  free_qty: number;
  mrp: number;
  rate: number;
  discount_amount: number;
  net_purchase_value: number;
  net_sales_value: number;
  tax_pct: number;
  tax_amount: number;
  purchase_qty: number;
  purchase_value: number;
  sales_value: number;
  profit: number;
  profit_pct: number;
}

const COLUMN_MAP: Record<string, string> = {
  'invoice no': 'invoice_no',
  'invoice date': 'invoice_date',
  'stockiest name': 'stockiest_name',
  'mfg name': 'mfg_name',
  'mfg': 'mfg_name',
  'hsn code': 'hsn_code',
  'drug name': 'drug_name',
  'batch no': 'batch_no',
  'batch qty': 'batch_qty',
  'free qty': 'free_qty',
  'mrp': 'mrp',
  'rate': 'rate',
  'discount amount': 'discount_amount',
  'net purchase value': 'net_purchase_value',
  'net salesvalue': 'net_sales_value',
  'tax%': 'tax_pct',
  'tax amount': 'tax_amount',
  'purchase qty': 'purchase_qty',
  'purchase value': 'purchase_value',
  'sales value': 'sales_value',
  'profit': 'profit',
  'profit(%)': 'profit_pct',
};

export function parseOneglancePurchase(filePath: string) {
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rawData = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true }) as any[][];

  let headerRowIdx = -1;
  let colMapping: Record<number, string> = {};
  for (let i = 0; i < Math.min(rawData.length, 10); i++) {
    const row = rawData[i];
    if (!row) continue;
    const matches: Record<number, string> = {};
    let matchCount = 0;
    for (let j = 0; j < row.length; j++) {
      const cell = String(row[j] ?? '').toLowerCase().trim();
      if (COLUMN_MAP[cell]) {
        matches[j] = COLUMN_MAP[cell];
        matchCount++;
      }
    }
    if (matchCount >= 5) {
      headerRowIdx = i;
      colMapping = matches;
      break;
    }
  }

  if (headerRowIdx === -1) {
    throw new Error('Could not find header row in Oneglance Purchase report. Expected columns: Invoice No, Invoice Date, Drug Name, Purchase Value');
  }

  const rows: PurchaseRow[] = [];
  const warnings: string[] = [];

  // Detect date format from all dates in the file (DD/MM vs MM/DD)
  const dateColIdx = Object.entries(colMapping).find(([_, v]) => v === 'invoice_date')?.[0];
  const allRawDates = dateColIdx
    ? rawData.slice(headerRowIdx + 1).map(r => r ? r[parseInt(dateColIdx)] : null).filter(Boolean)
    : [];
  const dateFormat = detectDateFormat(allRawDates, 'dmy'); // OneGlance CSV uses DD-MM-YYYY format

  for (let i = headerRowIdx + 1; i < rawData.length; i++) {
    const raw = rawData[i];
    if (!raw || raw.every((c: any) => c == null || c === '')) continue;

    const get = (field: string) => {
      for (const [colIdx, mappedField] of Object.entries(colMapping)) {
        if (mappedField === field) return raw[parseInt(colIdx)];
      }
      return null;
    };

    const invoiceMonth = dateToMonth(get('invoice_date'), dateFormat);
    if (!invoiceMonth) {
      warnings.push(`Row ${i + 1}: Could not determine month, skipping`);
      continue;
    }

    const toNum = (v: any) => {
      if (v == null || v === '') return 0;
      const n = Number(v);
      return isNaN(n) ? 0 : n;
    };

    rows.push({
      invoice_no: get('invoice_no') != null ? String(get('invoice_no')) : null,
      invoice_date: parseExcelDate(get('invoice_date'), dateFormat),
      invoice_month: invoiceMonth,
      stockiest_name: get('stockiest_name') ? String(get('stockiest_name')) : null,
      mfg_name: get('mfg_name') ? String(get('mfg_name')) : null,
      drug_name: get('drug_name') ? String(get('drug_name')) : null,
      batch_no: get('batch_no') ? String(get('batch_no')) : null,
      hsn_code: get('hsn_code') ? String(get('hsn_code')) : null,
      batch_qty: toNum(get('batch_qty')),
      free_qty: toNum(get('free_qty')),
      mrp: toNum(get('mrp')),
      rate: toNum(get('rate')),
      discount_amount: toNum(get('discount_amount')),
      net_purchase_value: toNum(get('net_purchase_value')),
      net_sales_value: toNum(get('net_sales_value')),
      tax_pct: toNum(get('tax_pct')),
      tax_amount: toNum(get('tax_amount')),
      purchase_qty: toNum(get('purchase_qty')),
      purchase_value: toNum(get('purchase_value')),
      sales_value: toNum(get('sales_value')),
      profit: toNum(get('profit')),
      profit_pct: toNum(get('profit_pct')),
    });
  }

  const months = rows.map(r => r.invoice_month).sort();
  return {
    rows,
    summary: {
      totalRows: rows.length,
      dateRange: months.length ? { start: months[0], end: months[months.length - 1] } : null,
      warnings,
    },
  };
}
