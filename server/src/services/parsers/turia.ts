import * as XLSX from 'xlsx';
import { parseExcelDate, dateToMonth } from '../../utils/fy.js';

export interface TuriaInvoiceRow {
  invoice_id: string | null;
  billing_org: string | null;
  client_name: string | null;
  gstin: string | null;
  service: string | null;
  sac_code: string | null;
  invoice_date: string | null;
  invoice_month: string;
  due_date: string | null;
  total_amount: number;
  status: string | null;
}

const COLUMN_MAP: Record<string, string> = {
  'id': 'invoice_id',
  'invoice id': 'invoice_id',
  'invoice no': 'invoice_id',
  'invoice number': 'invoice_id',
  'inv no': 'invoice_id',
  'billing org': 'billing_org',
  'billing organization': 'billing_org',
  'organisation': 'billing_org',
  'organization': 'billing_org',
  'client': 'client_name',
  'client name': 'client_name',
  'customer': 'client_name',
  'customer name': 'client_name',
  'party name': 'client_name',
  'gstin': 'gstin',
  'gst no': 'gstin',
  'gst number': 'gstin',
  'service': 'service',
  'service name': 'service',
  'description': 'service',
  'particulars': 'service',
  'sac code': 'sac_code',
  'sac': 'sac_code',
  'hsn/sac': 'sac_code',
  'invoice date': 'invoice_date',
  'date': 'invoice_date',
  'inv date': 'invoice_date',
  'due date': 'due_date',
  'total amount': 'total_amount',
  'total': 'total_amount',
  'amount': 'total_amount',
  'invoice amount': 'total_amount',
  'grand total': 'total_amount',
  'net amount': 'total_amount',
  'sub total': 'total_amount',
  'subtotal': 'total_amount',
  'status': 'status',
  'payment status': 'status',
};

function num(v: any): number {
  if (v == null || v === '' || v === '-') return 0;
  const n = parseFloat(String(v).replace(/,/g, ''));
  return isNaN(n) ? 0 : n;
}

function str(v: any): string | null {
  if (v == null || v === '' || v === '-') return null;
  return String(v).trim();
}

export function parseTuriaInvoices(filePath: string): {
  rows: TuriaInvoiceRow[];
  summary: { totalRows: number; totalAmount: number; dateRange: { start: string; end: string } | null; warnings: string[] };
} {
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  if (rawRows.length === 0) {
    throw new Error('No data found in the uploaded file');
  }

  // Map column headers
  const sampleRow = rawRows[0] as Record<string, any>;
  const headerMap: Record<string, string> = {};
  for (const key of Object.keys(sampleRow)) {
    const normalized = key.toLowerCase().trim();
    if (COLUMN_MAP[normalized]) {
      headerMap[key] = COLUMN_MAP[normalized];
    }
  }

  const warnings: string[] = [];
  if (!headerMap[Object.keys(headerMap).find(k => headerMap[k] === 'invoice_date') || '']) {
    warnings.push('Invoice date column not found — months may be incorrect');
  }

  const rows: TuriaInvoiceRow[] = [];
  let minDate: string | null = null;
  let maxDate: string | null = null;
  let totalAmount = 0;

  for (const raw of rawRows as Record<string, any>[]) {
    const mapped: Record<string, any> = {};
    for (const [origKey, dbKey] of Object.entries(headerMap)) {
      mapped[dbKey] = raw[origKey];
    }

    const invoiceDate = parseExcelDate(mapped.invoice_date);
    const invoiceMonth = dateToMonth(mapped.invoice_date) || '';

    if (!invoiceMonth && !mapped.client_name && !mapped.invoice_id) {
      continue; // Skip empty rows
    }

    const amount = num(mapped.total_amount);
    totalAmount += amount;

    const row: TuriaInvoiceRow = {
      invoice_id: str(mapped.invoice_id),
      billing_org: str(mapped.billing_org),
      client_name: str(mapped.client_name),
      gstin: str(mapped.gstin),
      service: str(mapped.service),
      sac_code: str(mapped.sac_code),
      invoice_date: invoiceDate,
      invoice_month: invoiceMonth,
      due_date: parseExcelDate(mapped.due_date),
      total_amount: amount,
      status: str(mapped.status),
    };

    rows.push(row);

    if (invoiceDate) {
      if (!minDate || invoiceDate < minDate) minDate = invoiceDate;
      if (!maxDate || invoiceDate > maxDate) maxDate = invoiceDate;
    }
  }

  if (rows.length === 0) {
    throw new Error('No valid invoice rows found in the file');
  }

  return {
    rows,
    summary: {
      totalRows: rows.length,
      totalAmount,
      dateRange: minDate && maxDate ? { start: minDate, end: maxDate } : null,
      warnings,
    },
  };
}
