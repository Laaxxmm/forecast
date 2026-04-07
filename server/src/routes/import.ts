import { Router } from 'express';
import { upload } from '../middleware/upload.js';
import { parseHealthplix } from '../services/parsers/healthplix.js';
import { parseOneglanceSales } from '../services/parsers/oneglance-sales.js';
import { parseOneglancePurchase } from '../services/parsers/oneglance-purchase.js';
import fs from 'fs';

const router = Router();

router.post('/healthplix', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const db = req.tenantDb!;
    const { rows, summary } = parseHealthplix(req.file.path);

    const importLog = db.run(
      `INSERT INTO import_logs (source, filename, rows_imported, date_range_start, date_range_end, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      'HEALTHPLIX', req.file.originalname, rows.length,
      summary.dateRange?.start || null, summary.dateRange?.end || null, 'completed'
    );

    for (const r of rows) {
      db.run(
        `INSERT INTO clinic_actuals (import_id, bill_date, bill_month, patient_id, patient_name, order_number,
          billed, paid, discount, tax, refund, due, addl_disc, item_price, item_disc,
          department, service_name, billed_doctor, service_owner)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        importLog.lastInsertRowid, r.bill_date, r.bill_month, r.patient_id, r.patient_name,
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
    const activeScenario = db.get(
      `SELECT s.id FROM scenarios s
       JOIN financial_years fy ON s.fy_id = fy.id
       WHERE fy.is_active = 1 AND s.is_default = 1 LIMIT 1`
    );
    if (activeScenario) {
      const clinicMonthly = db.all(
        `SELECT bill_month as month, COALESCE(SUM(item_price), 0) as total
         FROM clinic_actuals WHERE bill_month IS NOT NULL AND bill_month != '' GROUP BY bill_month`
      );
      for (const row of clinicMonthly) {
        if (!row.month) continue;
        db.run(
          `INSERT INTO dashboard_actuals (scenario_id, category, item_name, month, amount, updated_at)
           VALUES (?, 'revenue', 'Clinic Revenue', ?, ?, datetime('now'))
           ON CONFLICT(scenario_id, category, item_name, month)
           DO UPDATE SET amount = excluded.amount, updated_at = datetime('now')`,
          activeScenario.id, row.month, row.total
        );
      }
    }

    fs.unlinkSync(req.file.path);
    res.json({ importId: importLog.lastInsertRowid, ...summary });
  } catch (err: any) {
    if (req.file?.path) try { fs.unlinkSync(req.file.path); } catch {}
    res.status(400).json({ error: err.message });
  }
});

router.post('/oneglance-sales', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const db = req.tenantDb!;
    const { rows, summary } = parseOneglanceSales(req.file.path);

    const importLog = db.run(
      `INSERT INTO import_logs (source, filename, rows_imported, date_range_start, date_range_end, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      'ONEGLANCE_SALES', req.file.originalname, rows.length,
      summary.dateRange?.start || null, summary.dateRange?.end || null, 'completed'
    );

    for (const r of rows) {
      db.run(
        `INSERT INTO pharmacy_sales_actuals (import_id, bill_no, bill_date, bill_month, drug_name,
          batch_no, hsn_code, tax_pct, patient_id, patient_name, referred_by,
          qty, sales_amount, purchase_amount, purchase_tax, sales_tax, profit)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        importLog.lastInsertRowid, r.bill_no, r.bill_date, r.bill_month, r.drug_name,
        r.batch_no, r.hsn_code, r.tax_pct, r.patient_id, r.patient_name, r.referred_by,
        r.qty, r.sales_amount, r.purchase_amount, r.purchase_tax, r.sales_tax, r.profit
      );
    }

    fs.unlinkSync(req.file.path);
    res.json({ importId: importLog.lastInsertRowid, ...summary });
  } catch (err: any) {
    if (req.file?.path) try { fs.unlinkSync(req.file.path); } catch {}
    res.status(400).json({ error: err.message });
  }
});

router.post('/oneglance-purchase', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const db = req.tenantDb!;
    const { rows, summary } = parseOneglancePurchase(req.file.path);

    const importLog = db.run(
      `INSERT INTO import_logs (source, filename, rows_imported, date_range_start, date_range_end, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      'ONEGLANCE_PURCHASE', req.file.originalname, rows.length,
      summary.dateRange?.start || null, summary.dateRange?.end || null, 'completed'
    );

    for (const r of rows) {
      db.run(
        `INSERT INTO pharmacy_purchase_actuals (import_id, invoice_no, invoice_date, invoice_month,
          stockiest_name, mfg_name, drug_name, batch_no, hsn_code, batch_qty, free_qty,
          mrp, rate, discount_amount, net_purchase_value, net_sales_value, tax_pct, tax_amount,
          purchase_qty, purchase_value, sales_value, profit, profit_pct)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        importLog.lastInsertRowid, r.invoice_no, r.invoice_date, r.invoice_month,
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
    res.status(400).json({ error: err.message });
  }
});

router.get('/history', async (_req, res) => {
  const db = _req.tenantDb!;
  res.json(db.all('SELECT * FROM import_logs ORDER BY created_at DESC'));
});

router.delete('/:id', async (req, res) => {
  const db = req.tenantDb!;
  db.run('DELETE FROM clinic_actuals WHERE import_id = ?', req.params.id);
  db.run('DELETE FROM pharmacy_sales_actuals WHERE import_id = ?', req.params.id);
  db.run('DELETE FROM pharmacy_purchase_actuals WHERE import_id = ?', req.params.id);
  db.run('DELETE FROM import_logs WHERE id = ?', req.params.id);
  res.json({ ok: true });
});

export default router;
