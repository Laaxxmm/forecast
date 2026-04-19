// ─────────────────────────────────────────────────────────────────────────────
// Tally extractors — TDL queries + parse. Mirrors the battle-tested shapes in
// Vcfo-app/.../extractors/{xml-templates,data-extractor}.js.
//
// Output shapes match what the server's POST /api/ingest/batch expects:
//   companies    → { name }[]
//   ledgers      → { name, group, parent }[]
//   vouchers     → { date, voucherType, voucherNumber, ledgerName, amount,
//                    partyName, narration }[]
//   groups       → { name, parent, bsPl, drCr, affectsGrossProfit }[]
//   stockSummary → { periodFrom, periodTo, itemName, stockGroup,
//                    openingQty, openingValue, inwardQty, inwardValue,
//                    outwardQty, outwardValue, closingQty, closingValue }[]
// ─────────────────────────────────────────────────────────────────────────────

import { XMLParser } from 'fast-xml-parser';
import { TallyConnector } from './connector';
import type { TallyCompany } from '../types';

// ── Row shapes ───────────────────────────────────────────────────────────────
export interface CompanyRow { name: string; }
export interface LedgerRow {
  name: string;
  group?: string;
  parent?: string;
}
export interface VoucherRow {
  date: string;            // YYYY-MM-DD
  voucherType: string;
  voucherNumber: string;
  ledgerName: string;
  amount: number;
  partyName?: string;
  narration?: string;
}
export interface GroupRow {
  name: string;
  parent?: string;
  /** Balance Sheet ('BS') vs Profit & Loss ('PL'). Derived from $IsRevenue. */
  bsPl?: 'BS' | 'PL';
  /** Debit ('D') vs Credit ('C'). Derived from $IsDeemedPositive. */
  drCr?: 'D' | 'C';
  /** 'Y' / 'N'. Whether this group rolls into gross profit on the P&L. */
  affectsGrossProfit?: 'Y' | 'N';
}
export interface StockSummaryRow {
  /** Window this row describes (inclusive, YYYY-MM-DD). */
  periodFrom: string;
  periodTo: string;
  itemName: string;
  stockGroup?: string;
  openingQty: number;
  openingValue: number;
  inwardQty: number;
  inwardValue: number;
  outwardQty: number;
  outwardValue: number;
  closingQty: number;
  closingValue: number;
}

// ── Utilities ────────────────────────────────────────────────────────────────
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatTallyDate(iso: string): string {
  // Tally wants "01-Apr-2026" style. Input: "2026-04-01".
  const d = new Date(iso + 'T00:00:00');
  return `${d.getDate()}-${MONTHS_SHORT[d.getMonth()]}-${d.getFullYear()}`;
}

function parseTallyDate(val: any): string | null {
  if (!val) return null;
  const s = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // Tally sometimes returns YYYYMMDD (no separators)
  const compact = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  // Or "1-Apr-2026"
  const months: Record<string, number> = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
  const m = s.match(/^(\d{1,2})-(\w{3})-(\d{2,4})$/i);
  if (m) {
    const day = m[1].padStart(2, '0');
    const mon = String(months[m[2].toLowerCase()] || 1).padStart(2, '0');
    const year = m[3].length === 2 ? '20' + m[3] : m[3];
    return `${year}-${mon}-${day}`;
  }
  return null;
}

function parseAmount(val: any): number {
  if (val == null) return 0;
  const s = typeof val === 'object' ? String((val as any)['#text'] || '') : String(val);
  // Tally uses "(1234.56)" for negatives
  const negative = /^\(.*\)$/.test(s.trim());
  const n = parseFloat(s.replace(/[^\d.\-]/g, '')) || 0;
  return negative ? -Math.abs(n) : n;
}

function txt(val: any): string {
  if (val == null) return '';
  if (typeof val === 'object') return String((val as any)['#text'] || '').trim();
  return String(val).trim();
}

function cleanString(val: any): string {
  if (!val) return '';
  return String(val)
    .replace(/&#\d+;/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

// ── TDL templates (minimal subset) ──────────────────────────────────────────
// Note: we intentionally do NOT emit <SVCURRENTCOMPANY>. Tally Prime rejects
// that directive when the target company is already loaded ("Could not set
// SVCurrentCompany to ..."). All queries run against whichever company is
// currently active in Tally — the agent's caller is responsible for picking
// the right company name for labelling the output payload.

function tdlLedgers(): string {
  // Mirrors TEMPLATES['list-masters']('Ledger') — just name + parent group.
  return `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>TVLedgers</ID></HEADER>
<BODY><DESC>
<STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>
<TDL><TDLMESSAGE>
<REPORT NAME="TVLedgers"><FORMS>TVLedgersF</FORMS></REPORT>
<FORM NAME="TVLedgersF"><PARTS>TVLedgersP</PARTS><XMLTAG>DATA</XMLTAG></FORM>
<PART NAME="TVLedgersP"><LINES>L1</LINES><REPEAT>L1:C1</REPEAT><SCROLLED>Vertical</SCROLLED></PART>
<LINE NAME="L1"><FIELDS>F01,F02</FIELDS><XMLTAG>ROW</XMLTAG></LINE>
<FIELD NAME="F01"><SET>$Name</SET><XMLTAG>F01</XMLTAG></FIELD>
<FIELD NAME="F02"><SET>$Parent</SET><XMLTAG>F02</XMLTAG></FIELD>
<COLLECTION NAME="C1"><TYPE>Ledger</TYPE></COLLECTION>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

function tdlDaybook(fromDate: string, toDate: string): string {
  // Mirrors TEMPLATES['daybook'] FIX-23 — bare Collection API, voucher-level
  // fields ONLY. We deliberately do NOT request AllLedgerEntries:
  //   * AllLedgerEntries expansion balloons the response (15MB+ for 1 week on
  //     a real company) and reliably blows past 30s timeouts on Tally Prime.
  //   * SYSTEM Formulae filters (NOT $IsCancelled etc.) crash Tally on some
  //     companies — so no Tally-side filtering either.
  // The trade-off: we get ONE row per voucher (posted against the party
  // ledger at header Amount) instead of one row per ledger-posting. Good
  // enough for the Daybook / dashboard rollups; callers who need the full
  // double-entry can request a narrower window with a heavier extractor
  // later.
  return `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>TVDaybook</ID></HEADER>
<BODY><DESC>
<STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVFROMDATE>${formatTallyDate(fromDate)}</SVFROMDATE>
<SVTODATE>${formatTallyDate(toDate)}</SVTODATE>
</STATICVARIABLES>
<TDL><TDLMESSAGE>
<COLLECTION NAME="TVDaybook"><TYPE>Voucher</TYPE>
<NATIVEMETHOD>Date,VoucherTypeName,VoucherNumber,PartyLedgerName,Amount,Narration</NATIVEMETHOD>
</COLLECTION>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

// ── Extractors ──────────────────────────────────────────────────────────────
const tdlParser = new XMLParser({
  parseTagValue: false,
  isArray: (tagName: string) => tagName === 'ROW' || tagName.endsWith('.LIST'),
});

const voucherParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  isArray: (tagName: string) => tagName === 'VOUCHER',
});

function rowsFromReport(raw: string): any[] {
  if (!raw) throw new Error('Empty response from Tally');
  if (raw.includes('<EXCEPTION>')) {
    const m = raw.match(/<EXCEPTION>(.*?)<\/EXCEPTION>/);
    throw new Error(m ? m[1] : 'Tally exception');
  }
  const parsed: any = tdlParser.parse(raw);
  const rows = parsed?.DATA?.ROW;
  if (!rows) return [];
  return Array.isArray(rows) ? rows : [rows];
}

export async function extractCompanies(conn: TallyConnector): Promise<CompanyRow[]> {
  // Companies don't need TDL — the connector's getCompanies() already works.
  const companies: TallyCompany[] = await conn.getCompanies();
  return companies.map((c) => ({ name: c.name }));
}

export async function extractLedgers(conn: TallyConnector, companyName: string): Promise<LedgerRow[]> {
  // companyName is kept for callers that want to label their logs / payload;
  // the query itself runs against Tally's currently-active company.
  if (!companyName) throw new Error('companyName required for extractLedgers');
  const raw = await conn.sendXML(tdlLedgers());
  const rows = rowsFromReport(raw);
  return rows
    .map((r: any): LedgerRow => ({
      name: cleanString(r.F01),
      group: cleanString(r.F02),
      parent: cleanString(r.F02),
    }))
    .filter((l) => l.name.length > 0);
}

/**
 * Extract vouchers for a date window [fromDate, toDate] (inclusive, both
 * YYYY-MM-DD). Returns ONE row per voucher, posted against the party ledger
 * at the header Amount — not one row per ledger posting.
 *
 * Window is enforced client-side because Tally Prime's bare Collection API
 * ignores SVFROMDATE/SVTODATE when we skip the AllLedgerEntries NATIVEMETHOD
 * (which we skip for performance — see tdlDaybook). We still set the Sv*
 * variables to hint Tally about the current period, but the authoritative
 * filter is the JS date compare below. YYYY-MM-DD sorts lexicographically,
 * so string compare is correct.
 */
export async function extractVouchers(
  conn: TallyConnector,
  companyName: string,
  fromDate: string,
  toDate: string,
): Promise<VoucherRow[]> {
  if (!companyName) throw new Error('companyName required for extractVouchers');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) throw new Error('fromDate must be YYYY-MM-DD');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(toDate)) throw new Error('toDate must be YYYY-MM-DD');
  if (fromDate > toDate) throw new Error(`fromDate ${fromDate} is after toDate ${toDate}`);

  const raw = await conn.sendXML(tdlDaybook(fromDate, toDate));
  if (!raw) throw new Error('Empty response from Tally');
  if (raw.includes('Unknown Request')) throw new Error('Tally rejected daybook query');

  const parsed: any = voucherParser.parse(raw);
  // Bare Collection API response shape: <ENVELOPE><VOUCHER>...<VOUCHER>...
  // (older / Data-TYPE shape: <ENVELOPE><BODY><DATA><COLLECTION><VOUCHER>...)
  // Try both.
  const vouchers: any[] =
    parsed?.ENVELOPE?.VOUCHER
    ?? parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION?.VOUCHER
    ?? parsed?.ENVELOPE?.BODY?.DATA?.VOUCHER
    ?? [];
  const list = Array.isArray(vouchers) ? vouchers : (vouchers ? [vouchers] : []);

  const out: VoucherRow[] = [];
  for (const v of list) {
    const date = parseTallyDate(txt(v.DATE));
    if (!date) continue; // skip malformed vouchers
    if (date < fromDate || date > toDate) continue; // enforce window in JS

    const voucherType = cleanString(txt(v.VOUCHERTYPENAME));
    const voucherNumber = cleanString(txt(v.VOUCHERNUMBER));
    const partyName = cleanString(txt(v.PARTYLEDGERNAME));
    const narration = cleanString(txt(v.NARRATION));
    const headerAmount = parseAmount(v.AMOUNT);

    // FIX-23 shape: one row per voucher posted against the party ledger
    // at header Amount. If there's no party ledger (pure journal), fall
    // back to a placeholder so the row isn't lost.
    const ledgerName = partyName || voucherType || 'Journal';
    out.push({
      date,
      voucherType,
      voucherNumber,
      ledgerName,
      amount: headerAmount,
      partyName: partyName || undefined,
      narration: narration || undefined,
    });
  }
  return out;
}

// ── Groups (chart of accounts) ──────────────────────────────────────────────
// Ports Vcfo-app TEMPLATES['chart-of-accounts'] — one row per Tally Group
// with its BS/PL classification, dr/cr default sign, and gross-profit flag.
// These five fields are what the VCFO dashboard's P&L / balance-sheet
// rollups use to categorize ledgers; without them the server has to guess
// from `parent_group` strings, which is lossy.

function tdlGroups(): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>TVGroups</ID></HEADER>
<BODY><DESC>
<STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>
<TDL><TDLMESSAGE>
<REPORT NAME="TVGroups"><FORMS>TVGroupsF</FORMS></REPORT>
<FORM NAME="TVGroupsF"><PARTS>TVGroupsP</PARTS><XMLTAG>DATA</XMLTAG></FORM>
<PART NAME="TVGroupsP"><LINES>L1</LINES><REPEAT>L1:C1</REPEAT><SCROLLED>Vertical</SCROLLED></PART>
<LINE NAME="L1"><FIELDS>F01,F02,F03,F04,F05</FIELDS><XMLTAG>ROW</XMLTAG></LINE>
<FIELD NAME="F01"><SET>$Name</SET><XMLTAG>F01</XMLTAG></FIELD>
<FIELD NAME="F02"><SET>$Parent</SET><XMLTAG>F02</XMLTAG></FIELD>
<FIELD NAME="F03"><SET>if $IsRevenue then "PL" else "BS"</SET><XMLTAG>F03</XMLTAG></FIELD>
<FIELD NAME="F04"><SET>if $IsDeemedPositive then "D" else "C"</SET><XMLTAG>F04</XMLTAG></FIELD>
<FIELD NAME="F05"><SET>if $AffectsGrossProfit then "Y" else "N"</SET><XMLTAG>F05</XMLTAG></FIELD>
<COLLECTION NAME="C1"><TYPE>Group</TYPE></COLLECTION>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

export async function extractGroups(conn: TallyConnector, companyName: string): Promise<GroupRow[]> {
  if (!companyName) throw new Error('companyName required for extractGroups');
  const raw = await conn.sendXML(tdlGroups());
  const rows = rowsFromReport(raw);
  return rows
    .map((r: any): GroupRow => {
      const bsPl = cleanString(r.F03).toUpperCase();
      const drCr = cleanString(r.F04).toUpperCase();
      const agp = cleanString(r.F05).toUpperCase();
      return {
        name: cleanString(r.F01),
        parent: cleanString(r.F02) || undefined,
        bsPl: bsPl === 'PL' ? 'PL' : bsPl === 'BS' ? 'BS' : undefined,
        drCr: drCr === 'D' ? 'D' : drCr === 'C' ? 'C' : undefined,
        affectsGrossProfit: agp === 'Y' ? 'Y' : agp === 'N' ? 'N' : undefined,
      };
    })
    .filter((g) => g.name.length > 0);
}

// ── Stock summary ───────────────────────────────────────────────────────────
// Ports TEMPLATES['stock-summary'] — opening / inward / outward / closing
// qty+value per stock item, evaluated over a date window set via Sv*. The
// reference chunks the year into quarters (4 requests/year instead of 12)
// because a full-year StockItem collection is slow but not catastrophic.
//
// NOTE on the date filter: unlike Voucher, the StockItem collection DOES
// respect SVFROMDATE/SVTODATE because Tally computes opening/closing via
// $$NumValue formulas that reference the active period. So we don't need
// a JS-side filter.

function tdlStockSummary(fromDate: string, toDate: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>TVStockSum</ID></HEADER>
<BODY><DESC>
<STATICVARIABLES>
<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVFROMDATE>${formatTallyDate(fromDate)}</SVFROMDATE>
<SVTODATE>${formatTallyDate(toDate)}</SVTODATE>
</STATICVARIABLES>
<TDL><TDLMESSAGE>
<REPORT NAME="TVStockSum"><FORMS>TVStockSumF</FORMS></REPORT>
<FORM NAME="TVStockSumF"><PARTS>TVStockSumP</PARTS><XMLTAG>DATA</XMLTAG></FORM>
<PART NAME="TVStockSumP"><LINES>L1</LINES><REPEAT>L1:C1</REPEAT><SCROLLED>Vertical</SCROLLED></PART>
<LINE NAME="L1"><FIELDS>F01,F02,F03,F04,F05,F06,F07,F08,F09,F10</FIELDS><XMLTAG>ROW</XMLTAG></LINE>
<FIELD NAME="F01"><SET>$Name</SET><XMLTAG>F01</XMLTAG></FIELD>
<FIELD NAME="F02"><SET>$Parent</SET><XMLTAG>F02</XMLTAG></FIELD>
<FIELD NAME="F03"><SET>$$NumValue:$OpeningBalance</SET><XMLTAG>F03</XMLTAG></FIELD>
<FIELD NAME="F04"><SET>$$NumValue:$OpeningValue</SET><XMLTAG>F04</XMLTAG></FIELD>
<FIELD NAME="F05"><SET>$$NumValue:$InwardQuantity</SET><XMLTAG>F05</XMLTAG></FIELD>
<FIELD NAME="F06"><SET>$$NumValue:$InwardValue</SET><XMLTAG>F06</XMLTAG></FIELD>
<FIELD NAME="F07"><SET>$$NumValue:$OutwardQuantity</SET><XMLTAG>F07</XMLTAG></FIELD>
<FIELD NAME="F08"><SET>$$NumValue:$OutwardValue</SET><XMLTAG>F08</XMLTAG></FIELD>
<FIELD NAME="F09"><SET>$$NumValue:$ClosingBalance</SET><XMLTAG>F09</XMLTAG></FIELD>
<FIELD NAME="F10"><SET>$$NumValue:$ClosingValue</SET><XMLTAG>F10</XMLTAG></FIELD>
<COLLECTION NAME="C1"><TYPE>StockItem</TYPE></COLLECTION>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

/**
 * Chunk [fromDate, toDate] into Indian-FY quarters (Apr-Jun, Jul-Sep,
 * Oct-Dec, Jan-Mar). Each result describes one quarter that intersects
 * the requested window.
 *
 *   periodFrom / periodTo → canonical quarter boundaries (e.g. 2026-04-01
 *     to 2026-06-30 for Q1). These are used as stable DB keys so repeated
 *     syncs of the same quarter collapse via UNIQUE(period_from, period_to,
 *     item_name) + REPLACE. DO NOT clip these to the user's window — if you
 *     do, the rolling "current" quarter gets a new row every sync (because
 *     `toDate = today` shifts daily), and the dashboard accumulates
 *     duplicates.
 *
 *   queryFrom / queryTo → what we actually ask Tally for, clipped so we
 *     don't request data past `toDate`. Opening/closing in Tally are
 *     evaluated against SVFROMDATE / SVTODATE, so for an in-progress
 *     quarter the row's closingQty reflects "as-of today" even though the
 *     DB labels it with the quarter-end date. Each sync refreshes that
 *     number (via REPLACE) until the quarter closes and it stabilizes.
 *
 * Inclusive on both sides, YYYY-MM-DD.
 */
export function quarterChunks(
  fromDate: string,
  toDate: string,
): { periodFrom: string; periodTo: string; queryFrom: string; queryTo: string }[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) throw new Error('fromDate must be YYYY-MM-DD');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(toDate)) throw new Error('toDate must be YYYY-MM-DD');
  if (fromDate > toDate) throw new Error(`fromDate ${fromDate} is after toDate ${toDate}`);

  const chunks: { periodFrom: string; periodTo: string; queryFrom: string; queryTo: string }[] = [];
  // Use UTC to avoid DST / timezone drift on month-boundary math.
  const start = new Date(fromDate + 'T00:00:00Z');
  const end = new Date(toDate + 'T00:00:00Z');
  let cursor = start;
  // Safety valve — at most 80 quarters (20 years), prevents runaway loops.
  for (let i = 0; i < 80 && cursor <= end; i++) {
    const m = cursor.getUTCMonth(); // 0..11
    // Q1 Apr-Jun (3-5), Q2 Jul-Sep (6-8), Q3 Oct-Dec (9-11), Q4 Jan-Mar (0-2)
    const qStartMonth = m >= 3 && m <= 5 ? 3 : m >= 6 && m <= 8 ? 6 : m >= 9 ? 9 : 0;
    const qEndMonth = m >= 3 && m <= 5 ? 5 : m >= 6 && m <= 8 ? 8 : m >= 9 ? 11 : 2;
    const year = cursor.getUTCFullYear();
    const quarterStart = new Date(Date.UTC(year, qStartMonth, 1));
    const quarterEnd = new Date(Date.UTC(year, qEndMonth + 1, 0)); // last day of qEndMonth
    const queryEnd = quarterEnd > end ? end : quarterEnd;
    chunks.push({
      periodFrom: iso(quarterStart),
      periodTo: iso(quarterEnd),
      queryFrom: iso(quarterStart),
      queryTo: iso(queryEnd),
    });
    // Next quarter starts the day after THIS quarter's canonical end.
    cursor = new Date(Date.UTC(quarterEnd.getUTCFullYear(), quarterEnd.getUTCMonth(), quarterEnd.getUTCDate() + 1));
  }
  return chunks;
}

function iso(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Extract stock-summary rows for [fromDate, toDate], fanned out across
 * quarterly windows. Items that don't move in a given quarter still get
 * a row (with opening==closing, in/out==0) so the server can track item
 * masters over time.
 *
 * Per-quarter errors are swallowed and recorded to console — one bad
 * quarter shouldn't abort the whole multi-quarter pull. This is
 * deliberate: a fresh company might have no StockItem records at all,
 * and rowsFromReport throws on a truly empty response body.
 */
export async function extractStockSummary(
  conn: TallyConnector,
  companyName: string,
  fromDate: string,
  toDate: string,
): Promise<StockSummaryRow[]> {
  if (!companyName) throw new Error('companyName required for extractStockSummary');
  const chunks = quarterChunks(fromDate, toDate);
  const out: StockSummaryRow[] = [];
  for (const { periodFrom, periodTo, queryFrom, queryTo } of chunks) {
    let rows: any[] = [];
    try {
      const raw = await conn.sendXML(tdlStockSummary(queryFrom, queryTo));
      rows = rowsFromReport(raw);
    } catch (err: any) {
      // Log and continue to the next quarter. A 0-item or
      // 0-response quarter is not a reason to fail the whole extract.
      // eslint-disable-next-line no-console
      console.warn(
        `[tally] stockSummary quarter ${periodFrom}..${periodTo} (query ${queryFrom}..${queryTo}) failed: ${err?.message || err}`,
      );
      continue;
    }
    for (const r of rows) {
      const itemName = cleanString(r.F01);
      if (!itemName) continue;
      out.push({
        // Store canonical quarter boundaries (stable DB key across re-syncs),
        // not the clipped query window.
        periodFrom,
        periodTo,
        itemName,
        stockGroup: cleanString(r.F02) || undefined,
        openingQty: parseAmount(r.F03),
        openingValue: parseAmount(r.F04),
        inwardQty: parseAmount(r.F05),
        inwardValue: parseAmount(r.F06),
        outwardQty: parseAmount(r.F07),
        outwardValue: parseAmount(r.F08),
        closingQty: parseAmount(r.F09),
        closingValue: parseAmount(r.F10),
      });
    }
  }
  return out;
}
