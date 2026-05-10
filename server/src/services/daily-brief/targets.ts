// Monthly revenue target lookup for the brief generators.
//
// Targets in this app are stored in `forecast_items` (category='revenue')
// under a default `scenario` per (financial_year, stream, branch). To
// extract the rupee target for a given month we walk every revenue item
// in the active scenarios and pull the right field out of the meta JSON
// based on its item_type (unit_sales / recurring / generic).
//
// Mirrors the logic in routes/dashboard.ts ~line 1267 so the daily
// brief / weekly pulse stays consistent with what the live Operational
// Insights screen shows.

import type { DbHelper } from '../../db/connection.js';
import type { BranchContext } from '../../utils/branch.js';
import { branchFilter } from '../../utils/branch.js';

interface TargetOptions {
  fyId: number;
  month: string;          // YYYY-MM
  streamId?: number;      // when omitted → sum across all client streams
}

/**
 * Returns the monthly revenue target (in rupees) for the given FY/month,
 * scoped by the request's branch context. Optionally narrowed to a
 * single stream id; otherwise sums across every default scenario the
 * tenant has for this FY.
 *
 * Returns 0 when no scenario / no forecast items exist — the caller
 * decides how to phrase that ("No monthly target set yet").
 */
export function getMonthlyRevenueTarget(
  db: DbHelper,
  ctx: BranchContext,
  options: TargetOptions
): number {
  const bf = branchFilter(ctx, { strict: true });
  // Find default scenario(s). Per-stream when streamId given; any
  // default-scenario otherwise. Branch-scoped via bf.
  const params: any[] = [options.fyId];
  let scenarioWhere = `fy_id = ? AND is_default = 1${bf.where}`;
  params.push(...bf.params);
  if (options.streamId !== undefined) {
    scenarioWhere += ` AND (stream_id = ? OR stream_id IS NULL)`;
    params.push(options.streamId);
  }
  const scenarios = db.all(
    `SELECT id FROM scenarios WHERE ${scenarioWhere}`,
    ...params
  );
  if (scenarios.length === 0) return 0;

  const scenarioIds = (scenarios as any[]).map(s => s.id);
  const placeholders = scenarioIds.map(() => '?').join(',');
  const items = db.all(
    `SELECT item_type, meta FROM forecast_items
      WHERE scenario_id IN (${placeholders}) AND category = 'revenue'`,
    ...scenarioIds
  );

  let total = 0;
  for (const item of items as any[]) {
    let meta: any = {};
    try { meta = typeof item.meta === 'string' ? JSON.parse(item.meta) : (item.meta || {}); }
    catch { meta = {}; }
    const sv = meta?.stepValues || {};
    let amt = 0;
    if (item.item_type === 'unit_sales') {
      const units = sv.units?.[options.month] || 0;
      const price = sv.prices?.[options.month] || 0;
      amt = units * price;
    } else if (item.item_type === 'recurring') {
      amt = sv.amount?.[options.month] || 0;
    } else {
      // Generic: first stepValues key whose object has a value for this month.
      const key = Object.keys(sv).find(k => sv[k]?.[options.month] !== undefined);
      amt = key ? (sv[key][options.month] || 0) : 0;
    }
    total += Number(amt) || 0;
  }
  return total;
}

/**
 * Same as getMonthlyRevenueTarget but returns a per-stream-id map. When
 * the brief renders the 4 service-area cards it wants targets indexed
 * by the platform business_streams.id; this helper makes one query
 * per stream so the data gatherer doesn't loop in user code.
 */
export function getMonthlyRevenueTargetsByStream(
  db: DbHelper,
  ctx: BranchContext,
  options: { fyId: number; month: string; streams: { id: number }[] }
): Record<number, number> {
  const out: Record<number, number> = {};
  for (const s of options.streams) {
    out[s.id] = getMonthlyRevenueTarget(db, ctx, {
      fyId: options.fyId,
      month: options.month,
      streamId: s.id,
    });
  }
  return out;
}
