import { Router } from 'express';
import { upload } from '../middleware/upload.js';
import { requireAdmin, requireIntegration } from '../middleware/auth.js';
import { parseHealthplix } from '../services/parsers/healthplix.js';
import { parseOneglanceSales } from '../services/parsers/oneglance-sales.js';
import { parseOneglancePurchase } from '../services/parsers/oneglance-purchase.js';
import { parseTuriaInvoices } from '../services/parsers/turia.js';
import { getBranchIdForInsert, branchFilter, getStreamIdForInsert } from '../utils/branch.js';
import { getPlatformHelper } from '../db/platform-connection.js';
import fs from 'fs';

const isProd = process.env.NODE_ENV === 'production';

/** Resolve the correct stream_id for an import based on integration type.
 *  Falls back to getStreamIdForInsert if no match found. */
async function resolveStreamId(req: any, integrationHint: 'clinic' | 'pharmacy' | 'consultancy'): Promise<number | null> {
  const fromHeader = getStreamIdForInsert(req);
  if (fromHeader) return fromHeader;
  // If user is on "All" streams, determine the stream from the integration type
  try {
    const platformDb = await getPlatformHelper();
    const streams = platformDb.all(
      'SELECT id, name FROM business_streams WHERE client_id = ? AND is_active = 1 ORDER BY sort_order',
      req.clientId
    );
    for (const s of streams) {
      const n = s.name.toLowerCase();
      if (integrationHint === 'clinic' && (n.includes('clinic') || n.includes('health'))) return s.id;
      if (integrationHint === 'pharmacy' && n.includes('pharma')) return s.id;
      if (integrationHint === 'consultancy' && (n.includes('consult') || n.includes('turia'))) return s.id;
    }
  } catch { /* platform DB may not be available */ }
  return fromHeader;
}

const router = Router();

router.post('/healthplix', requireAdmin, requireIntegration('healthplix'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const db = req.tenantDb!;
    const branchId = getBranchIdForInsert(req);
    const { rows, summary } = parseHealthplix(req.file.path);

    const importLog = db.run(
      `INSERT INTO import_logs (source, filename, rows_imported, date_range_start, date_range_end, status, branch_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      'HEALTHPLIX', req.file.originalname, rows.length,
      summary.dateRange?.start || null, summary.dateRange?.end || null, 'completed', branchId
    );

    for (const r of rows) {
      db.run(
        `INSERT INTO clinic_actuals (import_id, branch_id, bill_date, bill_month, patient_id, patient_name, order_number,
          billed, paid, discount, tax, refund, due, addl_disc, item_price, item_disc,
          department, service_name, billed_doctor, service_owner)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        importLog.lastInsertRowid, branchId, r.bill_date, r.bill_month, r.patient_id, r.patient_name,
        r.order_number, r.billed, r.paid, r.discount, r.tax, r.refund, r.due,
        r.addl_disc, r.item_price, r.item_disc, r.department, r.service_name,
        r.billed_doctor, r.service_owner
      );
    }

    // Auto-add doctors
    const doctors = [...new Set(rows.map(r => r.billed_doctor).filter(d => d && d !== '-'))];
    for (const d of doctors) {
      db.run('INSERT OR IGNORE INTO doctors (name) VALUES (?)', d);
    }

    // Auto-sync clinic revenue to dashboard_actuals for active scenario
    const bf = branchFilter(req);
    const clinicStreamId = await resolveStreamId(req, 'clinic');
    const activeScenario = db.get(
      `SELECT s.id FROM scenarios s
       JOIN financial_years fy ON s.fy_id = fy.id
       WHERE fy.is_active = 1 AND s.is_default = 1${bf.where} LIMIT 1`,
      ...bf.params
    );
    if (activeScenario) {
      const clinicMonthly = db.all(
        `SELECT bill_month as month, COALESCE(SUM(item_price), 0) as total
         FROM clinic_actuals WHERE bill_month IS NOT NULL AND bill_month != ''${bf.where} GROUP BY bill_month`,
        ...bf.params
      );
      for (const row of clinicMonthly) {
        if (!row.month) continue;
        db.run(
          `INSERT INTO dashboard_actuals (scenario_id, category, item_name, month, amount, branch_id, stream_id, updated_at)
           VALUES (?, 'revenue', 'Clinic Revenue', ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(scenario_id, category, item_name, month)
           DO UPDATE SET amount = excluded.amount, stream_id = excluded.stream_id, updated_at = datetime('now')`,
          activeScenario.id, row.month, row.total, branchId, clinicStreamId
        );
      }
    }

    fs.unlinkSync(req.file.path);
    res.json({ importId: importLog.lastInsertRowid, ...summary });
  } catch (err: any) {
    if (req.file?.path) try { fs.unlinkSync(req.file.path); } catch {}
    res.status(400).json({ error: isProd ? 'Import failed' : err.message });
  }
});

router.post('/oneglance-sales', requireAdmin, requireIntegration('oneglance'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const db = req.tenantDb!;
    const branchId = getBranchIdForInsert(req);
    const { rows, summary } = parseOneglanceSales(req.file.path);

    const importLog = db.run(
      `INSERT INTO import_logs (source, filename, rows_imported, date_range_start, date_range_end, status, branch_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      'ONEGLANCE_SALES', req.file.originalname, rows.length,
      summary.dateRange?.start || null, summary.dateRange?.end || null, 'completed', branchId
    );

    for (const r of rows) {
      db.run(
        `INSERT INTO pharmacy_sales_actuals (import_id, branch_id, bill_no, bill_date, bill_month, drug_name,
          batch_no, hsn_code, tax_pct, patient_id, patient_name, referred_by,
          qty, sales_amount, purchase_amount, purchase_tax, sales_tax, profit)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        importLog.lastInsertRowid, branchId, r.bill_no, r.bill_date, r.bill_month, r.drug_name,
        r.batch_no, r.hsn_code, r.tax_pct, r.patient_id, r.patient_name, r.referred_by,
        r.qty, r.sales_amount, r.purchase_amount, r.purchase_tax, r.sales_tax, r.profit
      );
    }

    // Auto-sync pharmacy sales revenue to dashboard_actuals for active scenario
    const bf = branchFilter(req);
    const pharmaStreamId = await resolveStreamId(req, 'pharmacy');
    const activeScenario = db.get(
      `SELECT s.id FROM scenarios s
       JOIN financial_years fy ON s.fy_id = fy.id
       WHERE fy.is_active = 1 AND s.is_default = 1${bf.where} LIMIT 1`,
      ...bf.params
    );
    if (activeScenario) {
      const pharmaMonthly = db.all(
        `SELECT bill_month as month, COALESCE(SUM(sales_amount), 0) as total
         FROM pharmacy_sales_actuals WHERE bill_month IS NOT NULL AND bill_month != ''${bf.where} GROUP BY bill_month`,
        ...bf.params
      );
      for (const row of pharmaMonthly) {
        if (!row.month) continue;
        db.run(
          `INSERT INTO dashboard_actuals (scenario_id, category, item_name, month, amount, branch_id, stream_id, updated_at)
           VALUES (?, 'revenue', 'Pharmacy Revenue', ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(scenario_id, category, item_name, month)
           DO UPDATE SET amount = excluded.amount, stream_id = excluded.stream_id, updated_at = datetime('now')`,
          activeScenario.id, row.month, row.total, branchId, pharmaStreamId
        );
      }
    }

    fs.unlinkSync(req.file.path);
    res.json({ importId: importLog.lastInsertRowid, ...summary });
  } catch (err: any) {
    if (req.file?.path) try { fs.unlinkSync(req.file.path); } catch {}
    res.status(400).json({ error: isProd ? 'Import failed' : err.message });
  }
});

router.post('/oneglance-purchase', requireAdmin, requireIntegration('oneglance'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const db = req.tenantDb!;
    const branchId = getBranchIdForInsert(req);
    const { rows, summary } = parseOneglancePurchase(req.file.path);

    const importLog = db.run(
      `INSERT INTO import_logs (source, filename, rows_imported, date_range_start, date_range_end, status, branch_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      'ONEGLANCE_PURCHASE', req.file.originalname, rows.length,
      summary.dateRange?.start || null, summary.dateRange?.end || null, 'completed', branchId
    );

    for (const r of rows) {
      db.run(
        `INSERT INTO pharmacy_purchase_actuals (import_id, branch_id, invoice_no, invoice_date, invoice_month,
          stockiest_name, mfg_name, drug_name, batch_no, hsn_code, batch_qty, free_qty,
          mrp, rate, discount_amount, net_purchase_value, net_sales_value, tax_pct, tax_amount,
          purchase_qty, purchase_value, sales_value, profit, profit_pct)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        importLog.lastInsertRowid, branchId, r.invoice_no, r.invoice_date, r.invoice_month,
        r.stockiest_name, r.mfg_name, r.drug_name, r.batch_no, r.hsn_code,
        r.batch_qty, r.free_qty, r.mrp, r.rate, r.discount_amount,
        r.net_purchase_value, r.net_sales_value, r.tax_pct, r.tax_amount,
        r.purchase_qty, r.purchase_value, r.sales_value, r.profit, r.profit_pct
      );
    }

    fs.unlinkSync(req.file.path);
    res.json({ importId: importLog.lastInsertRowid, ...summary });
  } catch (err: any) {
    if (req.file?.path) try { fs.unlinkSync(req.file.path); } catch {}
    res.status(400).json({ error: isProd ? 'Import failed' : err.message });
  }
});

router.post('/turia', requireAdmin, requireIntegration('turia'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const db = req.tenantDb!;
    const branchId = getBranchIdForInsert(req);
    const { rows, summary } = parseTuriaInvoices(req.file.path);

    const importLog = db.run(
      `INSERT INTO import_logs (source, filename, rows_imported, date_range_start, date_range_end, status, branch_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      'TURIA', req.file.originalname, rows.length,
      summary.dateRange?.start || null, summary.dateRange?.end || null, 'completed', branchId
    );

    for (const r of rows) {
      db.run(
        `INSERT INTO turia_invoices (import_id, branch_id, invoice_id, billing_org, client_name, gstin,
          service, sac_code, invoice_date, invoice_month, due_date, total_amount, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        importLog.lastInsertRowid, branchId, r.invoice_id, r.billing_org, r.client_name, r.gstin,
        r.service, r.sac_code, r.invoice_date, r.invoice_month, r.due_date,
        r.total_amount, r.status
      );
    }

    // Auto-sync consultancy revenue to dashboard_actuals
    const bf = branchFilter(req);
    const consultStreamId = await resolveStreamId(req, 'consultancy');
    const activeScenario = db.get(
      `SELECT s.id FROM scenarios s JOIN financial_years fy ON s.fy_id = fy.id
       WHERE fy.is_active = 1 AND s.is_default = 1${bf.where} LIMIT 1`,
      ...bf.params
    );
    if (activeScenario) {
      const turiaMonthly = db.all(
        `SELECT invoice_month as month, COALESCE(SUM(total_amount), 0) as total
         FROM turia_invoices WHERE invoice_month IS NOT NULL AND invoice_month != ''${bf.where}
         GROUP BY invoice_month`,
        ...bf.params
      );
      for (const row of turiaMonthly) {
        if (!row.month) continue;
        db.run(
          `INSERT INTO dashboard_actuals (scenario_id, category, item_name, month, amount, branch_id, stream_id, updated_at)
           VALUES (?, 'revenue', 'Consultancy Revenue', ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(scenario_id, category, item_name, month)
           DO UPDATE SET amount = excluded.amount, stream_id = excluded.stream_id, updated_at = datetime('now')`,
          activeScenario.id, row.month, row.total, branchId, consultStreamId
        );
      }
    }

    fs.unlinkSync(req.file.path);
    res.json({ importId: importLog.lastInsertRowid, ...summary });
  } catch (err: any) {
    if (req.file?.path) try { fs.unlinkSync(req.file.path); } catch {}
    res.status(400).json({ error: isProd ? 'Import failed' : err.message });
  }
});

router.get('/history', async (req, res) => {
  const db = req.tenantDb!;
  const bf = branchFilter(req);
  res.json(db.all(`SELECT * FROM import_logs WHERE 1=1${bf.where} ORDER BY created_at DESC`, ...bf.params));
});

router.delete('/:id', requireAdmin, async (req, res) => {
  const db = req.tenantDb!;
  db.run('DELETE FROM clinic_actuals WHERE import_id = ?', req.params.id);
  db.run('DELETE FROM pharmacy_sales_actuals WHERE import_id = ?', req.params.id);
  db.run('DELETE FROM pharmacy_purchase_actuals WHERE import_id = ?', req.params.id);
  db.run('DELETE FROM turia_invoices WHERE import_id = ?', req.params.id);
  db.run('DELETE FROM import_logs WHERE id = ?', req.params.id);
  res.json({ ok: true });
});

export default router;
