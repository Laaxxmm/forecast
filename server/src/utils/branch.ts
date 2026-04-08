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
 * Returns a branch-prefixed settings key for multi-branch credential storage.
 * Single-branch clients use the base key as-is.
 */
export function branchSettingsKey(baseKey: string, req: Request): string {
  if (!req.isMultiBranch || !req.branchId) return baseKey;
  return `branch_${req.branchId}__${baseKey}`;
}
