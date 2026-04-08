/**
 * VCFO Tracker — Matches TallyVision's VCFO panel
 * Sub-tabs (Compliance/Accounting/Internal Control), summary cards, table
 */
import { useState, useEffect, useCallback } from 'react';
import { Plus, Sprout } from 'lucide-react';
import api from '../../api/client';

interface TrackerItem {
  id: number;
  tracker_type: string;
  name: string;
  category: string;
  frequency: string;
  sort_order: number;
}

type TrackerType = 'compliance' | 'accounting' | 'internal_control';

const trackerTypes: { key: TrackerType; label: string }[] = [
  { key: 'compliance', label: 'Compliance' },
  { key: 'accounting', label: 'Accounting' },
  { key: 'internal_control', label: 'Internal Control' },
];

const statusOpts = ['pending', 'in_progress', 'completed', 'overdue', 'not_applicable'];
const statusLabels: Record<string, string> = {
  pending: 'Pending', in_progress: 'In Progress', completed: 'Completed',
  overdue: 'Overdue', not_applicable: 'N/A',
};

function generatePeriodKeys(): string[] {
  const now = new Date();
  const fyStartYear = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  const periods: string[] = [];
  for (let m = 0; m < 12; m++) {
    const month = 3 + m;
    const year = month >= 12 ? fyStartYear + 1 : fyStartYear;
    const actualMonth = month >= 12 ? month - 12 : month;
    const d = new Date(year, actualMonth, 1);
    periods.push(d.toISOString().slice(0, 7));
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
  const [statusMap, setStatusMap] = useState<Record<number, Record<string, any>>>({});
  const [loading, setLoading] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [summary, setSummary] = useState<Record<string, number>>({});
  const [filterStatus, setFilterStatus] = useState<string>('');
  const [filterCategory, setFilterCategory] = useState<string>('');
  const [showAddItem, setShowAddItem] = useState(false);
  const [newItemName, setNewItemName] = useState('');
  const [newItemCategory, setNewItemCategory] = useState('');
  const [newItemFrequency, setNewItemFrequency] = useState('monthly');

  const periods = generatePeriodKeys();

  useEffect(() => {
    api.get('/vcfo/companies').then(r => {
      setCompanies(r.data || []);
      if (r.data?.length > 0) setCompanyId(String(r.data[0].id));
    }).catch(() => {});
  }, []);

  const loadData = useCallback(() => {
    if (!companyId) return;
    setLoading(true);
    const params: any = { type: trackerType, companyId, periodFrom: periods[0], periodTo: periods[periods.length - 1] };

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
        next[itemId] = { ...next[itemId], [periodKey]: { ...next[itemId]?.[periodKey], status } };
        return next;
      });
    }).catch(() => {});
  };

  const seedDefaults = () => {
    setSeeding(true);
    api.post('/vcfo/tracker/seed', { tracker_type: trackerType })
      .then(() => loadData())
      .finally(() => setSeeding(false));
  };

  const addItem = () => {
    if (!newItemName.trim()) return;
    api.post('/vcfo/tracker/items', {
      tracker_type: trackerType, name: newItemName.trim(),
      category: newItemCategory.trim(), frequency: newItemFrequency,
    }).then(() => {
      setNewItemName(''); setNewItemCategory(''); setShowAddItem(false);
      loadData();
    }).catch(() => {});
  };

  const categories = [...new Set(items.map(i => i.category).filter(Boolean))];
  const filteredItems = items.filter(i => {
    if (filterCategory && i.category !== filterCategory) return false;
    return true;
  });

  return (
    <div className="space-y-5">
      {/* ── Toolbar Card ────────────────────────────────────── */}
      <div className="card-tv p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-lg font-bold text-theme-heading">VCFO Tracker</h1>
            <p className="text-xs text-theme-faint mt-0.5">Compliance, Accounting & Internal Control tracking</p>
          </div>
          <div className="flex items-center gap-3">
            <select value={companyId} onChange={e => setCompanyId(e.target.value)} className="tv-input min-w-[160px]">
              {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        </div>
      </div>

      {/* ── Sub-tabs ────────────────────────────────────────── */}
      <div className="flex gap-1">
        {trackerTypes.map(t => (
          <button key={t.key} onClick={() => setTrackerType(t.key)}
            className={`tv-tab ${trackerType === t.key ? 'active' : ''}`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Summary Cards ───────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {statusOpts.map(s => (
          <div key={s} className="card-tv p-4 text-center">
            <div className="text-2xl font-bold text-theme-heading">{summary[s] || 0}</div>
            <div className="mt-1">
              <span className={`tv-status-badge ${s}`}>{statusLabels[s]}</span>
            </div>
          </div>
        ))}
      </div>

      {/* ── Filters + Actions ───────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3">
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className="tv-input">
          <option value="">All Statuses</option>
          {statusOpts.map(s => <option key={s} value={s}>{statusLabels[s]}</option>)}
        </select>
        <select value={filterCategory} onChange={e => setFilterCategory(e.target.value)} className="tv-input">
          <option value="">All Categories</option>
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <div className="ml-auto flex gap-2">
          <button onClick={() => setShowAddItem(!showAddItem)}
            className="tv-tab flex items-center gap-1.5"><Plus size={13} /> Add Item</button>
          {items.length === 0 && (
            <button onClick={seedDefaults} disabled={seeding}
              className="tv-tab active flex items-center gap-1.5"><Sprout size={13} /> {seeding ? 'Seeding...' : 'Seed Defaults'}</button>
          )}
        </div>
      </div>

      {/* ── Add Item Form ───────────────────────────────────── */}
      {showAddItem && (
        <div className="card-tv p-5">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-theme-faint mb-1">Name</label>
              <input value={newItemName} onChange={e => setNewItemName(e.target.value)} placeholder="Item name" className="tv-input w-52" />
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-theme-faint mb-1">Category</label>
              <input value={newItemCategory} onChange={e => setNewItemCategory(e.target.value)} placeholder="Category" className="tv-input w-36" />
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-theme-faint mb-1">Frequency</label>
              <select value={newItemFrequency} onChange={e => setNewItemFrequency(e.target.value)} className="tv-input">
                <option value="monthly">Monthly</option>
                <option value="quarterly">Quarterly</option>
                <option value="half_yearly">Half Yearly</option>
                <option value="annual">Annual</option>
              </select>
            </div>
            <button onClick={addItem} className="tv-tab active">Add</button>
          </div>
        </div>
      )}

      {loading && (
        <div className="flex justify-center py-16">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-indigo-500" />
        </div>
      )}

      {/* ── Tracker Grid Table ──────────────────────────────── */}
      {!loading && filteredItems.length > 0 && (
        <div className="card-tv overflow-x-auto">
          <table className="tv-table">
            <thead>
              <tr>
                <th className="sticky left-0 z-10 min-w-[200px]" style={{ backgroundColor: 'rgb(var(--c-dark-600))' }}>Action Item</th>
                <th className="w-24">Category</th>
                <th className="w-20">Frequency</th>
                {periods.map(pk => (
                  <th key={pk} className="text-center w-16">{shortMonth(pk)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredItems.map(item => (
                <tr key={item.id}>
                  <td className="font-medium sticky left-0 z-10" style={{ backgroundColor: 'rgb(var(--c-dark-700))' }}>{item.name}</td>
                  <td className="text-theme-faint">{item.category}</td>
                  <td className="text-theme-faint capitalize">{item.frequency?.replace('_', ' ')}</td>
                  {periods.map(pk => {
                    const s = statusMap[item.id]?.[pk]?.status || 'pending';
                    return (
                      <td key={pk} className="text-center !px-1">
                        <select value={s} onChange={e => updateStatus(item.id, pk, e.target.value)}
                          className={`tv-status-badge ${s} cursor-pointer border-0 text-center w-full appearance-none`}
                          style={{ fontSize: '9px', padding: '4px 2px' }}>
                          {statusOpts.map(opt => (
                            <option key={opt} value={opt}>{statusLabels[opt]}</option>
                          ))}
                        </select>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!loading && filteredItems.length === 0 && (
        <div className="card-tv p-12 text-center">
          <p className="text-theme-faint text-sm">No tracker items found. Click "Seed Defaults" to add standard {trackerType.replace('_', ' ')} items.</p>
        </div>
      )}
    </div>
  );
}
