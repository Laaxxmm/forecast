import { useEffect, useState } from 'react';
import api from '../../api/client';
import { formatINR, formatNumber } from '../../utils/format';
import { Users, Stethoscope, FlaskConical, Activity, Repeat } from 'lucide-react';
import DataTable, { type ColumnDef } from '../common/DataTable';

interface ClinicAnalyticsProps {
  isVisible: (key: string) => boolean;
  startMonth?: string | null;
  endMonth?: string | null;
}

export default function ClinicAnalytics({ isVisible, startMonth, endMonth }: ClinicAnalyticsProps) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const params: Record<string, string> = {};
    if (startMonth) params.startMonth = startMonth;
    if (endMonth) params.endMonth = endMonth;

    // Abort the previous request when the user switches month before the
    // first response lands. Without this, a slow April fetch could resolve
    // *after* the user picked May, overwriting the May data with April's
    // — visible as a brief flash of stale numbers.
    const ctl = new AbortController();
    setLoading(true);
    api.get('/dashboard/clinic-analytics', { params, signal: ctl.signal }).then(res => {
      if (ctl.signal.aborted) return;
      setData(res.data);
      setLoading(false);
    }).catch(() => {
      if (ctl.signal.aborted) return;
      setLoading(false);
    });
    return () => ctl.abort();
  }, [startMonth, endMonth]);

  const patientTable = data?.patientTable || [];

  if (loading) return (
    <div className="text-center py-6">
      <div className="w-5 h-5 border-2 border-teal-500/30 border-t-teal-500 rounded-full animate-spin mx-auto" />
    </div>
  );

  if (!data?.hasData) return null;

  const { kpi, departmentOverlap, revenueByDeptCount, patientFlow, doctorCrossSell } = data;

  const VOLUME_KEYS = ['total_unique_patients', 'appointment_patients', 'lab_test_patients', 'other_services_patients', 'walkins_repeat'];
  const VALUE_KEYS  = ['total_revenue', 'revenue_per_patient_kpi', 'cross_sell_rate', 'multi_dept_share'];
  const CHART_KEYS  = ['cross_sell_hero', 'appointment_flow', 'doctor_performance'];
  const anyVolumeVisible = VOLUME_KEYS.some(isVisible);
  const anyValueVisible  = VALUE_KEYS.some(isVisible);
  const anyChartVisible  = CHART_KEYS.some(isVisible);
  const tableVisible     = isVisible('patient_summary_table');

  if (!anyVolumeVisible && !anyValueVisible && !anyChartVisible && !tableVisible) return null;

  // ── Derived metrics ────────────────────────────────────────────────────
  // All numbers come from the existing /dashboard/clinic-analytics payload.
  // We compute on the client so we don't need to extend the API.

  // Total Revenue across all patients in the period (sum of paid amounts).
  const totalRevenue = patientTable.reduce(
    (s: number, p: any) => s + (p.total_paid || 0),
    0,
  );
  const revenuePerPatient = kpi.totalUnique > 0 ? totalRevenue / kpi.totalUnique : 0;

  // Cross-Sell Rate is per-appointment-patient: of all patients who booked
  // an appointment, how many also touched another department. The four
  // patientFlow partitions (crossToOther / crossToLab / crossToBoth /
  // apptOnly) are mutually exclusive and sum to the appointment patient
  // count, so we re-derive that count here rather than reusing
  // kpi.apptPatients (which is encounter-level, not patient-level).
  const apptPatientCount =
    (patientFlow.crossToOther || 0) +
    (patientFlow.crossToLab || 0) +
    (patientFlow.crossToBoth || 0) +
    (patientFlow.apptOnly || 0);
  const crossSoldCount =
    (patientFlow.crossToOther || 0) +
    (patientFlow.crossToLab || 0) +
    (patientFlow.crossToBoth || 0);
  const crossSellRate = apptPatientCount > 0 ? (crossSoldCount / apptPatientCount) * 100 : 0;

  const multiDeptCount = (departmentOverlap.in2 || 0) + (departmentOverlap.in3 || 0);
  const multiDeptShare = kpi.totalUnique > 0 ? (multiDeptCount / kpi.totalUnique) * 100 : 0;

  const totalWalkins = (kpi.directLabWalkins || 0) + (kpi.directOtherWalkins || 0);

  const crossSellRevenue =
    (patientFlow.crossToOtherRevenue || 0) +
    (patientFlow.crossToLabRevenue || 0) +
    (patientFlow.crossToBothRevenue || 0);
  const apptOnlyRevenue = patientFlow.apptOnlyRevenue || 0;
  const apptRevenueTotal = crossSellRevenue + apptOnlyRevenue;
  const crossSellRevPct = apptRevenueTotal > 0
    ? Math.round((crossSellRevenue / apptRevenueTotal) * 100)
    : 0;

  // Hero card tile data: avg revenue per dept-count bucket. The API
  // already gives us deptCount / patients / avgRevenue per bucket.
  const heroTiles = [1, 2, 3].map(n => {
    const row = (revenueByDeptCount as any[]).find(r => r.deptCount === n);
    return {
      deptCount: n,
      patients: row?.patients ?? 0,
      avgRevenue: Math.round(row?.avgRevenue ?? 0),
    };
  });
  const heroBaseAvg = heroTiles[0].avgRevenue || 1;
  const heroMaxAvg = Math.max(heroBaseAvg, heroTiles[1].avgRevenue, heroTiles[2].avgRevenue, 1);
  const heroMaxMultiplier = (heroMaxAvg / heroBaseAvg).toFixed(1);

  // Appointment-flow rows for the left column of the merged flow card.
  const flowRows = [
    { label: 'Appointment only',    value: patientFlow.apptOnly     || 0, color: 'rgb(100 116 139)' /* slate-500 */ },
    { label: '+ Lab tests',         value: patientFlow.crossToLab   || 0, color: 'rgb(167 139 250)' /* violet-400 */ },
    { label: '+ Lab + Other',       value: patientFlow.crossToBoth  || 0, color: 'rgb(124 58 237)'  /* violet-600 */ },
    { label: '+ Other services',    value: patientFlow.crossToOther || 0, color: 'rgb(59 130 246)'  /* blue-500 */ },
  ];

  // Server flags `isEmpty: true` when the table is healthy but no rows
  // exist for the selected period+branch (e.g. early in a new month
  // before the first import). We still render the KPI cards (they show
  // 0s) so the user sees structure rather than a blank page, plus a
  // discreet hint about the empty state.
  const isEmpty = !!data?.isEmpty;

  // Tile palette for the "Why cross-sell matters" hero card. Tints stay
  // light, text uses the dark stop of the same ramp so contrast holds in
  // both themes via the `text-{color}-700` token mapped through CSS vars.
  const heroTileStyles = [
    { bg: 'rgb(148 163 184 / 0.12)', border: 'rgb(148 163 184 / 0.30)', barText: 'rgb(71 85 105)',  bar: 'rgb(100 116 139)', text: 'rgb(71 85 105)'  },
    { bg: 'rgb(59 130 246 / 0.10)',  border: 'rgb(59 130 246 / 0.25)',  barText: 'rgb(29 78 216)',   bar: 'rgb(37 99 235)',  text: 'rgb(29 78 216)'  },
    { bg: 'rgb(139 92 246 / 0.10)',  border: 'rgb(139 92 246 / 0.25)',  barText: 'rgb(91 33 182)',   bar: 'rgb(124 58 237)', text: 'rgb(91 33 182)'  },
  ];

  return (
    <div className="mt-5">
      <div className="flex items-center gap-2 mb-3">
        <Stethoscope size={16} className="text-teal-400" />
        <h2 className="text-base font-medium text-theme-heading">Clinic Analytics</h2>
        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-teal-500/10 text-teal-400">Healthplix</span>
      </div>

      {isEmpty && (
        <div
          className="mb-3 px-3 py-2 rounded-lg text-xs"
          style={{
            background: 'color-mix(in srgb, var(--mt-accent) 8%, transparent)',
            border: '1px solid color-mix(in srgb, var(--mt-accent) 25%, transparent)',
            color: 'var(--mt-text-muted)',
          }}
        >
          No clinic data imported for this period yet — cards will populate as
          you import. For the forecast-vs-actual view, see the Insights page.
        </div>
      )}

      {/* ── Volume row ───────────────────────────────────────────────
          Operational counts. The "Walk-ins · Repeat" card consolidates
          three former cards (Direct Lab Walk-ins, Direct Other
          Walk-ins, Repeat Visits) so the row stays at five tiles. */}
      {anyVolumeVisible && (() => {
        const visibleCount = VOLUME_KEYS.filter(isVisible).length;
        const lgColsClass: Record<number, string> = { 1: '', 2: 'lg:grid-cols-2', 3: 'lg:grid-cols-3', 4: 'lg:grid-cols-4', 5: 'lg:grid-cols-5' };
        return (
          <div className="mb-4">
            <p className="mb-1.5 text-[12px] uppercase tracking-[0.5px] text-theme-faint">Volume</p>
            <div className={`grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 ${lgColsClass[visibleCount] || 'lg:grid-cols-5'} gap-2.5`}>
              {isVisible('total_unique_patients') && (
                <MiniKPI label="Unique Patients" value={formatNumber(kpi.totalUnique)} icon={Users} color="teal" />
              )}
              {isVisible('appointment_patients') && (
                <MiniKPI label="Appointments" value={formatNumber(kpi.apptPatients)} icon={Stethoscope} color="blue" />
              )}
              {isVisible('lab_test_patients') && (
                <MiniKPI label="Lab Tests" value={formatNumber(kpi.labPatients)} icon={FlaskConical} color="purple" />
              )}
              {isVisible('other_services_patients') && (
                <MiniKPI label="Other Services" value={formatNumber(kpi.otherPatients)} icon={Activity} color="amber" />
              )}
              {isVisible('walkins_repeat') && (
                <MiniKPI
                  label="Walk-ins · Repeat"
                  value={`${formatNumber(totalWalkins)} / ${formatNumber(kpi.repeatVisits || 0)}`}
                  icon={Repeat}
                  color="teal"
                  sub={`${formatNumber(kpi.repeatPatients || 0)} returned`}
                />
              )}
            </div>
          </div>
        );
      })()}

      {/* ── Value row ────────────────────────────────────────────────
          Financial outcomes. Neutral surface (no tint) to visually
          contrast with the Volume row above. */}
      {anyValueVisible && (() => {
        const visibleCount = VALUE_KEYS.filter(isVisible).length;
        const lgColsClass: Record<number, string> = { 1: '', 2: 'lg:grid-cols-2', 3: 'lg:grid-cols-3', 4: 'lg:grid-cols-4' };
        return (
          <div className="mb-4">
            <p className="mb-1.5 text-[12px] uppercase tracking-[0.5px] text-theme-faint">Value</p>
            <div className={`grid grid-cols-2 md:grid-cols-2 ${lgColsClass[visibleCount] || 'lg:grid-cols-4'} gap-2.5`}>
              {isVisible('total_revenue') && (
                <ValueKPI label="Total Revenue" value={formatINR(totalRevenue)} sub={`${formatNumber(kpi.totalUnique)} patients`} />
              )}
              {isVisible('revenue_per_patient_kpi') && (
                <ValueKPI label="Revenue / Patient" value={formatINR(Math.round(revenuePerPatient))} sub="Average across all patients" />
              )}
              {isVisible('cross_sell_rate') && (
                <ValueKPI
                  label="Cross-Sell Rate"
                  value={`${crossSellRate.toFixed(0)}%`}
                  sub={`${formatNumber(crossSoldCount)} of ${formatNumber(apptPatientCount)} appt patients`}
                />
              )}
              {isVisible('multi_dept_share') && (
                <ValueKPI
                  label="Multi-Dept Share"
                  value={`${multiDeptShare.toFixed(0)}%`}
                  sub={`${formatNumber(multiDeptCount)} of ${formatNumber(kpi.totalUnique)} patients`}
                />
              )}
            </div>
          </div>
        );
      })()}

      {/* ── Insight cards ────────────────────────────────────────────
          Three consolidated cards replace the eight legacy chart cards.
          Hidden in the empty-period state because tile bars and flow
          rows have nothing meaningful to render at zero. */}
      {!isEmpty && anyChartVisible && (
        <div className="grid grid-cols-1 gap-3 mb-4">

          {/* Why cross-sell matters — replaces department_overlap,
              patient_dept_donut, dept_combination_bars,
              revenue_per_patient. */}
          {isVisible('cross_sell_hero') && (
            <div className="rounded-xl p-5" style={{ background: 'var(--mt-bg-raised)', border: '0.5px solid var(--mt-border)' }}>
              <h3 className="text-base font-medium text-theme-heading">Why cross-sell matters</h3>
              <p className="text-[13px] text-theme-secondary mt-0.5">Revenue lift per patient</p>
              <p className="text-[13px] text-theme-faint mt-1">
                3-department patients are worth {heroMaxMultiplier}× a single-department patient.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-4">
                {heroTiles.map((tile, i) => {
                  const style = heroTileStyles[i];
                  const mult = heroBaseAvg > 0 ? (tile.avgRevenue / heroBaseAvg).toFixed(1) : '1.0';
                  const widthPct = heroMaxAvg > 0 ? Math.max(8, (tile.avgRevenue / heroMaxAvg) * 100) : 0;
                  const heading = `${tile.deptCount} ${tile.deptCount === 1 ? 'Department' : 'Departments'} · ${mult}×`;
                  return (
                    <div
                      key={i}
                      className="rounded-xl p-4"
                      style={{ background: style.bg, border: `0.5px solid ${style.border}` }}
                    >
                      <p className="text-[12px] font-medium uppercase tracking-[0.5px]" style={{ color: style.text }}>
                        {heading}
                      </p>
                      <p className="text-xl font-medium mt-2" style={{ color: style.text }}>{formatINR(tile.avgRevenue)}</p>
                      <p className="text-[12px] mt-0.5" style={{ color: style.text, opacity: 0.75 }}>
                        {formatNumber(tile.patients)} patient{tile.patients === 1 ? '' : 's'}
                      </p>
                      <div className="h-1.5 rounded-full mt-3" style={{ background: 'rgb(0 0 0 / 0.05)' }}>
                        <div
                          className="h-full rounded-full"
                          style={{ width: `${widthPct}%`, background: style.bar }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Where appointment patients went next — replaces
              cross_sell_funnel + patient_flow_sankey. */}
          {isVisible('appointment_flow') && (
            <div className="rounded-xl p-5" style={{ background: 'var(--mt-bg-raised)', border: '0.5px solid var(--mt-border)' }}>
              <h3 className="text-base font-medium text-theme-heading">Where appointment patients went next</h3>
              <p className="text-[13px] text-theme-secondary mt-0.5">
                {formatNumber(apptPatientCount)} patient{apptPatientCount === 1 ? '' : 's'} started with an appointment
              </p>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mt-4">
                <div className="space-y-2.5">
                  {flowRows.map((row, i) => {
                    const pct = apptPatientCount > 0 ? (row.value / apptPatientCount) * 100 : 0;
                    const widthPct = Math.max(2, pct);
                    return (
                      <div key={i}>
                        <div className="flex justify-between text-[13px] mb-1">
                          <span className="text-theme-secondary">{row.label}</span>
                          <span className="text-theme-heading font-medium">
                            {formatNumber(row.value)} <span className="text-theme-faint font-normal">({pct.toFixed(0)}%)</span>
                          </span>
                        </div>
                        <div className="h-2 rounded-full" style={{ background: 'rgb(0 0 0 / 0.06)' }}>
                          <div className="h-full rounded-full" style={{ width: `${widthPct}%`, background: row.color }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div
                  className="rounded-xl p-4 self-start"
                  style={{ background: 'rgb(148 163 184 / 0.10)', border: '0.5px solid var(--mt-border)' }}
                >
                  <div>
                    <p className="text-[12px] uppercase tracking-[0.5px] text-theme-faint">Cross-sell revenue</p>
                    <p className="text-lg font-medium text-theme-heading mt-0.5">{formatINR(crossSellRevenue)}</p>
                  </div>
                  <div className="mt-3">
                    <p className="text-[12px] uppercase tracking-[0.5px] text-theme-faint">Appointment-only revenue</p>
                    <p className="text-lg font-medium text-theme-heading mt-0.5">{formatINR(apptOnlyRevenue)}</p>
                  </div>
                  <p className="text-[12px] text-theme-faint mt-3">
                    {crossSellRevPct}% of revenue is from cross-sold patients
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Doctor performance — replaces doctor_cross_sell_rate +
              doctor_stacked_bar. */}
          {isVisible('doctor_performance') && doctorCrossSell.length > 0 && (
            <div className="rounded-xl p-5" style={{ background: 'var(--mt-bg-raised)', border: '0.5px solid var(--mt-border)' }}>
              <h3 className="text-base font-medium text-theme-heading">Doctor performance</h3>
              <p className="text-[13px] text-theme-secondary mt-0.5">Cross-sold vs appointment-only patients</p>
              <div className="flex items-center gap-3 mt-2 text-[12px] text-theme-faint">
                <span className="inline-flex items-center gap-1.5">
                  <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: '#10b981' }} />
                  Cross-sold
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: '#475569' }} />
                  Appointment only
                </span>
              </div>
              <div className="hidden md:grid grid-cols-[1fr_140px_1.4fr] gap-4 mt-4 px-2 text-[12px] uppercase tracking-[0.5px] text-theme-faint">
                <span>Doctor</span>
                <span>Cross-sell rate</span>
                <span>Patient mix</span>
              </div>
              <div className="mt-2 max-h-[420px] overflow-y-auto">
                {doctorCrossSell.map((d: any, i: number) => {
                  const total = d.totalPatients || 0;
                  const csPct = total > 0 ? (d.crossSold / total) * 100 : 0;
                  const aoPct = total > 0 ? (d.apptOnly / total) * 100 : 0;
                  const rate = d.crossSellRate || 0;
                  const isZero = rate === 0;
                  const name = d.doctor.length > 28 ? d.doctor.slice(0, 28) + '…' : d.doctor;
                  return (
                    <div
                      key={i}
                      className="grid grid-cols-1 md:grid-cols-[1fr_140px_1.4fr] gap-4 items-center px-2 py-2.5"
                      style={{ borderTop: i === 0 ? 'none' : '0.5px solid var(--mt-border)' }}
                    >
                      <span className="text-[13px] text-theme-heading truncate" title={d.doctor}>{name}</span>
                      <span className="text-[13px]">
                        <span className={`font-medium ${isZero ? 'text-red-400' : 'text-theme-heading'}`}>
                          {rate.toFixed(0)}%
                        </span>{' '}
                        <span className="text-theme-faint">({d.crossSold}/{total})</span>
                      </span>
                      <div className="h-2.5 rounded-full overflow-hidden flex" style={{ background: 'rgb(0 0 0 / 0.06)' }}>
                        <div className="h-full" style={{ width: `${csPct}%`, background: '#10b981' }} />
                        <div className="h-full" style={{ width: `${aoPct}%`, background: '#475569' }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Top patients by revenue ──────────────────────────────────
          Sorted by paid amount descending; pageSize=5 keeps the card
          short by default. DataTable's built-in search filters across
          all 51 rows when the user types. */}
      {tableVisible && patientTable.length > 0 && (() => {
        const cols: ColumnDef<any>[] = [
          { key: 'patient_id', header: 'ID', cellClassName: 'font-mono text-[10px]' },
          { key: 'patient_name', header: 'Name' },
          { key: 'departments', header: 'Departments', sortable: false, render: (p: any) => {
            const map: Record<string, string> = {
              'APPOINTMENT': 'Appt',
              'LAB TEST': 'Lab',
              'OTHER SERVICES': 'Other',
            };
            const labels = (p.departments || '')
              .split(',')
              .map((d: string) => map[d.trim().toUpperCase()] || d.trim())
              .filter(Boolean);
            return <span className="text-[12px] text-theme-faint">{labels.join(' · ')}</span>;
          } },
          { key: 'total_billed', header: 'Billed', type: 'number', format: 'currency' },
          { key: 'total_paid', header: 'Paid', type: 'number', format: 'currency' },
          { key: 'total_discount', header: 'Discount', type: 'number', format: 'currency' },
          { key: 'visits', header: 'Visits', type: 'number', format: 'number' },
        ];
        return (
          <div
            className="rounded-xl p-5 mb-4"
            style={{ background: 'var(--mt-bg-raised)', border: '0.5px solid var(--mt-border)' }}
          >
            <div className="flex items-end justify-between mb-3 gap-3">
              <div>
                <h3 className="text-base font-medium text-theme-heading">Top patients by revenue</h3>
                <p className="text-[13px] text-theme-secondary mt-0.5">Search the full list below</p>
              </div>
              <p className="text-[13px] text-theme-faint shrink-0">
                Showing {Math.min(5, patientTable.length)} of {formatNumber(patientTable.length)}
              </p>
            </div>
            <DataTable
              columns={cols}
              rows={patientTable}
              pageSize={5}
              defaultSort={{ key: 'total_paid', dir: 'desc' }}
              density="compact"
              searchPlaceholder="Search patient, ID, department..."
            />
          </div>
        );
      })()}
    </div>
  );
}

/** Soft pastel-tinted KPI tile used for the Volume row. */
function MiniKPI({ label, value, icon: Icon, color, sub }: { label: string; value: string; icon: any; color: string; sub?: string }) {
  const colorMap: Record<string, string> = {
    teal: 'bg-teal-500/10 text-teal-400 border-teal-500/20',
    blue: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
    purple: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
    amber: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  };
  const c = colorMap[color] || colorMap.teal;
  return (
    <div className={`rounded-xl border p-3 ${c.split(' ').slice(2).join(' ')} ${c.split(' ')[0]}`}>
      <Icon size={14} className={c.split(' ')[1]} />
      <p className="text-base font-medium text-theme-heading mt-1">{value}</p>
      <p className="text-[12px] text-theme-faint leading-tight mt-0.5">{label}</p>
      {sub && <p className="text-[11px] text-theme-faint mt-0.5">{sub}</p>}
    </div>
  );
}

/** Neutral-surface KPI tile used for the Value row. No background tint
 *  — the row reads as financial outcomes, distinct from the colourful
 *  Volume row above. */
function ValueKPI({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div
      className="rounded-xl p-3"
      style={{ background: 'var(--mt-bg-raised)', border: '0.5px solid var(--mt-border)' }}
    >
      <p className="text-[12px] uppercase tracking-[0.5px] text-theme-faint">{label}</p>
      <p className="text-lg font-medium text-theme-heading mt-1">{value}</p>
      {sub && <p className="text-[11px] text-theme-faint mt-0.5">{sub}</p>}
    </div>
  );
}
