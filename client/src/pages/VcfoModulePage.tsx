// VCFO module — the React replacement for the retired TallyVision_2.0 sub-app.
// Reads from the per-tenant `vcfo_*` tables populated by the sync-agent.
//
// Layout mirrors ForecastModulePage:
//   - Sticky top nav with 4 tab pills (Trial Balance / P&L / Balance Sheet / Cash Flow)
//   - Toolbar with FY selector, view mode (monthly/yearly), company picker, download menu
//   - Each sub-tab is its own component that fetches `/api/vcfo/<report>`
//
// Branch/stream sidebar context is honoured automatically by the axios client
// (see `api/client.ts` — X-Branch-Id / X-Stream-Id headers) and enforced
// server-side via `listAccessibleCompanies` in routes/vcfo-reports.ts.

import { useEffect, useMemo, useState } from 'react';
import { Routes, Route, NavLink, Navigate } from 'react-router-dom';
import api from '../api/client';
import { FileSpreadsheet, TrendingUp, Scale, Banknote, ChevronLeft, ChevronRight, Calendar } from 'lucide-react';
import VcfoCompanyPicker, { VcfoCompany } from '../components/vcfo/VcfoCompanyPicker';
import VcfoDownloadMenu from '../components/vcfo/VcfoDownloadMenu';
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
  const [viewMode, setViewMode] = useState<'monthly' | 'yearly'>('yearly');
  const [companies, setCompanies] = useState<VcfoCompany[]>([]);
  const [companiesLoading, setCompaniesLoading] = useState(false);
  const [selectedCompanyId, setSelectedCompanyId] = useState<number | null>(null);
  const [activeReportKey, setActiveReportKey] = useState<ReportKey>(detectActiveReportKey());

  // Track the active route so the download menu knows which report to export.
  useEffect(() => {
    const update = () => setActiveReportKey(detectActiveReportKey());
    window.addEventListener('popstate', update);
    // React-router programmatic navigations don't fire popstate, so also
    // listen for clicks on NavLinks via a tiny interval — the cost is trivial.
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

  // Load companies (re-loads when branch/stream context changes; we can't
  // easily observe localStorage, so just reload when the user changes FY or
  // the page mounts).
  useEffect(() => {
    setCompaniesLoading(true);
    api
      .get('/vcfo/companies')
      .then(res => {
        setCompanies(res.data || []);
        if (res.data?.length > 0 && selectedCompanyId == null) {
          setSelectedCompanyId(res.data[0].id);
        } else if (res.data?.length > 0 && !res.data.find((c: VcfoCompany) => c.id === selectedCompanyId)) {
          // If current selection is no longer in the visible set (e.g. branch switched), pick the first.
          setSelectedCompanyId(res.data[0].id);
        }
      })
      .catch(() => setCompanies([]))
      .finally(() => setCompaniesLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Derive date range from selected FY (April → March).
  const { fromDate, toDate } = useMemo(() => {
    if (!selectedFY) return { fromDate: '', toDate: '' };
    return { fromDate: selectedFY.start_date, toDate: selectedFY.end_date };
  }, [selectedFY]);

  const currentYear = selectedFY ? parseInt(selectedFY.start_date.slice(0, 4)) : new Date().getFullYear();

  const buildDownloadParams = (format: 'xlsx' | 'pdf' | 'docx'): string | null => {
    if (!selectedCompanyId || !fromDate || !toDate) return null;
    const params = new URLSearchParams({
      report: activeReportKey,
      format,
      companyId: String(selectedCompanyId),
    });
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
  const downloadDisabled = !selectedCompanyId || !selectedFY;
  const filenameHint = selectedCompany
    ? `${selectedCompany.name.replace(/[^a-z0-9]+/gi, '_')}_${activeReportKey}`
    : undefined;

  return (
    <div className="vcfo-module animate-fade-in">
      {/* Top Navigation Tabs */}
      <div className="bg-dark-800 border-b border-dark-400/30 -mx-4 -mt-4 px-4 md:-mx-8 md:-mt-8 md:px-8 mb-0">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between">
          <div className="flex overflow-x-auto scrollbar-hide">
            {topTabs.map(tab => (
              <NavLink
                key={tab.path}
                to={`/vcfo/${tab.path}`}
                onClick={() => setActiveReportKey(tab.key)}
                className={({ isActive }) =>
                  `flex items-center gap-1.5 md:gap-2 px-3 md:px-5 py-3 md:py-4 text-xs md:text-[13px] font-medium border-b-2 transition-all whitespace-nowrap ${
                    isActive
                      ? 'border-accent-500 text-accent-400'
                      : 'border-transparent text-theme-faint hover:text-theme-secondary hover:border-dark-300'
                  }`
                }
              >
                <tab.icon size={15} />
                {tab.label}
              </NavLink>
            ))}
          </div>
          <div className="flex items-center gap-2 md:gap-3 pb-2 md:pb-0 px-1 md:px-0 flex-shrink-0">
            {selectedCompany?.lastSyncedAt && (
              <span className="hidden lg:inline text-xs text-theme-faint">
                Synced {new Date(selectedCompany.lastSyncedAt).toLocaleString()}
              </span>
            )}
            <VcfoDownloadMenu
              disabled={downloadDisabled}
              buildParams={buildDownloadParams}
              filenameHint={filenameHint}
            />
            <div className="h-6 w-px bg-dark-400" />
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
                if (fy) setSelectedFY(fy);
              }}
              className="input text-xs md:text-sm py-1 md:py-1.5 w-28 md:w-36"
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
      <div className="flex flex-wrap items-center justify-between gap-2 py-3 border-b border-dark-400/30 -mx-4 px-4 md:-mx-8 md:px-8 bg-dark-800/50">
        <div className="flex items-center gap-2">
          {(activeReportKey === 'pl' || activeReportKey === 'bs') && (
            <div className="flex bg-dark-700 border border-dark-400/50 rounded-xl overflow-hidden">
              <button
                onClick={() => setViewMode('yearly')}
                className={`px-3 py-1.5 text-xs font-medium transition-all ${viewMode === 'yearly' ? 'bg-accent-500/15 text-accent-400' : 'text-theme-faint hover:text-theme-secondary'}`}
              >
                Yearly
              </button>
              <button
                onClick={() => setViewMode('monthly')}
                className={`px-3 py-1.5 text-xs font-medium transition-all ${viewMode === 'monthly' ? 'bg-accent-500/15 text-accent-400' : 'text-theme-faint hover:text-theme-secondary'}`}
              >
                Monthly
              </button>
            </div>
          )}
          <div className="flex items-center gap-1 ml-3">
            <button
              onClick={() => {
                const idx = fys.findIndex(f => f.id === selectedFY?.id);
                if (idx > 0) setSelectedFY(fys[idx - 1]);
              }}
              disabled={!selectedFY || fys.findIndex(f => f.id === selectedFY.id) <= 0}
              className="p-1.5 hover:bg-dark-600 rounded-lg text-theme-faint transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
              title="Previous fiscal year"
            >
              <ChevronLeft size={14} />
            </button>
            <div className="flex items-center gap-1 px-2 text-sm text-theme-muted">
              <Calendar size={14} />
              <span className="font-medium">{currentYear}-{String(currentYear + 1).slice(-2)}</span>
            </div>
            <button
              onClick={() => {
                const idx = fys.findIndex(f => f.id === selectedFY?.id);
                if (idx >= 0 && idx < fys.length - 1) setSelectedFY(fys[idx + 1]);
              }}
              disabled={!selectedFY || fys.findIndex(f => f.id === selectedFY.id) >= fys.length - 1}
              className="p-1.5 hover:bg-dark-600 rounded-lg text-theme-faint transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
              title="Next fiscal year"
            >
              <ChevronRight size={14} />
            </button>
          </div>
          {selectedCompany && (
            <span className="text-xs font-medium text-accent-400 bg-accent-500/10 px-2.5 py-1 rounded-lg ml-3">
              {selectedCompany.name}
            </span>
          )}
        </div>
      </div>

      {/* Route Content */}
      <div className="mt-4 md:mt-6">
        {companies.length === 0 && !companiesLoading ? (
          <div className="bg-dark-800 border border-dark-400/30 rounded-2xl p-10 text-center">
            <p className="text-theme-muted mb-2 font-medium">No companies synced yet.</p>
            <p className="text-sm text-theme-faint">
              Install the VCFO Sync desktop agent and point it at your Tally ERP. Once a sync completes,
              companies appear here automatically.
            </p>
          </div>
        ) : (
          <Routes>
            <Route index element={<Navigate to="trial-balance" replace />} />
            <Route
              path="trial-balance"
              element={<TrialBalanceReport companyId={selectedCompanyId} from={fromDate} to={toDate} />}
            />
            <Route
              path="profit-loss"
              element={
                <ProfitLossReport
                  companyId={selectedCompanyId}
                  from={fromDate}
                  to={toDate}
                  view={viewMode}
                />
              }
            />
            <Route
              path="balance-sheet"
              element={
                <BalanceSheetReport
                  companyId={selectedCompanyId}
                  asOf={toDate}
                  view={viewMode}
                  from={fromDate}
                />
              }
            />
            <Route
              path="cash-flow"
              element={<CashFlowReport companyId={selectedCompanyId} from={fromDate} to={toDate} />}
            />
          </Routes>
        )}
      </div>
    </div>
  );
}
