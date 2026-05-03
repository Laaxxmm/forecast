// Per-branch COGS resolution.
//
// Two paths exist depending on the branch's role:
//
//   • standalone — the default for every non-Hyderabad branch. COGS is taken
//     directly from `pharmacy_sales_actuals.purchase_amount` (already net of
//     input GST), summed by `bill_month`. Identical to today's behavior; this
//     path exists so the same aggregate table can drive the dashboard for
//     standalone and satellite branches uniformly.
//
//   • satellite — Hyderabad retail branches that never purchase from external
//     stockists. For each sale row we find the matching incoming transfer
//     (joined on drug_name_normalized + batch_no, with invoice_date <=
//     bill_date) and use that transfer's `purchase_price * sale.qty` as COGS.
//     If no exact match is found, we fall back to the median per-unit cost
//     across all transfers for that drug — and increment unmatched_count so
//     the UI can surface the gap for manual reconciliation.
//
//   • central_store — no retail sales, COGS not meaningful. Skipped.
//
// Results are upserted into pharmacy_branch_cogs(branch_id, month) so the
// dashboard read path is a fast indexed lookup. Recompute is triggered by
// import.ts on Sales / Transfer / Purchase imports for the branch and (for
// transfers) for the destination satellite.

import type { DbHelper } from '../../db/connection.js';
import { getPlatformHelper } from '../../db/platform-connection.js';
import { normalizeDrugName } from './normalize-drug-name.js';

export type BranchRole = 'standalone' | 'central_store' | 'satellite';

export async function getBranchRole(branchId: number | null): Promise<BranchRole> {
  if (!branchId) return 'standalone';
  const platformDb = await getPlatformHelper();
  const row = platformDb.get('SELECT branch_role FROM branches WHERE id = ?', branchId);
  const role = row?.branch_role as BranchRole | undefined;
  if (role === 'central_store' || role === 'satellite') return role;
  return 'standalone';
}

/**
 * Recompute pharmacy_branch_cogs for a branch.
 *
 * @param db          Tenant DB helper
 * @param branchId    Branch to recompute (null is treated as a single-branch
 *                    legacy tenant — uses the standalone path).
 * @param months      Optional months to scope the recompute to (YYYY-MM). If
 *                    omitted, recomputes every month with sales data.
 */
export async function recomputeBranchCogs(
  db: DbHelper,
  branchId: number | null,
  months?: string[],
): Promise<{ rowsWritten: number; unmatched: number }> {
  const role = await getBranchRole(branchId);
  if (role === 'central_store') {
    // Central stores have no retail sales — nothing to compute.
    return { rowsWritten: 0, unmatched: 0 };
  }

  // Resolve months in scope. If none provided, take every distinct month
  // present in the branch's sales rows.
  let targetMonths: string[];
  if (months && months.length) {
    targetMonths = [...new Set(months.filter(Boolean))];
  } else {
    const rows = db.all(
      `SELECT DISTINCT bill_month FROM pharmacy_sales_actuals
        WHERE branch_id IS ? AND bill_month IS NOT NULL AND bill_month != ''`,
      branchId,
    );
    targetMonths = rows.map((r: any) => r.bill_month);
  }

  if (targetMonths.length === 0) {
    // Nothing to compute, but still clear stale rows for this branch so a
    // deleted-import doesn't leave orphan COGS lingering.
    db.run('DELETE FROM pharmacy_branch_cogs WHERE branch_id = ?', branchId ?? 0);
    return { rowsWritten: 0, unmatched: 0 };
  }

  // Wipe the months we're about to rewrite, scoped to this branch only.
  const ph = targetMonths.map(() => '?').join(',');
  db.run(
    `DELETE FROM pharmacy_branch_cogs WHERE branch_id = ? AND month IN (${ph})`,
    branchId ?? 0, ...targetMonths,
  );

  let totalRowsWritten = 0;
  let totalUnmatched = 0;

  if (role === 'standalone') {
    // Today's behavior: SUM(purchase_amount) from sales, grouped by month.
    const grouped = db.all(
      `SELECT bill_month as month, COALESCE(SUM(purchase_amount), 0) as cogs
         FROM pharmacy_sales_actuals
        WHERE branch_id IS ? AND bill_month IN (${ph})
        GROUP BY bill_month`,
      branchId, ...targetMonths,
    );
    for (const g of grouped) {
      db.run(
        `INSERT INTO pharmacy_branch_cogs (branch_id, month, cogs_amount, unmatched_count, computed_at)
         VALUES (?, ?, ?, 0, datetime('now'))`,
        branchId ?? 0, g.month, g.cogs,
      );
      totalRowsWritten++;
    }
  } else {
    // Satellite: join sales → transfers on (normalized drug, batch).
    //
    // COGS resolution waterfall, per sale row, in priority order:
    //   1. Exact (drug, batch) match in transfers → use transfer.purchase_price × qty.
    //      This is the most precise: it ties the satellite's sale to the
    //      specific batch the central Store transferred in.
    //   2. Sales row's own `purchase_amount` if non-zero. OneGlance's Hyderabad
    //      Sales Report already fills this with the satellite's effective
    //      cost basis, so it's a reliable fallback when the transfer file
    //      doesn't cover the batch (e.g. transferred before the report's
    //      date window).
    //   3. Per-drug median across all transfers for that drug. Last-resort
    //      fallback for drugs we have transfer data for but in a different
    //      batch. Surfaces in COGS but doesn't increment unmatched_count.
    //   4. None of the above → unmatched_count++. The sale contributes 0
    //      to COGS, and the dashboard can surface the unmatched figure for
    //      manual reconciliation.
    const sales = db.all(
      `SELECT id, drug_name, batch_no, qty, bill_date, bill_month, purchase_amount
         FROM pharmacy_sales_actuals
        WHERE branch_id IS ? AND bill_month IN (${ph})`,
      branchId, ...targetMonths,
    );

    // Cache transfer rows for this branch so we don't re-query per sale.
    // `rate` is per-unit (₹/strip or ₹/vial), `purchase_price` is the batch
    // total (rate × qty). Per-unit is what we need to multiply by the sale's
    // own qty to get sale-level COGS, so we read `rate` here.
    const transferRows = db.all(
      `SELECT drug_name_normalized, batch_no, qty, rate, purchase_price, invoice_date
         FROM pharmacy_stock_transfers
        WHERE branch_to_id = ?`,
      branchId,
    );
    // Index: drug+batch → list of transfers (latest invoice_date wins on tie)
    const exactIndex = new Map<string, any[]>();
    // Index: drug → list of per-unit rates for fallback median
    const drugIndex = new Map<string, number[]>();
    for (const t of transferRows) {
      const drug = (t.drug_name_normalized || '').toUpperCase();
      const batch = (t.batch_no || '').trim().toUpperCase();
      const key = `${drug}|${batch}`;
      if (!exactIndex.has(key)) exactIndex.set(key, []);
      exactIndex.get(key)!.push(t);
      if (drug && t.rate > 0) {
        if (!drugIndex.has(drug)) drugIndex.set(drug, []);
        drugIndex.get(drug)!.push(t.rate);
      }
    }
    // Sort each exact-match list by invoice_date DESC for "latest <= bill_date" lookup.
    for (const list of exactIndex.values()) list.sort((a, b) => (b.invoice_date || '').localeCompare(a.invoice_date || ''));

    const median = (arr: number[]) => {
      if (arr.length === 0) return 0;
      const sorted = [...arr].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    };

    const cogsByMonth = new Map<string, { cogs: number; unmatched: number }>();
    for (const m of targetMonths) cogsByMonth.set(m, { cogs: 0, unmatched: 0 });

    for (const sale of sales) {
      const drug = normalizeDrugName(sale.drug_name);
      const batch = (sale.batch_no || '').trim().toUpperCase();
      const key = `${drug}|${batch}`;
      const billDate = sale.bill_date || '';
      const exactList = exactIndex.get(key) || [];
      // Prefer transfer rows received on/before the sale date; if none,
      // accept any (some transfer dates may post slightly after first sale
      // due to data lag — better to match than to use the median).
      let match = exactList.find(t => (t.invoice_date || '') <= billDate);
      if (!match && exactList.length) match = exactList[0];

      const bucket = cogsByMonth.get(sale.bill_month);
      if (!bucket) continue;
      if (match && match.rate > 0) {
        bucket.cogs += match.rate * (sale.qty || 0);
      } else if (sale.purchase_amount && sale.purchase_amount > 0) {
        // OneGlance's Sales Report carries the per-row cost basis already —
        // use it directly when no transfer match exists.
        bucket.cogs += sale.purchase_amount;
      } else {
        const fallback = median(drugIndex.get(drug) || []);
        bucket.cogs += fallback * (sale.qty || 0);
        if (fallback === 0) bucket.unmatched += 1;
      }
    }

    for (const [month, { cogs, unmatched }] of cogsByMonth) {
      db.run(
        `INSERT INTO pharmacy_branch_cogs (branch_id, month, cogs_amount, unmatched_count, computed_at)
         VALUES (?, ?, ?, ?, datetime('now'))`,
        branchId ?? 0, month, cogs, unmatched,
      );
      totalRowsWritten++;
      totalUnmatched += unmatched;
    }
  }

  return { rowsWritten: totalRowsWritten, unmatched: totalUnmatched };
}

/**
 * Look up cached COGS for a branch over a set of months.
 * Returns a map of month → cogs_amount.
 */
export function getBranchCogs(
  db: DbHelper,
  branchId: number | null,
  months: string[],
): Map<string, number> {
  const result = new Map<string, number>();
  if (!months.length) return result;
  const ph = months.map(() => '?').join(',');
  const rows = db.all(
    `SELECT month, cogs_amount FROM pharmacy_branch_cogs
      WHERE branch_id = ? AND month IN (${ph})`,
    branchId ?? 0, ...months,
  );
  for (const r of rows) result.set(r.month, r.cogs_amount || 0);
  return result;
}
