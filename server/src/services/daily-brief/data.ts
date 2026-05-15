// Builds the data shape consumed by the Daily Brief HTML/PDF template.
//
// Pulls from clinic_actuals + pharmacy_sales_actuals + budgets + auto_sync_runs
// (via the existing tenant DB) and assembles the friendly, non-finance numbers
// the design surfaces: yesterday's earnings, day-of-week comparison, today's
// per-stream targets, top + silent doctors, and a watchlist of risk items.
//
// Doctor names are resolved through doctor_aliases so canonical doctors get
// the credit even when imports use raw variant strings.

import type { DbHelper } from '../../db/connection.js';
import type { BranchContext } from '../../utils/branch.js';
import { branchFilter } from '../../utils/branch.js';
import { getMonthlyRevenueTarget } from './targets.js';

// ── Public types ──
export interface DailyBriefStream {
  key: string;
  label: string;
  yesterdayRevenue: number;
  todayTarget: number;
  status: 'ok' | 'amber' | 'red';
  statusLabel: string;
  takeaway: string;
}

export interface DailyBriefDoctor {
  name: string;
  yesterdayRevenue: number;
  typicalDayRevenue: number;
}

export interface DailyBriefSilentDoctor {
  name: string;
  daysQuiet: number;
  typicalDayRevenue: number;
  lastBilledDate: string | null;
}

export interface DailyBriefWatchItem {
  type: 'stock_expiry' | 'stream_behind' | 'discount_drift' | 'sync_failure';
  tone: 'amber' | 'red' | 'blue';
  title: string;
  subtitle: string;
  rightValue: string;
  rightSub: string;
}

export interface DailyBriefData {
  meta: {
    clientName: string;
    branchName: string;
    branchId: number | null;
    yesterday: string;          // YYYY-MM-DD (the day being summarised)
    today: string;              // YYYY-MM-DD
    yesterdayLabel: string;     // "Mon · 27 May"
    todayLabelLong: string;     // "Tuesday, 28 May 2026"
    todayLabelShort: string;    // "Tue · 28 May"
    todayWeekday: string;       // "Tuesday"
    monthPct: number;           // 0-100
    monthLabel: string;         // "May 2026"
    dayOfMonth: number;
    daysInMonth: number;
    daysRemaining: number;
    issueNumber: number;        // running count of briefs since launch
    syncedAtLabel: string;      // "7:42 AM"
    filedAtLabel: string;       // "8:00 AM"
    generatedAtLabel: string;   // "8:00 AM · 28 May 2026"
    progressFillPct: number;    // mtd / goal × 100
    progressPacePct: number;    // dayOfMonth / daysInMonth × 100
  };
  status: {
    tone: 'ok' | 'amber' | 'red';
    headline: string;
    systems: string;
  };
  yesterday: {
    revenue: number;
    revenueDeltaPct: number;     // signed % vs same-weekday avg
    visits: number;
    visitsDelta: number;         // signed count vs same-weekday avg
    typicalVisits: number;
    typicalDayLabel: string;     // "Tuesday"
    target: number;
    surplus: number;             // signed (revenue - target)
  };
  streams: DailyBriefStream[];
  today: {
    requiredRevenue: number;
    perStream: { key: string; label: string; target: number }[];
    mtdRevenue: number;
    monthlyGoal: number;
  };
  topDoctors: DailyBriefDoctor[];
  silentDoctors: DailyBriefSilentDoctor[];
  watchlist: DailyBriefWatchItem[];
}

// ── Internal helpers ──
const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_LONG = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function parseDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function fmtYmd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(d.getDate() + n);
  return r;
}

// Indian comma format (e.g. 1116746 → 11,16,746). Lakh/crore grouping —
// matches what the rest of the app uses for rupees.
function formatIndian(n: number): string {
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(Math.round(n));
  const s = String(abs);
  if (s.length <= 3) return sign + s;
  const lastThree = s.slice(-3);
  const rest = s.slice(0, -3);
  return sign + rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + lastThree;
}
function formatINR(n: number): string {
  return '₹' + formatIndian(n);
}

// Map a stream's name onto the design's canonical labels. The Daily Dose
// expects four cards (Consultations / Diagnostics / Other Revenue / Pharmacy);
// any other stream just keeps its raw name.
function friendlyStreamLabel(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('consult')) return 'Consultations';
  if (n.includes('diagnos') || n.includes('lab')) return 'Diagnostics';
  if (n.includes('pharma')) return 'Pharmacy';
  if (n.includes('other')) return 'Other Revenue';
  if (n.includes('dine'))     return 'Dine-in';
  if (n.includes('takeaway')) return 'Takeaway';
  if (n.includes('delivery')) return 'Delivery';
  if (n.includes('catering')) return 'Catering';
  return name;
}

// Map a stream onto its raw source table + amount expression. Returns null
// for streams we don't know how to source (e.g. a custom stream the tenant
// added manually) — the caller then skips the stream rather than blindly
// reading from clinic_actuals (which was the prior fallback's bug: a
// restaurant tenant's revenue would silently appear under whatever
// non-pharma stream name happened to be active).
//
// Restaurant streams share one table; the extraWhere/extraParams pin each
// stream to a single order_channel so the four restaurant streams don't
// all sum to the same total.
function streamSourceFor(stream: { name: string }):
  { table: string; amountCol: string; monthCol: string; extraWhere?: string; extraParams?: any[] } | null {
  const n = stream.name.toLowerCase();
  if (n.includes('pharma')) {
    return { table: 'pharmacy_sales_actuals', amountCol: '(sales_amount - COALESCE(sales_tax, 0))', monthCol: 'bill_month' };
  }
  if (n.includes('clinic') || n.includes('health') || n.includes('consult')
      || n.includes('diagnos') || n.includes('lab')) {
    // Clinic table absorbs consult / diagnostics / labs for healthcare tenants;
    // the daily brief has always treated them all as bill-line revenue from
    // clinic_actuals. Mentioning each name keeps the prior behaviour explicit.
    return { table: 'clinic_actuals', amountCol: 'item_price', monthCol: 'bill_month' };
  }
  const restaurantChannel =
    n.includes('dine')     ? 'Dine-in'  :
    n.includes('takeaway') ? 'Takeaway' :
    n.includes('delivery') ? 'Delivery' :
    n.includes('catering') ? 'Catering' : null;
  if (restaurantChannel) {
    return {
      table: 'restaurant_sales_actuals',
      amountCol: '(gross_amount - COALESCE(discount, 0))',
      monthCol: 'bill_month',
      extraWhere: " AND order_channel = ? AND (status IS NULL OR status = 'Success')",
      extraParams: [restaurantChannel],
    };
  }
  // Generic catch-all "Restaurant" stream — sums every channel.
  if (n.includes('restaurant')) {
    return {
      table: 'restaurant_sales_actuals',
      amountCol: '(gross_amount - COALESCE(discount, 0))',
      monthCol: 'bill_month',
      extraWhere: " AND (status IS NULL OR status = 'Success')",
      extraParams: [],
    };
  }
  return null;
}

// ── Main entry point ──
export function buildDailyBriefData(
  db: DbHelper,
  ctx: BranchContext,
  options: {
    clientName: string;
    branchName: string;
    branchId: number | null;
    streams: { id: number; name: string; icon?: string; color?: string }[];
    syncedAtLabel?: string;
    filedAtLabel?: string;
    today?: string;             // override "today" (defaults to today-IST in caller)
    yesterday?: string;         // override "yesterday"
  }
): DailyBriefData {
  const bf = branchFilter(ctx, { strict: true });

  const todayStr = options.today || new Date().toISOString().slice(0, 10);
  const yesterdayStr = options.yesterday || fmtYmd(addDays(parseDate(todayStr), -1));
  const today = parseDate(todayStr);
  const yesterday = parseDate(yesterdayStr);

  const cmYear = today.getFullYear();
  const cmMonth = today.getMonth() + 1;
  const currentMonth = `${cmYear}-${String(cmMonth).padStart(2, '0')}`;
  const daysInMonth = new Date(cmYear, cmMonth, 0).getDate();
  const dayOfMonth = today.getDate();
  const daysRemaining = Math.max(0, daysInMonth - dayOfMonth);

  // ── 1. Yesterday's revenue + visits ──
  // Clinic sells the bulk of revenue (consultation + diagnostics + other);
  // pharmacy is its own table.
  const yClinic = db.get(
    `SELECT COALESCE(SUM(item_price), 0) AS rev,
            COUNT(DISTINCT patient_id) AS visits,
            COALESCE(SUM(discount), 0) AS disc,
            COALESCE(SUM(billed), 0)   AS billed
       FROM clinic_actuals
      WHERE bill_date = ?${bf.where}`,
    yesterdayStr, ...bf.params
  );
  const yPharm = db.get(
    `SELECT COALESCE(SUM(sales_amount - COALESCE(sales_tax, 0)), 0) AS rev
       FROM pharmacy_sales_actuals
      WHERE bill_date = ?${bf.where}`,
    yesterdayStr, ...bf.params
  );
  const yRevenue = (yClinic?.rev || 0) + (yPharm?.rev || 0);
  const yVisits = yClinic?.visits || 0;

  // Same-weekday baseline: average of the prior 4 weeks on the same day-of-week.
  const baselineDates: string[] = [];
  for (let i = 1; i <= 4; i++) baselineDates.push(fmtYmd(addDays(yesterday, -7 * i)));
  const placeholders = baselineDates.map(() => '?').join(',');
  const baseRow = db.get(
    `SELECT COALESCE(AVG(daily.rev), 0) AS avg_rev,
            COALESCE(AVG(daily.visits), 0) AS avg_visits
       FROM (
         SELECT bill_date,
                COALESCE(SUM(item_price), 0) AS rev,
                COUNT(DISTINCT patient_id) AS visits
           FROM clinic_actuals
          WHERE bill_date IN (${placeholders})${bf.where}
          GROUP BY bill_date
       ) daily`,
    ...baselineDates, ...bf.params
  );
  const baseRevC = baseRow?.avg_rev || 0;
  const basePharmRow = db.get(
    `SELECT COALESCE(AVG(daily.rev), 0) AS avg_rev
       FROM (
         SELECT bill_date,
                COALESCE(SUM(sales_amount - COALESCE(sales_tax, 0)), 0) AS rev
           FROM pharmacy_sales_actuals
          WHERE bill_date IN (${placeholders})${bf.where}
          GROUP BY bill_date
       ) daily`,
    ...baselineDates, ...bf.params
  );
  const baseRevP = basePharmRow?.avg_rev || 0;
  const baseRevenue = baseRevC + baseRevP;
  const baseVisits = Math.round(baseRow?.avg_visits || 0);
  const yRevDeltaPct = baseRevenue > 0 ? ((yRevenue - baseRevenue) / baseRevenue) * 100 : 0;
  const yVisitsDelta = yVisits - baseVisits;
  const typicalDayLabel = WEEKDAY_LONG[yesterday.getDay()];

  // ── 2. Monthly goal + MTD ──
  // Targets live in forecast_items (category='revenue') under the default
  // scenario per (fy, stream, branch) — same place the Operational
  // Insights screen reads them from. Returns 0 when no scenario / no
  // forecast items exist.
  const fy = db.get('SELECT * FROM financial_years WHERE is_active = 1');
  const monthlyGoal = fy
    ? getMonthlyRevenueTarget(db, ctx, { fyId: fy.id, month: currentMonth })
    : 0;

  const mtdC = db.get(
    `SELECT COALESCE(SUM(item_price), 0) AS rev
       FROM clinic_actuals
      WHERE bill_month = ? AND bill_date <= ?${bf.where}`,
    currentMonth, todayStr, ...bf.params
  );
  const mtdP = db.get(
    `SELECT COALESCE(SUM(sales_amount - COALESCE(sales_tax, 0)), 0) AS rev
       FROM pharmacy_sales_actuals
      WHERE bill_month = ? AND bill_date <= ?${bf.where}`,
    currentMonth, todayStr, ...bf.params
  );
  const mtdRevenue = (mtdC?.rev || 0) + (mtdP?.rev || 0);

  // Yesterday's "target" — uniform daily share of the monthly goal.
  const yTarget = monthlyGoal > 0 ? monthlyGoal / daysInMonth : 0;
  const ySurplus = yRevenue - yTarget;

  // Today's required to stay on pace.
  const requiredRevenue = monthlyGoal > 0 && daysRemaining > 0
    ? Math.max(0, (monthlyGoal - mtdRevenue) / daysRemaining)
    : 0;

  // ── 3. Streams (yesterday's revenue + today's target per stream) ──
  const streams: DailyBriefStream[] = [];
  const todayPerStream: { key: string; label: string; target: number }[] = [];
  for (const s of options.streams) {
    const src = streamSourceFor(s);
    if (!src) continue;
    const xWhere  = src.extraWhere  || '';
    const xParams = src.extraParams || [];
    // Yesterday's revenue from this stream's source table.
    const dayRow = db.get(
      `SELECT COALESCE(SUM(${src.amountCol}), 0) AS rev
         FROM ${src.table}
        WHERE bill_date = ?${bf.where}${xWhere}`,
      yesterdayStr, ...bf.params, ...xParams
    );
    // Stream's monthly target = sum of revenue forecast_items in the
    // default scenario for this (fy, stream, branch).
    const monthlyTarget = fy
      ? getMonthlyRevenueTarget(db, ctx, { fyId: fy.id, month: currentMonth, streamId: s.id })
      : 0;
    const todayTarget = monthlyTarget > 0 && daysRemaining > 0
      ? Math.max(0, (monthlyTarget - (dayRow?.rev || 0)) / daysRemaining)  // crude — refined below
      : 0;
    // MTD for this stream — used for the takeaway line + status colour.
    const mtdRow = db.get(
      `SELECT COALESCE(SUM(${src.amountCol}), 0) AS rev
         FROM ${src.table}
        WHERE bill_month = ? AND bill_date <= ?${bf.where}${xWhere}`,
      currentMonth, todayStr, ...bf.params, ...xParams
    );
    const streamMtd = mtdRow?.rev || 0;
    const projected = dayOfMonth > 0 ? (streamMtd / dayOfMonth) * daysInMonth : 0;
    const projectedPct = monthlyTarget > 0 ? (projected / monthlyTarget) * 100 : 0;
    let status: 'ok' | 'amber' | 'red' = 'ok';
    let statusLabel = 'On track';
    if (monthlyTarget === 0) { statusLabel = 'No target set'; }
    else if (projectedPct >= 100) { statusLabel = 'Ahead'; }
    else if (projectedPct >= 90)  { statusLabel = 'On track'; }
    else if (projectedPct >= 80)  { status = 'amber'; statusLabel = 'Watch'; }
    else                          { status = 'red'; statusLabel = 'Behind'; }
    const takeaway = takeawayCopy(s.name, status, projectedPct);
    const friendlyTarget = monthlyTarget > 0 && daysRemaining > 0
      ? Math.max(0, (monthlyTarget - streamMtd) / daysRemaining)
      : 0;
    streams.push({
      key: s.name,
      label: friendlyStreamLabel(s.name),
      yesterdayRevenue: dayRow?.rev || 0,
      todayTarget: friendlyTarget,
      status,
      statusLabel,
      takeaway,
    });
    todayPerStream.push({ key: s.name, label: friendlyStreamLabel(s.name), target: friendlyTarget });
    void todayTarget;
  }

  // ── 4. Top doctors yesterday (resolved through doctor_aliases) ──
  // The aliases layer added to revenue-sharing canonicalises billed_doctor
  // strings → doctor_id. Reusing it here means "Dr Smith" and "DR.SMITH"
  // collapse into one row on the honour roll. Pharmacy referrers feed the
  // same lookup.
  const topDocsRaw = db.all(
    `SELECT d.id AS doctor_id, d.name AS doctor_name,
            COALESCE(SUM(rev.amount), 0) AS yest_rev
       FROM doctors d
       JOIN doctor_aliases a ON a.doctor_id = d.id
       LEFT JOIN (
         SELECT billed_doctor AS raw_name, item_price AS amount
           FROM clinic_actuals
          WHERE bill_date = ?${bf.where}
            AND billed_doctor IS NOT NULL AND billed_doctor != '' AND billed_doctor != '-'
         UNION ALL
         SELECT referred_by AS raw_name, (sales_amount - COALESCE(sales_tax, 0)) AS amount
           FROM pharmacy_sales_actuals
          WHERE bill_date = ?${bf.where}
            AND referred_by IS NOT NULL AND referred_by != ''
       ) rev ON rev.raw_name = a.alias
      GROUP BY d.id, d.name
      HAVING yest_rev > 0
      ORDER BY yest_rev DESC
      LIMIT 5`,
    yesterdayStr, ...bf.params, yesterdayStr, ...bf.params
  );
  // Typical-day baseline per doctor: average of last 30 calendar days where
  // they actually billed (so a doctor who works 3 days a week shows their
  // working-day average, not a smeared 7-day-week average).
  const thirtyAgo = fmtYmd(addDays(yesterday, -30));
  const topDoctors: DailyBriefDoctor[] = [];
  for (const r of topDocsRaw as any[]) {
    const baselineRow = db.get(
      `SELECT COALESCE(AVG(daily.rev), 0) AS avg_rev
         FROM (
           SELECT bill_date, SUM(amount) AS rev FROM (
             SELECT ca.bill_date AS bill_date, ca.item_price AS amount
               FROM clinic_actuals ca
               JOIN doctor_aliases a ON a.alias = ca.billed_doctor
              WHERE ca.bill_date >= ? AND ca.bill_date <= ? AND a.doctor_id = ?${branchFilter(ctx, { strict: true, alias: 'ca' }).where}
             UNION ALL
             SELECT ps.bill_date AS bill_date, (ps.sales_amount - COALESCE(ps.sales_tax, 0)) AS amount
               FROM pharmacy_sales_actuals ps
               JOIN doctor_aliases a ON a.alias = ps.referred_by
              WHERE ps.bill_date >= ? AND ps.bill_date <= ? AND a.doctor_id = ?${branchFilter(ctx, { strict: true, alias: 'ps' }).where}
           )
           GROUP BY bill_date HAVING rev > 0
         ) daily`,
      thirtyAgo, yesterdayStr, r.doctor_id, ...bf.params,
      thirtyAgo, yesterdayStr, r.doctor_id, ...bf.params
    );
    topDoctors.push({
      name: r.doctor_name,
      yesterdayRevenue: r.yest_rev || 0,
      typicalDayRevenue: Math.round(baselineRow?.avg_rev || 0),
    });
  }

  // ── 5. Silent doctors ──
  // Doctors who billed at least 5 working days in the past 30 but didn't
  // yesterday. Cap at 3 names so the panel stays scannable.
  const silentRaw = db.all(
    `SELECT d.id AS doctor_id, d.name AS doctor_name,
            COUNT(DISTINCT daily.bill_date) AS active_days,
            MAX(daily.bill_date) AS last_billed,
            AVG(daily.rev) AS avg_rev
       FROM doctors d
       JOIN doctor_aliases a ON a.doctor_id = d.id
       JOIN (
         SELECT a2.doctor_id, ca.bill_date,
                SUM(ca.item_price) AS rev
           FROM clinic_actuals ca
           JOIN doctor_aliases a2 ON a2.alias = ca.billed_doctor
          WHERE ca.bill_date >= ? AND ca.bill_date <= ?${branchFilter(ctx, { strict: true, alias: 'ca' }).where}
          GROUP BY a2.doctor_id, ca.bill_date
         HAVING rev > 0
       ) daily ON daily.doctor_id = d.id
      GROUP BY d.id, d.name
     HAVING active_days >= 5 AND last_billed < ?
      ORDER BY active_days DESC, avg_rev DESC
      LIMIT 3`,
    thirtyAgo, yesterdayStr, ...bf.params, yesterdayStr
  );
  const silentDoctors: DailyBriefSilentDoctor[] = (silentRaw as any[]).map(r => ({
    name: r.doctor_name,
    daysQuiet: daysBetween(r.last_billed, yesterdayStr),
    typicalDayRevenue: Math.round(r.avg_rev || 0),
    lastBilledDate: r.last_billed || null,
  }));

  // ── 6. Watchlist ──
  const watchlist: DailyBriefWatchItem[] = [];

  // (a) Stock expiring in 14 days — only meaningful when pharmacy_stock_actuals
  // has data; otherwise quietly skipped.
  const fourteen = fmtYmd(addDays(today, 14));
  const stockExp = db.get(
    `SELECT COUNT(DISTINCT drug_name) AS items, COALESCE(SUM(stock_value), 0) AS value
       FROM pharmacy_stock_actuals
      WHERE expiry_date IS NOT NULL
        AND expiry_date >= ? AND expiry_date <= ?
        AND avl_qty > 0${bf.where}`,
    todayStr, fourteen, ...bf.params
  );
  if (stockExp && stockExp.items > 0) {
    watchlist.push({
      type: 'stock_expiry',
      tone: 'amber',
      title: `${stockExp.items} ${stockExp.items === 1 ? 'medicine expires' : 'medicines expire'} in the next 14 days`,
      subtitle: 'Promote them on the counter today before they have to be written off.',
      rightValue: formatINR(stockExp.value),
      rightSub: 'value at risk',
    });
  }

  // (b) Streams behind for the month
  for (const s of streams) {
    if (s.status === 'red') {
      watchlist.push({
        type: 'stream_behind',
        tone: 'red',
        title: `${s.label} is behind for the month`,
        subtitle: takeawayCopy(s.key, 'red', 0),
        rightValue: s.statusLabel,
        rightSub: 'vs. monthly pace',
      });
    }
  }

  // (c) Discount drift — yesterday's discount % vs 30-day avg.
  if (yClinic && yClinic.billed > 0) {
    const yPct = (yClinic.disc / yClinic.billed) * 100;
    const baseDisc = db.get(
      `SELECT COALESCE(SUM(discount), 0) AS d, COALESCE(SUM(billed), 0) AS b
         FROM clinic_actuals
        WHERE bill_date >= ? AND bill_date < ?${bf.where}`,
      thirtyAgo, yesterdayStr, ...bf.params
    );
    const basePct = baseDisc && baseDisc.b > 0 ? (baseDisc.d / baseDisc.b) * 100 : 0;
    if (basePct > 0 && yPct >= basePct * 1.5) {
      watchlist.push({
        type: 'discount_drift',
        tone: 'amber',
        title: 'Discounts ran higher than usual yesterday',
        subtitle: `${yPct.toFixed(1)}% of yesterday was discounted — a typical day is around ${basePct.toFixed(1)}%.`,
        rightValue: `${yPct.toFixed(1)}%`,
        rightSub: `typical ${basePct.toFixed(1)}%`,
      });
    }
  }

  // (d) Sync failures yesterday or today — branch-scoped so a Hyderabad
  // failure doesn't show up on a Chennai brief. NULL branch_id rows
  // (company-level legacy) flow through bf's default OR-NULL clause.
  const syncFails = db.all(
    `SELECT source, error FROM auto_sync_runs
      WHERE run_date_ist >= ?
        AND status = 'failed'${bf.where}
      ORDER BY started_at DESC LIMIT 3`,
    yesterdayStr, ...bf.params
  );
  if (syncFails.length > 0) {
    const sources = [...new Set((syncFails as any[]).map(r => r.source))].join(', ');
    watchlist.push({
      type: 'sync_failure',
      tone: 'blue',
      title: `${syncFails.length === 1 ? 'A data import' : 'Data imports'} didn't sync this morning`,
      subtitle: `${sources} import${syncFails.length === 1 ? '' : 's'} failed and ${syncFails.length === 1 ? 'is' : 'are'} retrying automatically — no action needed yet.`,
      rightValue: 'Re-running',
      rightSub: 'retry in progress',
    });
  }

  // ── 7. Status strap ──
  const tone: 'ok' | 'amber' | 'red' =
    monthlyGoal === 0 ? 'amber'
    : ySurplus >= 0 ? 'ok'
    : ySurplus >= -0.1 * yTarget ? 'amber'
    : 'red';
  const headline = buildStatusHeadline(tone, ySurplus, yTarget, monthlyGoal);

  // ── 8. Pack response ──
  const monthPct = monthlyGoal > 0 ? (mtdRevenue / monthlyGoal) * 100 : 0;
  const progressPacePct = (dayOfMonth / daysInMonth) * 100;
  const issueNumber = computeIssueNumber(today);

  return {
    meta: {
      clientName: options.clientName,
      branchName: options.branchName,
      branchId: options.branchId,
      yesterday: yesterdayStr,
      today: todayStr,
      yesterdayLabel: `${WEEKDAY_SHORT[yesterday.getDay()]} · ${yesterday.getDate()} ${MONTH_SHORT[yesterday.getMonth()]}`,
      todayLabelLong: `${WEEKDAY_LONG[today.getDay()]}, ${today.getDate()} ${MONTH_LONG[today.getMonth()]} ${today.getFullYear()}`,
      todayLabelShort: `${WEEKDAY_SHORT[today.getDay()]} · ${today.getDate()} ${MONTH_SHORT[today.getMonth()]}`,
      todayWeekday: WEEKDAY_LONG[today.getDay()],
      monthPct: Math.round(monthPct),
      monthLabel: `${MONTH_LONG[today.getMonth()]} ${today.getFullYear()}`,
      dayOfMonth,
      daysInMonth,
      daysRemaining,
      issueNumber,
      syncedAtLabel: options.syncedAtLabel || '—',
      filedAtLabel: options.filedAtLabel || '8:00 AM',
      generatedAtLabel: `${options.filedAtLabel || '8:00 AM'} · ${today.getDate()} ${MONTH_SHORT[today.getMonth()]} ${today.getFullYear()}`,
      progressFillPct: Math.min(100, Math.round(monthPct * 10) / 10),
      progressPacePct: Math.min(100, Math.round(progressPacePct * 10) / 10),
    },
    status: {
      tone,
      headline,
      systems: syncFails.length > 0 ? `${syncFails.length} retry${syncFails.length === 1 ? '' : 'ies'}` : 'All systems',
    },
    yesterday: {
      revenue: Math.round(yRevenue),
      revenueDeltaPct: Math.round(yRevDeltaPct * 10) / 10,
      visits: yVisits,
      visitsDelta: yVisitsDelta,
      typicalVisits: baseVisits,
      typicalDayLabel,
      target: Math.round(yTarget),
      surplus: Math.round(ySurplus),
    },
    streams,
    today: {
      requiredRevenue: Math.round(requiredRevenue),
      perStream: todayPerStream.map(p => ({ ...p, target: Math.round(p.target) })),
      mtdRevenue: Math.round(mtdRevenue),
      monthlyGoal: Math.round(monthlyGoal),
    },
    topDoctors,
    silentDoctors,
    watchlist,
  };
}

// ── Copy helpers (kept here so the friendly tone is reviewable in one place) ──
function takeawayCopy(streamName: string, status: 'ok' | 'amber' | 'red', projectedPct: number): string {
  const n = streamName.toLowerCase();
  if (status === 'red') {
    if (n.includes('consult')) return 'Behind for the month — push new-patient bookings today.';
    if (n.includes('diagnos') || n.includes('lab')) return 'Lab pace has slowed — add packages and preventive panels.';
    if (n.includes('pharma')) return 'Pharmacy is trailing — stock the front counter and check refill calls.';
    return 'Behind pace this month — needs focused effort today.';
  }
  if (status === 'amber') {
    if (n.includes('consult')) return 'Slightly behind — keep new-patient slots open today.';
    if (n.includes('diagnos') || n.includes('lab')) return 'Slightly behind — pitch lab packages on consults.';
    if (n.includes('pharma')) return 'Watch — keep top-sellers stocked.';
    return 'Slightly behind — small push today should close the gap.';
  }
  if (projectedPct >= 110) {
    if (n.includes('diagnos') || n.includes('lab')) return 'Lab is well ahead of pace — a healthy cushion this week.';
    if (n.includes('pharma')) return 'Strong run — keep the floor stocked.';
    return 'Strong run — keep the momentum going.';
  }
  if (n.includes('consult')) return 'On pace — protect new-patient slots.';
  if (n.includes('diagnos') || n.includes('lab')) return 'On pace — keep the cross-sell pitch warm.';
  if (n.includes('pharma')) return 'On pace — front counter is the lever today.';
  return 'On pace — steady as she goes.';
}

function buildStatusHeadline(tone: 'ok' | 'amber' | 'red', surplus: number, target: number, monthlyGoal: number): string {
  if (monthlyGoal === 0) {
    return 'No monthly target set yet — add a budget to see how the day stacks up.';
  }
  if (tone === 'ok') {
    return `On track — yesterday beat the target by ${formatINR(Math.abs(surplus))}, putting us a comfortable nose ahead of pace.`;
  }
  if (tone === 'amber') {
    // tone='amber' with monthlyGoal>0 only fires when surplus is between
    // -10% of yTarget and 0 — the "soft miss" band. The deficit case below
    // is the only reachable branch; an amber tone with surplus≥0 would
    // require monthlyGoal=0, which the early-return at the top handles.
    return `Watch — yesterday came in ${formatINR(Math.abs(surplus))} short of the day's needed run rate.`;
  }
  return `Behind — yesterday missed by ${formatINR(Math.abs(surplus))}; today needs a push to recover.`;
}

function daysBetween(fromYmd: string | null, toYmd: string): number {
  if (!fromYmd) return 0;
  const a = parseDate(fromYmd);
  const b = parseDate(toYmd);
  return Math.round((b.getTime() - a.getTime()) / (24 * 3600 * 1000));
}

// Issue number = days since the launch epoch. Stable, monotonic, no DB.
function computeIssueNumber(today: Date): number {
  const epoch = new Date(2026, 0, 1).getTime();
  return Math.max(1, Math.floor((today.getTime() - epoch) / (24 * 3600 * 1000)) + 1);
}

// Re-export the formatter so render.ts can reuse it without duplicating the rules.
export { formatINR, formatIndian };
