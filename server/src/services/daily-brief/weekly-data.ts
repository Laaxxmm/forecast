// Builds the data shape consumed by the Weekly Pulse HTML/PDF template.
//
// Aggregates over the previous Mon-Sun week (in IST), with WoW deltas, a
// 4-week trailing baseline for visits, day-by-day breakdown, top-10
// doctors per week, doctors who skipped the entire week, an
// auto-detected weekly pattern, and a longer-horizon watchlist (30-day
// stock expiry, 4-week margin drift, etc.).

import type { DbHelper } from '../../db/connection.js';
import type { BranchContext } from '../../utils/branch.js';
import { branchFilter } from '../../utils/branch.js';
import { formatINR, formatIndian } from './data.js';
import { getMonthlyRevenueTarget } from './targets.js';

// ── Public types ──
export interface WeeklyDayPoint {
  date: string;            // YYYY-MM-DD
  weekday: string;         // "Mon"
  revenue: number;
  visits: number;
  isBest: boolean;
  isWorst: boolean;
  isClosed: boolean;       // weekend / no/low billing day
}

export interface WeeklyStream {
  key: string;
  label: string;
  weekRevenue: number;
  weekVisits: number;
  weekShare: number;       // % of week
  wowDelta: number;        // % vs prior week
  status: 'ok' | 'amber' | 'red';
  statusLabel: string;
  nextWeekTarget: number;
  // Optional extra noun for the "324 patients seen" line.
  unitsLabel?: string;
  unitsCount?: number;
}

export interface WeeklyDoctorRow {
  rank: number;
  name: string;
  weekRevenue: number;
  weekVisits: number;
  typicalWeekRevenue: number;
  typicalWeekVisits: number;
}

export interface WeeklySilentDoctor {
  name: string;
  typicalDaysPerWeek: number;
  typicalDayRevenue: number;
}

export interface WeeklyWatchItem {
  type: 'stock_expiry' | 'stream_behind' | 'discount_drift' | 'margin_drift' | 'refund_concentration' | 'unmapped_doctor';
  tone: 'amber' | 'red' | 'blue';
  title: string;
  subtitle: string;
  rightValue: string;
  rightSub: string;
}

export interface WeeklyPattern {
  label: string;
  text: string;            // may include <b>…</b>
}

export interface WeeklyPulseData {
  meta: {
    clientName: string;
    branchName: string;
    branchId: number | null;
    weekStart: string;       // Mon
    weekEnd: string;         // Sun
    weekRangeShort: string;  // "19 – 25 May"
    weekRangeLong: string;   // "Mon 19 → Sun 25 May"
    weekNumber: number;      // ISO week
    year: number;
    today: string;           // Issue date (Mon)
    todayWeekday: string;
    todayLabelLong: string;
    nextWeekRangeShort: string;
    monthLabel: string;
    monthPct: number;
    dayOfMonth: number;
    daysInMonth: number;
    daysRemaining: number;
    workingDaysRemainingThisWeek: number;
    issueNumber: number;
    syncedAtLabel: string;
    filedAtLabel: string;
    generatedAtLabel: string;
    progressFillPct: number;
    progressWeekSlotPct: number;
    progressPacePct: number;
    dailyTargetLabel: string;
  };
  status: {
    tone: 'ok' | 'amber' | 'red';
    headline: string;
    systems: string;
  };
  week: {
    revenue: number;
    revenueWoWPct: number;       // signed % vs last week
    visits: number;
    visitsWoWDelta: number;      // signed count vs last week
    visitsTrailingAvg: number;   // 4-week average
    target: number;
    daysHit: number;             // # of working days that beat the daily-target line
    workingDays: number;         // total working days in the just-past week (excludes Sun if no rev on Sun)
    daysHitNames: string;        // "Tue, Wed, Fri, Sat"
  };
  chart: {
    days: WeeklyDayPoint[];
    targetLinePct: number;       // percent position of daily target line
    summary: string;             // friendly italic line under the chart
  };
  streams: WeeklyStream[];
  prescription: {
    requiredRevenue: number;
    perStream: { key: string; label: string; target: number; units?: { count: number; label: string } }[];
    mtdRevenue: number;
    monthlyGoal: number;
  };
  topDoctors: WeeklyDoctorRow[];
  silentDoctors: WeeklySilentDoctor[];
  pattern: WeeklyPattern;
  watchlist: WeeklyWatchItem[];
}

// ── Internal helpers ──
const WEEKDAY_LONG = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const WEEKDAY_SHORT = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONTH_LONG = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function parseDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function fmtYmd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addDays(d: Date, n: number): Date {
  const r = new Date(d); r.setDate(d.getDate() + n); return r;
}
// ISO week number (Mon-based, ISO 8601).
function isoWeekNumber(d: Date): number {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const firstThursdayDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstThursdayDayNum + 3);
  return 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000));
}

// See data.ts: previously this fell through to clinic_actuals for any
// non-pharma stream, which would silently misroute restaurant data.
// Returns null for unknown streams so the caller skips them.
function streamSourceFor(stream: { name: string }):
  { table: string; amountCol: string; visitGrouping?: string; extraWhere?: string; extraParams?: any[] } | null {
  const n = stream.name.toLowerCase();
  if (n.includes('pharma')) {
    return { table: 'pharmacy_sales_actuals', amountCol: '(sales_amount - COALESCE(sales_tax, 0))' };
  }
  if (n.includes('clinic') || n.includes('health') || n.includes('consult')
      || n.includes('diagnos') || n.includes('lab')) {
    return { table: 'clinic_actuals', amountCol: 'item_price' };
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
      extraWhere: " AND order_channel = ? AND (status IS NULL OR status = 'Success')",
      extraParams: [restaurantChannel],
    };
  }
  // Generic catch-all "Restaurant" stream — sums every channel.
  if (n.includes('restaurant')) {
    return {
      table: 'restaurant_sales_actuals',
      amountCol: '(gross_amount - COALESCE(discount, 0))',
      extraWhere: " AND (status IS NULL OR status = 'Success')",
      extraParams: [],
    };
  }
  return null;
}

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

function friendlyStreamSubLabel(label: string): string {
  if (label === 'Consultations') return 'Doctor visits';
  if (label === 'Diagnostics') return 'Lab tests';
  if (label === 'Other Revenue') return 'Procedures & packages';
  if (label === 'Pharmacy') return 'Counter sales';
  if (label === 'Dine-in')  return 'Dine-in covers';
  if (label === 'Delivery') return 'Delivery orders';
  if (label === 'Takeaway') return 'Takeaway orders';
  if (label === 'Catering') return 'Catering orders';
  return label;
}

// ── Main builder ──
export function buildWeeklyPulseData(
  db: DbHelper,
  ctx: BranchContext,
  options: {
    clientName: string;
    branchName: string;
    branchId: number | null;
    streams: { id: number; name: string; icon?: string; color?: string }[];
    today: string;             // Monday issue date (YYYY-MM-DD)
    weekStart?: string;        // override (optional) — Mon
    weekEnd?: string;          // override (optional) — Sun
    syncedAtLabel?: string;
    filedAtLabel?: string;
  }
): WeeklyPulseData {
  const bf = branchFilter(ctx, { strict: true });
  const today = parseDate(options.today);

  // Derive the "previous Monday → previous Sunday" window from the issue
  // date. If "today" IS a Monday (the canonical send day), the window is
  // the seven days ending yesterday. For any other anchor day we still
  // walk back to the last full Mon-Sun.
  let weekEnd: Date;
  if (options.weekEnd) weekEnd = parseDate(options.weekEnd);
  else {
    // Walk back to the most recent Sunday.
    weekEnd = addDays(today, -1);
    while (weekEnd.getDay() !== 0) weekEnd = addDays(weekEnd, -1);
  }
  const weekStart = options.weekStart ? parseDate(options.weekStart) : addDays(weekEnd, -6);
  const weekStartStr = fmtYmd(weekStart);
  const weekEndStr = fmtYmd(weekEnd);

  // Prior week (for WoW delta)
  const priorEnd = addDays(weekStart, -1);
  const priorStart = addDays(priorEnd, -6);
  const priorStartStr = fmtYmd(priorStart);
  const priorEndStr = fmtYmd(priorEnd);

  // ── 1. Week revenue + visits ──
  const wClinic = db.get(
    `SELECT COALESCE(SUM(item_price), 0) AS rev,
            COUNT(DISTINCT patient_id) AS visits,
            COALESCE(SUM(discount), 0) AS disc,
            COALESCE(SUM(billed), 0)   AS billed
       FROM clinic_actuals
      WHERE bill_date >= ? AND bill_date <= ?${bf.where}`,
    weekStartStr, weekEndStr, ...bf.params
  );
  const wPharm = db.get(
    `SELECT COALESCE(SUM(sales_amount - COALESCE(sales_tax, 0)), 0) AS rev,
            COALESCE(SUM(profit), 0) AS profit,
            COALESCE(SUM(sales_amount), 0) AS gross
       FROM pharmacy_sales_actuals
      WHERE bill_date >= ? AND bill_date <= ?${bf.where}`,
    weekStartStr, weekEndStr, ...bf.params
  );
  const wRevenue = (wClinic?.rev || 0) + (wPharm?.rev || 0);
  const wVisits = wClinic?.visits || 0;

  const pClinic = db.get(
    `SELECT COALESCE(SUM(item_price), 0) AS rev,
            COUNT(DISTINCT patient_id) AS visits
       FROM clinic_actuals
      WHERE bill_date >= ? AND bill_date <= ?${bf.where}`,
    priorStartStr, priorEndStr, ...bf.params
  );
  const pPharm = db.get(
    `SELECT COALESCE(SUM(sales_amount - COALESCE(sales_tax, 0)), 0) AS rev
       FROM pharmacy_sales_actuals
      WHERE bill_date >= ? AND bill_date <= ?${bf.where}`,
    priorStartStr, priorEndStr, ...bf.params
  );
  const pRevenue = (pClinic?.rev || 0) + (pPharm?.rev || 0);
  const pVisits = pClinic?.visits || 0;
  const wowRevPct = pRevenue > 0 ? ((wRevenue - pRevenue) / pRevenue) * 100 : 0;
  const wowVisitsDelta = wVisits - pVisits;

  // 4-week trailing visit average (the four full weeks ending priorEnd).
  const trailStart = addDays(priorStart, -21);
  const trailEnd = priorEnd;
  const trailRow = db.get(
    `SELECT COALESCE(AVG(daily.visits), 0) * 7 AS avg_week_visits
       FROM (
         SELECT bill_date,
                COUNT(DISTINCT patient_id) AS visits
           FROM clinic_actuals
          WHERE bill_date >= ? AND bill_date <= ?${bf.where}
          GROUP BY bill_date
       ) daily`,
    fmtYmd(trailStart), fmtYmd(trailEnd), ...bf.params
  );
  const visitsTrailingAvg = Math.round(trailRow?.avg_week_visits || 0);

  // ── 2. Day-by-day ──
  const dailyRows = db.all(
    `SELECT daily.bill_date AS bill_date,
            COALESCE(SUM(daily.rev), 0) AS rev,
            COALESCE(MAX(daily.visits), 0) AS visits
       FROM (
         SELECT bill_date, COALESCE(SUM(item_price), 0) AS rev,
                COUNT(DISTINCT patient_id) AS visits
           FROM clinic_actuals
          WHERE bill_date >= ? AND bill_date <= ?${bf.where}
          GROUP BY bill_date
         UNION ALL
         SELECT bill_date, COALESCE(SUM(sales_amount - COALESCE(sales_tax, 0)), 0) AS rev,
                0 AS visits
           FROM pharmacy_sales_actuals
          WHERE bill_date >= ? AND bill_date <= ?${bf.where}
          GROUP BY bill_date
       ) daily
      GROUP BY daily.bill_date`,
    weekStartStr, weekEndStr, ...bf.params,
    weekStartStr, weekEndStr, ...bf.params
  );
  const dailyMap = new Map<string, { rev: number; visits: number }>();
  for (const r of dailyRows as any[]) dailyMap.set(r.bill_date, { rev: r.rev || 0, visits: r.visits || 0 });

  // ── 3. Monthly goal + MTD ──
  const fy = db.get('SELECT * FROM financial_years WHERE is_active = 1');
  const cmYear = today.getFullYear();
  const cmMonth = today.getMonth() + 1;
  const currentMonth = `${cmYear}-${String(cmMonth).padStart(2, '0')}`;
  const daysInMonth = new Date(cmYear, cmMonth, 0).getDate();
  const dayOfMonth = today.getDate();
  const daysRemaining = Math.max(0, daysInMonth - dayOfMonth);

  // Targets live in forecast_items (category='revenue') under the default
  // scenario per (fy, stream, branch) — same source as the Operational
  // Insights screen.
  const monthlyGoal = fy
    ? getMonthlyRevenueTarget(db, ctx, { fyId: fy.id, month: currentMonth })
    : 0;
  const dailyTarget = monthlyGoal > 0 ? monthlyGoal / daysInMonth : 0;
  const weekTarget = dailyTarget * 7;

  const mtdC = db.get(
    `SELECT COALESCE(SUM(item_price), 0) AS rev
       FROM clinic_actuals
      WHERE bill_month = ? AND bill_date <= ?${bf.where}`,
    currentMonth, options.today, ...bf.params
  );
  const mtdP = db.get(
    `SELECT COALESCE(SUM(sales_amount - COALESCE(sales_tax, 0)), 0) AS rev
       FROM pharmacy_sales_actuals
      WHERE bill_month = ? AND bill_date <= ?${bf.where}`,
    currentMonth, options.today, ...bf.params
  );
  const mtdRevenue = (mtdC?.rev || 0) + (mtdP?.rev || 0);

  // Compute working days remaining in the calendar week the issue belongs
  // to (Mon → Sun). For a Monday issue this counts Mon-Sat (6) by default;
  // for a mid-week preview/backfill it caps at days-until-Sunday so the
  // count doesn't overflow into next week. Sun is skipped unless the
  // branch routinely bills on Sundays (inferred from the just-past Sun).
  const weekRunsSundays = (dailyMap.get(weekEndStr)?.rev || 0) > 1000; // ₹1k threshold
  // Days remaining INCLUDING today, until the upcoming Sunday inclusive.
  // today.getDay(): 0=Sun, 1=Mon, …, 6=Sat. Days until Sunday = 7 - getDay()
  // when day !== 0; if today is Sunday itself, only that day remains in
  // its own week.
  const dayOfWeekToday = today.getDay();
  const daysUntilSundayInclusive = dayOfWeekToday === 0 ? 1 : 7 - dayOfWeekToday + 1;
  let workingDaysRemainingThisWeek = 0;
  for (let d = 0; d < daysUntilSundayInclusive; d++) {
    const day = addDays(today, d);
    if (day.getMonth() + 1 !== cmMonth) break; // stop crossing month boundary
    if (day.getDay() === 0 && !weekRunsSundays) continue;
    workingDaysRemainingThisWeek++;
  }
  const requiredRevenue = monthlyGoal > 0 && daysRemaining > 0
    ? Math.max(0, ((monthlyGoal - mtdRevenue) / daysRemaining) * Math.min(workingDaysRemainingThisWeek, daysRemaining))
    : 0;

  // ── 4. Days that hit target + day-by-day breakdown ──
  const days: WeeklyDayPoint[] = [];
  let bestDay: WeeklyDayPoint | null = null;
  let worstDay: WeeklyDayPoint | null = null;
  const daysHitList: string[] = [];
  let workingDaysCount = 0;
  for (let d = 0; d < 7; d++) {
    const date = addDays(weekStart, d);
    const ymd = fmtYmd(date);
    const v = dailyMap.get(ymd) || { rev: 0, visits: 0 };
    const isClosed = date.getDay() === 0 && v.rev < 1000;
    if (!isClosed) workingDaysCount++;
    const point: WeeklyDayPoint = {
      date: ymd,
      weekday: WEEKDAY_SHORT[date.getDay()],
      revenue: Math.round(v.rev),
      visits: v.visits || 0,
      isBest: false,
      isWorst: false,
      isClosed,
    };
    days.push(point);
    if (!isClosed && dailyTarget > 0 && v.rev >= dailyTarget) {
      daysHitList.push(WEEKDAY_SHORT[date.getDay()]);
    }
  }
  // Best / worst designations: best = highest non-closed; worst = lowest non-closed.
  const opens = days.filter(p => !p.isClosed);
  if (opens.length > 0) {
    const sorted = [...opens].sort((a, b) => b.revenue - a.revenue);
    sorted[0].isBest = true;
    if (sorted.length > 1) sorted[sorted.length - 1].isWorst = true;
    bestDay = sorted[0];
    worstDay = sorted[sorted.length - 1];
  }

  const maxBar = days.reduce((m, p) => Math.max(m, p.revenue), 0);
  const chartScale = Math.max(maxBar, dailyTarget * 1.1, 1); // headroom over target
  const targetLinePct = chartScale > 0 ? (dailyTarget / chartScale) * 100 : 0;

  const chartSummary = bestDay
    ? `${WEEKDAY_LONG[parseDate(bestDay.date).getDay()]} carried the week — <b>${formatINR(bestDay.revenue)}</b>, the highest single day. The dotted black line is the daily target the branch needs to clear to stay on monthly pace.`
    : 'No billing recorded across the week — likely a sync gap.';

  // ── 5. Streams ──
  const streams: WeeklyStream[] = [];
  const perStreamPlan: { key: string; label: string; target: number; units?: { count: number; label: string } }[] = [];
  for (const s of options.streams) {
    const src = streamSourceFor(s);
    if (!src) continue;
    const xWhere  = src.extraWhere  || '';
    const xParams = src.extraParams || [];
    const wRow = db.get(
      `SELECT COALESCE(SUM(${src.amountCol}), 0) AS rev
         FROM ${src.table}
        WHERE bill_date >= ? AND bill_date <= ?${bf.where}${xWhere}`,
      weekStartStr, weekEndStr, ...bf.params, ...xParams
    );
    const pRow = db.get(
      `SELECT COALESCE(SUM(${src.amountCol}), 0) AS rev
         FROM ${src.table}
        WHERE bill_date >= ? AND bill_date <= ?${bf.where}${xWhere}`,
      priorStartStr, priorEndStr, ...bf.params, ...xParams
    );
    const weekRev = wRow?.rev || 0;
    const priorRev = pRow?.rev || 0;
    const wowDelta = priorRev > 0 ? ((weekRev - priorRev) / priorRev) * 100 : 0;
    const weekShare = wRevenue > 0 ? (weekRev / wRevenue) * 100 : 0;
    // Stream-level patient/units count.
    let unitsCount: number | undefined;
    let unitsLabel: string | undefined;
    if (src.table === 'clinic_actuals') {
      const u = db.get(
        `SELECT COUNT(DISTINCT patient_id) AS n
           FROM clinic_actuals
          WHERE bill_date >= ? AND bill_date <= ?${bf.where}`,
        weekStartStr, weekEndStr, ...bf.params
      );
      unitsCount = u?.n || 0;
      unitsLabel = 'patients seen';
    } else if (src.table === 'restaurant_sales_actuals') {
      // Restaurant uses COUNT(DISTINCT bill_no) for orders — bill-line grain
      // in the source means many rows roll up to one bill.
      const u = db.get(
        `SELECT COUNT(DISTINCT bill_no) AS n
           FROM restaurant_sales_actuals
          WHERE bill_date >= ? AND bill_date <= ?${bf.where}${xWhere}`,
        weekStartStr, weekEndStr, ...bf.params, ...xParams
      );
      unitsCount = u?.n || 0;
      unitsLabel = 'orders';
    } else {
      const u = db.get(
        `SELECT COUNT(*) AS n
           FROM pharmacy_sales_actuals
          WHERE bill_date >= ? AND bill_date <= ?${bf.where}`,
        weekStartStr, weekEndStr, ...bf.params
      );
      unitsCount = u?.n || 0;
      unitsLabel = 'counter sales';
    }
    // Status from MTD pace
    const mtdRow = db.get(
      `SELECT COALESCE(SUM(${src.amountCol}), 0) AS rev
         FROM ${src.table}
        WHERE bill_month = ? AND bill_date <= ?${bf.where}${xWhere}`,
      currentMonth, options.today, ...bf.params, ...xParams
    );
    const streamMtd = mtdRow?.rev || 0;
    const monthlyTarget = fy
      ? getMonthlyRevenueTarget(db, ctx, { fyId: fy.id, month: currentMonth, streamId: s.id })
      : 0;
    const projected = dayOfMonth > 0 ? (streamMtd / dayOfMonth) * daysInMonth : 0;
    const projectedPct = monthlyTarget > 0 ? (projected / monthlyTarget) * 100 : 0;
    let status: 'ok' | 'amber' | 'red' = 'ok';
    let statusLabel = 'On track';
    if (monthlyTarget === 0) statusLabel = 'No target set';
    else if (projectedPct >= 100) statusLabel = 'Ahead';
    else if (projectedPct >= 90) statusLabel = 'On track';
    else if (projectedPct >= 80) { status = 'amber'; statusLabel = 'Watch'; }
    else { status = 'red'; statusLabel = 'Behind'; }

    const nextWeekTarget = monthlyTarget > 0 && daysRemaining > 0
      ? Math.max(0, ((monthlyTarget - streamMtd) / daysRemaining) * Math.min(workingDaysRemainingThisWeek, daysRemaining))
      : 0;

    const label = friendlyStreamLabel(s.name);
    streams.push({
      key: s.name,
      label,
      weekRevenue: Math.round(weekRev),
      weekVisits: src.table === 'clinic_actuals' ? (unitsCount || 0) : 0,
      weekShare: Math.round(weekShare),
      wowDelta: Math.round(wowDelta),
      status,
      statusLabel,
      nextWeekTarget: Math.round(nextWeekTarget),
      unitsCount,
      unitsLabel,
    });
    perStreamPlan.push({
      key: s.name,
      label,
      target: Math.round(nextWeekTarget),
      units: unitsCount != null ? { count: unitsCount, label: unitsLabel || '' } : undefined,
    });
  }

  // ── 6. Top 10 doctors this week (resolved through doctor_aliases) ──
  const topDocsRaw = db.all(
    `SELECT d.id AS doctor_id, d.name AS doctor_name,
            COALESCE(SUM(rev.amount), 0) AS week_rev,
            COUNT(DISTINCT rev.patient_id) AS week_visits
       FROM doctors d
       JOIN doctor_aliases a ON a.doctor_id = d.id
       LEFT JOIN (
         SELECT billed_doctor AS raw_name, item_price AS amount, patient_id
           FROM clinic_actuals
          WHERE bill_date >= ? AND bill_date <= ?${bf.where}
            AND billed_doctor IS NOT NULL AND billed_doctor != '' AND billed_doctor != '-'
         UNION ALL
         SELECT referred_by AS raw_name, (sales_amount - COALESCE(sales_tax, 0)) AS amount, NULL AS patient_id
           FROM pharmacy_sales_actuals
          WHERE bill_date >= ? AND bill_date <= ?${bf.where}
            AND referred_by IS NOT NULL AND referred_by != ''
       ) rev ON rev.raw_name = a.alias
      GROUP BY d.id, d.name
      HAVING week_rev > 0
      ORDER BY week_rev DESC
      LIMIT 10`,
    weekStartStr, weekEndStr, ...bf.params,
    weekStartStr, weekEndStr, ...bf.params
  );
  // Typical-week baseline: average of the last 4 weeks where they billed
  const fourWeeksAgo = fmtYmd(addDays(weekStart, -28));
  const topDoctors: WeeklyDoctorRow[] = [];
  for (let i = 0; i < (topDocsRaw as any[]).length; i++) {
    const r = (topDocsRaw as any[])[i];
    const baseRow = db.get(
      `SELECT COALESCE(AVG(weekly.rev), 0) AS avg_rev,
              COALESCE(AVG(weekly.visits), 0) AS avg_visits
         FROM (
           SELECT (CAST((julianday(bill_date) - julianday(?)) / 7 AS INTEGER)) AS wk,
                  SUM(amount) AS rev,
                  COUNT(DISTINCT patient_id) AS visits
             FROM (
               SELECT ca.bill_date AS bill_date, ca.item_price AS amount, ca.patient_id
                 FROM clinic_actuals ca
                 JOIN doctor_aliases a ON a.alias = ca.billed_doctor
                WHERE ca.bill_date >= ? AND ca.bill_date < ? AND a.doctor_id = ?${branchFilter(ctx, { strict: true, alias: 'ca' }).where}
               UNION ALL
               SELECT ps.bill_date AS bill_date, (ps.sales_amount - COALESCE(ps.sales_tax, 0)) AS amount, NULL AS patient_id
                 FROM pharmacy_sales_actuals ps
                 JOIN doctor_aliases a ON a.alias = ps.referred_by
                WHERE ps.bill_date >= ? AND ps.bill_date < ? AND a.doctor_id = ?${branchFilter(ctx, { strict: true, alias: 'ps' }).where}
             )
             GROUP BY wk HAVING rev > 0
         ) weekly`,
      fourWeeksAgo,
      fourWeeksAgo, weekStartStr, r.doctor_id, ...bf.params,
      fourWeeksAgo, weekStartStr, r.doctor_id, ...bf.params
    );
    topDoctors.push({
      rank: i + 1,
      name: r.doctor_name,
      weekRevenue: Math.round(r.week_rev || 0),
      weekVisits: r.week_visits || 0,
      typicalWeekRevenue: Math.round(baseRow?.avg_rev || 0),
      typicalWeekVisits: Math.round(baseRow?.avg_visits || 0),
    });
  }

  // ── 7. Skipped doctors — usually billed at least 2 days/week, didn't bill any day this week ──
  const silentRaw = db.all(
    `SELECT d.id AS doctor_id, d.name AS doctor_name,
            COUNT(DISTINCT weekly.bill_date) / 4.0 AS typical_days_per_week,
            COALESCE(AVG(weekly.daily_rev), 0) AS avg_daily_rev,
            MAX(weekly.bill_date) AS last_billed
       FROM doctors d
       JOIN doctor_aliases a ON a.doctor_id = d.id
       JOIN (
         SELECT a2.doctor_id, ca.bill_date,
                SUM(ca.item_price) AS daily_rev
           FROM clinic_actuals ca
           JOIN doctor_aliases a2 ON a2.alias = ca.billed_doctor
          WHERE ca.bill_date >= ? AND ca.bill_date < ?${branchFilter(ctx, { strict: true, alias: 'ca' }).where}
          GROUP BY a2.doctor_id, ca.bill_date HAVING daily_rev > 0
       ) weekly ON weekly.doctor_id = d.id
      GROUP BY d.id, d.name
     HAVING typical_days_per_week >= 2 AND last_billed < ?
      ORDER BY typical_days_per_week DESC, avg_daily_rev DESC
      LIMIT 5`,
    fourWeeksAgo, weekStartStr, ...bf.params, weekStartStr
  );
  const silentDoctors: WeeklySilentDoctor[] = (silentRaw as any[]).map(r => ({
    name: r.doctor_name,
    typicalDaysPerWeek: Math.round(Number(r.typical_days_per_week) * 10) / 10,
    typicalDayRevenue: Math.round(r.avg_daily_rev || 0),
  }));

  // ── 8. Pattern of the week — pick the strongest signal ──
  const pattern = detectPattern(db, ctx, weekStartStr, weekEndStr, dailyMap);

  // ── 9. Watchlist ──
  const watchlist: WeeklyWatchItem[] = [];

  // (a) Stock expiring in next 30 days
  const thirty = fmtYmd(addDays(today, 30));
  const stockExp = db.get(
    `SELECT COUNT(DISTINCT drug_name) AS items, COALESCE(SUM(stock_value), 0) AS value
       FROM pharmacy_stock_actuals
      WHERE expiry_date IS NOT NULL
        AND expiry_date >= ? AND expiry_date <= ?
        AND avl_qty > 0${bf.where}`,
    options.today, thirty, ...bf.params
  );
  if (stockExp && stockExp.items > 0) {
    watchlist.push({
      type: 'stock_expiry',
      tone: 'amber',
      title: `${stockExp.items} ${stockExp.items === 1 ? 'medicine expires' : 'medicines expire'} in the next 30 days`,
      subtitle: 'A wider horizon than the daily — front-of-counter promotion this week is the cleanest recovery.',
      rightValue: formatINR(stockExp.value),
      rightSub: 'value at risk',
    });
  }

  // (b) Streams that are red two weeks running
  for (const s of streams) {
    if (s.status === 'red') {
      watchlist.push({
        type: 'stream_behind',
        tone: 'red',
        title: `${s.label} is behind for the month`,
        subtitle: 'When a stream slips, the monthly recovery starts to require real plays, not nudges.',
        rightValue: s.statusLabel,
        rightSub: 'vs. monthly pace',
      });
    }
  }

  // (c) Discount drift — week vs. trailing 4-week
  if (wClinic && wClinic.billed > 0) {
    const wPct = (wClinic.disc / wClinic.billed) * 100;
    const baseRow = db.get(
      `SELECT COALESCE(SUM(discount), 0) AS d, COALESCE(SUM(billed), 0) AS b
         FROM clinic_actuals
        WHERE bill_date >= ? AND bill_date < ?${bf.where}`,
      fmtYmd(addDays(weekStart, -28)), weekStartStr, ...bf.params
    );
    const basePct = baseRow && baseRow.b > 0 ? (baseRow.d / baseRow.b) * 100 : 0;
    if (basePct > 0 && wPct >= basePct * 1.25) {
      watchlist.push({
        type: 'discount_drift',
        tone: 'amber',
        title: `Discounts ran hotter this week (${wPct.toFixed(1)}%)`,
        subtitle: `Trailing 4-week average is ${basePct.toFixed(1)}%. Worth a quick scan of which counter or doctor drove it.`,
        rightValue: `${wPct.toFixed(1)}%`,
        rightSub: `4-wk avg ${basePct.toFixed(1)}%`,
      });
    }
  }

  // (d) Pharmacy margin drift
  if (wPharm && wPharm.gross > 0) {
    const wMargin = (wPharm.profit / wPharm.gross) * 100;
    const trail = db.get(
      `SELECT COALESCE(SUM(profit), 0) AS p, COALESCE(SUM(sales_amount), 0) AS g
         FROM pharmacy_sales_actuals
        WHERE bill_date >= ? AND bill_date < ?${bf.where}`,
      fmtYmd(addDays(weekStart, -28)), weekStartStr, ...bf.params
    );
    const trailMargin = trail && trail.g > 0 ? (trail.p / trail.g) * 100 : 0;
    if (trailMargin > 0 && wMargin <= trailMargin - 2) {
      watchlist.push({
        type: 'margin_drift',
        tone: 'red',
        title: 'Pharmacy profit margin is drifting',
        subtitle: `${wMargin.toFixed(1)}% this week against a 4-week average of ${trailMargin.toFixed(1)}% — likely a mix shift toward lower-margin generics.`,
        rightValue: `${wMargin.toFixed(1)}%`,
        rightSub: `4-wk avg ${trailMargin.toFixed(1)}%`,
      });
    }
  }

  // (e) Refund concentration — was most refund value on one day?
  const refundRow = db.get(
    `SELECT MAX(daily.r) AS max_day, SUM(daily.r) AS total
       FROM (
         SELECT bill_date, SUM(refund) AS r
           FROM clinic_actuals
          WHERE bill_date >= ? AND bill_date <= ? AND refund > 0${bf.where}
          GROUP BY bill_date
       ) daily`,
    weekStartStr, weekEndStr, ...bf.params
  );
  if (refundRow && refundRow.total > 0 && refundRow.max_day / refundRow.total >= 0.7) {
    watchlist.push({
      type: 'refund_concentration',
      tone: 'amber',
      title: 'Refunds concentrated on a single day',
      subtitle: 'Most refund value sat on one day rather than spread across the week — usually a single batch or operator.',
      rightValue: '1 day',
      rightSub: 'concentration',
    });
  }

  // (f) Unmapped doctor revenue (this week)
  const unmappedRow = db.get(
    `SELECT COALESCE(SUM(rev), 0) AS total FROM (
        SELECT COALESCE(SUM(item_price), 0) AS rev
          FROM clinic_actuals
         WHERE bill_date >= ? AND bill_date <= ?
           AND billed_doctor IS NOT NULL AND billed_doctor != '' AND billed_doctor != '-'
           AND billed_doctor NOT IN (SELECT alias FROM doctor_aliases)${bf.where}
        UNION ALL
        SELECT COALESCE(SUM(sales_amount - COALESCE(sales_tax, 0)), 0) AS rev
          FROM pharmacy_sales_actuals
         WHERE bill_date >= ? AND bill_date <= ?
           AND referred_by IS NOT NULL AND referred_by != ''
           AND referred_by NOT IN (SELECT alias FROM doctor_aliases)${bf.where}
     )`,
    weekStartStr, weekEndStr, ...bf.params,
    weekStartStr, weekEndStr, ...bf.params
  );
  if (unmappedRow && unmappedRow.total > 1000) {
    watchlist.push({
      type: 'unmapped_doctor',
      tone: 'blue',
      title: 'Unmapped doctor revenue on the books',
      subtitle: `${formatINR(unmappedRow.total)} of weekly revenue isn't tagged to a canonical doctor — a rev-share leak until billing fixes the mapping.`,
      rightValue: formatINR(unmappedRow.total),
      rightSub: 'data-quality leak',
    });
  }

  // ── 10. Status strap ──
  const surplus = wRevenue - weekTarget;
  const tone: 'ok' | 'amber' | 'red' =
    monthlyGoal === 0 ? 'amber'
    : surplus >= 0 ? 'ok'
    : surplus >= -0.1 * weekTarget ? 'amber'
    : 'red';
  const headline = monthlyGoal === 0
    ? 'No monthly target set yet — the weekly scoreboard runs without a benchmark until a budget is added.'
    : tone === 'ok'
      ? `A steady week — earnings beat the weekly target by ${formatINR(Math.abs(surplus))}.`
      : tone === 'amber'
        ? `Within striking distance — earnings came in ${formatINR(Math.abs(surplus))} short of the weekly target.`
        : `A short week — earnings missed the weekly target by ${formatINR(Math.abs(surplus))}; the recovery starts now.`;

  // Issue number = ISO week number for stability across the year.
  const weekNumber = isoWeekNumber(weekStart);
  const monthPct = monthlyGoal > 0 ? (mtdRevenue / monthlyGoal) * 100 : 0;
  const progressFillPct = Math.min(100, Math.round(monthPct * 10) / 10);
  const progressPacePct = Math.min(100, Math.round((dayOfMonth / daysInMonth) * 1000) / 10);
  // The week-slot covers the days from today through min(today + 6, end-of-month)
  const weekSlotEndDay = Math.min(daysInMonth, dayOfMonth + workingDaysRemainingThisWeek);
  // Clamp at 0 — a tenant that's already overshooting (progressFillPct > 100)
  // would otherwise produce a negative slot width that renders as a flipped bar.
  const progressWeekSlotPct = Math.max(0, Math.min(100 - progressFillPct, ((weekSlotEndDay - dayOfMonth) / daysInMonth) * 100));

  return {
    meta: {
      clientName: options.clientName,
      branchName: options.branchName,
      branchId: options.branchId,
      weekStart: weekStartStr,
      weekEnd: weekEndStr,
      weekRangeShort: `${weekStart.getDate()} – ${weekEnd.getDate()} ${MONTH_SHORT[weekEnd.getMonth()]}`,
      weekRangeLong: `${WEEKDAY_SHORT[weekStart.getDay()]} ${weekStart.getDate()} → ${WEEKDAY_SHORT[weekEnd.getDay()]} ${weekEnd.getDate()} ${MONTH_SHORT[weekEnd.getMonth()]}`,
      weekNumber,
      year: cmYear,
      today: options.today,
      todayWeekday: WEEKDAY_LONG[today.getDay()],
      todayLabelLong: `${WEEKDAY_LONG[today.getDay()]}, ${today.getDate()} ${MONTH_LONG[today.getMonth()]} ${today.getFullYear()}`,
      nextWeekRangeShort: `${today.getDate()} – ${(addDays(today, workingDaysRemainingThisWeek - 1)).getDate()} ${MONTH_SHORT[today.getMonth()]}`,
      monthLabel: `${MONTH_LONG[today.getMonth()]} ${today.getFullYear()}`,
      monthPct: Math.round(monthPct),
      dayOfMonth,
      daysInMonth,
      daysRemaining,
      workingDaysRemainingThisWeek,
      issueNumber: weekNumber,
      syncedAtLabel: options.syncedAtLabel || '—',
      filedAtLabel: options.filedAtLabel || '7:30 AM',
      generatedAtLabel: `${options.filedAtLabel || '7:30 AM'} · ${today.getDate()} ${MONTH_SHORT[today.getMonth()]} ${today.getFullYear()}`,
      progressFillPct,
      progressWeekSlotPct: Math.round(progressWeekSlotPct * 10) / 10,
      progressPacePct,
      dailyTargetLabel: dailyTarget > 0 ? formatINR(dailyTarget) : 'not set',
    },
    status: {
      tone,
      headline,
      systems: 'All systems',
    },
    week: {
      revenue: Math.round(wRevenue),
      revenueWoWPct: Math.round(wowRevPct * 10) / 10,
      visits: wVisits,
      visitsWoWDelta: wowVisitsDelta,
      visitsTrailingAvg,
      target: Math.round(weekTarget),
      daysHit: daysHitList.length,
      workingDays: Math.max(workingDaysCount, 1),
      daysHitNames: daysHitList.length > 0 ? daysHitList.join(', ') + ' cleared the line' : 'No working day cleared the daily target',
    },
    chart: {
      days,
      targetLinePct: Math.round(targetLinePct * 10) / 10,
      summary: chartSummary,
    },
    streams,
    prescription: {
      requiredRevenue: Math.round(requiredRevenue),
      perStream: perStreamPlan,
      mtdRevenue: Math.round(mtdRevenue),
      monthlyGoal: Math.round(monthlyGoal),
    },
    topDoctors,
    silentDoctors,
    pattern,
    watchlist,
  };
}

// ── Pattern detection — pick the strongest signal from this past week ──
// Picks the day-of-week with the highest sustained outperformance over
// the last 4 weeks. Falls back to a generic "steady week" line when the
// signal isn't strong enough to be useful.
function detectPattern(
  db: DbHelper,
  ctx: BranchContext,
  weekStartStr: string,
  weekEndStr: string,
  _dailyMap: Map<string, { rev: number; visits: number }>
): WeeklyPattern {
  const bf = branchFilter(ctx, { strict: true });
  const start = parseDate(weekStartStr);
  const fourWeeksAgo = fmtYmd(addDays(start, -28));
  // Window is the FOUR weeks BEFORE the active week. Excluding the active
  // week prevents the pattern from being skewed by the same data the rest
  // of the report describes (self-reference). End anchor is the day before
  // the active week starts.
  const baselineEnd = fmtYmd(addDays(start, -1));
  const rows = db.all(
    `SELECT strftime('%w', bill_date) AS dow,
            COALESCE(AVG(daily.r), 0) AS avg_rev
       FROM (
         SELECT bill_date, SUM(item_price) AS r
           FROM clinic_actuals
          WHERE bill_date >= ? AND bill_date <= ?${bf.where}
          GROUP BY bill_date
       ) daily
      GROUP BY strftime('%w', daily.bill_date)`,
    fourWeeksAgo, baselineEnd, ...bf.params
  );
  if (!rows || rows.length === 0) {
    return { label: 'Observation', text: 'A typical week — nothing unusual jumped out across the 4-week window.' };
  }
  const all = (rows as any[]).map(r => ({ dow: Number(r.dow), avg: r.avg_rev }));
  const overall = all.reduce((s, r) => s + r.avg, 0) / all.length;
  if (overall <= 0) {
    return { label: 'Observation', text: 'A quiet 4-week window — not enough signal to pick a pattern.' };
  }
  const ranked = all.slice().sort((a, b) => b.avg - a.avg);
  const best = ranked[0];
  const lift = (best.avg - overall) / overall;
  if (lift >= 0.20) {
    return {
      label: 'Observation',
      text: `${WEEKDAY_LONG[best.dow]}s have run <b>${Math.round(lift * 100)}% above the weekly average</b> for four weeks running — a ${WEEKDAY_LONG[best.dow]} push pays disproportionately.`,
    };
  }
  // Underperforming day signal
  const worst = ranked[ranked.length - 1];
  const dip = (overall - worst.avg) / overall;
  if (dip >= 0.20) {
    return {
      label: 'Observation',
      text: `${WEEKDAY_LONG[worst.dow]}s have run <b>${Math.round(dip * 100)}% below the weekly average</b> for four weeks running — worth investigating whether scheduling or staffing softens that day.`,
    };
  }
  return { label: 'Observation', text: 'Days are flowing evenly across the week — no single weekday is pulling outsized weight.' };
}

// Re-export for the renderer's convenience
export { formatINR, formatIndian };
