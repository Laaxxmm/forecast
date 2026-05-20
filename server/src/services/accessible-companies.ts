// ─────────────────────────────────────────────────────────────────────────────
// Accessible-companies service.
//
// Single source of truth for "which Tally companies (vcfo_companies rows)
// can the current user see in the current sidebar branch/stream context?"
//
// Used by:
//   • routes/vcfo-reports.ts — the four detail tabs and the new Dashboard
//   • routes/forecast-module.ts — Budget vs Actual actuals scoping
//
// Both call sites previously did their own thing (the BvA actuals query
// did nothing, leaking other branches' totals). Pulling the logic here
// makes drift impossible.
// ─────────────────────────────────────────────────────────────────────────────

import type { Request } from 'express';
import { getPlatformHelper } from '../db/platform-connection.js';

export interface AccessibleCompany {
  id: number;
  name: string;
  location: string;
  entity_type: string;
  branchId: number | null;
  streamId: number | null;
  branchName: string | null;
  streamName: string | null;
  lastSyncedAt: string | null;
}

/**
 * Pick the set of vcfo_companies (tenant DB rows) the active user can see
 * in the current branch/stream context. Delegates filtering to the
 * platform.db.vcfo_company_mapping table.
 *
 * Permissive-NULL rule: a Tally company mapped to NULL branch/stream stays
 * visible across every sidebar selection. Mirrors `branchFilter` in
 * utils/branch.ts, which the rest of the codebase uses for legacy data
 * that hasn't been explicitly assigned yet.
 */
export async function listAccessibleCompanies(req: Request): Promise<AccessibleCompany[]> {
  const db = req.tenantDb!;
  const platformDb = await getPlatformHelper();

  // Load the sidebar filter context. `*Mode === 'specific'` means the user
  // picked one branch / one stream. 'all' (or undefined) means consolidated.
  const activeBranchId = req.branchMode === 'specific' ? req.branchId : null;
  const activeStreamId = req.streamMode === 'specific' ? req.streamId : null;

  // Companies that have actually received data from the sync-agent.
  // `last_full_sync_at IS NOT NULL` excludes the seed/ghost row planted on
  // tenant creation. Order so the most recently active company leads.
  const companies = db.all(
    `SELECT id, name, location, entity_type, last_full_sync_at
     FROM vcfo_companies
     WHERE is_active = 1
       AND last_full_sync_at IS NOT NULL
     ORDER BY last_full_sync_at DESC, name ASC`,
  ) as Array<{ id: number; name: string; location: string; entity_type: string; last_full_sync_at: string }>;

  if (companies.length === 0) return [];

  const mappings = platformDb.all(
    `SELECT tally_company_name, branch_id, stream_id
     FROM vcfo_company_mapping
     WHERE client_id = ?`,
    req.clientId,
  ) as Array<{ tally_company_name: string; branch_id: number | null; stream_id: number | null }>;
  const byName = new Map(mappings.map(m => [m.tally_company_name.toLowerCase(), m]));

  // Branch / stream label hydration — kept as separate lookups so an
  // unmapped company still resolves to `null` labels without blowing up
  // the join.
  const branches = platformDb.all(
    `SELECT id, name FROM branches WHERE client_id = ?`,
    req.clientId,
  ) as Array<{ id: number; name: string }>;
  const branchNameById = new Map<number, string>(branches.map(b => [b.id, b.name]));

  const streams = platformDb.all(
    `SELECT id, name FROM business_streams WHERE client_id = ?`,
    req.clientId,
  ) as Array<{ id: number; name: string }>;
  const streamNameById = new Map<number, string>(streams.map(s => [s.id, s.name]));

  return companies
    .map((c) => {
      const m = byName.get(c.name.toLowerCase());
      const branchId = m?.branch_id ?? null;
      const streamId = m?.stream_id ?? null;
      return {
        id: c.id,
        name: c.name,
        location: c.location || '',
        entity_type: c.entity_type || '',
        branchId,
        streamId,
        branchName: branchId != null ? branchNameById.get(branchId) ?? null : null,
        streamName: streamId != null ? streamNameById.get(streamId) ?? null : null,
        lastSyncedAt: c.last_full_sync_at || null,
      };
    })
    .filter((c) => {
      // Permissive NULL: an unmapped company stays visible everywhere.
      if (activeBranchId && c.branchId != null && c.branchId !== activeBranchId) return false;
      if (activeStreamId && c.streamId != null && c.streamId !== activeStreamId) return false;
      return true;
    });
}

/**
 * All synced Tally companies for the tenant, IGNORING the sidebar
 * branch/stream filter. Used by the allocation engine: cross-company rules
 * (rent split, HO pool, lab cross-charge, salary add-back) must be computed
 * against every company even when the user is viewing a single branch — the
 * result is then projected back down to the viewed columns. Without this, a
 * single-branch view can't see (or mis-computes) any rule that spans branches.
 *
 * Returns the same id/name shape buildProfitLossMulti expects. NULL-branch
 * companies and every mapped company are included regardless of selection.
 */
export async function listAllSyncedCompanies(
  req: Request,
): Promise<Array<{ id: number; name: string }>> {
  const db = req.tenantDb!;
  return db.all(
    `SELECT id, name
       FROM vcfo_companies
      WHERE is_active = 1
        AND last_full_sync_at IS NOT NULL
      ORDER BY name ASC`,
  ) as Array<{ id: number; name: string }>;
}

/**
 * Convenience wrapper for query-scoping callers (e.g. BvA actuals SQL).
 *
 * Returns:
 *   • `null` — caller should NOT filter by company_id. This corresponds to
 *     "all branches" mode (consolidated admin view) where no scoping was
 *     requested.
 *   • `number[]` — the set of `vcfo_companies.id` to scope queries to.
 *     May be empty if the user picked a branch with no Tally companies
 *     mapped to it; callers should treat empty as "no actuals" and
 *     short-circuit rather than emit `IN ()` (SQL syntax error).
 */
export async function getAccessibleCompanyIds(req: Request): Promise<number[] | null> {
  const branchSpecific = req.branchMode === 'specific';
  const streamSpecific = req.streamMode === 'specific';
  // No scoping was requested — the sidebar is on "All branches" with no
  // stream narrowing. Return null so callers know to skip the filter.
  if (!branchSpecific && !streamSpecific) return null;

  const accessible = await listAccessibleCompanies(req);
  return accessible.map((c) => c.id);
}
