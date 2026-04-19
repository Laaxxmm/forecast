// ─────────────────────────────────────────────────────────────────────────────
// VCFO Report routes (Slice 5b).
//
// Exposes the four financial reports (Trial Balance, P&L, Balance Sheet, Cash
// Flow) from the sync-agent-fed `vcfo_*` tables, plus a companies list and a
// download endpoint that pipes XLSX/PDF/DOCX straight to the browser.
//
// All routes run under the standard user-session middleware stack:
//   requireAuth → resolveTenant → resolveBranch → requireModule('forecast_ops')
// Mounting is in `index.ts` under `/api/vcfo`.
//
// Branch/stream context: the `/companies` endpoint filters by the sidebar
// branch/stream selection via `vcfo_company_mapping` (platform.db). Report
// endpoints are always company-scoped via `companyId`, but the UI only lets
// the user pick a company that's mapped to the active branch/stream, so the
// filter is applied upstream.
// ─────────────────────────────────────────────────────────────────────────────

import { Router, Request, Response } from 'express';
import { getPlatformHelper } from '../db/platform-connection.js';
import { requireAdmin } from '../middleware/auth.js';
import {
  buildTrialBalanceMulti,
  buildProfitLossMulti,
  buildBalanceSheetMulti,
  buildCashFlowMulti,
} from '../services/vcfo-report-builder.js';
import {
  renderXlsx,
  renderPdf,
  renderDocx,
} from '../services/vcfo-report-export.js';

const router = Router();

// ─── Helpers ────────────────────────────────────────────────────────────────

function requireInt(val: any, name: string): number {
  const n = parseInt(String(val), 10);
  if (Number.isNaN(n)) throw new Error(`${name} must be an integer`);
  return n;
}

function requireDate(val: any, name: string): string {
  const s = String(val || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`${name} must be YYYY-MM-DD`);
  return s;
}

function validView(val: any): 'yearly' | 'monthly' {
  return val === 'monthly' ? 'monthly' : 'yearly';
}

function validBool(val: any): boolean {
  if (val === true || val === 1) return true;
  const s = String(val || '').toLowerCase();
  return s === '1' || s === 'true' || s === 'yes';
}

/**
 * Resolve the set of companies the current report call should cover.
 *
 * Priority (first match wins):
 *   1. Explicit `companyIds` (CSV or repeated) → intersected with accessible set
 *   2. Explicit `companyId` (legacy single-company) → [that id]
 *   3. Default → all accessible companies (sidebar-filtered)
 *
 * Always intersects with `listAccessibleCompanies` so a user can never read
 * a company outside their active branch/stream context.
 */
async function resolveCompanyRefs(req: Request): Promise<Array<{ id: number; name: string }>> {
  const accessible = await listAccessibleCompanies(req);
  const byId = new Map(accessible.map(c => [c.id, { id: c.id, name: c.name }]));

  // 1. explicit companyIds
  const raw = req.query.companyIds;
  if (raw !== undefined && raw !== null && raw !== '') {
    const flat = Array.isArray(raw) ? raw.join(',') : String(raw);
    if (flat.toLowerCase() === 'all') return [...byId.values()];
    const ids = flat
      .split(',')
      .map(s => parseInt(s.trim(), 10))
      .filter(n => Number.isFinite(n));
    return ids.map(id => byId.get(id)).filter((x): x is { id: number; name: string } => !!x);
  }

  // 2. explicit single companyId
  if (req.query.companyId !== undefined && req.query.companyId !== '') {
    const n = parseInt(String(req.query.companyId), 10);
    if (Number.isFinite(n) && byId.has(n)) return [byId.get(n)!];
    return [];
  }

  // 3. default — every company the user can see right now
  return [...byId.values()];
}

/**
 * Pick the set of vcfo_companies the active user can see in the current
 * branch/stream context. Delegates filtering to platform.db.vcfo_company_mapping.
 */
async function listAccessibleCompanies(req: Request): Promise<Array<{
  id: number;
  name: string;
  location: string;
  entity_type: string;
  branchId: number | null;
  streamId: number | null;
  lastSyncedAt: string | null;
}>> {
  const db = req.tenantDb!;
  const platformDb = await getPlatformHelper();

  // Load the sidebar filter context
  const activeBranchId = req.branchMode === 'specific' ? req.branchId : null;
  const activeStreamId = req.streamMode === 'specific' ? req.streamId : null;

  // Pull companies that have actually received data from the sync-agent.
  // `last_full_sync_at IS NOT NULL` excludes the seed/ghost row that
  // `ensureVcfoForSlug` plants on tenant creation (it carries the client
  // display name, e.g. "MagnaCode Healthcare", which is NOT a real Tally
  // company). Ordering by `last_full_sync_at DESC` means the UI's default
  // auto-selection lands on the company the user most recently worked with
  // — no "pick a company to see anything" friction on page load.
  //
  // Tie-breaker by name keeps results stable when two companies happened
  // to be synced in the same second.
  const companies = db.all(
    `SELECT id, name, location, entity_type, last_full_sync_at
     FROM vcfo_companies
     WHERE is_active = 1
       AND last_full_sync_at IS NOT NULL
     ORDER BY last_full_sync_at DESC, name ASC`,
  ) as Array<{ id: number; name: string; location: string; entity_type: string; last_full_sync_at: string }>;

  if (companies.length === 0) return [];

  // Pull the mapping rows for this client
  const mappings = platformDb.all(
    `SELECT tally_company_name, branch_id, stream_id
     FROM vcfo_company_mapping
     WHERE client_id = ?`,
    req.clientId,
  ) as Array<{ tally_company_name: string; branch_id: number | null; stream_id: number | null }>;
  const byName = new Map(mappings.map(m => [m.tally_company_name.toLowerCase(), m]));

  const filtered = companies
    .map(c => {
      const m = byName.get(c.name.toLowerCase());
      return {
        id: c.id,
        name: c.name,
        location: c.location || '',
        entity_type: c.entity_type || '',
        branchId: m?.branch_id ?? null,
        streamId: m?.stream_id ?? null,
        lastSyncedAt: c.last_full_sync_at || null,
      };
    })
    .filter(c => {
      // If a branch is selected, keep companies mapped to it (or unmapped → still shown).
      // Same for stream. This mirrors the permissive "NULL == include" rule used
      // elsewhere (branchFilter in utils/branch.ts).
      if (activeBranchId && c.branchId != null && c.branchId !== activeBranchId) return false;
      if (activeStreamId && c.streamId != null && c.streamId !== activeStreamId) return false;
      return true;
    });

  return filtered;
}

// ─── Endpoints ──────────────────────────────────────────────────────────────

router.get('/companies', async (req, res) => {
  try {
    const rows = await listAccessibleCompanies(req);
    res.json(rows);
  } catch (err: any) {
    console.error('[vcfo-reports] /companies error', err);
    res.status(500).json({ error: err?.message || 'Failed to list companies' });
  }
});

/**
 * DESTRUCTIVE: wipe every sync-agent-populated vcfo_* table for the current
 * tenant so a fresh Tally sync can start from a clean slate. Intended for
 * debugging "is the data wrong because of bad ingest logic, or because it
 * was imported during a previous buggy build?" scenarios.
 *
 * Scope: only the tenant resolved by `resolveTenant` middleware (the session's
 * active client). Never cross-tenant.
 *
 * Safety:
 *   - Requires `admin` or `super_admin` session role.
 *   - Requires body `{ confirm: "DELETE" }` — a misfiring script or curl
 *     without the literal confirmation string hits a 400.
 *   - Runs inside a transaction so a failure mid-way rolls back.
 *   - Does NOT touch platform.db (agent keys, mappings) or any non-vcfo table.
 */
router.delete('/data', requireAdmin, async (req, res) => {
  if (req.body?.confirm !== 'DELETE') {
    return res.status(400).json({
      error: 'Missing confirmation. POST/DELETE body must be { "confirm": "DELETE" }',
    });
  }
  if (!req.tenantDb) {
    return res.status(500).json({ error: 'Tenant DB not resolved' });
  }

  const tables = [
    'vcfo_trial_balance',
    'vcfo_stock_summary',
    'vcfo_vouchers',
    'vcfo_account_groups',
    'vcfo_ledgers',
    'vcfo_companies', // last — other tables FK to this
  ];
  const counts: Record<string, number> = {};

  try {
    req.tenantDb.beginBatch();
    try {
      for (const t of tables) {
        try {
          const before = req.tenantDb.get(`SELECT COUNT(*) AS n FROM ${t}`) as { n: number };
          req.tenantDb.run(`DELETE FROM ${t}`);
          counts[t] = before?.n ?? 0;
        } catch (e: any) {
          // Table may not exist on very old tenants; log and continue.
          counts[t] = -1;
        }
      }
      req.tenantDb.endBatch();
    } catch (e) {
      req.tenantDb.rollbackBatch();
      throw e;
    }

    // Reclaim freed pages (VACUUM cannot run inside a transaction).
    try { req.tenantDb.exec('VACUUM'); } catch { /* non-fatal */ }

    console.log(
      `[vcfo-reports] /data DELETE by ${req.session?.username || req.session?.userId} slug=${req.tenantSlug}`,
      counts,
    );
    res.json({
      ok: true,
      tenantSlug: req.tenantSlug,
      cleared: counts,
    });
  } catch (err: any) {
    console.error('[vcfo-reports] /data DELETE error', err);
    res.status(500).json({ error: err?.message || 'Wipe failed' });
  }
});

router.get('/trial-balance', async (req, res) => {
  try {
    const companies = await resolveCompanyRefs(req);
    const from = requireDate(req.query.from, 'from');
    const to = requireDate(req.query.to, 'to');
    const report = buildTrialBalanceMulti(req.tenantDb!, companies, from, to);
    res.json(report);
  } catch (err: any) {
    console.error('[vcfo-reports] /trial-balance error', err);
    res.status(400).json({ error: err?.message || 'Failed to build trial balance' });
  }
});

router.get('/profit-loss', async (req, res) => {
  try {
    const companies = await resolveCompanyRefs(req);
    const from = requireDate(req.query.from, 'from');
    const to = requireDate(req.query.to, 'to');
    const view = validView(req.query.view);
    const bifurcate = validBool(req.query.bifurcate);
    const report = buildProfitLossMulti(req.tenantDb!, companies, from, to, view, bifurcate);
    res.json(report);
  } catch (err: any) {
    console.error('[vcfo-reports] /profit-loss error', err);
    res.status(400).json({ error: err?.message || 'Failed to build profit & loss' });
  }
});

router.get('/balance-sheet', async (req, res) => {
  try {
    const companies = await resolveCompanyRefs(req);
    const asOf = requireDate(req.query.asOf, 'asOf');
    const view = validView(req.query.view);
    const rangeFrom = req.query.from ? requireDate(req.query.from, 'from') : undefined;
    const bifurcate = validBool(req.query.bifurcate);
    const report = buildBalanceSheetMulti(req.tenantDb!, companies, asOf, view, rangeFrom, bifurcate);
    res.json(report);
  } catch (err: any) {
    console.error('[vcfo-reports] /balance-sheet error', err);
    res.status(400).json({ error: err?.message || 'Failed to build balance sheet' });
  }
});

router.get('/cash-flow', async (req, res) => {
  try {
    const companies = await resolveCompanyRefs(req);
    const from = requireDate(req.query.from, 'from');
    const to = requireDate(req.query.to, 'to');
    const bifurcate = validBool(req.query.bifurcate);
    const report = buildCashFlowMulti(req.tenantDb!, companies, from, to, bifurcate);
    res.json(report);
  } catch (err: any) {
    console.error('[vcfo-reports] /cash-flow error', err);
    res.status(400).json({ error: err?.message || 'Failed to build cash flow' });
  }
});

/**
 * Download endpoint — one URL, dispatched by `report` + `format`. The same
 * query params the JSON endpoints accept apply here.
 *   /download?report=tb|pl|bs|cf&format=xlsx|pdf|docx&companyId=…&from=…&to=…
 * For BS, use `asOf` instead of `to`.
 */
router.get('/download', async (req, res) => {
  try {
    const report = String(req.query.report || '').toLowerCase();
    const format = String(req.query.format || '').toLowerCase();
    if (!['tb', 'pl', 'bs', 'cf'].includes(report)) {
      return res.status(400).json({ error: 'report must be tb | pl | bs | cf' });
    }
    if (!['xlsx', 'pdf', 'docx'].includes(format)) {
      return res.status(400).json({ error: 'format must be xlsx | pdf | docx' });
    }

    const companies = await resolveCompanyRefs(req);
    if (companies.length === 0) return res.status(404).json({ error: 'No companies accessible' });
    const bifurcate = validBool(req.query.bifurcate);

    // Build the requested report
    let built: any;
    let dateLabel: string;
    if (report === 'tb') {
      const from = requireDate(req.query.from, 'from');
      const to = requireDate(req.query.to, 'to');
      built = buildTrialBalanceMulti(req.tenantDb!, companies, from, to);
      dateLabel = `${from}_${to}`;
    } else if (report === 'pl') {
      const from = requireDate(req.query.from, 'from');
      const to = requireDate(req.query.to, 'to');
      const view = validView(req.query.view);
      built = buildProfitLossMulti(req.tenantDb!, companies, from, to, view, bifurcate);
      dateLabel = `${from}_${to}`;
    } else if (report === 'bs') {
      const asOf = requireDate(req.query.asOf, 'asOf');
      const view = validView(req.query.view);
      const rangeFrom = req.query.from ? requireDate(req.query.from, 'from') : undefined;
      built = buildBalanceSheetMulti(req.tenantDb!, companies, asOf, view, rangeFrom, bifurcate);
      dateLabel = `as_of_${asOf}`;
    } else {
      const from = requireDate(req.query.from, 'from');
      const to = requireDate(req.query.to, 'to');
      built = buildCashFlowMulti(req.tenantDb!, companies, from, to, bifurcate);
      dateLabel = `${from}_${to}`;
    }

    const ctx = {
      companyName: companies.length === 1
        ? companies[0].name
        : `${companies.length}_companies`,
      reportKind: report as 'tb' | 'pl' | 'bs' | 'cf',
    };

    let buffer: Buffer;
    let contentType: string;
    let ext: string;
    if (format === 'xlsx') {
      buffer = await renderXlsx(ctx, built);
      contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      ext = 'xlsx';
    } else if (format === 'pdf') {
      buffer = await renderPdf(ctx, built);
      contentType = 'application/pdf';
      ext = 'pdf';
    } else {
      buffer = await renderDocx(ctx, built);
      contentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      ext = 'docx';
    }

    const safeName = ctx.companyName.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '');
    const fname = `${safeName}_${report}_${dateLabel}.${ext}`;
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.send(buffer);
  } catch (err: any) {
    console.error('[vcfo-reports] /download error', err);
    res.status(500).json({ error: err?.message || 'Failed to generate download' });
  }
});

export default router;
