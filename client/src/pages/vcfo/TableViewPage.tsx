/**
 * Table View — Combined P&L, Balance Sheet, Trial Balance, Bills in tab layout
 * Matches TallyVision's "Table View" panel which shows financial statements in tabular format
 */
import { useState, Component, ReactNode } from 'react';
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

/* ── Error Boundary ───────────────────────────────────── */
interface EBProps { children: ReactNode; fallback?: ReactNode }
interface EBState { hasError: boolean; error: string }

class TabErrorBoundary extends Component<EBProps, EBState> {
  state: EBState = { hasError: false, error: '' };
  static getDerivedStateFromError(err: Error) {
    return { hasError: true, error: err.message || 'Something went wrong' };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="card-tv p-12 text-center">
          <p className="text-red-400 text-sm font-semibold mb-2">Failed to load this tab</p>
          <p className="text-theme-faint text-xs">{this.state.error}</p>
          <button
            onClick={() => this.setState({ hasError: false, error: '' })}
            className="mt-4 tv-tab active"
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

/* ── Main Component ───────────────────────────────────── */
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
            className={`tv-tab ${activeTab === tab.key ? 'active' : ''}`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content — key forces remount on tab switch to avoid stale state */}
      <TabErrorBoundary key={activeTab}>
        {activeTab === 'pl' && <VcfoProfitLossPage />}
        {activeTab === 'bs' && <VcfoBalanceSheetPage />}
        {activeTab === 'tb' && <TrialBalancePage />}
        {activeTab === 'bills' && <VcfoBillsPage />}
      </TabErrorBoundary>
    </div>
  );
}
