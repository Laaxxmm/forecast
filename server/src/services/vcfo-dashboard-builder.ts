// ─────────────────────────────────────────────────────────────────────────────
// VCFO Dashboard builder.
//
// One function — buildDashboard — assembles the entire dashboard payload by
// fanning out across the existing single-purpose builders (P&L, Cash Flow,
// Balance-Sheet helpers) and one net-new SQL aggregate (top-N party
// ledgers). Lives separately from vcfo-report-builder.ts so the new endpoint
// is easy to read end-to-end without scrolling past 1500 lines of P&L
// reshape logic.
// ─────────────────────────────────────────────────────────────────────────────

import type { DbHelper } from '../db/connection.js';
import {
  buildProfitLossMulti,
  buildCashFlowMulti,
  buildProfitLoss,
  getGroupTree,
  computeBSClosing,
  computeBSClosingByLedger,
  type CompanyRef,
} from './vcfo-report-builder.js';

// ── Payload shape (kept in lock-step with client/src/components/vcfo/DashboardReport.tsx)
export interface DashboardPayload {
  period: { from: string; to: string };
  prior:  { from: string; to: string };
  scope:  { companyIds: number[]; consolidated: boolean; companyCount: number };

  kpis: {
    revenue:     { value: number; prior: number; deltaPct: number };
    grossProfit: { value: number; prior: number; deltaPct: number; marginPct: number };
    netProfit:   { value: number; prior: number; deltaPct: number; marginPct: number };
    cashAndBank: { value: number; asOf: string };
  };

  trend: {
    columns:   string[];
    revenue:   Record<string, number>;
    netProfit: Record<string, number>;
  };

  composition: {
    revenue: number;
    directCosts: number;
    indirectIncome: number;
    indirectExpenses: number;
    grossProfit: number;
    netProfit: number;
  };

  cashAndBank: {
    asOf: string;
    total: number;
    ledgers: Array<{ name: string; group: 'Cash-in-Hand' | 'Bank Accounts'; balance: number }>;
  };

  receivables: { total: number; top: Array<PartyEntry> };
  payables:    { total: number; top: Array<PartyEntry> };

  cashFlow: {
    opening: number;
    operating: number;
    investing: number;
    financing: number;
    netChange: number;
    closingCash: number;
  };

  /** Present only when scope is consolidated AND there are 2+ companies. */
  perCompany?: Array<{ id: number; name: string; revenue: number; netProfit: number }>;

  /**
   * Week-over-week deltas anchored at `to` — powers the dashboard's
   * Row 5 "What changed this week" card. `null` for revenue.deltaPct
   * means the prior 7-day window had zero revenue, so growth is not
   * meaningful to render. Always present; the frontend hides the card
   * if both deltas are zero (nothing happened in either week).
   */
  weekly: {
    revenue: { last7d: number; prior7d: number; deltaPct: number | null };
    netCash: { current: number; weekAgo: number; delta: number };
    windows: { last7dFrom: string; last7dTo: string; prior7dFrom: string; prior7dTo: string };
  };
}

/**
 * One party row in the receivables/payables top list. `oldestEntryDays` is a
 * pragmatic Phase-2 aging proxy: the age in days, as of the report date, of
 * the OLDEST voucher entry contributing to the party's balance. The frontend
 * uses it to colour the aging pill (>60 red, 30-60 amber, <30 green).
 *
 * It's not full FIFO aging (which would need invoice-level matching to
 * payments) but it's a meaningful improvement over no aging signal at all,
 * and unlike FIFO it adds zero query cost — just a MIN() in the existing
 * group-by.
 */
export interface PartyEntry {
  party: string;
  amount: number;
  oldestEntryDays: number | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function pctDelta(current: number, prior: number): number {
  if (prior === 0) {
    if (current === 0) return 0;
    // Prior is zero, current is non-zero → "infinite" growth. Cap at ±999% so the
    // UI doesn't have to render a special case.
    return current > 0 ? 999 : -999;
  }
  return Math.round(((current - prior) / Math.abs(prior)) * 1000) / 10;
}

/**
 * Shift a [from, to] window backwards by its own length. Used to compute the
 * "prior period" comparison for KPI delta chips.
 *
 * Example: from=2026-04-01 to=2026-04-30 → prior 2026-03-02 to 2026-03-31.
 */
function priorWindow(from: string, to: string): { from: string; to: string } {
  const start = new Date(from + 'T00:00:00');
  const end = new Date(to + 'T00:00:00');
  const lenDays = Math.round((end.getTime() - start.getTime()) / 86400000) + 1; // inclusive
  const priorEnd = new Date(start.getTime() - 86400000);
  const priorStart = new Date(priorEnd.getTime() - (lenDays - 1) * 86400000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { from: iso(priorStart), to: iso(priorEnd) };
}

/** Anchor `to` minus `n` days as ISO YYYY-MM-DD. */
function isoMinusDays(toIso: string, n: number): string {
  const d = new Date(toIso + 'T00:00:00');
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

/**
 * Top-N party ledgers by closing balance under a given parent group, across a
 * set of companies, as of a date. Used for both Top Receivables and Top Payables.
 *
 * Net amount = SUM(credit - debit) — credit-positive convention matching the
 * rest of the ingest. Caller flips the sign for Sundry Debtors (we are owed →
 * positive when displayed).
 */
function getTopPartyLedgers(
  db: DbHelper,
  companyIds: number[],
  asOf: string,
  parentGroup: 'Sundry Debtors' | 'Sundry Creditors',
  limit = 10,
): Array<PartyEntry> {
  if (companyIds.length === 0) return [];

  // Walk each company's group tree to collect every group that rolls up under
  // the parent (Sundry Debtors / Creditors). Accounts can sit under sub-groups
  // like "Customers - Bangalore" / "Customers - Hyderabad" that descend from
  // Sundry Debtors. getGroupTree handles the recursion.
  const groupNames = new Set<string>();
  for (const cid of companyIds) {
    for (const g of getGroupTree(db, cid, parentGroup)) groupNames.add(g);
  }
  if (groupNames.size === 0) return [];

  const cidPlaceholders = companyIds.map(() => '?').join(',');
  const grpPlaceholders = Array.from(groupNames).map(() => '?').join(',');

  // Sum (credit - debit) per party ledger across all included companies. Join
  // through vcfo_ledgers so we can filter by group_name (the entries table
  // doesn't carry group). is_party_ledger = 1 keeps party rows only — excludes
  // contra hits like opening journal entries on the parent ledger.
  //
  // MIN(voucher_date) gives us the date of the oldest entry contributing to
  // the party's balance — used as the aging proxy on the frontend.
  const rows = db.all(
    `SELECT e.ledger_name AS party,
            SUM(e.credit - e.debit) AS net_amount,
            MIN(e.voucher_date)     AS oldest_voucher_date
     FROM vcfo_voucher_ledger_entries e
     JOIN vcfo_ledgers l
       ON l.name = e.ledger_name AND l.company_id = e.company_id
     WHERE e.company_id IN (${cidPlaceholders})
       AND e.voucher_date <= ?
       AND e.is_party_ledger = 1
       AND l.group_name IN (${grpPlaceholders})
     GROUP BY e.ledger_name
     HAVING ABS(SUM(e.credit - e.debit)) > 0.01
     ORDER BY ${parentGroup === 'Sundry Debtors' ? 'SUM(e.credit - e.debit) ASC' : 'SUM(e.credit - e.debit) DESC'}
     LIMIT ?`,
    ...companyIds,
    asOf,
    ...Array.from(groupNames),
    limit,
  ) as Array<{ party: string; net_amount: number; oldest_voucher_date: string | null }>;

  const asOfMs = new Date(asOf + 'T00:00:00').getTime();

  // Display sign: receivables are stored credit-positive but flipped for the
  // user (we are owed → positive amount). Payables stay credit-positive.
  return rows.map((r) => {
    let oldestEntryDays: number | null = null;
    if (r.oldest_voucher_date) {
      const oldestMs = new Date(r.oldest_voucher_date + 'T00:00:00').getTime();
      if (!Number.isNaN(oldestMs)) {
        oldestEntryDays = Math.max(0, Math.round((asOfMs - oldestMs) / 86400000));
      }
    }
    return {
      party: r.party,
      amount: parentGroup === 'Sundry Debtors' ? -r.net_amount : r.net_amount,
      oldestEntryDays,
    };
  });
}

/**
 * Total balance under a parent group (e.g. "Sundry Debtors") across multiple
 * companies, as of a date. Sums per-company `computeBSClosing` calls. Sign
 * convention matches getTopPartyLedgers — flipped for debtors so the UI gets
 * a positive amount.
 */
function getTotalUnderGroup(
  db: DbHelper,
  companyIds: number[],
  asOf: string,
  parentGroup: 'Sundry Debtors' | 'Sundry Creditors',
): number {
  let total = 0;
  for (const cid of companyIds) {
    const groups = getGroupTree(db, cid, parentGroup);
    total += computeBSClosing(db, cid, asOf, groups);
  }
  return parentGroup === 'Sundry Debtors' ? -total : total;
}

// ── Public entry point ──────────────────────────────────────────────────────

export function buildDashboard(
  db: DbHelper,
  companies: CompanyRef[],
  from: string,
  to: string,
): DashboardPayload {
  const consolidated = companies.length !== 1;
  const companyIds = companies.map((c) => c.id);

  // 1. Current-window P&L (yearly view, single column → grandTotals)
  const plCurrent = buildProfitLossMulti(db, companies, from, to, 'yearly', false);

  // 2. Prior-window P&L for delta chips. Only the grandTotals are consumed.
  const prior = priorWindow(from, to);
  const plPrior = buildProfitLossMulti(db, companies, prior.from, prior.to, 'yearly', false);

  // 3. Monthly P&L for the trend chart (revenue + net profit per month).
  const plMonthly = buildProfitLossMulti(db, companies, from, to, 'monthly', false);

  // 4. Cash flow (operating/investing/financing + closing cash for the window).
  const cf = buildCashFlowMulti(db, companies, from, to, false);

  // 5. Cash & bank ledger list as of `to`.
  //    Loop per company so the row carries which group bucket it belongs to.
  const cashLedgers: Array<{ name: string; group: 'Cash-in-Hand' | 'Bank Accounts'; balance: number }> = [];
  let cashAndBankTotal = 0;
  for (const c of companies) {
    const cashGroups = getGroupTree(db, c.id, 'Cash-in-Hand');
    const bankGroups = getGroupTree(db, c.id, 'Bank Accounts');
    const cashByLedger = computeBSClosingByLedger(db, c.id, to, cashGroups);
    const bankByLedger = computeBSClosingByLedger(db, c.id, to, bankGroups);
    for (const [name, bal] of cashByLedger) {
      if (Math.abs(bal) < 0.01) continue;
      cashLedgers.push({ name, group: 'Cash-in-Hand', balance: bal });
      cashAndBankTotal += bal;
    }
    for (const [name, bal] of bankByLedger) {
      if (Math.abs(bal) < 0.01) continue;
      cashLedgers.push({ name, group: 'Bank Accounts', balance: bal });
      cashAndBankTotal += bal;
    }
  }
  // Sort largest balance first so the most-funded account leads.
  cashLedgers.sort((a, b) => b.balance - a.balance);

  // 6. Top receivables and payables (parties).
  const receivablesTotal = getTotalUnderGroup(db, companyIds, to, 'Sundry Debtors');
  const payablesTotal = getTotalUnderGroup(db, companyIds, to, 'Sundry Creditors');
  const topReceivables = getTopPartyLedgers(db, companyIds, to, 'Sundry Debtors', 10);
  const topPayables = getTopPartyLedgers(db, companyIds, to, 'Sundry Creditors', 10);

  // 7. Per-company contribution (only when consolidated and >1 company).
  let perCompany: DashboardPayload['perCompany'];
  if (consolidated && companies.length > 1) {
    perCompany = companies.map((c) => {
      const r = buildProfitLoss(db, c.id, from, to, 'yearly');
      return {
        id: c.id,
        name: c.name,
        revenue: r.grandTotals.revenue,
        netProfit: r.grandTotals.netProfit,
      };
    });
  }

  // 8. Week-over-week deltas — last 7d vs prior 7d, anchored at `to`.
  //    Costs two extra P&L builds + one BS-closing pass per company.
  //    Acceptable on this endpoint; revisit with an event-log table if
  //    the dashboard's render budget tightens.
  const last7dFrom  = isoMinusDays(to, 6);
  const prior7dFrom = isoMinusDays(to, 13);
  const prior7dTo   = isoMinusDays(to, 7);
  const plLast7d  = buildProfitLossMulti(db, companies, last7dFrom,  to,         'yearly', false);
  const plPrior7d = buildProfitLossMulti(db, companies, prior7dFrom, prior7dTo,  'yearly', false);
  const revLast = plLast7d.grandTotals.revenue;
  const revPrior = plPrior7d.grandTotals.revenue;
  const revDeltaPct = revPrior === 0
    ? null
    : Math.round(((revLast - revPrior) / Math.abs(revPrior)) * 1000) / 10;

  // Sign matches the Net Cash Position KPI in Row 1 — same source helper,
  // no flip — so "delta = current - weekAgo" reads identically to the user.
  let cashWeekAgo = 0;
  for (const c of companies) {
    const cashGroups = getGroupTree(db, c.id, 'Cash-in-Hand');
    const bankGroups = getGroupTree(db, c.id, 'Bank Accounts');
    cashWeekAgo += computeBSClosing(db, c.id, prior7dTo, [...cashGroups, ...bankGroups]);
  }

  // ── Assemble payload ──────────────────────────────────────────────────────
  const cur = plCurrent.grandTotals;
  const pri = plPrior.grandTotals;

  return {
    period: { from, to },
    prior,
    scope: {
      companyIds,
      consolidated,
      companyCount: companies.length,
    },
    kpis: {
      revenue: {
        value: cur.revenue,
        prior: pri.revenue,
        deltaPct: pctDelta(cur.revenue, pri.revenue),
      },
      grossProfit: {
        value: cur.grossProfit,
        prior: pri.grossProfit,
        deltaPct: pctDelta(cur.grossProfit, pri.grossProfit),
        marginPct: cur.revenue !== 0
          ? Math.round((cur.grossProfit / cur.revenue) * 1000) / 10
          : 0,
      },
      netProfit: {
        value: cur.netProfit,
        prior: pri.netProfit,
        deltaPct: pctDelta(cur.netProfit, pri.netProfit),
        marginPct: cur.revenue !== 0
          ? Math.round((cur.netProfit / cur.revenue) * 1000) / 10
          : 0,
      },
      cashAndBank: {
        value: cashAndBankTotal,
        asOf: to,
      },
    },
    trend: {
      columns: plMonthly.columns,
      revenue: Object.fromEntries(
        plMonthly.columns.map((col) => {
          const sec = plMonthly.sections.find((s) => s.key === 'revenue');
          return [col, sec?.values[col] || 0];
        }),
      ),
      netProfit: Object.fromEntries(
        plMonthly.columns.map((col) => [col, plMonthly.computed.netProfit[col] || 0]),
      ),
    },
    composition: {
      revenue: cur.revenue,
      directCosts: cur.directCosts,
      indirectIncome: cur.indirectIncome,
      indirectExpenses: cur.indirectExpenses,
      grossProfit: cur.grossProfit,
      netProfit: cur.netProfit,
    },
    cashAndBank: {
      asOf: to,
      total: cashAndBankTotal,
      ledgers: cashLedgers,
    },
    receivables: { total: receivablesTotal, top: topReceivables },
    payables: { total: payablesTotal, top: topPayables },
    cashFlow: {
      opening: cf.openingCash,
      operating: cf.operatingTotal,
      investing: cf.investingTotal,
      financing: cf.financingTotal,
      netChange: cf.netChange,
      closingCash: cf.closingCash,
    },
    perCompany,
    weekly: {
      revenue: { last7d: revLast, prior7d: revPrior, deltaPct: revDeltaPct },
      netCash: { current: cashAndBankTotal, weekAgo: cashWeekAgo, delta: cashAndBankTotal - cashWeekAgo },
      windows: { last7dFrom, last7dTo: to, prior7dFrom, prior7dTo },
    },
  };
}
