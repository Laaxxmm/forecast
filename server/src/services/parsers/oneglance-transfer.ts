import * as XLSX from 'xlsx';
import { parseExcelDate, dateToMonth, detectDateFormat } from '../../utils/fy.js';
import { normalizeDrugName } from '../pharmacy/normalize-drug-name.js';

export interface TransferRow {
  invoice_no: string | null;
  invoice_date: string | null;
  invoice_month: string;
  indent_no: string | null;
  indent_date: string | null;
  counterparty_raw: string | null;
  drug_name: string | null;
  drug_name_normalized: string | null;
  batch_no: string | null;
  qty: number;
  rate: number;
  mrp: number;
  gst_5: number; cgst_5: number; sgst_5: number;
  gst_12: number; cgst_12: number; sgst_12: number;
  gst_18: number; cgst_18: number; sgst_18: number;
  gst_28: number; cgst_28: number; sgst_28: number;
  gst_other: number; cgst_other: number; sgst_other: number;
  gst_total: number; cgst_total: number; sgst_total: number;
  total_value: number;
  purchase_value: number;
  purchase_price: number;
}

const COLUMN_MAP: Record<string, string> = {
  'invoice no': 'invoice_no',
  'invoice date': 'invoice_date',
  'indent no': 'indent_no',
  'indent date': 'indent_date',
  'center name': 'counterparty_raw',
  'centre name': 'counterparty_raw',
  'drug name': 'drug_name',
  'batch no': 'batch_no',
  'qty': 'qty',
  'rate': 'rate',
  'mrp': 'mrp',
  '5%gst': 'gst_5', '5%cgst': 'cgst_5', '5%sgst': 'sgst_5',
  '12%gst': 'gst_12', '12%cgst': 'cgst_12', '12%sgst': 'sgst_12',
  '18%gst': 'gst_18', '18%cgst': 'cgst_18', '18%sgst': 'sgst_18',
  '28%gst': 'gst_28', '28%cgst': 'cgst_28', '28%sgst': 'sgst_28',
  'other%gst': 'gst_other', 'other%cgst': 'cgst_other', 'other%sgst': 'sgst_other',
  'gst': 'gst_total', 'cgst': 'cgst_total', 'sgst': 'sgst_total',
  'total value': 'total_value',
  'purchasevalue': 'purchase_value',
  'purchase value': 'purchase_value',
  'purchaseprice': 'purchase_price',
  'purchase price': 'purchase_price',
};

export function parseOneglanceTransfer(filePath: string) {
  // raw: true preserves DD-MM-YYYY date strings (XLSX would otherwise
  // misinterpret them as MM/DD/YYYY when auto-converting).
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
    if (matchCount >= 6) {
      headerRowIdx = i;
      colMapping = matches;
      break;
    }
  }

  if (headerRowIdx === -1) {
    throw new Error('Could not find header row in Stock Transfer Details report. Expected columns: Invoice no, Invoice Date, Indent No, Center Name, Drug Name, Batch No, Qty, PurchasePrice');
  }

  const rows: TransferRow[] = [];
  const warnings: string[] = [];
  const counterpartySet = new Set<string>();

  const dateColIdx = Object.entries(colMapping).find(([_, v]) => v === 'invoice_date')?.[0];
  const allRawDates = dateColIdx
    ? rawData.slice(headerRowIdx + 1).map(r => r ? r[parseInt(dateColIdx)] : null).filter(Boolean)
    : [];
  const dateFormat = detectDateFormat(allRawDates, 'dmy');

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

    const drug = get('drug_name');
    const counterparty = get('counterparty_raw');
    if (counterparty) counterpartySet.add(String(counterparty).trim());

    rows.push({
      invoice_no: get('invoice_no') != null ? String(get('invoice_no')) : null,
      invoice_date: parseExcelDate(get('invoice_date'), dateFormat),
      invoice_month: invoiceMonth,
      indent_no: get('indent_no') != null ? String(get('indent_no')) : null,
      indent_date: get('indent_date') != null ? String(get('indent_date')).trim() : null,
      counterparty_raw: counterparty != null ? String(counterparty).trim() : null,
      drug_name: drug != null ? String(drug).trim() : null,
      drug_name_normalized: drug != null ? normalizeDrugName(String(drug)) : null,
      batch_no: get('batch_no') != null ? String(get('batch_no')).trim() : null,
      qty: toNum(get('qty')),
      rate: toNum(get('rate')),
      mrp: toNum(get('mrp')),
      gst_5: toNum(get('gst_5')), cgst_5: toNum(get('cgst_5')), sgst_5: toNum(get('sgst_5')),
      gst_12: toNum(get('gst_12')), cgst_12: toNum(get('cgst_12')), sgst_12: toNum(get('sgst_12')),
      gst_18: toNum(get('gst_18')), cgst_18: toNum(get('cgst_18')), sgst_18: toNum(get('sgst_18')),
      gst_28: toNum(get('gst_28')), cgst_28: toNum(get('cgst_28')), sgst_28: toNum(get('sgst_28')),
      gst_other: toNum(get('gst_other')), cgst_other: toNum(get('cgst_other')), sgst_other: toNum(get('sgst_other')),
      gst_total: toNum(get('gst_total')), cgst_total: toNum(get('cgst_total')), sgst_total: toNum(get('sgst_total')),
      total_value: toNum(get('total_value')),
      purchase_value: toNum(get('purchase_value')),
      purchase_price: toNum(get('purchase_price')),
    });
  }

  const months = rows.map(r => r.invoice_month).sort();
  const totalValue = rows.reduce((s, r) => s + r.total_value, 0);
  return {
    rows,
    summary: {
      totalRows: rows.length,
      totalValue,
      dateRange: months.length ? { start: months[0], end: months[months.length - 1] } : null,
      counterpartyBranches: Array.from(counterpartySet),
      warnings,
    },
  };
}
