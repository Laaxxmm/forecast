import { useState, useMemo, useEffect } from 'react';
import { NavLink, Routes, Route, Navigate } from 'react-router-dom';
import { Upload, Save, CheckCircle } from 'lucide-react';
import api from '../../api/client';
import { ForecastItem, FY, Scenario } from '../../pages/ForecastModulePage';
import { monthFullLabel, fmtRs } from './dashboardUtils';

interface Props {
  items: ForecastItem[];
  allValues: Record<number, Record<string, number>>;
  months: string[];
  settings: Record<string, any>;
  actuals: Record<string, Record<string, number>>;
  scenario: Scenario | null;
  selectedFY: FY | null;
  onReload: () => Promise<void>;
}

const SUB_TABS = [
  { path: 'revenue', label: 'Revenue', category: 'revenue' },
  { path: 'expenses', label: 'Expenses', category: 'expenses' },
  { path: 'direct-costs', label: 'Direct Costs', category: 'direct_costs' },
  { path: 'assets', label: 'Assets', category: 'assets' },
  { path: 'liabilities', label: 'Liabilities', category: 'liabilities' },
  { path: 'equity', label: 'Equity', category: 'equity' },
];

interface ActualEntry {
  item_name: string;
  linked_item_id: number | null;
  amount: number;
}

function ActualsEntryForm({ category, items, scenario, selectedMonth, onReload }: {
  category: string;
  items: ForecastItem[];
  scenario: Scenario | null;
  selectedMonth: string;
  onReload: () => Promise<void>;
}) {
  const [entries, setEntries] = useState<ActualEntry[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [enterMode, setEnterMode] = useState<'individual' | 'overall'>('individual');

  const catItems = useMemo(() => items.filter(i => i.category === category), [items, category]);

  // Load existing actuals
  useEffect(() => {
    if (!scenario) return;
    api.get('/dashboard-actuals', {
      params: { scenario_id: scenario.id, month: selectedMonth, category }
    }).then(res => {
      const existing = res.data as any[];
      // Build entries from forecast items + any existing actuals
      const entryList: ActualEntry[] = catItems.map(item => {
        const match = existing.find((e: any) => e.linked_item_id === item.id || e.item_name === item.name);
        return {
          item_name: item.name,
          linked_item_id: item.id,
          amount: match?.amount || 0,
        };
      });
      // Add any existing entries not linked to forecast items
      existing.forEach((e: any) => {
        if (!entryList.find(en => en.linked_item_id === e.linked_item_id || en.item_name === e.item_name)) {
          entryList.push({ item_name: e.item_name, linked_item_id: e.linked_item_id, amount: e.amount });
        }
      });
      // If no items in this category, add an "Overall" entry
      if (entryList.length === 0) {
        const match = existing.find((e: any) => e.item_name === `Overall ${category}`);
        entryList.push({ item_name: `Overall ${category}`, linked_item_id: null, amount: match?.amount || 0 });
      }
      setEntries(entryList);
    });
  }, [scenario, selectedMonth, category, catItems]);

  const updateAmount = (idx: number, amount: number) => {
    setEntries(prev => prev.map((e, i) => i === idx ? { ...e, amount } : e));
    setSaved(false);
  };

  const handleSave = async () => {
    if (!scenario) return;
    setSaving(true);
    try {
      await api.post('/dashboard-actuals/bulk', {
        scenario_id: scenario.id,
        entries: entries.map(e => ({
          category,
          item_name: e.item_name,
          linked_item_id: e.linked_item_id,
          month: selectedMonth,
          amount: e.amount,
        })),
      });
      setSaved(true);
      await onReload();
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      console.error('Failed to save actuals:', err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      {/* Entry mode toggle for Revenue */}
      {category === 'revenue' && (
        <div className="flex items-center gap-3 mb-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="radio" checked={enterMode === 'individual'} onChange={() => setEnterMode('individual')} className="text-primary-600" />
            <span className="text-sm text-slate-600">Enter individual revenue streams</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="radio" checked={enterMode === 'overall'} onChange={() => setEnterMode('overall')} className="text-primary-600" />
            <span className="text-sm text-slate-600">Enter overall revenue only</span>
          </label>
        </div>
      )}

      {/* Entry form */}
      <div className="card">
        <div className="space-y-3">
          {(enterMode === 'overall' && category === 'revenue'
            ? [{ item_name: 'Total Revenue', linked_item_id: null, amount: entries.reduce((s, e) => s + e.amount, 0) }]
            : entries
          ).map((entry, idx) => (
            <div key={idx} className="flex items-center gap-4">
              <label className="text-sm text-slate-700 w-64 flex-shrink-0 truncate" title={entry.item_name}>
                {entry.item_name}
              </label>
              <div className="relative flex-1 max-w-xs">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-400">Rs</span>
                <input
                  type="number"
                  value={entry.amount || ''}
                  onChange={e => updateAmount(idx, parseFloat(e.target.value) || 0)}
                  placeholder="0"
                  className="input pl-8 text-sm py-2"
                />
              </div>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-3 mt-6 pt-4 border-t border-slate-200">
          <button
            onClick={handleSave}
            disabled={saving}
            className="btn-primary flex items-center gap-2 text-sm"
          >
            {saving ? (
              <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            ) : saved ? (
              <CheckCircle size={16} />
            ) : (
              <Save size={16} />
            )}
            {saved ? 'Saved!' : saving ? 'Saving...' : 'Save Actuals'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function UpdateActuals({ items, months, scenario, onReload }: Props) {
  const [selectedMonth, setSelectedMonth] = useState(months[0] || '');

  return (
    <div>
      {/* Header */}
      <div className="mb-6">
        <h2 className="text-xl font-bold text-slate-800 mb-1">Update your actuals</h2>
        <p className="text-sm text-slate-500">Enter actual financial results for {monthFullLabel(selectedMonth)}</p>
      </div>

      {/* Month selector */}
      <div className="mb-4">
        <select
          value={selectedMonth}
          onChange={e => setSelectedMonth(e.target.value)}
          className="input text-sm py-2 w-48"
        >
          {months.map(m => <option key={m} value={m}>{monthFullLabel(m)}</option>)}
        </select>
      </div>

      {/* CSV Import Banner */}
      <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-4 mb-6 flex items-center gap-3 cursor-pointer hover:bg-emerald-100 transition-colors">
        <Upload size={20} className="text-emerald-600 flex-shrink-0" />
        <div>
          <p className="text-sm font-semibold text-emerald-800">Import Actuals from a Comma Separated Value (CSV) file</p>
          <p className="text-xs text-emerald-600">Use our CSV template to manually update your actuals</p>
        </div>
      </div>

      {/* Sub-tabs */}
      <div className="flex gap-1 overflow-x-auto pb-2 mb-4 border-b border-slate-200">
        {SUB_TABS.map(tab => (
          <NavLink
            key={tab.path}
            to={`/analysis/update-actuals/${tab.path}`}
            className={({ isActive }) =>
              `px-4 py-2 text-xs font-medium rounded-t-lg whitespace-nowrap border-b-2 transition-colors ${
                isActive
                  ? 'border-primary-500 text-primary-600 bg-primary-50/50'
                  : 'border-transparent text-slate-500 hover:text-slate-700 hover:bg-slate-50'
              }`
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </div>

      {/* Sub-tab routes */}
      <Routes>
        <Route index element={<Navigate to="revenue" replace />} />
        {SUB_TABS.map(tab => (
          <Route
            key={tab.path}
            path={tab.path}
            element={
              <ActualsEntryForm
                category={tab.category}
                items={items}
                scenario={scenario}
                selectedMonth={selectedMonth}
                onReload={onReload}
              />
            }
          />
        ))}
      </Routes>
    </div>
  );
}
