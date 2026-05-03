/**
 * Structural shape needed for branch + stream filtering.
 *
 * Express Request (after the auth + branch middleware run) carries all of
 * these fields, so existing route-handler call sites that pass `req` keep
 * working unchanged. Background jobs (the auto-sync scheduler) build a
 * plain object of this shape and pass it instead of a Request.
 */
export interface BranchContext {
  isMultiBranch?: boolean;
  branchId?: number | null;
  branchMode?: 'single' | 'specific' | 'consolidated' | 'region';
  allowedBranchIds?: number[];
  regionCity?: string | null;
  streamMode?: 'none' | 'specific' | 'all';
  streamId?: number | null;
}

/**
 * Returns a SQL WHERE fragment and params for branch filtering.
 * Appends to existing queries — always starts with "AND".
 *
 * - single-branch client or no branch context → no filtering
 * - specific branch → AND branch_id = ?
 * - consolidated → AND branch_id IN (?,?,?)
 *
 * The default behaviour INCLUDES rows with `branch_id IS NULL` so
 * "company-level" data created in consolidated mode is visible from every
 * branch's view. Some modules (notably Forecast) need strict per-branch
 * isolation instead — they should call `branchFilter(req, { strict: true })`
 * to drop the `OR branch_id IS NULL` clause.
 */
export function branchFilter(
  ctx: BranchContext,
  optsOrAlias?: string | { strict?: boolean; alias?: string }
): { where: string; params: any[] } {
  // Back-compat: legacy callers passed an alias string positionally.
  const opts = typeof optsOrAlias === 'string'
    ? { alias: optsOrAlias }
    : (optsOrAlias || {});
  const col = opts.alias ? `${opts.alias}.branch_id` : 'branch_id';
  const strict = !!opts.strict;

  if (!ctx.isMultiBranch || ctx.branchMode === 'single') {
    return { where: '', params: [] };
  }

  if (ctx.branchMode === 'specific' && ctx.branchId) {
    // Strict mode (forecast): scope the row to ONLY this branch — NULL-branch
    // legacy data does NOT leak in. Loose mode (default): also include NULL
    // so company-level rows show alongside branch-specific ones.
    return strict
      ? { where: ` AND ${col} = ?`, params: [ctx.branchId] }
      : { where: ` AND (${col} = ? OR ${col} IS NULL)`, params: [ctx.branchId] };
  }

  if ((ctx.branchMode === 'consolidated' || ctx.branchMode === 'region') && ctx.allowedBranchIds?.length) {
    // Region mode reuses the consolidated IN-list path. The middleware has
    // already narrowed allowedBranchIds to the satellite set for the chosen
    // city, so the filter just needs to pass that set into SQL.
    const placeholders = ctx.allowedBranchIds.map(() => '?').join(',');
    return strict
      ? { where: ` AND ${col} IN (${placeholders})`, params: [...ctx.allowedBranchIds] }
      : { where: ` AND (${col} IN (${placeholders}) OR ${col} IS NULL)`, params: [...ctx.allowedBranchIds] };
  }

  // Multi-branch client but no allowed branches — deny all data
  if (ctx.isMultiBranch) {
    return { where: ' AND 1=0', params: [] };
  }

  return { where: '', params: [] };
}

/**
 * Returns the branch_id value to use when inserting new records.
 * Returns null for single-branch clients.
 */
export function getBranchIdForInsert(ctx: BranchContext): number | null {
  if (!ctx.isMultiBranch || ctx.branchMode !== 'specific') return null;
  return ctx.branchId || null;
}

/**
 * Returns a SQL WHERE fragment and params for stream filtering.
 * Similar to branchFilter but for stream_id column.
 */
export function streamFilter(
  ctx: BranchContext,
  alias?: string
): { where: string; params: any[] } {
  const col = alias ? `${alias}.stream_id` : 'stream_id';

  if (!ctx.streamMode || ctx.streamMode === 'none') {
    return { where: '', params: [] };
  }

  if (ctx.streamMode === 'specific' && ctx.streamId) {
    // Include NULL so company-level data (created without a stream scope)
    // is visible when a specific stream is selected.
    return { where: ` AND (${col} = ? OR ${col} IS NULL)`, params: [ctx.streamId] };
  }

  // 'all' mode — no additional filtering (show data for all allowed streams)
  return { where: '', params: [] };
}

/**
 * Returns the stream_id value to use when inserting new records.
 * Returns null if no specific stream is selected.
 */
export function getStreamIdForInsert(ctx: BranchContext): number | null {
  if (!ctx.streamMode || ctx.streamMode !== 'specific') return null;
  return ctx.streamId || null;
}

/**
 * Returns a branch-prefixed settings key for multi-branch credential storage.
 * Single-branch clients use the base key as-is.
 */
export function branchSettingsKey(baseKey: string, ctx: BranchContext): string {
  if (!ctx.isMultiBranch || !ctx.branchId) return baseKey;
  return `branch_${ctx.branchId}__${baseKey}`;
}
