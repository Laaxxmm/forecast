import { useState, useMemo, useCallback } from 'react';
import { ChevronDown, ChevronRight, ArrowRight, ArrowLeft } from 'lucide-react';
import { Scenario, formatRs } from '../../pages/ForecastModulePage';
import api from '../../api/client';

interface Props {
  scenario: Scenario | null;
  months: string[];
  settings: Record<string, any>;
  onReload: () => Promise<void>;
  readOnly?: boolean;
}

interface Balances {
  // Assets
  cash: number;
  accounts_receivable: number;
  days_to_get_paid: number;
  inventory: number;
  long_term_assets: number;
  accumulated_depreciation: number;
  depreciation_period: string; // 'forever' | '1'-'50'
  other_current_assets: number;
  amortization_period: string; // '1'-'12' | 'keep'
  // Liabilities
  accounts_payable: number;
  days_to_pay: number;
  income_taxes_payable: number;
  sales_taxes_payable: number;
  // Equity
  paid_in_capital: number;
}

const DAYS_OPTIONS = [15, 30, 45, 60, 90];

function getDefaults(settings: Record<string, any>): Balances {
  const ib = settings.initial_balances || {};
  return {
    cash: ib.cash ?? 0,
    accounts_receivable: ib.accounts_receivable ?? 0,
    days_to_get_paid: ib.days_to_get_paid ?? 30,
    inventory: ib.inventory ?? 0,
    long_term_assets: ib.long_term_assets ?? 0,
    accumulated_depreciation: ib.accumulated_depreciation ?? 0,
    depreciation_period: ib.depreciation_period ?? 'forever',
    other_current_assets: ib.other_current_assets ?? 0,
    amortization_period: ib.amortization_period ?? 'keep',
    accounts_payable: ib.accounts_payable ?? 0,
    days_to_pay: ib.days_to_pay ?? 30,
    income_taxes_payable: ib.income_taxes_payable ?? 0,
    sales_taxes_payable: ib.sales_taxes_payable ?? 0,
    paid_in_capital: ib.paid_in_capital ?? 0,
  };
}

type TabKey = 'assets' | 'liabilities' | 'equity';

export default function InitialBalancesTab({ scenario, months, settings, onReload, readOnly }: Props) {
  const [activeTab, setActiveTab] = useState<TabKey>('assets');
  const [balances, setBalances] = useState<Balances>(() => getDefaults(settings));
  const [expandedFields, setExpandedFields] = useState<Record<string, boolean>>({});
  const [saveStatus, setSaveStatus] = useState<string | null>(null);

  const toggleField = (key: string) => {
    setExpandedFields(prev => ({ ...prev, [key]: !prev[key] }));
  };

  // Computed totals
  const totalAssets = useMemo(() =>
    balances.cash + balances.accounts_receivable + balances.inventory +
    balances.long_term_assets - balances.accumulated_depreciation + balances.other_current_assets,
    [balances]
  );

  const totalLiabilities = useMemo(() =>
    balances.accounts_payable + balances.income_taxes_payable + balances.sales_taxes_payable,
    [balances]
  );

  const totalEquity = totalAssets - totalLiabilities;
  const retainedEarnings = totalEquity - balances.paid_in_capital;

  // Save to backend
  const save = useCallback(async (updated: Balances) => {
    if (!scenario || scenario.id === -1 || readOnly) return;
    try {
      await api.post('/forecast-module/settings', {
        scenario_id: scenario.id,
        settings: { initial_balances: updated },
      });
      setSaveStatus('Saved');
      setTimeout(() => setSaveStatus(null), 2000);
    } catch (err) {
      console.error('Failed to save initial balances:', err);
    }
  }, [scenario, readOnly]);

  const updateField = (key: keyof Balances, value: number | string) => {
    const updated = { ...balances, [key]: value };
    setBalances(updated);
    save(updated);
  };

  const formatStartDate = () => {
    if (!months.length) return 'the start of your forecast';
    const [y, m] = months[0].split('-').map(Number);
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    return `${monthNames[m - 1]} ${y}`;
  };

  // Currency input component
  const CurrencyInput = ({ value, onChange, disabled }: { value: number; onChange: (v: number) => void; disabled?: boolean }) => (
    <div className="flex items-center gap-2">
      <span className="text-sm text-theme-faint font-medium">Rs</span>
      <input
        type="text"
        value={value === 0 ? '' : new Intl.NumberFormat('en-IN').format(value)}
        onChange={e => {
          const raw = e.target.value.replace(/[^0-9.-]/g, '');
          onChange(parseFloat(raw) || 0);
        }}
        disabled={disabled || readOnly}
        placeholder="0"
        className={`input text-sm text-right py-2 w-44 ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
      />
    </div>
  );

  // Field card component
  const FieldCard = ({ id, title, description, children }: { id: string; title: string; description: string; children: React.ReactNode }) => {
    const isExpanded = expandedFields[id] !== false; // default expanded
    return (
      <div className="border-b border-dark-400/20 last:border-b-0">
        <div className="flex items-start justify-between px-5 py-4 gap-4">
          <div className="flex-1 min-w-0">
            <button
              onClick={() => toggleField(id)}
              className="flex items-center gap-1.5 text-left"
            >
              {isExpanded
                ? <ChevronDown size={14} className="text-theme-faint flex-shrink-0 mt-0.5" />
                : <ChevronRight size={14} className="text-theme-faint flex-shrink-0 mt-0.5" />
              }
              <span className="text-sm font-bold text-theme-heading">{title}</span>
            </button>
            {isExpanded && (
              <p className="text-xs text-theme-faint leading-relaxed mt-1.5 ml-5">{description}</p>
            )}
          </div>
          <div className="flex-shrink-0">
            {children}
          </div>
        </div>
      </div>
    );
  };

  const TABS: { key: TabKey; label: string }[] = [
    { key: 'assets', label: 'Initial Assets' },
    { key: 'liabilities', label: 'Initial Liabilities' },
    { key: 'equity', label: 'Total Equity' },
  ];

  return (
    <div className="max-w-[900px]">
      {/* Save toast */}
      {saveStatus && (
        <div className="fixed top-4 right-4 z-50 bg-green-500/20 border border-green-500/40 text-green-400 text-sm px-4 py-2 rounded-lg animate-fade-in">
          Your changes have been saved
        </div>
      )}

      {/* Page Title */}
      <div className="mb-4">
        <h2 className="text-2xl font-bold text-theme-heading">Initial Balances</h2>
        <p className="text-sm text-theme-faint mt-1">
          Please enter the initial balance of each category below as of the start of your forecast ({formatStartDate()}).
          These will be the starting points for your balance sheet to accurately reflect your financial position.
        </p>
      </div>

      {/* Summary Equation Bar */}
      <div className="grid grid-cols-[1fr_auto_1fr_auto_1fr] gap-3 items-center mb-2">
        <div className="card text-center py-4">
          <div className="text-xs text-theme-faint uppercase tracking-wider">Total Assets</div>
          <div className={`text-xl font-bold mt-1 ${totalAssets !== 0 ? 'text-accent-400' : 'text-theme-heading'}`}>
            {formatRs(totalAssets)}
          </div>
        </div>
        <span className="text-xl font-bold text-theme-faint">=</span>
        <div className="card text-center py-4">
          <div className="text-xs text-theme-faint uppercase tracking-wider">Total Liabilities</div>
          <div className={`text-xl font-bold mt-1 ${totalLiabilities !== 0 ? 'text-accent-400' : 'text-theme-heading'}`}>
            {formatRs(totalLiabilities)}
          </div>
        </div>
        <span className="text-xl font-bold text-theme-faint">+</span>
        <div className="card text-center py-4">
          <div className="text-xs text-theme-faint uppercase tracking-wider">Total Equity*</div>
          <div className={`text-xl font-bold mt-1 ${totalEquity !== 0 ? 'text-accent-400' : 'text-theme-heading'}`}>
            {formatRs(totalEquity)}
          </div>
        </div>
      </div>
      <p className="text-[11px] text-theme-faint mb-5 leading-relaxed">
        * Be sure that your initial balances are in balance. If there's a difference between your total assets and your total liabilities and equity, we will automatically adjust the initial balance for retained earnings.
      </p>

      {/* Tab Navigation */}
      <div className="flex gap-1 mb-4">
        {TABS.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-5 py-2.5 text-sm font-medium rounded-lg transition-all ${
              activeTab === tab.key
                ? 'bg-accent-500/15 text-accent-400 border border-accent-500/40'
                : 'text-theme-faint hover:text-theme-secondary border border-dark-400/50 hover:border-dark-300'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── TAB 1: INITIAL ASSETS ── */}
      {activeTab === 'assets' && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-lg font-bold text-theme-heading">Initial Assets</h3>
            <span className="text-lg font-bold text-accent-400">{formatRs(totalAssets)}</span>
          </div>

          <div className="card overflow-hidden">
            <FieldCard id="cash" title="Cash" description="How much cash do you have in the bank? Remember, all of these balances should be as of the start of your forecast.">
              <CurrencyInput value={balances.cash} onChange={v => updateField('cash', v)} />
            </FieldCard>

            <FieldCard id="ar" title="Accounts Receivable" description="How much do your customers owe you for past sales on credit?">
              <CurrencyInput value={balances.accounts_receivable} onChange={v => updateField('accounts_receivable', v)} />
            </FieldCard>

            <FieldCard id="days_get_paid" title="Days to Get Paid" description="How long will you take to collect on this initial balance — that is, to get paid for the past sales on credit that it represents?">
              <select
                value={balances.days_to_get_paid}
                onChange={e => updateField('days_to_get_paid', Number(e.target.value))}
                disabled={readOnly}
                className="input text-sm py-2 w-36"
              >
                {DAYS_OPTIONS.map(d => (
                  <option key={d} value={d}>{d} days</option>
                ))}
              </select>
            </FieldCard>

            <FieldCard id="inventory" title="Inventory" description="What is the value of your unsold inventory? If you don't use inventory, just leave this at zero.">
              <CurrencyInput value={balances.inventory} onChange={v => updateField('inventory', v)} />
            </FieldCard>

            <FieldCard id="lt_assets" title="Long-term Assets" description="What is the value of your fixed assets? This should be the full, original value without any depreciation applied.">
              <CurrencyInput value={balances.long_term_assets} onChange={v => updateField('long_term_assets', v)} />
            </FieldCard>

            <FieldCard id="acc_dep" title="Accumulated Depreciation" description="How much depreciation have you claimed on those fixed assets so far?">
              <CurrencyInput value={balances.accumulated_depreciation} onChange={v => updateField('accumulated_depreciation', v)} />
            </FieldCard>

            <FieldCard id="dep_period" title="Depreciation Period" description="How long do you want to spread out the depreciation on the remaining value of the long-term assets that you are starting with?">
              <select
                value={balances.depreciation_period}
                onChange={e => updateField('depreciation_period', e.target.value)}
                disabled={readOnly}
                className="input text-sm py-2 w-44"
              >
                <option value="forever">Forever (do not depreciate)</option>
                {Array.from({ length: 50 }, (_, i) => (
                  <option key={i + 1} value={String(i + 1)}>{i + 1} year{i > 0 ? 's' : ''}</option>
                ))}
              </select>
            </FieldCard>

            <FieldCard id="oca" title="Other Current Assets" description="What is the unamortized value of your other current assets?">
              <CurrencyInput value={balances.other_current_assets} onChange={v => updateField('other_current_assets', v)} />
            </FieldCard>

            <FieldCard id="amort_period" title="Amortization Period" description="Select the length of time that those assets will provide value, so we can expense a suitable portion each month. If you don't want to expense them at all, choose 'Keep at full value' instead.">
              <select
                value={balances.amortization_period}
                onChange={e => updateField('amortization_period', e.target.value)}
                disabled={readOnly}
                className="input text-sm py-2 w-44"
              >
                {Array.from({ length: 12 }, (_, i) => (
                  <option key={i + 1} value={String(i + 1)}>{i + 1} month{i > 0 ? 's' : ''}</option>
                ))}
                <option value="keep">Keep at full value</option>
              </select>
            </FieldCard>
          </div>

          <div className="flex justify-end mt-4">
            <button
              onClick={() => setActiveTab('liabilities')}
              className="btn-primary flex items-center gap-2 px-5 py-2.5 text-sm"
            >
              Continue to liabilities
              <ArrowRight size={16} />
            </button>
          </div>
        </div>
      )}

      {/* ── TAB 2: INITIAL LIABILITIES ── */}
      {activeTab === 'liabilities' && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-lg font-bold text-theme-heading">Initial Liabilities</h3>
            <span className="text-lg font-bold text-accent-400">{formatRs(totalLiabilities)}</span>
          </div>

          <div className="card overflow-hidden">
            <FieldCard id="ap" title="Accounts Payable" description="How much do you owe to your suppliers for past purchases on credit?">
              <CurrencyInput value={balances.accounts_payable} onChange={v => updateField('accounts_payable', v)} />
            </FieldCard>

            <FieldCard id="days_pay" title="Days to Pay" description="How long will you take to pay off this initial balance — that is, to pay for the past purchases on credit that it represents?">
              <select
                value={balances.days_to_pay}
                onChange={e => updateField('days_to_pay', Number(e.target.value))}
                disabled={readOnly}
                className="input text-sm py-2 w-36"
              >
                {DAYS_OPTIONS.map(d => (
                  <option key={d} value={d}>{d} days</option>
                ))}
              </select>
            </FieldCard>

            <FieldCard id="itp" title="Income Taxes Payable" description="How much, if anything, have you accrued toward your next income tax payment?">
              <CurrencyInput value={balances.income_taxes_payable} onChange={v => updateField('income_taxes_payable', v)} />
            </FieldCard>

            <FieldCard id="stp" title="Sales Taxes Payable" description="How much of your cash balance is actually sales tax revenue that you will soon need to pass along to the government?">
              <CurrencyInput value={balances.sales_taxes_payable} onChange={v => updateField('sales_taxes_payable', v)} />
            </FieldCard>
          </div>

          {/* Auto-calculated fields */}
          <div className="mt-4">
            <p className="text-xs text-theme-faint mb-3 italic">These additional items are calculated automatically:</p>
            <div className="card overflow-hidden opacity-70">
              <FieldCard id="prepaid_rev" title="Prepaid Revenue" description="Your initial balance for prepaid revenue is calculated based on the existing customers you add in the Revenue step. This balance will convert to revenue within the first 12 months of your forecast.">
                <CurrencyInput value={0} onChange={() => {}} disabled />
              </FieldCard>

              <FieldCard id="st_debt" title="Short-term Debt" description="Your initial balances for debt are calculated automatically based on the financing you add in the Financing step. Short-term debt is associated with credit lines, credit cards, and loans that will be paid back within 12 months.">
                <CurrencyInput value={0} onChange={() => {}} disabled />
              </FieldCard>

              <FieldCard id="lt_debt" title="Long-term Debt" description="Long-term debt comes from loans or other financing that will take more than 12 months to pay back.">
                <CurrencyInput value={0} onChange={() => {}} disabled />
              </FieldCard>
            </div>
          </div>

          <div className="flex justify-between mt-4">
            <button
              onClick={() => setActiveTab('assets')}
              className="flex items-center gap-2 px-5 py-2.5 text-sm text-theme-faint hover:text-theme-secondary border border-dark-400/50 rounded-lg hover:border-dark-300 transition-colors"
            >
              <ArrowLeft size={16} />
              Back to assets
            </button>
            <button
              onClick={() => setActiveTab('equity')}
              className="btn-primary flex items-center gap-2 px-5 py-2.5 text-sm"
            >
              Continue to equity
              <ArrowRight size={16} />
            </button>
          </div>
        </div>
      )}

      {/* ── TAB 3: TOTAL EQUITY ── */}
      {activeTab === 'equity' && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-lg font-bold text-theme-heading">Initial Equity</h3>
            <span className="text-lg font-bold text-accent-400">{formatRs(totalEquity)}</span>
          </div>

          <div className="card overflow-hidden">
            <FieldCard id="pic" title="Paid-in Capital" description="How much money have you or others invested in the company as owners or in exchange for equity?">
              <CurrencyInput value={balances.paid_in_capital} onChange={v => updateField('paid_in_capital', v)} />
            </FieldCard>

            <FieldCard id="re" title="Retained Earnings" description="This value is calculated in our model, because that ensures that we can keep the balance sheet in balance, regardless of what you enter for your initial balances. If this value does not match your balance sheet as of the start of the forecast, that indicates that one of the other initial balances is off.">
              <div className="flex items-center gap-2">
                <span className="text-sm text-theme-faint font-medium">Rs</span>
                <input
                  type="text"
                  value={new Intl.NumberFormat('en-IN').format(retainedEarnings)}
                  disabled
                  className="input text-sm text-right py-2 w-44 opacity-50 cursor-not-allowed"
                />
              </div>
            </FieldCard>
          </div>

          <div className="flex justify-start mt-4">
            <button
              onClick={() => setActiveTab('liabilities')}
              className="flex items-center gap-2 px-5 py-2.5 text-sm text-theme-faint hover:text-theme-secondary border border-dark-400/50 rounded-lg hover:border-dark-300 transition-colors"
            >
              <ArrowLeft size={16} />
              Back to liabilities
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
