import * as XLSX from 'xlsx';
import { parseExcelDate, dateToMonth, detectDateFormat } from '../../utils/fy.js';

export interface PetpoojaRow {
  bill_no: string | null;
  bill_date: string | null;
  bill_month: string;
  bill_time: string | null;
  order_channel: string;          // canonicalized: Dine-in / Delivery / Takeaway / Catering / passthrough
  payment_type: string | null;
  table_no: string | null;
  server_name: string | null;
  covers: number;
  item_name: string | null;
  item_category: string | null;
  group_name: string | null;
  qty: number;
  price: number;
  gross_amount: number;
  discount: number;
  tax: number;
  final_total: number;
  status: string | null;
}

// Header-name → internal-field map (case-insensitive, trim'd).
// Petpooja's "Item Report With Customer/Order Details" exports these columns
// in row 5 (rows 0-2 hold report metadata, 3-4 are blank, row 6 is a "Total"
// summary that must be skipped). The auto-detection below scans the first
// 12 rows for the row that matches the most known column names — same
// approach as healthplix.ts so Petpooja layout changes don't break parsing.
const COLUMN_MAP: Record<string, keyof PetpoojaRow> = {
  'date':          'bill_date',
  'timestamp':     'bill_time',
  'invoice no.':   'bill_no',
  'invoice no':    'bill_no',
  'payment type':  'payment_type',
  'order type':    'order_channel',
  'item name':     'item_name',
  'price':         'price',
  'qty.':          'qty',
  'qty':           'qty',
  'sub total':     'gross_amount',
  'discount':      'discount',
  'tax':           'tax',
  'final total':   'final_total',
  'status':        'status',
  'table no.':     'table_no',
  'table no':      'table_no',
  'server name':   'server_name',
  'covers':        'covers',
  'category':      'item_category',
  'group name':    'group_name',
  'assign to':     'server_name', // fallback when Server Name is blank
};

/** Map Petpooja's raw Order Type values onto the four canonical streams
 *  declared in industry-templates.ts (Dine-in / Delivery / Takeaway / Catering).
 *  Anything unrecognized is passed through verbatim so it lands somewhere
 *  visible rather than silently silenced. */
export function canonicalChannel(raw: string | null | undefined): string {
  if (!raw) return 'Unknown';
  const s = String(raw).toLowerCase().trim();
  if (s.includes('dine'))                           return 'Dine-in';
  if (s.includes('pick') || s.includes('takeaway')
      || s.includes('take away'))                   return 'Takeaway';
  if (s.includes('parcel') || s.includes('deliver')
      || s.includes('zomato') || s.includes('swiggy')) return 'Delivery';
  if (s.includes('cater'))                          return 'Catering';
  return String(raw).trim();
}

export function parsePetpooja(filePath: string) {
  // raw: true so xlsx doesn't coerce date strings into Excel serial numbers
  const workbook = XLSX.readFile(filePath, { raw: true });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rawData = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true }) as any[][];

  // Find header row by best-match against COLUMN_MAP. Petpooja meta sits in
  // rows 0-2 ("Date:", "Name:", "Restaurant Name:") so we widen the window
  // to 12 to absorb future variants.
  let headerRowIdx = -1;
  let colMapping: Record<number, keyof PetpoojaRow> = {};
  for (let i = 0; i < Math.min(rawData.length, 12); i++) {
    const row = rawData[i];
    if (!row) continue;
    const matches: Record<number, keyof PetpoojaRow> = {};
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
    throw new Error('Could not find header row in Petpooja report. Expected columns: Date, Invoice No., Order Type, Item Name, Sub Total, Final Total.');
  }

  // Best-effort date-format detection. Petpooja today exports ISO YYYY-MM-DD
  // but the helper also handles DD/MM and MM/DD if a different export ever
  // lands here, so the parser stays robust.
  const dateColIdx = Object.entries(colMapping).find(([_, v]) => v === 'bill_date')?.[0];
  const allRawDates = dateColIdx
    ? rawData.slice(headerRowIdx + 1).map(r => r ? r[parseInt(dateColIdx)] : null).filter(Boolean)
    : [];
  const dateFormat = detectDateFormat(allRawDates);

  const rows: PetpoojaRow[] = [];
  const warnings: string[] = [];
  let skippedTotal = 0;
  let skippedNoDate = 0;
  let skippedNoChannel = 0;

  for (let i = headerRowIdx + 1; i < rawData.length; i++) {
    const raw = rawData[i];
    if (!raw || raw.every((c: any) => c == null || c === '')) continue;

    // Petpooja inserts a "Total" summary row directly after the headers.
    // Its first cell is the literal string "Total" and most data cells are
    // null. Skip it rather than treat the aggregates as a fake bill line.
    const firstCell = String(raw[0] ?? '').trim().toLowerCase();
    if (firstCell === 'total' || firstCell === 'grand total') { skippedTotal++; continue; }

    const get = (field: keyof PetpoojaRow) => {
      for (const [colIdx, mappedField] of Object.entries(colMapping)) {
        if (mappedField === field) return raw[parseInt(colIdx)];
      }
      return null;
    };

    const billDateRaw = get('bill_date');
    const billDate = parseExcelDate(billDateRaw, dateFormat);
    const billMonth = dateToMonth(billDateRaw, dateFormat);

    if (!billMonth) {
      skippedNoDate++;
      if (warnings.length < 10) warnings.push(`Row ${i + 1}: missing/unparseable date, skipping`);
      continue;
    }

    const channelRaw = get('order_channel');
    if (!channelRaw) {
      skippedNoChannel++;
      if (warnings.length < 10) warnings.push(`Row ${i + 1}: missing Order Type, skipping`);
      continue;
    }

    const toNum = (v: any) => {
      if (v == null || v === '') return 0;
      const n = Number(v);
      return isNaN(n) ? 0 : n;
    };
    const toStr = (v: any) => {
      if (v == null) return null;
      const s = String(v).trim();
      return s === '' ? null : s;
    };

    const billTimeRaw = get('bill_time');
    rows.push({
      bill_no:       get('bill_no') != null ? String(get('bill_no')).trim() : null,
      bill_date:     billDate,
      bill_month:    billMonth,
      bill_time:     billTimeRaw != null ? String(billTimeRaw).trim() : null,
      order_channel: canonicalChannel(String(channelRaw)),
      payment_type:  toStr(get('payment_type')),
      table_no:      get('table_no') != null ? String(get('table_no')).trim() : null,
      server_name:   toStr(get('server_name')),
      covers:        Math.round(toNum(get('covers'))),
      item_name:     toStr(get('item_name')),
      item_category: toStr(get('item_category')),
      group_name:    toStr(get('group_name')),
      qty:           toNum(get('qty')),
      price:         toNum(get('price')),
      gross_amount:  toNum(get('gross_amount')),
      discount:      toNum(get('discount')),
      tax:           toNum(get('tax')),
      final_total:   toNum(get('final_total')),
      status:        toStr(get('status')),
    });
  }

  const months = rows.map(r => r.bill_month).filter(Boolean).sort();
  if (skippedTotal > 1)     warnings.push(`Skipped ${skippedTotal} "Total" rows`);
  if (skippedNoDate > 0)    warnings.push(`Skipped ${skippedNoDate} rows with no parseable date`);
  if (skippedNoChannel > 0) warnings.push(`Skipped ${skippedNoChannel} rows with no Order Type`);

  return {
    rows,
    summary: {
      totalRows: rows.length,
      dateRange: months.length ? { start: months[0], end: months[months.length - 1] } : null,
      warnings,
    },
  };
}
