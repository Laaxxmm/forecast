/**
 * Adjustments — Combined Allocations + Write-offs in tab layout
 * Matches TallyVision's "Adjustments" sidebar item which opens setup with alloc/writeoff tabs
 */
import { useState } from 'react';
import AllocationRulesPage from './AllocationRulesPage';
import WriteoffRulesPage from './WriteoffRulesPage';

const TABS = [
  { key: 'alloc', label: 'Allocations' },
  { key: 'writeoff', label: 'Write-offs' },
];

export default function AdjustmentsPage() {
  const [activeTab, setActiveTab] = useState('alloc');

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
      {activeTab === 'alloc' && <AllocationRulesPage />}
      {activeTab === 'writeoff' && <WriteoffRulesPage />}
    </div>
  );
}
