import { Request } from 'express';

/**
 * Returns a SQL WHERE fragment and params for branch filtering.
 * Appends to existing queries — always starts with "AND".
 *
 * - single-branch client or no branch context → no filtering
 * - specific branch → AND branch_id = ?
 * - consolidated → AND branch_id IN (?,?,?)
 */
export function branchFilter(
  req: Request,
  alias?: string
): { where: string; params: any[] } {
  const col = alias ? `${alias}.branch_id` : 'branch_id';

  if (!req.isMultiBranch || req.branchMode === 'single') {
    return { where: '', params: [] };
  }

  if (req.branchMode === 'specific' && req.branchId) {
    return { where: ` AND ${col} = ?`, params: [req.branchId] };
  }

  if (req.branchMode === 'consolidated' && req.allowedBranchIds?.length) {
    const placeholders = req.allowedBranchIds.map(() => '?').join(',');
    return { where: ` AND ${col} IN (${placeholders})`, params: [...req.allowedBranchIds] };
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
    return { where: ` AND ${col} = ?`, params: [req.streamId] };
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
 * Combined branch + stream filter for convenience.
 */
export function branchStreamFilter(
  req: Request,
  alias?: string
): { where: string; params: any[] } {
  const bf = branchFilter(req, alias);
  const sf = streamFilter(req, alias);
  return {
    where: bf.where + sf.where,
    params: [...bf.params, ...sf.params],
  };
}

/**
 * Returns a branch-prefixed settings key for multi-branch credential storage.
 * Single-branch clients use the base key as-is.
 */
export function branchSettingsKey(baseKey: string, req: Request): string {
  if (!req.isMultiBranch || !req.branchId) return baseKey;
  return `branch_${req.branchId}__${baseKey}`;
}
