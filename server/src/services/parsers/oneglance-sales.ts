import * as XLSX from 'xlsx';
import { parseExcelDate, dateToMonth, detectDateFormat } from '../../utils/fy.js';

interface SalesRow {
  bill_no: string | null;
  bill_date: string | null;
  bill_month: string;
  drug_name: string | null;
  batch_no: string | null;
  hsn_code: string | null;
  tax_pct: number;
  patient_id: string | null;
  patient_name: string | null;
  referred_by: string | null;
  qty: number;
  sales_amount: number;
  purchase_amount: number;
  purchase_tax: number;
  sales_tax: number;
  profit: number;
}

const COLUMN_MAP: Record<string, string> = {
  'bill no': 'bill_no',
  'bill date': 'bill_date',
  'drug name': 'drug_name',
  'batch no': 'batch_no',
  'hsncode': 'hsn_code',
  'hsn code': 'hsn_code',
  'tax(%)': 'tax_pct',
  'tax %': 'tax_pct',
  'patient id': 'patient_id',
  'patient name': 'patient_name',
  'referred by': 'referred_by',
  'qty': 'qty',
  'sales amount': 'sales_amount',
  'tax%': 'tax_pct_alt',
  'purchase amount': 'purchase_amount',
  'purchase tax': 'purchase_tax',
  'sales tax': 'sales_tax',
  'profit': 'profit',
};

export function parseOneglanceSales(filePath: string) {
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
    throw new Error('Could not find header row in Oneglance Sales report. Expected columns: Bill No, Bill Date, Drug Name, Sales Amount');
  }

  const rows: SalesRow[] = [];
  const warnings: string[] = [];

  // Detect date format from all dates in the file (DD/MM vs MM/DD)
  const dateColIdx = Object.entries(colMapping).find(([_, v]) => v === 'bill_date')?.[0];
  const allRawDates = dateColIdx
    ? rawData.slice(headerRowIdx + 1).map(r => r ? r[parseInt(dateColIdx)] : null).filter(Boolean)
    : [];
  const dateFormat = detectDateFormat(allRawDates);

  for (let i = headerRowIdx + 1; i < rawData.length; i++) {
    const raw = rawData[i];
    if (!raw || raw.every((c: any) => c == null || c === '')) continue;

    const get = (field: string) => {
      for (const [colIdx, mappedField] of Object.entries(colMapping)) {
        if (mappedField === field) return raw[parseInt(colIdx)];
      }
      return null;
    };

    const billMonth = dateToMonth(get('bill_date'), dateFormat);
    if (!billMonth) {
      warnings.push(`Row ${i + 1}: Could not determine month, skipping`);
      continue;
    }

    const toNum = (v: any) => {
      if (v == null || v === '') return 0;
      const n = Number(v);
      return isNaN(n) ? 0 : n;
    };

    rows.push({
      bill_no: get('bill_no') != null ? String(get('bill_no')) : null,
      bill_date: parseExcelDate(get('bill_date'), dateFormat),
      bill_month: billMonth,
      drug_name: get('drug_name') ? String(get('drug_name')) : null,
      batch_no: get('batch_no') ? String(get('batch_no')) : null,
      hsn_code: get('hsn_code') ? String(get('hsn_code')) : null,
      tax_pct: toNum(get('tax_pct') || get('tax_pct_alt')),
      patient_id: get('patient_id') != null ? String(get('patient_id')) : null,
      patient_name: get('patient_name') ? String(get('patient_name')) : null,
      referred_by: get('referred_by') ? String(get('referred_by')) : null,
      qty: toNum(get('qty')),
      sales_amount: toNum(get('sales_amount')),
      purchase_amount: toNum(get('purchase_amount')),
      purchase_tax: toNum(get('purchase_tax')),
      sales_tax: toNum(get('sales_tax')),
      profit: toNum(get('profit')),
    });
  }

  const months = rows.map(r => r.bill_month).sort();
  return {
    rows,
    summary: {
      totalRows: rows.length,
      dateRange: months.length ? { start: months[0], end: months[months.length - 1] } : null,
      warnings,
    },
  };
}
