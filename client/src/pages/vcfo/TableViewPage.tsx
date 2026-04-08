/**
 * Table View — Combined P&L, Balance Sheet, Trial Balance, Bills in tab layout
 * Matches TallyVision's "Table View" panel which shows financial statements in tabular format
 */
import { useState } from 'react';
import VcfoProfitLossPage from './VcfoProfitLossPage';
import VcfoBalanceSheetPage from './VcfoBalanceSheetPage';
import TrialBalancePage from './TrialBalancePage';
import VcfoBillsPage from './VcfoBillsPage';

const TABS = [
  { key: 'pl', label: 'Profit & Loss' },
  { key: 'bs', label: 'Balance Sheet' },
  { key: 'tb', label: 'Trial Balance' },
  { key: 'bills', label: 'Bills Outstanding' },
];

export default function TableViewPage() {
  const [activeTab, setActiveTab] = useState('pl');

  return (
    <div className="space-y-4">
      {/* Tab bar */}
      <div className="flex gap-1 px-1">
        {TABS.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-2 text-xs font-semibold rounded-lg transition-colors ${
              activeTab === tab.key
                ? 'bg-indigo-600 text-white'
                : 'bg-dark-700 text-theme-muted hover:text-theme-primary hover:bg-dark-600'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === 'pl' && <VcfoProfitLossPage />}
      {activeTab === 'bs' && <VcfoBalanceSheetPage />}
      {activeTab === 'tb' && <TrialBalancePage />}
      {activeTab === 'bills' && <VcfoBillsPage />}
    </div>
  );
}
