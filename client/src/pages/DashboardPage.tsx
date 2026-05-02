import { useEffect, useState, useMemo } from 'react';
import api from '../api/client';
import ClinicAnalytics from '../components/dashboard/ClinicAnalytics';
import PharmacyAnalytics from '../components/dashboard/PharmacyAnalytics';
import ActualsAllOverview from '../components/dashboard/ActualsAllOverview';
import { buildPeriodOptions } from '../components/dashboard/dashboardUtils';
import { Activity, ChevronDown } from 'lucide-react';

export default function DashboardPage() {
  const [data, setData] = useState<any>(null);
  const [historical, setHistorical] = useState<any | null>(null);
  const [clinicData, setClinicData] = useState<any | null>(null);
  const [pharmaData, setPharmaData] = useState<any | null>(null);
  const [insightsData, setInsightsData] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedPeriod, setSelectedPeriod] = useState('current_month');
  // Orphan-actuals recovery state — same pattern as ForecastModulePage's
  // orphan-scenario banner. Strict branch isolation hides NULL-branch
  // rows; if any exist, surface them so an admin can claim them.
  const [actualsOrphans, setActualsOrphans] = useState<{ totalRows: number; counts: any } | null>(null);
  const [migratingActuals, setMigratingActuals] = useState(false);

  // Active stream filter — set by the top-right dropdown on this page or
  // the legacy sidebar pills. Both write to the same localStorage keys, so
  // either UI keeps the selection in sync.
  const activeStreamId = localStorage.getItem('stream_id');
  const activeStreamName = localStorage.getItem('stream_name');

  const selectStream = (id: string | null, name: string) => {
    if (id) {
      localStorage.setItem('stream_id', id);
      localStorage.setItem('stream_name', name);
    } else {
      localStorage.removeItem('stream_id');
      localStorage.removeItem('stream_name');
    }
    window.location.reload();
  };

  // Period filter
  const periodOptions = useMemo(() => {
    if (!data?.fy?.start_date) return [];
    return buildPeriodOptions(data.fy.start_date);
  }, [data?.fy?.start_date]);

  const currentPeriod = useMemo(() => {
    return periodOptions.find(p => p.value === selectedPeriod) || null;
  }, [periodOptions, selectedPeriod]);

  const periodStartMonth = currentPeriod?.months?.[0] || null;
  const periodEndMonth = currentPeriod?.months?.[currentPeriod.months.length - 1] || null;

  useEffect(() => {
    const params: Record<string, string> = {};
    if (periodStartMonth) params.startMonth = periodStartMonth;
    if (periodEndMonth) params.endMonth = periodEndMonth;

    setLoading(true);
    api.get('/dashboard/overview', { params }).then(res => {
      setData(res.data);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [periodStartMonth, periodEndMonth]);

  // Fetch a wider window (full FY to current month) for the homepage's
  // 6-month trend + month-over-month delta calculations. The headline
  // KPIs above stay scoped to the user-selected period; this fetch only
  // backfills the longer historical series the redesigned All view needs.
  // Limited to current FY because the dashboard endpoint queries scenarios
  // scoped to the active FY — pre-FY history is documented as a follow-up
  // ask in HOMEPAGE_BACKEND.md.
  useEffect(() => {
    if (activeStreamId) return; // sub-tab view — no homepage trend needed
    if (!data?.fy?.start_date) return;
    const fyStart = data.fy.start_date.slice(0, 7);
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    api.get('/dashboard/overview', { params: { startMonth: fyStart, endMonth: today } })
      .then(res => setHistorical(res.data))
      .catch(() => { /* trend hides itself on missing data */ });
  }, [data?.fy?.start_date, activeStreamId]);

  // Fetch sub-tab data for the alert center + Quick view cards in All mode.
  // Skipped when a specific stream is selected because the sub-tab itself
  // will fetch its own data anyway.
  useEffect(() => {
    if (activeStreamId) return;
    const params: Record<string, string> = {};
    if (periodStartMonth) params.startMonth = periodStartMonth;
    if (periodEndMonth) params.endMonth = periodEndMonth;
    api.get('/dashboard/clinic-analytics', { params })
      .then(res => setClinicData(res.data))
      .catch(() => setClinicData(null));
    api.get('/dashboard/pharmacy-analytics', { params })
      .then(res => setPharmaData(res.data))
      .catch(() => setPharmaData(null));
  }, [periodStartMonth, periodEndMonth, activeStreamId]);

  // Per-day stream revenue for the homepage's Daily revenue chart. The
  // /dashboard/operational-insights endpoint is the only place that
  // returns daily breakdowns per stream — overview gives monthly,
  // clinic-analytics and pharmacy-analytics return aggregates without
  // dates.
  //
  // operational-insights handles one month at a time via ?month=YYYY-MM.
  // We pass the end month of the user-selected period so that:
  //   • single-month period (e.g. "Last month (Apr '26)") → that month
  //   • multi-month period (e.g. "Current quarter") → latest month in
  //     the range, which is the most relevant for a "daily progression"
  //     chart since the earlier months are already complete history.
  // Without this, the chart would always show today's month even when
  // the user selected a different period in the dropdown.
  useEffect(() => {
    if (activeStreamId) return;
    const ctl = new AbortController();
    const params: Record<string, string> = {};
    if (periodEndMonth) params.month = periodEndMonth;
    api.get('/dashboard/operational-insights', { params, signal: ctl.signal })
      .then(res => { if (!ctl.signal.aborted) setInsightsData(res.data); })
      .catch(() => { if (!ctl.signal.aborted) setInsightsData(null); });
    return () => ctl.abort();
  }, [activeStreamId, periodEndMonth]);

  // Detect orphan (NULL-branch) actuals once on mount. Multi-branch
  // tenants only — single-branch has nothing to leak. Skipped silently
  // on older deployments (endpoint 404s before this migration deploys).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!localStorage.getItem('is_multi_branch')) return;
    api.get('/actuals/orphans')
      .then(res => {
        if (res.data?.scopeRequired) {
          setActualsOrphans({ totalRows: res.data.totalRows || 0, counts: res.data.counts });
        }
      })
      .catch(() => { /* endpoint missing on older deployments */ });
  }, []);

  const handleDeleteActuals = async () => {
    const c = actualsOrphans?.counts;
    const summary = c
      ? [
          c.clinic_actuals.rows            > 0 ? `${c.clinic_actuals.rows.toLocaleString()} clinic rows` : null,
          c.pharmacy_sales_actuals.rows    > 0 ? `${c.pharmacy_sales_actuals.rows.toLocaleString()} pharmacy sales rows` : null,
          c.pharmacy_purchase_actuals.rows > 0 ? `${c.pharmacy_purchase_actuals.rows.toLocaleString()} pharmacy purchase rows` : null,
          c.dashboard_actuals.rows         > 0 ? `${c.dashboard_actuals.rows.toLocaleString()} dashboard rollup rows` : null,
        ].filter(Boolean).join(' · ')
      : `${actualsOrphans?.totalRows} rows`;
    const ok = window.confirm(
      `PERMANENTLY DELETE ${summary}?\n\n` +
      `This removes the rows from the database entirely. There is no undo. ` +
      `Use this when you know the orphan rows are leaked / wrong data and you don't want them anywhere.`
    );
    if (!ok) return;
    setMigratingActuals(true);
    try {
      await api.post('/actuals/delete-orphans');
      setActualsOrphans(null);
      window.location.reload();
    } catch (e: any) {
      alert(`Delete failed: ${e?.response?.data?.error || e.message || 'unknown error'}`);
      setMigratingActuals(false);
    }
  };

  const handleMigrateActuals = async () => {
    const targetBranchId = localStorage.getItem('branch_id');
    const branchName = localStorage.getItem('branch_name') || 'this branch';
    if (!targetBranchId) {
      alert('Switch to a specific branch first — orphan actuals can only be moved into a chosen branch, not the consolidated view.');
      return;
    }
    const c = actualsOrphans?.counts;
    const summary = c
      ? [
          c.clinic_actuals.rows            > 0 ? `${c.clinic_actuals.rows.toLocaleString()} clinic rows` : null,
          c.pharmacy_sales_actuals.rows    > 0 ? `${c.pharmacy_sales_actuals.rows.toLocaleString()} pharmacy sales rows` : null,
          c.pharmacy_purchase_actuals.rows > 0 ? `${c.pharmacy_purchase_actuals.rows.toLocaleString()} pharmacy purchase rows` : null,
          c.dashboard_actuals.rows         > 0 ? `${c.dashboard_actuals.rows.toLocaleString()} dashboard rollup rows` : null,
        ].filter(Boolean).join(' · ')
      : `${actualsOrphans?.totalRows} rows`;
    const ok = window.confirm(
      `Move ${summary} into "${branchName}"?\n\n` +
      `After this, the data shows ONLY in ${branchName} and is hidden from every other branch. ` +
      `This cannot be undone automatically.`
    );
    if (!ok) return;
    setMigratingActuals(true);
    try {
      await api.post('/actuals/migrate-orphans', {
        targetBranchId: parseInt(targetBranchId),
      });
      setActualsOrphans(null);
      // Reload so the migrated rows show up in the current branch's view
      window.location.reload();
    } catch (e: any) {
      alert(`Migration failed: ${e?.response?.data?.error || e.message || 'unknown error'}`);
      setMigratingActuals(false);
    }
  };

  if (loading) return (
    <div className="flex items-center justify-center py-20">
      <div className="text-center">
        <div
          className="w-8 h-8 border-2 rounded-full animate-spin mx-auto mb-3"
          style={{
            borderColor: 'var(--mt-accent-soft)',
            borderTopColor: 'var(--mt-accent)',
          }}
        />
        <span className="text-sm" style={{ color: 'var(--mt-text-faint)' }}>Loading dashboard...</span>
      </div>
    </div>
  );

  if (!data) return (
    <div className="text-center py-20">
      <Activity size={40} className="mx-auto mb-3" style={{ color: 'var(--mt-text-faint)' }} />
      <span style={{ color: 'var(--mt-text-faint)' }}>No data available</span>
    </div>
  );

  const streams: any[] = data.streams || [];

  // Stream mode detection
  const isAllStreams = !activeStreamId;
  const isClinicStream = !isAllStreams && streams.some((s: any) =>
    String(s.id) === activeStreamId &&
    ((s.name || '').toLowerCase().includes('clinic') || (s.name || '').toLowerCase().includes('health'))
  );
  const isPharmaStream = !isAllStreams && streams.some((s: any) =>
    String(s.id) === activeStreamId &&
    (s.name || '').toLowerCase().includes('pharma')
  );
  // Chart visibility helper — used by stream-specific sub-tabs (Clinic /
  // Pharmacy). The All view's redesigned layout doesn't read individual
  // chart visibility settings; the sub-cards (alerts, trend, quick view)
  // self-gate on whether their underlying data is non-empty.
  const chartVis = data.chartVisibility || [];

  // Clinic stream visibility helper
  const clinicStream = streams.find((s: any) => {
    const n = (s.name || '').toLowerCase();
    return n.includes('clinic') || n.includes('health');
  });
  const clinicStreamId = clinicStream ? String(clinicStream.id) : null;
  const isClinicVisible = (key: string) => {
    if (!clinicStreamId) return false;
    const entry = chartVis.find((v: any) => v.element_key === key && v.scope === clinicStreamId);
    return entry ? !!entry.is_visible : true;
  };

  // Pharmacy stream visibility helper
  const pharmaStream = streams.find((s: any) => {
    const n = (s.name || '').toLowerCase();
    return n.includes('pharma');
  });
  const pharmaStreamId = pharmaStream ? String(pharmaStream.id) : null;
  const isPharmaVisible = (key: string) => {
    if (!pharmaStreamId) return false;
    const entry = chartVis.find((v: any) => v.element_key === key && v.scope === pharmaStreamId);
    return entry ? !!entry.is_visible : true; // default visible for pharmacy
  };

  // ── Header context ───────────────────────────────────────────────────────
  // Org and branch names are written to localStorage by the login + branch
  // selection flows. Falling back to a generic label keeps the subtitle
  // honest when something hasn't populated yet — never invent values.
  const orgName = (typeof window !== 'undefined' && localStorage.getItem('client_name'))
    || (typeof window !== 'undefined' && localStorage.getItem('client_slug'))
    || '';
  const branchName = typeof window !== 'undefined' ? (localStorage.getItem('branch_name') || '') : '';

  // ── Top-right stream filter dropdown ─────────────────────────────────────
  // Mirrors the legacy sidebar pills via the same localStorage keys, so
  // either UI moves the filter without diverging state.
  const streamFilterValue = activeStreamId || 'all';
  const onStreamFilterChange = (val: string) => {
    if (val === 'all') {
      selectStream(null, '');
      return;
    }
    const s = streams.find((x: any) => String(x.id) === val);
    if (s) selectStream(String(s.id), s.name);
  };

  return (
    <div className="animate-fade-in">
      <div className="flex items-start justify-between mb-6 gap-4 flex-wrap">
        <div>
          <h1 className="mt-heading" style={{ fontSize: 22, fontWeight: 500 }}>Actuals</h1>
          <p className="mt-1 text-[13px]" style={{ color: 'var(--mt-text-faint)' }}>
            {[
              orgName,
              branchName,
              activeStreamName
                ? `${activeStreamName} \u2014 ${currentPeriod?.label || data.fy?.label || 'All Time'}`
                : (currentPeriod?.label || data.fy?.label || 'All Time'),
            ].filter(Boolean).join(' \u00b7 ')}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {streams.length > 0 && (
            <div className="relative">
              <select
                value={streamFilterValue}
                onChange={e => onStreamFilterChange(e.target.value)}
                className="mt-input"
                style={{ paddingRight: 28, fontSize: 13 }}
                aria-label="Filter by stream"
              >
                <option value="all">All</option>
                {streams.map((s: any) => (
                  <option key={s.id} value={String(s.id)}>{s.name}</option>
                ))}
              </select>
              <ChevronDown
                size={13}
                style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: 'var(--mt-text-faint)' }}
              />
            </div>
          )}
          {periodOptions.length > 0 && (
            <select
              data-tour="period-filter"
              value={selectedPeriod}
              onChange={e => setSelectedPeriod(e.target.value)}
              className="mt-input"
              style={{ width: '16rem', padding: '8px 12px', fontSize: 13 }}
            >
              {periodOptions.map(p => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
          )}
        </div>
      </div>

      {/* Orphan-actuals recovery banner. Surfaces only when there's
          NULL-branch data sitting in clinic_actuals / pharmacy_*_actuals
          / dashboard_actuals — i.e. legacy rows from pre-multi-branch
          imports or imports done in consolidated mode. After strict
          isolation those rows are invisible until reassigned. */}
      {actualsOrphans && actualsOrphans.totalRows > 0 && (() => {
        const c = actualsOrphans.counts;
        const lines: string[] = [];
        if (c?.clinic_actuals?.rows > 0)            lines.push(`${c.clinic_actuals.rows.toLocaleString()} clinic actuals (₹${Math.round(c.clinic_actuals.revenue).toLocaleString('en-IN')})`);
        if (c?.pharmacy_sales_actuals?.rows > 0)    lines.push(`${c.pharmacy_sales_actuals.rows.toLocaleString()} pharmacy sales (₹${Math.round(c.pharmacy_sales_actuals.sales).toLocaleString('en-IN')})`);
        if (c?.pharmacy_purchase_actuals?.rows > 0) lines.push(`${c.pharmacy_purchase_actuals.rows.toLocaleString()} pharmacy purchases`);
        if (c?.dashboard_actuals?.rows > 0)         lines.push(`${c.dashboard_actuals.rows.toLocaleString()} dashboard rollup rows`);
        return (
          <div
            className="mb-6 px-4 py-3 rounded-lg flex items-center justify-between gap-4 text-sm"
            style={{
              background: 'color-mix(in srgb, #f59e0b 12%, transparent)',
              border: '1px solid color-mix(in srgb, #f59e0b 35%, transparent)',
              color: 'var(--mt-text-heading)',
            }}
          >
            <div className="flex items-start gap-3 flex-1">
              <span style={{ fontSize: 18, lineHeight: 1, color: '#f59e0b' }}>⚠</span>
              <div>
                <div style={{ fontWeight: 600 }}>
                  Actuals data not tied to any branch ({actualsOrphans.totalRows.toLocaleString()} rows)
                </div>
                <div style={{ color: 'var(--mt-text-muted)', marginTop: 2 }}>
                  {lines.join(' · ')} — hidden from every branch&apos;s view because they were imported without a branch context. Move them into the current branch to make them visible here.
                </div>
              </div>
            </div>
            <div className="flex gap-2 whitespace-nowrap">
              <button
                onClick={handleMigrateActuals}
                disabled={migratingActuals}
                className="mt-btn-gradient"
                style={{ padding: '8px 14px', fontSize: 13 }}
                title="Reassigns the orphan actuals to your current branch. Other branches keep showing their own data."
              >
                {migratingActuals
                  ? 'Working…'
                  : `Move into ${localStorage.getItem('branch_name') || 'current branch'}`}
              </button>
              <button
                onClick={handleDeleteActuals}
                disabled={migratingActuals}
                className="mt-btn-ghost"
                style={{ padding: '8px 14px', fontSize: 13, borderColor: 'color-mix(in srgb, #ef4444 50%, transparent)', color: '#ef4444' }}
                title="Permanently deletes the orphan rows from the database. Use when you know the data is leaked / wrong."
              >
                Delete
              </button>
            </div>
          </div>
        );
      })()}

      {/* All-streams homepage — KPI strip + forecast advisory + alerts +
          6-month trend + Quick view + Dig deeper. Stream-specific views
          (Clinic / Pharmacy) below this block remain unchanged. */}
      {isAllStreams && (
        <ActualsAllOverview
          data={data}
          historical={historical}
          clinic={clinicData}
          pharma={pharmaData}
          insights={insightsData}
          orgInfo={{
            orgName,
            branchName,
            periodLabel: currentPeriod?.label || data.fy?.label || '',
          }}
          selectStream={selectStream}
        />
      )}

      {/* Clinic Analytics — only when clinic stream is active */}
      {isClinicStream && clinicStreamId && <ClinicAnalytics isVisible={isClinicVisible} startMonth={periodStartMonth} endMonth={periodEndMonth} />}

      {/* Pharmacy Analytics — only when pharmacy stream is active */}
      {isPharmaStream && pharmaStreamId && <PharmacyAnalytics isVisible={isPharmaVisible} startMonth={periodStartMonth} endMonth={periodEndMonth} />}
    </div>
  );
}
