import { ReactNode } from 'react';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { formatRs } from '../../../pages/ForecastModulePage';
import HoverPopover from './HoverPopover';

interface Props {
  label: string;
  /** Numeric value (formatted via formatRs unless valueOverride is supplied). */
  value: number;
  /** Replace the default formatRs(value) display (e.g. "17.8%"). */
  valueOverride?: string;
  /** Prior-period delta (percent or pts depending on deltaUnit). */
  deltaPct?: number | null;
  /** Prior-period raw value — used to detect "no comparison data" when prior===0. */
  prior?: number;
  /** Suffix on the delta chip. Default '%'. */
  deltaUnit?: '%' | 'pts';
  /** Sub-line under the value. */
  sublabel?: string;
  /** Tone for the value text — defaults to neutral; positive=emerald, negative=red. */
  tone?: 'neutral' | 'positive' | 'negative';
  /** Optional thin coloured border around the card (used by Working Capital Gap when negative). */
  borderTone?: 'danger';
  /** Optional hover popover content rendered over the value (used by Net Cash Position). */
  tooltip?: ReactNode;
}

/**
 * KPI tile — single big number with optional delta chip vs prior period.
 *
 * Delta-rendering rule (the "+999%" fix):
 *   - render an em-dash with a "no comparison data available" tooltip when
 *     the prior period was zero, the delta is missing, or the delta is
 *     so large (>500) it must be a divide-by-near-zero artefact rather
 *     than a real growth rate.
 *
 * Used four-up across the Headline row of the Dashboard.
 */
export default function KpiCard({
  label,
  value,
  valueOverride,
  deltaPct,
  prior,
  deltaUnit = '%',
  sublabel,
  tone = 'neutral',
  borderTone,
  tooltip,
}: Props) {
  const valueColor = tone === 'positive'
    ? 'var(--mt-accent-text)'
    : tone === 'negative'
      ? 'var(--mt-danger-text)'
      : 'var(--mt-text-primary)';

  const cardStyle: React.CSSProperties = borderTone === 'danger'
    ? { border: '1px solid #F7C1C1' }
    : {};

  // ── Delta-display decision ──────────────────────────────────────────
  // (1) deltaPct missing → no comparison
  // (2) prior === 0 → backend caps at ±999, which is meaningless
  // (3) |deltaPct| > 500 → too volatile to be useful
  const noComparison =
    deltaPct == null ||
    prior === 0 ||
    Math.abs(deltaPct) > 500;

  const dir = noComparison
    ? null
    : Math.abs(deltaPct!) < 0.5 ? 'flat'
    : deltaPct! > 0 ? 'up' : 'down';

  const valueNode = (
    <div
      className="text-xl md:text-2xl font-mono font-semibold"
      style={{ color: valueColor }}
    >
      {valueOverride ?? formatRs(value)}
    </div>
  );

  return (
    <div className="mt-card p-4" style={cardStyle}>
      <div className="text-xs uppercase tracking-wide font-semibold" style={{ color: 'var(--mt-text-faint)' }}>
        {label}
      </div>
      <div className="mt-1.5 flex items-baseline gap-2">
        {tooltip ? (
          <HoverPopover trigger={valueNode} content={tooltip} />
        ) : (
          valueNode
        )}
        {dir ? (
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
            {dir === 'flat' ? `0${deltaUnit}` : `${deltaPct! > 0 ? '+' : ''}${deltaPct!.toFixed(1)}${deltaUnit}`}
          </span>
        ) : (deltaPct !== undefined || prior !== undefined) && (
          <span
            className="text-[11px] font-medium px-1 cursor-help"
            style={{ color: 'var(--mt-text-faint)' }}
            title="No comparison data available"
          >
            —
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
