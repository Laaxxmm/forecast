import { formatRs } from '../../../pages/ForecastModulePage';
import StackedShareBar from './StackedShareBar';

interface Props {
  revenue: number;
  directCosts: number;
  indirectIncome: number;
  indirectExpenses: number;
  grossProfit: number;
  netProfit: number;
}

/**
 * P&L composition — single horizontal stacked bar showing how every
 * rupee of Revenue is consumed by Direct Costs, Indirect (net), and
 * what remains as Net Profit. Numbers table below makes the math
 * explicit:  Revenue  - Direct  =  Gross  - Indirect  =  Net.
 */
export default function CompositionCard({
  revenue, directCosts, indirectIncome, indirectExpenses, grossProfit, netProfit,
}: Props) {
  // Net indirect impact (expenses pull profit down; income lifts it back up).
  const indirectNet = indirectExpenses - indirectIncome;
  const directPct   = revenue > 0 ? (directCosts   / revenue) * 100 : 0;
  const indirectPct = revenue > 0 ? (indirectNet   / revenue) * 100 : 0;
  const netPct      = revenue > 0 ? (netProfit     / revenue) * 100 : 0;

  return (
    <div className="mt-card p-4 h-full">
      <div className="mb-3">
        <div className="text-sm font-semibold" style={{ color: 'var(--mt-text-primary)' }}>
          P&amp;L composition
        </div>
        <div className="text-[11px] mt-0.5" style={{ color: 'var(--mt-text-faint)' }}>
          Where every Rs1 of revenue went
        </div>
      </div>

      <StackedShareBar
        total={revenue}
        segments={[
          { label: 'Direct',   value: directCosts,             color: 'var(--mt-pl-direct-red)' },
          { label: 'Indirect', value: Math.max(0, indirectNet), color: 'var(--mt-pl-indirect-gray)' },
          { label: 'Net',      value: Math.max(0, netProfit),  color: 'var(--mt-pl-net-green)' },
        ]}
      />

      <div className="flex justify-between text-[10px] mt-1.5" style={{ color: 'var(--mt-text-faint)' }}>
        <span>0%</span><span>50%</span><span>100%</span>
      </div>

      <div className="mt-4 text-[12px]">
        <Row label="Revenue"          value={revenue}                         strong />
        <Row label="− Direct costs"   value={-Math.abs(directCosts)}          tone="negative" />
        <Row label="= Gross profit"   value={grossProfit}                     strong />
        <Row label={indirectIncome > 0 ? '− Indirect (net)' : '− Indirect'} value={-Math.abs(indirectNet)} tone="negative" />
        <Row label="= Net profit"     value={netProfit}                       strong tone={netProfit >= 0 ? 'positive' : 'negative'} />
      </div>

      {revenue > 0 && (
        <div className="text-[11px] mt-3 pt-2" style={{ color: 'var(--mt-text-faint)', borderTop: '1px solid var(--mt-border)' }}>
          {directPct.toFixed(0)}% to direct · {Math.max(0, indirectPct).toFixed(0)}% to indirect · {netPct.toFixed(1)}% margin
        </div>
      )}
    </div>
  );
}

function Row({
  label, value, strong, tone,
}: {
  label: string;
  value: number;
  strong?: boolean;
  tone?: 'positive' | 'negative';
}) {
  const valueColor = tone === 'positive' ? 'var(--mt-accent-text)'
    : tone === 'negative' ? 'var(--mt-danger-text)'
    : 'var(--mt-text-primary)';
  return (
    <div
      className="flex items-center justify-between py-1.5"
      style={{ borderTop: '1px solid var(--mt-border)' }}
    >
      <span
        className={strong ? 'font-medium' : ''}
        style={{ color: strong ? 'var(--mt-text-primary)' : 'var(--mt-text-secondary)' }}
      >
        {label}
      </span>
      <span
        className={`font-mono ${strong ? 'font-semibold' : ''}`}
        style={{ color: valueColor }}
      >
        {formatRs(value)}
      </span>
    </div>
  );
}
