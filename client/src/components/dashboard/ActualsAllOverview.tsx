// ─────────────────────────────────────────────────────────────────────────────
// ActualsAllOverview — homepage / "All" view of /actuals
//
// Owns the redesigned All-streams overview: 3 KPI cards with month-over-month
// delta + demoted forecast comparison, the forecast advisory banner, the
// alert center pulling top signals from each sub-tab, the 6-month mini-bar
// trend, side-by-side Clinic + Pharmacy quick-view cards, and the
// "Dig deeper" footer nav.
//
// Stream-specific views (Clinic / Pharmacy) are still rendered by
// DashboardPage via ClinicAnalytics / PharmacyAnalytics — this component
// only renders when no stream is selected.
//
// Data sources (all existing endpoints — no new server work for this file):
//   • /dashboard/overview (passed in via `data` prop) — top-line KPIs
//   • /dashboard/overview with a 6-month window (`historical` prop) — trend + MoM delta
//   • /dashboard/clinic-analytics (`clinic` prop) — clinic quick view + cross-sell alert
//   • /dashboard/pharmacy-analytics (`pharma` prop) — pharmacy quick view + 4 alerts
//
// Sections that need backend signals which don't yet exist (e.g. forecast
// monthly-vs-annual diagnosis) are documented in HOMEPAGE_BACKEND.md.
// ─────────────────────────────────────────────────────────────────────────────

import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowUpRight, AlertTriangle, TrendingUp, TrendingDown,
  Minus, ChevronRight,
} from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Cell, PieChart, Pie,
} from 'recharts';
import { formatINR, formatNumber, formatCompact, getMonthLabel } from '../../utils/format';

// Feature flag for the forecast advisory banner. Flip to false once the
// forecast monthly-vs-annual issue documented in HOMEPAGE_BACKEND.md is
// resolved on the server. Kept in code (not env) so flipping is a one-line
// PR with full review context.
const SHOW_FORECAST_ADVISORY = true;

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatCompactInr(v: number): string {
  // Reuse the project's formatCompact helper but prefix with ₹ so the trend
  // labels and quick-view sub-lines read like rupees ("₹1.4L" not "1.4L").
  return `₹${formatCompact(v)}`;
}

function pct(num: number, denom: number): number {
  return denom > 0 ? (num / denom) * 100 : 0;
}

function isClinicName(name: string): boolean {
  const n = (name || '').toLowerCase();
  return n.includes('clinic') || n.includes('health');
}

function isPharmaName(name: string): boolean {
  return (name || '').toLowerCase().includes('pharma');
}

// Walk a stream's monthly[] array into a Map<month, revenueSum>. The data
// shape from /dashboard/overview returns one row per (month, category); we
// only care about category === 'revenue' here.
function streamMonthlyRevenue(stream: any): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of stream?.monthly || []) {
    if (m.category !== 'revenue') continue;
    out.set(m.month, (out.get(m.month) || 0) + Number(m.total || 0));
  }
  return out;
}

// Produce a sorted list of months that have *any* revenue across the streams
// in `historical`. Used as the time axis for the 6-month mini-bar chart and
// for selecting "current month" / "previous month" cells for MoM delta.
function unionRevenueMonths(streams: any[]): string[] {
  const set = new Set<string>();
  for (const s of streams || []) {
    for (const m of s?.monthly || []) {
      if (m.category === 'revenue' && (Number(m.total) || 0) > 0) {
        set.add(m.month);
      }
    }
  }
  return Array.from(set).sort();
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface OrgInfo {
  orgName: string;
  branchName: string;
  periodLabel: string;
}

interface Props {
  data: any;                 // /dashboard/overview for the selected period
  historical: any | null;    // /dashboard/overview spanning ≥6 months for trend + MoM
  clinic: any | null;        // /dashboard/clinic-analytics — for quick view + cross-sell alert
  pharma: any | null;        // /dashboard/pharmacy-analytics — for quick view + 4 pharmacy alerts
  insights: any | null;      // /dashboard/operational-insights — per-day stream revenue for the daily chart
  orgInfo: OrgInfo;
  selectStream: (id: string | null, name: string) => void;
}

// ─── Main render ────────────────────────────────────────────────────────────

export default function ActualsAllOverview({ data, historical, clinic, pharma, insights, selectStream }: Props) {
  const navigate = useNavigate();
  const streams: any[] = data?.streams || [];

  const clinicStream = streams.find((s: any) => isClinicName(s.name));
  const pharmaStream = streams.find((s: any) => isPharmaName(s.name));

  const totalRevenue = Number(data?.combined?.total_revenue) || 0;
  const totalForecast = Number(data?.combined?.total_budget) || 0;
  const clinicRevenue = Number(clinicStream?.total_revenue) || 0;
  const pharmaRevenue = Number(pharmaStream?.total_revenue) || 0;

  // Historical MoM context — uses the 6-month-window /dashboard/overview
  // call so we have prior-period revenue regardless of what period the user
  // has selected for the headline KPIs.
  const histStreams: any[] = historical?.streams || [];
  const histClinicStream = histStreams.find((s: any) => isClinicName(s.name));
  const histPharmaStream = histStreams.find((s: any) => isPharmaName(s.name));

  const histClinicMonthly = useMemo(() => streamMonthlyRevenue(histClinicStream), [histClinicStream]);
  const histPharmaMonthly = useMemo(() => streamMonthlyRevenue(histPharmaStream), [histPharmaStream]);
  const histAllMonths = useMemo(() => unionRevenueMonths(histStreams), [histStreams]);

  // Pick "current" and "previous" months from the historical series. We
  // prefer the period selected for the headline KPI when it's a single
  // month (e.g., "Current month (May)") so the MoM compares apples-to-
  // apples; for multi-month periods the MoM shifts to "last month vs the
  // month before" which is a less precise comparison and we mark it as
  // such by hiding the delta pill instead of fabricating one.
  const periodMonths = useMemo(() => {
    const set = new Set<string>();
    for (const s of streams || []) {
      for (const m of s?.monthly || []) {
        if (m.category === 'revenue') set.add(m.month);
      }
    }
    return Array.from(set).sort();
  }, [streams]);
  const isSingleMonth = periodMonths.length === 1;
  const currentMonth = isSingleMonth ? periodMonths[0] : null;
  const prevMonth = currentMonth
    ? (() => {
        const idx = histAllMonths.indexOf(currentMonth);
        return idx > 0 ? histAllMonths[idx - 1] : null;
      })()
    : null;

  // Revenue at the prior month, per stream + total. If we have no prior
  // month in the historical window we leave the values null so the delta
  // pill is hidden — never zero-filled.
  const prevTotal     = prevMonth ? (histClinicMonthly.get(prevMonth) || 0) + (histPharmaMonthly.get(prevMonth) || 0) : null;
  const prevClinic    = prevMonth ? (histClinicMonthly.get(prevMonth) || 0) : null;
  const prevPharma    = prevMonth ? (histPharmaMonthly.get(prevMonth) || 0) : null;

  const totalDelta  = (prevTotal != null && prevTotal > 0)  ? pct(totalRevenue - prevTotal, prevTotal) : null;
  const clinicDelta = (prevClinic != null && prevClinic > 0) ? pct(clinicRevenue - prevClinic, prevClinic) : null;
  const pharmaDelta = (prevPharma != null && prevPharma > 0) ? pct(pharmaRevenue - prevPharma, prevPharma) : null;

  // ─── KPI sub-line metrics ─────────────────────────────────────────────────
  // Pulled from sub-tab endpoints when available. Each value defaults to
  // null so the sub-line gracefully degrades to a static label rather than
  // a fabricated number.
  const clinicPatientCount = clinic?.kpi?.totalUnique != null ? Number(clinic.kpi.totalUnique) : null;
  const clinicCrossSellPct = (() => {
    const ttl = Number(clinic?.patientFlow?.totalAppointment) || 0;
    const apptOnly = Number(clinic?.patientFlow?.apptOnly) || 0;
    if (ttl <= 0) return null;
    return ((ttl - apptOnly) / ttl) * 100;
  })();

  const pharmaBills = pharma?.sales?.kpi?.totalBills != null ? Number(pharma.sales.kpi.totalBills) : null;
  const pharmaMargin = pharma?.sales?.kpi?.grossMarginPct != null
    ? Number(pharma.sales.kpi.grossMarginPct)
    : (pharma?.sales?.kpi?.totalNetSales > 0
        ? (Number(pharma.sales.kpi.totalGrossProfit ?? pharma.sales.kpi.totalProfit ?? 0) /
            Number(pharma.sales.kpi.totalNetSales)) * 100
        : null);

  // ─── Alert center ─────────────────────────────────────────────────────────
  // Each alert is an object so the sort step + render step don't have to
  // cross-reference free-standing variables. Severity rank: critical > watch
  // > opportunity. Within a rank, we sort by absolute rupee impact.
  type Alert = {
    key: string;
    severity: 'critical' | 'watch' | 'opportunity';
    title: string;
    detail: string;
    drillLabel: string;
    onClick: () => void;
    rupeeImpact: number;
  };
  const SEVERITY_RANK: Record<Alert['severity'], number> = { critical: 3, watch: 2, opportunity: 1 };

  const alerts = useMemo<Alert[]>(() => {
    const list: Alert[] = [];

    // 1. Margin leak — sum of sales for low-margin (< 5%) rows in
    // pharma.sales.table. Keep in sync with the LOW_MARGIN_THRESHOLD
    // constant in PharmacyAnalytics.tsx.
    if (pharma?.sales?.table?.length && pharmaStream) {
      let leakRupees = 0;
      let leakCount = 0;
      for (const r of pharma.sales.table) {
        const sales = Number(r.sales_amount) || 0;
        const tax   = Number(r.sales_tax) || 0;
        const cogs  = Number(r.purchase_amount) || 0;
        const ns    = sales - tax;
        const profit = ns - cogs;
        if (profit < 0 || ns <= 0) continue; // losses tracked separately, ignore
        const margin = (profit / ns) * 100;
        if (margin < 5) {
          leakRupees += sales;
          leakCount += 1;
        }
      }
      if (leakRupees >= 1000) {
        list.push({
          key: 'margin-leak',
          severity: leakRupees >= 5000 ? 'critical' : 'watch',
          title: `Margin leak: ${formatINR(Math.round(leakRupees))} in revenue at risk`,
          detail: `${formatNumber(leakCount)} pharmacy sale${leakCount === 1 ? '' : 's'} below 5% margin — review pricing or discount logic`,
          drillLabel: 'Sales & Profit',
          onClick: () => selectStream(String(pharmaStream.id), pharmaStream.name),
          rupeeImpact: leakRupees,
        });
      }
    }

    // 2. Sitting stock — purchases that have not yet sold. Available on
    // pharma.crossInsights when both purchases + sales have data.
    const sittingValue = Number(pharma?.crossInsights?.kpi?.purchasedNotSoldValue) || 0;
    if (sittingValue >= 1000 && pharmaStream) {
      list.push({
        key: 'sitting-stock',
        severity: 'watch',
        title: `Sitting stock: ${formatINR(Math.round(sittingValue))} purchased but not yet sold`,
        detail: `${formatNumber(Number(pharma.crossInsights.kpi.purchasedNotSoldCount) || 0)} SKUs purchased this period have zero sales — consider returns or pricing review`,
        drillLabel: 'Cross-Report',
        onClick: () => selectStream(String(pharmaStream.id), pharmaStream.name),
        rupeeImpact: sittingValue,
      });
    }

    // 3. Critical 0–3m expiry — sum of value in the "Critical (0-3m)" zone
    // from the stock expiry-zones aggregation. Some tenants name the zone
    // "Critical" without the parenthetical; handle both.
    const criticalZone = (pharma?.stock?.expiryZones || []).find((z: any) =>
      String(z?.name || '').toLowerCase().startsWith('critical')
    );
    const criticalValue = Number(criticalZone?.value) || 0;
    if (criticalValue >= 1000 && pharmaStream) {
      list.push({
        key: 'critical-expiry',
        severity: criticalValue >= 25000 ? 'critical' : 'watch',
        title: `${formatINR(Math.round(criticalValue))} in stock expiring within 3 months`,
        detail: `${formatNumber(Number(criticalZone.batches) || 0)} batch${Number(criticalZone.batches) === 1 ? '' : 'es'} in the critical 0–3m window — push hard now or write off`,
        drillLabel: 'Stock & Expiry',
        onClick: () => selectStream(String(pharmaStream.id), pharmaStream.name),
        rupeeImpact: criticalValue,
      });
    }

    // 4. Supplier concentration — top stockist's share of total purchases.
    // Tenants buying ~all from one supplier carry single-source risk.
    const stockists = pharma?.purchases?.topStockists || [];
    if (stockists.length > 0 && pharmaStream) {
      const totalSourcing = stockists.reduce((s: number, x: any) => s + (Number(x.value) || 0), 0);
      const topStockistValue = Number(stockists[0].value) || 0;
      const concentration = totalSourcing > 0 ? (topStockistValue / totalSourcing) * 100 : 0;
      if (concentration >= 70) {
        list.push({
          key: 'supplier-concentration',
          severity: 'watch',
          title: `${stockists[0].name} accounts for ${Math.round(concentration)}% of pharmacy purchases`,
          detail: 'High single-supplier concentration — consider diversifying to reduce stock-out / pricing risk',
          drillLabel: 'Purchases',
          onClick: () => selectStream(String(pharmaStream.id), pharmaStream.name),
          rupeeImpact: topStockistValue,
        });
      }
    }

    // 5. Cross-sell opportunity — appointment-only patients who never
    // touched a lab test or other service this period. The rupee
    // opportunity is patient_count × avg_revenue_of_cross_sold_patients.
    const apptOnly = Number(clinic?.patientFlow?.apptOnly) || 0;
    const crossToBoth = Number(clinic?.patientFlow?.crossToBoth) || 0;
    const crossToBothRevenue = Number(clinic?.patientFlow?.crossToBothRevenue) || 0;
    if (apptOnly > 0 && clinicStream) {
      const avgCrossRevenue = crossToBoth > 0 ? crossToBothRevenue / crossToBoth : 0;
      const opportunity = apptOnly * avgCrossRevenue;
      if (opportunity >= 1000) {
        list.push({
          key: 'cross-sell',
          severity: 'opportunity',
          title: `${formatINR(Math.round(opportunity))} cross-sell opportunity from appointment-only patients`,
          detail: `${formatNumber(apptOnly)} patients had a doctor visit but no lab / other services — average cross-sold patient adds ${formatINR(Math.round(avgCrossRevenue))} in revenue`,
          drillLabel: 'Clinic',
          onClick: () => selectStream(String(clinicStream.id), clinicStream.name),
          rupeeImpact: opportunity,
        });
      }
    }

    // Sort: severity desc, then rupee impact desc.
    list.sort((a, b) => {
      if (SEVERITY_RANK[a.severity] !== SEVERITY_RANK[b.severity]) {
        return SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
      }
      return b.rupeeImpact - a.rupeeImpact;
    });
    return list;
  }, [pharma, clinic, pharmaStream, clinicStream, selectStream]);

  // ─── 6-month mini-bar trend ──────────────────────────────────────────────
  // Always uses last-6 months from the historical series; ignores the
  // selected period. If we have fewer than 3 months we hide the chart and
  // show a small "trend appears at 3+ months" note in its place.
  const trendMonths = histAllMonths.slice(-6);
  type TrendPoint = { month: string; clinic: number; pharma: number; total: number };
  const trendData: TrendPoint[] = trendMonths.map(m => {
    const c = histClinicMonthly.get(m) || 0;
    const p = histPharmaMonthly.get(m) || 0;
    return { month: m, clinic: c, pharma: p, total: c + p };
  });
  const trendMaxTotal = Math.max(1, ...trendData.map(d => d.total));
  const showTrend = trendData.length >= 3;
  const trendInsight = (() => {
    if (trendData.length < 2) return '';
    const last = trendData[trendData.length - 1];
    if (last.pharma === 0 && last.clinic === 0) return '';
    const pharmaLeading = last.pharma > last.clinic;
    // Detect crossover within the visible window (clinic was leading and
    // pharma overtook, or vice versa). Walks the series chronologically and
    // flags the first month where the leader flips.
    let crossoverMonth: string | null = null;
    let prevPharmaLead: boolean | null = null;
    for (const p of trendData) {
      if (p.clinic === 0 && p.pharma === 0) continue;
      const lead = p.pharma > p.clinic;
      if (prevPharmaLead != null && lead !== prevPharmaLead) {
        crossoverMonth = p.month;
      }
      prevPharmaLead = lead;
    }
    if (crossoverMonth) {
      return `${pharmaLeading ? 'Pharmacy' : 'Clinic'} is now the larger stream — overtook ${pharmaLeading ? 'clinic' : 'pharmacy'} in ${getMonthLabel(crossoverMonth)}`;
    }
    return `${pharmaLeading ? 'Pharmacy' : 'Clinic'} remains the larger stream this window`;
  })();

  // ─── Quick-view derived fields ────────────────────────────────────────────
  const topDoctor = useMemo(() => {
    const doctors = clinic?.doctorCrossSell || [];
    if (!doctors.length) return null;
    return doctors.slice().sort((a: any, b: any) => (Number(b.crossSellPct) || 0) - (Number(a.crossSellPct) || 0))[0];
  }, [clinic]);

  const threeDeptPatients = useMemo(() => {
    const arr = clinic?.revenueByDeptCount || [];
    const row = arr.find((x: any) => Number(x.deptCount) === 3);
    if (!row) return null;
    const baseline = arr.find((x: any) => Number(x.deptCount) === 1);
    const mult = baseline?.avgRevenue > 0 && row.avgRevenue > 0
      ? row.avgRevenue / baseline.avgRevenue
      : null;
    return { count: Number(row.patients) || 0, multiplier: mult };
  }, [clinic]);

  const topSku = useMemo(() => {
    const list = pharma?.sales?.topDrugsBySales || [];
    if (!list.length) return null;
    const t = list[0];
    // Find margin from topDrugsByProfit when available; otherwise fall back
    // to derivation from the sales table.
    const profitEntry = (pharma?.sales?.topDrugsByProfit || []).find((d: any) => d.name === t.name);
    let margin = profitEntry?.marginPct != null ? Number(profitEntry.marginPct) : null;
    if (margin == null && pharma?.sales?.table?.length) {
      let ns = 0, profit = 0;
      for (const r of pharma.sales.table) {
        if (r.drug_name !== t.name) continue;
        const s = Number(r.sales_amount) || 0;
        const tx = Number(r.sales_tax) || 0;
        const c = Number(r.purchase_amount) || 0;
        ns += s - tx;
        profit += (s - tx) - c;
      }
      if (ns > 0) margin = (profit / ns) * 100;
    }
    return { name: t.name, sales: Number(t.sales) || 0, margin };
  }, [pharma]);

  const stockAtRisk = (() => {
    const expired = (pharma?.stock?.expiryZones || []).find((z: any) =>
      String(z?.name || '').toLowerCase() === 'expired'
    );
    const critical = (pharma?.stock?.expiryZones || []).find((z: any) =>
      String(z?.name || '').toLowerCase().startsWith('critical')
    );
    return (Number(expired?.value) || 0) + (Number(critical?.value) || 0);
  })();

  // ─── Daily revenue chart data (from operational-insights) ────────────────
  // /dashboard/operational-insights returns one `daily` array per stream
  // with per-day revenue for the current month. We sum across streams to
  // get a single combined-revenue series, then pad to the full month so
  // the chart always shows all days (past = solid, future = ghost). The
  // brief explicitly asks for past-vs-future visual distinction.
  const dailyRevenueChart = useMemo(() => {
    const rows = insights?.streams || [];
    if (!rows.length || !insights?.daysInMonth) return null;
    const byDate = new Map<string, number>();
    for (const s of rows) {
      for (const d of s.daily || []) {
        const date = String(d.date || '');
        if (!date) continue;
        byDate.set(date, (byDate.get(date) || 0) + (Number(d.revenue) || 0));
      }
    }
    const monthKey = String(insights.month || '');
    const [yStr, mStr] = monthKey.split('-');
    const year = Number(yStr), monthNum = Number(mStr);
    const daysInMonth = Number(insights.daysInMonth);
    const daysElapsed = Number(insights.daysElapsed) || 0;
    if (!year || !monthNum || !daysInMonth) return null;
    const series: { day: number; date: string; revenue: number; isFuture: boolean }[] = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const date = `${year}-${String(monthNum).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      series.push({ day: d, date, revenue: byDate.get(date) || 0, isFuture: d > daysElapsed });
    }
    const target = Number(insights.combined?.targetRevenue) || 0;
    const projected = Number(insights.combined?.projectedRevenue) || 0;
    const dailyTarget = target > 0 ? Math.round(target / daysInMonth) : 0;
    return {
      series, dailyTarget, daysInMonth, daysElapsed,
      monthLabel: getMonthLabel(monthKey),
      projected,
    };
  }, [insights]);

  // ─── Render — 2-column grid (main + sticky sidebar) ──────────────────────
  return (
    <div
      className="grid gap-4 grid-cols-1 lg:[grid-template-columns:1fr_320px]"
    >
      {/* ── Main column ─────────────────────────────────────────────────── */}
      <div className="min-w-0">
        {/* KPI strip — kept exactly as-is from the previous redesign. */}
        <div data-tour="kpi-cards" className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-5">
          <KpiCard
            label="TOTAL REVENUE"
            value={formatINR(totalRevenue)}
            delta={totalDelta}
            prevValue={prevTotal}
            rightSubText={prevTotal != null && prevTotal > 0 ? `${totalRevenue - prevTotal >= 0 ? '+' : ''}${formatINR(totalRevenue - prevTotal)}` : null}
            footerLabel={totalForecast > 0 ? `Forecast: ${formatINR(totalForecast)} (${isSingleMonth ? 'monthly' : 'period'})` : null}
            footerDelta={totalForecast > 0 ? pct(totalRevenue - totalForecast, totalForecast) : null}
          />
          <KpiCard
            label="CLINIC"
            value={formatINR(clinicRevenue)}
            delta={clinicDelta}
            prevValue={prevClinic}
            rightSubText={totalRevenue > 0 ? `${pct(clinicRevenue, totalRevenue).toFixed(1)}% of total` : null}
            footerLabel={
              clinicPatientCount != null
                ? `${formatNumber(clinicPatientCount)} patient${clinicPatientCount === 1 ? '' : 's'}${clinicCrossSellPct != null ? ` · ${clinicCrossSellPct.toFixed(0)}% cross-sell` : ''}`
                : null
            }
            footerLink={clinicStream ? () => selectStream(String(clinicStream.id), clinicStream.name) : null}
            footerLinkLabel="view"
          />
          <KpiCard
            label="PHARMACY"
            value={formatINR(pharmaRevenue)}
            delta={pharmaDelta}
            prevValue={prevPharma}
            rightSubText={totalRevenue > 0 ? `${pct(pharmaRevenue, totalRevenue).toFixed(1)}% of total` : null}
            footerLabel={
              pharmaBills != null
                ? `${formatNumber(pharmaBills)} bill${pharmaBills === 1 ? '' : 's'}${pharmaMargin != null ? ` · ${pharmaMargin.toFixed(1)}% margin` : ''}`
                : null
            }
            footerLink={pharmaStream ? () => selectStream(String(pharmaStream.id), pharmaStream.name) : null}
            footerLinkLabel="view"
          />
        </div>

        {/* 6-month stacked bar trend — full width of main column. Hides
            entirely when fewer than 3 months of history exist; the old
            "trend appears at 3+ months" placeholder is intentionally
            gone (it ate prime real estate for a non-actionable hint). */}
        {showTrend && (
          <RevenueTrendChart
            trendData={trendData}
            currentMonth={currentMonth}
            insight={trendInsight}
          />
        )}

        {/* Revenue mix donut + Daily revenue this month (side-by-side). */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-5">
          <RevenueMixDonut
            clinic={clinicRevenue}
            pharma={pharmaRevenue}
            total={totalRevenue}
          />
          {dailyRevenueChart && dailyRevenueChart.daysElapsed >= 2 && (
            <DailyRevenueChart
              series={dailyRevenueChart.series}
              dailyTarget={dailyRevenueChart.dailyTarget}
              daysInMonth={dailyRevenueChart.daysInMonth}
              daysElapsed={dailyRevenueChart.daysElapsed}
              monthLabel={dailyRevenueChart.monthLabel}
              projected={dailyRevenueChart.projected}
            />
          )}
        </div>

        {/* Quick view cards — kept exactly as-is. */}
        {(clinic?.hasData || pharma?.hasData) && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mb-5">
            {clinic?.hasData && (
              <QuickViewCard
                title="Clinic this month"
                onView={clinicStream ? () => selectStream(String(clinicStream.id), clinicStream.name) : undefined}
                metrics={[
                  { label: 'Patients', value: clinicPatientCount != null ? formatNumber(clinicPatientCount) : '—' },
                  { label: 'Cross-sell rate', value: clinicCrossSellPct != null ? `${clinicCrossSellPct.toFixed(1)}%` : '—' },
                  {
                    label: 'Top doctor',
                    value: topDoctor?.doctor || topDoctor?.name || '—',
                    sub: topDoctor && topDoctor.crossSellPct != null ? `${Number(topDoctor.crossSellPct).toFixed(0)}% cross-sell` : undefined,
                    subTone: 'positive',
                  },
                  {
                    label: '3-dept patients',
                    value: threeDeptPatients ? formatNumber(threeDeptPatients.count) : '—',
                    sub: threeDeptPatients?.multiplier ? `@${threeDeptPatients.multiplier.toFixed(1)}×` : undefined,
                  },
                ]}
              />
            )}
            {pharma?.hasData && (
              <QuickViewCard
                title="Pharmacy this month"
                onView={pharmaStream ? () => selectStream(String(pharmaStream.id), pharmaStream.name) : undefined}
                metrics={[
                  { label: 'Bills', value: pharmaBills != null ? formatNumber(pharmaBills) : '—' },
                  { label: 'Gross margin', value: pharmaMargin != null ? `${pharmaMargin.toFixed(1)}%` : '—' },
                  {
                    label: 'Top SKU',
                    value: topSku?.name || '—',
                    sub: topSku ? `${formatINR(topSku.sales)}${topSku.margin != null ? ` · ${topSku.margin.toFixed(1)}%` : ''}` : undefined,
                    subTone: topSku?.margin != null && topSku.margin < 5 ? 'danger' : undefined,
                    subWarn: topSku?.margin != null && topSku.margin < 5,
                  },
                  {
                    label: 'Stock at risk',
                    value: stockAtRisk > 0 ? formatINR(Math.round(stockAtRisk)) : '—',
                    valueTone: stockAtRisk > 0 ? 'danger' : undefined,
                  },
                ]}
              />
            )}
          </div>
        )}

        {/* Dig deeper footer — kept inside main column. */}
        <div
          className="rounded-xl px-5 py-4"
          style={{ background: 'var(--mt-bg-muted)', border: '1px solid var(--mt-border)' }}
        >
          <p className="text-[13px] mb-3" style={{ color: 'var(--mt-text-secondary)' }}>Dig deeper</p>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
            <DigDeeperTile title="Forecast"  desc="Set targets, track variance" onClick={() => navigate('/forecast')} />
            <DigDeeperTile title="Analysis"  desc="Trends, breakdowns"          onClick={() => navigate('/analysis')} />
            <DigDeeperTile title="Insights"  desc="Anomaly detection"           onClick={() => navigate('/insights')} />
            <DigDeeperTile title="Scenarios" desc="What-if modeling"            onClick={() => navigate('/scenarios')} />
          </div>
        </div>
      </div>

      {/* ── Right sidebar (sticky alerts + forecast advisory) ───────────── */}
      <div className="min-w-0">
        <div className="lg:sticky lg:top-4 flex flex-col gap-3">
          <AlertsSidebarCard alerts={alerts} />
          {SHOW_FORECAST_ADVISORY && totalForecast > 0 && (
            <div
              className="rounded-md text-[11px] leading-relaxed"
              style={{
                background: '#FAEEDA',
                color: '#633806',
                border: '1px solid rgba(99,56,6,0.18)',
                padding: '10px 12px',
              }}
            >
              <span style={{ color: '#b45309', marginRight: 6 }}>⚠</span>
              Forecast comparison may be miscalibrated — annual forecast appears compared against monthly actual.
              Use month-over-month deltas as the primary signal until the forecast logic is reviewed.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function KpiCard({ label, value, delta, prevValue, rightSubText, footerLabel, footerDelta, footerLink, footerLinkLabel }: {
  label: string;
  value: string;
  delta: number | null;          // month-over-month %, null when prior period unavailable
  prevValue: number | null;      // last-month rupees, null when unavailable
  rightSubText: string | null;   // absolute MoM diff or "X% of total" — right-aligned in row 3
  footerLabel?: string | null;   // left side of footer row (e.g., "Forecast: ₹X (monthly)")
  footerDelta?: number | null;   // forecast delta % when this is a Total card
  footerLink?: (() => void) | null;
  footerLinkLabel?: string;
}) {
  const showDelta = delta != null && isFinite(delta);
  const showFooter = footerLabel || footerLink;
  return (
    <div
      className="rounded-xl px-5 py-4"
      style={{
        background: 'var(--mt-bg-surface)',
        border: '1px solid var(--mt-border)',
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <p
          className="text-[11px]"
          style={{
            color: 'var(--mt-text-muted)',
            letterSpacing: '0.5px',
            textTransform: 'uppercase',
            fontWeight: 500,
          }}
        >
          {label}
        </p>
        {showDelta && <DeltaPill delta={delta} />}
      </div>
      <p className="mt-2" style={{ fontSize: 28, fontWeight: 500, color: 'var(--mt-text-heading)' }}>
        {value}
      </p>
      {(prevValue != null || rightSubText) && (
        <div className="mt-1.5 flex items-center justify-between gap-2 text-[12px]">
          <span style={{ color: 'var(--mt-text-secondary)' }}>
            {prevValue != null && prevValue > 0 ? `vs ${formatINR(Math.round(prevValue))} last month` : ''}
          </span>
          {rightSubText && (
            <span style={{ color: 'var(--mt-text-faint)' }}>{rightSubText}</span>
          )}
        </div>
      )}
      {showFooter && (
        <div
          className="mt-3 pt-2.5 flex items-center justify-between gap-2 text-[11px]"
          style={{ borderTop: '1px solid var(--mt-border)' }}
        >
          <span style={{ color: 'var(--mt-text-faint)' }}>{footerLabel || ''}</span>
          {footerDelta != null && isFinite(footerDelta) && (
            <span style={{ color: footerDelta >= 0 ? '#0F6E56' : '#A32D2D', fontWeight: 500 }}>
              {footerDelta >= 0 ? '+' : ''}{footerDelta.toFixed(1)}%
            </span>
          )}
          {footerLink && footerLinkLabel && (
            <button
              onClick={footerLink}
              className="inline-flex items-center gap-1"
              style={{ color: 'var(--mt-accent-text)', cursor: 'pointer' }}
            >
              {footerLinkLabel} <ArrowUpRight size={11} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function DeltaPill({ delta }: { delta: number }) {
  if (delta === 0) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-md text-[12px]"
        style={{ background: 'var(--mt-bg-muted)', color: 'var(--mt-text-faint)', padding: '2px 8px', fontWeight: 500 }}
      >
        <Minus size={11} /> 0%
      </span>
    );
  }
  const positive = delta > 0;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md text-[12px]"
      style={{
        background: positive ? '#EAF3DE' : '#FCEBEB',
        color: positive ? '#173404' : '#501313',
        padding: '2px 8px',
        fontWeight: 500,
      }}
    >
      {positive ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
      {positive ? '+' : ''}{delta.toFixed(1)}%
    </span>
  );
}

const ALERT_TONE: Record<'critical' | 'watch' | 'opportunity', { accent: string; bg: string; title: string; detail: string; link: string }> = {
  critical:    { accent: '#A32D2D', bg: '#FCEBEB', title: '#501313', detail: '#73271D', link: '#A32D2D' },
  watch:       { accent: '#B45309', bg: '#FAEEDA', title: '#412402', detail: '#633806', link: '#B45309' },
  opportunity: { accent: '#1D4ED8', bg: '#E6F1FB', title: '#0B2D6F', detail: '#1A3D7C', link: '#1D4ED8' },
};

function AlertRow({ alert }: { alert: { key: string; severity: 'critical' | 'watch' | 'opportunity'; title: string; detail: string; drillLabel: string; onClick: () => void } }) {
  const tone = ALERT_TONE[alert.severity];
  return (
    <button
      onClick={alert.onClick}
      className="w-full text-left rounded-md flex items-stretch gap-3 transition-shadow"
      style={{
        background: tone.bg,
        cursor: 'pointer',
      }}
    >
      <div style={{ width: 4, background: tone.accent, borderRadius: '4px 0 0 4px' }} />
      <div className="flex-1 py-3 pr-4 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] truncate" style={{ color: tone.title, fontWeight: 500 }}>
            {alert.title}
          </p>
          <p className="text-[12px] mt-0.5 leading-snug" style={{ color: tone.detail }}>
            {alert.detail}
          </p>
        </div>
        <span className="inline-flex items-center gap-1 text-[11px] shrink-0" style={{ color: tone.link, fontWeight: 500 }}>
          {alert.drillLabel} <ArrowUpRight size={11} />
        </span>
      </div>
    </button>
  );
}

type QuickViewMetric = {
  label: string;
  value: string;
  sub?: string;
  subTone?: 'positive' | 'danger';
  subWarn?: boolean;
  valueTone?: 'danger';
};

function QuickViewCard({ title, onView, metrics }: {
  title: string;
  onView?: () => void;
  metrics: QuickViewMetric[];
}) {
  return (
    <div
      className="rounded-xl px-5 py-4"
      style={{
        background: 'var(--mt-bg-surface)',
        border: '1px solid var(--mt-border)',
      }}
    >
      <div className="flex items-start justify-between mb-1">
        <div>
          <h3 className="text-base font-medium" style={{ color: 'var(--mt-text-heading)' }}>{title}</h3>
          <p className="text-[13px] mt-0.5" style={{ color: 'var(--mt-text-faint)' }}>Quick view</p>
        </div>
        {onView && (
          <button
            onClick={onView}
            className="inline-flex items-center gap-1 text-[12px]"
            style={{ color: 'var(--mt-accent-text)', cursor: 'pointer' }}
          >
            view <ArrowUpRight size={11} />
          </button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-3 mt-4">
        {metrics.map(m => (
          <div key={m.label}>
            <p className="text-[11px]" style={{ color: 'var(--mt-text-muted)' }}>{m.label}</p>
            <p
              className="mt-0.5"
              style={{
                fontSize: 16,
                fontWeight: 500,
                color: m.valueTone === 'danger' ? '#A32D2D' : 'var(--mt-text-heading)',
                lineHeight: 1.3,
              }}
            >
              {m.value}
            </p>
            {m.sub && (
              <p
                className="text-[11px] mt-0.5"
                style={{
                  color: m.subTone === 'positive' ? '#0F6E56'
                    : m.subTone === 'danger' ? '#A32D2D'
                    : 'var(--mt-text-faint)',
                  fontWeight: m.subTone ? 500 : 400,
                }}
              >
                {m.subWarn && <span style={{ marginRight: 4 }}>⚠</span>}
                {m.sub}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function DigDeeperTile({ title, desc, onClick }: { title: string; desc: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="text-left rounded-md transition-colors"
      style={{
        background: 'var(--mt-bg-surface)',
        border: '1px solid var(--mt-border)',
        padding: '10px 12px',
        cursor: 'pointer',
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-[12px]" style={{ color: 'var(--mt-text-heading)', fontWeight: 500 }}>{title}</p>
        <ChevronRight size={12} style={{ color: 'var(--mt-text-faint)' }} />
      </div>
      <p className="text-[11px] mt-0.5" style={{ color: 'var(--mt-text-faint)' }}>{desc}</p>
    </button>
  );
}

// ─── Sidebar alerts card (sticky, scrollable list) ─────────────────────────
//
// Replaces the full-width Alert Center block in the previous redesign.
// Same alert objects + AlertRow internals — just wrapped in a card with
// header (title + count pill + "sorted by impact" sub) and footer
// ("auto-refreshes" line + view-all). The card is sticky inside the
// right column of the page-level grid so it stays visible while the
// main column scrolls.

type SidebarAlert = {
  key: string;
  severity: 'critical' | 'watch' | 'opportunity';
  title: string;
  detail: string;
  drillLabel: string;
  onClick: () => void;
};

function AlertsSidebarCard({ alerts }: { alerts: SidebarAlert[] }) {
  const visible = alerts.slice(0, 8); // brief caps at 8 visible
  const count = alerts.length;
  const hasAlerts = count > 0;
  return (
    <div
      className="rounded-xl flex flex-col"
      style={{
        background: 'var(--mt-bg-surface)',
        border: '1px solid var(--mt-border)',
      }}
    >
      {/* Header */}
      <div
        className="flex items-start justify-between gap-2"
        style={{ padding: 16, borderBottom: '1px solid var(--mt-border)' }}
      >
        <div>
          <p style={{ fontSize: 14, fontWeight: 500, color: 'var(--mt-text-heading)' }}>
            Things that need attention
          </p>
          <p className="text-[11px] mt-0.5" style={{ color: 'var(--mt-text-faint)' }}>
            Sorted by impact
          </p>
        </div>
        <span
          className="rounded-md text-[11px] tabular-nums shrink-0"
          style={{
            background: hasAlerts ? '#FCEBEB' : 'var(--mt-bg-muted)',
            color: hasAlerts ? '#501313' : 'var(--mt-text-faint)',
            padding: '2px 8px',
            fontWeight: 500,
          }}
        >
          {count}
        </span>
      </div>

      {/* Scrollable list */}
      <div
        className="flex flex-col gap-2"
        style={{ padding: 12, maxHeight: 600, overflowY: 'auto' }}
      >
        {hasAlerts ? (
          visible.map(a => <SidebarAlertRow key={a.key} alert={a} />)
        ) : (
          <p className="text-[12px] text-center py-4" style={{ color: 'var(--mt-text-faint)' }}>
            All clear — nothing demanding attention right now.
          </p>
        )}
      </div>

      {/* Footer */}
      <div
        className="flex items-center justify-between gap-2 text-[11px]"
        style={{ padding: '10px 16px', borderTop: '1px solid var(--mt-border)' }}
      >
        {/* No client-side refresh timestamp tracked yet — surface the
            background-refresh cadence instead. The page reloads via the
            normal page-level data fetches; alerts are recomputed from
            the same data so they're as fresh as the rest of the page. */}
        <span style={{ color: 'var(--mt-text-faint)' }}>Auto-refreshes with page</span>
        <span style={{ color: '#185FA5', cursor: 'default' }} title="Full alerts page coming soon">
          View all <ArrowUpRight size={10} className="inline align-text-top" />
        </span>
      </div>
    </div>
  );
}

// Each alert row inside the sidebar list. Uses a 3px coloured left
// border + tinted background per severity, matching the brief.
function SidebarAlertRow({ alert }: { alert: SidebarAlert }) {
  const TONES: Record<SidebarAlert['severity'], { bg: string; border: string; title: string; body: string; link: string }> = {
    critical:    { bg: '#FCEBEB', border: '#A32D2D', title: '#501313', body: '#A32D2D', link: '#A32D2D' },
    watch:       { bg: '#FAEEDA', border: '#BA7517', title: '#412402', body: '#854F0B', link: '#854F0B' },
    opportunity: { bg: '#E6F1FB', border: '#185FA5', title: '#042C53', body: '#0C447C', link: '#185FA5' },
  };
  const t = TONES[alert.severity];
  return (
    <button
      onClick={alert.onClick}
      className="rounded-md text-left transition-shadow"
      style={{
        background: t.bg,
        borderLeft: `3px solid ${t.border}`,
        padding: 12,
        cursor: 'pointer',
      }}
    >
      <p className="text-[12px]" style={{ color: t.title, fontWeight: 500, marginBottom: 4 }}>
        {alert.title}
      </p>
      <p className="text-[11px]" style={{ color: t.body, lineHeight: 1.4, marginBottom: 8 }}>
        {alert.detail}
      </p>
      <p className="text-[10px]" style={{ color: t.link, fontWeight: 500 }}>
        {alert.drillLabel} <ArrowUpRight size={9} className="inline align-text-top" />
      </p>
    </button>
  );
}

// ─── 6-month stacked-bar revenue trend ─────────────────────────────────────

function RevenueTrendChart({ trendData, currentMonth, insight }: {
  trendData: { month: string; clinic: number; pharma: number; total: number }[];
  currentMonth: string | null;
  insight: string;
}) {
  // Recharts stacked bar — clinic first (bottom), pharmacy second (top).
  // Current-month tick is bolded by overriding the X-axis tick render.
  const chartData = trendData.map(d => ({
    label: getMonthLabel(d.month),
    month: d.month,
    Clinic: d.clinic,
    Pharmacy: d.pharma,
  }));
  return (
    <div
      className="rounded-xl mb-5"
      style={{
        background: 'var(--mt-bg-surface)',
        border: '1px solid var(--mt-border)',
        padding: '1.25rem',
      }}
    >
      <div className="flex items-start justify-between gap-3 mb-1">
        <div>
          <h3 style={{ fontSize: 16, fontWeight: 500, color: 'var(--mt-text-heading)' }}>
            6-month revenue trend
          </h3>
          {insight && (
            <p className="text-[13px] mt-0.5" style={{ color: 'var(--mt-text-secondary)' }}>{insight}</p>
          )}
        </div>
        <p className="text-[12px] shrink-0" style={{ color: 'var(--mt-text-faint)' }}>
          Clinic + Pharmacy stacked
        </p>
      </div>
      <div className="mt-4">
        <ResponsiveContainer width="100%" height={180}>
          <BarChart data={chartData} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--mt-border)" vertical={false} />
            <XAxis
              dataKey="label"
              tick={(props: any) => {
                const { x, y, payload } = props;
                const idx = chartData.findIndex(d => d.label === payload.value);
                const isCurrent = idx >= 0 && chartData[idx].month === currentMonth;
                return (
                  <text
                    x={x}
                    y={y + 12}
                    textAnchor="middle"
                    fontSize={10}
                    fontWeight={isCurrent ? 500 : 400}
                    fill={isCurrent ? '#04342C' : 'var(--mt-text-secondary)'}
                  >
                    {payload.value}
                  </text>
                );
              }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              tick={{ fontSize: 9, fill: 'var(--mt-text-faint)' }}
              tickFormatter={(v: number) => `₹${formatCompact(v)}`}
              width={42}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: 'var(--mt-bg-raised)',
                border: '1px solid var(--mt-border)',
                borderRadius: '10px',
                fontSize: '11px',
                boxShadow: 'var(--mt-shadow-pop)',
              }}
              formatter={(v: number) => formatINR(Math.round(v))}
            />
            <Bar dataKey="Clinic" stackId="rev" fill="#185FA5" radius={[0, 0, 0, 0]} />
            <Bar dataKey="Pharmacy" stackId="rev" fill="#7F77DD" radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="flex gap-4 mt-3 text-[12px]" style={{ color: 'var(--mt-text-secondary)' }}>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: '#185FA5' }} />
          Clinic
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: '#7F77DD' }} />
          Pharmacy
        </span>
      </div>
    </div>
  );
}

// ─── Revenue mix donut ─────────────────────────────────────────────────────

function RevenueMixDonut({ clinic, pharma, total }: { clinic: number; pharma: number; total: number }) {
  const data = [
    { name: 'Clinic', value: clinic, color: '#185FA5' },
    { name: 'Pharmacy', value: pharma, color: '#7F77DD' },
  ].filter(d => d.value > 0);
  const clinicPct = total > 0 ? (clinic / total) * 100 : 0;
  const pharmaPct = total > 0 ? (pharma / total) * 100 : 0;
  return (
    <div
      className="rounded-xl"
      style={{
        background: 'var(--mt-bg-surface)',
        border: '1px solid var(--mt-border)',
        padding: '1.25rem',
      }}
    >
      <h3 style={{ fontSize: 16, fontWeight: 500, color: 'var(--mt-text-heading)' }}>
        Revenue mix
      </h3>
      <p className="text-[12px] mt-0.5" style={{ color: 'var(--mt-text-faint)' }}>
        Where this month's {formatINR(total)} came from
      </p>
      <div className="flex items-center gap-4 mt-3">
        {/* Donut chart with center "Total" label. Width and height locked
            to 110×110 per the brief — the chart fills the same box. */}
        <div style={{ position: 'relative', width: 110, height: 110, flexShrink: 0 }}>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={data.length > 0 ? data : [{ name: 'No data', value: 1, color: '#E5E7EB' }]}
                cx="50%"
                cy="50%"
                innerRadius={36}
                outerRadius={54}
                dataKey="value"
                strokeWidth={0}
                isAnimationActive={false}
              >
                {(data.length > 0 ? data : [{ name: 'No data', value: 1, color: '#E5E7EB' }]).map((d, i) => (
                  <Cell key={i} fill={d.color} />
                ))}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
          {/* Center label — absolutely positioned over the donut hole. */}
          <div
            style={{
              position: 'absolute', inset: 0,
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              pointerEvents: 'none',
            }}
          >
            <span className="text-[10px]" style={{ color: 'var(--mt-text-faint)' }}>Total</span>
            <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--mt-text-heading)' }}>
              {`₹${formatCompact(total)}`}
            </span>
          </div>
        </div>
        {/* Right-side legend — two rows. */}
        <div className="flex flex-col gap-2 min-w-0 flex-1">
          <div>
            <div className="flex items-center gap-1.5">
              <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: '#185FA5' }} />
              <span className="text-[12px]" style={{ color: 'var(--mt-text-secondary)' }}>Clinic</span>
            </div>
            <p className="text-[12px] tabular-nums" style={{ color: 'var(--mt-text-heading)', marginLeft: 16 }}>
              {formatINR(clinic)} <span style={{ color: 'var(--mt-text-faint)' }}>· {clinicPct.toFixed(1)}%</span>
            </p>
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: '#7F77DD' }} />
              <span className="text-[12px]" style={{ color: 'var(--mt-text-secondary)' }}>Pharmacy</span>
            </div>
            <p className="text-[12px] tabular-nums" style={{ color: 'var(--mt-text-heading)', marginLeft: 16 }}>
              {formatINR(pharma)} <span style={{ color: 'var(--mt-text-faint)' }}>· {pharmaPct.toFixed(1)}%</span>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Daily revenue this month ──────────────────────────────────────────────

function DailyRevenueChart({ series, dailyTarget, daysInMonth, daysElapsed, monthLabel, projected }: {
  series: { day: number; date: string; revenue: number; isFuture: boolean }[];
  dailyTarget: number;
  daysInMonth: number;
  daysElapsed: number;
  monthLabel: string;
  projected: number;
}) {
  const chartData = series.map(d => ({
    day: String(d.day),
    revenue: d.revenue,
    isFuture: d.isFuture,
  }));
  // Future days render as low-opacity grey ghosts. We give them a small
  // placeholder height (10% of the largest actual bar) so the chart
  // doesn't end abruptly at today's date. The brief calls for a
  // "fixed short height" — using 10% of max keeps it visible without
  // dominating.
  const maxActual = Math.max(0, ...series.filter(d => !d.isFuture).map(d => d.revenue));
  const ghostHeight = maxActual > 0 ? maxActual * 0.1 : (dailyTarget > 0 ? dailyTarget * 0.1 : 0);
  const renderData = chartData.map(d => ({
    ...d,
    revenue: d.isFuture ? ghostHeight : d.revenue,
  }));
  return (
    <div
      className="rounded-xl"
      style={{
        background: 'var(--mt-bg-surface)',
        border: '1px solid var(--mt-border)',
        padding: '1.25rem',
      }}
    >
      <h3 style={{ fontSize: 16, fontWeight: 500, color: 'var(--mt-text-heading)' }}>
        Daily revenue · this month
      </h3>
      <p className="text-[12px] mt-0.5" style={{ color: 'var(--mt-text-faint)' }}>
        Day {daysElapsed} of {daysInMonth}{projected > 0 ? ` · projected ${formatINR(Math.round(projected))}` : ''}
      </p>
      <div className="mt-3" style={{ position: 'relative' }}>
        <ResponsiveContainer width="100%" height={110}>
          <BarChart data={renderData} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <XAxis dataKey="day" hide />
            <YAxis hide domain={[0, 'dataMax']} />
            <Tooltip
              contentStyle={{
                backgroundColor: 'var(--mt-bg-raised)',
                border: '1px solid var(--mt-border)',
                borderRadius: '10px',
                fontSize: '11px',
                boxShadow: 'var(--mt-shadow-pop)',
              }}
              labelFormatter={(label) => `Day ${label}`}
              formatter={(_v: number, _name, props: any) =>
                props.payload?.isFuture
                  ? ['Future day', 'Day']
                  : [formatINR(props.payload.revenue || 0), 'Revenue']
              }
            />
            {dailyTarget > 0 && (
              <ReferenceLine
                y={dailyTarget}
                stroke="#BA7517"
                strokeDasharray="4 4"
                strokeWidth={2}
                label={{
                  value: `Target ₹${formatCompact(dailyTarget)}/d`,
                  position: 'right',
                  fill: '#BA7517',
                  fontSize: 8,
                  fontWeight: 500,
                }}
              />
            )}
            <Bar dataKey="revenue" radius={[2, 2, 0, 0]}>
              {renderData.map((d, i) => (
                <Cell
                  key={i}
                  fill={d.isFuture ? '#B4B2A9' : '#1D9E75'}
                  fillOpacity={d.isFuture ? 0.25 : 1}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="flex justify-between mt-2 text-[10px]" style={{ color: 'var(--mt-text-faint)' }}>
        <span>1 {monthLabel.split('-')[0]}</span>
        <span>{daysInMonth} {monthLabel.split('-')[0]}</span>
      </div>
    </div>
  );
}

// AlertTriangle is imported at the top so the tree-shaking remains stable
// even after the alert subset is conditionally suppressed. Keeping a
// reference here documents the dependency for future maintainers.
void AlertTriangle;
