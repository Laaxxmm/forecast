import { formatRs } from '../../../pages/ForecastModulePage';

interface Props {
  revenue: number;
  directCosts: number;
  indirectIncome: number;
  indirectExpenses: number;
  grossProfit: number;
  netProfit: number;
}

/**
 * P&L composition — visualises how Revenue is consumed by Direct Costs,
 * leaves Gross Profit, then is reduced by Indirect Expenses (and possibly
 * lifted by Indirect Income) to land at Net Profit. Pure CSS bars sized
 * relative to Revenue so the proportions are visually obvious without a
 * chart library round-trip.
 */
export default function CompositionCard({
  revenue, directCosts, indirectIncome, indirectExpenses, grossProfit, netProfit,
}: Props) {
  // Use revenue as the 100% reference. If revenue is zero, fall back to the
  // largest absolute number so we still draw something legible.
  const ref = Math.max(
    Math.abs(revenue),
    Math.abs(directCosts),
    Math.abs(indirectExpenses),
    Math.abs(indirectIncome),
    Math.abs(grossProfit),
    Math.abs(netProfit),
    1, // avoid /0
  );
  const pct = (v: number) => Math.min(100, Math.max(0, (Math.abs(v) / ref) * 100));

  // Each row: label · bar · amount. Bar colour signals tone (revenue/income =
  // emerald, expense = rose, profit = indigo).
  const rows: { label: string; value: number; color: string }[] = [
    { label: 'Revenue',           value: revenue,           color: '#10b981' },
    { label: 'Direct Costs',      value: directCosts,       color: '#f43f5e' },
    { label: 'Gross Profit',      value: grossProfit,       color: '#6366f1' },
    ...(indirectIncome !== 0
      ? [{ label: 'Indirect Income', value: indirectIncome, color: '#34d399' }]
      : []),
    { label: 'Indirect Expenses', value: indirectExpenses,  color: '#fb7185' },
    { label: 'Net Profit',        value: netProfit,         color: netProfit >= 0 ? '#10b981' : '#ef4444' },
  ];

  return (
    <div className="mt-card p-4 h-full">
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm font-semibold" style={{ color: 'var(--mt-text-primary)' }}>
          P&amp;L composition
        </div>
        {revenue > 0 && (
          <div className="text-[11px]" style={{ color: 'var(--mt-text-faint)' }}>
            Margin {((netProfit / revenue) * 100).toFixed(1)}%
          </div>
        )}
      </div>
      <div className="space-y-2">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center gap-3">
            <div className="text-[11px] flex-shrink-0 w-28" style={{ color: 'var(--mt-text-secondary)' }}>
              {r.label}
            </div>
            <div className="flex-1 h-5 rounded relative overflow-hidden" style={{ background: 'var(--mt-bg-muted)' }}>
              <div
                className="absolute inset-y-0 left-0 rounded transition-all duration-300"
                style={{ width: `${pct(r.value)}%`, background: r.color, opacity: 0.85 }}
              />
            </div>
            <div className="text-[11px] font-mono font-semibold flex-shrink-0 w-24 text-right" style={{ color: 'var(--mt-text-primary)' }}>
              {formatRs(r.value)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
