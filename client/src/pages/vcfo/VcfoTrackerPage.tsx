/**
 * VCFO Tracker — Exact replica of TallyVision's VCFO panel
 * Task/Category/Frequency/Status Overview table with expandable rows
 * Period selector (Monthly/Apr 2026), summary cards
 */
import { useState, useEffect, useCallback } from 'react';
import { Plus, Sprout, ChevronRight, ChevronDown, Trash2 } from 'lucide-react';
import api from '../../api/client';

interface TrackerItem {
  id: number; tracker_type: string; name: string; category: string;
  frequency: string; sort_order: number;
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
const freqLabels: Record<string, string> = {
  monthly: 'Monthly', quarterly: 'Quarterly', half_yearly: 'Half Yearly',
  annual: 'Annual', one_time: 'One Time',
};

function generatePeriodKeys(): string[] {
  const now = new Date();
  const fyStartYear = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  const periods: string[] = [];
  for (let m = 0; m < 12; m++) {
    const month = 3 + m;
    const year = month >= 12 ? fyStartYear + 1 : fyStartYear;
    const actualMonth = month >= 12 ? month - 12 : month;
    periods.push(new Date(year, actualMonth, 1).toISOString().slice(0, 7));
  }
  return periods;
}

function getMonthOptions(): { value: string; label: string }[] {
  const periods = generatePeriodKeys();
  return periods.map(pk => ({
    value: pk,
    label: new Date(pk + '-01').toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }),
  }));
}

export default function VcfoTrackerPage() {
  const [companies, setCompanies] = useState<any[]>([]);
  const [companyId, setCompanyId] = useState<string>('');
  const [trackerType, setTrackerType] = useState<TrackerType>('compliance');
  const [items, setItems] = useState<TrackerItem[]>([]);
  const [statusMap, setStatusMap] = useState<Record<number, Record<string, any>>>({});
  const [loading, setLoading] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [filterStatus, setFilterStatus] = useState<string>('');
  const [filterCategory, setFilterCategory] = useState<string>('');
  const [periodType, setPeriodType] = useState<string>('monthly');
  const [selectedPeriod, setSelectedPeriod] = useState<string>('');
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set());
  const [showAddItem, setShowAddItem] = useState(false);
  const [newItemName, setNewItemName] = useState('');
  const [newItemCategory, setNewItemCategory] = useState('');
  const [newItemFrequency, setNewItemFrequency] = useState('monthly');

  const periods = generatePeriodKeys();
  const monthOptions = getMonthOptions();

  // Set default period to current month
  useEffect(() => {
    const now = new Date();
    setSelectedPeriod(now.toISOString().slice(0, 7));
  }, []);

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
    api.get('/vcfo/tracker/status', { params })
      .then(r => { setItems(r.data.items || []); setStatusMap(r.data.statuses || {}); })
      .catch(() => {}).finally(() => setLoading(false));
  }, [companyId, trackerType]);

  useEffect(() => { loadData(); }, [loadData]);

  const updateStatus = (itemId: number, periodKey: string, status: string) => {
    if (!companyId) return;
    api.put('/vcfo/tracker/status', { item_id: itemId, company_id: parseInt(companyId), period_key: periodKey, status })
      .then(() => {
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
    api.post('/vcfo/tracker/seed', { tracker_type: trackerType }).then(() => loadData()).finally(() => setSeeding(false));
  };

  const addItem = () => {
    if (!newItemName.trim()) return;
    api.post('/vcfo/tracker/items', { tracker_type: trackerType, name: newItemName.trim(), category: newItemCategory.trim(), frequency: newItemFrequency })
      .then(() => { setNewItemName(''); setNewItemCategory(''); setShowAddItem(false); loadData(); }).catch(() => {});
  };

  const deleteItem = (id: number) => {
    api.delete(`/vcfo/tracker/items/${id}`).then(() => loadData()).catch(() => {});
  };

  const toggleRow = (id: number) => {
    setExpandedRows(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };

  // Compute status overview per item
  const getStatusOverview = (itemId: number) => {
    const itemStatuses = statusMap[itemId] || {};
    let total = periods.length;
    let completed = 0;
    for (const pk of periods) {
      if (itemStatuses[pk]?.status === 'completed') completed++;
    }
    return { completed, total };
  };

  const categories = [...new Set(items.map(i => i.category).filter(Boolean))];
  const filteredItems = items.filter(i => {
    if (filterCategory && i.category !== filterCategory) return false;
    if (filterStatus) {
      const s = statusMap[i.id]?.[selectedPeriod]?.status || 'pending';
      if (s !== filterStatus) return false;
    }
    return true;
  });

  // Summary counts
  const totalTasks = filteredItems.length * periods.length;
  const completedCount = filteredItems.reduce((sum, item) => {
    const s = statusMap[item.id] || {};
    return sum + periods.filter(pk => s[pk]?.status === 'completed').length;
  }, 0);
  const pendingCount = filteredItems.reduce((sum, item) => {
    const s = statusMap[item.id] || {};
    return sum + periods.filter(pk => !s[pk]?.status || s[pk]?.status === 'pending').length;
  }, 0);
  const overdueCount = filteredItems.reduce((sum, item) => {
    const s = statusMap[item.id] || {};
    return sum + periods.filter(pk => s[pk]?.status === 'overdue').length;
  }, 0);

  return (
    <div className="space-y-5">
      {/* ── Toolbar ─────────────────────────────────────────── */}
      <div className="card-tv p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h1 className="text-lg font-bold text-theme-heading">VCFO Tracker</h1>
          <div className="flex items-center gap-3">
            <span className="text-xs text-theme-faint">Period</span>
            <select value={periodType} onChange={e => setPeriodType(e.target.value)} className="tv-input">
              <option value="monthly">Monthly</option>
              <option value="quarterly">Quarterly</option>
            </select>
            <select value={selectedPeriod} onChange={e => setSelectedPeriod(e.target.value)} className="tv-input">
              {monthOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
        </div>
      </div>

      {/* ── Sub-tabs ────────────────────────────────────────── */}
      <div className="flex gap-1">
        {trackerTypes.map(t => (
          <button key={t.key} onClick={() => { setTrackerType(t.key); setExpandedRows(new Set()); }}
            className={`tv-tab ${trackerType === t.key ? 'active' : ''}`}>{t.label}</button>
        ))}
      </div>

      {/* ── Summary Cards ───────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="card-tv p-4">
          <p className="kpi-label">TOTAL TASKS</p>
          <p className="text-2xl font-extrabold text-theme-heading">{totalTasks}</p>
        </div>
        <div className="card-tv p-4 border-l-4 border-l-emerald-500">
          <p className="kpi-label">COMPLETED</p>
          <p className="text-2xl font-extrabold text-emerald-500">{completedCount}</p>
        </div>
        <div className="card-tv p-4 border-l-4 border-l-amber-500">
          <p className="kpi-label">PENDING</p>
          <p className="text-2xl font-extrabold text-amber-500">{pendingCount}</p>
        </div>
        <div className="card-tv p-4 border-l-4 border-l-red-500">
          <p className="kpi-label">OVERDUE</p>
          <p className="text-2xl font-extrabold text-red-500">{overdueCount}</p>
        </div>
      </div>

      {/* ── Filters + Actions ───────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3">
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className="tv-input">
          <option value="">All Status</option>
          {statusOpts.map(s => <option key={s} value={s}>{statusLabels[s]}</option>)}
        </select>
        <select value={filterCategory} onChange={e => setFilterCategory(e.target.value)} className="tv-input">
          <option value="">All Categories</option>
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <div className="ml-auto flex gap-2">
          {items.length === 0 && (
            <button onClick={seedDefaults} disabled={seeding}
              className="tv-tab active flex items-center gap-1.5"><Sprout size={13} /> {seeding ? 'Seeding...' : 'Seed Defaults'}</button>
          )}
          <button onClick={() => setShowAddItem(!showAddItem)}
            className="tv-tab active flex items-center gap-1.5"><Plus size={13} /> Add Item</button>
        </div>
      </div>

      {/* ── Add Item Form ───────────────────────────────────── */}
      {showAddItem && (
        <div className="card-tv p-5">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="kpi-label" style={{ marginBottom: 4 }}>Name</label>
              <input value={newItemName} onChange={e => setNewItemName(e.target.value)} placeholder="Item name" className="tv-input w-52" />
            </div>
            <div>
              <label className="kpi-label" style={{ marginBottom: 4 }}>Category</label>
              <input value={newItemCategory} onChange={e => setNewItemCategory(e.target.value)} placeholder="Category" className="tv-input w-36" />
            </div>
            <div>
              <label className="kpi-label" style={{ marginBottom: 4 }}>Frequency</label>
              <select value={newItemFrequency} onChange={e => setNewItemFrequency(e.target.value)} className="tv-input">
                {Object.entries(freqLabels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
            <button onClick={addItem} className="tv-tab active">Add</button>
          </div>
        </div>
      )}

      {loading && <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-10 w-10 border-b-2 border-indigo-500" /></div>}

      {/* ── Tracker Table ───────────────────────────────────── */}
      {!loading && filteredItems.length > 0 && (
        <div className="card-tv overflow-x-auto">
          <table className="tv-table">
            <thead>
              <tr>
                <th style={{ width: 30 }}></th>
                <th>TASK</th>
                <th>CATEGORY</th>
                <th>FREQUENCY</th>
                <th>STATUS OVERVIEW</th>
                <th style={{ width: 60 }}></th>
              </tr>
            </thead>
            <tbody>
              {filteredItems.map(item => {
                const isExpanded = expandedRows.has(item.id);
                const { completed, total } = getStatusOverview(item.id);
                const pct = total > 0 ? (completed / total) * 100 : 0;

                return (
                  <React.Fragment key={item.id}>
                    {/* Main row */}
                    <tr className="cursor-pointer" onClick={() => toggleRow(item.id)}>
                      <td className="text-theme-faint text-center">
                        {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </td>
                      <td className="font-semibold">{item.name}</td>
                      <td className="text-theme-faint" style={{ fontSize: '0.72rem' }}>{item.category}</td>
                      <td className="text-theme-faint" style={{ fontSize: '0.72rem' }}>{freqLabels[item.frequency] || item.frequency}</td>
                      <td>
                        <div className="flex items-center gap-2" style={{ maxWidth: 120 }}>
                          <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: 'rgb(var(--c-dark-600))' }}>
                            <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: pct === 100 ? '#059669' : '#3b82f6' }} />
                          </div>
                          <span className="text-theme-faint" style={{ fontSize: '0.72rem' }}>{completed}/{total}</span>
                        </div>
                      </td>
                      <td className="text-center" onClick={e => e.stopPropagation()}>
                        <button onClick={() => deleteItem(item.id)} className="text-theme-faint hover:text-red-400 transition-colors">
                          <Trash2 size={13} />
                        </button>
                      </td>
                    </tr>

                    {/* Expanded drilldown — per-period rows */}
                    {isExpanded && periods.map(pk => {
                      const s = statusMap[item.id]?.[pk]?.status || 'pending';
                      const monthLabel = new Date(pk + '-01').toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
                      return (
                        <tr key={pk} style={{ backgroundColor: 'rgb(var(--c-dark-600) / 0.3)' }}>
                          <td></td>
                          <td colSpan={2} className="text-theme-muted" style={{ paddingLeft: 32, fontSize: '0.72rem' }}>
                            {monthLabel}
                          </td>
                          <td colSpan={2}>
                            <select value={s} onChange={e => updateStatus(item.id, pk, e.target.value)}
                              className={`tv-status-badge ${s} cursor-pointer border-0`}
                              style={{ fontSize: '10px', padding: '4px 8px' }}>
                              {statusOpts.map(opt => <option key={opt} value={opt}>{statusLabels[opt]}</option>)}
                            </select>
                          </td>
                          <td></td>
                        </tr>
                      );
                    })}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {!loading && filteredItems.length === 0 && (
        <div className="card-tv p-12 text-center text-theme-faint text-sm">
          No tracker items found. Click "Seed Defaults" to add standard {trackerType.replace('_', ' ')} items.
        </div>
      )}
    </div>
  );
}

// Need React import for Fragment
import React from 'react';
