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

// Column-to-DB-field map. Two OneGlance formats are supported:
//
// Bangalore / Chennai layout:
//   • "Sales Amount"     → gross sales (incl. GST)
//   • "Purchase Amount"  → ex-tax COGS (already net of input GST, since ITC
//                          is reclaimed)
//
// Hyderabad / Filim Nagar layout:
//   • "Total"            → gross sales (incl. GST)
//   • "Sales Amount"     → NET sales (ex-GST) — different semantic from BG/CH
//   • "Purchase Price"   → ex-tax COGS
//   • "Purchase Amount"  → gross purchase (incl. tax) — different semantic
//
// We normalise on the way in so the DB always stores BG/CH semantics:
// `sales_amount` = gross, `purchase_amount` = ex-tax. Detection happens after
// header matching: if "Total" + "Purchase Price" are present, it's Hyderabad
// and we remap those columns to the canonical fields (overriding the
// BG/CH-style "Sales Amount" / "Purchase Amount" mappings for that file).
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
  // Hyderabad-only columns. When present, the post-header normalisation block
  // remaps them to override 'sales_amount' / 'purchase_amount' so the DB
  // ends up with BG/CH semantics regardless of source.
  'total': 'hyd_total_gross',
  'purchase price': 'hyd_purchase_price_ex_tax',
};

export function parseOneglanceSales(filePath: string) {
  // raw: true prevents XLSX from auto-detecting types in CSV — keeps dates as strings
  // so our DD-MM-YYYY parser works correctly instead of XLSX assuming MM/DD/YYYY
  const workbook = XLSX.readFile(filePath, { raw: true });
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

  // ── Hyderabad-format normalisation ────────────────────────────────────────
  // If the file has both "Total" and "Purchase Price" columns, it's the
  // Hyderabad / Filim Nagar layout where:
  //   • "Sales Amount" is NET (ex-GST), "Total" is GROSS
  //   • "Purchase Amount" is GROSS (with tax), "Purchase Price" is ex-tax COGS
  // We need the DB to hold BG/CH semantics (sales_amount = gross,
  // purchase_amount = ex-tax COGS), so we remap the column indices: the
  // "Total" column takes the sales_amount slot, and "Purchase Price" takes
  // the purchase_amount slot. The original Hyderabad-only mappings are
  // dropped from the lookup. BG/CH files (no Total / no Purchase Price
  // columns) fall straight through this block unchanged.
  const totalColIdx = Object.entries(colMapping).find(([_, v]) => v === 'hyd_total_gross')?.[0];
  const purchasePriceColIdx = Object.entries(colMapping).find(([_, v]) => v === 'hyd_purchase_price_ex_tax')?.[0];
  const isHyderabadFormat = totalColIdx != null && purchasePriceColIdx != null;
  if (isHyderabadFormat) {
    // Drop the BG/CH semantics for these fields — Hyderabad's "Sales Amount"
    // (ex-tax) and "Purchase Amount" (gross) would mislead them.
    for (const [idx, field] of Object.entries(colMapping)) {
      if (field === 'sales_amount' || field === 'purchase_amount') {
        delete colMapping[parseInt(idx)];
      }
    }
    // Remap Hyderabad-only columns to the canonical DB fields.
    colMapping[parseInt(totalColIdx!)] = 'sales_amount';
    colMapping[parseInt(purchasePriceColIdx!)] = 'purchase_amount';
  }

  const rows: SalesRow[] = [];
  const warnings: string[] = [];

  // Detect date format from all dates in the file (DD/MM vs MM/DD)
  const dateColIdx = Object.entries(colMapping).find(([_, v]) => v === 'bill_date')?.[0];
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
