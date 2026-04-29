import { Request } from 'express';

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
  req: Request,
  optsOrAlias?: string | { strict?: boolean; alias?: string }
): { where: string; params: any[] } {
  // Back-compat: legacy callers passed an alias string positionally.
  const opts = typeof optsOrAlias === 'string'
    ? { alias: optsOrAlias }
    : (optsOrAlias || {});
  const col = opts.alias ? `${opts.alias}.branch_id` : 'branch_id';
  const strict = !!opts.strict;

  if (!req.isMultiBranch || req.branchMode === 'single') {
    return { where: '', params: [] };
  }

  if (req.branchMode === 'specific' && req.branchId) {
    // Strict mode (forecast): scope the row to ONLY this branch — NULL-branch
    // legacy data does NOT leak in. Loose mode (default): also include NULL
    // so company-level rows show alongside branch-specific ones.
    return strict
      ? { where: ` AND ${col} = ?`, params: [req.branchId] }
      : { where: ` AND (${col} = ? OR ${col} IS NULL)`, params: [req.branchId] };
  }

  if (req.branchMode === 'consolidated' && req.allowedBranchIds?.length) {
    const placeholders = req.allowedBranchIds.map(() => '?').join(',');
    return strict
      ? { where: ` AND ${col} IN (${placeholders})`, params: [...req.allowedBranchIds] }
      : { where: ` AND (${col} IN (${placeholders}) OR ${col} IS NULL)`, params: [...req.allowedBranchIds] };
  }

  // Multi-branch client but no allowed branches — deny all data
  if (req.isMultiBranch) {
    return { where: ' AND 1=0', params: [] };
  }

  return { where: '', params: [] };
}

/**
 * Returns the branch_id value to use when inserting new records.
 * Returns null for single-branch clients.
 */
export function getBranchIdForInsert(req: Request): number | null {
  if (!req.isMultiBranch || req.branchMode !== 'specific') return null;
  return req.branchId || null;
}

/**
 * Returns a SQL WHERE fragment and params for stream filtering.
 * Similar to branchFilter but for stream_id column.
 */
export function streamFilter(
  req: Request,
  alias?: string
): { where: string; params: any[] } {
  const col = alias ? `${alias}.stream_id` : 'stream_id';

  if (!req.streamMode || req.streamMode === 'none') {
    return { where: '', params: [] };
  }

  if (req.streamMode === 'specific' && req.streamId) {
    // Include NULL so company-level data (created without a stream scope)
    // is visible when a specific stream is selected.
    return { where: ` AND (${col} = ? OR ${col} IS NULL)`, params: [req.streamId] };
  }

  // 'all' mode — no additional filtering (show data for all allowed streams)
  return { where: '', params: [] };
}

/**
 * Returns the stream_id value to use when inserting new records.
 * Returns null if no specific stream is selected.
 */
export function getStreamIdForInsert(req: Request): number | null {
  if (!req.streamMode || req.streamMode !== 'specific') return null;
  return req.streamId || null;
}

/**
 * Returns a branch-prefixed settings key for multi-branch credential storage.
 * Single-branch clients use the base key as-is.
 */
export function branchSettingsKey(baseKey: string, req: Request): string {
  if (!req.isMultiBranch || !req.branchId) return baseKey;
  return `branch_${req.branchId}__${baseKey}`;
}
