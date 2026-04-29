import { useEffect, useState, useCallback } from 'react';
import { Routes, Route, NavLink, useNavigate, Navigate } from 'react-router-dom';
import api from '../api/client';
import ForecastOverview from '../components/forecast/ForecastOverview';
import FinancialTables from '../components/forecast/FinancialTables';
import ProfitAndLoss from '../components/forecast/ProfitAndLoss';
import BalanceSheet from '../components/forecast/BalanceSheet';
import FinancingEditor from '../components/forecast/FinancingEditor';
import CashFlowReport from '../components/forecast/CashFlowReport';
import CategoryMappingEditor from '../components/forecast/CategoryMappingEditor';
import BudgetVsActualReport from '../components/forecast/BudgetVsActualReport';
import {
  BarChart3, Table2, FileText, Building2, Banknote, ChevronLeft, ChevronRight, Calendar, Printer, FileDown, Settings, TrendingUp
} from 'lucide-react';
import DownloadPrintPanel from '../components/forecast/DownloadPrintPanel';
import { exportAllItemsCSV } from '../components/forecast/csvExport';
import { buildForecastWorkbook } from '../utils/forecastWorkbook';
import { canWriteForecast, isSuperAdmin } from '../utils/roles';

export interface FY { id: number; label: string; start_date: string; end_date: string; is_active: number; }
export interface Scenario { id: number; fy_id: number; name: string; is_default: number; }
export interface ForecastItem {
  id: number;
  scenario_id: number;
  category: string;
  name: string;
  item_type: string | null;
  entry_mode: string;
  constant_amount: number;
  constant_period: string;
  start_month: string | null;
  annual_raise_pct: number;
  tax_rate_pct: number;
  sort_order: number;
  parent_id: number | null;
  meta: Record<string, any>;
}

export function getFYMonths(startDate: string): string[] {
  const startYear = parseInt(startDate.slice(0, 4));
  const months: string[] = [];
  for (let m = 4; m <= 12; m++) months.push(`${startYear}-${String(m).padStart(2, '0')}`);
  for (let m = 1; m <= 3; m++) months.push(`${startYear + 1}-${String(m).padStart(2, '0')}`);
  return months;
}

export function getMonthLabel(month: string): string {
  const [y, m] = month.split('-');
  const names = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${names[parseInt(m)]} '${y.slice(-2)}`;
}

export function formatRs(amount: number): string {
  if (amount === 0) return 'Rs0';
  return 'Rs' + new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(amount);
}

const topTabs = [
  { path: 'overview', label: 'Overview', icon: BarChart3 },
  { path: 'tables', label: 'Financial Tables', icon: Table2 },
  { path: 'pnl', label: 'Profit & Loss', icon: FileText },
  { path: 'balance-sheet', label: 'Balance Sheet', icon: Building2 },
  { path: 'cash-flow', label: 'Cash Flow', icon: Banknote },
  { path: 'budget-vs-actual', label: 'Budget vs Actual', icon: TrendingUp },
  { path: 'settings/category-mapping', label: 'Settings', icon: Settings },
];

export default function ForecastModulePage() {
  const [fys, setFYs] = useState<FY[]>([]);
  const [selectedFY, setSelectedFY] = useState<FY | null>(null);
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [viewMode, setViewMode] = useState<'monthly' | 'yearly'>('monthly');
  const [items, setItems] = useState<ForecastItem[]>([]);
  const [allValues, setAllValues] = useState<Record<number, Record<string, number>>>({});
  const [settings, setSettings] = useState<Record<string, any>>({});
  const [showDownloadPanel, setShowDownloadPanel] = useState(false);
  const navigate = useNavigate();

  // Role-based access: admin + operational_head + super_admin can edit forecast.
  // Accountants and legacy `user` role are read-only. Consolidated view stays
  // super_admin-only because it spans branches (OH is branch-scoped).
  const isAllStreams = !localStorage.getItem('stream_id');
  const streamName = localStorage.getItem('stream_name');
  const [isConsolidated, setIsConsolidated] = useState(false);
  const readOnly = !canWriteForecast() || (isConsolidated && !isSuperAdmin());

  useEffect(() => {
    api.get('/settings/fy').then(res => {
      setFYs(res.data);
      const active = res.data.find((f: FY) => f.is_active);
      if (active) setSelectedFY(active);
      else if (res.data.length) setSelectedFY(res.data[0]);
    });
  }, []);

  useEffect(() => {
    if (!selectedFY) return;

    const loadNormalScenario = () => {
      setIsConsolidated(false);
      api.post('/forecast-module/scenarios/ensure', { fy_id: selectedFY.id }).then(res => {
        setScenario(res.data);
        return api.get('/forecast-module/scenarios', { params: { fy_id: selectedFY.id } });
      }).then(res => {
        setScenarios(res.data);
      });
    };

    if (isAllStreams) {
      // Try consolidated mode: fetch merged data from all per-stream scenarios
      api.get('/forecast-module/consolidated', { params: { fy_id: selectedFY.id } }).then(res => {
        const { items: cItems, values: cValues, settings: cSettings, scenarioCount } = res.data;
        if (scenarioCount && scenarioCount > 0) {
          // Multiple per-stream scenarios exist — show consolidated read-only view
          setIsConsolidated(true);
          setScenario({ id: -1, fy_id: selectedFY.id, name: 'All Streams (Consolidated)', is_default: 1 } as Scenario);
          setScenarios([]);
          setItems(cItems || []);
          setAllValues(cValues || {});
          setSettings(cSettings || {});
        } else {
          // No per-stream scenarios — client has no streams, load default scenario normally
          loadNormalScenario();
        }
      });
      return;
    }

    loadNormalScenario();
  }, [selectedFY, isAllStreams]);

  const loadData = useCallback(async () => {
    if (!scenario || scenario.id === -1) return;
    const [itemsRes, valuesRes, settingsRes] = await Promise.all([
      api.get('/forecast-module/items', { params: { scenario_id: scenario.id } }),
      api.get('/forecast-module/values', { params: { scenario_id: scenario.id } }),
      api.get('/forecast-module/settings', { params: { scenario_id: scenario.id } }),
    ]);
    setItems(itemsRes.data);
    const lookup: Record<number, Record<string, number>> = {};
    valuesRes.data.forEach((v: any) => {
      if (!lookup[v.item_id]) lookup[v.item_id] = {};
      lookup[v.item_id][v.month] = v.amount;
    });
    setAllValues(lookup);
    setSettings(settingsRes.data);
  }, [scenario]);

  useEffect(() => { loadData(); }, [loadData]);

  const months = selectedFY ? getFYMonths(selectedFY.start_date) : [];
  const currentYear = selectedFY ? parseInt(selectedFY.start_date.slice(0, 4)) : 2026;

  return (
    <div className="forecast-module animate-fade-in">
      {/* Top Navigation Tabs */}
      <div
        className="-mx-4 -mt-4 px-4 md:-mx-8 md:-mt-8 md:px-8 mb-0"
        style={{ background: 'var(--mt-bg-raised)', borderBottom: '1px solid var(--mt-border)' }}
      >
        <div className="flex flex-col md:flex-row md:items-center md:justify-between">
          <div data-tour="forecast-tabs" className="flex overflow-x-auto scrollbar-hide">
            {topTabs.map(tab => (
              <NavLink
                key={tab.path}
                to={`/forecast/${tab.path}`}
                className={({ isActive }) => `mt-tab${isActive ? ' mt-tab--active' : ''}`}
              >
                <tab.icon size={15} />
                {tab.label}
              </NavLink>
            ))}
          </div>
          <div className="flex items-center gap-2 md:gap-3 pb-2 md:pb-0 px-1 md:px-0 flex-shrink-0">
            {isConsolidated && (
              <span className="mt-pill mt-pill--warn">Consolidated View (Read-only)</span>
            )}
            {streamName && !isAllStreams && (
              <span className="mt-pill mt-pill--success">{streamName}</span>
            )}
            <button
              data-tour="print-button"
              onClick={() => setShowDownloadPanel(true)}
              className="mt-btn-ghost"
              title="Download & Print Reports"
            >
              <Printer size={15} />
              <span className="hidden lg:inline">Print</span>
            </button>
            {!isConsolidated && <>
            <div style={{ height: 24, width: 1, background: 'var(--mt-border)' }} />
            <select
              data-tour="scenario-select"
              value={scenario?.id || ''}
              onChange={e => {
                const s = scenarios.find(sc => sc.id === Number(e.target.value));
                if (s) setScenario(s);
              }}
              className="mt-input"
              style={{ padding: '6px 10px', fontSize: 12, width: '12rem' }}
            >
              {scenarios.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            </>}
            <select
              data-tour="fy-select"
              value={selectedFY?.id || ''}
              onChange={e => {
                const fy = fys.find(f => f.id === Number(e.target.value));
                if (fy) setSelectedFY(fy);
              }}
              className="mt-input"
              style={{ padding: '6px 10px', fontSize: 12, width: '9rem' }}
            >
              {fys.map(fy => <option key={fy.id} value={fy.id}>{fy.label}</option>)}
            </select>
          </div>
        </div>
      </div>

      {/* Toolbar */}
      <div
        className="flex flex-wrap items-center justify-between gap-2 py-3 -mx-4 px-4 md:-mx-8 md:px-8"
        style={{
          background: 'var(--mt-bg-surface)',
          borderBottom: '1px solid var(--mt-border)',
        }}
      >
        <div className="flex items-center gap-2">
          <div
            data-tour="view-mode"
            className="flex overflow-hidden"
            style={{
              background: 'var(--mt-bg-raised)',
              border: '1px solid var(--mt-border)',
              borderRadius: 10,
            }}
          >
            <button
              onClick={() => setViewMode('yearly')}
              className="px-3 py-1.5 text-xs font-medium transition-colors"
              style={{
                color: viewMode === 'yearly' ? 'var(--mt-accent-text)' : 'var(--mt-text-faint)',
                background: viewMode === 'yearly' ? 'var(--mt-accent-soft)' : 'transparent',
              }}
            >Yearly</button>
            <button
              onClick={() => setViewMode('monthly')}
              className="px-3 py-1.5 text-xs font-medium transition-colors"
              style={{
                color: viewMode === 'monthly' ? 'var(--mt-accent-text)' : 'var(--mt-text-faint)',
                background: viewMode === 'monthly' ? 'var(--mt-accent-soft)' : 'transparent',
              }}
            >Monthly</button>
          </div>
          <div className="flex items-center gap-1 ml-3">
            <button
              onClick={() => {
                const idx = fys.findIndex(f => f.id === selectedFY?.id);
                if (idx > 0) setSelectedFY(fys[idx - 1]);
              }}
              disabled={!selectedFY || fys.findIndex(f => f.id === selectedFY.id) <= 0}
              className="p-1.5 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ color: 'var(--mt-text-faint)' }}
              title="Previous fiscal year"
              aria-label="Previous fiscal year"
            >
              <ChevronLeft size={14} />
            </button>
            <div className="flex items-center gap-1 px-2 text-sm" style={{ color: 'var(--mt-text-muted)' }} title="Current fiscal year">
              <Calendar size={14} />
              <span className="font-medium mt-num">{currentYear}-{String(currentYear + 1).slice(-2)}</span>
            </div>
            <button
              onClick={() => {
                const idx = fys.findIndex(f => f.id === selectedFY?.id);
                if (idx >= 0 && idx < fys.length - 1) setSelectedFY(fys[idx + 1]);
              }}
              disabled={!selectedFY || fys.findIndex(f => f.id === selectedFY.id) >= fys.length - 1}
              className="p-1.5 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ color: 'var(--mt-text-faint)' }}
              title="Next fiscal year"
              aria-label="Next fiscal year"
            >
              <ChevronRight size={14} />
            </button>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="mt-pill mt-pill--warn">In Progress</span>
          <button
            onClick={async () => {
              try {
                const branchName = (typeof window !== 'undefined' ? localStorage.getItem('branch_name') : '') || undefined;
                const streamName = (typeof window !== 'undefined' ? localStorage.getItem('stream_name') : '') || undefined;
                const blob = await buildForecastWorkbook({
                  items, allValues, months, settings, scenario, fy: selectedFY, branchName, streamName,
                });
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                const fyTag = selectedFY?.label ? `_${selectedFY.label.replace(/\s+/g, '_')}` : '';
                const branchTag = branchName ? `_${branchName.replace(/\s+/g, '_')}` : '';
                link.download = `Forecast${fyTag}${branchTag}.xlsx`;
                link.click();
                URL.revokeObjectURL(url);
              } catch (e) {
                console.error('Forecast XLSX export failed:', e);
                alert('Could not generate the Excel workbook. Check the browser console for details.');
              }
            }}
            className="mt-btn-gradient"
            style={{ padding: '6px 12px', fontSize: 12 }}
            title="Download a multi-sheet Excel workbook (Summary + per-category sheets with formulas)"
          >
            <FileDown size={14} />
            <span className="hidden sm:inline">Excel</span>
          </button>
          <button
            onClick={() => exportAllItemsCSV(items, allValues, months, viewMode)}
            className="mt-btn-ghost"
            style={{ padding: '6px 10px', fontSize: 12 }}
            title="Download table as CSV (legacy single-sheet export)"
          >
            <FileDown size={14} />
            <span className="hidden sm:inline">CSV</span>
          </button>
        </div>
      </div>

      {/* Route Content */}
      <div className="mt-4 md:mt-6">
        <Routes>
          <Route index element={<Navigate to="tables" replace />} />
          <Route path="overview" element={
            <ForecastOverview items={items} allValues={allValues} months={months} settings={settings} scenario={scenario} />
          } />
          <Route path="tables/*" element={
            <FinancialTables
              scenario={scenario}
              months={months}
              viewMode={viewMode}
              items={items}
              allValues={allValues}
              settings={settings}
              onReload={loadData}
              readOnly={readOnly}
            />
          } />
          <Route path="pnl" element={
            <ProfitAndLoss items={items} allValues={allValues} months={months} viewMode={viewMode} settings={settings} scenario={scenario} onReload={loadData} readOnly={readOnly} />
          } />
          <Route path="balance-sheet" element={
            <BalanceSheet items={items} allValues={allValues} months={months} viewMode={viewMode} settings={settings} scenario={scenario} onReload={loadData} readOnly={readOnly} />
          } />
          <Route path="balance-sheet/financing/:itemId/:finType" element={
            <FinancingEditor items={items} allValues={allValues} months={months} scenario={scenario} onReload={loadData} />
          } />
          <Route path="cash-flow" element={
            <CashFlowReport items={items} allValues={allValues} months={months} viewMode={viewMode} settings={settings} scenario={scenario} onReload={loadData} readOnly={readOnly} />
          } />
          <Route path="budget-vs-actual" element={
            <BudgetVsActualReport scenario={scenario} viewMode={viewMode} />
          } />
          <Route path="settings/category-mapping" element={
            <CategoryMappingEditor readOnly={readOnly} />
          } />
        </Routes>
      </div>

      {/* Download & Print Panel */}
      <DownloadPrintPanel
        open={showDownloadPanel}
        onClose={() => setShowDownloadPanel(false)}
        items={items}
        allValues={allValues}
        months={months}
        settings={settings}
        scenarioName={scenario?.name || 'Forecast'}
        fyLabel={selectedFY?.label || ''}
      />
    </div>
  );
}
