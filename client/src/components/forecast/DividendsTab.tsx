import { useState, useMemo } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer
} from 'recharts';
import {
  Plus, FileDown, GripVertical, HelpCircle, X, StickyNote
} from 'lucide-react';
import api from '../../api/client';
import { Scenario, ForecastItem, getMonthLabel, formatRs } from '../../pages/ForecastModulePage';
import ItemEditForm from './ItemEditForm';
import ItemRowMenu from './ItemRowMenu';
import { exportTableCSV } from './csvExport';

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

export default function DividendsTab({ category, label, scenario, months, viewMode, items, allItems, allValues, settings, onReload, readOnly }: Props) {
  const [editingItem, setEditingItem] = useState<ForecastItem | null>(null);
  const [showInlineAdd, setShowInlineAdd] = useState(false);
  const [inlineAddName, setInlineAddName] = useState('');

  // Monthly totals
  const monthlyTotals: Record<string, number> = {};
  months.forEach(m => {
    monthlyTotals[m] = items.reduce((sum, item) => sum + (allValues[item.id]?.[m] || 0), 0);
  });
  const grandTotal = Object.values(monthlyTotals).reduce((s, v) => s + v, 0);

  // Chart data
  const chartData = useMemo(() =>
    months.map(m => ({ month: getMonthLabel(m), total: monthlyTotals[m] || 0 })),
  [months, monthlyTotals]);

  // Yearly aggregation
  const yearlyData = useMemo(() => {
    if (viewMode !== 'yearly') return {};
    const years: Record<string, string[]> = {};
    months.forEach(m => {
      const [y] = m.split('-');
      const fy = parseInt(m.split('-')[1]) >= 4 ? y : String(parseInt(y) - 1);
      const yearKey = `FY${fy}`;
      if (!years[yearKey]) years[yearKey] = [];
      years[yearKey].push(m);
    });
    return years;
  }, [months, viewMode]);
  const yearKeys = Object.keys(yearlyData);
  const displayCols = viewMode === 'yearly' ? yearKeys : months;

  const getColVal = (itemId: number, col: string): number => {
    if (viewMode === 'yearly') {
      return (yearlyData[col] || []).reduce((s, m) => s + (allValues[itemId]?.[m] || 0), 0);
    }
    return allValues[itemId]?.[col] || 0;
  };

  const getColTotal = (col: string): number => {
    if (viewMode === 'yearly') {
      return (yearlyData[col] || []).reduce((s, m) => s + (monthlyTotals[m] || 0), 0);
    }
    return monthlyTotals[col] || 0;
  };

  // Add new dividend
  const handleAdd = async () => {
    if (!scenario) return;
    const res = await api.post('/forecast-module/items', {
      scenario_id: scenario.id,
      category: 'dividends',
      name: 'New Dividend',
      item_type: 'dividend',
      entry_mode: 'varying',
      start_month: months[0],
    });
    await onReload();
    if (res.data?.id) setEditingItem(res.data);
  };

  const handleDuplicate = async (item: ForecastItem) => {
    if (!scenario) return;
    const res = await api.post('/forecast-module/items', {
      scenario_id: scenario.id,
      category: 'dividends',
      name: `${item.name} (Copy)`,
      item_type: item.item_type,
      entry_mode: item.entry_mode,
      constant_amount: item.constant_amount,
      constant_period: item.constant_period,
      start_month: item.start_month,
      meta: item.meta,
    });
    const vals = allValues[item.id];
    if (vals && Object.keys(vals).length > 0) {
      await api.post('/forecast-module/values', {
        item_id: res.data.id,
        values: Object.entries(vals).map(([month, amount]) => ({ month, amount })),
      });
    }
    await onReload();
  };

  const handleInlineAdd = async () => {
    if (!inlineAddName.trim() || !scenario) return;
    const res = await api.post('/forecast-module/items', {
      scenario_id: scenario.id,
      category: 'dividends',
      name: inlineAddName.trim(),
      item_type: 'dividend',
      entry_mode: 'varying',
      start_month: months[0],
    });
    setShowInlineAdd(false);
    setInlineAddName('');
    await onReload();
    if (res.data?.id) setEditingItem(res.data);
  };

  // ─── Editing view → delegate to ItemEditForm ───
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

  // ─── Listing view ───
  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-bold text-theme-heading">{label}</h2>
          <span className="text-xs px-2.5 py-1 rounded-full bg-amber-500/10 text-amber-400 font-medium cursor-pointer">
            In Progress
          </span>
        </div>
        <div className="flex items-center gap-2">
          {items.length > 0 && (
            <button
              onClick={() => exportTableCSV(items, allValues, months, viewMode, category, label)}
              className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-theme-faint hover:text-theme-secondary hover:bg-dark-500 rounded-lg transition-colors border border-dark-400/50"
              title="Download table as CSV"
            >
              <FileDown size={14} /> CSV
            </button>
          )}
          <button
            className="p-2 rounded-lg border border-dark-400/50 text-theme-faint hover:text-theme-secondary hover:bg-dark-600 transition-colors"
            title="Help"
          >
            <HelpCircle size={14} />
          </button>
          {!readOnly && (
            <button
              onClick={handleAdd}
              className="btn-primary flex items-center gap-2 text-sm"
            >
              <Plus size={16} />
              Add Dividend
            </button>
          )}
        </div>
      </div>

      {/* Chart */}
      {items.length > 0 && (
        <div className="card mb-4">
          <h3 className="text-sm font-semibold text-theme-muted mb-3">Dividends Totals</h3>
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData}>
                <defs>
                  <linearGradient id="gradDividends" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#1a1a28" />
                <XAxis dataKey="month" tick={{ fontSize: 11 }} stroke="#94a3b8" />
                <YAxis tick={{ fontSize: 11 }} stroke="#94a3b8" tickFormatter={v => `Rs${(v / 1000).toFixed(0)}k`} />
                <Tooltip
                  formatter={(value: number) => [formatRs(value), 'Total']}
                  contentStyle={{ borderRadius: 8, fontSize: 12, backgroundColor: '#14141f', borderColor: '#2a2a3d', color: '#e2e8f0' }}
                />
                <Area
                  type="monotone"
                  dataKey="total"
                  stroke="#6366f1"
                  strokeWidth={2}
                  strokeDasharray="5 3"
                  fill="url(#gradDividends)"
                  dot={{ r: 3, fill: 'transparent', stroke: '#6366f1', strokeWidth: 2 }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <div className="flex items-center gap-4 mt-2 text-xs text-theme-faint">
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-0.5 inline-block" style={{ borderTop: '2px dashed #6366f1' }} /> Forecast
            </span>
          </div>
        </div>
      )}

      {/* Data Table */}
      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm" style={{ minWidth: displayCols.length * 100 + 300 }}>
          <thead>
            <tr className="border-b border-dark-400/50 bg-dark-600">
              <th className="text-left py-3 px-4 font-semibold text-theme-muted sticky left-0 bg-dark-600 z-10 min-w-[240px]">
                <div className="flex items-center gap-2">
                  <span>Dividends</span>
                  <button className="text-xs text-theme-muted hover:text-theme-secondary border border-dark-400 rounded px-2 py-0.5">
                    Reorder
                  </button>
                </div>
              </th>
              {viewMode === 'yearly' && (
                <th className="text-right py-1 px-3 min-w-[100px]">
                  <span className="text-[9px] font-medium text-accent-400 bg-accent-500/10 px-1.5 py-0.5 rounded">Forecast →</span>
                </th>
              )}
              {displayCols.map(c => (
                <th key={c} className="text-right py-3 px-3 font-semibold text-theme-muted whitespace-nowrap min-w-[100px]">
                  {viewMode === 'yearly' ? c : getMonthLabel(c)}
                </th>
              ))}
              <th className="text-right py-3 px-4 font-semibold text-theme-muted bg-dark-500 min-w-[120px]">Total</th>
            </tr>
          </thead>
          <tbody>
            {items.map(item => {
              const rowTotal = displayCols.reduce((sum, c) => sum + getColVal(item.id, c), 0);
              return (
                <tr key={item.id} className="border-b border-dark-400/30 hover:bg-dark-600 group">
                  <td className="py-2.5 px-4 sticky left-0 bg-dark-700 z-10 group-hover:bg-dark-600">
                    <div className="flex items-center gap-2">
                      {!readOnly && <GripVertical size={14} className="text-theme-secondary cursor-grab opacity-0 group-hover:opacity-100" />}
                      {readOnly ? (
                        <span className="text-theme-secondary font-medium">{item.name}</span>
                      ) : (
                        <button
                          onClick={() => setEditingItem(item)}
                          className="text-accent-400 hover:text-accent-300 font-medium hover:underline text-left"
                        >
                          {item.name}
                        </button>
                      )}
                      {item.meta?.stepEntryModes?.dividend && (
                        <span className="text-[10px] text-theme-faint bg-dark-500 px-1.5 py-0.5 rounded">
                          {item.meta.stepEntryModes.dividend === 'one_time' ? 'One-time'
                            : item.meta.stepEntryModes.dividend === 'constant' ? 'Constant'
                            : item.meta.stepEntryModes.dividend === 'pct_net_profit' ? '% Profit'
                            : 'Varying'}
                        </span>
                      )}
                      {item.meta?.note && (
                        <span title={item.meta.note}><StickyNote size={12} className="text-amber-400 shrink-0" /></span>
                      )}
                      {!readOnly && (
                        <div className="relative ml-auto">
                          <ItemRowMenu
                            item={item}
                            items={items}
                            category={category}
                            allValues={allValues}
                            onEdit={() => setEditingItem(item)}
                            onDuplicate={() => handleDuplicate(item)}
                            onReload={onReload}
                          />
                        </div>
                      )}
                    </div>
                  </td>
                  {viewMode === 'yearly' && <td />}
                  {displayCols.map(c => {
                    const val = getColVal(item.id, c);
                    return (
                      <td key={c} className="text-right py-2.5 px-3 text-theme-secondary tabular-nums">
                        {val ? formatRs(val) : <span className="text-theme-secondary">-</span>}
                      </td>
                    );
                  })}
                  <td className="text-right py-2.5 px-4 font-semibold text-theme-heading bg-dark-600 tabular-nums">
                    {formatRs(rowTotal)}
                  </td>
                </tr>
              );
            })}

            {/* Add new row */}
            {!readOnly && (
              <tr className="border-b border-dark-400/30">
                <td className="py-2.5 px-4 sticky left-0 bg-dark-700 z-10" colSpan={displayCols.length + (viewMode === 'yearly' ? 3 : 2)}>
                  {showInlineAdd ? (
                    <div className="flex items-center gap-2">
                      <div className="flex items-center border border-dark-400 rounded-lg overflow-hidden">
                        <input
                          autoFocus
                          value={inlineAddName}
                          onChange={e => setInlineAddName(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === 'Enter' && inlineAddName.trim()) handleInlineAdd();
                            if (e.key === 'Escape') { setShowInlineAdd(false); setInlineAddName(''); }
                          }}
                          placeholder="Enter a new forecast item"
                          className="bg-transparent px-3 py-1.5 text-sm text-theme-secondary placeholder:text-theme-faint outline-none w-64"
                        />
                        <button
                          onClick={() => inlineAddName.trim() && handleInlineAdd()}
                          className="px-3 py-1.5 text-xs font-medium text-theme-muted border-l border-dark-400 hover:bg-dark-600 whitespace-nowrap"
                        >
                          Enter to Add
                        </button>
                      </div>
                      <button onClick={() => { setShowInlineAdd(false); setInlineAddName(''); }} className="p-1 text-theme-faint hover:text-theme-secondary">
                        <X size={16} />
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setShowInlineAdd(true)}
                      className="flex items-center gap-2 text-sm text-accent-400 hover:text-accent-300"
                    >
                      <Plus size={14} />
                      Add new dividend
                    </button>
                  )}
                </td>
              </tr>
            )}

            {/* Totals row */}
            <tr className="border-t-2 border-accent-500/30 bg-dark-600 font-semibold">
              <td className="py-3 px-4 text-theme-secondary sticky left-0 bg-dark-600 z-10">Totals</td>
              {viewMode === 'yearly' && <td />}
              {displayCols.map(c => (
                <td key={c} className="text-right py-3 px-3 text-theme-heading tabular-nums">
                  {formatRs(getColTotal(c))}
                </td>
              ))}
              <td className="text-right py-3 px-4 text-theme-heading bg-dark-500 tabular-nums">
                {formatRs(grandTotal)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

    </div>
  );
}
