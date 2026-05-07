import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { formatRsCompact } from '../../../pages/ForecastModulePage';

interface Props {
  revenue: { last7d: number; prior7d: number; deltaPct: number | null };
  netCash: { current: number; weekAgo: number; delta: number };
  windows: { last7dFrom: string; last7dTo: string; prior7dFrom: string; prior7dTo: string };
}

/**
 * Row 5 — "What changed this week". Two tiles, derived on-read from the
 * existing P&L and balance-sheet helpers (no event log, no migration).
 *
 * Hides itself entirely when there's nothing meaningful to surface
 * (both deltas zero) so a fresh tenant doesn't see an empty card.
 */
export default function WeeklyChangeCard({ revenue, netCash, windows }: Props) {
  const revenueDelta = revenue.last7d - revenue.prior7d;
  const cashDelta = netCash.delta;

  // Nothing happened in either dimension — skip the card.
  if (Math.abs(revenueDelta) < 1 && Math.abs(cashDelta) < 1) return null;

  return (
    <div>
      <div
        className="text-[11px] uppercase font-semibold mb-2"
        style={{ color: 'var(--mt-text-faint)', letterSpacing: '0.5px' }}
      >
        What changed this week
      </div>
      <div
        className="rounded-lg p-4"
        style={{ background: '#EEEDFE', color: '#26215C' }}
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Tile
            label="Revenue, last 7d"
            value={formatRsCompact(revenue.last7d)}
            deltaAbs={revenueDelta}
            deltaPct={revenue.deltaPct}
            sub={`vs ${formatRsCompact(revenue.prior7d)} the week before`}
          />
          <Tile
            label="Net cash, today"
            value={formatRsCompact(netCash.current)}
            deltaAbs={cashDelta}
            deltaPct={null}
            sub={`vs ${formatRsCompact(netCash.weekAgo)} a week ago`}
          />
        </div>
        <div className="text-[10px] mt-3 opacity-70">
          {windows.last7dFrom} → {windows.last7dTo} compared with {windows.prior7dFrom} → {windows.prior7dTo}
        </div>
      </div>
    </div>
  );
}

function Tile({
  label, value, deltaAbs, deltaPct, sub,
}: {
  label: string;
  value: string;
  deltaAbs: number;
  deltaPct: number | null;
  sub: string;
}) {
  const dir = Math.abs(deltaAbs) < 1 ? 'flat' : deltaAbs > 0 ? 'up' : 'down';
  const dirColor = dir === 'up' ? '#0F6E56' : dir === 'down' ? '#A32D2D' : '#3C3489';
  const sign = deltaAbs > 0 ? '+' : '';
  const pctLabel = deltaPct == null ? null
    : `${deltaPct > 0 ? '+' : ''}${deltaPct.toFixed(1)}%`;

  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide font-semibold opacity-80">
        {label}
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <div className="text-xl font-mono font-semibold">{value}</div>
        <span
          className="inline-flex items-center gap-1 text-[11px] font-semibold"
          style={{ color: dirColor }}
        >
          {dir === 'up' ? <TrendingUp size={11} /> : dir === 'down' ? <TrendingDown size={11} /> : <Minus size={11} />}
          {dir === 'flat' ? 'unchanged' : `${sign}${formatRsCompact(deltaAbs).replace('Rs', '')}${pctLabel ? ` (${pctLabel})` : ''}`}
        </span>
      </div>
      <div className="text-[11px] opacity-70 mt-1">{sub}</div>
    </div>
  );
}
