import { Router } from 'express';
import { upload } from '../middleware/upload.js';
import { requireAdmin, requireIntegration } from '../middleware/auth.js';
import { parseHealthplix } from '../services/parsers/healthplix.js';
import { parseOneglanceSales } from '../services/parsers/oneglance-sales.js';
import { parseOneglancePurchase } from '../services/parsers/oneglance-purchase.js';
import { parseOneglanceStock } from '../services/parsers/oneglance-stock.js';
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

    // Dedup: delete existing clinic rows for the specific (branch, date) pairs
    // being re-imported. The branch_id scope is MANDATORY — without it an
    // upload for one branch would wipe another branch's rows on the same dates.
    // `branch_id IS ?` handles NULL (single-branch clients) correctly.
    const clinicDatesToReplace = [...new Set(rows.map(r => r.bill_date).filter(Boolean))];
    if (clinicDatesToReplace.length > 0) {
      const ph = clinicDatesToReplace.map(() => '?').join(',');
      db.run(
        `DELETE FROM clinic_actuals WHERE branch_id IS ? AND bill_date IN (${ph})`,
        branchId, ...clinicDatesToReplace
      );
    }

    db.run(
      `INSERT INTO import_logs (source, filename, rows_imported, date_range_start, date_range_end, status, branch_id, file_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      'HEALTHPLIX', req.file.originalname, rows.length,
      summary.dateRange?.start || null, summary.dateRange?.end || null, 'completed', branchId, req.file.path
    );
    const importId = db.get("SELECT id FROM import_logs WHERE source = 'HEALTHPLIX' ORDER BY id DESC LIMIT 1")?.id || 0;

    db.beginBatch();
    try {
      for (const r of rows) {
        db.run(
          `INSERT INTO clinic_actuals (import_id, branch_id, bill_date, bill_month, patient_id, patient_name, order_number,
            billed, paid, discount, tax, refund, due, addl_disc, item_price, item_disc,
            department, service_name, billed_doctor, service_owner)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          importId, branchId, r.bill_date, r.bill_month, r.patient_id, r.patient_name,
          r.order_number, r.billed, r.paid, r.discount, r.tax, r.refund, r.due,
          r.addl_disc, r.item_price, r.item_disc, r.department, r.service_name,
          r.billed_doctor, r.service_owner
        );
      }
      db.endBatch();
    } catch (e) { db.rollbackBatch(); throw e; }

    // Verify rows were actually inserted
    const verifyCount = db.get('SELECT COUNT(*) as n FROM clinic_actuals WHERE import_id = ?', importId)?.n || 0;
    console.log(`[hp-import] Post-insert verification: expected=${rows.length}, actual=${verifyCount}, importId=${importId}`);

    // Auto-add doctors
    const doctors = [...new Set(rows.map(r => r.billed_doctor).filter(d => d && d !== '-'))];
    for (const d of doctors) {
      db.run('INSERT OR IGNORE INTO doctors (name) VALUES (?)', d);
    }

    // Auto-sync clinic revenue to dashboard_actuals for active scenario
    const bf = branchFilter(req);
    const clinicStreamId = await resolveStreamId(req, 'clinic');
    const activeScenario = db.get(
      `SELECT s.id FROM scenarios s JOIN financial_years fy ON s.fy_id = fy.id
       WHERE fy.is_active = 1 AND (s.stream_id = ? OR s.is_default = 1)
       ORDER BY CASE WHEN s.stream_id = ? THEN 0 ELSE 1 END, s.id LIMIT 1`,
      clinicStreamId, clinicStreamId
    );
    if (activeScenario) {
      db.run(
        `DELETE FROM dashboard_actuals WHERE scenario_id = ? AND category = 'revenue' AND item_name = 'Clinic Revenue'${bf.where}`,
        activeScenario.id, ...bf.params
      );
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

    res.json({ importId, ...summary });
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
    const currentMonth = new Date().toISOString().slice(0, 7);
    const { rows: allRows, summary } = parseOneglanceSales(req.file.path);
    const rows = allRows.filter(r => !r.bill_month || r.bill_month <= currentMonth);

    // Dedup: delete existing sales rows for this branch on the dates being
    // re-imported. branch_id scope is MANDATORY — an upload for one branch
    // must never clobber another branch's rows for the same dates.
    const salesDates = [...new Set(rows.map(r => r.bill_date).filter(Boolean))];
    if (salesDates.length > 0) {
      const ph = salesDates.map(() => '?').join(',');
      db.run(
        `DELETE FROM pharmacy_sales_actuals WHERE branch_id IS ? AND bill_date IN (${ph})`,
        branchId, ...salesDates
      );
    }

    db.run(
      `INSERT INTO import_logs (source, filename, rows_imported, date_range_start, date_range_end, status, branch_id, file_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      'ONEGLANCE_SALES', req.file.originalname, rows.length,
      summary.dateRange?.start || null, summary.dateRange?.end || null, 'completed', branchId, req.file.path
    );
    const importId = db.get("SELECT id FROM import_logs WHERE source = 'ONEGLANCE_SALES' ORDER BY id DESC LIMIT 1")?.id || 0;

    db.beginBatch();
    try {
      for (const r of rows) {
        db.run(
          `INSERT INTO pharmacy_sales_actuals (import_id, branch_id, bill_no, bill_date, bill_month, drug_name,
            batch_no, hsn_code, tax_pct, patient_id, patient_name, referred_by,
            qty, sales_amount, purchase_amount, purchase_tax, sales_tax, profit)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          importId, branchId, r.bill_no, r.bill_date, r.bill_month, r.drug_name,
          r.batch_no, r.hsn_code, r.tax_pct, r.patient_id, r.patient_name, r.referred_by,
          r.qty, r.sales_amount, r.purchase_amount, r.purchase_tax, r.sales_tax, r.profit
        );
      }
      db.endBatch();
    } catch (e) { db.rollbackBatch(); throw e; }

    // Auto-sync pharmacy sales revenue to dashboard_actuals for active scenario
    const bf = branchFilter(req);
    const pharmaStreamId = await resolveStreamId(req, 'pharmacy');
    const activeScenario = db.get(
      `SELECT s.id FROM scenarios s JOIN financial_years fy ON s.fy_id = fy.id
       WHERE fy.is_active = 1 AND (s.stream_id = ? OR s.is_default = 1)
       ORDER BY CASE WHEN s.stream_id = ? THEN 0 ELSE 1 END, s.id LIMIT 1`,
      pharmaStreamId, pharmaStreamId
    );
    if (activeScenario) {
      db.run(
        `DELETE FROM dashboard_actuals WHERE scenario_id = ? AND category = 'revenue' AND item_name = 'Pharmacy Revenue'${bf.where}`,
        activeScenario.id, ...bf.params
      );
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

    res.json({ importId, ...summary });
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
    const currentMonth = new Date().toISOString().slice(0, 7);
    const { rows: allRows, summary } = parseOneglancePurchase(req.file.path);
    const rows = allRows.filter(r => !r.invoice_month || r.invoice_month <= currentMonth);

    // Dedup: delete existing purchase rows for this branch on the dates being
    // re-imported. branch_id scope is MANDATORY — see sales handler above.
    const purchaseDates = [...new Set(rows.map(r => r.invoice_date).filter(Boolean))];
    if (purchaseDates.length > 0) {
      const ph = purchaseDates.map(() => '?').join(',');
      db.run(
        `DELETE FROM pharmacy_purchase_actuals WHERE branch_id IS ? AND invoice_date IN (${ph})`,
        branchId, ...purchaseDates
      );
    }

    db.run(
      `INSERT INTO import_logs (source, filename, rows_imported, date_range_start, date_range_end, status, branch_id, file_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      'ONEGLANCE_PURCHASE', req.file.originalname, rows.length,
      summary.dateRange?.start || null, summary.dateRange?.end || null, 'completed', branchId, req.file.path
    );
    const importId = db.get("SELECT id FROM import_logs WHERE source = 'ONEGLANCE_PURCHASE' ORDER BY id DESC LIMIT 1")?.id || 0;

    db.beginBatch();
    try {
      for (const r of rows) {
        db.run(
          `INSERT INTO pharmacy_purchase_actuals (import_id, branch_id, invoice_no, invoice_date, invoice_month,
            stockiest_name, mfg_name, drug_name, batch_no, hsn_code, batch_qty, free_qty,
            mrp, rate, discount_amount, net_purchase_value, net_sales_value, tax_pct, tax_amount,
            purchase_qty, purchase_value, sales_value, profit, profit_pct)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          importId, branchId, r.invoice_no, r.invoice_date, r.invoice_month,
          r.stockiest_name, r.mfg_name, r.drug_name, r.batch_no, r.hsn_code,
          r.batch_qty, r.free_qty, r.mrp, r.rate, r.discount_amount,
          r.net_purchase_value, r.net_sales_value, r.tax_pct, r.tax_amount,
          r.purchase_qty, r.purchase_value, r.sales_value, r.profit, r.profit_pct
        );
      }
      db.endBatch();
    } catch (e) { db.rollbackBatch(); throw e; }

    res.json({ importId, ...summary });
  } catch (err: any) {
    if (req.file?.path) try { fs.unlinkSync(req.file.path); } catch {}
    res.status(400).json({ error: isProd ? 'Import failed' : err.message });
  }
});

router.post('/oneglance-stock', requireAdmin, requireIntegration('oneglance'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const db = req.tenantDb!;
    const branchId = getBranchIdForInsert(req);
    const { rows, summary } = parseOneglanceStock(req.file.path);
    const snapshotDate = req.body.snapshotDate || new Date().toISOString().slice(0, 10);

    // Replace existing snapshot for the same date & branch
    db.run('DELETE FROM pharmacy_stock_actuals WHERE snapshot_date = ? AND branch_id IS ?', snapshotDate, branchId);

    db.run(
      `INSERT INTO import_logs (source, filename, rows_imported, date_range_start, date_range_end, status, branch_id, file_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      'ONEGLANCE_STOCK', req.file.originalname, rows.length,
      snapshotDate, snapshotDate, 'completed', branchId, req.file.path
    );
    const importId = db.get("SELECT id FROM import_logs WHERE source = 'ONEGLANCE_STOCK' ORDER BY id DESC LIMIT 1")?.id || 0;

    db.beginBatch();
    try {
      for (const r of rows) {
        db.run(
          `INSERT INTO pharmacy_stock_actuals (import_id, snapshot_date, drug_name, batch_no,
            received_date, expiry_date, avl_qty, strips, purchase_price, purchase_tax,
            purchase_value, stock_value, branch_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          importId, snapshotDate, r.drug_name, r.batch_no,
          r.received_date, r.expiry_date, r.avl_qty, r.strips,
          r.purchase_price, r.purchase_tax, r.purchase_value, r.stock_value, branchId
        );
      }
      db.endBatch();
    } catch (e) { db.rollbackBatch(); throw e; }

    res.json({ importId, ...summary });
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

    // Dedup: delete existing turia rows for this branch on the dates being
    // re-imported. branch_id scope is MANDATORY — see clinic handler above.
    const turiaDates = [...new Set(rows.map(r => r.invoice_date).filter(Boolean))];
    if (turiaDates.length > 0) {
      const ph = turiaDates.map(() => '?').join(',');
      db.run(
        `DELETE FROM turia_invoices WHERE branch_id IS ? AND invoice_date IN (${ph})`,
        branchId, ...turiaDates
      );
    }

    db.run(
      `INSERT INTO import_logs (source, filename, rows_imported, date_range_start, date_range_end, status, branch_id, file_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      'TURIA', req.file.originalname, rows.length,
      summary.dateRange?.start || null, summary.dateRange?.end || null, 'completed', branchId, req.file.path
    );
    const importId = db.get("SELECT id FROM import_logs WHERE source = 'TURIA' ORDER BY id DESC LIMIT 1")?.id || 0;

    db.beginBatch();
    try {
      for (const r of rows) {
        db.run(
          `INSERT INTO turia_invoices (import_id, branch_id, invoice_id, billing_org, client_name, gstin,
            service, sac_code, invoice_date, invoice_month, due_date, total_amount, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          importId, branchId, r.invoice_id, r.billing_org, r.client_name, r.gstin,
          r.service, r.sac_code, r.invoice_date, r.invoice_month, r.due_date,
          r.total_amount, r.status
        );
      }
      db.endBatch();
    } catch (e) { db.rollbackBatch(); throw e; }

    // Auto-sync consultancy revenue to dashboard_actuals
    const bf = branchFilter(req);
    const consultStreamId = await resolveStreamId(req, 'consultancy');
    const activeScenario = db.get(
      `SELECT s.id FROM scenarios s JOIN financial_years fy ON s.fy_id = fy.id
       WHERE fy.is_active = 1 AND (s.stream_id = ? OR s.is_default = 1)
       ORDER BY CASE WHEN s.stream_id = ? THEN 0 ELSE 1 END, s.id LIMIT 1`,
      consultStreamId, consultStreamId
    );
    if (activeScenario) {
      // Clear old Consultancy Revenue entries before re-syncing (prevents stale month data)
      db.run(
        `DELETE FROM dashboard_actuals WHERE scenario_id = ? AND category = 'revenue' AND item_name = 'Consultancy Revenue'${bf.where}`,
        activeScenario.id, ...bf.params
      );
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

    res.json({ importId, ...summary });
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
  const bf = branchFilter(req);

  // Delete source rows for this import
  db.run('DELETE FROM clinic_actuals WHERE import_id = ?', req.params.id);
  db.run('DELETE FROM pharmacy_sales_actuals WHERE import_id = ?', req.params.id);
  db.run('DELETE FROM pharmacy_purchase_actuals WHERE import_id = ?', req.params.id);
  db.run('DELETE FROM pharmacy_stock_actuals WHERE import_id = ?', req.params.id);
  db.run('DELETE FROM turia_invoices WHERE import_id = ?', req.params.id);
  db.run('DELETE FROM import_logs WHERE id = ?', req.params.id);

  // Re-sync dashboard_actuals from remaining source data
  const activeScenario = db.get(
    `SELECT s.id FROM scenarios s JOIN financial_years fy ON s.fy_id = fy.id
     WHERE fy.is_active = 1 AND s.is_default = 1${bf.where} LIMIT 1`,
    ...bf.params
  );
  if (activeScenario) {
    const branchId = getBranchIdForInsert(req);

    // Clear all synced entries (revenue + direct_costs) then rebuild from remaining source data
    db.run(
      `DELETE FROM dashboard_actuals WHERE scenario_id = ? AND category IN ('revenue', 'direct_costs')${bf.where}`,
      activeScenario.id, ...bf.params
    );

    // Re-sync Clinic Revenue from remaining data
    const clinicStreamId = await resolveStreamId(req, 'clinic');
    const clinicMonthly = db.all(
      `SELECT bill_month as month, COALESCE(SUM(item_price), 0) as total
       FROM clinic_actuals WHERE bill_month IS NOT NULL AND bill_month != ''${bf.where} GROUP BY bill_month`,
      ...bf.params
    );
    for (const row of clinicMonthly) {
      if (!row.month) continue;
      db.run(
        `INSERT INTO dashboard_actuals (scenario_id, category, item_name, month, amount, branch_id, stream_id, updated_at)
         VALUES (?, 'revenue', 'Clinic Revenue', ?, ?, ?, ?, datetime('now'))`,
        activeScenario.id, row.month, row.total, branchId, clinicStreamId
      );
    }

    // Re-sync Pharmacy Revenue from remaining data
    const pharmaStreamId = await resolveStreamId(req, 'pharmacy');
    const pharmaMonthly = db.all(
      `SELECT bill_month as month, COALESCE(SUM(sales_amount), 0) as total
       FROM pharmacy_sales_actuals WHERE bill_month IS NOT NULL AND bill_month != ''${bf.where} GROUP BY bill_month`,
      ...bf.params
    );
    for (const row of pharmaMonthly) {
      if (!row.month) continue;
      db.run(
        `INSERT INTO dashboard_actuals (scenario_id, category, item_name, month, amount, branch_id, stream_id, updated_at)
         VALUES (?, 'revenue', 'Pharmacy Revenue', ?, ?, ?, ?, datetime('now'))`,
        activeScenario.id, row.month, row.total, branchId, pharmaStreamId
      );
    }

    // Re-sync Pharmacy COGS from remaining data
    const pharmaCogs = db.all(
      `SELECT bill_month as month, COALESCE(SUM(purchase_amount), 0) as total
       FROM pharmacy_sales_actuals WHERE bill_month IS NOT NULL AND bill_month != ''${bf.where} GROUP BY bill_month`,
      ...bf.params
    );
    for (const row of pharmaCogs) {
      if (!row.month || row.total === 0) continue;
      db.run(
        `INSERT INTO dashboard_actuals (scenario_id, category, item_name, month, amount, branch_id, stream_id, updated_at)
         VALUES (?, 'direct_costs', 'Pharmacy COGS', ?, ?, ?, ?, datetime('now'))`,
        activeScenario.id, row.month, row.total, branchId, pharmaStreamId
      );
    }

    // Re-sync Consultancy Revenue from remaining data
    const consultStreamId = await resolveStreamId(req, 'consultancy');
    const turiaMonthly = db.all(
      `SELECT invoice_month as month, COALESCE(SUM(total_amount), 0) as total
       FROM turia_invoices WHERE invoice_month IS NOT NULL AND invoice_month != ''${bf.where} GROUP BY invoice_month`,
      ...bf.params
    );
    for (const row of turiaMonthly) {
      if (!row.month) continue;
      db.run(
        `INSERT INTO dashboard_actuals (scenario_id, category, item_name, month, amount, branch_id, stream_id, updated_at)
         VALUES (?, 'revenue', 'Consultancy Revenue', ?, ?, ?, ?, datetime('now'))`,
        activeScenario.id, row.month, row.total, branchId, consultStreamId
      );
    }
  }

  res.json({ ok: true });
});

router.get('/sync-tracker', async (req, res) => {
  const db = req.tenantDb!;
  const bf = branchFilter(req);
  const now = new Date();
  const monthParam = (req.query.month as string) || now.toISOString().slice(0, 7);
  const [yr, mo] = monthParam.split('-').map(Number);
  const daysInMonth = new Date(yr, mo, 0).getDate();
  const firstDay = `${monthParam}-01`;
  const lastDay = `${monthParam}-${String(daysInMonth).padStart(2, '0')}`;
  const todayStr = now.toISOString().slice(0, 10);

  // Q1–Q3: daily data coverage
  const clinicDays = db.all(
    `SELECT bill_date as date, COUNT(*) as row_count, COALESCE(SUM(item_price),0) as revenue
     FROM clinic_actuals WHERE bill_date >= ? AND bill_date <= ?${bf.where} GROUP BY bill_date`,
    firstDay, lastDay, ...bf.params
  );
  const salesDays = db.all(
    `SELECT bill_date as date, COUNT(*) as row_count, COALESCE(SUM(sales_amount),0) as revenue
     FROM pharmacy_sales_actuals WHERE bill_date >= ? AND bill_date <= ?${bf.where} GROUP BY bill_date`,
    firstDay, lastDay, ...bf.params
  );
  const purchaseDays = db.all(
    `SELECT invoice_date as date, COUNT(*) as row_count, COALESCE(SUM(purchase_value),0) as total
     FROM pharmacy_purchase_actuals WHERE invoice_date >= ? AND invoice_date <= ?${bf.where} GROUP BY invoice_date`,
    firstDay, lastDay, ...bf.params
  );

  // Q4: last sync timestamps
  const syncRows = db.all(
    `SELECT source, MAX(created_at) as last_sync_at FROM import_logs
     WHERE source IN ('HEALTHPLIX','HEALTHPLIX_SYNC','ONEGLANCE_SALES','ONEGLANCE_SALES_SYNC',
       'ONEGLANCE_PURCHASE','ONEGLANCE_PURCHASE_SYNC','ONEGLANCE_STOCK','ONEGLANCE_STOCK_SYNC','TURIA','TURIA_SYNC')
       AND status = 'completed'${bf.where} GROUP BY source`,
    ...bf.params
  );

  // Q5: latest stock snapshot
  const stockRow = db.get(
    `SELECT MAX(snapshot_date) as latest FROM pharmacy_stock_actuals WHERE 1=1${bf.where}`,
    ...bf.params
  );

  // Build lookup maps
  const clinicMap: Record<string, any> = {};
  for (const r of clinicDays) if (r.date) clinicMap[r.date] = { has: true, rows: r.row_count, rev: r.revenue };
  const salesMap: Record<string, any> = {};
  for (const r of salesDays) if (r.date) salesMap[r.date] = { has: true, rows: r.row_count, rev: r.revenue };
  const purchaseMap: Record<string, any> = {};
  for (const r of purchaseDays) if (r.date) purchaseMap[r.date] = { has: true, rows: r.row_count, total: r.total };

  // Sync timestamps — merge HP/HP_SYNC etc. into single per-integration latest
  const syncMap: Record<string, string> = {};
  for (const r of syncRows) {
    const key = r.source.replace('_SYNC', '');
    if (!syncMap[key] || r.last_sync_at > syncMap[key]) syncMap[key] = r.last_sync_at;
  }

  // Build per-day response + compute gaps
  const days: Record<string, any> = {};
  const gaps: Record<string, string[]> = { clinic: [], sales: [], purchase: [] };
  let clinicCovered = 0, clinicExpected = 0;
  let salesCovered = 0, salesExpected = 0;
  let purchaseCovered = 0, purchaseExpected = 0;

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${monthParam}-${String(d).padStart(2, '0')}`;
    const dow = new Date(yr, mo - 1, d).getDay(); // 0=Sun
    const isPast = dateStr <= todayStr;
    const noData = { has: false, rows: 0, rev: 0 };

    days[dateStr] = {
      dow,
      clinic: clinicMap[dateStr] || { ...noData },
      sales: salesMap[dateStr] || { ...noData },
      purchase: purchaseMap[dateStr] || { has: false, rows: 0, total: 0 },
    };

    if (isPast) {
      // Clinic: skip Sundays
      if (dow !== 0) {
        clinicExpected++;
        if (clinicMap[dateStr]) clinicCovered++;
        else gaps.clinic.push(dateStr);
      }
      // Sales & Purchase: every day
      salesExpected++;
      purchaseExpected++;
      if (salesMap[dateStr]) salesCovered++;
      else gaps.sales.push(dateStr);
      if (purchaseMap[dateStr]) purchaseCovered++;
      else gaps.purchase.push(dateStr);
    }
  }

  res.json({
    month: monthParam,
    today: todayStr,
    days,
    summary: {
      clinic: { covered: clinicCovered, expected: clinicExpected, pct: clinicExpected ? Math.round(clinicCovered / clinicExpected * 1000) / 10 : 100, lastSync: syncMap['HEALTHPLIX'] || null },
      sales: { covered: salesCovered, expected: salesExpected, pct: salesExpected ? Math.round(salesCovered / salesExpected * 1000) / 10 : 100, lastSync: syncMap['ONEGLANCE_SALES'] || null },
      purchase: { covered: purchaseCovered, expected: purchaseExpected, pct: purchaseExpected ? Math.round(purchaseCovered / purchaseExpected * 1000) / 10 : 100, lastSync: syncMap['ONEGLANCE_PURCHASE'] || null },
      stock: { latestSnapshot: stockRow?.latest || null, lastSync: syncMap['ONEGLANCE_STOCK'] || null },
      turia: { lastSync: syncMap['TURIA'] || null },
    },
    gaps,
  });
});

router.get('/download/:id', async (req, res) => {
  const db = req.tenantDb!;
  const log = db.get('SELECT file_path, filename FROM import_logs WHERE id = ?', req.params.id);
  if (!log || !log.file_path) return res.status(404).json({ error: 'File not available for download' });
  if (!fs.existsSync(log.file_path)) return res.status(404).json({ error: 'File no longer exists on disk' });
  res.download(log.file_path, log.filename || `import-${req.params.id}`);
});

// ── Export data from DB as JSON (client generates XLSX) ─────────────────────

router.get('/export/:source', async (req, res) => {
  const db = req.tenantDb!;
  const { source } = req.params;
  const { from, to } = req.query as { from?: string; to?: string };
  if (!from || !to) return res.status(400).json({ error: 'from and to query params required' });

  const bf = branchFilter(req);

  try {
    let rows: any[] = [];

    switch (source) {
      case 'clinic':
        rows = db.all(
          `SELECT bill_date, patient_id, patient_name, order_number, department, service_name,
            billed_doctor, service_owner, billed, paid, discount, tax, refund, due,
            addl_disc, item_price, item_disc
           FROM clinic_actuals WHERE bill_date >= ? AND bill_date <= ?${bf.where}
           ORDER BY bill_date, patient_name`,
          from, to, ...bf.params
        );
        break;

      case 'pharma-sales':
        rows = db.all(
          `SELECT bill_no, bill_date, patient_name, drug_name, batch_no, hsn_code,
            qty, sales_amount, purchase_amount, sales_tax, profit, referred_by
           FROM pharmacy_sales_actuals WHERE bill_date >= ? AND bill_date <= ?${bf.where}
           ORDER BY bill_date, bill_no`,
          from, to, ...bf.params
        );
        break;

      case 'pharma-purchase':
        rows = db.all(
          `SELECT invoice_no, invoice_date, stockiest_name, mfg_name, drug_name, batch_no,
            hsn_code, batch_qty, free_qty, mrp, rate, discount_amount,
            purchase_value, net_purchase_value, tax_amount, profit_pct
           FROM pharmacy_purchase_actuals WHERE invoice_date >= ? AND invoice_date <= ?${bf.where}
           ORDER BY invoice_date, invoice_no`,
          from, to, ...bf.params
        );
        break;

      case 'pharma-stock':
        rows = db.all(
          `SELECT drug_name, batch_no, received_date, expiry_date, avl_qty, strips,
            purchase_price, stock_value, snapshot_date
           FROM pharmacy_stock_actuals${bf.where ? ' WHERE 1=1' + bf.where : ''}
           ORDER BY stock_value DESC`,
          ...bf.params
        );
        break;

      default:
        return res.status(400).json({ error: 'Invalid source' });
    }

    res.json({ rows, count: rows.length });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
