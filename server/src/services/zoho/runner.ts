// ─────────────────────────────────────────────────────────────────────────────
// Zoho Books sync runner — pulls one organization's books into a tenant DB.
//
// Zoho's v3 API exposes NO trial-balance / P&L / balance-sheet report endpoint,
// so we RECONSTRUCT from primitives and write into the exact same vcfo_* tables
// the Tally sync-agent feeds — meaning the vCFO reports AND the Forecast module
// light up with zero downstream changes.
//
// Per organization:
//   1. GET /chartofaccounts        → vcfo_account_groups + vcfo_ledgers
//      (account_type mapped to a Tally-style group via the normalizer).
//   2. GET /chartofaccounts/transactions?account_id=…  (one sweep per account,
//      full history up to toDate) → bucketed in memory into:
//        • vcfo_voucher_ledger_entries — one row per posting (credit-positive
//          debit/credit magnitudes). This is what computeDynamicTB() composes
//          the vCFO TB/P&L/BS from.
//        • vcfo_fy_opening_balances    — each ledger's balance as of FY start
//          (credit-positive). BS accounts carry their cumulative opening;
//          P&L accounts reset to 0 each FY (nominal accounts don't carry fwd).
//        • vcfo_trial_balance          — month-by-month rows (net_debit /
//          net_credit = that month's movement; closing = running credit-
//          positive). This is what the Forecast budget-vs-actual reads.
//
// Sign convention (matches dynamic-tb.ts): credit-positive, where
//   closing = opening + Σcredit − Σdebit.
//
// ⚠ FIELD-MAPPING CAVEAT: the precise field names on the
// /chartofaccounts/transactions response (debit/credit vs debit_or_credit+amount,
// the list key, pagination) are parsed defensively below and SHOULD be
// validated against a real response on the first live sync — see
// parseTxnDebitCredit() and the TXN_LIST_KEYS fallback.
// ─────────────────────────────────────────────────────────────────────────────

import { getClientHelper } from '../../db/connection.js';
import { getPlatformHelper } from '../../db/platform-connection.js';
import { todayIst } from '../../utils/ist-date.js';
import { fyStartFor } from '../dynamic-tb.js';
import {
  resolveCompanyId,
  bumpLastSyncedAt,
  ingestGroups,
  ingestLedgers,
  ingestVoucherLedgerEntries,
  ingestFyOpeningBalances,
  ingestTrialBalance,
} from '../vcfo-ingest.js';
import { getValidAccessToken, stampOrgSync } from './connections.js';
import { zohoGet, zohoGetAllPages } from './client.js';
import { classifyAccountType, isUnmappedAccountType } from './normalizer.js';

export interface ZohoSyncTarget {
  id: number; // zoho_org_mappings.id (for stamping); 0 if ad-hoc
  connection_id: number;
  dc_region: string;
  zoho_org_id: string;
  zoho_org_name?: string | null;
  target_client_slug: string;
  target_company_name: string;
  fiscal_year_start_month?: number | null;
}

export interface ZohoSyncResult {
  companyId: number;
  accounts: number;
  voucherLines: number;
  tbRows: number;
  openings: number;
  warnings: string[];
}

const num = (v: any): number => (v == null ? 0 : Number(v) || 0);

/** Possible array keys the transactions endpoint might use (defensive). */
const TXN_LIST_KEYS = ['transactions', 'chartofaccounts_transactions', 'account_transactions'];

function monthStartIso(ym: string): string {
  return `${ym}-01`;
}
function monthEndIso(ym: string): string {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7));
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate(); // day 0 of next month
  return `${ym}-${String(lastDay).padStart(2, '0')}`;
}
/** Inclusive list of YYYY-MM from `fromIso`'s month through `toIso`'s month. */
function monthsBetween(fromIso: string, toIso: string): string[] {
  const out: string[] = [];
  let y = Number(fromIso.slice(0, 4));
  let m = Number(fromIso.slice(5, 7));
  const ty = Number(toIso.slice(0, 4));
  const tm = Number(toIso.slice(5, 7));
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

/**
 * Defensive debit/credit extraction from a Zoho account-transaction row.
 * Returns credit-positive magnitudes. Validate the actual field names against
 * a live response on first sync (see header caveat).
 */
function parseTxnDebitCredit(t: any): { debit: number; credit: number } {
  // Shape A — explicit columns.
  if (t.debit_amount != null || t.credit_amount != null) {
    return { debit: num(t.debit_amount), credit: num(t.credit_amount) };
  }
  if (t.debit != null || t.credit != null) {
    return { debit: num(t.debit), credit: num(t.credit) };
  }
  // Shape B — a side flag plus an amount.
  const flag = String(t.debit_or_credit || t.dr_or_cr || '').toLowerCase();
  const amount = num(t.amount ?? t.bcy_amount ?? t.fcy_amount ?? t.debit_or_credit_amount);
  if (flag.startsWith('debit') || flag === 'dr') return { debit: amount, credit: 0 };
  if (flag.startsWith('credit') || flag === 'cr') return { debit: 0, credit: amount };
  // Shape C — signed amount fallback (positive = debit). Best-effort only.
  if (t.amount != null) {
    const a = num(t.amount);
    return a >= 0 ? { debit: a, credit: 0 } : { debit: 0, credit: -a };
  }
  return { debit: 0, credit: 0 };
}

function txnDate(t: any): string {
  return String(t.date || t.transaction_date || t.last_modified_time || '').slice(0, 10);
}

/** Fetch all transactions for one account, trying known list keys. */
async function fetchAccountTransactions(
  region: string,
  accessToken: string,
  orgId: string,
  accountId: string,
  fromDate: string,
  toDate: string,
): Promise<any[]> {
  for (const key of TXN_LIST_KEYS) {
    const rows = await zohoGetAllPages({
      region,
      accessToken,
      path: '/chartofaccounts/transactions',
      listKey: key,
      query: { organization_id: orgId, account_id: accountId, from_date: fromDate, to_date: toDate },
    });
    if (rows.length > 0) return rows;
  }
  return [];
}

/**
 * Run a full sync for one Zoho organization → tenant company.
 * Backfills from the current FY start (April 1) through today by default.
 */
export async function runZohoOrgSync(opts: {
  target: ZohoSyncTarget;
  fromDate?: string;
  toDate?: string;
  onProgress?: (msg: string, pct: number) => void;
}): Promise<ZohoSyncResult> {
  const { target } = opts;
  const warnings: string[] = [];
  const progress = (msg: string, pct: number) => opts.onProgress?.(msg, pct);

  const toDate = opts.toDate || todayIst();
  const fyStart = fyStartFor(toDate); // YYYY-04-01 (Indian FY assumed, as in dynamic-tb)
  const fromDate = opts.fromDate || fyStart;
  const HISTORY_START = '2000-01-01'; // far-back bound so pre-FY postings roll into the opening

  progress('Authenticating with Zoho…', 2);
  const accessToken = await getValidAccessToken(target.connection_id);

  const db = await getClientHelper(target.target_client_slug);
  const companyId = resolveCompanyId(db, target.target_company_name);
  if (!companyId) throw new Error(`Could not resolve company "${target.target_company_name}"`);

  // Reflect the org's FY start month onto the company row (best-effort).
  if (target.fiscal_year_start_month) {
    try {
      db.run('UPDATE vcfo_companies SET fy_start_month = ? WHERE id = ?', target.fiscal_year_start_month, companyId);
    } catch { /* column/edge — non-fatal */ }
  }

  // ── 1. Chart of accounts → groups + ledgers ────────────────────────────────
  progress('Fetching chart of accounts…', 8);
  const accounts = await zohoGetAllPages({
    region: target.dc_region,
    accessToken,
    path: '/chartofaccounts',
    listKey: 'chartofaccounts',
    query: { organization_id: target.zoho_org_id },
  });
  if (accounts.length === 0) {
    warnings.push('No chart-of-accounts rows returned from Zoho.');
  }

  const groupByName = new Map<string, { name: string; parent: string; bsPl: string; drCr: string; affectsGrossProfit: string }>();
  const ledgerRows: Array<{ name: string; group: string; parent: string }> = [];
  // account_id → { name, groupName, bsPl } for the transaction phase
  const acctMeta = new Map<string, { name: string; groupName: string; bsPl: 'BS' | 'PL' }>();

  for (const a of accounts) {
    const accountId = String(a.account_id ?? '');
    const accountName = String(a.account_name ?? '').trim();
    if (!accountId || !accountName) continue;
    const c = classifyAccountType(a.account_type);
    if (isUnmappedAccountType(a.account_type)) {
      warnings.push(`Unmapped account_type "${a.account_type}" → ${c.groupName} (account "${accountName}")`);
    }
    groupByName.set(c.groupName, {
      name: c.groupName,
      parent: c.parentGroup,
      bsPl: c.bsPl,
      drCr: c.drCr,
      affectsGrossProfit: c.affectsGrossProfit,
    });
    ledgerRows.push({ name: accountName, group: c.groupName, parent: c.groupName });
    acctMeta.set(accountId, { name: accountName, groupName: c.groupName, bsPl: c.bsPl });
  }

  ingestGroups(db, companyId, [...groupByName.values()]);
  ingestLedgers(db, companyId, ledgerRows);

  // ── 2. Per-account transactions → voucher entries + openings + monthly TB ──
  const voucherRows: Array<any> = [];
  const openingRows: Array<any> = [];
  const tbRows: Array<any> = [];
  const months = monthsBetween(fromDate, toDate);

  const total = acctMeta.size || 1;
  let idx = 0;
  for (const [accountId, meta] of acctMeta) {
    idx++;
    progress(`Syncing ${meta.name} (${idx}/${total})…`, 10 + Math.round((idx / total) * 85));

    let txns: any[] = [];
    try {
      txns = await fetchAccountTransactions(target.dc_region, accessToken, target.zoho_org_id, accountId, HISTORY_START, toDate);
    } catch (e: any) {
      warnings.push(`Transactions fetch failed for "${meta.name}": ${e?.message || e}`);
      continue;
    }

    // Cumulative (credit-positive) of everything strictly before FY start →
    // the FY opening for balance-sheet accounts. P&L accounts reset to 0.
    let openingCum = 0;
    const monthMov = new Map<string, { debit: number; credit: number }>();

    for (const t of txns) {
      const date = txnDate(t);
      if (!date) continue;
      const { debit, credit } = parseTxnDebitCredit(t);
      if (debit === 0 && credit === 0) continue;

      if (date < fyStart) {
        openingCum += credit - debit;
        continue; // pre-FY postings only inform the opening, not the window
      }
      if (date > toDate) continue;

      const ym = date.slice(0, 7);
      const mv = monthMov.get(ym) || { debit: 0, credit: 0 };
      mv.debit += debit;
      mv.credit += credit;
      monthMov.set(ym, mv);

      voucherRows.push({
        voucherDate: date,
        ledgerName: meta.name,
        debit,
        credit,
        voucherType: t.transaction_type ? String(t.transaction_type) : '',
        voucherNumber: String(t.entry_number ?? t.transaction_id ?? ''),
        narration: t.description ? String(t.description) : (t.reference_number ? String(t.reference_number) : null),
      });
    }

    const fyOpening = meta.bsPl === 'PL' ? 0 : openingCum;
    openingRows.push({
      fyStart,
      ledgerName: meta.name,
      groupName: meta.groupName,
      openingBalance: fyOpening,
    });

    // Month-by-month TB rows for the Forecast module.
    let running = fyOpening;
    for (const ym of months) {
      const mv = monthMov.get(ym) || { debit: 0, credit: 0 };
      const opening = running;
      running = running + (mv.credit - mv.debit);
      // Skip dead months (no opening, no movement) to keep the table compact.
      if (opening === 0 && mv.debit === 0 && mv.credit === 0 && running === 0) continue;
      tbRows.push({
        periodFrom: monthStartIso(ym),
        periodTo: monthEndIso(ym),
        ledgerName: meta.name,
        groupName: meta.groupName,
        openingBalance: opening,
        netDebit: mv.debit,
        netCredit: mv.credit,
        closingBalance: running,
      });
    }
  }

  // ── 3. Persist via the shared idempotent ingest layer ──────────────────────
  progress('Writing to the database…', 96);
  if (openingRows.length) ingestFyOpeningBalances(db, companyId, openingRows);
  if (voucherRows.length) ingestVoucherLedgerEntries(db, companyId, voucherRows);
  if (tbRows.length) ingestTrialBalance(db, companyId, tbRows);
  bumpLastSyncedAt(db, companyId);

  if (target.id) {
    await stampOrgSync(target.id, warnings.length ? `success (${warnings.length} warnings)` : 'success');
  }
  progress('Done', 100);

  return {
    companyId,
    accounts: acctMeta.size,
    voucherLines: voucherRows.length,
    tbRows: tbRows.length,
    openings: openingRows.length,
    warnings,
  };
}

/**
 * Convenience: load a syncable mapping row (from getSyncableOrgMappings) by id
 * and run it. Used by the manual "Sync now" endpoint and the scheduler.
 */
export async function runZohoSyncByMappingId(
  mappingId: number,
  onProgress?: (msg: string, pct: number) => void,
): Promise<ZohoSyncResult> {
  const platformDb = await getPlatformHelper();
  const m = platformDb.get(
    `SELECT m.id, m.connection_id, m.zoho_org_id, m.zoho_org_name, m.fiscal_year_start_month,
            m.target_company_name, c.dc_region, c.status AS connection_status,
            cl.slug AS target_client_slug
       FROM zoho_org_mappings m
       JOIN zoho_connections c ON c.id = m.connection_id
       LEFT JOIN clients cl ON cl.id = m.target_client_id
      WHERE m.id = ?`,
    mappingId,
  );
  if (!m) throw new Error(`Zoho org mapping ${mappingId} not found`);
  if (!m.target_client_slug || !m.target_company_name) {
    throw new Error('Mapping is not fully targeted (client + company required)');
  }
  if (m.connection_status !== 'connected') {
    throw new Error(`Connection is not connected (status: ${m.connection_status})`);
  }
  return runZohoOrgSync({
    target: {
      id: m.id,
      connection_id: m.connection_id,
      dc_region: m.dc_region,
      zoho_org_id: m.zoho_org_id,
      zoho_org_name: m.zoho_org_name,
      target_client_slug: m.target_client_slug,
      target_company_name: m.target_company_name,
      fiscal_year_start_month: m.fiscal_year_start_month,
    },
    onProgress,
  });
}
