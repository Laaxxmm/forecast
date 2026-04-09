import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer
} from 'recharts';
import { FileDown, BarChart3, ChevronDown, Plus } from 'lucide-react';
import { ForecastItem, Scenario, getMonthLabel, formatRs } from '../../pages/ForecastModulePage';

interface Props {
  items: ForecastItem[];
  allValues: Record<number, Record<string, number>>;
  months: string[];
  viewMode: 'monthly' | 'yearly';
  settings: Record<string, any>;
  scenario?: Scenario | null;
  onReload?: () => Promise<void>;
  readOnly?: boolean;
  actuals?: Record<string, Record<string, number>>;
}

function sumCategory(items: ForecastItem[], category: string, allValues: Record<number, Record<string, number>>, month: string): number {
  return items.filter(i => i.category === category).reduce((s, i) => s + (allValues[i.id]?.[month] || 0), 0);
}

type CFRowKind = 'header' | 'detail' | 'total' | 'separator' | 'highlight';

interface CFRow {
  id: string;
  label: string;
  kind: CFRowKind;
  indent?: number;
  getValue: (month: string) => number;
}

// Format negative as parentheses
function formatCFCell(val: number): React.ReactNode {
  if (val === 0) return 'Rs0';
  if (val < 0) return <span className="text-theme-secondary">({formatRs(Math.abs(val))})</span>;
  return formatRs(val);
}

export default function CashFlowReport({ items, allValues, months, viewMode, settings, scenario, onReload, readOnly, actuals }: Props) {
  const navigate = useNavigate();
  const [chartView, setChartView] = useState<'flow' | 'balance'>('flow');
  const [showChart, setShowChart] = useState(true);
  const [showAddMenu, setShowAddMenu] = useState(false);

  const ib = settings.initial_balances || {};
  const employeeBenefitsPct = settings.employee_benefits_pct || 0;
  const arGlobalDays = settings.ar_global_days || 30;
  const apGlobalDays = settings.ap_global_days || 30;
  const arGlobalCreditPct = settings.ar_global_credit_pct || 100;
  const apGlobalCreditPct = settings.ap_global_credit_pct || 100;

  const financingItems = useMemo(() => items.filter(i => i.category === 'financing'), [items]);
  const loanItems = useMemo(() => financingItems.filter(i => i.item_type === 'loan'), [financingItems]);
  const investmentItems = useMemo(() => financingItems.filter(i => i.item_type === 'investment'), [financingItems]);
  const creditItems = useMemo(() => financingItems.filter(i => i.item_type === 'line_of_credit' || i.item_type === 'other'), [financingItems]);

  // Monthly calculation cache
  const monthData = useMemo(() => {
    const data: Record<string, {
      netProfit: number; depreciation: number;
      changeAR: number; changeAP: number;
      changeIncomeTax: number; changeSalesTax: number;
      netCashOps: number;
      assetsPurchased: number; netCashInvesting: number;
      loanReceipts: number; loanRepayments: number;
      investmentReceipts: number; creditNetCash: number;
      dividends: number; netCashFinancing: number;
      cashBeginning: number; netChangeCash: number; cashEnd: number;
    }> = {};

    let prevCashEnd = ib.cash || 0;
    let prevAR = ib.accounts_receivable || 0;
    let prevAP = ib.accounts_payable || 0;
    let prevIncomeTax = ib.income_taxes_payable || 0;
    let prevSalesTax = ib.sales_taxes_payable || 0;

    months.forEach(m => {
      const revenue = sumCategory(items, 'revenue', allValues, m);
      const directCosts = sumCategory(items, 'direct_costs', allValues, m);
      const personnel = sumCategory(items, 'personnel', allValues, m);
      const employeeTaxes = Math.round(personnel * (employeeBenefitsPct / 100));
      const expenses = sumCategory(items, 'expenses', allValues, m);
      const taxes = sumCategory(items, 'taxes', allValues, m);
      const assetsPurchased = sumCategory(items, 'assets', allValues, m);
      const dividends = sumCategory(items, 'dividends', allValues, m);

      const totalExpenses = directCosts + personnel + employeeTaxes + expenses + taxes;
      const netProfit = revenue - totalExpenses;

      // Depreciation (simplified — from asset settings or zero)
      const depreciation = 0; // TODO: derive from asset depreciation schedules

      // AR/AP changes based on cash flow assumptions
      const arFraction = (arGlobalCreditPct / 100) * Math.min(arGlobalDays / 30, 1);
      const currentAR = revenue * arFraction;
      const changeAR = currentAR - prevAR;
      prevAR = currentAR;

      const apFraction = (apGlobalCreditPct / 100) * Math.min(apGlobalDays / 30, 1);
      const currentAP = (directCosts + expenses) * apFraction;
      const changeAP = currentAP - prevAP;
      prevAP = currentAP;

      // Tax payable changes
      const currentIncomeTax = taxes;
      const changeIncomeTax = currentIncomeTax - prevIncomeTax;
      prevIncomeTax = currentIncomeTax;

      const changeSalesTax = 0 - prevSalesTax;
      prevSalesTax = 0;

      const netCashOps = netProfit + depreciation - changeAR + changeAP + changeIncomeTax + changeSalesTax;

      // Investing
      const netCashInvesting = -assetsPurchased;

      // Financing
      // Loan receipts (from meta: receive_month, receive_amount)
      let loanReceipts = 0;
      loanItems.forEach(li => {
        if (li.meta?.receive_month === m) {
          loanReceipts += li.meta?.receive_amount || 0;
        }
      });
      const loanRepayments = loanItems.reduce((s, i) => s + (allValues[i.id]?.[m] || 0), 0);
      const investmentReceipts = investmentItems.reduce((s, i) => s + (allValues[i.id]?.[m] || 0), 0);
      const creditNetCash = creditItems.reduce((s, i) => s + (allValues[i.id]?.[m] || 0), 0);

      const netCashFinancing = loanReceipts - loanRepayments + investmentReceipts + creditNetCash - dividends;

      const cashBeginning = prevCashEnd;
      const netChangeCash = netCashOps + netCashInvesting + netCashFinancing;
      const cashEnd = cashBeginning + netChangeCash;
      prevCashEnd = cashEnd;

      data[m] = {
        netProfit, depreciation,
        changeAR, changeAP, changeIncomeTax, changeSalesTax,
        netCashOps,
        assetsPurchased, netCashInvesting,
        loanReceipts, loanRepayments, investmentReceipts, creditNetCash,
        dividends, netCashFinancing,
        cashBeginning, netChangeCash, cashEnd,
      };
    });
    return data;
  }, [items, allValues, months, ib, employeeBenefitsPct, arGlobalDays, apGlobalDays, arGlobalCreditPct, apGlobalCreditPct, loanItems, investmentItems, creditItems]);

  // Build row hierarchy
  const cfRows: CFRow[] = useMemo(() => {
    const rows: CFRow[] = [];
    const md = monthData;

    // Section 1: Net Cash from Operations
    rows.push({ id: 'ops_header', label: 'Net Cash from Operations', kind: 'header', getValue: m => md[m]?.netCashOps || 0 });
    rows.push({ id: 'net_profit', label: 'Net Profit', kind: 'detail', indent: 1, getValue: m => md[m]?.netProfit || 0 });
    rows.push({ id: 'depreciation', label: 'Depreciation and Amortization', kind: 'detail', indent: 1, getValue: m => md[m]?.depreciation || 0 });
    rows.push({ id: 'change_ar', label: 'Change in Accounts Receivable', kind: 'detail', indent: 1, getValue: m => md[m]?.changeAR || 0 });
    rows.push({ id: 'change_ap', label: 'Change in Accounts Payable', kind: 'detail', indent: 1, getValue: m => md[m]?.changeAP || 0 });
    rows.push({ id: 'change_income_tax', label: 'Change in Income Tax Payable', kind: 'detail', indent: 1, getValue: m => md[m]?.changeIncomeTax || 0 });
    rows.push({ id: 'change_sales_tax', label: 'Change in Sales Tax Payable', kind: 'detail', indent: 1, getValue: m => md[m]?.changeSalesTax || 0 });

    // Section 2: Net Cash from Investing
    rows.push({ id: 'inv_header', label: 'Net Cash from Investing', kind: 'header', getValue: m => md[m]?.netCashInvesting || 0 });
    rows.push({ id: 'assets_purchased', label: 'Assets Purchased or Sold', kind: 'detail', indent: 1, getValue: m => -(md[m]?.assetsPurchased || 0) });

    // Section 3: Net Cash from Financing
    rows.push({ id: 'fin_header', label: 'Net Cash from Financing', kind: 'header', getValue: m => md[m]?.netCashFinancing || 0 });

    // Dynamic financing sub-rows
    if (loanItems.length > 0) {
      loanItems.forEach(li => {
        rows.push({
          id: `loan_receipt_${li.id}`, label: `${li.name} (Received)`, kind: 'detail', indent: 1,
          getValue: m => li.meta?.receive_month === m ? (li.meta?.receive_amount || 0) : 0,
        });
        rows.push({
          id: `loan_repay_${li.id}`, label: `${li.name} (Repayment)`, kind: 'detail', indent: 1,
          getValue: m => -(allValues[li.id]?.[m] || 0),
        });
      });
    }
    investmentItems.forEach(ii => {
      rows.push({
        id: `invest_${ii.id}`, label: ii.name, kind: 'detail', indent: 1,
        getValue: m => allValues[ii.id]?.[m] || 0,
      });
    });
    creditItems.forEach(ci => {
      rows.push({
        id: `credit_${ci.id}`, label: ci.name, kind: 'detail', indent: 1,
        getValue: m => allValues[ci.id]?.[m] || 0,
      });
    });
    if (items.some(i => i.category === 'dividends')) {
      rows.push({ id: 'dividends', label: 'Dividends', kind: 'detail', indent: 1, getValue: m => -(md[m]?.dividends || 0) });
    }

    // Separator
    rows.push({ id: 'sep1', label: '', kind: 'separator', getValue: () => 0 });

    // Summary rows
    rows.push({ id: 'cash_beginning', label: 'Cash at Beginning of Period', kind: 'total', getValue: m => md[m]?.cashBeginning || 0 });
    rows.push({ id: 'net_change', label: 'Net Change in Cash', kind: 'total', getValue: m => md[m]?.netChangeCash || 0 });

    // Highlight row
    rows.push({ id: 'cash_end', label: 'Cash at End of Period', kind: 'highlight', getValue: m => md[m]?.cashEnd || 0 });

    return rows;
  }, [monthData, loanItems, investmentItems, creditItems, allValues, items]);

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

  const getYearlyValue = (row: CFRow, yearMonths: string[]): number => {
    // For balance rows, use end-of-period value
    if (row.id === 'cash_beginning') return row.getValue(yearMonths[0]);
    if (row.id === 'cash_end') return row.getValue(yearMonths[yearMonths.length - 1]);
    return yearMonths.reduce((sum, m) => sum + row.getValue(m), 0);
  };

  const displayCols = viewMode === 'yearly' ? yearKeys : months;

  // Total column
  const getTotal = (row: CFRow): number => {
    if (row.id === 'cash_beginning') return row.getValue(months[0]);
    if (row.id === 'cash_end') return row.getValue(months[months.length - 1]);
    return months.reduce((sum, m) => sum + row.getValue(m), 0);
  };

  // Chart data
  const chartData = useMemo(() => {
    if (viewMode === 'yearly') {
      return yearKeys.map(yk => ({
        label: yk,
        'Cash Flow': yearlyData[yk].reduce((s, m) => s + (monthData[m]?.netChangeCash || 0), 0),
        'Cash Balance': monthData[yearlyData[yk][yearlyData[yk].length - 1]]?.cashEnd || 0,
      }));
    }
    return months.map(m => ({
      label: getMonthLabel(m),
      'Cash Flow': monthData[m]?.netChangeCash || 0,
      'Cash Balance': monthData[m]?.cashEnd || 0,
    }));
  }, [months, monthData, viewMode, yearKeys, yearlyData]);

  // CSV export
  const exportCSV = () => {
    const header = ['', ...displayCols.map(c => viewMode === 'yearly' ? c : getMonthLabel(c)), 'Total'];
    const csvRows = cfRows
      .filter(r => r.kind !== 'separator')
      .map(r => {
        const vals = displayCols.map(c => {
          if (viewMode === 'yearly') return getYearlyValue(r, yearlyData[c]);
          return r.getValue(c);
        });
        return [r.label, ...vals, getTotal(r)];
      });
    const csv = [header, ...csvRows].map(row => row.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'cash-flow.csv';
    a.click();
  };

  // Add New menu items
  const addMenuItems = [
    { label: 'Asset', path: '/forecast/tables/assets' },
    { label: 'Loan', action: () => navigate('/forecast/tables/financing') },
    { label: 'Line of Credit', action: () => navigate('/forecast/tables/financing') },
    { label: 'Investment', action: () => navigate('/forecast/tables/financing') },
  ];

  const chartKey = chartView === 'flow' ? 'Cash Flow' : 'Cash Balance';

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold text-theme-heading">Projected Cash Flow</h2>
        <div className="flex items-center gap-2">
          <button
            onClick={exportCSV}
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
          <button
            onClick={() => navigate('/forecast/tables/cash-flow-assumptions')}
            className="px-3 py-1.5 text-sm font-medium border border-accent-500 text-accent-400 rounded-lg hover:bg-accent-500/10 transition-colors"
          >
            Set Cash Flow Assumptions
          </button>
          {!readOnly && (
            <div className="relative">
              <button
                onClick={() => setShowAddMenu(!showAddMenu)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-accent-600 text-white rounded-lg hover:bg-accent-700 transition-colors"
              >
                <Plus size={14} />
                Add New
                <ChevronDown size={12} />
              </button>
              {showAddMenu && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowAddMenu(false)} />
                  <div className="absolute right-0 mt-1 bg-dark-700 border border-dark-400/50 rounded-lg shadow-lg z-50 w-40">
                    {addMenuItems.map(mi => (
                      <button
                        key={mi.label}
                        onClick={() => {
                          setShowAddMenu(false);
                          if (mi.action) mi.action();
                          else if (mi.path) navigate(mi.path);
                        }}
                        className="w-full text-left px-3 py-2 text-sm text-theme-secondary hover:bg-dark-600 first:rounded-t-lg last:rounded-b-lg"
                      >
                        {mi.label}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Chart View Toggle */}
      {showChart && (
        <div className="flex mb-3">
          <div className="flex bg-dark-500 rounded-lg p-1">
            <button
              onClick={() => setChartView('flow')}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${chartView === 'flow' ? 'bg-dark-700 shadow-sm text-accent-400' : 'text-theme-faint hover:text-theme-secondary'}`}
            >Cash Flow</button>
            <button
              onClick={() => setChartView('balance')}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${chartView === 'balance' ? 'bg-dark-700 shadow-sm text-accent-400' : 'text-theme-faint hover:text-theme-secondary'}`}
            >Cash Balance</button>
          </div>
        </div>
      )}

      {/* Chart */}
      {showChart && (
        <div className="card mb-4">
          <h3 className="text-sm font-semibold text-theme-muted mb-3">{chartView === 'flow' ? 'Cash Flow' : 'Cash Balance'}</h3>
          <div className="h-52">
            <ResponsiveContainer width="100%" height="100%">
              {viewMode === 'yearly' ? (
                <BarChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1a1a28" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="#94a3b8" />
                  <YAxis tick={{ fontSize: 11 }} stroke="#94a3b8" tickFormatter={v => `${(v / 1000).toFixed(0)}k`} />
                  <Tooltip formatter={(value: number) => [formatRs(value)]} contentStyle={{ borderRadius: 8, fontSize: 12, backgroundColor: '#14141f', borderColor: '#2a2a3d', color: '#e2e8f0' }} />
                  <Bar dataKey={chartKey} fill="#0d948840" stroke="#0d9488" strokeWidth={2} radius={[4, 4, 0, 0]} />
                </BarChart>
              ) : (
                <AreaChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1a1a28" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="#94a3b8" />
                  <YAxis tick={{ fontSize: 11 }} stroke="#94a3b8" tickFormatter={v => `${(v / 1000).toFixed(0)}k`} />
                  <Tooltip formatter={(value: number) => [formatRs(value)]} contentStyle={{ borderRadius: 8, fontSize: 12, backgroundColor: '#14141f', borderColor: '#2a2a3d', color: '#e2e8f0' }} />
                  <Area type="monotone" dataKey={chartKey} stroke="#6366f1" fill="#6366f120" strokeWidth={2} strokeDasharray="5 3" dot={{ r: 3, fill: 'transparent', stroke: '#6366f1', strokeWidth: 2 }} />
                </AreaChart>
              )}
            </ResponsiveContainer>
          </div>
          <div className="flex items-center gap-4 mt-2 text-xs text-theme-faint">
            <span className="flex items-center gap-1.5"><span className="w-3 h-0.5 bg-indigo-500 inline-block" style={{ borderTop: '2px dashed #6366f1' }} /> Forecast</span>
          </div>
        </div>
      )}

      {/* Data Table */}
      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm" style={{ minWidth: displayCols.length * 110 + 320 }}>
          <thead>
            <tr className="border-b border-dark-400/50 bg-dark-600">
              <th className="text-left py-3 px-4 font-semibold text-theme-muted sticky left-0 bg-dark-600 z-10 min-w-[280px]">
                Projected Cash Flow
              </th>
              {displayCols.map(c => (
                <th key={c} className="text-right py-3 px-3 font-semibold text-theme-muted whitespace-nowrap min-w-[110px]">
                  {viewMode === 'yearly' ? c : getMonthLabel(c)}
                </th>
              ))}
              <th className="text-right py-3 px-4 font-semibold text-theme-muted bg-dark-500 min-w-[120px]">Total</th>
            </tr>
          </thead>
          <tbody>
            {cfRows.map(row => {
              // Separator
              if (row.kind === 'separator') {
                return (
                  <tr key={row.id}>
                    <td colSpan={displayCols.length + 2} className="py-0">
                      <div className="border-t-2 border-dark-300/50" />
                    </td>
                  </tr>
                );
              }

              const isHeader = row.kind === 'header';
              const isHighlight = row.kind === 'highlight';
              const isTotal = row.kind === 'total';
              const isBold = isHeader || isHighlight || isTotal;

              const totalVal = getTotal(row);

              return (
                <tr
                  key={row.id}
                  className={`border-b border-dark-400/30 ${isHeader ? 'bg-dark-600/50' : ''} ${isHighlight ? 'border-t-2 border-t-accent-500/50' : ''}`}
                >
                  {/* Label cell */}
                  <td
                    className={`py-2.5 px-4 sticky left-0 z-10 ${
                      isBold ? 'font-semibold text-theme-heading' : 'text-theme-secondary'
                    } ${isHeader ? 'bg-dark-600/50' : isHighlight ? 'bg-dark-600/30' : 'bg-dark-700'}`}
                    style={{ paddingLeft: row.indent ? `${16 + row.indent * 20}px` : '16px' }}
                  >
                    {row.label}
                  </td>

                  {/* Value cells */}
                  {displayCols.map(c => {
                    const val = viewMode === 'yearly'
                      ? getYearlyValue(row, yearlyData[c])
                      : row.getValue(c);
                    return (
                      <td key={c} className={`text-right py-2.5 px-3 tabular-nums ${
                        val < 0 ? 'text-theme-secondary' : isBold ? 'text-theme-heading' : 'text-theme-secondary'
                      }`}>
                        {val === 0 && !isBold ? '' : formatCFCell(val)}
                      </td>
                    );
                  })}

                  {/* Total cell */}
                  <td className={`text-right py-2.5 px-4 tabular-nums bg-dark-500/50 ${totalVal < 0 ? 'text-theme-secondary' : 'text-theme-heading'} ${isBold ? 'font-semibold' : ''}`}>
                    {formatCFCell(totalVal)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
