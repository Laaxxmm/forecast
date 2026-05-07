import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { formatRs } from '../../../pages/ForecastModulePage';

interface Props {
  label: string;
  value: number;
  /** Prior-period delta as a percentage (e.g. 12.4 = +12.4%). Omit for KPIs without comparison. */
  deltaPct?: number;
  /** Optional sub-line under the value, e.g. "33.99% margin" or "as of 31 Mar 2026". */
  sublabel?: string;
  /** Tone for the value text — defaults to neutral; use 'positive'/'negative' for emphasis. */
  tone?: 'neutral' | 'positive' | 'negative';
}

/**
 * KPI tile — single big number with optional delta chip vs prior period.
 * Used four-up across the top row of the Dashboard.
 */
export default function KpiCard({ label, value, deltaPct, sublabel, tone = 'neutral' }: Props) {
  const valueColor = tone === 'positive'
    ? 'var(--mt-accent-text)'
    : tone === 'negative'
      ? 'var(--mt-danger-text)'
      : 'var(--mt-text-primary)';

  // Delta chip — green up / red down / grey flat. ±0.5% is treated as flat
  // to suppress noise.
  const dir = deltaPct == null ? null
    : Math.abs(deltaPct) < 0.5 ? 'flat'
    : deltaPct > 0 ? 'up' : 'down';

  return (
    <div className="mt-card p-4">
      <div className="text-xs uppercase tracking-wide font-semibold" style={{ color: 'var(--mt-text-faint)' }}>
        {label}
      </div>
      <div className="mt-1.5 flex items-baseline gap-2">
        <div className="text-xl md:text-2xl font-mono font-semibold" style={{ color: valueColor }}>
          {formatRs(value)}
        </div>
        {dir && (
          <span
            className="inline-flex items-center gap-1 text-[11px] font-semibold px-1.5 py-0.5 rounded"
            style={{
              background:
                dir === 'up' ? 'var(--mt-accent-soft)' :
                dir === 'down' ? 'var(--mt-danger-soft)' :
                'var(--mt-bg-muted)',
              color:
                dir === 'up' ? 'var(--mt-accent-text)' :
                dir === 'down' ? 'var(--mt-danger-text)' :
                'var(--mt-text-faint)',
            }}
          >
            {dir === 'up' ? <TrendingUp size={11} /> : dir === 'down' ? <TrendingDown size={11} /> : <Minus size={11} />}
            {dir === 'flat' ? '0%' : `${deltaPct! > 0 ? '+' : ''}${deltaPct!.toFixed(1)}%`}
          </span>
        )}
      </div>
      {sublabel && (
        <div className="mt-1 text-[11px]" style={{ color: 'var(--mt-text-faint)' }}>
          {sublabel}
        </div>
      )}
    </div>
  );
}
