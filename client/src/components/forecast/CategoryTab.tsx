import { useState } from 'react';
import { MoreVertical, Plus, GripVertical, FileDown } from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import api from '../../api/client';
import { Scenario, ForecastItem, getMonthLabel, formatRs } from '../../pages/ForecastModulePage';
import ItemEditForm from './ItemEditForm';
import TypeSelectionScreen from './TypeSelectionScreen';
import PersonnelTab from './PersonnelTab';
import ExpensesTab from './ExpensesTab';
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

const CATEGORY_CONFIG: Record<string, { addLabel: string; itemTypes: { value: string; label: string; description: string }[]; showChart: boolean }> = {
  revenue: {
    addLabel: 'Add Revenue Stream',
    itemTypes: [
      { value: 'unit_sales', label: 'Patient-based revenue', description: 'Forecast revenue based on patient counts and per-patient revenue' },
      { value: 'billable_hours', label: 'Billable hours', description: 'Best for services priced on a per-hour basis' },
      { value: 'recurring', label: 'Recurring charges', description: 'Best for subscriptions, memberships, rentals, or other periodic charges' },
      { value: 'revenue_only', label: 'Revenue only', description: 'Best for entering overall revenue values without any detail' },
    ],
    showChart: true,
  },
  direct_costs: {
    addLabel: 'Add Direct Cost',
    itemTypes: [
      { value: 'general_cost', label: 'General Cost', description: 'Best for direct costs that relate to all of your revenue streams' },
      { value: 'specific_cost', label: 'Specific Cost', description: 'For costs that are related to the creation or production of a particular revenue stream' },
    ],
    showChart: true,
  },
  personnel: {
    addLabel: 'Add New',
    itemTypes: [
      { value: 'individual', label: 'Add Personnel', description: 'Add an individual employee or group' },
      { value: 'employee_benefits', label: 'Employee Taxes or Benefits', description: 'Add a burden rate for on-staff employees' },
    ],
    showChart: true,
  },
  expenses: {
    addLabel: 'Add Expense',
    itemTypes: [
      { value: 'other', label: 'Other expense', description: 'General operating expenses' },
    ],
    showChart: true,
  },
  assets: {
    addLabel: 'Add Asset',
    itemTypes: [
      { value: 'long_term', label: 'Long-term asset', description: 'Equipment, vehicles, buildings' },
      { value: 'current', label: 'Current asset', description: 'Assets consumed within 12 months' },
    ],
    showChart: false,
  },
  taxes: {
    addLabel: 'Set Tax Rates',
    itemTypes: [
      { value: 'income_tax', label: 'Income Tax', description: 'Corporate income tax' },
      { value: 'sales_tax', label: 'Sales Tax / GST', description: 'GST or sales tax' },
    ],
    showChart: false,
  },
  dividends: {
    addLabel: 'Add Dividend',
    itemTypes: [{ value: 'dividend', label: 'Dividend', description: 'Dividend payment' }],
    showChart: false,
  },
  cash_flow_assumptions: { addLabel: '', itemTypes: [], showChart: true },
  initial_balances: { addLabel: '', itemTypes: [], showChart: false },
  financing: {
    addLabel: 'Add Financing',
    itemTypes: [
      { value: 'loan', label: 'Loan', description: 'Bank loan or line of credit' },
      { value: 'investment', label: 'Investment', description: 'Equity investment' },
    ],
    showChart: false,
  },
};

export default function CategoryTab({ category, label, scenario, months, viewMode, items, allItems, allValues, settings, onReload, readOnly }: Props) {
  const [editingItem, setEditingItem] = useState<ForecastItem | null>(null);
  const [showTypeSelection, setShowTypeSelection] = useState(false);
  const [showAddType, setShowAddType] = useState(false);
  const [menuOpenId, setMenuOpenId] = useState<number | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  const config = CATEGORY_CONFIG[category] || { addLabel: 'Add', itemTypes: [], showChart: false };

  // Calculate totals per month
  const monthlyTotals: Record<string, number> = {};
  months.forEach(m => {
    monthlyTotals[m] = items.reduce((sum, item) => sum + (allValues[item.id]?.[m] || 0), 0);
  });

  const chartData = months.map(m => ({
    month: getMonthLabel(m),
    total: monthlyTotals[m] || 0,
  }));

  const grandTotal = Object.values(monthlyTotals).reduce((s, v) => s + v, 0);

  const handleAddClick = () => {
    if (config.itemTypes.length === 1) {
      handleAdd(config.itemTypes[0].value);
    } else if (config.itemTypes.length > 1) {
      setShowTypeSelection(true);
    }
  };

  const handleAdd = async (itemType: string) => {
    if (!scenario) {
      console.error('No scenario available');
      return;
    }
    const typeDef = config.itemTypes.find(t => t.value === itemType);
    try {
      const res = await api.post('/forecast-module/items', {
        scenario_id: scenario.id,
        category,
        name: `New ${typeDef?.label || label}`,
        item_type: itemType,
        entry_mode: 'varying',
        start_month: months[0],
      });
      setShowTypeSelection(false);
      setShowAddType(false);
      await onReload();
      if (res.data?.id) {
        setEditingItem(res.data);
      }
    } catch (err) {
      console.error('Failed to add item:', err);
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
    // Copy values
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

  // Delegate personnel to PersonnelTab
  if (category === 'personnel') {
    return (
      <PersonnelTab
        category={category}
        label={label}
        scenario={scenario}
        months={months}
        viewMode={viewMode}
        items={items}
        allItems={allItems}
        allValues={allValues}
        settings={settings}
        onReload={onReload}
        readOnly={readOnly}
      />
    );
  }

  // Delegate expenses to ExpensesTab
  if (category === 'expenses') {
    return (
      <ExpensesTab
        category={category}
        label={label}
        scenario={scenario}
        months={months}
        viewMode={viewMode}
        items={items}
        allItems={allItems}
        allValues={allValues}
        settings={settings}
        onReload={onReload}
        readOnly={readOnly}
      />
    );
  }

  // Show type selection screen
  if (showTypeSelection) {
    const questionMap: Record<string, string> = {
      revenue: 'How would you like to forecast this revenue stream?',
      direct_costs: 'What type of direct cost is this?',
      personnel: 'What type of personnel entry?',
      expenses: 'What type of expense is this?',
      assets: 'What type of asset is this?',
      taxes: 'What type of tax?',
      financing: 'What type of financing?',
    };
    return (
      <TypeSelectionScreen
        title={config.addLabel}
        question={questionMap[category] || `Choose a type for this ${label.toLowerCase()}`}
        types={config.itemTypes}
        onSelect={handleAdd}
        onBack={() => setShowTypeSelection(false)}
      />
    );
  }

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

  // Special pages
  if (category === 'cash_flow_assumptions') {
    return <CashFlowAssumptionsTab items={items} months={months} allValues={allValues} />;
  }
  if (category === 'initial_balances') {
    return <InitialBalancesTab />;
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-bold text-white">{label}</h2>
          <span className="text-xs px-2.5 py-1 rounded-full bg-amber-500/10 text-amber-400 font-medium cursor-pointer">In Progress</span>
        </div>
        <div className="flex items-center gap-2">
          {items.length > 0 && (
            <button
              onClick={() => exportTableCSV(items, allValues, months, viewMode, category, label)}
              className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-500 hover:text-slate-300 hover:bg-dark-500 rounded-lg transition-colors border border-dark-400/50"
              title="Download table as CSV"
            >
              <FileDown size={14} />
              CSV
            </button>
          )}
        {config.addLabel && !readOnly && (
          <button
            onClick={handleAddClick}
            className="btn-primary flex items-center gap-2 text-sm"
          >
            <Plus size={16} />
            {config.addLabel}
          </button>
        )}
        </div>
      </div>

      {/* Chart */}
      {config.showChart && items.length > 0 && (
        <div className="card mb-4">
          <h3 className="text-sm font-semibold text-slate-400 mb-3">{label} Totals</h3>
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData}>
                <defs>
                  <linearGradient id={`gradient-${category}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#0d9488" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#0d9488" stopOpacity={0} />
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
                  stroke="#0d9488"
                  strokeWidth={2}
                  strokeDasharray="5 3"
                  fill={`url(#gradient-${category})`}
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

            {/* Add new row */}
            {config.addLabel && !readOnly && (
              <tr className="border-b border-dark-400/30">
                <td className="py-2.5 px-4 sticky left-0 bg-dark-700 z-10" colSpan={months.length + 2}>
                  <button
                    onClick={handleAddClick}
                    className="flex items-center gap-2 text-sm text-accent-400 hover:text-accent-300"
                  >
                    <Plus size={14} />
                    Add new {label.toLowerCase().replace(/s$/, '')}
                  </button>
                </td>
              </tr>
            )}

            {/* Totals row */}
            <tr className="border-t-2 border-accent-500/30 bg-dark-600 font-semibold">
              <td className="py-3 px-4 text-slate-300 sticky left-0 bg-dark-600 z-10">Totals</td>
              {months.map(m => (
                <td key={m} className="text-right py-3 px-3 text-white tabular-nums">
                  {formatRs(monthlyTotals[m] || 0)}
                </td>
              ))}
              <td className="text-right py-3 px-4 text-white bg-dark-500 tabular-nums">
                {formatRs(grandTotal)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Fixed-position kebab menu (renders outside overflow container) */}
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

// Simple placeholder for Cash Flow Assumptions
function CashFlowAssumptionsTab({ items: _items, months: _months, allValues: _allValues }: { items: ForecastItem[]; months: string[]; allValues: Record<number, Record<string, number>> }) {
  return (
    <div>
      <h2 className="text-xl font-bold text-white mb-4">Cash Flow Assumptions</h2>
      <div className="card">
        <h3 className="font-semibold text-slate-300 mb-3">Accounts Receivable</h3>
        <p className="text-sm text-slate-500 mb-4">Configure how quickly you collect payments from customers.</p>
        <div className="grid grid-cols-3 gap-4 text-sm">
          <div className="font-medium text-slate-400">Revenue Stream</div>
          <div className="font-medium text-slate-400">Sales on Credit (%)</div>
          <div className="font-medium text-slate-400">Days to Get Paid</div>
          <div className="text-slate-500">Default</div>
          <input type="number" defaultValue={0} className="input py-1.5 text-sm" />
          <select className="input py-1.5 text-sm"><option>30 days</option><option>15 days</option><option>45 days</option><option>60 days</option><option>90 days</option></select>
        </div>
      </div>
      <div className="card mt-4">
        <h3 className="font-semibold text-slate-300 mb-3">Accounts Payable</h3>
        <p className="text-sm text-slate-500 mb-4">Configure how quickly you pay your vendors and suppliers.</p>
        <div className="grid grid-cols-3 gap-4 text-sm">
          <div className="font-medium text-slate-400">Expense</div>
          <div className="font-medium text-slate-400">Purchases on Credit (%)</div>
          <div className="font-medium text-slate-400">Days to Pay</div>
          <div className="text-slate-500">Default</div>
          <input type="number" defaultValue={0} className="input py-1.5 text-sm" />
          <select className="input py-1.5 text-sm"><option>30 days</option><option>15 days</option><option>45 days</option><option>60 days</option><option>90 days</option></select>
        </div>
      </div>
    </div>
  );
}

// Simple placeholder for Initial Balances
function InitialBalancesTab() {
  return (
    <div>
      <h2 className="text-xl font-bold text-white mb-2">Initial Balances</h2>
      <p className="text-sm text-slate-500 mb-4">Set your starting financial position before the forecast begins.</p>
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="card text-center">
          <div className="text-xs text-slate-500 uppercase tracking-wider">Total Assets</div>
          <div className="text-2xl font-bold text-white mt-1">Rs0</div>
        </div>
        <div className="card text-center">
          <div className="text-xs text-slate-500">= Total Liabilities +</div>
          <div className="text-2xl font-bold text-white mt-1">Rs0</div>
        </div>
        <div className="card text-center">
          <div className="text-xs text-slate-500 uppercase tracking-wider">Total Equity</div>
          <div className="text-2xl font-bold text-white mt-1">Rs0</div>
        </div>
      </div>
      <div className="flex gap-2 mb-4">
        {['Initial Assets', 'Initial Liabilities', 'Total Equity'].map(tab => (
          <button key={tab} className="px-4 py-2 text-sm font-medium rounded-lg border border-dark-400/50 hover:bg-dark-600">{tab}</button>
        ))}
      </div>
      <div className="card">
        <p className="text-sm text-slate-500">Enter your initial asset, liability, and equity values to start your forecast from your current financial position.</p>
      </div>
    </div>
  );
}
