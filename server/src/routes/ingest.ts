// ─────────────────────────────────────────────────────────────────────────────
// Sync-agent ingest routes (Slice 5a).
//
// The desktop VCFO Sync agent POSTs to these endpoints on every sync tick;
// each request carries `Authorization: Bearer vcfo_live_...` and is scoped to
// the key's client via `requireAgentKey`.
//
// Endpoints:
//   POST /api/ingest/ping   — handshake. No writes, just echoes server time.
//   POST /api/ingest/batch  — bulk upsert. Dispatches on body.kind to the
//                             appropriate vcfo_* table in the tenant DB.
//
// The actual upsert logic now lives in services/vcfo-ingest.ts so the Zoho
// Books runner can write through the exact same idempotent code path. This
// file is just the agent-authenticated HTTP shell over those helpers.
// ─────────────────────────────────────────────────────────────────────────────

import { Router, Request, Response } from 'express';
import { requireAgentKey } from '../middleware/agentKey.js';
import {
  resolveCompanyId,
  bumpLastSyncedAt,
  ingestCompanies,
  ingestLedgers,
  ingestVouchers,
  ingestGroups,
  ingestStockSummary,
  ingestTrialBalance,
  ingestVoucherLedgerEntries,
  ingestFyOpeningBalances,
  ingestStockMonthlyBalances,
} from '../services/vcfo-ingest.js';

const router = Router();

// ─── Routes ─────────────────────────────────────────────────────────────────

/** Handshake — verifies the key works and reports server identity back. */
router.post('/ping', requireAgentKey, (req: Request, res: Response) => {
  const { agentVersion, tally } = req.body || {};
  console.log(
    `[ingest/ping] agent=${agentVersion || '?'} slug=${req.tenantSlug}`
    + ` tally=${tally?.reachable ? (tally.version || 'ok') : 'offline'}`
    + ` companies=${tally?.companies?.length ?? 0}`,
  );
  res.json({
    ok: true,
    rowsAccepted: 0,
    message: `Handshake received from agent ${agentVersion || 'unknown'}`,
    tenantSlug: req.tenantSlug,
    serverTime: new Date().toISOString(),
  });
});

/**
 * Bulk upsert entry point. Body:
 *   {
 *     kind: 'companies' | 'ledgers' | 'vouchers' | 'groups' | 'stockSummary' | 'trialBalance' | 'voucherLedgerEntries' | 'fyOpeningBalances' | 'stockMonthlyBalances',
 *     companyName?: string,  // required for everything except 'companies'
 *     rows: Array<object>    // shape depends on `kind`
 *   }
 */
router.post('/batch', requireAgentKey, (req: Request, res: Response) => {
  const { kind, companyName, rows } = req.body || {};
  if (!kind || !Array.isArray(rows)) {
    return res.status(400).json({ error: 'Expected { kind, rows: [...] }' });
  }
  if (!req.tenantDb) {
    return res.status(500).json({ error: 'Tenant DB not resolved' });
  }

  try {
    let accepted = 0;
    let companyId: number | null = null;

    if (kind === 'companies') {
      accepted = ingestCompanies(req.tenantDb, rows);
      // Stamp every company we just accepted so seed/ghost rows get filtered
      // out of the UI dropdown once their first real data lands.
      for (const r of rows) {
        if (!r?.name) continue;
        const row = req.tenantDb.get(
          'SELECT id FROM vcfo_companies WHERE name = ?',
          String(r.name).trim(),
        );
        if (row?.id) bumpLastSyncedAt(req.tenantDb, row.id);
      }
    } else if (
      kind === 'ledgers' ||
      kind === 'vouchers' ||
      kind === 'groups' ||
      kind === 'stockSummary' ||
      kind === 'trialBalance' ||
      kind === 'voucherLedgerEntries' ||
      kind === 'fyOpeningBalances' ||
      kind === 'stockMonthlyBalances'
    ) {
      if (!companyName) {
        return res.status(400).json({ error: 'companyName required for ' + kind });
      }
      companyId = resolveCompanyId(req.tenantDb, String(companyName));
      if (!companyId) {
        return res.status(500).json({ error: 'Failed to resolve company' });
      }
      if (kind === 'ledgers') accepted = ingestLedgers(req.tenantDb, companyId, rows);
      else if (kind === 'vouchers') accepted = ingestVouchers(req.tenantDb, companyId, rows);
      else if (kind === 'groups') accepted = ingestGroups(req.tenantDb, companyId, rows);
      else if (kind === 'stockSummary') accepted = ingestStockSummary(req.tenantDb, companyId, rows);
      else if (kind === 'trialBalance') accepted = ingestTrialBalance(req.tenantDb, companyId, rows);
      else if (kind === 'voucherLedgerEntries') accepted = ingestVoucherLedgerEntries(req.tenantDb, companyId, rows);
      else if (kind === 'fyOpeningBalances') accepted = ingestFyOpeningBalances(req.tenantDb, companyId, rows);
      else accepted = ingestStockMonthlyBalances(req.tenantDb, companyId, rows);
      // Any successful child-entity push marks this company as "active" so
      // the UI auto-selection picks the most recently touched one.
      if (accepted > 0) bumpLastSyncedAt(req.tenantDb, companyId);
    } else {
      return res.status(400).json({ error: `Unknown kind: ${kind}` });
    }

    console.log(
      `[ingest/batch] slug=${req.tenantSlug} kind=${kind}`
      + `${companyName ? ' company=' + companyName : ''} accepted=${accepted}/${rows.length}`,
    );
    res.json({
      ok: true,
      kind,
      rowsReceived: rows.length,
      rowsAccepted: accepted,
      companyId,
      serverTime: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error('[ingest/batch] error', err);
    res.status(500).json({ error: err?.message || 'Ingest failed' });
  }
});

export default router;
