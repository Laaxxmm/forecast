import * as XLSX from 'xlsx';
import { parseExcelDate, dateToMonth } from '../../utils/fy.js';

interface HealthplixRow {
  bill_date: string | null;
  bill_month: string;
  patient_id: string | null;
  patient_name: string | null;
  order_number: string | null;
  billed: number;
  paid: number;
  discount: number;
  tax: number;
  refund: number;
  due: number;
  addl_disc: number;
  item_price: number;
  item_disc: number;
  department: string | null;
  service_name: string | null;
  billed_doctor: string | null;
  service_owner: string | null;
}

const COLUMN_MAP: Record<string, string> = {
  'bill date': 'bill_date',
  'id': 'patient_id',
  'name': 'patient_name',
  '#order': 'order_number',
  'billed': 'billed',
  'paid': 'paid',
  'discount': 'discount',
  'tax': 'tax',
  'refund': 'refund',
  'due': 'due',
  'addl. disc': 'addl_disc',
  'item price': 'item_price',
  'item disc': 'item_disc',
  'dept.': 'department',
  'dept': 'department',
  'service name': 'service_name',
  'billed doctor': 'billed_doctor',
  'service owner': 'service_owner',
};

export function parseHealthplix(filePath: string) {
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rawData = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null }) as any[][];

  // Find header row
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
    throw new Error('Could not find header row in Healthplix report. Expected columns: Bill Date, ID, Name, Item Price, Dept.');
  }

  const rows: HealthplixRow[] = [];
  const warnings: string[] = [];
  let lastDate: string | null = null;
  let lastMonth: string | null = null;
  let lastPatientId: string | null = null;
  let lastPatientName: string | null = null;
  let lastOrderNumber: string | null = null;

  for (let i = headerRowIdx + 1; i < rawData.length; i++) {
    const raw = rawData[i];
    if (!raw || raw.every((c: any) => c == null || c === '')) continue;

    const get = (field: string) => {
      for (const [colIdx, mappedField] of Object.entries(colMapping)) {
        if (mappedField === field) return raw[parseInt(colIdx)];
      }
      return null;
    };

    const billDateRaw = get('bill_date');
    const billDate = parseExcelDate(billDateRaw);
    const billMonth = dateToMonth(billDateRaw);

    // Carry forward date/patient for multi-row bills
    const currentDate = billDate || lastDate;
    const currentMonth = billMonth || lastMonth;
    const currentPatientId = get('patient_id') != null ? String(get('patient_id')) : lastPatientId;
    const currentPatientName = get('patient_name') != null ? String(get('patient_name')) : lastPatientName;
    const currentOrderNumber = get('order_number') != null ? String(get('order_number')) : lastOrderNumber;

    if (billDate) {
      lastDate = billDate;
      lastMonth = billMonth;
    }
    if (get('patient_id') != null) lastPatientId = String(get('patient_id'));
    if (get('patient_name') != null) lastPatientName = String(get('patient_name'));
    if (get('order_number') != null) lastOrderNumber = String(get('order_number'));

    if (!currentMonth) {
      warnings.push(`Row ${i + 1}: Could not determine month, skipping`);
      continue;
    }

    const toNum = (v: any) => {
      if (v == null || v === '') return 0;
      const n = Number(v);
      return isNaN(n) ? 0 : n;
    };

    rows.push({
      bill_date: currentDate,
      bill_month: currentMonth,
      patient_id: currentPatientId,
      patient_name: currentPatientName,
      order_number: currentOrderNumber,
      billed: toNum(get('billed')),
      paid: toNum(get('paid')),
      discount: toNum(get('discount')),
      tax: toNum(get('tax')),
      refund: toNum(get('refund')),
      due: toNum(get('due')),
      addl_disc: toNum(get('addl_disc')),
      item_price: toNum(get('item_price')),
      item_disc: toNum(get('item_disc')),
      department: get('department') ? String(get('department')).toUpperCase().trim() : null,
      service_name: get('service_name') ? String(get('service_name')) : null,
      billed_doctor: get('billed_doctor') ? String(get('billed_doctor')).trim() : null,
      service_owner: get('service_owner') ? String(get('service_owner')).trim() : null,
    });
  }

  const months = rows.map(r => r.bill_month).filter(Boolean).sort();
  return {
    rows,
    summary: {
      totalRows: rows.length,
      dateRange: months.length ? { start: months[0], end: months[months.length - 1] } : null,
      warnings,
    },
  };
}
