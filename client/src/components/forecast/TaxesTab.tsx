import { useState, useMemo } from 'react';
import { Settings2, ChevronDown, ChevronRight, FileDown } from 'lucide-react';
import { Scenario, ForecastItem, getMonthLabel, formatRs } from '../../pages/ForecastModulePage';
import TaxRatesConfig from './TaxRatesConfig';
import api from '../../api/client';

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

interface TaxConfig {
  income_tax_rate: number;
  income_tax_frequency: 'monthly' | 'quarterly' | 'annually' | 'custom';
  income_tax_custom_months: number[];
  sales_tax_rate: number;
  sales_tax_frequency: 'monthly' | 'quarterly' | 'annually';
  sales_tax_streams: number[]; // IDs of selected revenue streams
}

function getDefaultConfig(settings: Record<string, any>): TaxConfig {
  return {
    income_tax_rate: settings.income_tax_rate ?? 0,
    income_tax_frequency: settings.income_tax_frequency ?? 'annually',
    income_tax_custom_months: settings.income_tax_custom_months ?? [],
    sales_tax_rate: settings.sales_tax_rate ?? 18,
    sales_tax_frequency: settings.sales_tax_frequency ?? 'monthly',
    sales_tax_streams: settings.sales_tax_streams ?? [],
  };
}

export default function TaxesTab({ scenario, months, viewMode, items, allItems, allValues, settings, onReload, readOnly }: Props) {
  const [showConfig, setShowConfig] = useState(false);
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});

  const config = useMemo(() => getDefaultConfig(settings), [settings]);

  // Revenue items for sales tax calculation
  const revenueItems = useMemo(() => allItems.filter(i => i.category === 'revenue'), [allItems]);

  // Calculate net profit per month (revenue - direct_costs - personnel - expenses)
  const monthlyNetProfit = useMemo(() => {
    const result: Record<string, number> = {};
    months.forEach(m => {
      const revenue = allItems.filter(i => i.category === 'revenue')
        .reduce((sum, i) => sum + (allValues[i.id]?.[m] || 0), 0);
      const directCosts = allItems.filter(i => i.category === 'direct_costs')
        .reduce((sum, i) => sum + (allValues[i.id]?.[m] || 0), 0);
      const personnel = allItems.filter(i => i.category === 'personnel')
        .reduce((sum, i) => sum + (allValues[i.id]?.[m] || 0), 0);
      const expenses = allItems.filter(i => i.category === 'expenses')
        .reduce((sum, i) => sum + (allValues[i.id]?.[m] || 0), 0);
      result[m] = revenue - directCosts - personnel - expenses;
    });
    return result;
  }, [allItems, allValues, months]);

  // Income tax accrued: rate × max(0, net profit)
  const incomeTaxAccrued = useMemo(() => {
    const result: Record<string, number> = {};
    months.forEach(m => {
      const profit = monthlyNetProfit[m] || 0;
      result[m] = profit > 0 ? Math.round(profit * config.income_tax_rate / 100) : 0;
    });
    return result;
  }, [monthlyNetProfit, config.income_tax_rate, months]);

  // Income tax paid: based on payment frequency
  const incomeTaxPaid = useMemo(() => {
    return computePaidSchedule(incomeTaxAccrued, months, config.income_tax_frequency, config.income_tax_custom_months);
  }, [incomeTaxAccrued, months, config.income_tax_frequency, config.income_tax_custom_months]);

  // Sales tax accrued: rate × revenue from selected streams
  const salesTaxAccrued = useMemo(() => {
    const result: Record<string, number> = {};
    const selectedStreams = config.sales_tax_streams;
    months.forEach(m => {
      let taxableRevenue = 0;
      if (selectedStreams.length === 0) {
        // If no streams selected, apply to all revenue
        taxableRevenue = revenueItems.reduce((sum, i) => sum + (allValues[i.id]?.[m] || 0), 0);
      } else {
        taxableRevenue = revenueItems
          .filter(i => selectedStreams.includes(i.id))
          .reduce((sum, i) => sum + (allValues[i.id]?.[m] || 0), 0);
      }
      result[m] = Math.round(taxableRevenue * config.sales_tax_rate / 100);
    });
    return result;
  }, [revenueItems, allValues, config.sales_tax_rate, config.sales_tax_streams, months]);

  // Sales tax paid: based on frequency with one-period lag
  const salesTaxPaid = useMemo(() => {
    return computePaidSchedule(salesTaxAccrued, months, config.sales_tax_frequency, [], true);
  }, [salesTaxAccrued, months, config.sales_tax_frequency]);

  // Grand totals
  const grandTotals = useMemo(() => {
    const result: Record<string, number> = {};
    months.forEach(m => {
      result[m] = (incomeTaxAccrued[m] || 0) + (salesTaxAccrued[m] || 0);
    });
    return result;
  }, [incomeTaxAccrued, salesTaxAccrued, months]);

  const toggleSection = (key: string) => {
    setCollapsedSections(prev => ({ ...prev, [key]: !prev[key] }));
  };

  if (showConfig && !readOnly) {
    return (
      <TaxRatesConfig
        scenario={scenario}
        settings={settings}
        revenueItems={revenueItems}
        onExit={() => setShowConfig(false)}
        onSave={async () => {
          await onReload();
        }}
      />
    );
  }

  const renderSection = (
    sectionKey: string,
    sectionLabel: string,
    accruedValues: Record<string, number>,
    paidValues: Record<string, number>,
    rateLabel: string
  ) => {
    const isCollapsed = collapsedSections[sectionKey];
    const sectionTotal = months.reduce((sum, m) => sum + (accruedValues[m] || 0), 0);

    return (
      <>
        <tr
          className="border-b border-dark-400/50 bg-dark-600/70 cursor-pointer hover:bg-dark-600"
          onClick={() => toggleSection(sectionKey)}
        >
          <td className="py-2.5 px-4 sticky left-0 bg-dark-600/70 z-10">
            <div className="flex items-center gap-2">
              {isCollapsed
                ? <ChevronRight size={14} className="text-theme-faint" />
                : <ChevronDown size={14} className="text-theme-faint" />}
              <span className="font-semibold text-sm text-theme-muted">{sectionLabel}</span>
              <span className="text-xs text-theme-faint">({rateLabel})</span>
            </div>
          </td>
          {isCollapsed && months.map(m => (
            <td key={m} className="text-right py-2.5 px-3 text-theme-muted tabular-nums text-sm font-medium">
              {accruedValues[m] ? formatRs(accruedValues[m]) : '-'}
            </td>
          ))}
          {isCollapsed && (
            <td className="text-right py-2.5 px-4 font-semibold text-theme-heading bg-dark-500 tabular-nums">
              {formatRs(sectionTotal)}
            </td>
          )}
          {!isCollapsed && <td colSpan={months.length + 1} />}
        </tr>
        {!isCollapsed && (
          <>
            <tr className="border-b border-dark-400/30 hover:bg-dark-600/30">
              <td className="py-2.5 px-4 sticky left-0 bg-dark-700 z-10 pl-10">
                <span className="text-sm text-theme-secondary">Accrued</span>
              </td>
              {months.map(m => (
                <td key={m} className="text-right py-2.5 px-3 text-theme-secondary tabular-nums">
                  {accruedValues[m] ? formatRs(accruedValues[m]) : <span className="text-theme-faint">-</span>}
                </td>
              ))}
              <td className="text-right py-2.5 px-4 font-semibold text-theme-heading bg-dark-600 tabular-nums">
                {formatRs(months.reduce((s, m) => s + (accruedValues[m] || 0), 0))}
              </td>
            </tr>
            <tr className="border-b border-dark-400/30 hover:bg-dark-600/30">
              <td className="py-2.5 px-4 sticky left-0 bg-dark-700 z-10 pl-10">
                <span className="text-sm text-theme-secondary">Paid</span>
              </td>
              {months.map(m => (
                <td key={m} className="text-right py-2.5 px-3 text-theme-secondary tabular-nums">
                  {paidValues[m] ? formatRs(paidValues[m]) : <span className="text-theme-faint">-</span>}
                </td>
              ))}
              <td className="text-right py-2.5 px-4 font-semibold text-theme-heading bg-dark-600 tabular-nums">
                {formatRs(months.reduce((s, m) => s + (paidValues[m] || 0), 0))}
              </td>
            </tr>
          </>
        )}
      </>
    );
  };

  const grandTotal = months.reduce((sum, m) => sum + (grandTotals[m] || 0), 0);

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-bold text-theme-heading">Taxes</h2>
          <span className="text-xs px-2.5 py-1 rounded-full bg-amber-500/10 text-amber-400 font-medium">
            {config.income_tax_rate > 0 || config.sales_tax_rate > 0 ? 'Configured' : 'Not configured'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              const csvRows = ['Category,Type,' + months.map(getMonthLabel).join(',') + ',Total'];
              const addRow = (cat: string, type: string, vals: Record<string, number>) => {
                const total = months.reduce((s, m) => s + (vals[m] || 0), 0);
                csvRows.push(`${cat},${type},${months.map(m => vals[m] || 0).join(',')},${total}`);
              };
              addRow('Income Taxes', 'Accrued', incomeTaxAccrued);
              addRow('Income Taxes', 'Paid', incomeTaxPaid);
              addRow('Sales Taxes', 'Accrued', salesTaxAccrued);
              addRow('Sales Taxes', 'Paid', salesTaxPaid);
              const blob = new Blob([csvRows.join('\n')], { type: 'text/csv' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url; a.download = 'taxes.csv'; a.click();
              URL.revokeObjectURL(url);
            }}
            className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-theme-faint hover:text-theme-secondary hover:bg-dark-500 rounded-lg transition-colors border border-dark-400/50"
            title="Download table as CSV"
          >
            <FileDown size={14} />
            CSV
          </button>
          {!readOnly && (
            <button
              onClick={() => setShowConfig(true)}
              className="btn-primary flex items-center gap-2 text-sm"
            >
              <Settings2 size={16} />
              Set Tax Rates
            </button>
          )}
        </div>
      </div>

      {/* Summary Cards */}
      {(config.income_tax_rate > 0 || config.sales_tax_rate > 0) && (
        <div className="grid grid-cols-2 gap-4 mb-4">
          <div className="card p-4">
            <div className="text-xs text-theme-faint uppercase tracking-wider mb-1">Income Tax Rate</div>
            <div className="text-lg font-bold text-theme-heading">{config.income_tax_rate}%</div>
            <div className="text-xs text-theme-faint mt-0.5 capitalize">{config.income_tax_frequency} payments</div>
          </div>
          <div className="card p-4">
            <div className="text-xs text-theme-faint uppercase tracking-wider mb-1">Sales Tax (GST) Rate</div>
            <div className="text-lg font-bold text-theme-heading">{config.sales_tax_rate}%</div>
            <div className="text-xs text-theme-faint mt-0.5 capitalize">
              {config.sales_tax_frequency} payments
              {config.sales_tax_streams.length > 0
                ? ` · ${config.sales_tax_streams.length} stream${config.sales_tax_streams.length > 1 ? 's' : ''}`
                : ' · all revenue'}
            </div>
          </div>
        </div>
      )}

      {/* Data Table */}
      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm" style={{ minWidth: months.length * 100 + 300 }}>
          <thead>
            <tr className="border-b border-dark-400/50 bg-dark-600">
              <th className="text-left py-3 px-4 font-semibold text-theme-muted sticky left-0 bg-dark-600 z-10 min-w-[240px]">
                Taxes
              </th>
              {months.map(m => (
                <th key={m} className="text-right py-3 px-3 font-semibold text-theme-muted whitespace-nowrap min-w-[100px]">
                  {getMonthLabel(m)}
                </th>
              ))}
              <th className="text-right py-3 px-4 font-semibold text-theme-muted bg-dark-500 min-w-[120px]">Total</th>
            </tr>
          </thead>
          <tbody>
            {renderSection(
              'income',
              'Income Taxes',
              incomeTaxAccrued,
              incomeTaxPaid,
              `${config.income_tax_rate}%`
            )}
            {renderSection(
              'sales',
              'Sales Taxes (GST)',
              salesTaxAccrued,
              salesTaxPaid,
              `${config.sales_tax_rate}%`
            )}

            {/* Grand Totals */}
            <tr className="border-t-2 border-accent-500/30 bg-dark-600 font-semibold">
              <td className="py-3 px-4 text-theme-secondary sticky left-0 bg-dark-600 z-10">Total Tax Accrued</td>
              {months.map(m => (
                <td key={m} className="text-right py-3 px-3 text-theme-heading tabular-nums">
                  {formatRs(grandTotals[m] || 0)}
                </td>
              ))}
              <td className="text-right py-3 px-4 text-theme-heading bg-dark-500 tabular-nums">
                {formatRs(grandTotal)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Empty state hint */}
      {config.income_tax_rate === 0 && config.sales_tax_rate === 0 && !readOnly && (
        <div className="card mt-4 text-center py-8">
          <p className="text-theme-faint text-sm mb-3">No tax rates configured yet. Set your income tax and GST rates to see projected tax liability.</p>
          <button
            onClick={() => setShowConfig(true)}
            className="btn-primary text-sm px-6"
          >
            Set Tax Rates
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Compute paid schedule from accrued values based on payment frequency.
 * @param lag - if true, payment is shifted one period forward (for sales tax)
 */
function computePaidSchedule(
  accrued: Record<string, number>,
  months: string[],
  frequency: string,
  customMonths: number[] = [],
  lag: boolean = false
): Record<string, number> {
  const result: Record<string, number> = {};
  months.forEach(m => { result[m] = 0; });

  if (frequency === 'monthly') {
    if (lag) {
      // Pay previous month's accrued
      for (let i = 1; i < months.length; i++) {
        result[months[i]] = accrued[months[i - 1]] || 0;
      }
    } else {
      months.forEach(m => { result[m] = accrued[m] || 0; });
    }
  } else if (frequency === 'quarterly') {
    // Accumulate and pay at end of each quarter (months 6, 9, 12, 3 in Indian FY)
    const quarterEndMonths = [6, 9, 12, 3]; // Jun, Sep, Dec, Mar
    let accumulated = 0;
    for (let i = 0; i < months.length; i++) {
      const m = months[i];
      accumulated += accrued[m] || 0;
      const monthNum = parseInt(m.split('-')[1]);
      if (quarterEndMonths.includes(monthNum)) {
        const payMonth = lag && i + 1 < months.length ? months[i + 1] : m;
        result[payMonth] = (result[payMonth] || 0) + accumulated;
        accumulated = 0;
      }
    }
  } else if (frequency === 'annually') {
    // Pay all at end of fiscal year (March)
    const totalAccrued = months.reduce((sum, m) => sum + (accrued[m] || 0), 0);
    const lastMonth = months[months.length - 1];
    result[lastMonth] = totalAccrued;
  } else if (frequency === 'custom' && customMonths.length > 0) {
    let accumulated = 0;
    for (let i = 0; i < months.length; i++) {
      const m = months[i];
      accumulated += accrued[m] || 0;
      const monthNum = parseInt(m.split('-')[1]);
      if (customMonths.includes(monthNum)) {
        result[m] = (result[m] || 0) + accumulated;
        accumulated = 0;
      }
    }
    // If there's remaining accumulated, add to last month
    if (accumulated > 0) {
      result[months[months.length - 1]] = (result[months[months.length - 1]] || 0) + accumulated;
    }
  }

  return result;
}
