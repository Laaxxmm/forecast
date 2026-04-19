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
import {
  buildTrialBalance,
  buildProfitLoss,
  buildBalanceSheet,
  buildCashFlow,
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

  // Pull all active companies from the tenant DB
  const companies = db.all(
    `SELECT id, name, location, entity_type, last_full_sync_at
     FROM vcfo_companies
     WHERE is_active = 1
     ORDER BY name`,
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

router.get('/trial-balance', async (req, res) => {
  try {
    const companyId = requireInt(req.query.companyId, 'companyId');
    const from = requireDate(req.query.from, 'from');
    const to = requireDate(req.query.to, 'to');
    const report = buildTrialBalance(req.tenantDb!, companyId, from, to);
    res.json(report);
  } catch (err: any) {
    console.error('[vcfo-reports] /trial-balance error', err);
    res.status(400).json({ error: err?.message || 'Failed to build trial balance' });
  }
});

router.get('/profit-loss', async (req, res) => {
  try {
    const companyId = requireInt(req.query.companyId, 'companyId');
    const from = requireDate(req.query.from, 'from');
    const to = requireDate(req.query.to, 'to');
    const view = validView(req.query.view);
    const report = buildProfitLoss(req.tenantDb!, companyId, from, to, view);
    res.json(report);
  } catch (err: any) {
    console.error('[vcfo-reports] /profit-loss error', err);
    res.status(400).json({ error: err?.message || 'Failed to build profit & loss' });
  }
});

router.get('/balance-sheet', async (req, res) => {
  try {
    const companyId = requireInt(req.query.companyId, 'companyId');
    const asOf = requireDate(req.query.asOf, 'asOf');
    const view = validView(req.query.view);
    const rangeFrom = req.query.from ? requireDate(req.query.from, 'from') : undefined;
    const report = buildBalanceSheet(req.tenantDb!, companyId, asOf, view, rangeFrom);
    res.json(report);
  } catch (err: any) {
    console.error('[vcfo-reports] /balance-sheet error', err);
    res.status(400).json({ error: err?.message || 'Failed to build balance sheet' });
  }
});

router.get('/cash-flow', async (req, res) => {
  try {
    const companyId = requireInt(req.query.companyId, 'companyId');
    const from = requireDate(req.query.from, 'from');
    const to = requireDate(req.query.to, 'to');
    const report = buildCashFlow(req.tenantDb!, companyId, from, to);
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

    const companyId = requireInt(req.query.companyId, 'companyId');
    const company = req.tenantDb!.get(
      'SELECT id, name FROM vcfo_companies WHERE id = ?',
      companyId,
    );
    if (!company) return res.status(404).json({ error: 'Company not found' });

    // Build the requested report
    let built: any;
    let dateLabel: string;
    if (report === 'tb') {
      const from = requireDate(req.query.from, 'from');
      const to = requireDate(req.query.to, 'to');
      built = buildTrialBalance(req.tenantDb!, companyId, from, to);
      dateLabel = `${from}_${to}`;
    } else if (report === 'pl') {
      const from = requireDate(req.query.from, 'from');
      const to = requireDate(req.query.to, 'to');
      const view = validView(req.query.view);
      built = buildProfitLoss(req.tenantDb!, companyId, from, to, view);
      dateLabel = `${from}_${to}`;
    } else if (report === 'bs') {
      const asOf = requireDate(req.query.asOf, 'asOf');
      const view = validView(req.query.view);
      const rangeFrom = req.query.from ? requireDate(req.query.from, 'from') : undefined;
      built = buildBalanceSheet(req.tenantDb!, companyId, asOf, view, rangeFrom);
      dateLabel = `as_of_${asOf}`;
    } else {
      const from = requireDate(req.query.from, 'from');
      const to = requireDate(req.query.to, 'to');
      built = buildCashFlow(req.tenantDb!, companyId, from, to);
      dateLabel = `${from}_${to}`;
    }

    const ctx = {
      companyName: (company as any).name || 'Company',
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
