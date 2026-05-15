import { Router } from 'express';
import { upload } from '../middleware/upload.js';
import { requireRole, requireIntegration } from '../middleware/auth.js';
import { parseHealthplix } from '../services/parsers/healthplix.js';
import { parseOneglanceSales } from '../services/parsers/oneglance-sales.js';
import { parseOneglancePurchase } from '../services/parsers/oneglance-purchase.js';
import { parseOneglanceStock } from '../services/parsers/oneglance-stock.js';
import { parseOneglanceTransfer } from '../services/parsers/oneglance-transfer.js';
import { parseTuriaInvoices } from '../services/parsers/turia.js';
import { parsePetpooja } from '../services/parsers/petpooja.js';
import { getBranchIdForInsert, branchFilter, getStreamIdForInsert } from '../utils/branch.js';
import { findActiveScenarioForStream } from '../utils/scenarios.js';
import { getPlatformHelper } from '../db/platform-connection.js';
import { recomputeBranchCogs, getBranchRole } from '../services/pharmacy/cogs.js';
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

/** For restaurant tenants: a Petpooja CSV contains all four channels mixed
 *  together. The dashboard rollup needs to write a separate row per channel
 *  to that channel's stream-scoped scenario, so we resolve every restaurant
 *  stream upfront and key it by canonical channel name (matching the values
 *  produced by canonicalChannel() in parsers/petpooja.ts).
 *  Returns Map<canonicalChannel, streamId>. Empty map if the tenant has no
 *  restaurant streams (defensive — middleware should already prevent that). */
async function resolveRestaurantStreamsByChannel(req: any): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    const platformDb = await getPlatformHelper();
    const streams = platformDb.all(
      'SELECT id, name FROM business_streams WHERE client_id = ? AND is_active = 1 ORDER BY sort_order',
      req.clientId
    );
    for (const s of streams) {
      const n = (s.name || '').toLowerCase();
      if      (n.includes('dine'))     map.set('Dine-in',  s.id);
      else if (n.includes('takeaway')) map.set('Takeaway', s.id);
      else if (n.includes('delivery')) map.set('Delivery', s.id);
      else if (n.includes('catering')) map.set('Catering', s.id);
    }
  } catch { /* platform DB may not be available */ }
  return map;
}

const router = Router();

router.post('/healthplix', requireRole('admin', 'operational_head'), requireIntegration('healthplix'), upload.single('file'), async (req, res) => {
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

    // Auto-add doctors. Stamp branch_id so the doctor is scoped to the
    // branch this import belongs to (Revenue Sharing visibility relies on it).
    // For multi-branch tenants only — single-branch returns NULL via
    // getBranchIdForInsert. Existing rows (UNIQUE on name) are left untouched
    // by INSERT OR IGNORE; their branch is set by the schema.ts backfill.
    const doctors = [...new Set(rows.map(r => r.billed_doctor).filter(d => d && d !== '-'))];
    for (const d of doctors) {
      db.run('INSERT OR IGNORE INTO doctors (name, branch_id) VALUES (?, ?)', d, branchId);
    }

    // Auto-sync clinic revenue to dashboard_actuals for active scenario.
    // Use the canonical helper so we write to the SAME scenario the
    // dashboard's read path picks (is_default=1 + branch-filtered).
    // Strict: don't re-aggregate NULL-branch legacy rows under the
    // active branch — that's a migration decision, not an import effect.
    const bf = branchFilter(req, { strict: true });
    const clinicStreamId = await resolveStreamId(req, 'clinic');
    const activeScenario = findActiveScenarioForStream(db, req, clinicStreamId);
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
           ON CONFLICT(scenario_id, category, item_name, month, COALESCE(branch_id, 0))
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

router.post('/oneglance-sales', requireRole('admin', 'operational_head'), requireIntegration('oneglance'), upload.single('file'), async (req, res) => {
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

    // Auto-sync pharmacy sales revenue to dashboard_actuals for active scenario.
    // Use the canonical helper — see clinic auto-sync above for context.
    // Strict: NULL-branch legacy rows are excluded from the rebuild.
    const bf = branchFilter(req, { strict: true });
    const pharmaStreamId = await resolveStreamId(req, 'pharmacy');
    const activeScenario = findActiveScenarioForStream(db, req, pharmaStreamId);
    if (activeScenario) {
      db.run(
        `DELETE FROM dashboard_actuals WHERE scenario_id = ? AND category = 'revenue' AND item_name = 'Pharmacy Revenue'${bf.where}`,
        activeScenario.id, ...bf.params
      );
      const pharmaMonthly = db.all(
        // Roll up ex-GST so dashboard_actuals matches the P&L semantic
        // (sales_amount is gross-incl-GST in pharmacy_sales_actuals).
        `SELECT bill_month as month,
                COALESCE(SUM(sales_amount - COALESCE(sales_tax, 0)), 0) as total
         FROM pharmacy_sales_actuals WHERE bill_month IS NOT NULL AND bill_month != ''${bf.where} GROUP BY bill_month`,
        ...bf.params
      );
      for (const row of pharmaMonthly) {
        if (!row.month) continue;
        db.run(
          `INSERT INTO dashboard_actuals (scenario_id, category, item_name, month, amount, branch_id, stream_id, updated_at)
           VALUES (?, 'revenue', 'Pharmacy Revenue', ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(scenario_id, category, item_name, month, COALESCE(branch_id, 0))
           DO UPDATE SET amount = excluded.amount, stream_id = excluded.stream_id, updated_at = datetime('now')`,
          activeScenario.id, row.month, row.total, branchId, pharmaStreamId
        );
      }
    }

    // Refresh per-branch COGS aggregate. Standalone branches use SUM(purchase_amount);
    // satellites need it because their COGS comes from incoming transfers.
    try {
      const monthsTouched = [...new Set(rows.map(r => r.bill_month).filter(Boolean))];
      await recomputeBranchCogs(db, branchId, monthsTouched);
    } catch (e: any) {
      console.warn('[import/oneglance-sales] COGS recompute skipped:', e?.message);
    }

    res.json({ importId, ...summary });
  } catch (err: any) {
    if (req.file?.path) try { fs.unlinkSync(req.file.path); } catch {}
    res.status(400).json({ error: isProd ? 'Import failed' : err.message });
  }
});

router.post('/oneglance-purchase', requireRole('admin', 'operational_head'), requireIntegration('oneglance'), upload.single('file'), async (req, res) => {
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

    // Refresh per-branch COGS aggregate. For standalone branches purchases
    // don't directly drive COGS (sales rows already carry purchase_amount),
    // but recomputing keeps the cache consistent if the caller uploads
    // purchases before sales for the same period.
    try {
      const monthsTouched = [...new Set(rows.map(r => r.invoice_month).filter(Boolean))];
      await recomputeBranchCogs(db, branchId, monthsTouched);
    } catch (e: any) {
      console.warn('[import/oneglance-purchase] COGS recompute skipped:', e?.message);
    }

    res.json({ importId, ...summary });
  } catch (err: any) {
    if (req.file?.path) try { fs.unlinkSync(req.file.path); } catch {}
    res.status(400).json({ error: isProd ? 'Import failed' : err.message });
  }
});

// ── Stock Transfer (OneGlance Stock Transfer Details) ─────────────────────
// Hyderabad-only flow: the central_store branch transfers stock OUT to its
// satellite branches. Each branch downloads its own report; the "Center Name"
// column in each row identifies the counterparty by name. We resolve that to
// the source/destination branch_id depending on which side uploaded.
router.post('/oneglance-transfer', requireRole('admin', 'operational_head'), requireIntegration('oneglance'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const db = req.tenantDb!;
    const branchId = getBranchIdForInsert(req);
    if (!branchId) {
      return res.status(400).json({ error: 'Stock transfers require a specific branch context. Switch to a branch and try again.' });
    }
    const role = await getBranchRole(branchId);
    if (role === 'standalone') {
      return res.status(400).json({ error: 'This branch is not configured for inter-branch transfers. Set its role to satellite (or central_store) in Admin → Branches first.' });
    }

    const platformDb = await getPlatformHelper();
    const branchRow = platformDb.get('SELECT id, parent_branch_id FROM branches WHERE id = ?', branchId);
    const parentBranchId: number | null = branchRow?.parent_branch_id || null;

    const { rows: parsedRows, summary } = parseOneglanceTransfer(req.file.path);

    // Build a name → branch_id index for counterparty resolution. Match on a
    // normalized form (uppercase, trim, strip the "MAGNACODE - " org prefix
    // commonly seen in OneGlance "Center Name" strings).
    const allBranches = platformDb.all(
      'SELECT id, name, code FROM branches WHERE client_id = ?',
      req.clientId,
    );
    const norm = (s: string) => String(s || '').toUpperCase().replace(/MAGNACODE\s*-\s*/i, '').trim();
    const nameIndex = new Map<string, number>();
    for (const b of allBranches) {
      if (b.name) nameIndex.set(norm(b.name), b.id);
      if (b.code) nameIndex.set(norm(b.code), b.id);
    }

    // For satellite uploads, fall back to the configured parent_branch_id when
    // the counterparty string can't be matched (the most common case for
    // Hyderabad files where "Center Name" = the central store).
    const resolveCounterparty = (raw: string | null): number | null => {
      if (!raw) return parentBranchId;
      const hit = nameIndex.get(norm(raw));
      if (hit) return hit;
      return parentBranchId;
    };

    const insertRows = parsedRows.map(r => {
      const counterpartyId = resolveCounterparty(r.counterparty_raw);
      const branchFrom = role === 'central_store' ? branchId : (counterpartyId || parentBranchId || branchId);
      const branchTo = role === 'central_store' ? (counterpartyId || branchId) : branchId;
      return { ...r, branch_from_id: branchFrom, branch_to_id: branchTo };
    });

    // Dedup by (branch_to_id, invoice_date) so re-uploads cleanly replace
    // the previous data window. Mirrors the sales/purchase dedup pattern.
    const datesByDest = new Map<number, Set<string>>();
    for (const r of insertRows) {
      if (!r.invoice_date) continue;
      if (!datesByDest.has(r.branch_to_id)) datesByDest.set(r.branch_to_id, new Set());
      datesByDest.get(r.branch_to_id)!.add(r.invoice_date);
    }
    for (const [destId, dateSet] of datesByDest) {
      const dates = [...dateSet];
      const ph = dates.map(() => '?').join(',');
      db.run(
        `DELETE FROM pharmacy_stock_transfers WHERE branch_to_id = ? AND invoice_date IN (${ph})`,
        destId, ...dates,
      );
    }

    db.run(
      `INSERT INTO import_logs (source, filename, rows_imported, date_range_start, date_range_end, status, branch_id, file_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      'ONEGLANCE_TRANSFER', req.file.originalname, insertRows.length,
      summary.dateRange?.start || null, summary.dateRange?.end || null, 'completed', branchId, req.file.path,
    );
    const importId = db.get("SELECT id FROM import_logs WHERE source = 'ONEGLANCE_TRANSFER' ORDER BY id DESC LIMIT 1")?.id || 0;

    db.beginBatch();
    try {
      for (const r of insertRows) {
        db.run(
          `INSERT INTO pharmacy_stock_transfers (
            import_id, branch_from_id, branch_to_id,
            invoice_no, invoice_date, invoice_month, indent_no, indent_date,
            drug_name, drug_name_normalized, batch_no,
            qty, rate, mrp,
            gst_5, cgst_5, sgst_5, gst_12, cgst_12, sgst_12,
            gst_18, cgst_18, sgst_18, gst_28, cgst_28, sgst_28,
            gst_other, cgst_other, sgst_other,
            gst_total, cgst_total, sgst_total,
            total_value, purchase_value, purchase_price, counterparty_raw
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          importId, r.branch_from_id, r.branch_to_id,
          r.invoice_no, r.invoice_date, r.invoice_month, r.indent_no, r.indent_date,
          r.drug_name, r.drug_name_normalized, r.batch_no,
          r.qty, r.rate, r.mrp,
          r.gst_5, r.cgst_5, r.sgst_5, r.gst_12, r.cgst_12, r.sgst_12,
          r.gst_18, r.cgst_18, r.sgst_18, r.gst_28, r.cgst_28, r.sgst_28,
          r.gst_other, r.cgst_other, r.sgst_other,
          r.gst_total, r.cgst_total, r.sgst_total,
          r.total_value, r.purchase_value, r.purchase_price, r.counterparty_raw,
        );
      }
      db.endBatch();
    } catch (e) { db.rollbackBatch(); throw e; }

    // Refresh COGS for every destination branch touched by this upload —
    // these are the satellites whose retail COGS is driven by the transfers
    // we just wrote.
    const monthsTouched = [...new Set(insertRows.map(r => r.invoice_month).filter(Boolean))];
    const destBranchIds = [...new Set(insertRows.map(r => r.branch_to_id))];
    for (const destId of destBranchIds) {
      try {
        await recomputeBranchCogs(db, destId, monthsTouched);
      } catch (e: any) {
        console.warn(`[import/oneglance-transfer] COGS recompute for branch ${destId} skipped:`, e?.message);
      }
    }

    res.json({ importId, ...summary });
  } catch (err: any) {
    if (req.file?.path) try { fs.unlinkSync(req.file.path); } catch {}
    res.status(400).json({ error: isProd ? 'Import failed' : err.message });
  }
});

router.post('/oneglance-stock', requireRole('admin', 'operational_head'), requireIntegration('oneglance'), upload.single('file'), async (req, res) => {
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

router.post('/turia', requireRole('admin', 'operational_head'), requireIntegration('turia'), upload.single('file'), async (req, res) => {
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

    // Auto-sync consultancy revenue to dashboard_actuals — canonical scenario helper.
    // Strict: NULL-branch legacy rows excluded from the rebuild.
    const bf = branchFilter(req, { strict: true });
    const consultStreamId = await resolveStreamId(req, 'consultancy');
    const activeScenario = findActiveScenarioForStream(db, req, consultStreamId);
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
           ON CONFLICT(scenario_id, category, item_name, month, COALESCE(branch_id, 0))
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

// ── Restaurant (Petpooja) ────────────────────────────────────────────────────
// A single Petpooja "Item Report With Customer/Order Details" export contains
// every channel (Dine-in / Delivery / Takeaway / Catering) mixed together. We
// insert all rows into restaurant_sales_actuals with order_channel populated
// (canonicalized at parse time) and then write a separate rollup row to each
// channel's stream-scoped scenario so the four restaurant streams each show
// their own revenue and target on the dashboard.
router.post('/petpooja-sales', requireRole('admin', 'operational_head'), requireIntegration('petpooja'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const db = req.tenantDb!;
    const branchId = getBranchIdForInsert(req);
    const { rows, summary } = parsePetpooja(req.file.path);

    // Dedup: delete existing restaurant rows for this branch on the dates
    // being re-imported. branch_id scope is MANDATORY — re-importing one
    // branch's CSV must never wipe another branch's rows on the same dates.
    const restDates = [...new Set(rows.map(r => r.bill_date).filter(Boolean))];
    if (restDates.length > 0) {
      const ph = restDates.map(() => '?').join(',');
      db.run(
        `DELETE FROM restaurant_sales_actuals WHERE branch_id IS ? AND bill_date IN (${ph})`,
        branchId, ...restDates
      );
    }

    db.run(
      `INSERT INTO import_logs (source, filename, rows_imported, date_range_start, date_range_end, status, branch_id, file_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      'PETPOOJA', req.file.originalname, rows.length,
      summary.dateRange?.start || null, summary.dateRange?.end || null, 'completed', branchId, req.file.path
    );
    const importId = db.get("SELECT id FROM import_logs WHERE source = 'PETPOOJA' ORDER BY id DESC LIMIT 1")?.id || 0;

    db.beginBatch();
    try {
      for (const r of rows) {
        db.run(
          `INSERT INTO restaurant_sales_actuals (import_id, branch_id, bill_no, bill_date, bill_month, bill_time,
             order_channel, payment_type, table_no, server_name, covers,
             item_name, item_category, group_name, qty, price,
             gross_amount, discount, tax, final_total, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          importId, branchId, r.bill_no, r.bill_date, r.bill_month, r.bill_time,
          r.order_channel, r.payment_type, r.table_no, r.server_name, r.covers,
          r.item_name, r.item_category, r.group_name, r.qty, r.price,
          r.gross_amount, r.discount, r.tax, r.final_total, r.status
        );
      }
      db.endBatch();
    } catch (e) { db.rollbackBatch(); throw e; }

    // Per-channel auto-sync to dashboard_actuals. Each restaurant stream has
    // its OWN active scenario, so we loop the four channels and write a
    // separate rollup row keyed to each stream's scenario. This matches the
    // clinic + pharma pattern (one rollup per stream) but multiplied by the
    // four channels that share the single Petpooja import.
    const bf = branchFilter(req, { strict: true });
    const channelStreams = await resolveRestaurantStreamsByChannel(req);
    for (const [channel, streamId] of channelStreams.entries()) {
      const activeScenario = findActiveScenarioForStream(db, req, streamId);
      if (!activeScenario) continue; // no scenario yet (FY not set up) — skip silently

      // Wipe the channel's existing rollup before re-inserting. Scoped to
      // the caller's branch via bf so multi-branch tenants don't lose
      // sibling-branch rows during a per-branch re-import.
      db.run(
        `DELETE FROM dashboard_actuals WHERE scenario_id = ? AND category = 'revenue' AND item_name = 'Restaurant Revenue'${bf.where}`,
        activeScenario.id, ...bf.params
      );

      // Net revenue (ex-tax) = gross_amount - discount. Voids/cancellations
      // are filtered defensively — Petpooja today exports only Success rows
      // but the WHERE survives future export-format changes.
      const monthly = db.all(
        `SELECT bill_month as month,
                COALESCE(SUM(gross_amount - COALESCE(discount, 0)), 0) as total
         FROM restaurant_sales_actuals
         WHERE order_channel = ?
           AND (status IS NULL OR status = 'Success')
           AND bill_month IS NOT NULL AND bill_month != ''${bf.where}
         GROUP BY bill_month`,
        channel, ...bf.params
      );
      for (const row of monthly) {
        if (!row.month) continue;
        db.run(
          `INSERT INTO dashboard_actuals (scenario_id, category, item_name, month, amount, branch_id, stream_id, updated_at)
           VALUES (?, 'revenue', 'Restaurant Revenue', ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(scenario_id, category, item_name, month, COALESCE(branch_id, 0))
           DO UPDATE SET amount = excluded.amount, stream_id = excluded.stream_id, updated_at = datetime('now')`,
          activeScenario.id, row.month, row.total, branchId, streamId
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
  // Strict: branch users see only their branch's import logs. NULL-branch
  // legacy logs from the pre-multi-branch era stay hidden until reassigned.
  const bf = branchFilter(req, { strict: true });
  res.json(db.all(`SELECT * FROM import_logs WHERE 1=1${bf.where} ORDER BY created_at DESC`, ...bf.params));
});

router.delete('/:id', requireRole('admin', 'operational_head'), async (req, res) => {
  const db = req.tenantDb!;
  // Strict: rebuild only the caller's branch rows. NULL-branch legacy
  // rows are not re-absorbed during the post-delete re-sync.
  const bf = branchFilter(req, { strict: true });

  // Delete source rows for this import
  db.run('DELETE FROM clinic_actuals WHERE import_id = ?', req.params.id);
  db.run('DELETE FROM pharmacy_sales_actuals WHERE import_id = ?', req.params.id);
  db.run('DELETE FROM pharmacy_purchase_actuals WHERE import_id = ?', req.params.id);
  db.run('DELETE FROM pharmacy_stock_actuals WHERE import_id = ?', req.params.id);
  db.run('DELETE FROM pharmacy_stock_transfers WHERE import_id = ?', req.params.id);
  db.run('DELETE FROM turia_invoices WHERE import_id = ?', req.params.id);
  db.run('DELETE FROM restaurant_sales_actuals WHERE import_id = ?', req.params.id);
  db.run('DELETE FROM import_logs WHERE id = ?', req.params.id);

  // Refresh COGS aggregate for the caller's branch — sales/transfer rows
  // that this import wrote are now gone.
  try {
    const branchIdForCogs = getBranchIdForInsert(req);
    await recomputeBranchCogs(db, branchIdForCogs);
  } catch (e: any) {
    console.warn('[import/delete] COGS recompute skipped:', e?.message);
  }

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

    // Re-sync Pharmacy Revenue from remaining data — ex-GST so the
    // rollup matches the P&L semantic shown on the dashboard.
    const pharmaStreamId = await resolveStreamId(req, 'pharmacy');
    const pharmaMonthly = db.all(
      `SELECT bill_month as month,
              COALESCE(SUM(sales_amount - COALESCE(sales_tax, 0)), 0) as total
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

    // Re-sync Restaurant Revenue per-channel from remaining data. Each
    // channel has its own stream-scoped scenario, so the wipe above
    // (scoped to the caller's active scenario) only cleared one channel's
    // rollup; we must look up each channel's scenario explicitly.
    const channelStreams = await resolveRestaurantStreamsByChannel(req);
    for (const [channel, streamId] of channelStreams.entries()) {
      const channelScenario = findActiveScenarioForStream(db, req, streamId);
      if (!channelScenario) continue;
      // Wipe this channel's existing rollup (could differ from activeScenario above).
      db.run(
        `DELETE FROM dashboard_actuals WHERE scenario_id = ? AND category = 'revenue' AND item_name = 'Restaurant Revenue'${bf.where}`,
        channelScenario.id, ...bf.params
      );
      const restMonthly = db.all(
        `SELECT bill_month as month,
                COALESCE(SUM(gross_amount - COALESCE(discount, 0)), 0) as total
         FROM restaurant_sales_actuals
         WHERE order_channel = ?
           AND (status IS NULL OR status = 'Success')
           AND bill_month IS NOT NULL AND bill_month != ''${bf.where}
         GROUP BY bill_month`,
        channel, ...bf.params
      );
      for (const row of restMonthly) {
        if (!row.month) continue;
        db.run(
          `INSERT INTO dashboard_actuals (scenario_id, category, item_name, month, amount, branch_id, stream_id, updated_at)
           VALUES (?, 'revenue', 'Restaurant Revenue', ?, ?, ?, ?, datetime('now'))`,
          channelScenario.id, row.month, row.total, branchId, streamId
        );
      }
    }
  }

  res.json({ ok: true });
});

router.get('/sync-tracker', async (req, res) => {
  const db = req.tenantDb!;
  // Strict: each branch's tracker reflects only its own coverage.
  const bf = branchFilter(req, { strict: true });
  const now = new Date();
  const monthParam = (req.query.month as string) || now.toISOString().slice(0, 7);
  const [yr, mo] = monthParam.split('-').map(Number);
  const daysInMonth = new Date(yr, mo, 0).getDate();
  const firstDay = `${monthParam}-01`;
  const lastDay = `${monthParam}-${String(daysInMonth).padStart(2, '0')}`;
  const todayStr = now.toISOString().slice(0, 10);

  // Resolve the current branch's role so we only track the data sources
  // that actually apply. Without this, satellites flag every day as
  // "missing Pharma Purchase" (which they should never have) and central
  // stores flag every day as "missing Pharma Sales / Stock". Standalone
  // branches see today's full set.
  const platformDb = await getPlatformHelper();
  const branchRow = req.branchId ? platformDb.get(
    'SELECT branch_role FROM branches WHERE id = ?',
    req.branchId,
  ) : null;
  const role: 'standalone' | 'central_store' | 'satellite' =
    branchRow?.branch_role === 'central_store' || branchRow?.branch_role === 'satellite'
      ? branchRow.branch_role
      : 'standalone';

  // Build the expected-source set per role. The frontend uses this to
  // decide which rows / dots to render. Order matters — it controls the
  // visual order of the legend and summary panels.
  const tracksClinic = role !== 'central_store';
  const tracksSales = role !== 'central_store';
  const tracksPurchase = role !== 'satellite';
  const tracksStock = role !== 'central_store';
  const tracksTransfer = role !== 'standalone';

  // Q1–Q3: daily data coverage (only fetch for sources we track)
  const clinicDays = tracksClinic ? db.all(
    `SELECT bill_date as date, COUNT(*) as row_count, COALESCE(SUM(item_price),0) as revenue
     FROM clinic_actuals WHERE bill_date >= ? AND bill_date <= ?${bf.where} GROUP BY bill_date`,
    firstDay, lastDay, ...bf.params
  ) : [];
  const salesDays = tracksSales ? db.all(
    `SELECT bill_date as date, COUNT(*) as row_count, COALESCE(SUM(sales_amount),0) as revenue
     FROM pharmacy_sales_actuals WHERE bill_date >= ? AND bill_date <= ?${bf.where} GROUP BY bill_date`,
    firstDay, lastDay, ...bf.params
  ) : [];
  const purchaseDays = tracksPurchase ? db.all(
    `SELECT invoice_date as date, COUNT(*) as row_count, COALESCE(SUM(purchase_value),0) as total
     FROM pharmacy_purchase_actuals WHERE invoice_date >= ? AND invoice_date <= ?${bf.where} GROUP BY invoice_date`,
    firstDay, lastDay, ...bf.params
  ) : [];
  // Transfers don't have a strict daily-coverage expectation (they happen
  // when stock moves, not on a schedule), but we still surface "any
  // transfers this period?" + the latest sync time. Filter scope follows
  // branchTo for satellites and branchFrom for central stores.
  const transferDays = tracksTransfer && req.branchId ? db.all(
    role === 'satellite'
      ? `SELECT invoice_date as date, COUNT(*) as row_count, COALESCE(SUM(total_value),0) as total
           FROM pharmacy_stock_transfers
          WHERE invoice_date >= ? AND invoice_date <= ? AND branch_to_id = ?
          GROUP BY invoice_date`
      : `SELECT invoice_date as date, COUNT(*) as row_count, COALESCE(SUM(total_value),0) as total
           FROM pharmacy_stock_transfers
          WHERE invoice_date >= ? AND invoice_date <= ? AND branch_from_id = ?
          GROUP BY invoice_date`,
    firstDay, lastDay, req.branchId,
  ) : [];

  // Q4: last sync timestamps
  const syncRows = db.all(
    `SELECT source, MAX(created_at) as last_sync_at FROM import_logs
     WHERE source IN ('HEALTHPLIX','HEALTHPLIX_SYNC','ONEGLANCE_SALES','ONEGLANCE_SALES_SYNC',
       'ONEGLANCE_PURCHASE','ONEGLANCE_PURCHASE_SYNC','ONEGLANCE_STOCK','ONEGLANCE_STOCK_SYNC',
       'ONEGLANCE_TRANSFER','ONEGLANCE_TRANSFER_SYNC','TURIA','TURIA_SYNC')
       AND status = 'completed'${bf.where} GROUP BY source`,
    ...bf.params
  );

  // Q5: latest stock snapshot
  const stockRow = tracksStock ? db.get(
    `SELECT MAX(snapshot_date) as latest FROM pharmacy_stock_actuals WHERE 1=1${bf.where}`,
    ...bf.params
  ) : null;

  // Build lookup maps
  const clinicMap: Record<string, any> = {};
  for (const r of clinicDays) if (r.date) clinicMap[r.date] = { has: true, rows: r.row_count, rev: r.revenue };
  const salesMap: Record<string, any> = {};
  for (const r of salesDays) if (r.date) salesMap[r.date] = { has: true, rows: r.row_count, rev: r.revenue };
  const purchaseMap: Record<string, any> = {};
  for (const r of purchaseDays) if (r.date) purchaseMap[r.date] = { has: true, rows: r.row_count, total: r.total };
  const transferMap: Record<string, any> = {};
  for (const r of transferDays) if (r.date) transferMap[r.date] = { has: true, rows: r.row_count, total: r.total };

  // Sync timestamps — merge HP/HP_SYNC etc. into single per-integration latest
  const syncMap: Record<string, string> = {};
  for (const r of syncRows) {
    const key = r.source.replace('_SYNC', '');
    if (!syncMap[key] || r.last_sync_at > syncMap[key]) syncMap[key] = r.last_sync_at;
  }

  // Build per-day response + compute gaps. Only count expectations for
  // sources this branch actually tracks — that's what makes the "Pharma
  // Purchase missing every day" noise on satellites go away.
  const days: Record<string, any> = {};
  const gaps: Record<string, string[]> = { clinic: [], sales: [], purchase: [], transfer: [] };
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
      transfer: transferMap[dateStr] || { has: false, rows: 0, total: 0 },
    };

    if (isPast) {
      // Clinic: skip Sundays. Only track if applicable to this role.
      if (tracksClinic && dow !== 0) {
        clinicExpected++;
        if (clinicMap[dateStr]) clinicCovered++;
        else gaps.clinic.push(dateStr);
      }
      if (tracksSales) {
        salesExpected++;
        if (salesMap[dateStr]) salesCovered++;
        else gaps.sales.push(dateStr);
      }
      if (tracksPurchase) {
        purchaseExpected++;
        if (purchaseMap[dateStr]) purchaseCovered++;
        else gaps.purchase.push(dateStr);
      }
      // Transfers don't have a daily expectation — we don't push to
      // gaps.transfer for missing days, only track the dates that have
      // activity (the UI uses presence/latest sync, not coverage %).
    }
  }

  res.json({
    month: monthParam,
    today: todayStr,
    role,
    tracks: {
      clinic: tracksClinic, sales: tracksSales, purchase: tracksPurchase,
      stock: tracksStock, transfer: tracksTransfer,
    },
    days,
    summary: {
      clinic: tracksClinic ? { covered: clinicCovered, expected: clinicExpected, pct: clinicExpected ? Math.round(clinicCovered / clinicExpected * 1000) / 10 : 100, lastSync: syncMap['HEALTHPLIX'] || null } : null,
      sales: tracksSales ? { covered: salesCovered, expected: salesExpected, pct: salesExpected ? Math.round(salesCovered / salesExpected * 1000) / 10 : 100, lastSync: syncMap['ONEGLANCE_SALES'] || null } : null,
      purchase: tracksPurchase ? { covered: purchaseCovered, expected: purchaseExpected, pct: purchaseExpected ? Math.round(purchaseCovered / purchaseExpected * 1000) / 10 : 100, lastSync: syncMap['ONEGLANCE_PURCHASE'] || null } : null,
      stock: tracksStock ? { latestSnapshot: stockRow?.latest || null, lastSync: syncMap['ONEGLANCE_STOCK'] || null } : null,
      transfer: tracksTransfer ? { lastSync: syncMap['ONEGLANCE_TRANSFER'] || null } : null,
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

  // Strict: branch users export only their branch's rows.
  const bf = branchFilter(req, { strict: true });

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
        // Computed columns:
        //   net_sales        = sales_amount - sales_tax (sales ex-GST)
        //   gross_profit     = net_sales - purchase_amount (true profit on goods)
        //   gross_margin_pct = gross_profit / net_sales (denominator is net sales)
        // The source-system 'profit' column is renamed `reported_profit` in the
        // export and kept only for sanity check (reported - gross = sales_tax).
        rows = db.all(
          `SELECT bill_no, bill_date, patient_name, drug_name, batch_no, hsn_code,
            qty,
            sales_amount,
            (sales_amount - COALESCE(sales_tax, 0)) AS net_sales,
            COALESCE(sales_tax, 0) AS sales_tax,
            COALESCE(purchase_amount, 0) AS purchase_amount,
            (sales_amount - COALESCE(sales_tax, 0) - COALESCE(purchase_amount, 0)) AS gross_profit,
            CASE WHEN (sales_amount - COALESCE(sales_tax, 0)) > 0
              THEN ROUND((sales_amount - COALESCE(sales_tax, 0) - COALESCE(purchase_amount, 0)) * 100.0
                         / (sales_amount - COALESCE(sales_tax, 0)), 2)
              ELSE 0
            END AS gross_margin_pct,
            COALESCE(profit, 0) AS reported_profit,
            referred_by
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
    const isProd = process.env.NODE_ENV === 'production';
    res.status(500).json({ error: isProd ? 'Data retrieval failed' : e.message });
  }
});

export default router;
