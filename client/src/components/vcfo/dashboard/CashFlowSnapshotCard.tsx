import { ArrowUpRight, ArrowDownRight, Wallet } from 'lucide-react';
import { formatRs } from '../../../pages/ForecastModulePage';

interface Props {
  operating: number;
  investing: number;
  financing: number;
  netChange: number;
  closingCash: number;
}

/**
 * Cash Flow snapshot — three rows for Operating / Investing / Financing
 * activity totals across the window, plus a "closing cash" line. No chart;
 * just stat-rows. Click-through to the full Cash Flow tab is implicit via
 * the page nav.
 */
export default function CashFlowSnapshotCard({
  operating, investing, financing, netChange, closingCash,
}: Props) {
  const Row = ({ label, value }: { label: string; value: number }) => {
    const positive = value >= 0;
    return (
      <div
        className="flex items-center justify-between py-2.5"
        style={{ borderTop: '1px solid var(--mt-border)' }}
      >
        <div className="flex items-center gap-2">
          <span
            className="inline-flex items-center justify-center w-6 h-6 rounded"
            style={{
              background: positive ? 'var(--mt-accent-soft)' : 'var(--mt-danger-soft)',
              color: positive ? 'var(--mt-accent-text)' : 'var(--mt-danger-text)',
            }}
          >
            {positive ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}
          </span>
          <span className="text-sm" style={{ color: 'var(--mt-text-secondary)' }}>{label}</span>
        </div>
        <span
          className="font-mono font-semibold text-sm"
          style={{ color: positive ? 'var(--mt-accent-text)' : 'var(--mt-danger-text)' }}
        >
          {formatRs(value)}
        </span>
      </div>
    );
  };

  return (
    <div className="mt-card p-4 h-full flex flex-col">
      <div className="text-sm font-semibold mb-3" style={{ color: 'var(--mt-text-primary)' }}>
        Cash Flow snapshot
      </div>

      <Row label="Operating activities" value={operating} />
      <Row label="Investing activities" value={investing} />
      <Row label="Financing activities" value={financing} />

      <div
        className="flex items-center justify-between py-2.5 mt-2"
        style={{ borderTop: '2px solid var(--mt-border-strong)' }}
      >
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center justify-center w-6 h-6 rounded" style={{ background: 'var(--mt-bg-muted)', color: 'var(--mt-text-faint)' }}>
            <Wallet size={14} />
          </span>
          <span className="text-sm font-medium" style={{ color: 'var(--mt-text-primary)' }}>Net change</span>
        </div>
        <span
          className="font-mono font-semibold text-sm"
          style={{ color: netChange >= 0 ? 'var(--mt-accent-text)' : 'var(--mt-danger-text)' }}
        >
          {formatRs(netChange)}
        </span>
      </div>

      <div className="flex items-center justify-between mt-2">
        <span className="text-[11px]" style={{ color: 'var(--mt-text-faint)' }}>Closing cash</span>
        <span className="text-xs font-mono font-medium" style={{ color: 'var(--mt-text-primary)' }}>
          {formatRs(closingCash)}
        </span>
      </div>
    </div>
  );
}
