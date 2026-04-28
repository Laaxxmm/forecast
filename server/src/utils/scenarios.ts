import { Request } from 'express';
import { branchFilter } from './branch.js';

/**
 * Pick the canonical active-scenario for a given stream — the SAME scenario
 * that GET /api/dashboard/overview will read from when displaying actuals.
 *
 * Auto-sync writes (in import.ts and sync.ts) MUST go to this scenario,
 * otherwise the dashboard reads from one scenario while we wrote to another
 * and the actuals appear missing.
 *
 * Logic mirrors GET /overview's per-stream lookup at dashboard.ts:55-60:
 *   - active financial year
 *   - is_default = 1 (strict — never picks non-default scenarios)
 *   - stream-specific OR null-stream legacy scenarios match
 *   - branch-filtered (the request's active branch context)
 *   - prefer stream-specific over null-stream, then by id
 *
 * Historical bug this prevents: the auto-sync used
 *   WHERE fy.is_active = 1 AND (s.stream_id = ? OR s.is_default = 1)
 * with no branch filter — it could write to a non-default scenario, or to
 * a scenario tagged with a different branch_id than the upload's branch
 * context. The read (with branch filter + strict is_default) then picked
 * a different scenario and the actuals looked like ~₹7L instead of ~₹36L.
 */
export function findActiveScenarioForStream(
  db: any,
  req: Request,
  streamId: number | null,
): { id: number } | null {
  const bfs = branchFilter(req, 's');
  return db.get(
    `SELECT s.id FROM scenarios s
     JOIN financial_years fy ON s.fy_id = fy.id
     WHERE fy.is_active = 1
       AND s.is_default = 1
       AND (s.stream_id = ? OR s.stream_id IS NULL)${bfs.where}
     ORDER BY CASE WHEN s.stream_id = ? THEN 0 ELSE 1 END, s.id LIMIT 1`,
    streamId, ...bfs.params, streamId,
  ) || null;
}
