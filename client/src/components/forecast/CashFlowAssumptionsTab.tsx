import { useState, useMemo, useCallback } from 'react';
import { ChevronDown, ChevronRight, HelpCircle, Info } from 'lucide-react';
import { Scenario, ForecastItem, formatRs } from '../../pages/ForecastModulePage';
import api from '../../api/client';

interface Props {
  scenario: Scenario | null;
  items: ForecastItem[];
  allItems: ForecastItem[];
  allValues: Record<number, Record<string, number>>;
  settings: Record<string, any>;
  onReload: () => Promise<void>;
  readOnly?: boolean;
}

const DAYS_OPTIONS = [0, 15, 30, 45, 60, 90, 120, 150, 180];

interface ARSetting {
  credit_pct: number;
  days_to_collect: number;
}

interface APSetting {
  credit_pct: number;
  days_to_pay: number;
}

export default function CashFlowAssumptionsTab({ scenario, allItems, settings, onReload, readOnly }: Props) {
  // Section collapse state
  const [arExpanded, setArExpanded] = useState(true);
  const [apExpanded, setApExpanded] = useState(true);

  // Individual vs global toggles
  const [arIndividual, setArIndividual] = useState<boolean>(settings.ar_individual ?? false);
  const [apIndividual, setApIndividual] = useState<boolean>(settings.ap_individual ?? false);

  // Global defaults
  const [arGlobalCredit, setArGlobalCredit] = useState<number>(settings.ar_global_credit_pct ?? 0);
  const [arGlobalDays, setArGlobalDays] = useState<number>(settings.ar_global_days ?? 30);
  const [apGlobalCredit, setApGlobalCredit] = useState<number>(settings.ap_global_credit_pct ?? 0);
  const [apGlobalDays, setApGlobalDays] = useState<number>(settings.ap_global_days ?? 30);

  // Per-item settings: { [itemId]: { credit_pct, days_to_collect/days_to_pay } }
  const [arPerStream, setArPerStream] = useState<Record<number, ARSetting>>(settings.ar_per_stream ?? {});
  const [apPerItem, setApPerItem] = useState<Record<number, APSetting>>(settings.ap_per_item ?? {});

  // Inventory
  const [inventoryEnabled, setInventoryEnabled] = useState<boolean>(settings.inventory_enabled ?? false);
  const [inventoryMonths, setInventoryMonths] = useState<number>(settings.inventory_months ?? 1);
  const [inventoryMinOrder, setInventoryMinOrder] = useState<number>(settings.inventory_min_order ?? 0);
  const [minOrderInput, setMinOrderInput] = useState<string>(String(settings.inventory_min_order ?? 0));

  // Tooltip state
  const [activeTooltip, setActiveTooltip] = useState<string | null>(null);

  // Derived item lists
  const revenueItems = useMemo(() => allItems.filter(i => i.category === 'revenue'), [allItems]);
  const directCostItems = useMemo(() => allItems.filter(i => i.category === 'direct_costs'), [allItems]);
  const expenseItems = useMemo(() => allItems.filter(i => i.category === 'expenses'), [allItems]);

  // Save helper
  const saveSetting = useCallback(async (key: string, value: any) => {
    if (!scenario || scenario.id === -1 || readOnly) return;
    try {
      await api.post('/forecast-module/settings', {
        scenario_id: scenario.id,
        settings: { [key]: value },
      });
    } catch (err) {
      console.error('Failed to save cash flow setting:', err);
    }
  }, [scenario, readOnly]);

  const saveMultiple = useCallback(async (pairs: Record<string, any>) => {
    if (!scenario || scenario.id === -1 || readOnly) return;
    try {
      await api.post('/forecast-module/settings', {
        scenario_id: scenario.id,
        settings: pairs,
      });
    } catch (err) {
      console.error('Failed to save cash flow settings:', err);
    }
  }, [scenario, readOnly]);

  // AR handlers
  const handleArIndividualToggle = (checked: boolean) => {
    setArIndividual(checked);
    saveSetting('ar_individual', checked);
  };

  const handleArGlobalCreditBlur = () => {
    saveSetting('ar_global_credit_pct', arGlobalCredit);
  };

  const handleArGlobalDaysChange = (days: number) => {
    setArGlobalDays(days);
    saveSetting('ar_global_days', days);
  };

  const handleArStreamCredit = (itemId: number, value: number) => {
    const updated = { ...arPerStream, [itemId]: { ...arPerStream[itemId] || { credit_pct: 0, days_to_collect: 30 }, credit_pct: value } };
    setArPerStream(updated);
    saveSetting('ar_per_stream', updated);
  };

  const handleArStreamDays = (itemId: number, value: number) => {
    const updated = { ...arPerStream, [itemId]: { ...arPerStream[itemId] || { credit_pct: 0, days_to_collect: 30 }, days_to_collect: value } };
    setArPerStream(updated);
    saveSetting('ar_per_stream', updated);
  };

  // AP handlers
  const handleApIndividualToggle = (checked: boolean) => {
    setApIndividual(checked);
    saveSetting('ap_individual', checked);
  };

  const handleApGlobalCreditBlur = () => {
    saveSetting('ap_global_credit_pct', apGlobalCredit);
  };

  const handleApGlobalDaysChange = (days: number) => {
    setApGlobalDays(days);
    saveSetting('ap_global_days', days);
  };

  const handleApItemCredit = (itemId: number, value: number) => {
    const updated = { ...apPerItem, [itemId]: { ...apPerItem[itemId] || { credit_pct: 0, days_to_pay: 30 }, credit_pct: value } };
    setApPerItem(updated);
    saveSetting('ap_per_item', updated);
  };

  const handleApItemDays = (itemId: number, value: number) => {
    const updated = { ...apPerItem, [itemId]: { ...apPerItem[itemId] || { credit_pct: 0, days_to_pay: 30 }, days_to_pay: value } };
    setApPerItem(updated);
    saveSetting('ap_per_item', updated);
  };

  // Inventory handlers
  const handleInventoryToggle = (enabled: boolean) => {
    setInventoryEnabled(enabled);
    saveSetting('inventory_enabled', enabled);
  };

  const handleInventoryMonths = (months: number) => {
    setInventoryMonths(months);
    saveSetting('inventory_months', months);
  };

  const handleApplyMinOrder = () => {
    const val = parseFloat(minOrderInput) || 0;
    setInventoryMinOrder(val);
    saveSetting('inventory_min_order', val);
  };

  // Tooltip component
  const Tooltip = ({ id, text }: { id: string; text: string }) => (
    <span className="relative inline-block">
      <button
        onClick={() => setActiveTooltip(activeTooltip === id ? null : id)}
        className="text-theme-faint hover:text-theme-secondary ml-1"
      >
        <HelpCircle size={14} />
      </button>
      {activeTooltip === id && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setActiveTooltip(null)} />
          <div className="absolute z-50 bottom-full left-1/2 -translate-x-1/2 mb-2 w-64 bg-dark-600 border border-dark-400/50 rounded-lg p-3 shadow-lg text-xs text-theme-faint leading-relaxed">
            {text}
            <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-dark-600" />
          </div>
        </>
      )}
    </span>
  );

  return (
    <div className="max-w-[900px]">
      {/* Page Header */}
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-theme-heading">Cash Flow Assumptions</h2>
        <p className="text-sm text-theme-faint mt-1">
          Configure how cash moves through your business — when you collect from customers and when you pay vendors.
        </p>
      </div>

      {/* ── ACCOUNTS RECEIVABLE ── */}
      <div className="card mb-4 overflow-hidden">
        <button
          onClick={() => setArExpanded(!arExpanded)}
          className="w-full flex items-center justify-between px-6 py-4 hover:bg-dark-600/50 transition-colors"
        >
          <div className="flex items-center gap-2">
            {arExpanded ? <ChevronDown size={16} className="text-theme-faint" /> : <ChevronRight size={16} className="text-theme-faint" />}
            <h3 className="text-lg font-bold text-theme-heading">Accounts Receivable</h3>
          </div>
        </button>

        {arExpanded && (
          <div className="px-6 pb-6 border-t border-dark-400/30 pt-5 space-y-5">
            {/* Info box */}
            <div className="bg-dark-600/50 rounded-xl p-4">
              <div className="flex items-center gap-1.5 mb-2">
                <Info size={14} className="text-accent-400" />
                <span className="text-sm font-semibold text-theme-secondary">About accounts receivable</span>
              </div>
              <p className="text-xs text-theme-faint leading-relaxed">
                Accounts receivable tracks how quickly you collect payments from customers. If some of your sales are on credit (invoiced rather than paid immediately), configure the percentage here and how long it typically takes to get paid. This affects your cash flow projections.
              </p>
            </div>

            {/* Individual toggle */}
            {!readOnly && (
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={arIndividual}
                  onChange={e => handleArIndividualToggle(e.target.checked)}
                  className="w-4 h-4 rounded border-dark-400 bg-dark-600 text-accent-500 focus:ring-accent-500/30"
                />
                <span className="text-sm text-theme-secondary">Adjust assumptions for individual revenue streams</span>
              </label>
            )}

            {/* Global or per-stream table */}
            {!arIndividual ? (
              /* Global settings */
              <div className="bg-dark-700 rounded-xl border border-dark-400/50 overflow-hidden">
                <div className="grid grid-cols-3 gap-0">
                  <div className="px-4 py-3 text-xs font-semibold text-theme-faint uppercase tracking-wider border-b border-dark-400/30">
                    Revenue
                  </div>
                  <div className="px-4 py-3 text-xs font-semibold text-theme-faint uppercase tracking-wider border-b border-dark-400/30 flex items-center">
                    Sales on credit
                    <Tooltip id="ar-credit-global" text="The percentage of your sales that are invoiced on credit terms rather than paid immediately. For example, if 50% of sales are on credit, half your revenue will be delayed." />
                  </div>
                  <div className="px-4 py-3 text-xs font-semibold text-theme-faint uppercase tracking-wider border-b border-dark-400/30 flex items-center">
                    Days to get paid
                    <Tooltip id="ar-days-global" text="The average number of days it takes to collect payment after invoicing. Common terms are Net 30 (30 days) or Net 15 (15 days)." />
                  </div>

                  <div className="px-4 py-3 text-sm text-theme-secondary border-b border-dark-400/20">
                    All revenue streams
                  </div>
                  <div className="px-4 py-3 border-b border-dark-400/20">
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        min={0}
                        max={100}
                        value={arGlobalCredit}
                        onChange={e => setArGlobalCredit(Math.min(100, Math.max(0, parseFloat(e.target.value) || 0)))}
                        onBlur={handleArGlobalCreditBlur}
                        disabled={readOnly}
                        className="input w-20 text-sm text-right py-1.5"
                      />
                      <span className="text-sm text-theme-faint">%</span>
                    </div>
                  </div>
                  <div className="px-4 py-3 border-b border-dark-400/20">
                    <select
                      value={arGlobalDays}
                      onChange={e => handleArGlobalDaysChange(Number(e.target.value))}
                      disabled={readOnly}
                      className="input text-sm py-1.5 w-28"
                    >
                      {DAYS_OPTIONS.map(d => (
                        <option key={d} value={d}>{d} days</option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
            ) : (
              /* Per-stream settings */
              <div className="bg-dark-700 rounded-xl border border-dark-400/50 overflow-hidden">
                <div className="grid grid-cols-3 gap-0">
                  <div className="px-4 py-3 text-xs font-semibold text-theme-faint uppercase tracking-wider border-b border-dark-400/30">
                    Revenue stream
                  </div>
                  <div className="px-4 py-3 text-xs font-semibold text-theme-faint uppercase tracking-wider border-b border-dark-400/30 flex items-center">
                    Sales on credit
                    <Tooltip id="ar-credit-ind" text="The percentage of sales for this specific revenue stream that are invoiced on credit rather than paid immediately." />
                  </div>
                  <div className="px-4 py-3 text-xs font-semibold text-theme-faint uppercase tracking-wider border-b border-dark-400/30 flex items-center">
                    Days to get paid
                    <Tooltip id="ar-days-ind" text="The average number of days to collect payment for this revenue stream after invoicing." />
                  </div>

                  {revenueItems.length === 0 ? (
                    <div className="col-span-3 px-4 py-6 text-center text-sm text-theme-faint">
                      No revenue streams defined yet. Add revenue items first.
                    </div>
                  ) : (
                    revenueItems.map(item => {
                      const s = arPerStream[item.id] || { credit_pct: 0, days_to_collect: 30 };
                      return (
                        <div key={item.id} className="contents">
                          <div className="px-4 py-3 text-sm text-theme-secondary border-b border-dark-400/20 flex items-center">
                            {item.name}
                          </div>
                          <div className="px-4 py-3 border-b border-dark-400/20">
                            <div className="flex items-center gap-1">
                              <input
                                type="number"
                                min={0}
                                max={100}
                                value={s.credit_pct}
                                onChange={e => {
                                  const val = Math.min(100, Math.max(0, parseFloat(e.target.value) || 0));
                                  setArPerStream(prev => ({ ...prev, [item.id]: { ...s, credit_pct: val } }));
                                }}
                                onBlur={() => handleArStreamCredit(item.id, arPerStream[item.id]?.credit_pct ?? 0)}
                                disabled={readOnly}
                                className="input w-20 text-sm text-right py-1.5"
                              />
                              <span className="text-sm text-theme-faint">%</span>
                            </div>
                          </div>
                          <div className="px-4 py-3 border-b border-dark-400/20">
                            <select
                              value={s.days_to_collect}
                              onChange={e => handleArStreamDays(item.id, Number(e.target.value))}
                              disabled={readOnly}
                              className="input text-sm py-1.5 w-28"
                            >
                              {DAYS_OPTIONS.map(d => (
                                <option key={d} value={d}>{d} days</option>
                              ))}
                            </select>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── ACCOUNTS PAYABLE ── */}
      <div className="card mb-4 overflow-hidden">
        <button
          onClick={() => setApExpanded(!apExpanded)}
          className="w-full flex items-center justify-between px-6 py-4 hover:bg-dark-600/50 transition-colors"
        >
          <div className="flex items-center gap-2">
            {apExpanded ? <ChevronDown size={16} className="text-theme-faint" /> : <ChevronRight size={16} className="text-theme-faint" />}
            <h3 className="text-lg font-bold text-theme-heading">Accounts Payable</h3>
          </div>
        </button>

        {apExpanded && (
          <div className="px-6 pb-6 border-t border-dark-400/30 pt-5 space-y-5">
            {/* Info box */}
            <div className="bg-dark-600/50 rounded-xl p-4">
              <div className="flex items-center gap-1.5 mb-2">
                <Info size={14} className="text-accent-400" />
                <span className="text-sm font-semibold text-theme-secondary">About accounts payable</span>
              </div>
              <p className="text-xs text-theme-faint leading-relaxed">
                Accounts payable tracks how quickly you pay your vendors and suppliers. If you buy goods or services on credit terms, the percentage and payment timing configured here will affect your cash flow projections.
              </p>
            </div>

            {/* Individual toggle */}
            {!readOnly && (
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={apIndividual}
                  onChange={e => handleApIndividualToggle(e.target.checked)}
                  className="w-4 h-4 rounded border-dark-400 bg-dark-600 text-accent-500 focus:ring-accent-500/30"
                />
                <span className="text-sm text-theme-secondary">Adjust assumptions for individual expenses</span>
              </label>
            )}

            {!apIndividual ? (
              /* Global settings */
              <div className="bg-dark-700 rounded-xl border border-dark-400/50 overflow-hidden">
                <div className="grid grid-cols-3 gap-0">
                  <div className="px-4 py-3 text-xs font-semibold text-theme-faint uppercase tracking-wider border-b border-dark-400/30">
                    Costs & Expenses
                  </div>
                  <div className="px-4 py-3 text-xs font-semibold text-theme-faint uppercase tracking-wider border-b border-dark-400/30 flex items-center">
                    Purchases on credit
                    <Tooltip id="ap-credit-global" text="The percentage of your costs and expenses that you pay on credit terms (invoiced) rather than paying immediately." />
                  </div>
                  <div className="px-4 py-3 text-xs font-semibold text-theme-faint uppercase tracking-wider border-b border-dark-400/30 flex items-center">
                    Days to pay
                    <Tooltip id="ap-days-global" text="The average number of days it takes you to pay your vendors after receiving an invoice." />
                  </div>

                  <div className="px-4 py-3 text-sm text-theme-secondary border-b border-dark-400/20">
                    All costs & expenses
                  </div>
                  <div className="px-4 py-3 border-b border-dark-400/20">
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        min={0}
                        max={100}
                        value={apGlobalCredit}
                        onChange={e => setApGlobalCredit(Math.min(100, Math.max(0, parseFloat(e.target.value) || 0)))}
                        onBlur={handleApGlobalCreditBlur}
                        disabled={readOnly}
                        className="input w-20 text-sm text-right py-1.5"
                      />
                      <span className="text-sm text-theme-faint">%</span>
                    </div>
                  </div>
                  <div className="px-4 py-3 border-b border-dark-400/20">
                    <select
                      value={apGlobalDays}
                      onChange={e => handleApGlobalDaysChange(Number(e.target.value))}
                      disabled={readOnly}
                      className="input text-sm py-1.5 w-28"
                    >
                      {DAYS_OPTIONS.map(d => (
                        <option key={d} value={d}>{d} days</option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
            ) : (
              /* Per-item settings */
              <div className="space-y-5">
                {/* Direct Costs sub-section */}
                <div>
                  <h4 className="text-sm font-bold text-theme-secondary mb-3">Direct Costs</h4>
                  <div className="bg-dark-700 rounded-xl border border-dark-400/50 overflow-hidden">
                    <div className="grid grid-cols-3 gap-0">
                      <div className="px-4 py-3 text-xs font-semibold text-theme-faint uppercase tracking-wider border-b border-dark-400/30">
                        Direct cost
                      </div>
                      <div className="px-4 py-3 text-xs font-semibold text-theme-faint uppercase tracking-wider border-b border-dark-400/30 flex items-center">
                        Purchases on credit
                        <Tooltip id="ap-credit-dc" text="The percentage of this direct cost that you pay on credit terms rather than immediately." />
                      </div>
                      <div className="px-4 py-3 text-xs font-semibold text-theme-faint uppercase tracking-wider border-b border-dark-400/30 flex items-center">
                        Days to pay
                        <Tooltip id="ap-days-dc" text="The average number of days to pay this vendor after receiving an invoice." />
                      </div>

                      {directCostItems.length === 0 ? (
                        <div className="col-span-3 px-4 py-5 text-center text-sm text-theme-faint">
                          You don't have any direct costs yet.
                        </div>
                      ) : (
                        directCostItems.map(item => {
                          const s = apPerItem[item.id] || { credit_pct: 0, days_to_pay: 30 };
                          return (
                            <div key={item.id} className="contents">
                              <div className="px-4 py-3 text-sm text-theme-secondary border-b border-dark-400/20 flex items-center">
                                {item.name}
                              </div>
                              <div className="px-4 py-3 border-b border-dark-400/20">
                                <div className="flex items-center gap-1">
                                  <input
                                    type="number"
                                    min={0}
                                    max={100}
                                    value={s.credit_pct}
                                    onChange={e => {
                                      const val = Math.min(100, Math.max(0, parseFloat(e.target.value) || 0));
                                      setApPerItem(prev => ({ ...prev, [item.id]: { ...s, credit_pct: val } }));
                                    }}
                                    onBlur={() => handleApItemCredit(item.id, apPerItem[item.id]?.credit_pct ?? 0)}
                                    disabled={readOnly}
                                    className="input w-20 text-sm text-right py-1.5"
                                  />
                                  <span className="text-sm text-theme-faint">%</span>
                                </div>
                              </div>
                              <div className="px-4 py-3 border-b border-dark-400/20">
                                <select
                                  value={s.days_to_pay}
                                  onChange={e => handleApItemDays(item.id, Number(e.target.value))}
                                  disabled={readOnly}
                                  className="input text-sm py-1.5 w-28"
                                >
                                  {DAYS_OPTIONS.map(d => (
                                    <option key={d} value={d}>{d} days</option>
                                  ))}
                                </select>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                </div>

                {/* Expenses sub-section */}
                <div>
                  <h4 className="text-sm font-bold text-theme-secondary mb-3">Expenses</h4>
                  <div className="bg-dark-700 rounded-xl border border-dark-400/50 overflow-hidden">
                    <div className="grid grid-cols-3 gap-0">
                      <div className="px-4 py-3 text-xs font-semibold text-theme-faint uppercase tracking-wider border-b border-dark-400/30">
                        Expense
                      </div>
                      <div className="px-4 py-3 text-xs font-semibold text-theme-faint uppercase tracking-wider border-b border-dark-400/30 flex items-center">
                        Purchases on credit
                        <Tooltip id="ap-credit-exp" text="The percentage of this expense that you pay on credit terms rather than immediately." />
                      </div>
                      <div className="px-4 py-3 text-xs font-semibold text-theme-faint uppercase tracking-wider border-b border-dark-400/30 flex items-center">
                        Days to pay
                        <Tooltip id="ap-days-exp" text="The average number of days to pay for this expense after receiving an invoice." />
                      </div>

                      {expenseItems.length === 0 ? (
                        <div className="col-span-3 px-4 py-5 text-center text-sm text-theme-faint">
                          No expenses defined yet.
                        </div>
                      ) : (
                        expenseItems.map(item => {
                          const s = apPerItem[item.id] || { credit_pct: 0, days_to_pay: 30 };
                          return (
                            <div key={item.id} className="contents">
                              <div className="px-4 py-3 text-sm text-theme-secondary border-b border-dark-400/20 flex items-center">
                                {item.name}
                              </div>
                              <div className="px-4 py-3 border-b border-dark-400/20">
                                <div className="flex items-center gap-1">
                                  <input
                                    type="number"
                                    min={0}
                                    max={100}
                                    value={s.credit_pct}
                                    onChange={e => {
                                      const val = Math.min(100, Math.max(0, parseFloat(e.target.value) || 0));
                                      setApPerItem(prev => ({ ...prev, [item.id]: { ...s, credit_pct: val } }));
                                    }}
                                    onBlur={() => handleApItemCredit(item.id, apPerItem[item.id]?.credit_pct ?? 0)}
                                    disabled={readOnly}
                                    className="input w-20 text-sm text-right py-1.5"
                                  />
                                  <span className="text-sm text-theme-faint">%</span>
                                </div>
                              </div>
                              <div className="px-4 py-3 border-b border-dark-400/20">
                                <select
                                  value={s.days_to_pay}
                                  onChange={e => handleApItemDays(item.id, Number(e.target.value))}
                                  disabled={readOnly}
                                  className="input text-sm py-1.5 w-28"
                                >
                                  {DAYS_OPTIONS.map(d => (
                                    <option key={d} value={d}>{d} days</option>
                                  ))}
                                </select>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── INVENTORY ── */}
      <div className="card mb-4 overflow-hidden">
        <div className="px-6 py-4 flex items-center justify-between">
          <h3 className="text-lg font-bold text-theme-heading">Inventory</h3>
          {!readOnly && (
            <button
              onClick={() => handleInventoryToggle(!inventoryEnabled)}
              className={`relative w-12 h-6 rounded-full transition-colors ${inventoryEnabled ? 'bg-accent-500' : 'bg-dark-400'}`}
            >
              <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${inventoryEnabled ? 'left-[26px]' : 'left-0.5'}`} />
            </button>
          )}
          {readOnly && (
            <span className={`text-sm font-medium ${inventoryEnabled ? 'text-green-400' : 'text-theme-faint'}`}>
              {inventoryEnabled ? 'ON' : 'OFF'}
            </span>
          )}
        </div>

        {inventoryEnabled && (
          <div className="px-6 pb-6 border-t border-dark-400/30 pt-5 space-y-5">
            {/* Info box */}
            <div className="bg-dark-600/50 rounded-xl p-4">
              <div className="flex items-center gap-1.5 mb-2">
                <Info size={14} className="text-accent-400" />
                <span className="text-sm font-semibold text-theme-secondary">About inventory</span>
              </div>
              <p className="text-xs text-theme-faint leading-relaxed">
                If your business holds inventory, these settings determine how much stock to keep on hand and minimum order quantities. This affects your cash flow by requiring upfront purchases before sales occur.
              </p>
            </div>

            {/* Warning if no direct costs */}
            {directCostItems.length === 0 && (
              <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-4 flex items-start gap-3">
                <Info size={16} className="text-yellow-400 mt-0.5 flex-shrink-0" />
                <p className="text-sm text-yellow-300">
                  You have no direct costs. Please add direct costs to use the inventory feature effectively.
                </p>
              </div>
            )}

            {/* Two cards side by side */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Months to keep on hand */}
              <div className="bg-dark-700 rounded-xl border border-dark-400/50 p-5">
                <div className="flex items-center gap-1 mb-4">
                  <h4 className="text-sm font-bold text-theme-secondary">Months to keep on hand</h4>
                  <Tooltip id="inv-months" text="How many months' worth of inventory to maintain. A higher number means more cash tied up in inventory but less risk of stockouts." />
                </div>

                {/* Slider */}
                <div className="space-y-3">
                  <input
                    type="range"
                    min={1}
                    max={18}
                    value={inventoryMonths}
                    onChange={e => handleInventoryMonths(Number(e.target.value))}
                    disabled={readOnly}
                    className="w-full accent-accent-500"
                  />
                  <div className="flex justify-between text-[10px] text-theme-faint px-0.5">
                    {Array.from({ length: 18 }, (_, i) => (
                      <span key={i + 1} className={inventoryMonths === i + 1 ? 'text-accent-400 font-bold' : ''}>
                        {i + 1}
                      </span>
                    ))}
                  </div>
                  <div className="text-center">
                    <span className="text-2xl font-bold text-accent-400">{inventoryMonths}</span>
                    <span className="text-sm text-theme-faint ml-1">month{inventoryMonths !== 1 ? 's' : ''}</span>
                  </div>
                </div>
              </div>

              {/* Minimum order size */}
              <div className="bg-dark-700 rounded-xl border border-dark-400/50 p-5">
                <div className="flex items-center gap-1 mb-4">
                  <h4 className="text-sm font-bold text-theme-secondary">Minimum order size</h4>
                  <Tooltip id="inv-min-order" text="The minimum value of each inventory order. If the calculated reorder amount is below this threshold, the order will be bumped up to this minimum." />
                </div>

                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-theme-faint font-medium">Rs</span>
                    <input
                      type="text"
                      value={minOrderInput}
                      onChange={e => setMinOrderInput(e.target.value)}
                      disabled={readOnly}
                      className="input text-sm flex-1 text-right py-2"
                      placeholder="0"
                    />
                  </div>
                  {!readOnly && (
                    <button
                      onClick={handleApplyMinOrder}
                      className="btn-primary w-full py-2 text-sm"
                    >
                      Apply
                    </button>
                  )}
                  {inventoryMinOrder > 0 && (
                    <p className="text-xs text-theme-faint text-center">
                      Current: {formatRs(inventoryMinOrder)}
                    </p>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
