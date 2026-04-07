import { useState, useMemo } from 'react';
import { MoreVertical, Plus, GripVertical } from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import api from '../../api/client';
import { Scenario, ForecastItem, getMonthLabel, formatRs } from '../../pages/ForecastModulePage';
import ItemEditForm from './ItemEditForm';

interface Props {
  category: string;
  label: string;
  scenario: Scenario | null;
  months: string[];
  viewMode: 'monthly' | 'yearly';
  items: ForecastItem[];
  allItems: ForecastItem[];
  allValues: Record<number, Record<string, number>>;
  settings: Record<string, any>;
  onReload: () => Promise<void>;
  readOnly?: boolean;
}

export default function ExpensesTab({ category, label, scenario, months, items, allItems, allValues, onReload, readOnly }: Props) {
  const [editingItem, setEditingItem] = useState<ForecastItem | null>(null);
  const [menuOpenId, setMenuOpenId] = useState<number | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  // Calculate totals per month
  const monthlyTotals = useMemo(() => {
    const totals: Record<string, number> = {};
    months.forEach(m => {
      totals[m] = items.reduce((sum, item) => sum + (allValues[item.id]?.[m] || 0), 0);
    });
    return totals;
  }, [items, allValues, months]);

  const grandTotal = useMemo(() => Object.values(monthlyTotals).reduce((s, v) => s + v, 0), [monthlyTotals]);

  // Chart data
  const chartData = useMemo(() => months.map(m => ({
    month: getMonthLabel(m),
    total: monthlyTotals[m] || 0,
  })), [monthlyTotals, months]);

  const handleAdd = async () => {
    if (!scenario) return;
    try {
      const res = await api.post('/forecast-module/items', {
        scenario_id: scenario.id,
        category,
        name: 'New Expense',
        item_type: 'other',
        entry_mode: 'varying',
        start_month: months[0],
      });
      await onReload();
      if (res.data?.id) {
        setEditingItem(res.data);
      }
    } catch (err) {
      console.error('Failed to add expense:', err);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Delete this item?')) return;
    await api.delete(`/forecast-module/items/${id}`);
    setMenuOpenId(null);
    await onReload();
  };

  const handleDuplicate = async (item: ForecastItem) => {
    if (!scenario) return;
    const res = await api.post('/forecast-module/items', {
      scenario_id: scenario.id,
      category: item.category,
      name: `${item.name} (Copy)`,
      item_type: item.item_type,
      entry_mode: item.entry_mode,
      constant_amount: item.constant_amount,
      constant_period: item.constant_period,
      start_month: item.start_month,
      annual_raise_pct: item.annual_raise_pct,
      meta: item.meta,
    });
    const vals = allValues[item.id];
    if (vals && Object.keys(vals).length > 0) {
      await api.post('/forecast-module/values', {
        item_id: res.data.id,
        values: Object.entries(vals).map(([month, amount]) => ({ month, amount })),
      });
    }
    setMenuOpenId(null);
    await onReload();
  };

  if (editingItem && !readOnly) {
    return (
      <ItemEditForm
        item={editingItem}
        category={category}
        months={months}
        values={allValues[editingItem.id] || {}}
        allItems={allItems}
        allValues={allValues}
        onSave={async () => {
          setEditingItem(null);
          await onReload();
        }}
        onDiscard={() => setEditingItem(null)}
      />
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-bold text-white">{label}</h2>
          <span className="text-xs px-2.5 py-1 rounded-full bg-amber-500/10 text-amber-400 font-medium cursor-pointer">In Progress</span>
        </div>
        {!readOnly && (
          <button
            onClick={handleAdd}
            className="btn-primary flex items-center gap-2 text-sm"
          >
            <Plus size={16} />
            Add Expense
          </button>
        )}
      </div>

      {/* Chart */}
      {items.length > 0 && (
        <div className="card mb-4">
          <h3 className="text-sm font-semibold text-slate-400 mb-3">Expenses Totals</h3>
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData}>
                <defs>
                  <linearGradient id="gradient-expenses" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#0d9488" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#0d9488" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#1a1a28" />
                <XAxis dataKey="month" tick={{ fontSize: 11 }} stroke="#94a3b8" />
                <YAxis tick={{ fontSize: 11 }} stroke="#94a3b8" tickFormatter={v => `Rs${(v / 1000).toFixed(0)}k`} />
                <Tooltip
                  formatter={(value: number) => [formatRs(value), 'Total']}
                  contentStyle={{ borderRadius: 8, borderColor: '#e2e8f0', fontSize: 12 }}
                />
                <Area
                  type="monotone"
                  dataKey="total"
                  stroke="#0d9488"
                  strokeWidth={2}
                  strokeDasharray="5 3"
                  fill="url(#gradient-expenses)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Data Table */}
      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm" style={{ minWidth: months.length * 100 + 300 }}>
          <thead>
            <tr className="border-b border-dark-400/50 bg-dark-600">
              <th className="text-left py-3 px-4 font-semibold text-slate-400 sticky left-0 bg-dark-600 z-10 min-w-[240px]">
                <div className="flex items-center gap-2">
                  <span>{label}</span>
                  <button className="text-xs text-slate-400 hover:text-slate-400 border border-dark-400 rounded px-2 py-0.5">Organize</button>
                </div>
              </th>
              {months.map(m => (
                <th key={m} className="text-right py-3 px-3 font-semibold text-slate-400 whitespace-nowrap min-w-[100px]">
                  {getMonthLabel(m)}
                </th>
              ))}
              <th className="text-right py-3 px-4 font-semibold text-slate-400 bg-dark-500 min-w-[120px]">Total</th>
            </tr>
          </thead>
          <tbody>
            {items.map(item => {
              const itemValues = allValues[item.id] || {};
              const rowTotal = months.reduce((sum, m) => sum + (itemValues[m] || 0), 0);
              return (
                <tr key={item.id} className="border-b border-dark-400/30 hover:bg-dark-600 group">
                  <td className="py-2.5 px-4 sticky left-0 bg-dark-700 z-10 group-hover:bg-dark-600">
                    <div className="flex items-center gap-2">
                      {!readOnly && <GripVertical size={14} className="text-slate-300 cursor-grab opacity-0 group-hover:opacity-100" />}
                      {readOnly ? (
                        <span className="text-slate-300 font-medium text-left">{item.name}</span>
                      ) : (
                        <button
                          onClick={() => setEditingItem(item)}
                          className="text-accent-400 hover:text-accent-300 font-medium hover:underline text-left"
                        >
                          {item.name}
                        </button>
                      )}
                      {!readOnly && (
                        <div className="relative ml-auto">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              if (menuOpenId === item.id) {
                                setMenuOpenId(null);
                              } else {
                                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                                setMenuPos({ top: rect.bottom + 4, left: rect.right - 160 });
                                setMenuOpenId(item.id);
                              }
                            }}
                            className="opacity-0 group-hover:opacity-100 p-1 hover:bg-dark-400 rounded"
                          >
                            <MoreVertical size={14} />
                          </button>
                        </div>
                      )}
                    </div>
                  </td>
                  {months.map(m => (
                    <td key={m} className="text-right py-2.5 px-3 text-slate-300 tabular-nums">
                      {itemValues[m] ? formatRs(itemValues[m]) : <span className="text-slate-300">-</span>}
                    </td>
                  ))}
                  <td className="text-right py-2.5 px-4 font-semibold text-white bg-dark-600 tabular-nums">
                    {formatRs(rowTotal)}
                  </td>
                </tr>
              );
            })}

            {/* Add new expense link */}
            {!readOnly && (
              <tr className="border-b border-dark-400/30">
                <td className="py-2.5 px-4 sticky left-0 bg-dark-700 z-10" colSpan={months.length + 2}>
                  <button
                    onClick={handleAdd}
                    className="flex items-center gap-2 text-sm text-accent-400 hover:text-accent-300"
                  >
                    <Plus size={14} />
                    Add new expense
                  </button>
                </td>
              </tr>
            )}

            {/* Totals row */}
            <tr className="border-t-2 border-primary-200 bg-dark-600 font-semibold">
              <td className="py-3 px-4 text-slate-300 sticky left-0 bg-dark-600 z-10">Totals</td>
              {months.map(m => (
                <td key={m} className="text-right py-3 px-3 text-white tabular-nums">
                  {formatRs(monthlyTotals[m] || 0)}
                </td>
              ))}
              <td className="text-right py-3 px-4 text-slate-900 bg-dark-500 tabular-nums">
                {formatRs(grandTotal)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Fixed-position kebab menu */}
      {menuOpenId !== null && (
        <>
          <div className="fixed inset-0 z-[49]" onClick={() => setMenuOpenId(null)} />
          <div
            className="fixed bg-dark-700 border border-dark-400/50 rounded-lg shadow-lg z-50 w-40"
            style={{ top: menuPos.top, left: menuPos.left }}
          >
            <button onClick={() => { const item = items.find(i => i.id === menuOpenId); if (item) { setEditingItem(item); setMenuOpenId(null); } }} className="w-full text-left px-3 py-2 text-sm hover:bg-dark-600 rounded-t-lg">Edit</button>
            <button onClick={() => { const item = items.find(i => i.id === menuOpenId); if (item) handleDuplicate(item); }} className="w-full text-left px-3 py-2 text-sm hover:bg-dark-600">Duplicate</button>
            <button onClick={() => { if (menuOpenId) handleDelete(menuOpenId); }} className="w-full text-left px-3 py-2 text-sm text-red-400 hover:bg-red-500/10 rounded-b-lg">Delete</button>
          </div>
        </>
      )}
    </div>
  );
}
