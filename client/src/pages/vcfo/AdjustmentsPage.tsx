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
      {/* Tab bar — uses tv-tab class for TallyVision consistency */}
      <div className="flex gap-1 px-1">
        {TABS.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`tv-tab ${activeTab === tab.key ? 'active' : ''}`}
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
