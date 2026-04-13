import { useState, useMemo, useCallback } from 'react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar } from 'recharts';
import { ChevronDown, ChevronRight, MoreVertical, FileDown, BarChart3, Plus, Pencil, Trash2, Copy, ArrowRightLeft, Merge } from 'lucide-react';
import { ForecastItem, Scenario, getMonthLabel, formatRs } from '../../pages/ForecastModulePage';
import api from '../../api/client';

interface Props {
  items: ForecastItem[];
  allValues: Record<number, Record<string, number>>;
  months: string[];
  viewMode: 'monthly' | 'yearly';
  settings: Record<string, any>;
  scenario?: Scenario | null;
  onReload?: () => Promise<void>;
  readOnly?: boolean;
}

function sumCategory(items: ForecastItem[], category: string, allValues: Record<number, Record<string, number>>, month: string): number {
  return items
    .filter(i => i.category === category)
    .reduce((sum, item) => sum + (allValues[item.id]?.[month] || 0), 0);
}

// Row types for the P&L hierarchy
type RowKind = 'collapsible' | 'leaf' | 'system_leaf' | 'calculated' | 'percentage' | 'separator' | 'special';

interface PnLRow {
  id: string;
  label: string;
  kind: RowKind;
  level: number;
  parentId?: string;   // for collapse grouping
  category?: string;   // for leaf items: the forecast category
  itemId?: number;     // for leaf items: the forecast item id
  getValue: (month: string) => number;
}

export default function ProfitAndLoss({ items, allValues, months, viewMode, settings, scenario, onReload, readOnly }: Props) {
  const [showChart, setShowChart] = useState(true);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });

  // Item groups
  const revenueItems = useMemo(() => items.filter(i => i.category === 'revenue'), [items]);
  const directCostItems = useMemo(() => items.filter(i => i.category === 'direct_costs'), [items]);
  const personnelItems = useMemo(() => items.filter(i => i.category === 'personnel'), [items]);
  const expenseItems = useMemo(() => items.filter(i => i.category === 'expenses'), [items]);
  const taxItems = useMemo(() => items.filter(i => i.category === 'taxes'), [items]);
  const assetItems = useMemo(() => items.filter(i => i.category === 'assets'), [items]);

  const longTermAssetItems = useMemo(() => items.filter(i => i.category === 'assets' && (i.item_type === 'long_term' || !i.item_type)), [items]);

  const employeeBenefitsPct = settings.employee_benefits_pct || 0;
  const incomeTaxRate = settings.income_tax_rate ?? 25;

  // Monthly calculation cache
  const monthData = useMemo(() => {
    const data: Record<string, {
      revenue: number; directCosts: number; grossProfit: number; grossMargin: number;
      personnel: number; employeeTaxes: number; expenses: number; totalOpex: number;
      operatingIncome: number; interestExpense: number; incomeTaxes: number;
      depreciation: number; totalExpenses: number; netProfit: number; netProfitMargin: number;
    }> = {};

    const ib = settings.initial_balances || {};
    let cumulativeLTAssets = ib.long_term_assets || 0;

    months.forEach(m => {
      const revenue = sumCategory(items, 'revenue', allValues, m);
      const directCosts = sumCategory(items, 'direct_costs', allValues, m);
      const grossProfit = revenue - directCosts;
      const grossMargin = revenue > 0 ? (grossProfit / revenue) * 100 : 0;

      const personnel = sumCategory(items, 'personnel', allValues, m);
      const employeeTaxes = Math.round(personnel * (employeeBenefitsPct / 100));
      const expenses = sumCategory(items, 'expenses', allValues, m);
      const totalOpex = personnel + employeeTaxes + expenses;

      const operatingIncome = grossProfit - totalOpex;

      // Interest from financing items (loan interest)
      const interestExpense = 0; // TODO: derive from financing items

      // Depreciation from cumulative long-term assets
      const ltPurchases = longTermAssetItems.reduce((s, i) => s + (allValues[i.id]?.[m] || 0), 0);
      cumulativeLTAssets += ltPurchases;
      const depPeriod = ib.depreciation_period;
      let depreciation = 0;
      if (depPeriod && depPeriod !== 'forever' && cumulativeLTAssets > 0) {
        depreciation = Math.round(cumulativeLTAssets / (parseFloat(depPeriod) * 12));
      }

      // Income tax from settings rate (applied to profit before tax)
      const profitBeforeTax = operatingIncome - interestExpense - depreciation;
      const incomeTaxes = profitBeforeTax > 0 ? Math.round(profitBeforeTax * incomeTaxRate / 100) : 0;

      const totalExpenses = directCosts + totalOpex + interestExpense + depreciation + incomeTaxes;
      const netProfit = revenue - totalExpenses;
      const netProfitMargin = revenue > 0 ? (netProfit / revenue) * 100 : 0;

      data[m] = {
        revenue, directCosts, grossProfit, grossMargin,
        personnel, employeeTaxes, expenses, totalOpex,
        operatingIncome, interestExpense, depreciation,
        incomeTaxes, totalExpenses, netProfit, netProfitMargin,
      };
    });
    return data;
  }, [items, allValues, months, employeeBenefitsPct, longTermAssetItems, incomeTaxRate, settings]);

  // Direct personnel assigned to direct costs vs operating expenses
  const directPersonnel = useMemo(() => personnelItems.filter(p => p.meta?.labor_type === 'direct_labor'), [personnelItems]);
  const otherPersonnel = useMemo(() => personnelItems.filter(p => p.meta?.labor_type !== 'direct_labor'), [personnelItems]);

  // Build row hierarchy
  const pnlRows: PnLRow[] = useMemo(() => {
    const rows: PnLRow[] = [];

    // Revenue section
    rows.push({
      id: 'revenue', label: 'Revenue', kind: 'collapsible', level: 0,
      getValue: m => monthData[m]?.revenue || 0,
    });
    revenueItems.forEach(item => {
      rows.push({
        id: `rev_${item.id}`, label: item.name, kind: 'leaf', level: 1,
        parentId: 'revenue', category: 'revenue', itemId: item.id,
        getValue: m => allValues[item.id]?.[m] || 0,
      });
    });

    // Direct Costs section
    rows.push({
      id: 'direct_costs', label: 'Direct Costs', kind: 'collapsible', level: 0,
      getValue: m => monthData[m]?.directCosts || 0,
    });
    if (directPersonnel.length > 0) {
      rows.push({
        id: 'direct_salaries', label: 'Direct Salaries & Wages', kind: 'collapsible', level: 1,
        parentId: 'direct_costs',
        getValue: m => directPersonnel.reduce((s, p) => s + (allValues[p.id]?.[m] || 0), 0),
      });
      directPersonnel.forEach(item => {
        rows.push({
          id: `dpers_${item.id}`, label: item.name, kind: 'leaf', level: 2,
          parentId: 'direct_salaries', category: 'personnel', itemId: item.id,
          getValue: m => allValues[item.id]?.[m] || 0,
        });
      });
    }
    directCostItems.forEach(item => {
      rows.push({
        id: `dc_${item.id}`, label: item.name, kind: 'leaf', level: 1,
        parentId: 'direct_costs', category: 'direct_costs', itemId: item.id,
        getValue: m => allValues[item.id]?.[m] || 0,
      });
    });

    // Gross Profit & Margin
    rows.push({
      id: 'gross_profit', label: 'Gross Profit', kind: 'calculated', level: 0,
      getValue: m => monthData[m]?.grossProfit || 0,
    });
    rows.push({
      id: 'gross_margin', label: 'Gross Margin', kind: 'percentage', level: 0,
      getValue: m => monthData[m]?.grossMargin || 0,
    });

    // Operating Expenses
    rows.push({
      id: 'opex', label: 'Operating Expenses', kind: 'collapsible', level: 0,
      getValue: m => monthData[m]?.totalOpex || 0,
    });
    if (otherPersonnel.length > 0) {
      rows.push({
        id: 'other_salaries', label: 'Other Salaries & Wages', kind: 'collapsible', level: 1,
        parentId: 'opex',
        getValue: m => otherPersonnel.reduce((s, p) => s + (allValues[p.id]?.[m] || 0), 0),
      });
      otherPersonnel.forEach(item => {
        rows.push({
          id: `opers_${item.id}`, label: item.name, kind: 'leaf', level: 2,
          parentId: 'other_salaries', category: 'personnel', itemId: item.id,
          getValue: m => allValues[item.id]?.[m] || 0,
        });
      });
    }
    if (employeeBenefitsPct > 0) {
      rows.push({
        id: 'employee_taxes', label: 'Employee Taxes & Benefits', kind: 'system_leaf', level: 1,
        parentId: 'opex',
        getValue: m => monthData[m]?.employeeTaxes || 0,
      });
    }
    expenseItems.forEach(item => {
      rows.push({
        id: `exp_${item.id}`, label: item.name, kind: 'leaf', level: 1,
        parentId: 'opex', category: 'expenses', itemId: item.id,
        getValue: m => allValues[item.id]?.[m] || 0,
      });
    });

    // Calculated summary rows
    rows.push({ id: 'operating_income', label: 'Operating Income', kind: 'calculated', level: 0, getValue: m => monthData[m]?.operatingIncome || 0 });
    rows.push({ id: 'interest_expense', label: 'Interest Expense', kind: 'calculated', level: 0, getValue: m => monthData[m]?.interestExpense || 0 });
    rows.push({ id: 'depreciation', label: 'Depreciation and Amortization', kind: 'calculated', level: 0, getValue: m => monthData[m]?.depreciation || 0 });
    rows.push({ id: 'income_taxes', label: 'Income Taxes', kind: 'calculated', level: 0, getValue: m => monthData[m]?.incomeTaxes || 0 });
    rows.push({ id: 'total_expenses', label: 'Total Expenses', kind: 'calculated', level: 0, getValue: m => monthData[m]?.totalExpenses || 0 });
    rows.push({ id: 'net_profit', label: 'Net Profit', kind: 'calculated', level: 0, getValue: m => monthData[m]?.netProfit || 0 });
    rows.push({ id: 'net_profit_margin', label: 'Net Profit Margin', kind: 'percentage', level: 0, getValue: m => monthData[m]?.netProfitMargin || 0 });

    // Separator + Cash at End of Period
    rows.push({ id: 'separator', label: '', kind: 'separator', level: 0, getValue: () => 0 });
    rows.push({
      id: 'cash_end',
      label: 'Cash at End of Period',
      kind: 'special',
      level: 0,
      getValue: m => {
        // Simplified: cumulative net profit as proxy for cash position
        let cumulative = 0;
        for (const mo of months) {
          cumulative += monthData[mo]?.netProfit || 0;
          if (mo === m) break;
        }
        return cumulative;
      },
    });

    return rows;
  }, [revenueItems, directCostItems, directPersonnel, otherPersonnel, expenseItems, employeeBenefitsPct, monthData, allValues, months]);

  // Collapse/expand logic
  const toggleCollapse = (id: string) => {
    setCollapsed(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const allExpanded = useMemo(() => {
    const collapsibles = pnlRows.filter(r => r.kind === 'collapsible');
    return collapsibles.every(r => !collapsed[r.id]);
  }, [pnlRows, collapsed]);

  const toggleAll = () => {
    const collapsibles = pnlRows.filter(r => r.kind === 'collapsible');
    const newState: Record<string, boolean> = {};
    const shouldCollapse = allExpanded;
    collapsibles.forEach(r => { newState[r.id] = shouldCollapse; });
    setCollapsed(newState);
  };

  const isRowVisible = useCallback((row: PnLRow): boolean => {
    if (!row.parentId) return true;
    // Check all ancestor collapsibles
    let pid: string | undefined = row.parentId;
    while (pid) {
      if (collapsed[pid]) return false;
      const parent = pnlRows.find(r => r.id === pid);
      pid = parent?.parentId;
    }
    return true;
  }, [collapsed, pnlRows]);

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

  const getYearlyValue = (row: PnLRow, yearMonths: string[]): number => {
    if (row.kind === 'percentage') {
      // Recalculate percentage for the full year
      if (row.id === 'gross_margin') {
        const rev = yearMonths.reduce((s, m) => s + (monthData[m]?.revenue || 0), 0);
        const gp = yearMonths.reduce((s, m) => s + (monthData[m]?.grossProfit || 0), 0);
        return rev > 0 ? (gp / rev) * 100 : 0;
      }
      if (row.id === 'net_profit_margin') {
        const rev = yearMonths.reduce((s, m) => s + (monthData[m]?.revenue || 0), 0);
        const np = yearMonths.reduce((s, m) => s + (monthData[m]?.netProfit || 0), 0);
        return rev > 0 ? (np / rev) * 100 : 0;
      }
    }
    if (row.id === 'cash_end') {
      // Cash at end = last month of year
      return row.getValue(yearMonths[yearMonths.length - 1]);
    }
    return yearMonths.reduce((sum, m) => sum + row.getValue(m), 0);
  };

  // Chart data
  const chartData = useMemo(() => {
    if (viewMode === 'yearly') {
      return yearKeys.map(yk => ({
        label: yk,
        Revenue: yearlyData[yk].reduce((s, m) => s + (monthData[m]?.revenue || 0), 0),
        'Net Profit': yearlyData[yk].reduce((s, m) => s + (monthData[m]?.netProfit || 0), 0),
      }));
    }
    return months.map(m => ({
      label: getMonthLabel(m),
      Revenue: monthData[m]?.revenue || 0,
      'Net Profit': monthData[m]?.netProfit || 0,
    }));
  }, [months, monthData, viewMode, yearKeys, yearlyData]);

  // Total column
  const getTotal = (row: PnLRow): number => {
    if (row.kind === 'percentage') {
      const rev = months.reduce((s, m) => s + (monthData[m]?.revenue || 0), 0);
      if (row.id === 'gross_margin') {
        const gp = months.reduce((s, m) => s + (monthData[m]?.grossProfit || 0), 0);
        return rev > 0 ? (gp / rev) * 100 : 0;
      }
      if (row.id === 'net_profit_margin') {
        const np = months.reduce((s, m) => s + (monthData[m]?.netProfit || 0), 0);
        return rev > 0 ? (np / rev) * 100 : 0;
      }
    }
    if (row.id === 'cash_end') return row.getValue(months[months.length - 1]);
    return months.reduce((sum, m) => sum + row.getValue(m), 0);
  };

  // Kebab menu handlers
  const handleDelete = async (itemId: number) => {
    setMenuOpenId(null);
    if (!confirm('Delete this item?')) return;
    await api.delete(`/forecast-module/items/${itemId}`);
    onReload?.();
  };

  const handleDuplicate = async (item: ForecastItem) => {
    setMenuOpenId(null);
    await api.post('/forecast-module/items', {
      scenario_id: item.scenario_id,
      category: item.category,
      name: `${item.name} (Copy)`,
      item_type: item.item_type,
      entry_mode: item.entry_mode,
      constant_amount: item.constant_amount,
      constant_period: item.constant_period,
      start_month: item.start_month,
      meta: item.meta,
    });
    onReload?.();
  };

  const openKebab = (e: React.MouseEvent, rowId: string) => {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenuPos({ top: rect.bottom + 4, left: rect.left - 120 });
    setMenuOpenId(menuOpenId === rowId ? null : rowId);
  };

  // Format cell value
  const formatCell = (val: number, isPct: boolean) => {
    if (isPct) return `${val.toFixed(1)}%`;
    if (val === 0) return <span className="text-theme-faint">-</span>;
    return formatRs(val);
  };

  // Display columns
  const displayCols = viewMode === 'yearly' ? yearKeys : months;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold text-theme-heading">Projected Profit & Loss</h2>
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              // CSV export
              const header = ['', ...displayCols.map(c => viewMode === 'yearly' ? c : getMonthLabel(c)), 'Total'];
              const csvRows = pnlRows
                .filter(r => r.kind !== 'separator' && isRowVisible(r))
                .map(r => {
                  const vals = displayCols.map(c => {
                    if (viewMode === 'yearly') return getYearlyValue(r, yearlyData[c]);
                    return r.getValue(c);
                  });
                  return [r.label, ...vals.map(v => r.kind === 'percentage' ? `${v.toFixed(1)}%` : v), r.kind === 'percentage' ? `${getTotal(r).toFixed(1)}%` : getTotal(r)];
                });
              const csv = [header, ...csvRows].map(row => row.join(',')).join('\n');
              const blob = new Blob([csv], { type: 'text/csv' });
              const a = document.createElement('a');
              a.href = URL.createObjectURL(blob);
              a.download = 'profit-and-loss.csv';
              a.click();
            }}
            className="p-2 rounded-lg border border-dark-400/50 text-theme-faint hover:text-theme-secondary hover:bg-dark-600 transition-colors"
            title="Download table as CSV"
          >
            <FileDown size={16} />
          </button>
          <button
            onClick={() => setShowChart(!showChart)}
            className="p-2 rounded-lg border border-dark-400/50 text-theme-faint hover:text-theme-secondary hover:bg-dark-600 transition-colors"
            title={showChart ? 'Hide Charts' : 'Show Charts'}
          >
            <BarChart3 size={16} />
          </button>
        </div>
      </div>

      {/* Chart */}
      {showChart && (
        <div className="card mb-4">
          <h3 className="text-sm font-semibold text-theme-muted mb-3">Projected Profit & Loss</h3>
          <div className="h-52">
            <ResponsiveContainer width="100%" height="100%">
              {viewMode === 'yearly' ? (
                <BarChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1a1a28" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="#94a3b8" />
                  <YAxis tick={{ fontSize: 11 }} stroke="#94a3b8" tickFormatter={v => `${(v / 1000).toFixed(0)}k`} />
                  <Tooltip formatter={(value: number) => [formatRs(value)]} contentStyle={{ borderRadius: 8, fontSize: 12, backgroundColor: '#14141f', borderColor: '#2a2a3d', color: '#e2e8f0' }} />
                  <Bar dataKey="Revenue" fill="#0d948840" stroke="#0d9488" strokeWidth={2} strokeDasharray="5 3" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="Net Profit" fill="#6366f140" stroke="#6366f1" strokeWidth={2} strokeDasharray="5 3" radius={[4, 4, 0, 0]} />
                </BarChart>
              ) : (
                <AreaChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1a1a28" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="#94a3b8" />
                  <YAxis tick={{ fontSize: 11 }} stroke="#94a3b8" tickFormatter={v => `${(v / 1000).toFixed(0)}k`} />
                  <Tooltip formatter={(value: number) => [formatRs(value)]} contentStyle={{ borderRadius: 8, fontSize: 12, backgroundColor: '#14141f', borderColor: '#2a2a3d', color: '#e2e8f0' }} />
                  <Area type="monotone" dataKey="Revenue" stroke="#0d9488" fill="#0d948820" strokeWidth={2} />
                  <Area type="monotone" dataKey="Net Profit" stroke="#6366f1" fill="#6366f120" strokeWidth={2} />
                </AreaChart>
              )}
            </ResponsiveContainer>
          </div>
          <div className="flex items-center gap-4 mt-2 text-xs text-theme-faint">
            <span className="flex items-center gap-1.5"><span className="w-3 h-0.5 bg-accent-500 inline-block" /> Revenue</span>
            <span className="flex items-center gap-1.5"><span className="w-3 h-0.5 bg-indigo-500 inline-block" /> Net Profit</span>
          </div>
        </div>
      )}

      {/* P&L Table */}
      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm" style={{ minWidth: displayCols.length * 110 + 300 }}>
          <thead>
            <tr className="border-b border-dark-400/50 bg-dark-600">
              <th className="text-left py-3 px-4 font-semibold text-theme-muted sticky left-0 bg-dark-600 z-10 min-w-[260px]">
                <button
                  onClick={toggleAll}
                  className="text-xs text-accent-400 hover:text-accent-300 font-medium"
                >
                  {allExpanded ? 'Collapse all rows' : 'Expand all rows'}
                </button>
              </th>
              {displayCols.map(c => (
                <th key={c} className="text-right py-3 px-3 font-semibold text-theme-muted whitespace-nowrap min-w-[100px]">
                  {viewMode === 'yearly' ? c : getMonthLabel(c)}
                </th>
              ))}
              <th className="text-right py-3 px-4 font-semibold text-theme-muted bg-dark-500 min-w-[120px]">Total</th>
            </tr>
          </thead>
          <tbody>
            {pnlRows.map(row => {
              if (!isRowVisible(row)) return null;

              // Separator row
              if (row.kind === 'separator') {
                return (
                  <tr key={row.id}>
                    <td colSpan={displayCols.length + 2} className="py-0">
                      <div className="border-t-2 border-accent-500/50" />
                    </td>
                  </tr>
                );
              }

              const isPct = row.kind === 'percentage';
              const isCalc = row.kind === 'calculated' || row.kind === 'special';
              const isCollapsible = row.kind === 'collapsible';
              const isLeaf = row.kind === 'leaf';
              const isSpecial = row.kind === 'special';
              const isBold = isCollapsible || isCalc || isSpecial;

              const totalVal = getTotal(row);

              const categoryPath = row.category === 'revenue' ? 'revenue'
                : row.category === 'direct_costs' ? 'direct-costs'
                : row.category === 'personnel' ? 'personnel'
                : row.category === 'expenses' ? 'expenses'
                : null;

              return (
                <tr
                  key={row.id}
                  className={`border-b border-dark-400/30 ${isBold ? 'bg-dark-600/50' : ''} ${isSpecial ? 'border-t-2 border-t-accent-500/50' : ''}`}
                >
                  {/* Label cell */}
                  <td
                    className={`py-2.5 px-4 sticky left-0 z-10 ${isBold ? 'bg-dark-600/50 font-semibold text-theme-heading' : 'bg-dark-700 text-theme-secondary'}`}
                    style={{ paddingLeft: `${16 + row.level * 20}px` }}
                  >
                    <div className="flex items-center gap-1.5">
                      {isCollapsible && (
                        <button onClick={() => toggleCollapse(row.id)} className="text-theme-faint hover:text-theme-secondary flex-shrink-0">
                          {collapsed[row.id] ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                        </button>
                      )}
                      {isLeaf && categoryPath && !readOnly ? (
                        <span className="text-accent-400 hover:text-accent-300 cursor-pointer underline decoration-accent-400/30 hover:decoration-accent-300">
                          {row.label}
                        </span>
                      ) : (
                        <span>{row.label}</span>
                      )}
                      {isLeaf && !readOnly && (
                        <button
                          onClick={e => openKebab(e, row.id)}
                          className="ml-auto text-theme-faint hover:text-theme-secondary opacity-0 group-hover:opacity-100 flex-shrink-0"
                          style={{ opacity: menuOpenId === row.id ? 1 : undefined }}
                        >
                          <MoreVertical size={14} />
                        </button>
                      )}
                    </div>
                  </td>

                  {/* Value cells */}
                  {displayCols.map(c => {
                    const val = viewMode === 'yearly'
                      ? getYearlyValue(row, yearlyData[c])
                      : row.getValue(c);
                    return (
                      <td key={c} className={`text-right py-2.5 px-3 tabular-nums ${val < 0 ? 'text-red-400' : isBold ? 'text-theme-heading' : 'text-theme-secondary'}`}>
                        {formatCell(val, isPct)}
                      </td>
                    );
                  })}

                  {/* Total cell */}
                  <td className={`text-right py-2.5 px-4 tabular-nums bg-dark-500/50 ${totalVal < 0 ? 'text-red-400' : 'text-theme-heading'} ${isBold ? 'font-semibold' : ''}`}>
                    {formatCell(totalVal, isPct)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Kebab menu overlay */}
      {menuOpenId !== null && (
        <>
          <div className="fixed inset-0 z-[49]" onClick={() => setMenuOpenId(null)} />
          <div
            className="fixed bg-dark-700 border border-dark-400/50 rounded-lg shadow-lg z-50 w-48"
            style={{ top: menuPos.top, left: menuPos.left }}
          >
            {(() => {
              const row = pnlRows.find(r => r.id === menuOpenId);
              const item = row?.itemId ? items.find(i => i.id === row.itemId) : null;
              if (!item) return null;
              return (
                <>
                  <button onClick={() => setMenuOpenId(null)} className="w-full text-left px-3 py-2 text-sm hover:bg-dark-600 rounded-t-lg flex items-center gap-2">
                    <Pencil size={13} /> Open editor
                  </button>
                  <button onClick={() => setMenuOpenId(null)} className="w-full text-left px-3 py-2 text-sm hover:bg-dark-600 flex items-center gap-2">
                    <Plus size={13} /> Add/edit note
                  </button>
                  <button onClick={() => handleDelete(item.id)} className="w-full text-left px-3 py-2 text-sm hover:bg-dark-600 flex items-center gap-2 text-red-400 hover:text-red-300">
                    <Trash2 size={13} /> Delete
                  </button>
                  <button onClick={() => handleDuplicate(item)} className="w-full text-left px-3 py-2 text-sm hover:bg-dark-600 flex items-center gap-2">
                    <Copy size={13} /> Duplicate
                  </button>
                  <button onClick={() => setMenuOpenId(null)} className="w-full text-left px-3 py-2 text-sm hover:bg-dark-600 flex items-center gap-2">
                    <ArrowRightLeft size={13} /> Move
                  </button>
                  <button onClick={() => setMenuOpenId(null)} className="w-full text-left px-3 py-2 text-sm hover:bg-dark-600 rounded-b-lg flex items-center gap-2">
                    <Merge size={13} /> Merge with...
                  </button>
                </>
              );
            })()}
          </div>
        </>
      )}
    </div>
  );
}
