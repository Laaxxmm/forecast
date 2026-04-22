// VCFO module — the React replacement for the retired TallyVision_2.0 sub-app.
// Reads from the per-tenant `vcfo_*` tables populated by the sync-agent.
//
// Layout mirrors ForecastModulePage:
//   - Sticky top nav with 4 tab pills (Trial Balance / P&L / Balance Sheet / Cash Flow)
//   - Toolbar with period picker (FY / Q1-Q4 / MTD / YTD / Custom), view mode
//     (monthly/yearly), company picker (with "All companies" consolidation),
//     bifurcate toggle, and download menu
//   - Each sub-tab is its own component that fetches `/api/vcfo/<report>`
//
// Branch/stream sidebar context is honoured automatically by the axios client
// (see `api/client.ts` — X-Branch-Id / X-Stream-Id headers) and enforced
// server-side via `listAccessibleCompanies` in routes/vcfo-reports.ts.
//
// Multi-company behaviour:
//   - `selectedCompanyId = null` → consolidation over every accessible company
//     (server receives `companyIds=all`)
//   - `selectedCompanyId = N` → single-company report (legacy `companyId=N`)
//   - `bifurcate = true` (only meaningful when scope has >1 companies)
//     → server emits one column per company + a `total` column

import { useEffect, useMemo, useState } from 'react';
import { Routes, Route, NavLink, Navigate } from 'react-router-dom';
import api from '../api/client';
import { FileSpreadsheet, TrendingUp, Scale, Banknote, Columns, Trash2 } from 'lucide-react';
import VcfoCompanyPicker, { VcfoCompany } from '../components/vcfo/VcfoCompanyPicker';
import VcfoDownloadMenu from '../components/vcfo/VcfoDownloadMenu';
import VcfoPeriodPicker, { PeriodValue } from '../components/vcfo/VcfoPeriodPicker';
import TrialBalanceReport from '../components/vcfo/TrialBalanceReport';
import ProfitLossReport from '../components/vcfo/ProfitLossReport';
import BalanceSheetReport from '../components/vcfo/BalanceSheetReport';
import CashFlowReport from '../components/vcfo/CashFlowReport';

interface FY { id: number; label: string; start_date: string; end_date: string; is_active: number; }

const topTabs = [
  { path: 'trial-balance', label: 'Trial Balance', icon: FileSpreadsheet, key: 'tb' as const },
  { path: 'profit-loss', label: 'Profit & Loss', icon: TrendingUp, key: 'pl' as const },
  { path: 'balance-sheet', label: 'Balance Sheet', icon: Scale, key: 'bs' as const },
  { path: 'cash-flow', label: 'Cash Flow', icon: Banknote, key: 'cf' as const },
];

type ReportKey = 'tb' | 'pl' | 'bs' | 'cf';

function detectActiveReportKey(): ReportKey {
  const path = window.location.pathname;
  if (path.endsWith('/profit-loss')) return 'pl';
  if (path.endsWith('/balance-sheet')) return 'bs';
  if (path.endsWith('/cash-flow')) return 'cf';
  return 'tb';
}

export default function VcfoModulePage() {
  const [fys, setFYs] = useState<FY[]>([]);
  const [selectedFY, setSelectedFY] = useState<FY | null>(null);
  const [period, setPeriod] = useState<PeriodValue | null>(null);
  const [viewMode, setViewMode] = useState<'monthly' | 'yearly'>('yearly');
  const [companies, setCompanies] = useState<VcfoCompany[]>([]);
  const [companiesLoading, setCompaniesLoading] = useState(false);
  const [companiesError, setCompaniesError] = useState<string | null>(null);
  // null = consolidation across every accessible company.
  const [selectedCompanyId, setSelectedCompanyId] = useState<number | null>(null);
  const [bifurcate, setBifurcate] = useState(false);
  const [activeReportKey, setActiveReportKey] = useState<ReportKey>(detectActiveReportKey());
  const [resetOpen, setResetOpen] = useState(false);
  const [resetConfirmText, setResetConfirmText] = useState('');
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  const userType = typeof window !== 'undefined' ? localStorage.getItem('user_type') : null;
  const userRole = typeof window !== 'undefined' ? localStorage.getItem('user_role') : null;
  const canResetData = userType === 'super_admin' || userRole === 'admin';

  const performReset = async () => {
    setResetting(true);
    setResetError(null);
    try {
      const res = await api.delete('/vcfo/data', { data: { confirm: 'DELETE' } });
      console.log('[vcfo] reset result', res.data);
      setResetOpen(false);
      setResetConfirmText('');
      window.location.reload();
    } catch (err: any) {
      setResetError(err?.response?.data?.error || err?.message || 'Reset failed');
    } finally {
      setResetting(false);
    }
  };

  // Track the active route so the download menu knows which report to export.
  useEffect(() => {
    const update = () => setActiveReportKey(detectActiveReportKey());
    window.addEventListener('popstate', update);
    const interval = window.setInterval(update, 500);
    return () => {
      window.removeEventListener('popstate', update);
      window.clearInterval(interval);
    };
  }, []);

  // Load fiscal years
  useEffect(() => {
    api.get('/settings/fy').then(res => {
      setFYs(res.data);
      const active = res.data.find((f: FY) => f.is_active);
      if (active) setSelectedFY(active);
      else if (res.data.length) setSelectedFY(res.data[0]);
    });
  }, []);

  // Once an FY is picked, seed the period to "FY" preset spanning its range.
  useEffect(() => {
    if (!selectedFY) return;
    setPeriod(p => {
      // Preserve any custom range the user has already set — only seed on first
      // load or when the current period sits outside the new FY.
      if (p && p.preset !== 'fy') return p;
      return { preset: 'fy', from: selectedFY.start_date, to: selectedFY.end_date };
    });
  }, [selectedFY]);

  // Load companies. The server returns only companies mapped to the active
  // branch/stream context (filtered in `listAccessibleCompanies`). On first
  // load we default to null = "All companies" consolidation so the user
  // immediately sees whole-tenant numbers; they can narrow to one company
  // via the dropdown.
  useEffect(() => {
    setCompaniesLoading(true);
    setCompaniesError(null);
    api
      .get('/vcfo/companies')
      .then(res => {
        const list: VcfoCompany[] = res.data || [];
        setCompanies(list);
        // Keep the current selection if it's still valid; otherwise fall back
        // to null (= All companies) so we show a consolidated view by default.
        if (list.length === 0) {
          setSelectedCompanyId(null);
        } else if (selectedCompanyId != null && !list.find(c => c.id === selectedCompanyId)) {
          setSelectedCompanyId(null);
        }
      })
      .catch(err => {
        setCompanies([]);
        setSelectedCompanyId(null);
        setCompaniesError(
          err?.response?.data?.error || err?.message || 'Failed to load companies',
        );
      })
      .finally(() => setCompaniesLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { fromDate, toDate } = useMemo(() => {
    if (period) return { fromDate: period.from, toDate: period.to };
    if (selectedFY) return { fromDate: selectedFY.start_date, toDate: selectedFY.end_date };
    return { fromDate: '', toDate: '' };
  }, [period, selectedFY]);

  // When selection collapses to a single company, bifurcation is meaningless.
  const scopeCompanyCount = selectedCompanyId == null ? companies.length : 1;
  const canBifurcate = scopeCompanyCount > 1;
  useEffect(() => {
    if (!canBifurcate && bifurcate) setBifurcate(false);
  }, [canBifurcate, bifurcate]);

  // Compose the companyIds / companyId params the report components receive.
  const reportScope = useMemo(() => {
    if (selectedCompanyId != null) {
      return { companyId: selectedCompanyId, companyIds: null as string | null };
    }
    return { companyId: null, companyIds: 'all' };
  }, [selectedCompanyId]);

  const buildDownloadParams = (format: 'xlsx' | 'pdf' | 'docx'): string | null => {
    if (!fromDate || !toDate) return null;
    if (companies.length === 0) return null;
    const params = new URLSearchParams({
      report: activeReportKey,
      format,
    });
    if (selectedCompanyId != null) {
      params.set('companyId', String(selectedCompanyId));
    } else {
      params.set('companyIds', 'all');
    }
    if (bifurcate && canBifurcate) params.set('bifurcate', 'true');
    if (activeReportKey === 'bs') {
      params.set('asOf', toDate);
      params.set('from', fromDate);
      params.set('view', viewMode);
    } else if (activeReportKey === 'pl') {
      params.set('from', fromDate);
      params.set('to', toDate);
      params.set('view', viewMode);
    } else {
      params.set('from', fromDate);
      params.set('to', toDate);
    }
    return params.toString();
  };

  const selectedCompany = companies.find(c => c.id === selectedCompanyId) || null;
  const downloadDisabled = !selectedFY || companies.length === 0;
  const filenameHint = selectedCompany
    ? `${selectedCompany.name.replace(/[^a-z0-9]+/gi, '_')}_${activeReportKey}`
    : `consolidated_${activeReportKey}`;

  return (
    <div className="vcfo-module animate-fade-in">
      {/* Top Navigation Tabs */}
      <div
        className="-mx-4 -mt-4 px-4 md:-mx-8 md:-mt-8 md:px-8 mb-0"
        style={{ background: 'var(--mt-bg-raised)', borderBottom: '1px solid var(--mt-border)' }}
      >
        <div className="flex flex-col md:flex-row md:items-center md:justify-between">
          <div className="flex overflow-x-auto scrollbar-hide">
            {topTabs.map(tab => (
              <NavLink
                key={tab.path}
                to={`/vcfo/${tab.path}`}
                onClick={() => setActiveReportKey(tab.key)}
                className={({ isActive }) =>
                  `mt-tab ${isActive ? 'mt-tab--active' : ''}`
                }
              >
                <tab.icon size={15} />
                {tab.label}
              </NavLink>
            ))}
          </div>
          <div className="flex items-center gap-2 md:gap-3 pb-2 md:pb-0 px-1 md:px-0 flex-shrink-0">
            {selectedCompany?.lastSyncedAt && (
              <span className="hidden lg:inline text-xs" style={{ color: 'var(--mt-text-faint)' }}>
                Synced {new Date(selectedCompany.lastSyncedAt).toLocaleString()}
              </span>
            )}
            <VcfoDownloadMenu
              disabled={downloadDisabled}
              buildParams={buildDownloadParams}
              filenameHint={filenameHint}
            />
            {canResetData && (
              <button
                onClick={() => { setResetOpen(true); setResetError(null); setResetConfirmText(''); }}
                className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-lg transition-colors"
                style={{
                  color: 'var(--mt-text-faint)',
                  border: '1px solid var(--mt-border)',
                  background: 'transparent',
                }}
                onMouseEnter={e => {
                  e.currentTarget.style.color = 'var(--mt-danger-text)';
                  e.currentTarget.style.background = 'var(--mt-danger-soft)';
                  e.currentTarget.style.borderColor = 'var(--mt-danger-border)';
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.color = 'var(--mt-text-faint)';
                  e.currentTarget.style.background = 'transparent';
                  e.currentTarget.style.borderColor = 'var(--mt-border)';
                }}
                title="Delete all synced Tally data for this tenant"
              >
                <Trash2 size={13} />
                <span className="hidden md:inline">Reset</span>
              </button>
            )}
            <div className="h-6 w-px" style={{ background: 'var(--mt-border)' }} />
            <VcfoCompanyPicker
              companies={companies}
              selectedId={selectedCompanyId}
              onSelect={setSelectedCompanyId}
              loading={companiesLoading}
            />
            <select
              value={selectedFY?.id || ''}
              onChange={e => {
                const fy = fys.find(f => f.id === Number(e.target.value));
                if (fy) {
                  setSelectedFY(fy);
                  setPeriod({ preset: 'fy', from: fy.start_date, to: fy.end_date });
                }
              }}
              className="mt-input text-xs md:text-sm w-28 md:w-36"
              style={{ padding: '6px 10px' }}
            >
              {fys.map(fy => (
                <option key={fy.id} value={fy.id}>
                  {fy.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Toolbar */}
      <div
        className="flex flex-wrap items-center justify-between gap-2 py-3 -mx-4 px-4 md:-mx-8 md:px-8"
        style={{
          borderBottom: '1px solid var(--mt-border)',
          background: 'color-mix(in srgb, var(--mt-bg-raised) 55%, transparent)',
        }}
      >
        <div className="flex flex-wrap items-center gap-2">
          {(activeReportKey === 'pl' || activeReportKey === 'bs') && (
            <div
              className="flex rounded-xl overflow-hidden"
              style={{ background: 'var(--mt-bg-raised)', border: '1px solid var(--mt-border)' }}
            >
              <button
                onClick={() => setViewMode('yearly')}
                className="px-3 py-1.5 text-xs font-medium transition-all"
                style={{
                  background: viewMode === 'yearly' ? 'var(--mt-accent-soft)' : 'transparent',
                  color: viewMode === 'yearly' ? 'var(--mt-accent-text)' : 'var(--mt-text-faint)',
                }}
              >
                Yearly
              </button>
              <button
                onClick={() => setViewMode('monthly')}
                className="px-3 py-1.5 text-xs font-medium transition-all"
                style={{
                  background: viewMode === 'monthly' ? 'var(--mt-accent-soft)' : 'transparent',
                  color: viewMode === 'monthly' ? 'var(--mt-accent-text)' : 'var(--mt-text-faint)',
                }}
              >
                Monthly
              </button>
            </div>
          )}
          {selectedFY && period && (
            <VcfoPeriodPicker
              fyStart={selectedFY.start_date}
              fyEnd={selectedFY.end_date}
              value={period}
              onChange={setPeriod}
            />
          )}
          {canBifurcate && (
            <button
              onClick={() => setBifurcate(b => !b)}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg transition-colors"
              style={{
                background: bifurcate ? 'var(--mt-accent-soft)' : 'var(--mt-bg-raised)',
                color: bifurcate ? 'var(--mt-accent-text)' : 'var(--mt-text-secondary)',
                border: `1px solid ${bifurcate ? 'var(--mt-accent-border)' : 'var(--mt-border)'}`,
              }}
              title="Show one column per company"
            >
              <Columns size={13} />
              Bifurcate
            </button>
          )}
          {selectedCompanyId == null && companies.length > 1 && (
            <span className="mt-pill mt-pill--success mt-pill-sm">
              Consolidated · {companies.length} {companies.length === 1 ? 'company' : 'companies'}
            </span>
          )}
          {selectedCompany && (
            <span className="mt-pill mt-pill--success mt-pill-sm">
              {selectedCompany.name}
            </span>
          )}
        </div>
      </div>

      {/* Route Content */}
      <div className="mt-4 md:mt-6">
        {companiesLoading ? (
          <div className="mt-card p-10 text-center">
            <p style={{ color: 'var(--mt-text-muted)' }}>Loading…</p>
          </div>
        ) : companiesError ? (
          <div
            className="rounded-2xl p-10 text-center"
            style={{
              background: 'var(--mt-bg-raised)',
              border: '1px solid var(--mt-danger-border)',
              boxShadow: 'var(--mt-shadow-card)',
            }}
          >
            <p className="mb-2 font-medium" style={{ color: 'var(--mt-danger-text)' }}>Couldn't load companies.</p>
            <p className="text-sm" style={{ color: 'var(--mt-text-faint)' }}>{companiesError}</p>
          </div>
        ) : companies.length === 0 ? (
          <div className="mt-card p-10 text-center">
            <p className="mb-2 font-medium" style={{ color: 'var(--mt-text-muted)' }}>No data synced yet.</p>
            <p className="text-sm" style={{ color: 'var(--mt-text-faint)' }}>
              Install the VCFO Sync desktop agent and point it at your Tally ERP. Once a sync completes,
              reports appear here automatically.
            </p>
          </div>
        ) : (
          <Routes>
            <Route index element={<Navigate to="trial-balance" replace />} />
            <Route
              path="trial-balance"
              element={
                <TrialBalanceReport
                  companyId={reportScope.companyId}
                  companyIds={reportScope.companyIds}
                  from={fromDate}
                  to={toDate}
                />
              }
            />
            <Route
              path="profit-loss"
              element={
                <ProfitLossReport
                  companyId={reportScope.companyId}
                  companyIds={reportScope.companyIds}
                  from={fromDate}
                  to={toDate}
                  view={viewMode}
                  bifurcate={bifurcate && canBifurcate}
                />
              }
            />
            <Route
              path="balance-sheet"
              element={
                <BalanceSheetReport
                  companyId={reportScope.companyId}
                  companyIds={reportScope.companyIds}
                  asOf={toDate}
                  view={viewMode}
                  from={fromDate}
                  bifurcate={bifurcate && canBifurcate}
                />
              }
            />
            <Route
              path="cash-flow"
              element={
                <CashFlowReport
                  companyId={reportScope.companyId}
                  companyIds={reportScope.companyIds}
                  from={fromDate}
                  to={toDate}
                  bifurcate={bifurcate && canBifurcate}
                />
              }
            />
          </Routes>
        )}
      </div>

      {/* Reset-data confirm modal (admin-only, typed confirmation) */}
      {resetOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm"
          style={{ background: 'rgba(0,0,0,0.6)' }}
        >
          <div
            className="rounded-2xl max-w-md w-[92%] p-6"
            style={{
              background: 'var(--mt-bg-raised)',
              border: '1px solid var(--mt-danger-border)',
              boxShadow: '0 20px 48px -12px rgba(0,0,0,0.6), var(--mt-shadow-card)',
            }}
          >
            <div className="flex items-start gap-3 mb-4">
              <div
                className="p-2 rounded-lg"
                style={{ background: 'var(--mt-danger-soft)' }}
              >
                <Trash2 size={18} style={{ color: 'var(--mt-danger-text)' }} />
              </div>
              <div>
                <h3 className="mt-heading text-base">Delete all synced Tally data?</h3>
                <p className="text-xs mt-1" style={{ color: 'var(--mt-text-faint)' }}>
                  This clears every <code
                    className="text-[11px] px-1 py-0.5 rounded"
                    style={{ background: 'var(--mt-bg-muted)' }}
                  >vcfo_*</code> table
                  for this tenant: companies, ledgers, account groups, vouchers, stock summary, trial balance.
                  Non-VCFO data (forecast, budgets, dashboards) is untouched.
                </p>
                <p className="text-xs mt-2 font-medium" style={{ color: 'var(--mt-danger-text)' }}>
                  Cannot be undone. The next Sync Now in the desktop agent will repopulate.
                </p>
              </div>
            </div>

            <label className="block text-xs mb-1.5" style={{ color: 'var(--mt-text-secondary)' }}>
              Type <span className="font-mono font-semibold" style={{ color: 'var(--mt-danger-text)' }}>DELETE</span> to confirm:
            </label>
            <input
              type="text"
              value={resetConfirmText}
              onChange={e => setResetConfirmText(e.target.value)}
              autoFocus
              className="mt-input w-full text-sm font-mono"
              placeholder="DELETE"
              disabled={resetting}
            />

            {resetError && (
              <p className="text-xs mt-2" style={{ color: 'var(--mt-danger-text)' }}>{resetError}</p>
            )}

            <div className="flex justify-end gap-2 mt-5">
              <button
                onClick={() => { setResetOpen(false); setResetConfirmText(''); setResetError(null); }}
                disabled={resetting}
                className="mt-btn-ghost text-xs"
              >
                Cancel
              </button>
              <button
                onClick={performReset}
                disabled={resetting || resetConfirmText !== 'DELETE'}
                className="px-3 py-1.5 text-xs font-medium rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                style={{
                  background: 'var(--mt-danger-soft)',
                  color: 'var(--mt-danger-text)',
                  border: '1px solid var(--mt-danger-border)',
                }}
              >
                {resetting ? 'Deleting…' : 'Delete everything'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
