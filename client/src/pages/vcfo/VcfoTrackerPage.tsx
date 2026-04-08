import { useState, useEffect, useCallback } from 'react';
import { ClipboardCheck, Plus, Check, Clock, AlertCircle, Minus, Loader2, Sprout } from 'lucide-react';
import api from '../../api/client';

interface TrackerItem {
  id: number;
  tracker_type: string;
  name: string;
  category: string;
  frequency: string;
  sort_order: number;
}

interface TrackerStatus {
  status: string;
  due_date: string | null;
  completion_date: string | null;
  assigned_to: string;
  notes: string;
}

type TrackerType = 'compliance' | 'accounting' | 'internal_control';

const trackerTypes: { key: TrackerType; label: string; color: string }[] = [
  { key: 'compliance', label: 'Compliance', color: 'text-blue-400' },
  { key: 'accounting', label: 'Accounting', color: 'text-green-400' },
  { key: 'internal_control', label: 'Internal Control', color: 'text-purple-400' },
];

const statusOptions = [
  { value: 'pending', label: 'Pending', icon: Clock, color: 'text-gray-400 bg-gray-500/10' },
  { value: 'in_progress', label: 'In Progress', icon: Loader2, color: 'text-blue-400 bg-blue-500/10' },
  { value: 'completed', label: 'Completed', icon: Check, color: 'text-green-400 bg-green-500/10' },
  { value: 'overdue', label: 'Overdue', icon: AlertCircle, color: 'text-red-400 bg-red-500/10' },
  { value: 'not_applicable', label: 'N/A', icon: Minus, color: 'text-theme-faint bg-dark-500' },
];

function generatePeriodKeys(type: TrackerType): string[] {
  const now = new Date();
  const fyStartYear = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  const periods: string[] = [];
  for (let m = 0; m < 12; m++) {
    const month = 3 + m; // Apr=3
    const year = month >= 12 ? fyStartYear + 1 : fyStartYear;
    const actualMonth = month >= 12 ? month - 12 : month;
    const d = new Date(year, actualMonth, 1);
    periods.push(d.toISOString().slice(0, 7)); // YYYY-MM
  }
  return periods;
}

function shortMonth(pk: string): string {
  const d = new Date(pk + '-01');
  return d.toLocaleDateString('en-IN', { month: 'short' }).toUpperCase();
}

export default function VcfoTrackerPage() {
  const [companies, setCompanies] = useState<any[]>([]);
  const [companyId, setCompanyId] = useState<string>('');
  const [trackerType, setTrackerType] = useState<TrackerType>('compliance');
  const [items, setItems] = useState<TrackerItem[]>([]);
  const [statusMap, setStatusMap] = useState<Record<number, Record<string, TrackerStatus>>>({});
  const [loading, setLoading] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [summary, setSummary] = useState<Record<string, number>>({});
  const [showAddItem, setShowAddItem] = useState(false);
  const [newItemName, setNewItemName] = useState('');
  const [newItemCategory, setNewItemCategory] = useState('');
  const [newItemFrequency, setNewItemFrequency] = useState('monthly');

  const periods = generatePeriodKeys(trackerType);

  useEffect(() => {
    api.get('/vcfo/companies').then(r => {
      setCompanies(r.data);
      if (r.data.length > 0) setCompanyId(String(r.data[0].id));
    }).catch(() => {});
  }, []);

  const loadData = useCallback(() => {
    if (!companyId) return;
    setLoading(true);
    const periodFrom = periods[0];
    const periodTo = periods[periods.length - 1];
    const params: any = { type: trackerType, companyId, periodFrom, periodTo };

    Promise.all([
      api.get('/vcfo/tracker/status', { params }),
      api.get('/vcfo/tracker/summary', { params: { companyId, period: periods[new Date().getMonth() >= 3 ? new Date().getMonth() - 3 : new Date().getMonth() + 9] } }),
    ]).then(([statusRes, summaryRes]) => {
      setItems(statusRes.data.items || []);
      setStatusMap(statusRes.data.statuses || {});
      setSummary(summaryRes.data || {});
    }).catch(() => {}).finally(() => setLoading(false));
  }, [companyId, trackerType]);

  useEffect(() => { loadData(); }, [loadData]);

  const updateStatus = (itemId: number, periodKey: string, status: string) => {
    if (!companyId) return;
    api.put('/vcfo/tracker/status', {
      item_id: itemId, company_id: parseInt(companyId), period_key: periodKey, status,
    }).then(() => {
      setStatusMap(prev => {
        const next = { ...prev };
        if (!next[itemId]) next[itemId] = {};
        next[itemId] = { ...next[itemId], [periodKey]: { ...next[itemId]?.[periodKey], status } as TrackerStatus };
        return next;
      });
    }).catch(() => {});
  };

  const seedDefaults = () => {
    setSeeding(true);
    api.post('/vcfo/tracker/seed', { tracker_type: trackerType })
      .then(() => loadData())
      .catch(() => {})
      .finally(() => setSeeding(false));
  };

  const addItem = () => {
    if (!newItemName.trim()) return;
    api.post('/vcfo/tracker/items', {
      tracker_type: trackerType, name: newItemName.trim(),
      category: newItemCategory.trim(), frequency: newItemFrequency,
    }).then(() => {
      setNewItemName('');
      setNewItemCategory('');
      setShowAddItem(false);
      loadData();
    }).catch(() => {});
  };

  const getStatusBadge = (itemId: number, periodKey: string) => {
    const s = statusMap[itemId]?.[periodKey]?.status || 'pending';
    const opt = statusOptions.find(o => o.value === s) || statusOptions[0];
    return opt;
  };

  const totalItems = items.length;
  const completedCount = summary.completed || 0;
  const overdueCount = summary.overdue || 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-theme-heading flex items-center gap-2">
            <ClipboardCheck size={22} className="text-accent-400" />
            vCFO Tracker
          </h1>
          <p className="text-sm text-theme-muted mt-0.5">Compliance, Accounting & Internal Control tracking</p>
        </div>
      </div>

      {/* Filters & Controls */}
      <div className="bg-dark-700 rounded-xl p-4 border border-dark-400/30">
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label className="block text-xs text-theme-muted mb-1">Company</label>
            <select value={companyId} onChange={e => setCompanyId(e.target.value)}
              className="bg-dark-600 text-theme-primary text-sm rounded-lg px-3 py-2 border border-dark-400/30 min-w-[180px]">
              {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="flex gap-1">
            {trackerTypes.map(t => (
              <button key={t.key} onClick={() => setTrackerType(t.key)}
                className={`px-3 py-2 text-xs font-medium rounded-lg transition-colors ${trackerType === t.key ? 'bg-accent-500 text-white' : 'bg-dark-600 text-theme-muted hover:text-theme-primary'}`}>
                {t.label}
              </button>
            ))}
          </div>
          <div className="ml-auto flex gap-2">
            <button onClick={() => setShowAddItem(!showAddItem)}
              className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-dark-600 text-theme-primary rounded-lg hover:bg-dark-500 transition-colors">
              <Plus size={14} /> Add Item
            </button>
            {items.length === 0 && (
              <button onClick={seedDefaults} disabled={seeding}
                className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-accent-500/20 text-accent-400 rounded-lg hover:bg-accent-500/30 transition-colors disabled:opacity-50">
                <Sprout size={14} /> {seeding ? 'Seeding...' : 'Seed Defaults'}
              </button>
            )}
          </div>
        </div>

        {/* Add Item Form */}
        {showAddItem && (
          <div className="mt-4 pt-4 border-t border-dark-400/30 flex flex-wrap items-end gap-3">
            <div>
              <label className="block text-xs text-theme-muted mb-1">Name</label>
              <input value={newItemName} onChange={e => setNewItemName(e.target.value)} placeholder="Item name"
                className="bg-dark-600 text-theme-primary text-sm rounded-lg px-3 py-2 border border-dark-400/30 w-52" />
            </div>
            <div>
              <label className="block text-xs text-theme-muted mb-1">Category</label>
              <input value={newItemCategory} onChange={e => setNewItemCategory(e.target.value)} placeholder="Category"
                className="bg-dark-600 text-theme-primary text-sm rounded-lg px-3 py-2 border border-dark-400/30 w-36" />
            </div>
            <div>
              <label className="block text-xs text-theme-muted mb-1">Frequency</label>
              <select value={newItemFrequency} onChange={e => setNewItemFrequency(e.target.value)}
                className="bg-dark-600 text-theme-primary text-sm rounded-lg px-3 py-2 border border-dark-400/30">
                <option value="monthly">Monthly</option>
                <option value="quarterly">Quarterly</option>
                <option value="half_yearly">Half Yearly</option>
                <option value="annual">Annual</option>
              </select>
            </div>
            <button onClick={addItem}
              className="px-4 py-2 text-xs font-medium bg-accent-500 text-white rounded-lg hover:bg-accent-600 transition-colors">
              Add
            </button>
          </div>
        )}
      </div>

      {/* Summary Stats */}
      <div className="grid grid-cols-3 md:grid-cols-5 gap-3">
        {statusOptions.map(opt => (
          <div key={opt.value} className="bg-dark-700 rounded-xl p-3 border border-dark-400/30 text-center">
            <div className="text-lg font-bold text-theme-heading">{summary[opt.value] || 0}</div>
            <div className={`text-[10px] font-medium ${opt.color.split(' ')[0]}`}>{opt.label}</div>
          </div>
        ))}
      </div>

      {loading && (
        <div className="flex justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent-400"></div>
        </div>
      )}

      {/* Tracker Grid */}
      {!loading && items.length > 0 && (
        <div className="bg-dark-700 rounded-xl border border-dark-400/30 overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-dark-400/30">
                <th className="text-left px-4 py-3 text-theme-muted font-medium sticky left-0 bg-dark-700 z-10 min-w-[200px]">Item</th>
                <th className="text-left px-2 py-3 text-theme-muted font-medium w-20">Category</th>
                {periods.map(pk => (
                  <th key={pk} className="text-center px-1 py-3 text-theme-muted font-medium w-14">{shortMonth(pk)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map(item => (
                <tr key={item.id} className="border-b border-dark-400/10 hover:bg-dark-600/20">
                  <td className="px-4 py-2 text-theme-primary font-medium sticky left-0 bg-dark-700 z-10">{item.name}</td>
                  <td className="px-2 py-2 text-theme-faint truncate">{item.category}</td>
                  {periods.map(pk => {
                    const badge = getStatusBadge(item.id, pk);
                    const Icon = badge.icon;
                    return (
                      <td key={pk} className="px-1 py-1 text-center">
                        <div className="relative group">
                          <button
                            className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${badge.color}`}
                            title={`${item.name} - ${shortMonth(pk)}: ${badge.label}`}
                          >
                            <Icon size={14} />
                          </button>
                          {/* Status dropdown on hover */}
                          <div className="hidden group-hover:block absolute top-full left-1/2 -translate-x-1/2 z-50 bg-dark-800 border border-dark-400/30 rounded-lg shadow-xl p-1 mt-1 min-w-[120px]">
                            {statusOptions.map(opt => (
                              <button key={opt.value}
                                onClick={() => updateStatus(item.id, pk, opt.value)}
                                className={`w-full text-left px-2 py-1.5 text-xs rounded flex items-center gap-2 hover:bg-dark-600 transition-colors ${opt.color.split(' ')[0]}`}>
                                <opt.icon size={12} />
                                {opt.label}
                              </button>
                            ))}
                          </div>
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!loading && items.length === 0 && (
        <div className="text-center py-12 text-theme-muted text-sm">
          <ClipboardCheck size={32} className="mx-auto mb-3 text-theme-faint" />
          No tracker items found. Click "Seed Defaults" to add standard {trackerType.replace('_', ' ')} items.
        </div>
      )}
    </div>
  );
}
