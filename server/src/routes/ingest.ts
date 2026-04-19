// ─────────────────────────────────────────────────────────────────────────────
// Sync-agent ingest routes (Slice 5a).
//
// Re-home of TallyVision's `/api/ingest/*` endpoints into the main app. The
// desktop VCFO Sync agent POSTs to these endpoints on every sync tick; each
// request carries `Authorization: Bearer vcfo_live_...` and is scoped to the
// key's client via `requireAgentKey`.
//
// Endpoints:
//   POST /api/ingest/ping   — handshake. No writes, just echoes server time.
//   POST /api/ingest/batch  — bulk upsert. Dispatches on body.kind to the
//                             appropriate vcfo_* table in the tenant DB.
//
// Idempotency: each kind uses the same upsert semantics as TallyVision so
// agents can safely re-push the same window without creating duplicates.
//   companies    → INSERT ... ON CONFLICT(name) DO UPDATE
//   ledgers      → INSERT OR REPLACE  by (company_id, name)
//   groups       → INSERT OR REPLACE  by (company_id, group_name)
//   vouchers     → INSERT OR IGNORE   by the composite voucher UNIQUE index
//   stockSummary → INSERT OR REPLACE  by (company_id, period_from, period_to, item_name)
//   trialBalance → INSERT OR REPLACE  by (company_id, period_from, period_to, ledger_name)
// ─────────────────────────────────────────────────────────────────────────────

import { Router, Request, Response } from 'express';
import { requireAgentKey } from '../middleware/agentKey.js';
import { DbHelper } from '../db/connection.js';

const router = Router();

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Look up (or auto-create) the vcfo_companies row for a given Tally company
 * name in the current tenant DB. New companies default to April-starting FY
 * which matches Indian financial conventions; the operator can rename/adjust
 * later via the mapping UI.
 */
function resolveCompanyId(db: DbHelper, companyName: string): number | null {
  if (!companyName) return null;
  const existing = db.get('SELECT id FROM vcfo_companies WHERE name = ?', companyName);
  if (existing) return existing.id;
  const result = db.run(
    'INSERT INTO vcfo_companies (name, fy_start_month, is_active) VALUES (?, 4, 1)',
    companyName,
  );
  return result.lastInsertRowid ?? null;
}

function ingestCompanies(db: DbHelper, rows: any[]): number {
  let n = 0;
  db.beginBatch();
  try {
    for (const r of rows) {
      if (!r?.name) continue;
      db.run(
        `INSERT INTO vcfo_companies (name, fy_start_month, is_active)
         VALUES (?, 4, 1)
         ON CONFLICT(name) DO UPDATE SET is_active = 1`,
        String(r.name).trim(),
      );
      n++;
    }
    db.endBatch();
  } catch (e) {
    db.rollbackBatch();
    throw e;
  }
  return n;
}

function ingestLedgers(db: DbHelper, companyId: number, rows: any[]): number {
  let n = 0;
  db.beginBatch();
  try {
    for (const r of rows) {
      if (!r?.name) continue;
      db.run(
        `INSERT OR REPLACE INTO vcfo_ledgers
           (company_id, name, group_name, parent_group)
         VALUES (?, ?, ?, ?)`,
        [
          companyId,
          String(r.name).trim(),
          r.group ? String(r.group) : null,
          r.parent ? String(r.parent) : null,
        ],
      );
      n++;
    }
    db.endBatch();
  } catch (e) {
    db.rollbackBatch();
    throw e;
  }
  return n;
}

function ingestVouchers(db: DbHelper, companyId: number, rows: any[]): number {
  let n = 0;
  db.beginBatch();
  try {
    for (const r of rows) {
      if (!r?.date || !r?.ledgerName) continue;
      const syncMonth = String(r.date).slice(0, 7); // YYYY-MM
      db.run(
        `INSERT OR IGNORE INTO vcfo_vouchers
           (company_id, date, voucher_type, voucher_number, ledger_name,
            amount, party_name, narration, sync_month)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          companyId,
          String(r.date),
          r.voucherType ? String(r.voucherType) : '',
          r.voucherNumber ? String(r.voucherNumber) : '',
          String(r.ledgerName),
          Number(r.amount) || 0,
          r.partyName ? String(r.partyName) : null,
          r.narration ? String(r.narration) : null,
          syncMonth,
        ],
      );
      n++;
    }
    db.endBatch();
  } catch (e) {
    db.rollbackBatch();
    throw e;
  }
  return n;
}

/**
 * Chart-of-accounts. REPLACE lets agents re-sync classification changes (a
 * group migrating BS ↔ PL). CHECK constraints on bs_pl/dr_cr/affects_gross_profit
 * reject anything outside the canonical letters, so we defensively normalize
 * before insert.
 */
function ingestGroups(db: DbHelper, companyId: number, rows: any[]): number {
  const norm = (val: any, allowed: string[]): string | null => {
    if (!val) return null;
    const s = String(val).trim().toUpperCase();
    return allowed.includes(s) ? s : null;
  };
  let n = 0;
  db.beginBatch();
  try {
    for (const r of rows) {
      const name = r?.name ? String(r.name).trim() : '';
      if (!name) continue;
      db.run(
        `INSERT OR REPLACE INTO vcfo_account_groups
           (company_id, group_name, parent_group, bs_pl, dr_cr, affects_gross_profit)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          companyId,
          name,
          r.parent ? String(r.parent) : null,
          norm(r.bsPl, ['BS', 'PL']),
          norm(r.drCr, ['D', 'C']),
          norm(r.affectsGrossProfit, ['Y', 'N']),
        ],
      );
      n++;
    }
    db.endBatch();
  } catch (e) {
    db.rollbackBatch();
    throw e;
  }
  return n;
}

/**
 * Stock summary — per-item opening/inward/outward/closing for a time window.
 * REPLACE is correct: re-syncing a quarter with busier data legitimately
 * updates the closing numbers. UNIQUE on (company, window, item) keeps the
 * table at one row per item per window.
 */
function ingestStockSummary(db: DbHelper, companyId: number, rows: any[]): number {
  const num = (v: any) => (v == null ? 0 : Number(v) || 0);
  let n = 0;
  db.beginBatch();
  try {
    for (const r of rows) {
      if (!r?.itemName || !r?.periodFrom || !r?.periodTo) continue;
      db.run(
        `INSERT OR REPLACE INTO vcfo_stock_summary
           (company_id, period_from, period_to, item_name, stock_group,
            opening_qty, opening_value, inward_qty, inward_value,
            outward_qty, outward_value, closing_qty, closing_value)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          companyId,
          String(r.periodFrom),
          String(r.periodTo),
          String(r.itemName).trim(),
          r.stockGroup ? String(r.stockGroup) : null,
          num(r.openingQty), num(r.openingValue),
          num(r.inwardQty),  num(r.inwardValue),
          num(r.outwardQty), num(r.outwardValue),
          num(r.closingQty), num(r.closingValue),
        ],
      );
      n++;
    }
    db.endBatch();
  } catch (e) {
    db.rollbackBatch();
    throw e;
  }
  return n;
}

/**
 * Trial balance — per-ledger opening/debit/credit/closing for a window.
 * Primary data source for every financial report; REPLACE so a re-sync of
 * the same window cleanly updates the numbers.
 */
function ingestTrialBalance(db: DbHelper, companyId: number, rows: any[]): number {
  const num = (v: any) => (v == null ? 0 : Number(v) || 0);
  let n = 0;
  db.beginBatch();
  try {
    for (const r of rows) {
      if (!r?.ledgerName || !r?.periodFrom || !r?.periodTo) continue;
      db.run(
        `INSERT OR REPLACE INTO vcfo_trial_balance
           (company_id, period_from, period_to, ledger_name, group_name,
            opening_balance, net_debit, net_credit, closing_balance)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          companyId,
          String(r.periodFrom),
          String(r.periodTo),
          String(r.ledgerName).trim(),
          r.groupName ? String(r.groupName) : null,
          num(r.openingBalance),
          num(r.netDebit),
          num(r.netCredit),
          num(r.closingBalance),
        ],
      );
      n++;
    }
    db.endBatch();
  } catch (e) {
    db.rollbackBatch();
    throw e;
  }
  return n;
}

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
 *     kind: 'companies' | 'ledgers' | 'vouchers' | 'groups' | 'stockSummary' | 'trialBalance',
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
    } else if (
      kind === 'ledgers' ||
      kind === 'vouchers' ||
      kind === 'groups' ||
      kind === 'stockSummary' ||
      kind === 'trialBalance'
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
      else accepted = ingestTrialBalance(req.tenantDb, companyId, rows);
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
