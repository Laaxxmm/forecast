import { useState } from 'react';
import { X, Truck, Shield, TrendingUp, Info } from 'lucide-react';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreate: (config: AssetConfig) => void;
  months: string[];
}

export interface AssetConfig {
  name: string;
  assetType: 'long_term' | 'current' | 'investment';
  usefulLife: string;
  customLifeValue?: number;
  planToSell: boolean;
}

const LONG_TERM_LIFE_OPTIONS = [
  { value: '3', label: '3 years' },
  { value: '5', label: '5 years' },
  { value: '7', label: '7 years' },
  { value: '10', label: '10 years' },
  { value: '15', label: '15 years' },
  { value: '20', label: '20 years' },
  { value: '25', label: '25 years' },
  { value: '27.5', label: '27.5 years' },
  { value: '39', label: '39 years' },
  { value: 'custom', label: 'Custom (2\u201350 years)' },
  { value: 'forever', label: 'Forever (do not depreciate)' },
];

const CURRENT_LIFE_OPTIONS = [
  { value: '1m', label: '1 month' },
  { value: '2m', label: '2 months' },
  { value: '3m', label: '3 months' },
  { value: '4m', label: '4 months' },
  { value: '5m', label: '5 months' },
  { value: '6m', label: '6 months' },
  { value: '7m', label: '7 months' },
  { value: '8m', label: '8 months' },
  { value: '9m', label: '9 months' },
  { value: '10m', label: '10 months' },
  { value: '11m', label: '11 months' },
  { value: '12m', label: '12 months' },
  { value: 'full', label: 'Keep at full value' },
];

export default function AssetCreateModal({ open, onClose, onCreate }: Props) {
  const [name, setName] = useState('');
  const [assetType, setAssetType] = useState<'long_term' | 'current' | 'investment'>('long_term');
  const [usefulLife, setUsefulLife] = useState('forever');
  const [customLifeValue, setCustomLifeValue] = useState(5);
  const [planToSell, setPlanToSell] = useState(false);

  if (!open) return null;

  const lifeOptions = assetType === 'current' ? CURRENT_LIFE_OPTIONS : LONG_TERM_LIFE_OPTIONS;

  const handleTypeChange = (type: 'long_term' | 'current' | 'investment') => {
    setAssetType(type);
    setUsefulLife(type === 'current' ? 'full' : 'forever');
    setPlanToSell(false);
  };

  const handleContinue = () => {
    if (!name.trim()) return;
    onCreate({
      name: name.trim(),
      assetType,
      usefulLife,
      customLifeValue: usefulLife === 'custom' ? customLifeValue : undefined,
      planToSell,
    });
    // Reset
    setName('');
    setAssetType('long_term');
    setUsefulLife('forever');
    setPlanToSell(false);
  };

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
      <div className="bg-dark-700 rounded-2xl w-full max-w-lg shadow-2xl border border-dark-400/50 max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-dark-400/30">
          <h2 className="text-lg font-bold text-theme-heading">Add Asset</h2>
          <button onClick={onClose} className="p-1.5 hover:bg-dark-500 rounded-lg text-theme-faint">
            <X size={18} />
          </button>
        </div>

        <div className="px-6 py-5 space-y-6">
          {/* Asset Name */}
          <div>
            <label className="block text-sm font-semibold text-theme-secondary mb-2">Asset name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value.slice(0, 255))}
              placeholder="e.g. Office Equipment, Delivery Vehicle"
              className="input w-full text-sm"
              autoFocus
            />
            <div className="text-right text-xs text-theme-faint mt-1">{name.length} of 255</div>
          </div>

          {/* Asset Type */}
          <div>
            <label className="block text-sm font-semibold text-theme-secondary mb-3">
              What type of asset is this?
            </label>
            <div className="grid grid-cols-3 gap-3">
              <button
                onClick={() => handleTypeChange('long_term')}
                className={`text-left p-4 rounded-xl border-2 transition-all ${
                  assetType === 'long_term'
                    ? 'border-accent-500 bg-accent-500/10'
                    : 'border-dark-400/50 hover:border-dark-300 bg-dark-600'
                }`}
              >
                <div className="flex items-center gap-2 mb-2">
                  <Truck size={18} className={assetType === 'long_term' ? 'text-accent-400' : 'text-theme-faint'} />
                  <span className="font-semibold text-sm text-theme-heading">Long-term asset</span>
                </div>
                <p className="text-xs text-theme-faint leading-relaxed">
                  Equipment, vehicles, or buildings. Not easy to convert to cash.
                </p>
              </button>
              <button
                onClick={() => handleTypeChange('current')}
                className={`text-left p-4 rounded-xl border-2 transition-all ${
                  assetType === 'current'
                    ? 'border-accent-500 bg-accent-500/10'
                    : 'border-dark-400/50 hover:border-dark-300 bg-dark-600'
                }`}
              >
                <div className="flex items-center gap-2 mb-2">
                  <Shield size={18} className={assetType === 'current' ? 'text-accent-400' : 'text-theme-faint'} />
                  <span className="font-semibold text-sm text-theme-heading">Current asset</span>
                </div>
                <p className="text-xs text-theme-faint leading-relaxed">
                  Full value within 12 months — prepaid contracts, inventory.
                </p>
              </button>
              <button
                onClick={() => handleTypeChange('investment')}
                className={`text-left p-4 rounded-xl border-2 transition-all ${
                  assetType === 'investment'
                    ? 'border-accent-500 bg-accent-500/10'
                    : 'border-dark-400/50 hover:border-dark-300 bg-dark-600'
                }`}
              >
                <div className="flex items-center gap-2 mb-2">
                  <TrendingUp size={18} className={assetType === 'investment' ? 'text-accent-400' : 'text-theme-faint'} />
                  <span className="font-semibold text-sm text-theme-heading">Investment</span>
                </div>
                <p className="text-xs text-theme-faint leading-relaxed">
                  Mutual funds, fixed deposits, or other financial instruments.
                </p>
              </button>
            </div>
          </div>

          {/* Useful Life */}
          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <label className="text-sm font-semibold text-theme-secondary">
                What is the useful life of this asset?
              </label>
              <div className="group relative">
                <Info size={14} className="text-theme-faint cursor-help" />
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-56 bg-dark-800 border border-dark-400/50 rounded-lg p-3 text-xs text-theme-faint hidden group-hover:block shadow-lg z-10">
                  {assetType === 'long_term'
                    ? 'How long will this asset be used before it loses its value? This determines how depreciation is calculated.'
                    : 'How many months until this asset is fully consumed or expires?'}
                </div>
              </div>
            </div>
            <select
              value={usefulLife}
              onChange={e => setUsefulLife(e.target.value)}
              className="input w-full text-sm"
            >
              {lifeOptions.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
            {usefulLife === 'custom' && (
              <div className="flex items-center gap-2 mt-2">
                <input
                  type="number"
                  min={2}
                  max={50}
                  value={customLifeValue}
                  onChange={e => setCustomLifeValue(Math.min(50, Math.max(2, parseInt(e.target.value) || 2)))}
                  className="input w-24 text-sm"
                />
                <span className="text-sm text-theme-faint">years</span>
              </div>
            )}
          </div>

          {/* Plan to Sell */}
          {(assetType === 'long_term' || assetType === 'investment') && (
            <div>
              <div className="flex items-center gap-1.5 mb-2">
                <label className="text-sm font-semibold text-theme-secondary">
                  Do you plan to resell this asset?
                </label>
                <div className="group relative">
                  <Info size={14} className="text-theme-faint cursor-help" />
                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-56 bg-dark-800 border border-dark-400/50 rounded-lg p-3 text-xs text-theme-faint hidden group-hover:block shadow-lg z-10">
                    If you plan to sell this asset in the future, you can set the expected sale price and date later.
                  </div>
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setPlanToSell(false)}
                  className={`px-5 py-2 text-sm font-medium rounded-lg border transition-all ${
                    !planToSell
                      ? 'border-accent-500 bg-accent-500/15 text-accent-400'
                      : 'border-dark-400/50 text-theme-faint hover:text-theme-secondary'
                  }`}
                >
                  No
                </button>
                <button
                  onClick={() => setPlanToSell(true)}
                  className={`px-5 py-2 text-sm font-medium rounded-lg border transition-all ${
                    planToSell
                      ? 'border-accent-500 bg-accent-500/15 text-accent-400'
                      : 'border-dark-400/50 text-theme-faint hover:text-theme-secondary'
                  }`}
                >
                  Yes
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-dark-400/30 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm text-theme-faint hover:text-theme-secondary">
            Cancel
          </button>
          <button
            onClick={handleContinue}
            disabled={!name.trim()}
            className="btn-primary px-6 py-2 text-sm disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}
