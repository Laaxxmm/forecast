import { useEffect, useState, useCallback } from 'react';
import { Routes, Route, NavLink, Navigate } from 'react-router-dom';
import api from '../api/client';
import { FY, Scenario, ForecastItem, getFYMonths } from './ForecastModulePage';
import DashboardOverview from '../components/dashboard/DashboardOverview';
import DashboardTrends from '../components/dashboard/DashboardTrends';
import DashboardPnL from '../components/dashboard/DashboardPnL';
import DashboardBalanceSheet from '../components/dashboard/DashboardBalanceSheet';
import DashboardCashFlow from '../components/dashboard/DashboardCashFlow';
import MonthlyReview from '../components/dashboard/MonthlyReview';
import UpdateActuals from '../components/dashboard/UpdateActuals';
import DashboardDownloadPrint from '../components/dashboard/DashboardDownloadPrint';
import {
  BarChart3, TrendingUp, FileText, Building2, Banknote, BookOpen, Edit3, Download
} from 'lucide-react';

const tabs = [
  { path: 'overview', label: 'Overview', icon: BarChart3 },
  { path: 'trends', label: 'Trends', icon: TrendingUp },
  { path: 'pnl', label: 'Profit & Loss', icon: FileText },
  { path: 'balance-sheet', label: 'Balance Sheet', icon: Building2 },
  { path: 'cash-flow', label: 'Cash Flow', icon: Banknote },
  { path: 'monthly-review', label: 'Monthly Review', icon: BookOpen },
  { path: 'update-actuals', label: 'Update your actuals', icon: Edit3 },
  { path: 'download', label: 'Download & Print', icon: Download },
];

export default function DashboardModulePage() {
  const userRole = localStorage.getItem('user_role');
  const isClientAdmin = userRole === 'admin';
  const [fys, setFYs] = useState<FY[]>([]);
  const [selectedFY, setSelectedFY] = useState<FY | null>(null);
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [items, setItems] = useState<ForecastItem[]>([]);
  const [allValues, setAllValues] = useState<Record<number, Record<string, number>>>({});
  const [settings, setSettings] = useState<Record<string, any>>({});
  const [actuals, setActuals] = useState<Record<string, Record<string, number>>>({});

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
    api.post('/forecast-module/scenarios/ensure', { fy_id: selectedFY.id }).then(res => {
      setScenario(res.data);
      return api.get('/forecast-module/scenarios', { params: { fy_id: selectedFY.id } });
    }).then(res => setScenarios(res.data));
  }, [selectedFY]);

  const loadData = useCallback(async () => {
    if (!scenario) return;
    const [itemsRes, valuesRes, settingsRes, actualsRes] = await Promise.all([
      api.get('/forecast-module/items', { params: { scenario_id: scenario.id } }),
      api.get('/forecast-module/values', { params: { scenario_id: scenario.id } }),
      api.get('/forecast-module/settings', { params: { scenario_id: scenario.id } }),
      api.get('/dashboard-actuals/summary', { params: { scenario_id: scenario.id } }),
    ]);
    setItems(itemsRes.data);
    const lookup: Record<number, Record<string, number>> = {};
    valuesRes.data.forEach((v: any) => {
      if (!lookup[v.item_id]) lookup[v.item_id] = {};
      lookup[v.item_id][v.month] = v.amount;
    });
    setAllValues(lookup);
    setSettings(settingsRes.data);

    const aLookup: Record<string, Record<string, number>> = {};
    actualsRes.data.forEach((r: any) => {
      if (!aLookup[r.category]) aLookup[r.category] = {};
      aLookup[r.category][r.month] = r.total;
    });
    setActuals(aLookup);
  }, [scenario]);

  useEffect(() => { loadData(); }, [loadData]);

  const months = selectedFY ? getFYMonths(selectedFY.start_date) : [];

  const sharedProps = {
    items,
    allValues,
    months,
    settings,
    actuals,
    scenario,
    selectedFY,
    onReload: loadData,
  };

  return (
    <div className="dashboard-module animate-fade-in">
      {/* Top Navigation */}
      <div className="bg-dark-800 border-b border-dark-400/30 -mx-8 -mt-8 px-8 mb-0 rounded-none">
        <div className="flex items-center justify-between">
          <div className="flex overflow-x-auto">
            {tabs.filter(tab => isClientAdmin || tab.path !== 'update-actuals').map(tab => (
              <NavLink
                key={tab.path}
                to={`/analysis/${tab.path}`}
                className={({ isActive }) =>
                  `flex items-center gap-2 px-4 py-4 text-[13px] font-medium border-b-2 whitespace-nowrap transition-all ${
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
          <div className="flex items-center gap-3 ml-4 flex-shrink-0">
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

      {/* Content */}
      <div className="mt-6">
        <Routes>
          <Route index element={<Navigate to="overview" replace />} />
          <Route path="overview" element={<DashboardOverview {...sharedProps} />} />
          <Route path="trends" element={<DashboardTrends {...sharedProps} />} />
          <Route path="pnl" element={<DashboardPnL {...sharedProps} />} />
          <Route path="balance-sheet" element={<DashboardBalanceSheet {...sharedProps} />} />
          <Route path="cash-flow" element={<DashboardCashFlow {...sharedProps} />} />
          <Route path="monthly-review" element={<MonthlyReview {...sharedProps} />} />
          <Route path="update-actuals/*" element={<UpdateActuals {...sharedProps} />} />
          <Route path="download" element={<DashboardDownloadPrint {...sharedProps} />} />
        </Routes>
      </div>
    </div>
  );
}
