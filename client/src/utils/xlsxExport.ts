import * as XLSX from 'xlsx';

interface Column {
  header: string;
  key: string;
  width?: number;
  format?: 'currency' | 'percent' | 'number' | 'date';
}

export function downloadXlsx(rows: any[], columns: Column[], filename: string) {
  const headers = columns.map(c => c.header);
  const data = rows.map(r =>
    columns.map(c => {
      const val = r[c.key];
      if (val == null || val === '') return '';
      if (c.format === 'currency') return typeof val === 'number' ? val : parseFloat(val) || 0;
      if (c.format === 'percent') return typeof val === 'number' ? val : parseFloat(val) || 0;
      if (c.format === 'number') return typeof val === 'number' ? val : parseFloat(val) || 0;
      return val;
    })
  );

  const ws = XLSX.utils.aoa_to_sheet([headers, ...data]);

  // Set column widths
  ws['!cols'] = columns.map(c => ({ wch: c.width || 15 }));

  // Format currency/percent cells
  columns.forEach((c, ci) => {
    if (!c.format) return;
    const fmt = c.format === 'currency' ? '#,##0.00'
      : c.format === 'percent' ? '0.0"%"'
      : c.format === 'number' ? '#,##0'
      : undefined;
    if (!fmt) return;
    for (let ri = 1; ri <= rows.length; ri++) {
      const ref = XLSX.utils.encode_cell({ r: ri, c: ci });
      if (ws[ref]) ws[ref].z = fmt;
    }
  });

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Report');
  XLSX.writeFile(wb, `${filename}.xlsx`);
}

// ── Column configs for Pharmacy tables ─────────────────────────────────────

export const PURCHASE_COLUMNS: Column[] = [
  { header: 'Invoice', key: 'invoice_no', width: 15 },
  { header: 'Date', key: 'invoice_date', width: 12, format: 'date' },
  { header: 'Stockist', key: 'stockiest_name', width: 30 },
  { header: 'Drug', key: 'drug_name', width: 35 },
  { header: 'Batch Qty', key: 'batch_qty', width: 10, format: 'number' },
  { header: 'Free Qty', key: 'free_qty', width: 10, format: 'number' },
  { header: 'MRP', key: 'mrp', width: 12, format: 'currency' },
  { header: 'Purchase Value', key: 'purchase_value', width: 15, format: 'currency' },
  { header: 'Tax', key: 'tax_amount', width: 12, format: 'currency' },
  { header: 'Margin %', key: 'profit_pct', width: 10, format: 'percent' },
];

export const SALES_COLUMNS: Column[] = [
  { header: 'Bill #', key: 'bill_no', width: 10 },
  { header: 'Date', key: 'bill_date', width: 12, format: 'date' },
  { header: 'Patient', key: 'patient_name', width: 25 },
  { header: 'Drug', key: 'drug_name', width: 35 },
  { header: 'Qty', key: 'qty', width: 8, format: 'number' },
  { header: 'Sales', key: 'sales_amount', width: 14, format: 'currency' },
  { header: 'COGS', key: 'purchase_amount', width: 14, format: 'currency' },
  { header: 'Profit', key: 'profit', width: 14, format: 'currency' },
  { header: 'Referred By', key: 'referred_by', width: 20 },
];

export const STOCK_COLUMNS: Column[] = [
  { header: 'Drug Name', key: 'drug_name', width: 35 },
  { header: 'Batch', key: 'batch_no', width: 15 },
  { header: 'Received', key: 'received_date', width: 12, format: 'date' },
  { header: 'Expiry', key: 'expiry_date', width: 12, format: 'date' },
  { header: 'Avl Qty', key: 'avl_qty', width: 10, format: 'number' },
  { header: 'Strips', key: 'strips', width: 10, format: 'number' },
  { header: 'Purchase Price', key: 'purchase_price', width: 15, format: 'currency' },
  { header: 'Stock Value', key: 'stock_value', width: 15, format: 'currency' },
];

// ── Full export columns (from DB, used by Import page download) ───────────

export const CLINIC_EXPORT_COLUMNS: Column[] = [
  { header: 'Bill Date', key: 'bill_date', width: 12, format: 'date' },
  { header: 'Patient ID', key: 'patient_id', width: 12 },
  { header: 'Patient Name', key: 'patient_name', width: 22 },
  { header: 'Order #', key: 'order_number', width: 14 },
  { header: 'Department', key: 'department', width: 18 },
  { header: 'Service', key: 'service_name', width: 30 },
  { header: 'Billed Doctor', key: 'billed_doctor', width: 20 },
  { header: 'Service Owner', key: 'service_owner', width: 20 },
  { header: 'Billed', key: 'billed', width: 12, format: 'currency' },
  { header: 'Paid', key: 'paid', width: 12, format: 'currency' },
  { header: 'Discount', key: 'discount', width: 12, format: 'currency' },
  { header: 'Tax', key: 'tax', width: 10, format: 'currency' },
  { header: 'Refund', key: 'refund', width: 10, format: 'currency' },
  { header: 'Due', key: 'due', width: 10, format: 'currency' },
  { header: 'Item Price', key: 'item_price', width: 12, format: 'currency' },
  { header: 'Item Discount', key: 'item_disc', width: 12, format: 'currency' },
];

export const PHARMA_PURCHASE_EXPORT_COLUMNS: Column[] = [
  { header: 'Invoice', key: 'invoice_no', width: 15 },
  { header: 'Date', key: 'invoice_date', width: 12, format: 'date' },
  { header: 'Stockist', key: 'stockiest_name', width: 30 },
  { header: 'Manufacturer', key: 'mfg_name', width: 25 },
  { header: 'Drug', key: 'drug_name', width: 35 },
  { header: 'Batch', key: 'batch_no', width: 12 },
  { header: 'HSN Code', key: 'hsn_code', width: 10 },
  { header: 'Batch Qty', key: 'batch_qty', width: 10, format: 'number' },
  { header: 'Free Qty', key: 'free_qty', width: 10, format: 'number' },
  { header: 'MRP', key: 'mrp', width: 12, format: 'currency' },
  { header: 'Rate', key: 'rate', width: 12, format: 'currency' },
  { header: 'Discount', key: 'discount_amount', width: 12, format: 'currency' },
  { header: 'Purchase Value', key: 'purchase_value', width: 15, format: 'currency' },
  { header: 'Net Purchase', key: 'net_purchase_value', width: 15, format: 'currency' },
  { header: 'Tax', key: 'tax_amount', width: 12, format: 'currency' },
  { header: 'Margin %', key: 'profit_pct', width: 10, format: 'percent' },
];

export const PHARMA_SALES_EXPORT_COLUMNS: Column[] = [
  { header: 'Bill #', key: 'bill_no', width: 10 },
  { header: 'Date', key: 'bill_date', width: 12, format: 'date' },
  { header: 'Patient', key: 'patient_name', width: 25 },
  { header: 'Drug', key: 'drug_name', width: 35 },
  { header: 'Batch', key: 'batch_no', width: 12 },
  { header: 'HSN Code', key: 'hsn_code', width: 10 },
  { header: 'Qty', key: 'qty', width: 8, format: 'number' },
  { header: 'Sales', key: 'sales_amount', width: 14, format: 'currency' },
  { header: 'COGS', key: 'purchase_amount', width: 14, format: 'currency' },
  { header: 'Tax', key: 'sales_tax', width: 12, format: 'currency' },
  { header: 'Profit', key: 'profit', width: 14, format: 'currency' },
  { header: 'Referred By', key: 'referred_by', width: 20 },
];
