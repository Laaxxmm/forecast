import { useState } from 'react';
import { ArrowLeft, ChevronDown, ChevronRight, Info } from 'lucide-react';
import api from '../../api/client';
import { Scenario, ForecastItem } from '../../pages/ForecastModulePage';

interface Props {
  scenario: Scenario | null;
  settings: Record<string, any>;
  revenueItems: ForecastItem[];
  onExit: () => void;
  onSave: () => Promise<void>;
}

export default function TaxRatesConfig({ scenario, settings, revenueItems, onExit, onSave }: Props) {
  const [saving, setSaving] = useState(false);

  // Income tax state
  const [incomeTaxRate, setIncomeTaxRate] = useState<number>(settings.income_tax_rate ?? 0);
  const [incomeTaxFrequency, setIncomeTaxFrequency] = useState<string>(settings.income_tax_frequency ?? 'annually');
  const [incomeTaxCustomMonths, setIncomeTaxCustomMonths] = useState<number[]>(settings.income_tax_custom_months ?? []);

  // Sales tax state
  const [salesTaxRate, setSalesTaxRate] = useState<number>(settings.sales_tax_rate ?? 18);
  const [salesTaxFrequency, setSalesTaxFrequency] = useState<string>(settings.sales_tax_frequency ?? 'monthly');
  const [salesTaxStreams, setSalesTaxStreams] = useState<number[]>(settings.sales_tax_streams ?? []);

  // Collapsible sections
  const [incomeExpanded, setIncomeExpanded] = useState(true);
  const [salesExpanded, setSalesExpanded] = useState(true);

  const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const toggleCustomMonth = (month: number) => {
    setIncomeTaxCustomMonths(prev =>
      prev.includes(month) ? prev.filter(m => m !== month) : [...prev, month].sort((a, b) => a - b)
    );
  };

  const toggleStream = (id: number) => {
    setSalesTaxStreams(prev =>
      prev.includes(id) ? prev.filter(s => s !== id) : [...prev, id]
    );
  };

  const handleSave = async () => {
    if (!scenario || scenario.id === -1) return;
    setSaving(true);
    try {
      await api.post('/forecast-module/settings', {
        scenario_id: scenario.id,
        settings: {
          income_tax_rate: incomeTaxRate,
          income_tax_frequency: incomeTaxFrequency,
          income_tax_custom_months: incomeTaxCustomMonths,
          sales_tax_rate: salesTaxRate,
          sales_tax_frequency: salesTaxFrequency,
          sales_tax_streams: salesTaxStreams,
        },
      });
      await onSave();
      onExit();
    } catch (err) {
      console.error('Failed to save tax settings:', err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-[800px]">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <button onClick={onExit} className="p-2 hover:bg-dark-500 rounded-lg transition-colors">
            <ArrowLeft size={20} className="text-theme-muted" />
          </button>
          <h2 className="text-2xl font-bold text-theme-heading">Tax Rates</h2>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onExit} className="px-4 py-2 text-sm text-theme-faint hover:text-theme-secondary">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="btn-primary px-6 py-2 text-sm disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save & Exit'}
          </button>
        </div>
      </div>

      {/* ── Income Taxes Section ── */}
      <div className="card mb-4 overflow-hidden">
        <button
          onClick={() => setIncomeExpanded(!incomeExpanded)}
          className="w-full flex items-center justify-between px-6 py-4 hover:bg-dark-600/50 transition-colors"
        >
          <div className="flex items-center gap-2">
            {incomeExpanded ? <ChevronDown size={16} className="text-theme-faint" /> : <ChevronRight size={16} className="text-theme-faint" />}
            <h3 className="text-lg font-bold text-theme-heading">Income Taxes</h3>
          </div>
          <span className="text-sm text-theme-faint">{incomeTaxRate}%</span>
        </button>

        {incomeExpanded && (
          <div className="px-6 pb-6 space-y-6 border-t border-dark-400/30 pt-5">
            {/* About */}
            <div className="bg-dark-600/50 rounded-xl p-4">
              <div className="flex items-center gap-1.5 mb-2">
                <Info size={14} className="text-accent-400" />
                <span className="text-sm font-semibold text-theme-secondary">About income taxes</span>
              </div>
              <p className="text-xs text-theme-faint leading-relaxed mb-2">
                Income taxes are applied to your net profit (revenue minus all costs). Set a single combined rate that covers all applicable income taxes (central, state, and local). A typical effective rate for Indian businesses is 25-30%.
              </p>
              <p className="text-xs text-theme-faint leading-relaxed">
                Taxes are only accrued when the business is profitable. If you have a net loss, no income tax is accrued. Note: payroll taxes and benefits are handled separately in Personnel.
              </p>
            </div>

            {/* Tax Rate */}
            <div>
              <label className="block text-sm font-semibold text-theme-secondary mb-2">
                What is your estimated tax rate?
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={0.5}
                  value={incomeTaxRate}
                  onChange={e => setIncomeTaxRate(Math.min(100, Math.max(0, parseFloat(e.target.value) || 0)))}
                  className="input w-28 text-sm text-right"
                />
                <span className="text-sm text-theme-faint font-medium">%</span>
              </div>
            </div>

            {/* Payment Frequency */}
            <div>
              <label className="block text-sm font-semibold text-theme-secondary mb-2">
                How often will you pay your taxes?
              </label>
              <select
                value={incomeTaxFrequency}
                onChange={e => setIncomeTaxFrequency(e.target.value)}
                className="input text-sm w-56"
              >
                <option value="monthly">Monthly</option>
                <option value="quarterly">Quarterly (advance tax)</option>
                <option value="annually">Annually</option>
                <option value="custom">Custom</option>
              </select>
              {incomeTaxFrequency === 'quarterly' && (
                <p className="text-xs text-theme-faint mt-2">
                  Advance tax will be paid at the end of each quarter (June, September, December, March).
                </p>
              )}
            </div>

            {/* Custom months */}
            {incomeTaxFrequency === 'custom' && (
              <div>
                <label className="block text-sm font-semibold text-theme-secondary mb-2">
                  Select the months when taxes are paid
                </label>
                <div className="grid grid-cols-4 gap-2">
                  {MONTH_NAMES.map((name, idx) => {
                    const monthNum = idx + 1;
                    const isSelected = incomeTaxCustomMonths.includes(monthNum);
                    return (
                      <button
                        key={monthNum}
                        onClick={() => toggleCustomMonth(monthNum)}
                        className={`px-3 py-2 text-sm font-medium rounded-lg border transition-all ${
                          isSelected
                            ? 'border-accent-500 bg-accent-500/15 text-accent-400'
                            : 'border-dark-400/50 text-theme-faint hover:text-theme-secondary hover:border-dark-300'
                        }`}
                      >
                        {name}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Sales Taxes (GST) Section ── */}
      <div className="card mb-4 overflow-hidden">
        <button
          onClick={() => setSalesExpanded(!salesExpanded)}
          className="w-full flex items-center justify-between px-6 py-4 hover:bg-dark-600/50 transition-colors"
        >
          <div className="flex items-center gap-2">
            {salesExpanded ? <ChevronDown size={16} className="text-theme-faint" /> : <ChevronRight size={16} className="text-theme-faint" />}
            <h3 className="text-lg font-bold text-theme-heading">Sales Taxes (GST)</h3>
          </div>
          <span className="text-sm text-theme-faint">{salesTaxRate}%</span>
        </button>

        {salesExpanded && (
          <div className="px-6 pb-6 space-y-6 border-t border-dark-400/30 pt-5">
            {/* About */}
            <div className="bg-dark-600/50 rounded-xl p-4">
              <div className="flex items-center gap-1.5 mb-2">
                <Info size={14} className="text-accent-400" />
                <span className="text-sm font-semibold text-theme-secondary">About sales taxes (GST)</span>
              </div>
              <p className="text-xs text-theme-faint leading-relaxed mb-2">
                Sales taxes (GST in India) are collected from customers on taxable revenue and periodically remitted to the government. Collecting GST doesn't affect your profitability, but it impacts your cash flow projections.
              </p>
              <p className="text-xs text-theme-faint leading-relaxed">
                Select which revenue streams are taxable and set the applicable rate. In India, GST rates typically range from 5% to 28% depending on the goods or services.
              </p>
            </div>

            {/* Applicable Revenue Streams */}
            <div>
              <label className="block text-sm font-semibold text-theme-secondary mb-2">
                Which revenue streams have sales tax?
              </label>
              {revenueItems.length === 0 ? (
                <p className="text-xs text-theme-faint">No revenue streams defined yet. Add revenue items first.</p>
              ) : (
                <div className="space-y-2">
                  {revenueItems.map(item => (
                    <label
                      key={item.id}
                      className="flex items-center gap-3 px-4 py-2.5 rounded-lg border border-dark-400/50 hover:border-dark-300 cursor-pointer transition-colors"
                    >
                      <input
                        type="checkbox"
                        checked={salesTaxStreams.includes(item.id)}
                        onChange={() => toggleStream(item.id)}
                        className="w-4 h-4 rounded border-dark-400 bg-dark-600 text-accent-500 focus:ring-accent-500/30"
                      />
                      <span className="text-sm text-theme-secondary">{item.name}</span>
                    </label>
                  ))}
                </div>
              )}
              {salesTaxStreams.length === 0 && revenueItems.length > 0 && (
                <p className="text-xs text-theme-faint mt-2">
                  No streams selected — GST will be applied to all revenue.
                </p>
              )}
            </div>

            {/* Tax Rate */}
            <div>
              <label className="block text-sm font-semibold text-theme-secondary mb-2">
                What is your estimated tax rate?
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={0.5}
                  value={salesTaxRate}
                  onChange={e => setSalesTaxRate(Math.min(100, Math.max(0, parseFloat(e.target.value) || 0)))}
                  className="input w-28 text-sm text-right"
                />
                <span className="text-sm text-theme-faint font-medium">%</span>
              </div>
            </div>

            {/* Payment Frequency */}
            <div>
              <label className="block text-sm font-semibold text-theme-secondary mb-2">
                How often will you pay your taxes?
              </label>
              <select
                value={salesTaxFrequency}
                onChange={e => setSalesTaxFrequency(e.target.value)}
                className="input text-sm w-56"
              >
                <option value="monthly">Monthly</option>
                <option value="quarterly">Quarterly</option>
                <option value="annually">Annually</option>
              </select>
              {salesTaxFrequency === 'monthly' && (
                <p className="text-xs text-theme-faint mt-2">
                  GST collected will be paid to the government the following month.
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Bottom Save */}
      <div className="flex justify-end gap-3 mt-6">
        <button onClick={onExit} className="px-4 py-2 text-sm text-theme-faint hover:text-theme-secondary">
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          className="btn-primary px-8 py-2.5 text-sm disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save & Exit'}
        </button>
      </div>
    </div>
  );
}
