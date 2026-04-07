import { useEffect, useState, useCallback } from 'react';
import { Routes, Route, NavLink, useNavigate, Navigate } from 'react-router-dom';
import api from '../api/client';
import ForecastOverview from '../components/forecast/ForecastOverview';
import FinancialTables from '../components/forecast/FinancialTables';
import ProfitAndLoss from '../components/forecast/ProfitAndLoss';
import BalanceSheet from '../components/forecast/BalanceSheet';
import CashFlowReport from '../components/forecast/CashFlowReport';
import {
  BarChart3, Table2, FileText, Building2, Banknote, ChevronLeft, ChevronRight, Calendar, Download, Printer, FileDown
} from 'lucide-react';
import DownloadPrintPanel from '../components/forecast/DownloadPrintPanel';
import { exportAllItemsCSV } from '../components/forecast/csvExport';

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

  // Load FYs
  useEffect(() => {
    api.get('/settings/fy').then(res => {
      setFYs(res.data);
      const active = res.data.find((f: FY) => f.is_active);
      if (active) setSelectedFY(active);
      else if (res.data.length) setSelectedFY(res.data[0]);
    });
  }, []);

  // Ensure scenario exists for selected FY
  useEffect(() => {
    if (!selectedFY) return;
    api.post('/forecast-module/scenarios/ensure', { fy_id: selectedFY.id }).then(res => {
      setScenario(res.data);
      return api.get('/forecast-module/scenarios', { params: { fy_id: selectedFY.id } });
    }).then(res => {
      setScenarios(res.data);
    });
  }, [selectedFY]);

  // Load all items and values for scenario
  const loadData = useCallback(async () => {
    if (!scenario) return;
    const [itemsRes, valuesRes, settingsRes] = await Promise.all([
      api.get('/forecast-module/items', { params: { scenario_id: scenario.id } }),
      api.get('/forecast-module/values', { params: { scenario_id: scenario.id } }),
      api.get('/forecast-module/settings', { params: { scenario_id: scenario.id } }),
    ]);
    setItems(itemsRes.data);
    // Build lookup
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
    <div className="forecast-module">
      {/* Top Navigation Tabs */}
      <div className="bg-white border-b border-slate-200 -mx-6 -mt-6 px-6 mb-0">
        <div className="flex items-center justify-between">
          <div className="flex">
            {topTabs.map(tab => (
              <NavLink
                key={tab.path}
                to={`/forecast/${tab.path}`}
                className={({ isActive }) =>
                  `flex items-center gap-2 px-5 py-4 text-sm font-medium border-b-2 transition-colors ${
                    isActive
                      ? 'border-primary-500 text-primary-600'
                      : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300'
                  }`
                }
              >
                <tab.icon size={16} />
                {tab.label}
              </NavLink>
            ))}
          </div>
          <div className="flex items-center gap-3">
            {/* Download & Print button */}
            <button
              onClick={() => setShowDownloadPanel(true)}
              className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-slate-600 hover:text-primary-600 hover:bg-primary-50 rounded-lg transition-colors"
              title="Download & Print Reports"
            >
              <Printer size={16} />
              <span className="hidden lg:inline">Download & Print</span>
            </button>
            <div className="h-6 w-px bg-slate-200" />
            {/* Scenario selector */}
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
            {/* FY Selector */}
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

      {/* Toolbar */}
      <div className="flex items-center justify-between py-3 border-b border-slate-200 -mx-6 px-6 bg-slate-50">
        <div className="flex items-center gap-2">
          <div className="flex bg-white border border-slate-200 rounded-lg overflow-hidden">
            <button
              onClick={() => setViewMode('yearly')}
              className={`px-3 py-1.5 text-xs font-medium ${viewMode === 'yearly' ? 'bg-primary-50 text-primary-600' : 'text-slate-500 hover:bg-slate-50'}`}
            >Yearly</button>
            <button
              onClick={() => setViewMode('monthly')}
              className={`px-3 py-1.5 text-xs font-medium ${viewMode === 'monthly' ? 'bg-primary-50 text-primary-600' : 'text-slate-500 hover:bg-slate-50'}`}
            >Monthly</button>
          </div>
          <div className="flex items-center gap-1 ml-3">
            <button className="p-1.5 hover:bg-slate-200 rounded"><ChevronLeft size={14} /></button>
            <div className="flex items-center gap-1 px-2 text-sm text-slate-600">
              <Calendar size={14} />
              <span className="font-medium">{currentYear}-{String(currentYear + 1).slice(-2)}</span>
            </div>
            <button className="p-1.5 hover:bg-slate-200 rounded"><ChevronRight size={14} /></button>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs px-2 py-1 rounded-full bg-amber-100 text-amber-700 font-medium">In Progress</span>
          <button
            onClick={() => exportAllItemsCSV(items, allValues, months, viewMode)}
            className="flex items-center gap-1 px-2 py-1.5 hover:bg-slate-200 rounded text-slate-500 hover:text-slate-700 transition-colors"
            title="Download table as CSV"
          >
            <FileDown size={14} />
            <span className="text-xs font-medium hidden sm:inline">CSV</span>
          </button>
        </div>
      </div>

      {/* Route Content */}
      <div className="mt-4">
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
            />
          } />
          <Route path="pnl" element={
            <ProfitAndLoss items={items} allValues={allValues} months={months} viewMode={viewMode} settings={settings} />
          } />
          <Route path="balance-sheet" element={
            <BalanceSheet items={items} allValues={allValues} months={months} viewMode={viewMode} settings={settings} />
          } />
          <Route path="cash-flow" element={
            <CashFlowReport items={items} allValues={allValues} months={months} viewMode={viewMode} settings={settings} />
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
