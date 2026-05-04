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
import { parseOneglanceTransfer } from '../parsers/oneglance-transfer.js';
import { recomputeBranchCogs } from '../pharmacy/cogs.js';

export type ProgressFn = (step: string, message: string, pct: number) => void;

export interface OneglanceRunOpts {
  tenantSlug: string;
  clientId: number;
  ctx: BranchContext;
  branchId: number | null;
  fromDate: string;
  toDate: string;
  reportType?: 'sales' | 'purchase' | 'stock' | 'transfer' | 'both' | 'all';
  trigger: 'manual' | 'auto-schedule' | 'auto-catchup' | 'auto-test';
  onProgress?: ProgressFn;
}

export interface OneglanceRunResult {
  totalRows: number;
  importIds: { sales?: number; purchase?: number; stock?: number; transfer?: number };
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

  // Look up branch role + city + parent + oneglance_center so we can:
  // - dispatch between the existing emr7 scraper and the new emr25 / Hyderabad
  //   scraper without touching the rest of the pipeline
  // - resolve credentials from the parent Store when called from a satellite
  //   (Hyderabad uses a single shared OneGlance login for the whole city)
  // - pass the satellite's OneGlance Center filter to the scraper
  // - skip parsing reports that don't apply to the branch role
  const platformDbForRole = await getPlatformHelper();
  const branchRow = branchId ? platformDbForRole.get(
    `SELECT branch_role, parent_branch_id, city,
            COALESCE(oneglance_center, '') as oneglance_center
       FROM branches WHERE id = ?`,
    branchId,
  ) : null;
  const branchRole: 'standalone' | 'central_store' | 'satellite' =
    (branchRow?.branch_role === 'central_store' || branchRow?.branch_role === 'satellite')
      ? branchRow.branch_role
      : 'standalone';
  const cityNorm = (branchRow?.city || '').toString().trim().toLowerCase();
  const isHyderabad = cityNorm === 'hyderabad';
  const useHyderabadScraper = isHyderabad && (branchRole === 'central_store' || branchRole === 'satellite');
  const oneglanceCenter = (branchRow?.oneglance_center || '').toString().trim();

  // Credential lookup. For Hyderabad satellites the credentials live on the
  // parent central_store (one shared OneGlance login for the whole city);
  // for everyone else, the calling branch's own settings.
  const credentialBranchId =
    branchRole === 'satellite' && branchRow?.parent_branch_id
      ? branchRow.parent_branch_id
      : branchId;
  const credKey = (base: string) =>
    !ctx.isMultiBranch || !credentialBranchId
      ? base
      : `branch_${credentialBranchId}__${base}`;
  const usernameRow = db.get("SELECT value FROM app_settings WHERE key = ?", credKey('oneglance_username'));
  const passwordRow = db.get("SELECT value FROM app_settings WHERE key = ?", credKey('oneglance_password'));

  if (!usernameRow?.value || !passwordRow?.value) {
    if (branchRole === 'satellite') {
      throw new Error(
        'Oneglance credentials not configured. For Hyderabad satellites, save the credentials once on the central Store branch — they are shared automatically.',
      );
    }
    throw new Error('Oneglance credentials not configured');
  }

  const username = usernameRow.value;
  const password = decrypt(passwordRow.value);

  // Existing-scraper return shape; the Hyderabad path produces a subset
  // that we map onto this so the rest of the pipeline is unchanged.
  type ResultShape = {
    salesFile?: { filePath: string; filename: string };
    purchaseFile?: { filePath: string; filename: string };
    stockFile?: { filePath: string; filename: string };
    transferFile?: { filePath: string; filename: string };
    stockError?: string;
  };
  let result: ResultShape;

  if (useHyderabadScraper) {
    // Decide which Hyderabad reports to download for this run.
    // Coverage today:
    //   central_store → Purchase
    //   satellite     → Sales, Stock Transfer
    // Stock Report auto-sync at satellites is still pending — surface a
    // clear actionable error instead of silently no-op'ing so the user
    // knows what's missing.
    if (branchRole === 'satellite' && reportType === 'stock') {
      throw new Error(
        'Stock Report auto-sync for Hyderabad satellites is not yet wired. Walk Claude through the OneGlance navigation for the Stock Report and it will be enabled in the next round.',
      );
    }

    const reports: Array<'purchase' | 'sales' | 'transfer'> = [];
    if (branchRole === 'central_store') {
      if (reportType === 'purchase' || reportType === 'both' || reportType === 'all' || !reportType) {
        reports.push('purchase');
      }
    } else if (branchRole === 'satellite') {
      // Sales: 'sales' | 'both' | 'all' | undefined → include sales
      // Transfer: 'transfer' | 'all' | undefined → include transfer
      // 'both' is treated as Sales-only (legacy alias) so manual users
      // who pick "both" don't suddenly start downloading transfers
      // they didn't expect.
      const wantSales = reportType === 'sales' || reportType === 'both' || reportType === 'all' || !reportType;
      const wantTransfer = reportType === 'transfer' || reportType === 'all' || !reportType;
      if (wantSales || wantTransfer) {
        if (!oneglanceCenter) {
          throw new Error(
            'OneGlance Center Name not configured for this satellite. Set it on the branch in Admin → Branches before syncing.',
          );
        }
        if (wantSales) reports.push('sales');
        if (wantTransfer) reports.push('transfer');
      }
    }
    if (reports.length === 0) {
      progress('complete', 'No Hyderabad reports configured for this branch / report type combination', 100);
      return { totalRows: 0, importIds: {} };
    }

    const { syncOneglanceHyderabad } = await import('./oneglance-sync-hyderabad.js');
    const hydResult = await syncOneglanceHyderabad({
      username, password, fromDate, toDate,
      reports,
      oneglanceCenter: oneglanceCenter || undefined,
      onProgress: progress,
    });
    result = {
      purchaseFile: hydResult.purchaseFile,
      salesFile: hydResult.salesFile,
      transferFile: hydResult.transferFile,
    };
  } else {
    if (reportType === 'transfer') {
      // The legacy emr7 scraper doesn't know about Stock Transfer (it's
      // a Hyderabad-only concept). The UI only exposes the 'transfer'
      // button on Hyderabad satellites, so reaching this branch with
      // reportType='transfer' would be a programming error elsewhere.
      throw new Error('Stock Transfer sync is only available for Hyderabad satellite branches.');
    }
    const legacyReportType: 'sales' | 'purchase' | 'stock' | 'both' | 'all' = reportType || 'both';
    const { syncOneglance } = await import('./oneglance-sync.js');
    result = await syncOneglance({
      username,
      password,
      fromDate,
      toDate,
      reportType: legacyReportType,
      onProgress: progress,
    });
  }

  // Drop downloaded files that don't apply to this branch's role. Keeps
  // the rest of the pipeline simple (each block already guards on the
  // file being defined). For the Hyderabad path this is mostly a no-op
  // since the scraper only downloads role-appropriate files anyway, but
  // it stays here as a defensive guard for the legacy emr7 path.
  if (branchRole === 'central_store') {
    result.salesFile = undefined;
    result.stockFile = undefined;
  } else if (branchRole === 'satellite') {
    result.purchaseFile = undefined;
  }

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

  // ── Stock Transfer Details ───────────────────────────────────────────
  // Hyderabad-only flow: a satellite's downloaded "Stock Transfer
  // Details" report lists rows transferred IN from the central Store.
  // Mirror the manual /import/oneglance-transfer endpoint logic — same
  // counterparty resolution, same dedup pattern, same insert columns.
  // Today this only runs for satellites (the Hyderabad scraper only
  // downloads transfer for satellites), but the role-aware branch_from
  // / branch_to assignment matches the manual endpoint so a future
  // central_store transfer flow would Just Work.
  if (result.transferFile) {
    progress('parsing', 'Parsing stock transfer report...', 93);
    const { rows: parsedRows, summary } = parseOneglanceTransfer(result.transferFile.filePath);

    const platformDb = await getPlatformHelper();
    const allBranches = platformDb.all(
      'SELECT id, name, code FROM branches WHERE client_id = ?',
      clientId,
    );
    const norm = (s: string) => String(s || '').toUpperCase().replace(/MAGNACODE\s*-\s*/i, '').trim();
    const nameIndex = new Map<string, number>();
    for (const b of allBranches) {
      if (b.name) nameIndex.set(norm(b.name), b.id);
      if (b.code) nameIndex.set(norm(b.code), b.id);
    }
    const parentBranchId: number | null = branchRow?.parent_branch_id || null;
    const resolveCounterparty = (raw: string | null): number | null => {
      if (!raw) return parentBranchId;
      const hit = nameIndex.get(norm(raw));
      if (hit) return hit;
      return parentBranchId;
    };

    const insertRows = parsedRows.map(r => {
      const counterpartyId = resolveCounterparty(r.counterparty_raw);
      const branchFrom = branchRole === 'central_store'
        ? branchId!
        : (counterpartyId || parentBranchId || branchId!);
      const branchTo = branchRole === 'central_store'
        ? (counterpartyId || branchId!)
        : branchId!;
      return { ...r, branch_from_id: branchFrom, branch_to_id: branchTo };
    });

    // Dedup by (branch_to_id, invoice_date) so re-syncs cleanly replace
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
      'ONEGLANCE_TRANSFER_SYNC', result.transferFile.filename, insertRows.length,
      summary.dateRange?.start || null, summary.dateRange?.end || null, 'completed', branchId, result.transferFile.filePath,
    );
    const transferImportId = db.get("SELECT id FROM import_logs WHERE source = 'ONEGLANCE_TRANSFER_SYNC' ORDER BY id DESC LIMIT 1")?.id || 0;
    importIds.transfer = transferImportId;

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
          transferImportId, r.branch_from_id, r.branch_to_id,
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
    totalRows += insertRows.length;

    // COGS for the destination branch(es) needs to be refreshed since
    // satellite COGS is derived from incoming-transfer purchase_price.
    const monthsTouched = [...new Set(insertRows.map(r => r.invoice_month).filter(Boolean))];
    const destBranchIds = [...new Set(insertRows.map(r => r.branch_to_id))];
    for (const destId of destBranchIds) {
      try {
        await recomputeBranchCogs(db, destId, monthsTouched);
      } catch (e: any) {
        console.warn(`[oneglance-runner] COGS recompute for branch ${destId} skipped:`, e?.message);
      }
    }

    console.log(`[oneglance-runner] Stock Transfer: ${insertRows.length} rows imported, ${destBranchIds.length} destination branch(es)`);
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

  // Refresh per-branch COGS cache after any pharmacy import (sales or
  // purchase). For Hyderabad satellites this also picks up any prior
  // stock-transfer rows we already have on file. Best-effort — failures
  // here shouldn't block the sync.
  try {
    await recomputeBranchCogs(db, branchId);
  } catch (e: any) {
    console.warn('[oneglance-runner] COGS recompute skipped:', e?.message);
  }

  return { totalRows, importIds, stockError: result.stockError };
}
