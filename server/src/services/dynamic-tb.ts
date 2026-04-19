// ─────────────────────────────────────────────────────────────────────────────
// Dynamic Trial Balance service.
//
// Replaces the stored-quarterly `vcfo_trial_balance` as the primary data source
// for the four VCFO financial reports (TB / P&L / BS / Cash Flow). Every
// caller asks for balances over an arbitrary [fromDate, toDate] window; the
// service composes:
//
//     opening(as-of fromDate)  = fy_opening + SUM(credit-debit) over [fyStart, fromDate)
//     movement(fromDate..toDate)= SUM(debit), SUM(credit) over [fromDate, toDate]
//     closing(as-of toDate)    = opening + (credit - debit) during the window
//
// from voucher-level allocations in `vcfo_voucher_ledger_entries` plus the
// once-per-FY snapshot in `vcfo_fy_opening_balances`. All amounts follow the
// credit-positive convention (`closing = opening + credit - debit`) so the
// result is drop-in compatible with the old TB shape that every report
// builder consumes.
//
// Why day-precision: the legacy pipeline stored quarterly snapshots, so any
// FY start that didn't land on a quarter boundary (e.g. 2026-04-04) fell
// through strict-containment SQL filters and rendered as zero. Going
// voucher-level removes the quarter alignment assumption entirely.
// ─────────────────────────────────────────────────────────────────────────────

import { DbHelper } from '../db/connection.js';

export interface LedgerBalance {
  ledgerName: string;
  groupName: string | null;
  /** Revised opening balance as of `fromDate` (credit-positive). */
  opening: number;
  /** Magnitude of all debit entries within the window. */
  debit: number;
  /** Magnitude of all credit entries within the window. */
  credit: number;
  /** Closing balance as of `toDate` (credit-positive). */
  closing: number;
}

/**
 * Add `days` to a YYYY-MM-DD string and return the resulting YYYY-MM-DD.
 * Used to derive the "day before fromDate" bound for the pre-period aggregate.
 */
function addDays(isoDate: string, days: number): string {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Derive the Indian FY start (YYYY-04-01) that contains a given date.
 * Example: '2026-07-15' → '2026-04-01'; '2026-02-10' → '2025-04-01'.
 */
export function fyStartFor(isoDate: string): string {
  const d = new Date(isoDate + 'T00:00:00Z');
  const year = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return `${year}-04-01`;
}

/**
 * Core primitive: per-ledger opening, debit, credit, closing over
 * [fromDate, toDate] for a single company. `fyStart` anchors the opening
 * snapshot — callers typically derive it with `fyStartFor(fromDate)`.
 *
 * Returns every ledger that has either a non-zero opening OR any activity
 * in the window. Ledgers with both zero opening and zero movement are
 * filtered out — they'd contribute nothing to any report.
 */
export function computeDynamicTB(
  db: DbHelper,
  companyId: number,
  fromDate: string,
  toDate: string,
  fyStart: string,
): LedgerBalance[] {
  // One CTE-based query so SQLite can fuse the three scans over
  // vcfo_voucher_ledger_entries into a single pass per ledger. Credit-positive
  // throughout: opening + (credit - debit) = closing.
  // Three scans over vcfo_voucher_ledger_entries:
  //   base — every ledger that has touched any voucher up to `toDate` OR has
  //          an FY-opening snapshot. Group name is pulled from vcfo_ledgers
  //          (chart-of-accounts) with fallback to the opening snapshot.
  //   pre  — cumulative movement from [fyStart, fromDate) to roll the FY
  //          opening forward into a period opening.
  //   cur  — magnitudes within [fromDate, toDate] (inclusive both ends).
  const sql = `
    WITH base AS (
      SELECT DISTINCT ledger_name
      FROM vcfo_voucher_ledger_entries
      WHERE company_id = ? AND voucher_date <= ?
      UNION
      SELECT ledger_name
      FROM vcfo_fy_opening_balances
      WHERE company_id = ? AND fy_start = ?
    ),
    pre AS (
      SELECT ledger_name,
             SUM(credit) - SUM(debit) AS delta
      FROM vcfo_voucher_ledger_entries
      WHERE company_id = ?
        AND voucher_date >= ?
        AND voucher_date < ?
      GROUP BY ledger_name
    ),
    cur AS (
      SELECT ledger_name,
             SUM(debit)  AS d,
             SUM(credit) AS c
      FROM vcfo_voucher_ledger_entries
      WHERE company_id = ?
        AND voucher_date >= ?
        AND voucher_date <= ?
      GROUP BY ledger_name
    ),
    op AS (
      SELECT ledger_name, opening_balance, group_name
      FROM vcfo_fy_opening_balances
      WHERE company_id = ? AND fy_start = ?
    )
    SELECT
      base.ledger_name                                                    AS ledgerName,
      COALESCE(led.group_name, op.group_name)                             AS groupName,
      COALESCE(op.opening_balance, 0) + COALESCE(pre.delta, 0)            AS opening,
      COALESCE(cur.d, 0)                                                  AS debit,
      COALESCE(cur.c, 0)                                                  AS credit,
      COALESCE(op.opening_balance, 0) + COALESCE(pre.delta, 0)
        + (COALESCE(cur.c, 0) - COALESCE(cur.d, 0))                       AS closing
    FROM base
    LEFT JOIN op  ON op.ledger_name  = base.ledger_name
    LEFT JOIN pre ON pre.ledger_name = base.ledger_name
    LEFT JOIN cur ON cur.ledger_name = base.ledger_name
    LEFT JOIN vcfo_ledgers led
           ON led.company_id = ? AND led.name = base.ledger_name
  `;

  const rows = db.all(
    sql,
    // base CTE
    companyId, toDate,
    companyId, fyStart,
    // pre CTE — everything from FY start up to (but not including) fromDate
    companyId, fyStart, fromDate,
    // cur CTE — the requested window, inclusive on both ends
    companyId, fromDate, toDate,
    // op CTE
    companyId, fyStart,
    // LEFT JOIN vcfo_ledgers
    companyId,
  );

  const out: LedgerBalance[] = [];
  for (const r of rows) {
    const opening = Number(r.opening) || 0;
    const debit = Number(r.debit) || 0;
    const credit = Number(r.credit) || 0;
    const closing = Number(r.closing) || 0;
    // Filter out no-op ledgers (zero opening + zero movement). Keeps report
    // tables compact without losing any meaningful line.
    if (opening === 0 && debit === 0 && credit === 0 && closing === 0) continue;
    out.push({
      ledgerName: String(r.ledgerName),
      groupName: r.groupName ? String(r.groupName) : null,
      opening,
      debit,
      credit,
      closing,
    });
  }
  return out;
}

/**
 * Convenience wrapper: position-only snapshot at `asOfDate`. Runs a
 * zero-width window `[asOfDate, asOfDate]` so the `closing` column holds the
 * point-in-time balance. Debit/credit columns carry whatever happened on
 * that single day; Balance Sheet builders only read `closing`.
 */
export function getBalancesAsOf(
  db: DbHelper,
  companyId: number,
  asOfDate: string,
  fyStart: string = fyStartFor(asOfDate),
): LedgerBalance[] {
  return computeDynamicTB(db, companyId, asOfDate, asOfDate, fyStart);
}

/**
 * Balances strictly *before* a given date — the opening snapshot for a
 * report that starts on `beforeDate`. Implemented as an as-of query for
 * `beforeDate - 1 day` so the caller doesn't have to subtract days itself.
 * Used by Cash Flow (opening cash = close of day before period start).
 */
export function getBalancesBefore(
  db: DbHelper,
  companyId: number,
  beforeDate: string,
  fyStart: string = fyStartFor(beforeDate),
): LedgerBalance[] {
  return getBalancesAsOf(db, companyId, addDays(beforeDate, -1), fyStart);
}
