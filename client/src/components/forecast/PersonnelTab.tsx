import { useState, useMemo } from 'react';
import { MoreVertical, Plus, GripVertical, ChevronDown, ChevronRight } from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import api from '../../api/client';
import { Scenario, ForecastItem, getMonthLabel, formatRs } from '../../pages/ForecastModulePage';
import ItemEditForm from './ItemEditForm';
import TypeSelectionScreen from './TypeSelectionScreen';

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

const PERSONNEL_ADD_TYPES = [
  { value: 'individual', label: 'Add Personnel', description: 'Add an individual employee or group' },
  { value: 'employee_benefits', label: 'Employee Taxes or Benefits', description: 'Add a burden rate for on-staff employees' },
];

export default function PersonnelTab({ category, label, scenario, months, items, allItems, allValues, onReload, readOnly }: Props) {
  const [editingItem, setEditingItem] = useState<ForecastItem | null>(null);
  const [showTypeSelection, setShowTypeSelection] = useState(false);
  const [showAddDropdown, setShowAddDropdown] = useState(false);
  const [menuOpenId, setMenuOpenId] = useState<number | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const [headCountExpanded, setHeadCountExpanded] = useState(false);

  // Separate items by section
  const directLaborItems = useMemo(() => items.filter(i => i.item_type !== 'employee_benefits' && i.meta?.labor_type === 'direct_labor'), [items]);
  const otherLaborItems = useMemo(() => items.filter(i => i.item_type !== 'employee_benefits' && i.meta?.labor_type !== 'direct_labor'), [items]);
  const benefitsItems = useMemo(() => items.filter(i => i.item_type === 'employee_benefits'), [items]);

  // Calculate subtotals per section
  const calcSectionTotals = (sectionItems: ForecastItem[]) => {
    const totals: Record<string, number> = {};
    months.forEach(m => {
      totals[m] = sectionItems.reduce((sum, item) => sum + (allValues[item.id]?.[m] || 0), 0);
    });
    return totals;
  };

  const directLaborTotals = useMemo(() => calcSectionTotals(directLaborItems), [directLaborItems, allValues, months]);
  const otherLaborTotals = useMemo(() => calcSectionTotals(otherLaborItems), [otherLaborItems, allValues, months]);

  // Employee benefits calculation: rate applied to on-staff employee salaries
  const benefitsTotals = useMemo(() => {
    const totals: Record<string, number> = {};
    const onStaffItems = items.filter(i => i.item_type !== 'employee_benefits' && i.meta?.staffing_type !== 'contract');
    const benefitsItem = benefitsItems[0];
    const benefitsRate = benefitsItem
      ? (benefitsItem.meta?.stepConstants?.rate?.amount || 0) / 100
      : 0;
    const isBenefitsVarying = benefitsItem?.meta?.stepEntryModes?.rate === 'varying';

    months.forEach(m => {
      const onStaffSalary = onStaffItems.reduce((sum, item) => sum + (allValues[item.id]?.[m] || 0), 0);
      if (isBenefitsVarying && benefitsItem) {
        const rateVal = benefitsItem.meta?.stepValues?.rate?.[m] || 0;
        totals[m] = Math.round(onStaffSalary * rateVal / 100);
      } else {
        totals[m] = Math.round(onStaffSalary * benefitsRate);
      }
    });
    return totals;
  }, [items, benefitsItems, allValues, months]);

  // Overall totals
  const monthlyTotals = useMemo(() => {
    const totals: Record<string, number> = {};
    months.forEach(m => {
      totals[m] = (directLaborTotals[m] || 0) + (otherLaborTotals[m] || 0) + (benefitsTotals[m] || 0);
    });
    return totals;
  }, [directLaborTotals, otherLaborTotals, benefitsTotals, months]);

  const grandTotal = useMemo(() => Object.values(monthlyTotals).reduce((s, v) => s + v, 0), [monthlyTotals]);

  // Head count per month
  const headCountPerMonth = useMemo(() => {
    const counts: Record<string, number> = {};
    const personnelItems = items.filter(i => i.item_type !== 'employee_benefits');
    months.forEach(m => {
      let count = 0;
      personnelItems.forEach(item => {
        const hasValueThisMonth = (allValues[item.id]?.[m] || 0) > 0;
        if (!hasValueThisMonth) return;
        if (item.item_type === 'group') {
          count += item.meta?.stepValues?.headcount?.[m] || 0;
        } else {
          count += 1;
        }
      });
      counts[m] = count;
    });
    return counts;
  }, [items, allValues, months]);

  const totalHeadCount = useMemo(() => Math.max(...Object.values(headCountPerMonth), 0), [headCountPerMonth]);

  // Chart data
  const chartData = useMemo(() => months.map(m => ({
    month: getMonthLabel(m),
    total: monthlyTotals[m] || 0,
  })), [monthlyTotals, months]);

  // Benefits display rate
  const benefitsRate = useMemo(() => {
    const bi = benefitsItems[0];
    if (!bi) return 0;
    return bi.meta?.stepConstants?.rate?.amount || 0;
  }, [benefitsItems]);

  const handleAdd = async (itemType: string) => {
    if (!scenario) return;
    try {
      const defaultMeta: Record<string, any> = {
        labor_type: 'regular_labor',
        staffing_type: 'on_staff',
      };
      const res = await api.post('/forecast-module/items', {
        scenario_id: scenario.id,
        category,
        name: itemType === 'employee_benefits' ? 'Employee Taxes & Benefits' : 'New Employee',
        item_type: itemType,
        entry_mode: 'varying',
        start_month: months[0],
        meta: itemType === 'employee_benefits' ? {} : defaultMeta,
      });
      setShowTypeSelection(false);
      setShowAddDropdown(false);
      await onReload();
      if (res.data?.id) {
        setEditingItem(res.data);
      }
    } catch (err) {
      console.error('Failed to add item:', err);
    }
  };

  const handleAddPersonnel = (laborType: string) => {
    // Show type selection for individual vs group, then set labor type
    setShowTypeSelection(true);
    setShowAddDropdown(false);
    // Store the intended labor type for the next creation
    pendingLaborType.current = laborType;
  };

  // Use a ref-like pattern for pending labor type
  const pendingLaborType = useMemo(() => ({ current: 'regular_labor' }), []);

  const handleAddWithType = async (itemType: string) => {
    if (!scenario) return;
    try {
      const res = await api.post('/forecast-module/items', {
        scenario_id: scenario.id,
        category,
        name: 'New Employee',
        item_type: itemType,
        entry_mode: 'varying',
        start_month: months[0],
        meta: {
          labor_type: pendingLaborType.current,
          staffing_type: 'on_staff',
        },
      });
      setShowTypeSelection(false);
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

  // Type selection for individual vs group
  if (showTypeSelection) {
    return (
      <TypeSelectionScreen
        title="Add Personnel"
        question="What type of personnel entry?"
        types={[
          { value: 'individual', label: 'Individual', description: 'Single employee with a specific role' },
          { value: 'group', label: 'Group of employees', description: 'Multiple employees with the same role and salary' },
        ]}
        onSelect={handleAddWithType}
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

  const renderItemRow = (item: ForecastItem) => {
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
            {item.item_type === 'group' && (
              <span className="text-xs px-1.5 py-0.5 bg-dark-500 text-slate-500 rounded">Group</span>
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
  };

  const renderSectionSubtotal = (sectionLabel: string, totals: Record<string, number>) => {
    const sectionTotal = months.reduce((s, m) => s + (totals[m] || 0), 0);
    return (
      <tr className="border-b border-dark-400/50 bg-dark-600/50">
        <td className="py-2 px-4 font-semibold text-slate-400 text-sm sticky left-0 bg-dark-600/50 z-10">
          {sectionLabel}
        </td>
        {months.map(m => (
          <td key={m} className="text-right py-2 px-3 text-slate-400 font-medium tabular-nums text-sm">
            {formatRs(totals[m] || 0)}
          </td>
        ))}
        <td className="text-right py-2 px-4 font-semibold text-slate-300 bg-dark-500 tabular-nums text-sm">
          {formatRs(sectionTotal)}
        </td>
      </tr>
    );
  };

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-bold text-white">{label}</h2>
          <span className="text-xs px-2.5 py-1 rounded-full bg-amber-500/10 text-amber-400 font-medium cursor-pointer">In Progress</span>
        </div>
        {!readOnly && <div className="relative">
          <button
            onClick={() => setShowAddDropdown(!showAddDropdown)}
            className="btn-primary flex items-center gap-2 text-sm"
          >
            <Plus size={16} />
            Add New
            <ChevronDown size={14} />
          </button>
          {showAddDropdown && (
            <>
              <div className="fixed inset-0 z-[49]" onClick={() => setShowAddDropdown(false)} />
              <div className="absolute right-0 mt-1 bg-dark-700 border border-dark-400/50 rounded-lg shadow-lg z-50 w-64">
                <button
                  onClick={() => {
                    pendingLaborType.current = 'regular_labor';
                    setShowTypeSelection(true);
                    setShowAddDropdown(false);
                  }}
                  className="w-full text-left px-4 py-3 hover:bg-dark-600 rounded-t-lg"
                >
                  <div className="font-medium text-sm text-white">Add Personnel</div>
                  <div className="text-xs text-slate-500">Add an individual employee or group</div>
                </button>
                <button
                  onClick={() => handleAdd('employee_benefits')}
                  className="w-full text-left px-4 py-3 hover:bg-dark-600 rounded-b-lg border-t border-dark-400/30"
                >
                  <div className="font-medium text-sm text-white">Employee Taxes or Benefits</div>
                  <div className="text-xs text-slate-500">Add a burden rate for on-staff employees</div>
                </button>
              </div>
            </>
          )}
        </div>}
      </div>

      {/* Chart */}
      {items.length > 0 && (
        <div className="card mb-4">
          <h3 className="text-sm font-semibold text-slate-400 mb-3">Personnel Totals</h3>
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData}>
                <defs>
                  <linearGradient id="gradient-personnel" x1="0" y1="0" x2="0" y2="1">
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
                  fill="url(#gradient-personnel)"
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
            {/* ── Direct Labor Section ── */}
            {directLaborItems.length > 0 && (
              <>
                <tr className="border-b border-dark-400/50 bg-blue-500/10/30">
                  <td colSpan={months.length + 2} className="py-2 px-4 sticky left-0 z-10">
                    <span className="text-xs font-bold text-blue-400 uppercase tracking-wider">Direct Labor</span>
                  </td>
                </tr>
                {directLaborItems.map(renderItemRow)}
                {renderSectionSubtotal('Direct Labor Subtotal', directLaborTotals)}
              </>
            )}

            {/* Add direct labor link */}
            {directLaborItems.length > 0 && !readOnly && (
              <tr className="border-b border-dark-400/30">
                <td className="py-2 px-4 sticky left-0 bg-dark-700 z-10" colSpan={months.length + 2}>
                  <button
                    onClick={() => handleAddPersonnel('direct_labor')}
                    className="flex items-center gap-2 text-sm text-accent-400 hover:text-accent-300"
                  >
                    <Plus size={14} />
                    Add new direct labor
                  </button>
                </td>
              </tr>
            )}

            {/* ── Other Labor Section ── */}
            {otherLaborItems.length > 0 && (
              <>
                <tr className="border-b border-dark-400/50 bg-dark-600/50">
                  <td colSpan={months.length + 2} className="py-2 px-4 sticky left-0 z-10">
                    <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Other Labor</span>
                  </td>
                </tr>
                {otherLaborItems.map(renderItemRow)}
                {renderSectionSubtotal('Other Labor Subtotal', otherLaborTotals)}
              </>
            )}

            {/* Add personnel link */}
            {!readOnly && (
              <tr className="border-b border-dark-400/30">
                <td className="py-2 px-4 sticky left-0 bg-dark-700 z-10" colSpan={months.length + 2}>
                  <button
                    onClick={() => {
                      pendingLaborType.current = 'regular_labor';
                      setShowTypeSelection(true);
                    }}
                    className="flex items-center gap-2 text-sm text-accent-400 hover:text-accent-300"
                  >
                    <Plus size={14} />
                    Add new personnel
                  </button>
                </td>
              </tr>
            )}

            {/* ── Employee Taxes & Benefits Row ── */}
            {benefitsItems.length > 0 && (
              <tr className="border-b border-dark-400/50 bg-amber-500/10/30">
                <td className="py-2.5 px-4 sticky left-0 bg-amber-500/10/30 z-10">
                  <div className="flex items-center gap-2">
                    {readOnly ? (
                      <span className="text-slate-300 font-medium text-left">Employee Taxes & Benefits</span>
                    ) : (
                      <button
                        onClick={() => {
                          const bi = benefitsItems[0];
                          if (bi) setEditingItem(bi);
                        }}
                        className="text-accent-400 hover:text-accent-300 font-medium hover:underline text-left"
                      >
                        Employee Taxes & Benefits
                      </button>
                    )}
                    <span className="text-xs px-1.5 py-0.5 bg-amber-500/10 text-amber-400 rounded">
                      {benefitsRate}%
                    </span>
                  </div>
                </td>
                {months.map(m => (
                  <td key={m} className="text-right py-2.5 px-3 text-slate-300 tabular-nums">
                    {benefitsTotals[m] ? formatRs(benefitsTotals[m]) : <span className="text-slate-300">-</span>}
                  </td>
                ))}
                <td className="text-right py-2.5 px-4 font-semibold text-white bg-dark-600 tabular-nums">
                  {formatRs(months.reduce((s, m) => s + (benefitsTotals[m] || 0), 0))}
                </td>
              </tr>
            )}

            {/* ── Totals Row ── */}
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

            {/* ── Head Count Row ── */}
            <tr
              className="border-t border-dark-400/50 bg-dark-600/50 cursor-pointer hover:bg-dark-500/50"
              onClick={() => setHeadCountExpanded(!headCountExpanded)}
            >
              <td className="py-2.5 px-4 text-slate-400 font-medium sticky left-0 bg-dark-600/50 z-10">
                <div className="flex items-center gap-2">
                  {headCountExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  Head Count
                </div>
              </td>
              {months.map(m => (
                <td key={m} className="text-right py-2.5 px-3 text-slate-400 tabular-nums">
                  {headCountPerMonth[m] || 0}
                </td>
              ))}
              <td className="text-right py-2.5 px-4 font-semibold text-slate-300 bg-dark-500 tabular-nums">
                {totalHeadCount}
              </td>
            </tr>

            {/* Head Count expanded detail */}
            {headCountExpanded && items.filter(i => i.item_type !== 'employee_benefits').map(item => {
              const isGroup = item.item_type === 'group';
              return (
                <tr key={`hc-${item.id}`} className="border-b border-slate-50 bg-dark-700">
                  <td className="py-1.5 px-4 pl-10 text-slate-500 text-xs sticky left-0 bg-dark-700 z-10">
                    {item.name}
                  </td>
                  {months.map(m => {
                    const hasValue = (allValues[item.id]?.[m] || 0) > 0;
                    const count = isGroup ? (item.meta?.stepValues?.headcount?.[m] || 0) : (hasValue ? 1 : 0);
                    return (
                      <td key={m} className="text-right py-1.5 px-3 text-slate-400 tabular-nums text-xs">
                        {count || <span className="text-slate-200">-</span>}
                      </td>
                    );
                  })}
                  <td className="text-right py-1.5 px-4 text-slate-500 bg-dark-600 tabular-nums text-xs">
                    {isGroup
                      ? Math.max(...months.map(m => item.meta?.stepValues?.headcount?.[m] || 0), 0)
                      : (months.some(m => (allValues[item.id]?.[m] || 0) > 0) ? 1 : 0)
                    }
                  </td>
                </tr>
              );
            })}
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
