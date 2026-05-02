// OneGlance sync runner. Single code path used by both the manual HTTP
// handler (routes/sync.ts) and the auto-sync scheduler.
//
// Extracted verbatim from POST /api/sync/oneglance — same parse, dedup,
// insert, and dashboard rollup behaviour for manual + scheduled runs.

import { decrypt } from '../../utils/crypto.js';
import { branchFilter, branchSettingsKey, type BranchContext } from '../../utils/branch.js';
import { findActiveScenarioForStream } from '../../utils/scenarios.js';
import { getClientHelper } from '../../db/connection.js';
import { getPlatformHelper } from '../../db/platform-connection.js';
import { parseOneglanceSales } from '../parsers/oneglance-sales.js';
import { parseOneglancePurchase } from '../parsers/oneglance-purchase.js';
import { parseOneglanceStock } from '../parsers/oneglance-stock.js';

export type ProgressFn = (step: string, message: string, pct: number) => void;

export interface OneglanceRunOpts {
  tenantSlug: string;
  clientId: number;
  ctx: BranchContext;
  branchId: number | null;
  fromDate: string;
  toDate: string;
  reportType?: 'sales' | 'purchase' | 'stock' | 'both' | 'all';
  trigger: 'manual' | 'auto-schedule' | 'auto-catchup' | 'auto-test';
  onProgress?: ProgressFn;
}

export interface OneglanceRunResult {
  totalRows: number;
  importIds: { sales?: number; purchase?: number; stock?: number };
  /**
   * Partial-success: when the stock report failed (commonly a renderer
   * crash on huge-inventory branches) but sales+purchase succeeded, the
   * underlying `syncOneglance` returns the stock error here so callers
   * can surface it as a warning rather than treating the whole run as
   * failed. Empty/undefined when stock succeeded or wasn't requested.
   */
  stockError?: string;
}

export async function runOneglanceSync(opts: OneglanceRunOpts): Promise<OneglanceRunResult> {
  const { tenantSlug, clientId, ctx, branchId, fromDate, toDate, reportType, onProgress } = opts;
  const progress: ProgressFn = onProgress || (() => {});

  const db = await getClientHelper(tenantSlug);

  const usernameRow = db.get("SELECT value FROM app_settings WHERE key = ?", branchSettingsKey('oneglance_username', ctx));
  const passwordRow = db.get("SELECT value FROM app_settings WHERE key = ?", branchSettingsKey('oneglance_password', ctx));

  if (!usernameRow?.value || !passwordRow?.value) {
    throw new Error('Oneglance credentials not configured');
  }

  const username = usernameRow.value;
  const password = decrypt(passwordRow.value);

  const { syncOneglance } = await import('./oneglance-sync.js');

  const result = await syncOneglance({
    username,
    password,
    fromDate,
    toDate,
    reportType: reportType || 'both',
    onProgress: progress,
  });

  progress('parsing', 'Parsing downloaded reports...', 85);

  let totalRows = 0;
  const importIds: OneglanceRunResult['importIds'] = {};

  // Reject any rows with future months — OneGlance CSVs occasionally contain bad dates.
  const currentMonth = new Date().toISOString().slice(0, 7);

  // ── Sales ────────────────────────────────────────────────────────────
  if (result.salesFile) {
    progress('parsing', 'Parsing sales report...', 87);
    const { rows: allRows, summary } = parseOneglanceSales(result.salesFile.filePath);
    const rows = allRows.filter(r => !r.bill_month || r.bill_month <= currentMonth);
    console.log(`[oneglance-sync] Sales: ${allRows.length} total rows, ${rows.length} after filtering future months (dropped ${allRows.length - rows.length})`);

    const salesDatesToReplace = [...new Set(rows.map((r: any) => r.bill_date).filter(Boolean))];
    if (salesDatesToReplace.length > 0) {
      const ph = salesDatesToReplace.map(() => '?').join(',');
      db.run(
        `DELETE FROM pharmacy_sales_actuals WHERE branch_id IS ? AND bill_date IN (${ph})`,
        branchId, ...salesDatesToReplace
      );
      console.log(`[oneglance-sync] Cleared existing sales data for branch=${branchId}, dates=${salesDatesToReplace.length}`);
    }

    db.run(
      `INSERT INTO import_logs (source, filename, rows_imported, date_range_start, date_range_end, status, branch_id, file_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      'ONEGLANCE_SALES_SYNC', result.salesFile.filename, rows.length,
      summary.dateRange?.start || null, summary.dateRange?.end || null, 'completed', branchId, result.salesFile.filePath
    );
    const salesImportRow = db.get("SELECT id FROM import_logs WHERE source = 'ONEGLANCE_SALES_SYNC' ORDER BY id DESC LIMIT 1");
    const salesImportId = salesImportRow?.id || 0;
    importIds.sales = salesImportId;

    db.beginBatch();
    try {
      for (const r of rows) {
        db.run(
          `INSERT INTO pharmacy_sales_actuals (import_id, bill_no, bill_date, bill_month, drug_name, batch_no,
            hsn_code, tax_pct, patient_id, patient_name, referred_by, qty, sales_amount,
            purchase_amount, purchase_tax, sales_tax, profit, branch_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          salesImportId, r.bill_no, r.bill_date, r.bill_month, r.drug_name, r.batch_no,
          r.hsn_code, r.tax_pct, r.patient_id, r.patient_name, r.referred_by, r.qty,
          r.sales_amount, r.purchase_amount, r.purchase_tax, r.sales_tax, r.profit, branchId
        );
      }
      db.endBatch();
    } catch (e) { db.rollbackBatch(); throw e; }
    totalRows += rows.length;

    // Roll up Pharmacy Revenue + COGS to dashboard_actuals (branch-scoped).
    // Strict: NULL-branch legacy rows excluded from the rebuild.
    const bf = branchFilter(ctx, { strict: true });
    const platformDb = await getPlatformHelper();
    const pharmaStream = clientId ? platformDb.get(
      "SELECT id FROM business_streams WHERE client_id = ? AND LOWER(name) LIKE '%pharma%' AND is_active = 1 LIMIT 1",
      clientId
    ) : null;
    const pharmaStreamId = pharmaStream?.id || null;
    const activeScenario = findActiveScenarioForStream(db, ctx, pharmaStreamId);
    if (activeScenario) {
      db.run(
        `DELETE FROM dashboard_actuals WHERE scenario_id = ? AND category = 'revenue' AND item_name = 'Pharmacy Revenue'${bf.where}`,
        activeScenario.id, ...bf.params
      );
      db.run(
        `DELETE FROM dashboard_actuals WHERE scenario_id = ? AND category = 'direct_costs' AND item_name = 'Pharmacy COGS'${bf.where}`,
        activeScenario.id, ...bf.params
      );
      const pharmaMonthly = db.all(
        // Pharmacy revenue is rolled up ex-GST so the rollup matches the
        // P&L semantic shown on the Actuals / Insights pages.
        `SELECT bill_month as month,
                COALESCE(SUM(sales_amount - COALESCE(sales_tax, 0)), 0) as revenue,
                COALESCE(SUM(purchase_amount), 0) as cogs
         FROM pharmacy_sales_actuals
         WHERE bill_month IS NOT NULL AND bill_month != ''${bf.where}
         GROUP BY bill_month`,
        ...bf.params
      );
      for (const row of pharmaMonthly) {
        if (!row.month) continue;
        db.run(
          `INSERT INTO dashboard_actuals (scenario_id, category, item_name, month, amount, branch_id, stream_id, updated_at)
           VALUES (?, 'revenue', 'Pharmacy Revenue', ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(scenario_id, category, item_name, month, COALESCE(branch_id, 0))
           DO UPDATE SET amount = excluded.amount, stream_id = excluded.stream_id, updated_at = datetime('now')`,
          activeScenario.id, row.month, row.revenue, branchId, pharmaStreamId
        );
        db.run(
          `INSERT INTO dashboard_actuals (scenario_id, category, item_name, month, amount, branch_id, stream_id, updated_at)
           VALUES (?, 'direct_costs', 'Pharmacy COGS', ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(scenario_id, category, item_name, month, COALESCE(branch_id, 0))
           DO UPDATE SET amount = excluded.amount, stream_id = excluded.stream_id, updated_at = datetime('now')`,
          activeScenario.id, row.month, row.cogs, branchId, pharmaStreamId
        );
      }
    }
  }

  // ── Purchase ─────────────────────────────────────────────────────────
  if (result.purchaseFile) {
    progress('parsing', 'Parsing purchase report...', 92);
    const { rows: allPurchaseRows, summary } = parseOneglancePurchase(result.purchaseFile.filePath);
    const rows = allPurchaseRows.filter(r => !r.invoice_month || r.invoice_month <= currentMonth);
    console.log(`[oneglance-sync] Purchase: ${allPurchaseRows.length} total rows, ${rows.length} after filtering future months`);

    const purchaseDatesToReplace = [...new Set(rows.map((r: any) => r.invoice_date).filter(Boolean))];
    if (purchaseDatesToReplace.length > 0) {
      const ph = purchaseDatesToReplace.map(() => '?').join(',');
      db.run(
        `DELETE FROM pharmacy_purchase_actuals WHERE branch_id IS ? AND invoice_date IN (${ph})`,
        branchId, ...purchaseDatesToReplace
      );
      console.log(`[oneglance-sync] Cleared existing purchase data for branch=${branchId}, dates=${purchaseDatesToReplace.length}`);
    }

    db.run(
      `INSERT INTO import_logs (source, filename, rows_imported, date_range_start, date_range_end, status, branch_id, file_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      'ONEGLANCE_PURCHASE_SYNC', result.purchaseFile.filename, rows.length,
      summary.dateRange?.start || null, summary.dateRange?.end || null, 'completed', branchId, result.purchaseFile.filePath
    );
    const purchaseImportRow = db.get("SELECT id FROM import_logs WHERE source = 'ONEGLANCE_PURCHASE_SYNC' ORDER BY id DESC LIMIT 1");
    const purchaseImportId = purchaseImportRow?.id || 0;
    importIds.purchase = purchaseImportId;

    db.beginBatch();
    try {
      for (const r of rows) {
        db.run(
          `INSERT INTO pharmacy_purchase_actuals (import_id, invoice_no, invoice_date, invoice_month,
            stockiest_name, mfg_name, drug_name, batch_no, hsn_code, batch_qty, free_qty, mrp, rate,
            discount_amount, net_purchase_value, net_sales_value, tax_pct, tax_amount,
            purchase_qty, purchase_value, sales_value, profit, profit_pct, branch_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          purchaseImportId, r.invoice_no, r.invoice_date, r.invoice_month,
          r.stockiest_name, r.mfg_name, r.drug_name, r.batch_no, r.hsn_code,
          r.batch_qty, r.free_qty, r.mrp, r.rate, r.discount_amount,
          r.net_purchase_value, r.net_sales_value, r.tax_pct, r.tax_amount,
          r.purchase_qty, r.purchase_value, r.sales_value, r.profit, r.profit_pct, branchId
        );
      }
      db.endBatch();
    } catch (e) { db.rollbackBatch(); throw e; }
    totalRows += rows.length;
  }

  // ── Stock snapshot ───────────────────────────────────────────────────
  if (result.stockFile) {
    progress('parsing', 'Parsing stock report...', 94);
    const { rows } = parseOneglanceStock(result.stockFile.filePath);
    const snapshotDate = new Date().toISOString().slice(0, 10);

    db.run('DELETE FROM pharmacy_stock_actuals WHERE snapshot_date = ? AND branch_id IS ?',
      snapshotDate, branchId);

    db.run(
      `INSERT INTO import_logs (source, filename, rows_imported, date_range_start, date_range_end, status, branch_id, file_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      'ONEGLANCE_STOCK_SYNC', result.stockFile.filename, rows.length,
      snapshotDate, snapshotDate, 'completed', branchId, result.stockFile.filePath
    );
    const stockImportId = db.get("SELECT id FROM import_logs WHERE source = 'ONEGLANCE_STOCK_SYNC' ORDER BY id DESC LIMIT 1")?.id || 0;
    importIds.stock = stockImportId;

    db.beginBatch();
    try {
      for (const r of rows) {
        db.run(
          `INSERT INTO pharmacy_stock_actuals (import_id, snapshot_date, drug_name, batch_no,
            received_date, expiry_date, avl_qty, strips, purchase_price, purchase_tax,
            purchase_value, stock_value, branch_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          stockImportId, snapshotDate, r.drug_name, r.batch_no,
          r.received_date, r.expiry_date, r.avl_qty, r.strips,
          r.purchase_price, r.purchase_tax, r.purchase_value, r.stock_value, branchId
        );
      }
      db.endBatch();
    } catch (e) { db.rollbackBatch(); throw e; }
    totalRows += rows.length;
  }

  return { totalRows, importIds, stockError: result.stockError };
}
