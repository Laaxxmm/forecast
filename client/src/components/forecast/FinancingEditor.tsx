import { useState, useMemo, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ChevronDown, ChevronRight, RotateCcw, Info } from 'lucide-react';
import { ForecastItem, Scenario, getMonthLabel, formatRs } from '../../pages/ForecastModulePage';
import api from '../../api/client';

interface Props {
  items: ForecastItem[];
  allValues: Record<number, Record<string, number>>;
  months: string[];
  scenario: Scenario | null;
  onReload: () => Promise<void>;
}

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

function getStartYear(months: string[]): number {
  if (!months.length) return new Date().getFullYear();
  return parseInt(months[0].split('-')[0]);
}

// ─── Loan Editor ───
function LoanEditor({ item, months, onSave, onDiscard }: {
  item: ForecastItem; months: string[];
  onSave: (meta: Record<string, any>) => void; onDiscard: () => void;
}) {
  const [showTips, setShowTips] = useState(false);
  const meta = item.meta || {};
  const [receiveMonth, setReceiveMonth] = useState(meta.receive_month || 'before_start');
  const [receiveAmount, setReceiveAmount] = useState(meta.receive_amount || 0);
  const [numPayments, setNumPayments] = useState(meta.num_payments || 12);
  const [rateMode, setRateMode] = useState(meta.rate_mode || 'constant');
  const [interestRate, setInterestRate] = useState(meta.interest_rate || 0);

  const monthOpts = getMonthOptions(months);

  return (
    <div className="space-y-6">
      {/* Tips */}
      <button
        onClick={() => setShowTips(!showTips)}
        className="flex items-center gap-2 text-sm text-accent-400 hover:text-accent-300"
      >
        <Info size={14} />
        <span>Tips</span>
        {showTips ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {showTips && (
        <div className="bg-dark-600/50 border border-dark-400/30 rounded-lg p-4 text-sm text-theme-faint space-y-2">
          <p>Don't add your loan payments as a separate expense — they're tracked here automatically.</p>
          <p>This feature assumes a standard repayment schedule.</p>
          <p>If you choose variable interest rates, payment amounts adjust as the rate changes.</p>
          <p>For variable interest rates, the annual rate is divided by 12 for monthly calculations.</p>
        </div>
      )}

      {/* Fields */}
      <div className="space-y-5">
        <div>
          <label className="block text-sm font-medium text-theme-secondary mb-2">When will you receive it?</label>
          <select value={receiveMonth} onChange={e => setReceiveMonth(e.target.value)} className="input w-full">
            {monthOpts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-theme-secondary mb-2">How much will you receive?</label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-theme-faint text-sm">Rs</span>
            <input
              type="number"
              value={receiveAmount || ''}
              onChange={e => setReceiveAmount(Number(e.target.value))}
              className="input w-full pl-8"
              placeholder="0"
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-theme-secondary mb-2">How many monthly payments will you make?</label>
          <input
            type="number"
            value={numPayments || ''}
            onChange={e => setNumPayments(Number(e.target.value))}
            className="input w-48"
            placeholder="12"
            min={1}
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-theme-secondary mb-2">How do you want to enter the interest rate?</label>
          <select value={rateMode} onChange={e => setRateMode(e.target.value)} className="input w-64">
            <option value="constant">Constant rate</option>
            <option value="variable">Variable rate</option>
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-theme-secondary mb-2">What is the interest rate?</label>
          <div className="relative w-32">
            <input
              type="number"
              value={interestRate || ''}
              onChange={e => setInterestRate(Number(e.target.value))}
              className="input w-full pr-8"
              placeholder="0"
              step={0.1}
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-theme-faint text-sm">%</span>
          </div>
          <p className="text-xs text-theme-faint mt-1.5">If you are not sure what interest rate you are paying on this loan, check your financing documents.</p>
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-3 pt-4 border-t border-dark-400/30">
        <button
          onClick={() => onSave({ receive_month: receiveMonth, receive_amount: receiveAmount, num_payments: numPayments, rate_mode: rateMode, interest_rate: interestRate })}
          className="btn-primary text-sm"
        >
          Save & Exit
        </button>
        <button onClick={onDiscard} className="btn-secondary text-sm">Discard & Exit</button>
      </div>
    </div>
  );
}

// ─── Monthly Grid (for Line of Credit / Other / Investment varying) ───
function MonthlyGrid({ label, helpText, months, values, onChange, onReset }: {
  label: string; helpText: string;
  months: string[];
  values: Record<string, number>;
  onChange: (month: string, val: number) => void;
  onReset: () => void;
}) {
  const startYear = getStartYear(months);
  // Group months into years
  const yearGroups = useMemo(() => {
    const groups: Record<number, string[]> = {};
    months.forEach(m => {
      const yr = parseInt(m.split('-')[0]);
      if (!groups[yr]) groups[yr] = [];
      groups[yr].push(m);
    });
    return groups;
  }, [months]);

  const years = Object.keys(yearGroups).map(Number).sort();

  return (
    <div className="space-y-3">
      <div>
        <h4 className="text-sm font-medium text-theme-secondary">{label}</h4>
        <p className="text-xs text-theme-faint mt-1">{helpText}</p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm" style={{ minWidth: 900 }}>
          <thead>
            <tr className="border-b border-dark-400/50">
              <th className="text-left py-2 px-2 text-theme-faint font-medium w-20"></th>
              {MONTH_COLS.map(m => (
                <th key={m} className="text-center py-2 px-1 text-theme-faint font-medium text-xs w-16">{m}</th>
              ))}
              <th className="text-right py-2 px-2 text-theme-faint font-medium text-xs">TOTAL</th>
            </tr>
          </thead>
          <tbody>
            {years.map(yr => {
              const yrMonths = yearGroups[yr];
              const total = yrMonths.reduce((s, m) => s + (values[m] || 0), 0);
              return (
                <tr key={yr} className="border-b border-dark-400/30">
                  <td className="py-1.5 px-2 text-theme-secondary font-medium text-xs">{yr}</td>
                  {MONTH_COLS.map((_, mi) => {
                    const monthStr = `${yr}-${String(mi + 1).padStart(2, '0')}`;
                    const isInRange = yrMonths.includes(monthStr);
                    return (
                      <td key={mi} className="py-1 px-0.5">
                        {isInRange ? (
                          <input
                            type="number"
                            value={values[monthStr] || ''}
                            onChange={e => onChange(monthStr, Number(e.target.value))}
                            className="input text-xs text-center w-full py-1 px-1"
                            placeholder="0"
                          />
                        ) : (
                          <span className="text-theme-faint text-xs text-center block">-</span>
                        )}
                      </td>
                    );
                  })}
                  <td className="text-right py-1.5 px-2 text-theme-secondary text-xs font-medium tabular-nums">
                    {total ? formatRs(total) : '-'}
                  </td>
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

// ─── Line of Credit / Other Financing Editor ───
function CreditLineEditor({ item, months, allValues: itemValues, onSave, onDiscard }: {
  item: ForecastItem; months: string[];
  allValues: Record<string, number>;
  onSave: (meta: Record<string, any>, withdrawals: Record<string, number>, payments: Record<string, number>) => void;
  onDiscard: () => void;
}) {
  const [tab, setTab] = useState<'terms' | 'withdrawals' | 'payments'>('terms');
  const [showTips, setShowTips] = useState(false);
  const meta = item.meta || {};

  const [creditLimit, setCreditLimit] = useState(meta.credit_limit || 0);
  const [existingBalance, setExistingBalance] = useState(meta.existing_balance || 0);
  const [rateMode, setRateMode] = useState(meta.rate_mode || 'constant');
  const [interestRate, setInterestRate] = useState(meta.interest_rate || 0);

  const [withdrawals, setWithdrawals] = useState<Record<string, number>>(meta.withdrawals || {});
  const [payments, setPayments] = useState<Record<string, number>>(meta.payments || {});

  const startMonth = months[0];
  const [startY, startM] = startMonth ? startMonth.split('-') : ['2026', '04'];
  const planStartLabel = `${MONTH_NAMES[parseInt(startM)]} ${startY}`;

  const tabs = [
    { key: 'terms' as const, label: 'Terms' },
    { key: 'withdrawals' as const, label: 'Withdrawals' },
    { key: 'payments' as const, label: 'Payments' },
  ];

  return (
    <div className="space-y-5">
      {/* Tabs */}
      <div className="flex border-b border-dark-400/30">
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              tab === t.key ? 'border-accent-500 text-accent-400' : 'border-transparent text-theme-faint hover:text-theme-secondary'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'terms' && (
        <div className="space-y-5">
          <div>
            <label className="block text-sm font-medium text-theme-secondary mb-2">What is its credit limit?</label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-theme-faint text-sm">Rs</span>
              <input type="number" value={creditLimit || ''} onChange={e => setCreditLimit(Number(e.target.value))} className="input w-full pl-8" placeholder="0" />
            </div>
            <p className="text-xs text-theme-faint mt-1">Enter the maximum amount you are allowed to have as an outstanding balance on this line of credit.</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-theme-secondary mb-2">Does it have an existing balance as of your start date?</label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-theme-faint text-sm">Rs</span>
              <input type="number" value={existingBalance || ''} onChange={e => setExistingBalance(Number(e.target.value))} className="input w-full pl-8" placeholder="0" />
            </div>
            <p className="text-xs text-theme-faint mt-1">Your forecast starts in {planStartLabel}. If this line of credit was already in place before that, enter the amount that was owed as of that date.</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-theme-secondary mb-2">How do you want to enter the interest rate?</label>
            <select value={rateMode} onChange={e => setRateMode(e.target.value)} className="input w-64">
              <option value="constant">Constant rate</option>
              <option value="variable">Variable rate</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-theme-secondary mb-2">What is the interest rate?</label>
            <div className="relative w-32">
              <input type="number" value={interestRate || ''} onChange={e => setInterestRate(Number(e.target.value))} className="input w-full pr-8" placeholder="0" step={0.1} />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-theme-faint text-sm">%</span>
            </div>
          </div>

          <div className="flex justify-end">
            <button onClick={() => setTab('withdrawals')} className="text-sm text-accent-400 hover:text-accent-300 font-medium">
              Withdrawals →
            </button>
          </div>
        </div>
      )}

      {tab === 'withdrawals' && (
        <div className="space-y-4">
          <MonthlyGrid
            label="How much will you withdraw from — or, if this is a credit card, charge against — this credit line and when?"
            helpText="Enter the amount (in Rs) that you plan to draw in each period."
            months={months}
            values={withdrawals}
            onChange={(m, v) => setWithdrawals(prev => ({ ...prev, [m]: v }))}
            onReset={() => setWithdrawals({})}
          />
          <div className="flex justify-between">
            <button onClick={() => setTab('terms')} className="text-sm text-accent-400 hover:text-accent-300 font-medium">← Terms</button>
            <button onClick={() => setTab('payments')} className="text-sm text-accent-400 hover:text-accent-300 font-medium">Payments →</button>
          </div>
        </div>
      )}

      {tab === 'payments' && (
        <div className="space-y-4">
          <MonthlyGrid
            label="How much will you pay back against the balance and when?"
            helpText="Enter the actual amount (in Rs) that you want to pay in each period against the outstanding balance."
            months={months}
            values={payments}
            onChange={(m, v) => setPayments(prev => ({ ...prev, [m]: v }))}
            onReset={() => setPayments({})}
          />
          <div className="flex justify-start">
            <button onClick={() => setTab('withdrawals')} className="text-sm text-accent-400 hover:text-accent-300 font-medium">← Withdrawals</button>
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-3 pt-4 border-t border-dark-400/30">
        <button
          onClick={() => onSave({ credit_limit: creditLimit, existing_balance: existingBalance, rate_mode: rateMode, interest_rate: interestRate, withdrawals, payments }, withdrawals, payments)}
          className="btn-primary text-sm"
        >
          Save & Exit
        </button>
        <button onClick={onDiscard} className="btn-secondary text-sm">Discard & Exit</button>
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
  const [showTips, setShowTips] = useState(false);
  const meta = item.meta || {};
  const [entryMode, setEntryMode] = useState(meta.entry_mode || 'one_time');
  const [amount, setAmount] = useState(meta.amount || 0);
  const [investMonth, setInvestMonth] = useState(meta.invest_month || months[0]);
  const [monthlyValues, setMonthlyValues] = useState<Record<string, number>>(meta.monthly_values || {});

  const monthOpts = months.map(m => {
    const [y, mo] = m.split('-');
    return { value: m, label: `${MONTH_NAMES[parseInt(mo)]} ${y}` };
  });

  // Build values based on entry mode
  const buildValues = (): Record<string, number> => {
    const vals: Record<string, number> = {};
    if (entryMode === 'one_time') {
      if (investMonth && amount) vals[investMonth] = amount;
    } else if (entryMode === 'constant') {
      months.forEach(m => { vals[m] = amount; });
    } else {
      Object.entries(monthlyValues).forEach(([m, v]) => { if (v) vals[m] = v; });
    }
    return vals;
  };

  return (
    <div className="space-y-6">
      {/* Tips */}
      <button onClick={() => setShowTips(!showTips)} className="flex items-center gap-2 text-sm text-accent-400 hover:text-accent-300">
        <Info size={14} /> <span>Tips</span>
        {showTips ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {showTips && (
        <div className="bg-dark-600/50 border border-dark-400/30 rounded-lg p-4 text-sm text-theme-faint space-y-2">
          <p>Equity investments are injections of cash in exchange for partial ownership of the company.</p>
          <p>Record the total amount you expect to receive and when.</p>
        </div>
      )}

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
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <label className="block text-sm font-medium text-theme-secondary mb-2">How much will you receive and when?</label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-theme-faint text-sm">Rs</span>
                <input type="number" value={amount || ''} onChange={e => setAmount(Number(e.target.value))} className="input w-full pl-8" placeholder="0" />
              </div>
            </div>
            <select value={investMonth} onChange={e => setInvestMonth(e.target.value)} className="input w-36">
              {monthOpts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
        )}

        {entryMode === 'constant' && (
          <div>
            <label className="block text-sm font-medium text-theme-secondary mb-2">How much will you receive each month?</label>
            <div className="relative w-48">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-theme-faint text-sm">Rs</span>
              <input type="number" value={amount || ''} onChange={e => setAmount(Number(e.target.value))} className="input w-full pl-8" placeholder="0" />
            </div>
          </div>
        )}

        {entryMode === 'varying' && (
          <MonthlyGrid
            label="How much will you receive and when?"
            helpText="Enter the investment amount (in Rs) for each period."
            months={months}
            values={monthlyValues}
            onChange={(m, v) => setMonthlyValues(prev => ({ ...prev, [m]: v }))}
            onReset={() => setMonthlyValues({})}
          />
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-3 pt-4 border-t border-dark-400/30">
        <button
          onClick={() => onSave({ entry_mode: entryMode, amount, invest_month: investMonth, monthly_values: monthlyValues }, buildValues())}
          className="btn-primary text-sm"
        >
          Save & Exit
        </button>
        <button onClick={onDiscard} className="btn-secondary text-sm">Discard & Exit</button>
      </div>
    </div>
  );
}

// ─── Main Financing Editor Router ───
export default function FinancingEditor({ items, allValues, months, scenario, onReload }: Props) {
  const navigate = useNavigate();
  const { itemId, finType } = useParams<{ itemId: string; finType: string }>();
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);

  const item = useMemo(() => items.find(i => i.id === Number(itemId)), [items, itemId]);

  // Load existing values for this item
  const itemValues = useMemo(() => {
    if (!item) return {};
    return allValues[item.id] || {};
  }, [item, allValues]);

  if (!item) {
    return (
      <div className="text-center py-12">
        <p className="text-theme-faint">Financing item not found.</p>
        <button onClick={() => navigate('/forecast/balance-sheet')} className="text-accent-400 hover:text-accent-300 text-sm mt-2">
          ← Back to Balance Sheet
        </button>
      </div>
    );
  }

  const handleDiscard = () => {
    setShowDiscardConfirm(true);
  };

  const confirmDiscard = async () => {
    // Delete the item if it was just created (no values saved yet)
    const hasValues = Object.keys(itemValues).some(m => itemValues[m] !== 0);
    if (!hasValues) {
      await api.delete(`/forecast-module/items/${item.id}`);
    }
    await onReload();
    navigate('/forecast/balance-sheet');
  };

  const handleLoanSave = async (meta: Record<string, any>) => {
    // Save meta to item
    await api.put(`/forecast-module/items/${item.id}`, {
      name: item.name,
      meta: { ...item.meta, ...meta },
    });

    // Calculate monthly EMI values from loan terms
    const { receive_amount, num_payments, interest_rate, receive_month } = meta;
    if (receive_amount && num_payments) {
      const monthlyRate = (interest_rate || 0) / 100 / 12;
      let emi: number;
      if (monthlyRate > 0) {
        emi = receive_amount * monthlyRate * Math.pow(1 + monthlyRate, num_payments)
          / (Math.pow(1 + monthlyRate, num_payments) - 1);
      } else {
        emi = receive_amount / num_payments;
      }
      emi = Math.round(emi);

      // Determine start month for payments
      const startIdx = receive_month === 'before_start' ? 0 : months.indexOf(receive_month);
      const paymentStartIdx = Math.max(0, startIdx === -1 ? 0 : startIdx);

      const entries: { month: string; amount: number }[] = [];
      for (let i = 0; i < num_payments && paymentStartIdx + i < months.length; i++) {
        entries.push({ month: months[paymentStartIdx + i], amount: emi });
      }

      if (entries.length > 0) {
        await api.post('/forecast-module/values/bulk', {
          item_id: item.id,
          entries,
        });
      }
    }

    await onReload();
    navigate('/forecast/balance-sheet');
  };

  const handleCreditSave = async (meta: Record<string, any>, withdrawals: Record<string, number>, payments: Record<string, number>) => {
    await api.put(`/forecast-module/items/${item.id}`, {
      name: item.name,
      meta: { ...item.meta, ...meta },
    });

    // Store net cash flow as values (withdrawals - payments)
    const entries: { month: string; amount: number }[] = [];
    months.forEach(m => {
      const w = withdrawals[m] || 0;
      const p = payments[m] || 0;
      const net = w - p;
      if (net !== 0) entries.push({ month: m, amount: net });
    });

    if (entries.length > 0) {
      await api.post('/forecast-module/values/bulk', { item_id: item.id, entries });
    }

    await onReload();
    navigate('/forecast/balance-sheet');
  };

  const handleInvestmentSave = async (meta: Record<string, any>, values: Record<string, number>) => {
    await api.put(`/forecast-module/items/${item.id}`, {
      name: item.name,
      meta: { ...item.meta, ...meta },
    });

    const entries = Object.entries(values)
      .filter(([_, v]) => v !== 0)
      .map(([month, amount]) => ({ month, amount }));

    if (entries.length > 0) {
      await api.post('/forecast-module/values/bulk', { item_id: item.id, entries });
    }

    await onReload();
    navigate('/forecast/balance-sheet');
  };

  const typeLabel = finType === 'loan' ? 'Loan'
    : finType === 'line-of-credit' ? 'Line of Credit'
    : finType === 'investment' ? 'Investment'
    : 'Other Financing';

  return (
    <div>
      {/* Back nav */}
      <button
        onClick={() => navigate('/forecast/balance-sheet')}
        className="flex items-center gap-1.5 text-sm text-accent-400 hover:text-accent-300 mb-4"
      >
        <ArrowLeft size={14} /> Back to Balance Sheet
      </button>

      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-theme-faint bg-dark-600 px-2 py-0.5 rounded">{typeLabel}</span>
        </div>
        <h2 className="text-xl font-bold text-theme-heading mt-1">{item.name}</h2>
      </div>

      {/* Editor content based on type */}
      <div className="card">
        {finType === 'loan' && (
          <LoanEditor item={item} months={months} onSave={handleLoanSave} onDiscard={handleDiscard} />
        )}
        {(finType === 'line-of-credit' || finType === 'custom-financing') && (
          <CreditLineEditor
            item={item} months={months} allValues={itemValues}
            onSave={handleCreditSave} onDiscard={handleDiscard}
          />
        )}
        {finType === 'investment' && (
          <InvestmentEditor item={item} months={months} onSave={handleInvestmentSave} onDiscard={handleDiscard} />
        )}
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
