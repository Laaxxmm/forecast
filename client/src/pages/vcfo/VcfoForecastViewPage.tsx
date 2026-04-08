/**
 * VCFO Forecast View — Read-only mirror of the Forecast module.
 * Reuses the same display components (ForecastOverview, ProfitAndLoss, BalanceSheet,
 * CashFlowReport, CategoryTab) but forces readOnly mode. All data comes from the
 * same tenant DB via /vcfo/forecast-view/ endpoints.
 */
import { useEffect, useState, useCallback } from 'react';
import {
  BarChart3, Table2, FileText, Building2, Banknote,
  ChevronLeft, ChevronRight, Calendar,
} from 'lucide-react';
import api from '../../api/client';
import ForecastOverview from '../../components/forecast/ForecastOverview';
import ProfitAndLoss from '../../components/forecast/ProfitAndLoss';
import BalanceSheet from '../../components/forecast/BalanceSheet';
import CashFlowReport from '../../components/forecast/CashFlowReport';
import CategoryTab from '../../components/forecast/CategoryTab';
import type { FY, Scenario, ForecastItem } from '../ForecastModulePage';
import { getFYMonths, getMonthLabel } from '../ForecastModulePage';

/* ─── Top-level tabs (match Forecast module exactly) ──────── */
const topTabs = [
  { key: 'overview', label: 'Overview', icon: BarChart3 },
  { key: 'tables', label: 'Financial Tables', icon: Table2 },
  { key: 'pnl', label: 'Profit & Loss', icon: FileText },
  { key: 'balance-sheet', label: 'Balance Sheet', icon: Building2 },
  { key: 'cash-flow', label: 'Cash Flow', icon: Banknote },
] as const;

type TopTab = typeof topTabs[number]['key'];

/* ─── Category sub-tabs for Financial Tables ──────────────── */
const subTabs = [
  { key: 'revenue', label: 'Revenue', category: 'revenue' },
  { key: 'direct-costs', label: 'Direct Costs', category: 'direct_costs' },
  { key: 'personnel', label: 'Personnel', category: 'personnel' },
  { key: 'expenses', label: 'Expenses', category: 'expenses' },
  { key: 'assets', label: 'Assets', category: 'assets' },
  { key: 'taxes', label: 'Taxes', category: 'taxes' },
  { key: 'dividends', label: 'Dividends', category: 'dividends' },
  { key: 'cash-flow-assumptions', label: 'Cash Flow Assumptions', category: 'cash_flow_assumptions' },
  { key: 'initial-balances', label: 'Initial Balances', category: 'initial_balances' },
  { key: 'financing', label: 'Financing', category: 'financing' },
];

export default function VcfoForecastViewPage() {
  const [fys, setFYs] = useState<FY[]>([]);
  const [selectedFY, setSelectedFY] = useState<FY | null>(null);
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [viewMode, setViewMode] = useState<'monthly' | 'yearly'>('monthly');
  const [items, setItems] = useState<ForecastItem[]>([]);
  const [allValues, setAllValues] = useState<Record<number, Record<string, number>>>({});
  const [settings, setSettings] = useState<Record<string, any>>({});

  const [activeTop, setActiveTop] = useState<TopTab>('tables');
  const [activeSub, setActiveSub] = useState('revenue');

  // Load FYs
  useEffect(() => {
    api.get('/vcfo/forecast-view/financial-years').then(res => {
      setFYs(res.data);
      const active = res.data.find((f: FY) => f.is_active);
      if (active) setSelectedFY(active);
      else if (res.data.length) setSelectedFY(res.data[0]);
    }).catch(() => {});
  }, []);

  // Load scenarios when FY changes
  useEffect(() => {
    if (!selectedFY) return;
    api.get('/vcfo/forecast-view/scenarios', { params: { fy_id: selectedFY.id } }).then(res => {
      setScenarios(res.data);
      const def = res.data.find((s: Scenario) => s.is_default) || res.data[0];
      setScenario(def || null);
    }).catch(() => setScenarios([]));
  }, [selectedFY]);

  // Load forecast data when scenario changes
  const loadData = useCallback(async () => {
    if (!scenario) return;
    try {
      const res = await api.get('/vcfo/forecast-view/summary', { params: { scenario_id: scenario.id } });
      setItems(res.data.items || []);
      setAllValues(res.data.values || {});
      setSettings(res.data.settings || {});
    } catch { /* empty */ }
  }, [scenario]);

  useEffect(() => { loadData(); }, [loadData]);

  const months = selectedFY ? getFYMonths(selectedFY.start_date) : [];
  const currentYear = selectedFY ? parseInt(selectedFY.start_date.slice(0, 4)) : 2026;

  return (
    <div className="forecast-module animate-fade-in">
      {/* Top Navigation Tabs — identical to Forecast module */}
      <div className="bg-dark-800 border-b border-dark-400/30 -mx-8 -mt-8 px-8 mb-0">
        <div className="flex items-center justify-between">
          <div className="flex">
            {topTabs.map(tab => (
              <button
                key={tab.key}
                onClick={() => setActiveTop(tab.key)}
                className={`flex items-center gap-2 px-5 py-4 text-[13px] font-medium border-b-2 transition-all ${
                  activeTop === tab.key
                    ? 'border-accent-500 text-accent-400'
                    : 'border-transparent text-theme-faint hover:text-theme-secondary hover:border-dark-300'
                }`}
              >
                <tab.icon size={16} />
                {tab.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <select
              value={scenario?.id || ''}
              onChange={e => {
                const s = scenarios.find(sc => sc.id === Number(e.target.value));
                if (s) setScenario(s);
              }}
              className="input text-sm py-1.5 w-48"
            >
              {scenarios.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <select
              value={selectedFY?.id || ''}
              onChange={e => {
                const fy = fys.find(f => f.id === Number(e.target.value));
                if (fy) setSelectedFY(fy);
              }}
              className="input text-sm py-1.5 w-36"
            >
              {fys.map(fy => <option key={fy.id} value={fy.id}>{fy.label}</option>)}
            </select>
          </div>
        </div>
      </div>

      {/* Toolbar — same as Forecast module */}
      <div className="flex items-center justify-between py-3 border-b border-dark-400/30 -mx-8 px-8 bg-dark-800/50">
        <div className="flex items-center gap-2">
          <div className="flex bg-dark-700 border border-dark-400/50 rounded-xl overflow-hidden">
            <button
              onClick={() => setViewMode('yearly')}
              className={`px-3 py-1.5 text-xs font-medium transition-all ${viewMode === 'yearly' ? 'bg-accent-500/15 text-accent-400' : 'text-theme-faint hover:text-theme-secondary'}`}
            >Yearly</button>
            <button
              onClick={() => setViewMode('monthly')}
              className={`px-3 py-1.5 text-xs font-medium transition-all ${viewMode === 'monthly' ? 'bg-accent-500/15 text-accent-400' : 'text-theme-faint hover:text-theme-secondary'}`}
            >Monthly</button>
          </div>
          <div className="flex items-center gap-1 ml-3">
            <button className="p-1.5 hover:bg-dark-600 rounded-lg text-theme-faint transition-colors"><ChevronLeft size={14} /></button>
            <div className="flex items-center gap-1 px-2 text-sm text-theme-muted">
              <Calendar size={14} />
              <span className="font-medium">{currentYear}-{String(currentYear + 1).slice(-2)}</span>
            </div>
            <button className="p-1.5 hover:bg-dark-600 rounded-lg text-theme-faint transition-colors"><ChevronRight size={14} /></button>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="badge-warning text-[10px]">In Progress</span>
        </div>
      </div>

      {/* Tab Content */}
      <div className="mt-6">
        {activeTop === 'overview' && (
          <ForecastOverview items={items} allValues={allValues} months={months} settings={settings} scenario={scenario} />
        )}

        {activeTop === 'tables' && (
          <div>
            {/* Category sub-tabs — same as FinancialTables but state-based */}
            <div className="flex gap-1 overflow-x-auto pb-2 mb-4 border-b border-dark-400/50 -mx-6 px-6">
              {subTabs.map(tab => (
                <button
                  key={tab.key}
                  onClick={() => setActiveSub(tab.key)}
                  className={`px-4 py-2 text-xs font-medium rounded-t-lg whitespace-nowrap border-b-2 transition-colors ${
                    activeSub === tab.key
                      ? 'border-accent-500 text-accent-400 bg-accent-500/10'
                      : 'border-transparent text-theme-faint hover:text-theme-secondary hover:bg-dark-600'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* Render the active category tab */}
            {(() => {
              const active = subTabs.find(t => t.key === activeSub);
              if (!active) return null;
              return (
                <CategoryTab
                  key={active.key}
                  category={active.category}
                  label={active.label}
                  scenario={scenario}
                  months={months}
                  viewMode={viewMode}
                  items={items.filter(i => i.category === active.category)}
                  allItems={items}
                  allValues={allValues}
                  settings={settings}
                  onReload={loadData}
                  readOnly={true}
                />
              );
            })()}
          </div>
        )}

        {activeTop === 'pnl' && (
          <ProfitAndLoss items={items} allValues={allValues} months={months} viewMode={viewMode} settings={settings} />
        )}

        {activeTop === 'balance-sheet' && (
          <BalanceSheet items={items} allValues={allValues} months={months} viewMode={viewMode} settings={settings} />
        )}

        {activeTop === 'cash-flow' && (
          <CashFlowReport items={items} allValues={allValues} months={months} viewMode={viewMode} settings={settings} />
        )}
      </div>
    </div>
  );
}
