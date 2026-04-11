import * as XLSX from 'xlsx';
import { parseExcelDate, detectDateFormat } from '../../utils/fy.js';

interface StockRow {
  drug_name: string | null;
  batch_no: string | null;
  received_date: string | null;
  expiry_date: string | null;
  avl_qty: number;
  strips: number;
  purchase_price: number;
  purchase_tax: number;
  purchase_value: number;
  stock_value: number;
}

const COLUMN_MAP: Record<string, string> = {
  'products': 'drug_name',
  'product': 'drug_name',
  'drug name': 'drug_name',
  'drugname': 'drug_name',
  'item name': 'drug_name',
  'batchno': 'batch_no',
  'batch no': 'batch_no',
  'batch_no': 'batch_no',
  'received date': 'received_date',
  'receiveddate': 'received_date',
  'received_date': 'received_date',
  'expiry date': 'expiry_date',
  'expirydate': 'expiry_date',
  'expiry_date': 'expiry_date',
  'avlqty': 'avl_qty',
  'avl qty': 'avl_qty',
  'available qty': 'avl_qty',
  'available quantity': 'avl_qty',
  'strips': 'strips',
  'purchaseprice': 'purchase_price',
  'purchase price': 'purchase_price',
  'purchase_price': 'purchase_price',
  'purchasetax': 'purchase_tax',
  'purchase tax': 'purchase_tax',
  'purchase_tax': 'purchase_tax',
  'purchasevalue': 'purchase_value',
  'purchase value': 'purchase_value',
  'purchase_value': 'purchase_value',
  'stockvalue': 'stock_value',
  'stock value': 'stock_value',
  'stock_value': 'stock_value',
};

export function parseOneglanceStock(filePath: string) {
  // raw: true prevents XLSX from auto-converting date strings to serial numbers
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
    if (matchCount >= 4) {
      headerRowIdx = i;
      colMapping = matches;
      break;
    }
  }

  if (headerRowIdx === -1) {
    throw new Error('Could not find header row in Oneglance Stock report. Expected columns: Products, BatchNo, AvlQty, StockValue');
  }

  const rows: StockRow[] = [];
  const warnings: string[] = [];

  // Detect date format from received_date column
  const dateColIdx = Object.entries(colMapping).find(([_, v]) => v === 'received_date')?.[0];
  const allRawDates = dateColIdx
    ? rawData.slice(headerRowIdx + 1).map(r => r ? r[parseInt(dateColIdx)] : null).filter(Boolean)
    : [];
  const dateFormat = detectDateFormat(allRawDates, 'dmy'); // OneGlance stock uses DD-MM-YYYY

  for (let i = headerRowIdx + 1; i < rawData.length; i++) {
    const raw = rawData[i];
    if (!raw || raw.every((c: any) => c == null || c === '')) continue;

    const get = (field: string) => {
      for (const [colIdx, mappedField] of Object.entries(colMapping)) {
        if (mappedField === field) return raw[parseInt(colIdx)];
      }
      return null;
    };

    const drugName = get('drug_name');
    if (!drugName || String(drugName).trim() === '') continue;

    const toNum = (v: any) => {
      if (v == null || v === '') return 0;
      const n = Number(v);
      return isNaN(n) ? 0 : n;
    };

    rows.push({
      drug_name: String(drugName).trim(),
      batch_no: get('batch_no') != null ? String(get('batch_no')).trim() : null,
      received_date: parseExcelDate(get('received_date'), dateFormat),
      expiry_date: get('expiry_date') != null ? String(get('expiry_date')).trim() : null,
      avl_qty: toNum(get('avl_qty')),
      strips: toNum(get('strips')),
      purchase_price: toNum(get('purchase_price')),
      purchase_tax: toNum(get('purchase_tax')),
      purchase_value: toNum(get('purchase_value')),
      stock_value: toNum(get('stock_value')),
    });
  }

  const totalStockValue = rows.reduce((sum, r) => sum + r.stock_value, 0);

  return {
    rows,
    summary: {
      totalRows: rows.length,
      totalStockValue,
      totalItems: rows.length,
      warnings,
    },
  };
}
