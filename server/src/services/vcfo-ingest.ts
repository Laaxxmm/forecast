// ─────────────────────────────────────────────────────────────────────────────
// Shared vCFO ingest layer.
//
// The canonical, idempotent upserts that write synced financial data into a
// tenant DB's vcfo_* tables. Extracted from routes/ingest.ts (the sync-agent
// HTTP endpoint) so that OTHER producers — notably the Zoho Books runner
// (services/zoho/runner.ts) — write through the EXACT same code path and
// idempotency guarantees rather than a divergent copy.
//
// Idempotency per kind (unchanged from the original ingest route):
//   companies            → INSERT ... ON CONFLICT(name) DO UPDATE
//   ledgers              → INSERT OR REPLACE  by (company_id, name)
//   groups               → INSERT OR REPLACE  by (company_id, group_name)
//   vouchers             → DELETE by (company_id, sync_month) THEN INSERT
//   stockSummary         → INSERT OR REPLACE  by (company_id, period_from, period_to, item_name)
//   trialBalance         → INSERT OR REPLACE  by (company_id, period_from, period_to, ledger_name)
//   voucherLedgerEntries → DELETE by (company_id, sync_month) THEN INSERT
//   fyOpeningBalances    → INSERT OR REPLACE  by (company_id, fy_start, ledger_name)
//   stockMonthlyBalances → INSERT OR REPLACE  by (company_id, as_of_date, ledger_name)
//
// Why DELETE-then-INSERT for voucher tables: their UNIQUE keys include the
// amount columns (debit/credit on voucherLedgerEntries, amount on vouchers)
// to support the legitimate "same ledger appears twice in one voucher with
// different amounts" case. That makes plain INSERT OR IGNORE non-idempotent
// under EDITS — when a voucher's amount changes upstream, the new value lands
// as a "different" unique row alongside the stale one, double-counting in
// every report. Wiping the (company, sync_month) bucket before inserting the
// freshly-pulled batch keeps the table in sync even when prior vouchers were
// edited or deleted.
// ─────────────────────────────────────────────────────────────────────────────

import { DbHelper } from '../db/connection.js';

/**
 * Look up (or auto-create) the vcfo_companies row for a given company name in
 * the current tenant DB. New companies default to April-starting FY which
 * matches Indian financial conventions; the operator can rename/adjust later
 * via the mapping UI.
 */
export function resolveCompanyId(db: DbHelper, companyName: string): number | null {
  if (!companyName) return null;
  const existing = db.get('SELECT id FROM vcfo_companies WHERE name = ?', companyName);
  if (existing) return existing.id;
  const result = db.run(
    'INSERT INTO vcfo_companies (name, fy_start_month, is_active) VALUES (?, 4, 1)',
    companyName,
  );
  return result.lastInsertRowid ?? null;
}

/**
 * Stamp `last_full_sync_at` whenever any batch lands for a company so the
 * `/api/vcfo/companies` endpoint can (a) filter out seed/ghost rows that
 * have never received data and (b) order by "most recently active" for
 * auto-selection in the UI.
 */
export function bumpLastSyncedAt(db: DbHelper, companyId: number): void {
  try {
    db.run(
      `UPDATE vcfo_companies SET last_full_sync_at = datetime('now') WHERE id = ?`,
      companyId,
    );
  } catch {
    // Non-fatal — older tenant DBs that haven't run the ALTER migration
    // will throw "no such column" here; don't let that block the ingest.
  }
}

export function ingestCompanies(db: DbHelper, rows: any[]): number {
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

export function ingestLedgers(db: DbHelper, companyId: number, rows: any[]): number {
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

export function ingestVouchers(db: DbHelper, companyId: number, rows: any[]): number {
  let n = 0;
  db.beginBatch();
  try {
    // Wipe the (company, sync_month) buckets present in this batch before
    // inserting. See header comment for the rationale — INSERT OR IGNORE
    // with `amount` in the UNIQUE key is not idempotent under voucher edits.
    const months = new Set<string>();
    for (const r of rows) {
      if (!r?.date || !r?.ledgerName) continue;
      months.add(String(r.date).slice(0, 7));
    }
    if (months.size > 0) {
      const placeholders = Array.from(months).map(() => '?').join(',');
      db.run(
        `DELETE FROM vcfo_vouchers
         WHERE company_id = ? AND sync_month IN (${placeholders})`,
        companyId,
        ...Array.from(months),
      );
    }

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
 * Chart-of-accounts. REPLACE lets producers re-sync classification changes (a
 * group migrating BS ↔ PL). CHECK constraints on bs_pl/dr_cr/affects_gross_profit
 * reject anything outside the canonical letters, so we defensively normalize
 * before insert.
 */
export function ingestGroups(db: DbHelper, companyId: number, rows: any[]): number {
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
export function ingestStockSummary(db: DbHelper, companyId: number, rows: any[]): number {
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
export function ingestTrialBalance(db: DbHelper, companyId: number, rows: any[]): number {
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

/**
 * Voucher-level ledger entries — one row per (voucher, ledger allocation).
 * Feeds the dynamic-TB service which composes any date range from these plus
 * FY-start openings. All lines of one voucher that hit the same ledger are
 * aggregated into a single summed row before insert (see below), so the
 * UNIQUE(... debit, credit) can never silently drop a repeated line.
 *
 * Idempotency under edits: we DELETE all existing rows for the (company_id,
 * sync_month) buckets present in the batch before inserting. The producer
 * always re-emits a full month's worth of entries, so wiping that bucket
 * first keeps the table in lock-step even when vouchers were edited, deleted,
 * or renumbered upstream.
 */
export function ingestVoucherLedgerEntries(db: DbHelper, companyId: number, rows: any[]): number {
  const num = (v: any) => (v == null ? 0 : Number(v) || 0);
  let n = 0;
  db.beginBatch();
  try {
    const months = new Set<string>();
    for (const r of rows) {
      if (!r?.voucherDate || !r?.ledgerName) continue;
      months.add(String(r.voucherDate).slice(0, 7));
    }
    if (months.size > 0) {
      const placeholders = Array.from(months).map(() => '?').join(',');
      db.run(
        `DELETE FROM vcfo_voucher_ledger_entries
         WHERE company_id = ? AND sync_month IN (${placeholders})`,
        companyId,
        ...Array.from(months),
      );
    }

    // Aggregate per (voucher_date, voucher_type, voucher_number, ledger_name),
    // summing debit + credit, BEFORE inserting. The table's UNIQUE(... debit,
    // credit) + INSERT OR IGNORE silently DROPS a second line when one voucher
    // posts the same ledger with the same amount twice (a common Tally pattern
    // — a payment settling two equal bills, two cost-centre splits of the same
    // value). That under-counts the ledger by the dropped line's amount.
    // Collapsing each voucher-ledger pair into one summed row makes the SUM
    // exact; dynamic-TB only ever reads SUM(debit)/SUM(credit) per ledger, so
    // aggregating loses nothing the reports care about.
    const agg = new Map<string, {
      date: string; type: string; number: string; ledger: string;
      debit: number; credit: number; isParty: number;
      narration: string | null; syncMonth: string;
    }>();
    for (const r of rows) {
      if (!r?.voucherDate || !r?.ledgerName) continue;
      const date = String(r.voucherDate);
      const type = r.voucherType ? String(r.voucherType) : '';
      const number = r.voucherNumber ? String(r.voucherNumber) : '';
      const ledger = String(r.ledgerName).trim();
      const key = `${date} ${type} ${number} ${ledger}`;
      let e = agg.get(key);
      if (!e) {
        e = {
          date, type, number, ledger,
          debit: 0, credit: 0,
          isParty: r.isPartyLedger ? 1 : 0,
          narration: r.narration ? String(r.narration) : null,
          syncMonth: date.slice(0, 7),
        };
        agg.set(key, e);
      }
      e.debit += num(r.debit);
      e.credit += num(r.credit);
      if (r.isPartyLedger) e.isParty = 1;
      if (!e.narration && r.narration) e.narration = String(r.narration);
    }

    for (const e of agg.values()) {
      db.run(
        `INSERT OR IGNORE INTO vcfo_voucher_ledger_entries
           (company_id, voucher_date, voucher_type, voucher_number, ledger_name,
            debit, credit, is_party_ledger, narration, sync_month)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          companyId,
          e.date,
          e.type,
          e.number,
          e.ledger,
          e.debit,
          e.credit,
          e.isParty,
          e.narration,
          e.syncMonth,
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
 * FY-start opening balances — one row per (company, fy_start, ledger). REPLACE
 * because a re-pull must pick up any back-dated openings posted upstream after
 * the last sync. Credit-positive convention matches
 * vcfo_trial_balance.opening_balance.
 */
export function ingestFyOpeningBalances(db: DbHelper, companyId: number, rows: any[]): number {
  const num = (v: any) => (v == null ? 0 : Number(v) || 0);
  let n = 0;
  db.beginBatch();
  try {
    for (const r of rows) {
      if (!r?.fyStart || !r?.ledgerName) continue;
      db.run(
        `INSERT OR REPLACE INTO vcfo_fy_opening_balances
           (company_id, fy_start, ledger_name, group_name, opening_balance)
         VALUES (?, ?, ?, ?, ?)`,
        [
          companyId,
          String(r.fyStart),
          String(r.ledgerName).trim(),
          r.groupName ? String(r.groupName) : null,
          num(r.openingBalance),
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

export function ingestStockMonthlyBalances(db: DbHelper, companyId: number, rows: any[]): number {
  const num = (v: any) => (v == null ? 0 : Number(v) || 0);
  let n = 0;
  db.beginBatch();
  try {
    for (const r of rows) {
      if (!r?.asOfDate || !r?.ledgerName) continue;
      db.run(
        `INSERT OR REPLACE INTO vcfo_stock_closing_balances
           (company_id, as_of_date, ledger_name, group_name, closing_value)
         VALUES (?, ?, ?, ?, ?)`,
        [
          companyId,
          String(r.asOfDate),
          String(r.ledgerName).trim(),
          r.groupName ? String(r.groupName) : null,
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
