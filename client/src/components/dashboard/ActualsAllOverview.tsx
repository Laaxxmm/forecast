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
  orgInfo: OrgInfo;
  selectStream: (id: string | null, name: string) => void;
}

// ─── Main render ────────────────────────────────────────────────────────────

export default function ActualsAllOverview({ data, historical, clinic, pharma, selectStream }: Props) {
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

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <>
      {/* ── 3-card KPI strip ─────────────────────────────────────────────── */}
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

      {/* ── Forecast advisory banner ─────────────────────────────────────── */}
      {SHOW_FORECAST_ADVISORY && totalForecast > 0 && (
        <div
          className="mb-6 px-3 py-2 rounded-md text-[12px] leading-relaxed"
          style={{
            background: 'color-mix(in srgb, #f59e0b 12%, transparent)',
            color: '#633806',
          }}
        >
          <span style={{ color: '#b45309', marginRight: 6 }}>⚠</span>
          Forecast comparison may be miscalibrated — the annual forecast value appears to be compared against the monthly actual,
          producing the large negative delta shown above. Use month-over-month deltas as the primary signal until forecast logic is reviewed.
        </div>
      )}

      {/* ── Alert center ─────────────────────────────────────────────────── */}
      {alerts.length > 0 && (
        <div className="mt-card p-5 mb-5">
          <div className="flex items-start justify-between gap-3 mb-3">
            <div>
              <h3 className="text-base font-medium" style={{ color: 'var(--mt-text-heading)' }}>
                Things that need your attention
              </h3>
              <p className="text-[13px] mt-0.5" style={{ color: 'var(--mt-text-faint)' }}>
                Top insights from across pharmacy, clinic and stock — click to investigate
              </p>
            </div>
            <p className="text-[12px] shrink-0" style={{ color: 'var(--mt-text-faint)' }}>
              {alerts.length} alert{alerts.length === 1 ? '' : 's'} · sorted by impact
            </p>
          </div>
          <div className="flex flex-col gap-2">
            {alerts.slice(0, 5).map(a => <AlertRow key={a.key} alert={a} />)}
          </div>
          {alerts.length > 5 && (
            <p className="mt-3 text-[12px]" style={{ color: 'var(--mt-text-faint)' }}>
              + {alerts.length - 5} more alert{alerts.length - 5 === 1 ? '' : 's'}
            </p>
          )}
        </div>
      )}

      {/* ── 6-month mini-bar trend ───────────────────────────────────────── */}
      {showTrend ? (
        <div className="mt-card p-5 mb-5">
          <div className="flex items-start justify-between gap-3 mb-1">
            <div>
              <h3 className="text-base font-medium" style={{ color: 'var(--mt-text-heading)' }}>
                6-month revenue trend
              </h3>
              <p className="text-[13px] mt-0.5" style={{ color: 'var(--mt-text-faint)' }}>Clinic + Pharmacy</p>
            </div>
            {trendInsight && (
              <p className="text-[12px] shrink-0 max-w-[55%] text-right" style={{ color: 'var(--mt-text-secondary)' }}>
                {trendInsight}
              </p>
            )}
          </div>
          <div className="grid grid-cols-6 gap-2 mt-5">
            {trendData.map((d) => {
              const fillRatio = d.total / trendMaxTotal;
              const containerHeight = 100;
              const barHeight = Math.max(4, fillRatio * containerHeight);
              const clinicH = d.total > 0 ? (d.clinic / d.total) * barHeight : 0;
              const pharmaH = d.total > 0 ? (d.pharma / d.total) * barHeight : 0;
              const isCurrent = d.month === currentMonth;
              return (
                <div key={d.month} className="flex flex-col items-center">
                  <div
                    className="w-full flex flex-col-reverse"
                    style={{ height: containerHeight, gap: 2 }}
                  >
                    {clinicH > 0 && (
                      <div
                        style={{
                          height: clinicH,
                          background: '#185FA5',
                          borderRadius: pharmaH > 0 ? 0 : '2px 2px 0 0',
                        }}
                        title={`Clinic ${formatINR(Math.round(d.clinic))}`}
                      />
                    )}
                    {pharmaH > 0 && (
                      <div
                        style={{
                          height: pharmaH,
                          background: '#7F77DD',
                          borderRadius: '2px 2px 0 0',
                        }}
                        title={`Pharmacy ${formatINR(Math.round(d.pharma))}`}
                      />
                    )}
                  </div>
                  <p
                    className="text-[11px] mt-2"
                    style={{
                      color: 'var(--mt-text-secondary)',
                      fontWeight: isCurrent ? 500 : 400,
                    }}
                  >
                    {getMonthLabel(d.month)}
                  </p>
                  <p className="text-[10px]" style={{ color: 'var(--mt-text-faint)' }}>
                    {d.total > 0 ? formatCompactInr(d.total) : '—'}
                  </p>
                </div>
              );
            })}
          </div>
          <div className="flex gap-4 mt-4 text-[11px]" style={{ color: 'var(--mt-text-secondary)' }}>
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
      ) : (
        <div
          className="mb-5 px-4 py-3 rounded-lg text-[12px]"
          style={{
            background: 'var(--mt-bg-muted)',
            color: 'var(--mt-text-faint)',
          }}
        >
          Trend will appear once 3+ months of history are available.
        </div>
      )}

      {/* ── Side-by-side Quick view cards ────────────────────────────────── */}
      {(clinic?.hasData || pharma?.hasData) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mb-5">
          {clinic?.hasData && (
            <QuickViewCard
              title="Clinic this month"
              onView={clinicStream ? () => selectStream(String(clinicStream.id), clinicStream.name) : undefined}
              metrics={[
                {
                  label: 'Patients',
                  value: clinicPatientCount != null ? formatNumber(clinicPatientCount) : '—',
                },
                {
                  label: 'Cross-sell rate',
                  value: clinicCrossSellPct != null ? `${clinicCrossSellPct.toFixed(1)}%` : '—',
                },
                {
                  label: 'Top doctor',
                  value: topDoctor?.doctor || topDoctor?.name || '—',
                  sub: topDoctor && topDoctor.crossSellPct != null
                    ? `${Number(topDoctor.crossSellPct).toFixed(0)}% cross-sell`
                    : undefined,
                  subTone: 'positive',
                },
                {
                  label: '3-dept patients',
                  value: threeDeptPatients ? formatNumber(threeDeptPatients.count) : '—',
                  sub: threeDeptPatients?.multiplier
                    ? `@${threeDeptPatients.multiplier.toFixed(1)}×`
                    : undefined,
                },
              ]}
            />
          )}
          {pharma?.hasData && (
            <QuickViewCard
              title="Pharmacy this month"
              onView={pharmaStream ? () => selectStream(String(pharmaStream.id), pharmaStream.name) : undefined}
              metrics={[
                {
                  label: 'Bills',
                  value: pharmaBills != null ? formatNumber(pharmaBills) : '—',
                },
                {
                  label: 'Gross margin',
                  value: pharmaMargin != null ? `${pharmaMargin.toFixed(1)}%` : '—',
                },
                {
                  label: 'Top SKU',
                  value: topSku?.name || '—',
                  sub: topSku
                    ? `${formatINR(topSku.sales)}${topSku.margin != null ? ` · ${topSku.margin.toFixed(1)}%` : ''}`
                    : undefined,
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

      {/* ── "Dig deeper" footer nav ──────────────────────────────────────── */}
      <div
        className="rounded-xl px-5 py-4"
        style={{
          background: 'var(--mt-bg-muted)',
          border: '1px solid var(--mt-border)',
        }}
      >
        <p className="text-[13px] mb-3" style={{ color: 'var(--mt-text-secondary)' }}>Dig deeper</p>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
          <DigDeeperTile title="Forecast"  desc="Set targets, track variance" onClick={() => navigate('/forecast')} />
          <DigDeeperTile title="Analysis"  desc="Trends, breakdowns"          onClick={() => navigate('/analysis')} />
          <DigDeeperTile title="Insights"  desc="Anomaly detection"           onClick={() => navigate('/insights')} />
          <DigDeeperTile title="Scenarios" desc="What-if modeling"            onClick={() => navigate('/scenarios')} />
        </div>
      </div>
    </>
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

// AlertTriangle is imported at the top so the tree-shaking remains stable
// even after the alert subset is conditionally suppressed. Keeping a
// reference here documents the dependency for future maintainers.
void AlertTriangle;
