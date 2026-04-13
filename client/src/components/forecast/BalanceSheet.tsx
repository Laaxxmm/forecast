import { useState, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, ChevronRight, FileDown, Plus, X } from 'lucide-react';
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
  return items.filter(i => i.category === category).reduce((s, i) => s + (allValues[i.id]?.[month] || 0), 0);
}

type RowKind = 'collapsible' | 'leaf' | 'calculated';

interface BSRow {
  id: string;
  label: string;
  kind: RowKind;
  level: number;
  parentId?: string;
  getValue: (month: string) => number;
  getInitial: () => number;
}

// Financing modal types
const FINANCING_TYPES = [
  { value: 'loan', label: 'Loan', desc: 'Best for fixed-amount financing with scheduled repayments and set terms' },
  { value: 'line_of_credit', label: 'Line of Credit', desc: 'Best for flexible access to funds where you only pay interest on what you use' },
  { value: 'investment', label: 'Investment', desc: 'Best for equity funding where you exchange ownership stake for capital' },
  { value: 'other', label: 'Other financing', desc: 'Best for alternative funding like grants, factoring, or non-traditional financing' },
];

export default function BalanceSheet({ items, allValues, months, viewMode, settings, scenario, onReload, readOnly }: Props) {
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [showModal, setShowModal] = useState(false);
  const [finName, setFinName] = useState('');
  const [finType, setFinType] = useState('');

  const ib = settings.initial_balances || {};

  // Item groups
  const revenueItems = useMemo(() => items.filter(i => i.category === 'revenue'), [items]);
  const directCostItems = useMemo(() => items.filter(i => i.category === 'direct_costs'), [items]);
  const personnelItems = useMemo(() => items.filter(i => i.category === 'personnel'), [items]);
  const expenseItems = useMemo(() => items.filter(i => i.category === 'expenses'), [items]);
  const taxItems = useMemo(() => items.filter(i => i.category === 'taxes'), [items]);
  const assetItems = useMemo(() => items.filter(i => i.category === 'assets'), [items]);
  const financingItems = useMemo(() => items.filter(i => i.category === 'financing'), [items]);
  const dividendItems = useMemo(() => items.filter(i => i.category === 'dividends'), [items]);

  const employeeBenefitsPct = settings.employee_benefits_pct || 0;

  // Tax rates from settings (same source as TaxesTab)
  const incomeTaxRate = settings.income_tax_rate ?? 25;
  const salesTaxRate = settings.sales_tax_rate ?? 18;

  // AR/AP settings
  const arGlobalDays = settings.ar_global_days || 30;
  const apGlobalDays = settings.ap_global_days || 30;

  // Monthly calculation cache
  const monthData = useMemo(() => {
    const data: Record<string, {
      revenue: number; directCosts: number; personnel: number; employeeTaxes: number;
      expenses: number; taxes: number; assetPurchases: number; netProfit: number;
      loanReceipts: number; loanRepayments: number; investmentReceipts: number;
      dividends: number;
    }> = {};

    months.forEach(m => {
      const revenue = sumCategory(items, 'revenue', allValues, m);
      const directCosts = sumCategory(items, 'direct_costs', allValues, m);
      const personnel = sumCategory(items, 'personnel', allValues, m);
      const employeeTaxes = Math.round(personnel * (employeeBenefitsPct / 100));
      const expenses = sumCategory(items, 'expenses', allValues, m);
      const taxes = sumCategory(items, 'taxes', allValues, m);
      const assetPurchases = sumCategory(items, 'assets', allValues, m);
      const dividends = sumCategory(items, 'dividends', allValues, m);

      const totalExpenses = directCosts + personnel + employeeTaxes + expenses + taxes;
      const netProfit = revenue - totalExpenses;

      // Financing items split by type
      const loanItems = financingItems.filter(i => i.item_type === 'loan');
      const investItems = financingItems.filter(i => i.item_type === 'investment');
      const loanReceipts = 0; // derived from loan meta (receive_month, receive_amount)
      const loanRepayments = loanItems.reduce((s, i) => s + (allValues[i.id]?.[m] || 0), 0);
      const investmentReceipts = investItems.reduce((s, i) => s + (allValues[i.id]?.[m] || 0), 0);

      data[m] = {
        revenue, directCosts, personnel, employeeTaxes, expenses, taxes,
        assetPurchases, netProfit, loanReceipts, loanRepayments,
        investmentReceipts, dividends,
      };
    });
    return data;
  }, [items, allValues, months, employeeBenefitsPct, financingItems]);

  // Long-term asset items for depreciation & investments
  const longTermAssetItems = useMemo(() => items.filter(i => i.category === 'assets' && (i.item_type === 'long_term' || !i.item_type)), [items]);
  const investmentAssetItems = useMemo(() => items.filter(i => i.category === 'assets' && i.item_type === 'investment'), [items]);

  // Cumulative calculations for balance sheet
  const balanceData = useMemo(() => {
    const data: Record<string, {
      cash: number; accountsReceivable: number; otherCurrentAssets: number;
      fixedAssets: number; investmentAssets: number;
      longTermAssets: number; accumulatedDepreciation: number;
      currentAssets: number; longTermAssetsNet: number; totalAssets: number;
      accountsPayable: number; incomeTaxesPayable: number; salesTaxesPayable: number;
      currentLiabilities: number; longTermLiabilities: number; totalLiabilities: number;
      paidInCapital: number; retainedEarnings: number; earnings: number;
      totalEquity: number; totalLiabilitiesEquity: number;
    }> = {};

    let cumulativeCash = ib.cash || 0;
    let cumulativeDepreciation = ib.accumulated_depreciation || 0;
    let cumulativeEarnings = 0;
    let cumulativeFixedAssets = ib.long_term_assets || 0;
    let cumulativeInvestmentAssets = 0;

    // Initial AR/AP values
    const initialAR = ib.accounts_receivable || 0;
    const initialAP = ib.accounts_payable || 0;
    const initialOtherCurrentAssets = ib.other_current_assets || 0;
    const initialIncomeTaxPayable = ib.income_taxes_payable || 0;
    const initialSalesTaxPayable = ib.sales_taxes_payable || 0;
    const initialPaidInCapital = ib.paid_in_capital || 0;

    // Simplified: long-term liabilities from financing
    let cumulativeLTLiabilities = 0;
    let cumulativeInvestments = initialPaidInCapital;

    months.forEach((m, idx) => {
      const md = monthData[m];

      // Income tax accrual from settings rate
      const netProfitBeforeTax = md.revenue - md.directCosts - md.personnel - md.employeeTaxes - md.expenses;
      const incomeTaxAccrued = netProfitBeforeTax > 0 ? Math.round(netProfitBeforeTax * incomeTaxRate / 100) : 0;

      // Sales tax accrual from settings rate
      const salesTaxAccrued = Math.round(md.revenue * salesTaxRate / 100);

      // Cash = initial + cumulative net profit + financing inflows - asset purchases - dividends - taxes
      const cashInflow = md.revenue;
      const cashOutflow = md.directCosts + md.personnel + md.employeeTaxes + md.expenses;
      const netOperatingCash = cashInflow - cashOutflow;

      cumulativeCash += netOperatingCash - md.assetPurchases + md.investmentReceipts - md.loanRepayments - md.dividends;

      // AR: simplified - revenue * (arDays/30) fraction stays as receivable
      const arFraction = Math.min(arGlobalDays / 30, 1);
      const accountsReceivable = idx === 0
        ? initialAR + md.revenue * arFraction
        : md.revenue * arFraction;

      // Other current assets: stays at initial (amortized if configured)
      const amortPeriod = ib.amortization_period;
      let otherCurrentAssets = initialOtherCurrentAssets;
      if (amortPeriod && amortPeriod !== 'keep') {
        const periods = parseInt(amortPeriod);
        const remaining = Math.max(0, periods - idx);
        otherCurrentAssets = remaining > 0 ? initialOtherCurrentAssets * (remaining / periods) : 0;
      }

      // Fixed assets (long_term type purchases)
      const ltPurchases = longTermAssetItems.reduce((s, i) => s + (allValues[i.id]?.[m] || 0), 0);
      cumulativeFixedAssets += ltPurchases;

      // Investment assets (investment type purchases)
      const invPurchases = investmentAssetItems.reduce((s, i) => s + (allValues[i.id]?.[m] || 0), 0);
      cumulativeInvestmentAssets += invPurchases;

      const longTermAssets = cumulativeFixedAssets + cumulativeInvestmentAssets;

      // Accumulated depreciation: monthly depreciation on fixed assets only
      const depPeriod = ib.depreciation_period;
      if (depPeriod && depPeriod !== 'forever' && cumulativeFixedAssets > 0) {
        const monthlyDep = cumulativeFixedAssets / (parseFloat(depPeriod) * 12);
        cumulativeDepreciation += monthlyDep;
      }

      // AP: costs * (apDays/30) fraction stays payable
      const apFraction = Math.min(apGlobalDays / 30, 1);
      const totalCostsPaid = md.directCosts + md.expenses;
      const accountsPayable = idx === 0
        ? initialAP + totalCostsPaid * apFraction
        : totalCostsPaid * apFraction;

      // Tax payables: auto-calculated from settings rates
      const incomeTaxesPayable = idx === 0 ? initialIncomeTaxPayable + incomeTaxAccrued : incomeTaxAccrued;
      const salesTaxesPayable = idx === 0 ? initialSalesTaxPayable + salesTaxAccrued : salesTaxAccrued;

      // Long-term liabilities from financing (loans outstanding)
      const loanItems = financingItems.filter(i => i.item_type === 'loan');
      let loanBalance = 0;
      loanItems.forEach(li => {
        const receiveMonth = li.meta?.receive_month;
        const receiveAmount = li.meta?.receive_amount || 0;
        if (receiveMonth && m >= receiveMonth) {
          // Loan received, subtract cumulative repayments
          let repaid = 0;
          months.forEach(pm => {
            if (pm <= m) repaid += allValues[li.id]?.[pm] || 0;
          });
          loanBalance += Math.max(0, receiveAmount - repaid);
        }
      });
      cumulativeLTLiabilities = loanBalance;

      // Investments add to paid-in capital
      cumulativeInvestments += md.investmentReceipts;

      // Earnings (cumulative net profit YTD)
      cumulativeEarnings += md.netProfit;

      // Retained earnings from initial balances
      const retainedEarnings = (ib.cash || 0) + initialAR + initialOtherCurrentAssets
        + (ib.long_term_assets || 0) - (ib.accumulated_depreciation || 0)
        - initialAP - initialIncomeTaxPayable - initialSalesTaxPayable
        - initialPaidInCapital;

      const currentAssets = cumulativeCash + accountsReceivable + otherCurrentAssets;
      const longTermAssetsNet = longTermAssets - cumulativeDepreciation;
      const totalAssets = currentAssets + longTermAssetsNet;

      const currentLiabilities = accountsPayable + incomeTaxesPayable + salesTaxesPayable;
      const totalLiabilities = currentLiabilities + cumulativeLTLiabilities;

      const totalEquity = cumulativeInvestments + retainedEarnings + cumulativeEarnings;
      const totalLiabilitiesEquity = totalLiabilities + totalEquity;

      data[m] = {
        cash: cumulativeCash,
        accountsReceivable,
        otherCurrentAssets,
        fixedAssets: cumulativeFixedAssets,
        investmentAssets: cumulativeInvestmentAssets,
        longTermAssets,
        accumulatedDepreciation: -cumulativeDepreciation,
        currentAssets,
        longTermAssetsNet,
        totalAssets,
        accountsPayable,
        incomeTaxesPayable,
        salesTaxesPayable,
        currentLiabilities,
        longTermLiabilities: cumulativeLTLiabilities,
        totalLiabilities,
        paidInCapital: cumulativeInvestments,
        retainedEarnings,
        earnings: cumulativeEarnings,
        totalEquity,
        totalLiabilitiesEquity,
      };
    });
    return data;
  }, [monthData, months, ib, arGlobalDays, apGlobalDays, financingItems, allValues, incomeTaxRate, salesTaxRate, longTermAssetItems, investmentAssetItems]);

  // Initial balance values
  const initialValues: Record<string, number> = useMemo(() => {
    const totalCurrentAssets = (ib.cash || 0) + (ib.accounts_receivable || 0) + (ib.other_current_assets || 0);
    const ltAssetsNet = (ib.long_term_assets || 0) - (ib.accumulated_depreciation || 0);
    const totalAssets = totalCurrentAssets + ltAssetsNet;

    const totalCurrentLiab = (ib.accounts_payable || 0) + (ib.income_taxes_payable || 0) + (ib.sales_taxes_payable || 0);
    const totalLiab = totalCurrentLiab;

    const paidIn = ib.paid_in_capital || 0;
    const retainedEarnings = totalAssets - totalLiab - paidIn;
    const totalEquity = paidIn + retainedEarnings;

    return {
      cash: ib.cash || 0,
      ar: ib.accounts_receivable || 0,
      otherCurrent: ib.other_current_assets || 0,
      currentAssets: totalCurrentAssets,
      ltAssets: ib.long_term_assets || 0,
      accDep: -(ib.accumulated_depreciation || 0),
      ltAssetsNet,
      totalAssets,
      ap: ib.accounts_payable || 0,
      incomeTax: ib.income_taxes_payable || 0,
      salesTax: ib.sales_taxes_payable || 0,
      currentLiab: totalCurrentLiab,
      ltLiab: 0,
      totalLiab,
      paidIn,
      retainedEarnings,
      earnings: 0,
      totalEquity,
      totalLiabEquity: totalLiab + totalEquity,
    };
  }, [ib]);

  // Build row hierarchy
  const bsRows: BSRow[] = useMemo(() => {
    const rows: BSRow[] = [];
    const bd = balanceData;
    const iv = initialValues;

    // ASSETS
    rows.push({
      id: 'assets', label: 'Assets', kind: 'collapsible', level: 0,
      getValue: m => bd[m]?.totalAssets || 0,
      getInitial: () => iv.totalAssets,
    });

    // Current Assets
    rows.push({
      id: 'current_assets', label: 'Current Assets', kind: 'collapsible', level: 1,
      parentId: 'assets',
      getValue: m => bd[m]?.currentAssets || 0,
      getInitial: () => iv.currentAssets,
    });
    rows.push({
      id: 'cash', label: 'Cash', kind: 'leaf', level: 2,
      parentId: 'current_assets',
      getValue: m => bd[m]?.cash || 0,
      getInitial: () => iv.cash,
    });
    rows.push({
      id: 'ar', label: 'Accounts Receivable', kind: 'leaf', level: 2,
      parentId: 'current_assets',
      getValue: m => bd[m]?.accountsReceivable || 0,
      getInitial: () => iv.ar,
    });
    rows.push({
      id: 'other_current', label: 'Other Current Assets', kind: 'leaf', level: 2,
      parentId: 'current_assets',
      getValue: m => bd[m]?.otherCurrentAssets || 0,
      getInitial: () => iv.otherCurrent,
    });

    // Long-Term Assets
    rows.push({
      id: 'lt_assets', label: 'Long-Term Assets', kind: 'collapsible', level: 1,
      parentId: 'assets',
      getValue: m => bd[m]?.longTermAssetsNet || 0,
      getInitial: () => iv.ltAssetsNet,
    });
    rows.push({
      id: 'fixed_assets', label: 'Fixed Assets', kind: 'leaf', level: 2,
      parentId: 'lt_assets',
      getValue: m => bd[m]?.fixedAssets || 0,
      getInitial: () => iv.ltAssets,
    });
    rows.push({
      id: 'investment_assets', label: 'Investments', kind: 'leaf', level: 2,
      parentId: 'lt_assets',
      getValue: m => bd[m]?.investmentAssets || 0,
      getInitial: () => 0,
    });
    rows.push({
      id: 'acc_dep', label: 'Accumulated Depreciation', kind: 'leaf', level: 2,
      parentId: 'lt_assets',
      getValue: m => bd[m]?.accumulatedDepreciation || 0,
      getInitial: () => iv.accDep,
    });

    // LIABILITIES & EQUITY
    rows.push({
      id: 'liab_equity', label: 'Liabilities & Equity', kind: 'collapsible', level: 0,
      getValue: m => bd[m]?.totalLiabilitiesEquity || 0,
      getInitial: () => iv.totalLiabEquity,
    });

    // Liabilities
    rows.push({
      id: 'liabilities', label: 'Liabilities', kind: 'collapsible', level: 1,
      parentId: 'liab_equity',
      getValue: m => bd[m]?.totalLiabilities || 0,
      getInitial: () => iv.totalLiab,
    });

    // Current Liabilities
    rows.push({
      id: 'current_liab', label: 'Current Liabilities', kind: 'collapsible', level: 2,
      parentId: 'liabilities',
      getValue: m => bd[m]?.currentLiabilities || 0,
      getInitial: () => iv.currentLiab,
    });
    rows.push({
      id: 'ap', label: 'Accounts Payable', kind: 'leaf', level: 3,
      parentId: 'current_liab',
      getValue: m => bd[m]?.accountsPayable || 0,
      getInitial: () => iv.ap,
    });
    rows.push({
      id: 'income_tax_payable', label: 'Income Taxes Payable', kind: 'leaf', level: 3,
      parentId: 'current_liab',
      getValue: m => bd[m]?.incomeTaxesPayable || 0,
      getInitial: () => iv.incomeTax,
    });
    rows.push({
      id: 'sales_tax_payable', label: 'Sales Taxes Payable', kind: 'leaf', level: 3,
      parentId: 'current_liab',
      getValue: m => bd[m]?.salesTaxesPayable || 0,
      getInitial: () => iv.salesTax,
    });

    // Long-Term Liabilities (leaf, bold, no collapse)
    rows.push({
      id: 'lt_liab', label: 'Long-Term Liabilities', kind: 'leaf', level: 2,
      parentId: 'liabilities',
      getValue: m => bd[m]?.longTermLiabilities || 0,
      getInitial: () => iv.ltLiab,
    });

    // Equity
    rows.push({
      id: 'equity', label: 'Equity', kind: 'collapsible', level: 1,
      parentId: 'liab_equity',
      getValue: m => bd[m]?.totalEquity || 0,
      getInitial: () => iv.totalEquity,
    });
    rows.push({
      id: 'paid_in_capital', label: 'Paid-In Capital', kind: 'leaf', level: 2,
      parentId: 'equity',
      getValue: m => bd[m]?.paidInCapital || 0,
      getInitial: () => iv.paidIn,
    });
    rows.push({
      id: 'retained_earnings', label: 'Retained Earnings', kind: 'leaf', level: 2,
      parentId: 'equity',
      getValue: m => bd[m]?.retainedEarnings || 0,
      getInitial: () => iv.retainedEarnings,
    });
    rows.push({
      id: 'earnings', label: 'Earnings', kind: 'leaf', level: 2,
      parentId: 'equity',
      getValue: m => bd[m]?.earnings || 0,
      getInitial: () => 0, // No initial balance for earnings
    });

    return rows;
  }, [balanceData, initialValues]);

  // Collapse/expand
  const toggleCollapse = (id: string) => {
    setCollapsed(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const allExpanded = useMemo(() => {
    const collapsibles = bsRows.filter(r => r.kind === 'collapsible');
    return collapsibles.every(r => !collapsed[r.id]);
  }, [bsRows, collapsed]);

  const toggleAll = () => {
    const collapsibles = bsRows.filter(r => r.kind === 'collapsible');
    const newState: Record<string, boolean> = {};
    const shouldCollapse = allExpanded;
    collapsibles.forEach(r => { newState[r.id] = shouldCollapse; });
    setCollapsed(newState);
  };

  const isRowVisible = useCallback((row: BSRow): boolean => {
    if (!row.parentId) return true;
    let pid: string | undefined = row.parentId;
    while (pid) {
      if (collapsed[pid]) return false;
      const parent = bsRows.find(r => r.id === pid);
      pid = parent?.parentId;
    }
    return true;
  }, [collapsed, bsRows]);

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

  // For balance sheet, yearly value = end-of-year (last month) balance
  const getYearlyValue = (row: BSRow, yearMonths: string[]): number => {
    return row.getValue(yearMonths[yearMonths.length - 1]);
  };

  const displayCols = viewMode === 'yearly' ? yearKeys : months;

  // Format cell: Rs with parentheses for negatives, blank for null/zero initial
  const formatBSCell = (val: number, isInitialCol?: boolean): React.ReactNode => {
    if (val === 0) {
      return isInitialCol ? '' : 'Rs0';
    }
    if (val < 0) {
      return <span className="text-theme-secondary">({formatRs(Math.abs(val))})</span>;
    }
    return formatRs(val);
  };

  // CSV export
  const exportCSV = () => {
    const header = ['', 'Initial Balances', ...displayCols.map(c => viewMode === 'yearly' ? c : getMonthLabel(c))];
    const csvRows = bsRows
      .filter(r => isRowVisible(r))
      .map(r => {
        const initVal = r.getInitial();
        const vals = displayCols.map(c => {
          if (viewMode === 'yearly') return getYearlyValue(r, yearlyData[c]);
          return r.getValue(c);
        });
        return [r.label, initVal, ...vals];
      });
    const csv = [header, ...csvRows].map(row => row.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'balance-sheet.csv';
    a.click();
  };

  // Financing modal: create item and navigate to editor
  const handleCreateFinancing = async () => {
    if (!finName.trim() || !finType || !scenario) return;
    const res = await api.post('/forecast-module/items', {
      scenario_id: scenario.id,
      category: 'financing',
      name: finName.trim(),
      item_type: finType,
      entry_mode: 'varying',
    });
    setShowModal(false);
    setFinName('');
    setFinType('');
    await onReload?.();
    const itemId = res.data.id;
    const slug = finType === 'line_of_credit' ? 'line-of-credit'
      : finType === 'other' ? 'custom-financing'
      : finType;
    navigate(`/forecast/balance-sheet/financing/${itemId}/${slug}`);
  };

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold text-theme-heading">Projected Balance Sheet</h2>
        <div className="flex items-center gap-2">
          <button
            onClick={exportCSV}
            className="p-2 rounded-lg border border-dark-400/50 text-theme-faint hover:text-theme-secondary hover:bg-dark-600 transition-colors"
            title="Download table as CSV"
          >
            <FileDown size={16} />
          </button>
          <button
            onClick={() => navigate('/forecast/tables/initial-balances')}
            className="px-3 py-1.5 text-sm font-medium border border-accent-500 text-accent-400 rounded-lg hover:bg-accent-500/10 transition-colors"
          >
            Set Initial Balances
          </button>
          {!readOnly && (
            <button
              onClick={() => setShowModal(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-accent-600 text-white rounded-lg hover:bg-accent-700 transition-colors"
            >
              <Plus size={14} />
              Add Financing
            </button>
          )}
        </div>
      </div>

      {/* Balance Sheet Table */}
      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm" style={{ minWidth: (displayCols.length + 1) * 120 + 300 }}>
          <thead>
            <tr className="border-b border-dark-400/50 bg-dark-600">
              <th className="text-left py-3 px-4 font-semibold text-theme-muted sticky left-0 bg-dark-600 z-10 min-w-[280px]">
                <button
                  onClick={toggleAll}
                  className="text-xs text-accent-400 hover:text-accent-300 font-medium"
                >
                  {allExpanded ? 'Collapse all rows' : 'Expand all rows'}
                </button>
              </th>
              <th className="text-right py-3 px-3 font-semibold text-theme-muted whitespace-nowrap min-w-[120px] border-r border-dark-400/30">
                <div className="flex flex-col items-end gap-0.5">
                  {viewMode === 'yearly' && (
                    <span className="text-[9px] font-medium text-accent-400 bg-accent-500/10 px-1.5 py-0.5 rounded">Forecast →</span>
                  )}
                  <span>Initial Balances</span>
                </div>
              </th>
              {displayCols.map(c => (
                <th key={c} className="text-right py-3 px-3 font-semibold text-theme-muted whitespace-nowrap min-w-[110px]">
                  {viewMode === 'yearly' ? c : getMonthLabel(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {bsRows.map(row => {
              if (!isRowVisible(row)) return null;

              const isCollapsible = row.kind === 'collapsible';
              const isLeaf = row.kind === 'leaf';
              const isBoldLeaf = row.id === 'lt_liab';
              const isBold = isCollapsible || isBoldLeaf;
              const initVal = row.getInitial();

              return (
                <tr
                  key={row.id}
                  className={`border-b border-dark-400/30 ${isBold ? 'bg-dark-600/50' : ''}`}
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
                      <span>{row.label}</span>
                    </div>
                  </td>

                  {/* Initial Balances cell */}
                  <td className={`text-right py-2.5 px-3 tabular-nums border-r border-dark-400/30 ${initVal < 0 ? 'text-theme-secondary' : isBold ? 'text-theme-heading' : 'text-theme-secondary'}`}>
                    {row.id === 'earnings' ? '' : formatBSCell(initVal, true)}
                  </td>

                  {/* Value cells */}
                  {displayCols.map(c => {
                    const val = viewMode === 'yearly'
                      ? getYearlyValue(row, yearlyData[c])
                      : row.getValue(c);
                    return (
                      <td key={c} className={`text-right py-2.5 px-3 tabular-nums ${val < 0 ? 'text-theme-secondary' : isBold ? 'text-theme-heading' : 'text-theme-secondary'}`}>
                        {formatBSCell(val)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Add Financing Modal */}
      {showModal && (
        <>
          <div className="fixed inset-0 bg-black/60 z-50" onClick={() => setShowModal(false)} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="bg-dark-700 border border-dark-400/50 rounded-xl shadow-2xl w-full max-w-lg animate-fade-in">
              <div className="flex items-center justify-between p-5 border-b border-dark-400/30">
                <h3 className="text-lg font-semibold text-theme-heading">Create a Financing Item</h3>
                <button onClick={() => { setShowModal(false); setFinName(''); setFinType(''); }} className="text-theme-faint hover:text-theme-secondary">
                  <X size={18} />
                </button>
              </div>

              <div className="p-5 space-y-5">
                {/* Name */}
                <div>
                  <input
                    type="text"
                    value={finName}
                    onChange={e => setFinName(e.target.value.slice(0, 255))}
                    placeholder="Financing Name"
                    className="input w-full"
                    maxLength={255}
                  />
                  <div className="text-right text-xs text-theme-faint mt-1">{finName.length} of 255</div>
                </div>

                {/* Type selection */}
                <div>
                  <p className="text-sm font-medium text-theme-secondary mb-3">What type of financing do you want?</p>
                  <div className="grid grid-cols-2 gap-3">
                    {FINANCING_TYPES.map(ft => (
                      <button
                        key={ft.value}
                        onClick={() => setFinType(ft.value)}
                        className={`text-left p-3 rounded-lg border-2 transition-colors ${
                          finType === ft.value
                            ? 'border-accent-500 bg-accent-500/10'
                            : 'border-dark-400/50 hover:border-dark-300'
                        }`}
                      >
                        <div className="font-medium text-sm text-theme-heading mb-1">{ft.label}</div>
                        <div className="text-xs text-theme-faint leading-relaxed">{ft.desc}</div>
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="flex justify-end p-5 border-t border-dark-400/30">
                <button
                  onClick={handleCreateFinancing}
                  disabled={!finName.trim() || !finType}
                  className="btn-primary text-sm disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Continue
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
