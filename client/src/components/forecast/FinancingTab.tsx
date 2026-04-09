import { useState, useMemo, useCallback } from 'react';
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer
} from 'recharts';
import {
  Plus, FileDown, BarChart3, X, ChevronDown, ChevronRight, Info,
  ArrowLeft, RotateCcw, GripVertical, MoreVertical, Lightbulb, StickyNote
} from 'lucide-react';
import api from '../../api/client';
import ItemRowMenu from './ItemRowMenu';
import { Scenario, ForecastItem, getMonthLabel, formatRs } from '../../pages/ForecastModulePage';
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

const FINANCING_TYPES = [
  { value: 'loan', label: 'Loan', desc: 'Best for fixed-amount financing with scheduled repayments and set terms' },
  { value: 'line_of_credit', label: 'Line of Credit', desc: 'Best for flexible access to funds where you only pay interest on what you use' },
  { value: 'investment', label: 'Investment', desc: 'Best for equity funding where you exchange ownership stake for capital' },
  { value: 'other', label: 'Other financing', desc: 'Best for alternative funding like grants, factoring, or non-traditional financing' },
];

const MONTH_NAMES = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_COLS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function getMonthOptions(months: string[]): { value: string; label: string }[] {
  const opts = [{ value: 'before_start', label: 'Before plan start date' }];
  months.forEach(m => {
    const [y, mo] = m.split('-');
    opts.push({ value: m, label: `${MONTH_NAMES[parseInt(mo)]} ${y}` });
  });
  return opts;
}

// ─── Tips Accordion ───
function TipsSection({ tips }: { tips: string[] }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="mb-5">
      <button onClick={() => setOpen(!open)} className="flex items-center gap-2 text-sm font-medium text-accent-400 hover:text-accent-300">
        <div className="w-5 h-5 rounded-full bg-accent-500/20 flex items-center justify-center"><Lightbulb size={12} /></div>
        <span>Tips</span>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {open && (
        <div className="mt-2 bg-dark-600/50 border border-dark-400/30 rounded-lg p-4 text-sm text-theme-faint">
          <ul className="space-y-1.5 list-disc pl-4">
            {tips.map((t, i) => <li key={i}>{t}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

// ─── Monthly Grid ───
function MonthlyGrid({ label, helpText, months, values, onChange, onReset }: {
  label: string; helpText: string; months: string[];
  values: Record<string, number>;
  onChange: (month: string, val: number) => void;
  onReset: () => void;
}) {
  const yearGroups = useMemo(() => {
    const groups: Record<number, string[]> = {};
    months.forEach(m => { const yr = parseInt(m.split('-')[0]); if (!groups[yr]) groups[yr] = []; groups[yr].push(m); });
    return groups;
  }, [months]);
  const years = Object.keys(yearGroups).map(Number).sort();

  return (
    <div className="space-y-3">
      <div>
        <div className="flex items-center gap-1.5">
          <h4 className="text-sm font-medium text-theme-secondary">{label}</h4>
          <Info size={13} className="text-theme-faint" />
        </div>
        {helpText && <p className="text-xs text-theme-faint mt-1">{helpText}</p>}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm" style={{ minWidth: 900 }}>
          <thead>
            <tr className="border-b border-dark-400/50">
              <th className="text-left py-2 px-2 text-theme-faint font-medium w-20"></th>
              {MONTH_COLS.map(m => <th key={m} className="text-center py-2 px-1 text-theme-faint font-medium text-xs w-16">{m}</th>)}
              <th className="text-right py-2 px-2 text-theme-faint font-medium text-xs">TOTAL</th>
              <th className="text-right py-2 px-2 text-theme-faint font-medium text-xs w-14">Y/Y%</th>
            </tr>
          </thead>
          <tbody>
            {years.map((yr, yi) => {
              const yrMonths = yearGroups[yr];
              const total = yrMonths.reduce((s, m) => s + (values[m] || 0), 0);
              const prevYrMonths = yi > 0 ? yearGroups[years[yi - 1]] : null;
              const prevTotal = prevYrMonths ? prevYrMonths.reduce((s, m) => s + (values[m] || 0), 0) : 0;
              const yoy = yi > 0 && prevTotal > 0 ? ((total - prevTotal) / prevTotal * 100).toFixed(0) + '%' : '';
              return (
                <tr key={yr} className="border-b border-dark-400/30">
                  <td className="py-1.5 px-2 text-theme-secondary font-medium text-xs">
                    <div className="flex items-center gap-1">
                      <span>{yr}</span>
                      <button className="text-theme-faint hover:text-theme-secondary"><MoreVertical size={12} /></button>
                    </div>
                  </td>
                  {MONTH_COLS.map((_, mi) => {
                    const monthStr = `${yr}-${String(mi + 1).padStart(2, '0')}`;
                    const isInRange = yrMonths.includes(monthStr);
                    return (
                      <td key={mi} className="py-1 px-0.5">
                        {isInRange ? (
                          <input type="number" value={values[monthStr] || ''} onChange={e => onChange(monthStr, Number(e.target.value))}
                            className="input text-xs text-center w-full py-1 px-1" placeholder="0" />
                        ) : <span className="text-theme-faint text-xs text-center block">-</span>}
                      </td>
                    );
                  })}
                  <td className="text-right py-1.5 px-2 text-theme-secondary text-xs font-medium tabular-nums">{total ? formatRs(total) : '-'}</td>
                  <td className="text-right py-1.5 px-2 text-theme-faint text-xs tabular-nums">{yoy}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <button onClick={onReset} className="flex items-center gap-1.5 text-xs text-red-400 hover:text-red-300">
        <RotateCcw size={12} /> Reset Form
      </button>
    </div>
  );
}

// ─── Loan Editor ───
function LoanEditor({ item, months, onSave, onDiscard }: {
  item: ForecastItem; months: string[];
  onSave: (meta: Record<string, any>) => void; onDiscard: () => void;
}) {
  const meta = item.meta || {};
  const [receiveMonth, setReceiveMonth] = useState(meta.receive_month || '');
  const [receiveAmount, setReceiveAmount] = useState(meta.receive_amount || 0);
  const [numPayments, setNumPayments] = useState(meta.num_payments || 12);
  const [rateMode, setRateMode] = useState(meta.rate_mode || 'constant');
  const [interestRate, setInterestRate] = useState(meta.interest_rate || 0);
  const [variableRates, setVariableRates] = useState<Record<string, number>>(meta.variable_rates || {});
  const monthOpts = getMonthOptions(months);

  return (
    <div className="space-y-6">
      <TipsSection tips={[
        "Don't add your loan payments as a separate expense — they're tracked here automatically.",
        "This feature assumes a standard repayment schedule.",
        "If you choose variable interest rates, payment amounts adjust as the rate changes.",
        "For variable interest rates, the annual rate is divided by 12 for monthly calculations.",
      ]} />
      <div className="space-y-5">
        <div>
          <label className="block text-sm font-medium text-theme-secondary mb-2">When will you receive it?</label>
          <select value={receiveMonth} onChange={e => setReceiveMonth(e.target.value)} className="input w-full max-w-sm">
            <option value="">Please choose...</option>
            {monthOpts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-theme-secondary mb-2">How much will you receive?</label>
          <div className="relative max-w-xs">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-theme-faint text-sm">Rs</span>
            <input type="number" value={receiveAmount || ''} onChange={e => setReceiveAmount(Number(e.target.value))} className="input w-full pl-8" placeholder="0" />
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-theme-secondary mb-2">How many monthly payments will you make?</label>
          <input type="number" value={numPayments || ''} onChange={e => setNumPayments(Number(e.target.value))} className="input w-48" min={1} />
        </div>
        <div>
          <label className="block text-sm font-medium text-theme-secondary mb-2">How do you want to enter the interest rate?</label>
          <select value={rateMode} onChange={e => setRateMode(e.target.value)} className="input w-64">
            <option value="constant">Constant rate</option>
            <option value="variable">Variable rate</option>
          </select>
        </div>
        <div>
          <div className="flex items-center gap-1.5 mb-2">
            <label className="text-sm font-medium text-theme-secondary">What is the interest rate?</label>
            <Info size={13} className="text-theme-faint" />
          </div>
          <p className="text-xs text-theme-faint mb-2">If you are not sure what interest rate you are paying on this loan, check your financing documents.</p>
          {rateMode === 'constant' ? (
            <div className="relative w-32">
              <input type="number" value={interestRate || ''} onChange={e => setInterestRate(Number(e.target.value))} className="input w-full pr-8" step={0.1} />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-theme-faint text-sm">%</span>
            </div>
          ) : (
            <MonthlyGrid label="" helpText="" months={months} values={variableRates}
              onChange={(m, v) => setVariableRates(prev => ({ ...prev, [m]: v }))}
              onReset={() => setVariableRates({})} />
          )}
        </div>
      </div>
      <div className="flex items-center gap-3 pt-4 border-t border-dark-400/30">
        <button onClick={() => onSave({ receive_month: receiveMonth, receive_amount: receiveAmount, num_payments: numPayments, rate_mode: rateMode, interest_rate: interestRate, variable_rates: variableRates })} className="btn-primary text-sm">Create & Exit</button>
        <button onClick={onDiscard} className="text-sm text-accent-400 hover:text-accent-300 font-medium">Discard & Exit</button>
      </div>
    </div>
  );
}

// ─── Line of Credit / Other Financing Editor ───
function CreditLineEditor({ item, months, onSave, onDiscard, isOther }: {
  item: ForecastItem; months: string[];
  onSave: (meta: Record<string, any>, withdrawals: Record<string, number>, payments: Record<string, number>) => void;
  onDiscard: () => void; isOther?: boolean;
}) {
  const meta = item.meta || {};
  const tabLabels = isOther
    ? [{ key: 'terms', label: 'Initial Terms' }, { key: 'funding', label: 'Funding' }, { key: 'payments', label: 'Payments' }]
    : [{ key: 'terms', label: 'Terms' }, { key: 'withdrawals', label: 'Withdrawals' }, { key: 'payments', label: 'Payments' }];

  const [tab, setTab] = useState(tabLabels[0].key);
  const [creditLimit, setCreditLimit] = useState(meta.credit_limit || 0);
  const [existingBalance, setExistingBalance] = useState(meta.existing_balance || 0);
  const [rateMode, setRateMode] = useState(meta.rate_mode || 'constant');
  const [interestRate, setInterestRate] = useState(meta.interest_rate || 0);
  const [shortTerm, setShortTerm] = useState(meta.short_term ?? '');
  const [withdrawals, setWithdrawals] = useState<Record<string, number>>(meta.withdrawals || {});
  const [payments, setPayments] = useState<Record<string, number>>(meta.payments || {});

  const startMonth = months[0];
  const [startY, startM] = startMonth ? startMonth.split('-') : ['2026', '04'];
  const planStartLabel = `${MONTH_NAMES[parseInt(startM)]} ${startY}`;

  // Incomplete tab warnings
  const termsComplete = isOther ? (interestRate > 0 && shortTerm !== '') : (creditLimit > 0 && interestRate > 0);
  const fundingComplete = Object.values(withdrawals).some(v => v > 0);
  const paymentsComplete = Object.values(payments).some(v => v > 0);

  return (
    <div className="space-y-5">
      <TipsSection tips={isOther ? [
        "Use this for non-traditional financing like grants, factoring, or other funding sources.",
        "Enter your interest rate, funding schedule, and payment plan.",
        "Short-term financing (under 12 months) appears under current liabilities on the balance sheet.",
      ] : [
        "Use this for credit lines and credit cards.",
        "Track your credit limit, withdrawals, and payments separately.",
        "Interest is calculated on the outstanding balance.",
        "The outstanding balance appears as a liability on the balance sheet.",
      ]} />

      {/* Step tabs */}
      <div className="flex border-b border-dark-400/30">
        {tabLabels.map((t, i) => {
          const isComplete = i === 0 ? termsComplete : i === 1 ? fundingComplete : paymentsComplete;
          return (
            <button key={t.key} onClick={() => setTab(t.key)}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                tab === t.key ? 'border-accent-500 text-accent-400' : 'border-transparent text-theme-faint hover:text-theme-secondary'
              }`}>
              <span className="w-5 h-5 rounded-full bg-accent-500 text-white text-[10px] font-bold flex items-center justify-center">{i + 1}</span>
              {t.label}
              {!isComplete && tab !== t.key && <span className="text-amber-400 text-xs">⚠</span>}
            </button>
          );
        })}
      </div>

      {tab === 'terms' && (
        <div className="space-y-5">
          {!isOther && (
            <>
              <div>
                <div className="flex items-center gap-1.5 mb-2">
                  <label className="text-sm font-medium text-theme-secondary">What is its credit limit?</label>
                  <Info size={13} className="text-theme-faint" />
                </div>
                <p className="text-xs text-theme-faint mb-2">Enter the maximum amount you are allowed to have as an outstanding balance.</p>
                <div className="relative max-w-xs">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-theme-faint text-sm">Rs</span>
                  <input type="number" value={creditLimit || ''} onChange={e => setCreditLimit(Number(e.target.value))} className="input w-full pl-8" />
                </div>
              </div>
              <div>
                <div className="flex items-center gap-1.5 mb-2">
                  <label className="text-sm font-medium text-theme-secondary">Does it have an existing balance as of your start date?</label>
                  <Info size={13} className="text-theme-faint" />
                </div>
                <p className="text-xs text-theme-faint mb-2">Your forecast starts in {planStartLabel}. If this was already in place before that, enter the amount owed.</p>
                <div className="relative max-w-xs">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-theme-faint text-sm">Rs</span>
                  <input type="number" value={existingBalance || ''} onChange={e => setExistingBalance(Number(e.target.value))} className="input w-full pl-8" />
                </div>
              </div>
            </>
          )}
          <div>
            <label className="block text-sm font-medium text-theme-secondary mb-2">How do you want to enter the interest rate?</label>
            <select value={rateMode} onChange={e => setRateMode(e.target.value)} className="input w-64">
              <option value="constant">Constant rate</option>
              <option value="variable">Variable rate</option>
            </select>
          </div>
          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <label className="text-sm font-medium text-theme-secondary">What is the interest rate?</label>
              <Info size={13} className="text-theme-faint" />
            </div>
            <div className="relative w-32">
              <input type="number" value={interestRate || ''} onChange={e => setInterestRate(Number(e.target.value))} className="input w-full pr-8" step={0.1} />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-theme-faint text-sm">%</span>
            </div>
          </div>
          {isOther && (
            <div>
              <div className="flex items-center gap-1.5 mb-2">
                <label className="text-sm font-medium text-theme-secondary">Do you expect to pay this money back within 12 months of receiving it?</label>
                <Info size={13} className="text-theme-faint" />
              </div>
              <p className="text-xs text-theme-faint mb-2">Short-term financing appears under current liabilities; long-term under long-term liabilities on the balance sheet.</p>
              <select value={shortTerm} onChange={e => setShortTerm(e.target.value)} className="input w-64">
                <option value="">Please choose...</option>
                <option value="yes">Yes</option>
                <option value="no">No, or I'm not sure</option>
              </select>
            </div>
          )}
          <div className="flex justify-end">
            <button onClick={() => setTab(tabLabels[1].key)} className="text-sm text-accent-400 hover:text-accent-300 font-medium">
              {tabLabels[1].label} →
            </button>
          </div>
        </div>
      )}

      {(tab === 'withdrawals' || tab === 'funding') && (
        <div className="space-y-4">
          <MonthlyGrid
            label={isOther ? 'How much money do you expect to receive and when?' : 'How much will you withdraw from — or, if this is a credit card, charge against — this credit line and when?'}
            helpText={isOther ? 'Enter the amount (in Rs) you expect to receive in each period.' : 'Enter the amount (in Rs) that you plan to draw in each period.'}
            months={months} values={withdrawals}
            onChange={(m, v) => setWithdrawals(prev => ({ ...prev, [m]: v }))}
            onReset={() => setWithdrawals({})} />
          <div className="flex justify-between">
            <button onClick={() => setTab(tabLabels[0].key)} className="text-sm text-accent-400 hover:text-accent-300 font-medium">← {tabLabels[0].label}</button>
            <button onClick={() => setTab('payments')} className="text-sm text-accent-400 hover:text-accent-300 font-medium">Payments →</button>
          </div>
        </div>
      )}

      {tab === 'payments' && (
        <div className="space-y-4">
          <MonthlyGrid
            label="How much will you pay back against the balance and when?"
            helpText="Enter the actual amount (in Rs) that you want to pay in each period against the outstanding balance."
            months={months} values={payments}
            onChange={(m, v) => setPayments(prev => ({ ...prev, [m]: v }))}
            onReset={() => setPayments({})} />
          <div className="flex justify-start">
            <button onClick={() => setTab(tabLabels[1].key)} className="text-sm text-accent-400 hover:text-accent-300 font-medium">← {tabLabels[1].label}</button>
          </div>
        </div>
      )}

      <div className="flex items-center gap-3 pt-4 border-t border-dark-400/30">
        <button onClick={() => onSave({
          credit_limit: creditLimit, existing_balance: existingBalance,
          rate_mode: rateMode, interest_rate: interestRate, short_term: shortTerm,
          withdrawals, payments,
        }, withdrawals, payments)} className="btn-primary text-sm">Create & Exit</button>
        <button onClick={onDiscard} className="text-sm text-accent-400 hover:text-accent-300 font-medium">Discard & Exit</button>
      </div>
    </div>
  );
}

// ─── Investment Editor ───
function InvestmentEditor({ item, months, onSave, onDiscard }: {
  item: ForecastItem; months: string[];
  onSave: (meta: Record<string, any>, values: Record<string, number>) => void;
  onDiscard: () => void;
}) {
  const meta = item.meta || {};
  const [entryMode, setEntryMode] = useState(meta.entry_mode || 'one_time');
  const [amount, setAmount] = useState(meta.amount || 0);
  const [investMonth, setInvestMonth] = useState(meta.invest_month || months[0]);
  const [constPeriod, setConstPeriod] = useState(meta.const_period || 'month');
  const [constStart, setConstStart] = useState(meta.const_start || months[0]);
  const [monthlyValues, setMonthlyValues] = useState<Record<string, number>>(meta.monthly_values || {});

  const monthOpts = months.map(m => { const [y, mo] = m.split('-'); return { value: m, label: `${MONTH_NAMES[parseInt(mo)]} ${y}` }; });

  const buildValues = (): Record<string, number> => {
    const vals: Record<string, number> = {};
    if (entryMode === 'one_time') {
      if (investMonth && amount) vals[investMonth] = amount;
    } else if (entryMode === 'constant') {
      const startIdx = months.indexOf(constStart);
      months.forEach((m, i) => {
        if (i >= startIdx) vals[m] = amount;
      });
    } else {
      Object.entries(monthlyValues).forEach(([m, v]) => { if (v) vals[m] = v; });
    }
    return vals;
  };

  return (
    <div className="space-y-6">
      <TipsSection tips={[
        "Equity investments are injections of cash in exchange for partial ownership of the company.",
        "Record the total amount you expect to receive and when.",
        "Investment amounts appear as Paid-In Capital on the balance sheet.",
      ]} />
      <div className="space-y-5">
        <div>
          <label className="block text-sm font-medium text-theme-secondary mb-2">How do you want to enter it?</label>
          <select value={entryMode} onChange={e => setEntryMode(e.target.value)} className="input w-72">
            <option value="one_time">One-time amount (Rs)</option>
            <option value="constant">Constant amount (Rs)</option>
            <option value="varying">Varying amounts over time (Rs)</option>
          </select>
        </div>

        {entryMode === 'one_time' && (
          <div>
            <label className="block text-sm font-medium text-theme-secondary mb-2">How much will you receive and when?</label>
            <div className="flex items-end gap-3">
              <div className="relative flex-1 max-w-xs">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-theme-faint text-sm">Rs</span>
                <input type="number" value={amount || ''} onChange={e => setAmount(Number(e.target.value))} className="input w-full pl-8" />
              </div>
              <select value={investMonth} onChange={e => setInvestMonth(e.target.value)} className="input w-36">
                {monthOpts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          </div>
        )}

        {entryMode === 'constant' && (
          <div>
            <label className="block text-sm font-medium text-theme-secondary mb-2">How much will you receive?</label>
            <div className="flex items-center gap-2 flex-wrap">
              <div className="relative max-w-[180px]">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-theme-faint text-sm">Rs</span>
                <input type="number" value={amount || ''} onChange={e => setAmount(Number(e.target.value))} className="input w-full pl-8" />
              </div>
              <span className="text-sm text-theme-faint">per</span>
              <select value={constPeriod} onChange={e => setConstPeriod(e.target.value)} className="input w-28">
                <option value="month">Month</option>
                <option value="year">Year</option>
              </select>
              <span className="text-sm text-theme-faint">starting</span>
              <select value={constStart} onChange={e => setConstStart(e.target.value)} className="input w-36">
                {monthOpts.slice(1).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          </div>
        )}

        {entryMode === 'varying' && (
          <MonthlyGrid label="How much will you receive and when?" helpText="Enter the investment amount (in Rs) for each period."
            months={months} values={monthlyValues}
            onChange={(m, v) => setMonthlyValues(prev => ({ ...prev, [m]: v }))}
            onReset={() => setMonthlyValues({})} />
        )}
      </div>
      <div className="flex items-center gap-3 pt-4 border-t border-dark-400/30">
        <button onClick={() => onSave({ entry_mode: entryMode, amount, invest_month: investMonth, const_period: constPeriod, const_start: constStart, monthly_values: monthlyValues }, buildValues())} className="btn-primary text-sm">Create & Exit</button>
        <button onClick={onDiscard} className="text-sm text-accent-400 hover:text-accent-300 font-medium">Discard & Exit</button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// Main FinancingTab
// ═══════════════════════════════════════════════════════════════
export default function FinancingTab({ category, label, scenario, months, viewMode, items, allItems, allValues, settings, onReload, readOnly }: Props) {
  const [showModal, setShowModal] = useState(false);
  const [finName, setFinName] = useState('');
  const [finType, setFinType] = useState('');
  const [editingItem, setEditingItem] = useState<ForecastItem | null>(null);
  const [showChart, setShowChart] = useState(true);
  const [chartView, setChartView] = useState<'flow' | 'balance'>('flow');
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);

  // Totals per month
  const monthlyTotals: Record<string, number> = {};
  months.forEach(m => { monthlyTotals[m] = items.reduce((sum, item) => sum + (allValues[item.id]?.[m] || 0), 0); });
  const grandTotal = Object.values(monthlyTotals).reduce((s, v) => s + v, 0);

  // Chart data
  const chartData = useMemo(() => {
    if (chartView === 'balance') {
      let cum = 0;
      return months.map(m => {
        cum += monthlyTotals[m] || 0;
        return { month: getMonthLabel(m), value: cum };
      });
    }
    return months.map(m => ({ month: getMonthLabel(m), value: monthlyTotals[m] || 0 }));
  }, [months, monthlyTotals, chartView]);

  // Create financing item
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
    await onReload();
    const newItem = { ...res.data, meta: res.data.meta ? JSON.parse(res.data.meta) : {} };
    setEditingItem(newItem);
  };

  // Save handlers
  const handleLoanSave = async (meta: Record<string, any>) => {
    if (!editingItem) return;
    await api.put(`/forecast-module/items/${editingItem.id}`, { name: editingItem.name, meta: { ...editingItem.meta, ...meta } });

    const { receive_amount, num_payments, interest_rate, receive_month } = meta;
    if (receive_amount && num_payments) {
      const monthlyRate = (interest_rate || 0) / 100 / 12;
      let emi: number;
      if (monthlyRate > 0) {
        emi = receive_amount * monthlyRate * Math.pow(1 + monthlyRate, num_payments) / (Math.pow(1 + monthlyRate, num_payments) - 1);
      } else {
        emi = receive_amount / num_payments;
      }
      emi = Math.round(emi);
      const startIdx = receive_month === 'before_start' ? 0 : Math.max(0, months.indexOf(receive_month));
      const entries: { month: string; amount: number }[] = [];
      for (let i = 0; i < num_payments && startIdx + i < months.length; i++) {
        entries.push({ month: months[startIdx + i], amount: emi });
      }
      if (entries.length > 0) await api.post('/forecast-module/values/bulk', { item_id: editingItem.id, entries });
    }
    setEditingItem(null);
    await onReload();
  };

  const handleCreditSave = async (meta: Record<string, any>, withdrawals: Record<string, number>, payments: Record<string, number>) => {
    if (!editingItem) return;
    await api.put(`/forecast-module/items/${editingItem.id}`, { name: editingItem.name, meta: { ...editingItem.meta, ...meta } });
    const entries: { month: string; amount: number }[] = [];
    months.forEach(m => {
      const w = withdrawals[m] || 0;
      const p = payments[m] || 0;
      const net = w - p;
      if (net !== 0) entries.push({ month: m, amount: net });
    });
    if (entries.length > 0) await api.post('/forecast-module/values/bulk', { item_id: editingItem.id, entries });
    setEditingItem(null);
    await onReload();
  };

  const handleInvestmentSave = async (meta: Record<string, any>, values: Record<string, number>) => {
    if (!editingItem) return;
    await api.put(`/forecast-module/items/${editingItem.id}`, { name: editingItem.name, meta: { ...editingItem.meta, ...meta } });
    const entries = Object.entries(values).filter(([_, v]) => v !== 0).map(([month, amount]) => ({ month, amount }));
    if (entries.length > 0) await api.post('/forecast-module/values/bulk', { item_id: editingItem.id, entries });
    setEditingItem(null);
    await onReload();
  };

  const handleDiscard = () => setShowDiscardConfirm(true);

  const confirmDiscard = async () => {
    if (editingItem) {
      const hasValues = Object.keys(allValues[editingItem.id] || {}).some(m => (allValues[editingItem.id]?.[m] || 0) !== 0);
      if (!hasValues) await api.delete(`/forecast-module/items/${editingItem.id}`);
    }
    setShowDiscardConfirm(false);
    setEditingItem(null);
    await onReload();
  };

  const handleDuplicate = async (item: ForecastItem) => {
    if (!scenario) return;
    const res = await api.post('/forecast-module/items', {
      scenario_id: scenario.id, category: 'financing', name: `${item.name} (Copy)`,
      item_type: item.item_type, entry_mode: item.entry_mode, meta: item.meta,
    });
    const vals = allValues[item.id];
    if (vals && Object.keys(vals).length > 0) {
      await api.post('/forecast-module/values', { item_id: res.data.id, values: Object.entries(vals).map(([month, amount]) => ({ month, amount })) });
    }
    await onReload();
  };

  // ─── Editing view ───
  if (editingItem && !readOnly) {
    const typeLabel = editingItem.item_type === 'loan' ? 'Loan'
      : editingItem.item_type === 'line_of_credit' ? 'Line of Credit'
      : editingItem.item_type === 'investment' ? 'Investment'
      : 'Other Financing';

    return (
      <div>
        <button onClick={handleDiscard} className="flex items-center gap-1.5 text-sm text-accent-400 hover:text-accent-300 mb-4">
          <ArrowLeft size={14} /> Back to Financing
        </button>
        <div className="mb-5">
          <span className="text-xs font-medium text-theme-faint bg-dark-600 px-2 py-0.5 rounded">{typeLabel}</span>
          <h2 className="text-xl font-bold text-theme-heading mt-1">{editingItem.name}</h2>
        </div>
        <div className="card">
          {editingItem.item_type === 'loan' && <LoanEditor item={editingItem} months={months} onSave={handleLoanSave} onDiscard={handleDiscard} />}
          {editingItem.item_type === 'line_of_credit' && <CreditLineEditor item={editingItem} months={months} onSave={handleCreditSave} onDiscard={handleDiscard} />}
          {editingItem.item_type === 'investment' && <InvestmentEditor item={editingItem} months={months} onSave={handleInvestmentSave} onDiscard={handleDiscard} />}
          {editingItem.item_type === 'other' && <CreditLineEditor item={editingItem} months={months} onSave={handleCreditSave} onDiscard={handleDiscard} isOther />}
        </div>

        {/* Discard confirmation */}
        {showDiscardConfirm && (
          <>
            <div className="fixed inset-0 bg-black/60 z-50" onClick={() => setShowDiscardConfirm(false)} />
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
              <div className="bg-dark-700 border border-dark-400/50 rounded-xl shadow-2xl w-full max-w-sm animate-fade-in p-6">
                <h3 className="text-lg font-semibold text-theme-heading mb-2">Discard?</h3>
                <p className="text-sm text-theme-secondary mb-5">Are you sure you want to discard this forecast item?</p>
                <div className="flex justify-end gap-3">
                  <button onClick={() => setShowDiscardConfirm(false)} className="btn-secondary text-sm">Cancel</button>
                  <button onClick={confirmDiscard} className="btn-primary text-sm">Discard</button>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    );
  }

  // ─── Listing view ───
  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-bold text-theme-heading">{label}</h2>
          <span className="text-xs px-2.5 py-1 rounded-full bg-amber-500/10 text-amber-400 font-medium cursor-pointer">In Progress</span>
        </div>
        <div className="flex items-center gap-2">
          {items.length > 0 && (
            <button onClick={() => exportTableCSV(items, allValues, months, viewMode, category, label)}
              className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-theme-faint hover:text-theme-secondary hover:bg-dark-500 rounded-lg transition-colors border border-dark-400/50" title="Download table as CSV">
              <FileDown size={14} /> CSV
            </button>
          )}
          <button onClick={() => setShowChart(!showChart)}
            className={`p-2 rounded-lg border border-dark-400/50 transition-colors ${showChart ? 'text-theme-faint hover:text-theme-secondary' : 'text-theme-faint/50'}`}
            title={showChart ? 'Hide Charts' : 'Show Charts'}>
            <BarChart3 size={14} />
          </button>
          {!readOnly && (
            <button onClick={() => setShowModal(true)} className="btn-primary flex items-center gap-2 text-sm">
              <Plus size={16} /> Add Financing
            </button>
          )}
        </div>
      </div>

      {/* Chart */}
      {showChart && items.length > 0 && (
        <>
          <div className="flex justify-end mb-2">
            <div className="flex bg-dark-500 rounded-lg p-1">
              <button onClick={() => setChartView('flow')}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${chartView === 'flow' ? 'bg-dark-700 shadow-sm text-accent-400' : 'text-theme-faint'}`}>
                Cash Flow</button>
              <button onClick={() => setChartView('balance')}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${chartView === 'balance' ? 'bg-dark-700 shadow-sm text-accent-400' : 'text-theme-faint'}`}>
                Cash Balance</button>
            </div>
          </div>
          <div className="card mb-4">
            <h3 className="text-sm font-semibold text-theme-muted mb-3">{chartView === 'flow' ? 'Cash Flow' : 'Cash Balance'}</h3>
            <div className="h-48">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData}>
                  <defs>
                    <linearGradient id="gradFinancing" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1a1a28" />
                  <XAxis dataKey="month" tick={{ fontSize: 11 }} stroke="#94a3b8" />
                  <YAxis tick={{ fontSize: 11 }} stroke="#94a3b8" tickFormatter={v => `Rs${(v / 1000).toFixed(0)}k`} />
                  <Tooltip formatter={(value: number) => [formatRs(value)]} contentStyle={{ borderRadius: 8, fontSize: 12, backgroundColor: '#14141f', borderColor: '#2a2a3d', color: '#e2e8f0' }} />
                  <Area type="monotone" dataKey="value" stroke="#6366f1" strokeWidth={2} strokeDasharray="5 3" fill="url(#gradFinancing)"
                    dot={{ r: 3, fill: 'transparent', stroke: '#6366f1', strokeWidth: 2 }} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <div className="flex items-center gap-4 mt-2 text-xs text-theme-faint">
              <span className="flex items-center gap-1.5"><span className="w-3 h-0.5 inline-block" style={{ borderTop: '2px dashed #6366f1' }} /> Forecast</span>
            </div>
          </div>
        </>
      )}

      {/* Data Table */}
      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm" style={{ minWidth: months.length * 100 + 300 }}>
          <thead>
            <tr className="border-b border-dark-400/50 bg-dark-600">
              <th className="text-left py-3 px-4 font-semibold text-theme-muted sticky left-0 bg-dark-600 z-10 min-w-[240px]">
                <div className="flex items-center gap-2">
                  <span>Financing</span>
                  <button className="text-xs text-theme-muted hover:text-theme-secondary border border-dark-400 rounded px-2 py-0.5">Reorder</button>
                </div>
              </th>
              {months.map(m => (
                <th key={m} className="text-right py-3 px-3 font-semibold text-theme-muted whitespace-nowrap min-w-[100px]">{getMonthLabel(m)}</th>
              ))}
              <th className="text-right py-3 px-4 font-semibold text-theme-muted bg-dark-500 min-w-[120px]">Total</th>
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
                      {!readOnly && <GripVertical size={14} className="text-theme-secondary cursor-grab opacity-0 group-hover:opacity-100" />}
                      {readOnly ? (
                        <span className="text-theme-secondary font-medium">{item.name}</span>
                      ) : (
                        <button onClick={() => setEditingItem(item)} className="text-accent-400 hover:text-accent-300 font-medium hover:underline text-left">
                          {item.name}
                        </button>
                      )}
                      <span className="text-[10px] text-theme-faint bg-dark-500 px-1.5 py-0.5 rounded">
                        {item.item_type === 'loan' ? 'Loan' : item.item_type === 'line_of_credit' ? 'LOC' : item.item_type === 'investment' ? 'Inv' : 'Other'}
                      </span>
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
                  {months.map(m => (
                    <td key={m} className="text-right py-2.5 px-3 text-theme-secondary tabular-nums">
                      {itemValues[m] ? formatRs(itemValues[m]) : <span className="text-theme-secondary">-</span>}
                    </td>
                  ))}
                  <td className="text-right py-2.5 px-4 font-semibold text-theme-heading bg-dark-600 tabular-nums">{formatRs(rowTotal)}</td>
                </tr>
              );
            })}

            {!readOnly && (
              <tr className="border-b border-dark-400/30">
                <td className="py-2.5 px-4 sticky left-0 bg-dark-700 z-10" colSpan={months.length + 2}>
                  <button onClick={() => setShowModal(true)} className="flex items-center gap-2 text-sm text-accent-400 hover:text-accent-300">
                    <Plus size={14} /> Add financing
                  </button>
                </td>
              </tr>
            )}

            {/* Totals */}
            <tr className="border-t-2 border-accent-500/30 bg-dark-600 font-semibold">
              <td className="py-3 px-4 text-theme-secondary sticky left-0 bg-dark-600 z-10">Amount received</td>
              {months.map(m => (
                <td key={m} className="text-right py-3 px-3 text-theme-heading tabular-nums">{formatRs(monthlyTotals[m] || 0)}</td>
              ))}
              <td className="text-right py-3 px-4 text-theme-heading bg-dark-500 tabular-nums">{formatRs(grandTotal)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Create Financing Modal */}
      {showModal && (
        <>
          <div className="fixed inset-0 bg-black/60 z-50" onClick={() => { setShowModal(false); setFinName(''); setFinType(''); }} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="bg-dark-700 border border-dark-400/50 rounded-xl shadow-2xl w-full max-w-lg animate-fade-in">
              <div className="flex items-center justify-between p-5 border-b border-dark-400/30">
                <h3 className="text-lg font-semibold text-theme-heading">Create a Financing Item</h3>
                <button onClick={() => { setShowModal(false); setFinName(''); setFinType(''); }} className="text-theme-faint hover:text-theme-secondary"><X size={18} /></button>
              </div>
              <div className="p-5 space-y-5">
                <div>
                  <input type="text" value={finName} onChange={e => setFinName(e.target.value.slice(0, 255))} placeholder="Financing Name" className="input w-full" maxLength={255} />
                  <div className="text-right text-xs text-theme-faint mt-1">{finName.length} of 255</div>
                </div>
                <div>
                  <p className="text-sm font-medium text-theme-secondary mb-3">What type of financing do you want?</p>
                  <div className="grid grid-cols-2 gap-3">
                    {FINANCING_TYPES.map(ft => (
                      <button key={ft.value} onClick={() => setFinType(ft.value)}
                        className={`text-left p-3 rounded-lg border-2 transition-colors ${finType === ft.value ? 'border-accent-500 bg-accent-500/10' : 'border-dark-400/50 border-dashed hover:border-dark-300'}`}>
                        <div className="font-medium text-sm text-theme-heading mb-1">{ft.label}</div>
                        <div className="text-xs text-theme-faint leading-relaxed">{ft.desc}</div>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <div className="flex justify-end p-5 border-t border-dark-400/30">
                <button onClick={handleCreateFinancing} disabled={!finName.trim() || !finType} className="btn-primary text-sm disabled:opacity-40 disabled:cursor-not-allowed">Continue</button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
