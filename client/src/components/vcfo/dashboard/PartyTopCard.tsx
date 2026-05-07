import { formatRs, formatRsCompact } from '../../../pages/ForecastModulePage';
import type { PartyEntry } from '../DashboardReport';

interface Props {
  title: string;                      // 'Money owed to us' | 'Money we owe'
  total: number;
  entries: PartyEntry[];
  /** When non-empty, shown under the title (e.g. 'Sundry Debtors'). */
  subtitle?: string;
  /** 'customers' or 'vendors' — used in the count summary line. */
  entityLabel?: string;
}

const VISIBLE_ROWS = 5;
const AGING_RED_THRESHOLD = 60;
const AGING_AMBER_THRESHOLD = 30;

/**
 * Top party ledgers — clean table (top 5 with "+ N more" footer) replacing
 * the previous horizontal bar chart. Each row carries an aging pill keyed
 * to the age of the OLDEST contributing voucher entry: red ≥60 days,
 * amber 30–60, green <30. The header sub-line summarises the total stuck
 * in the red bucket so the CFO can act on the worst-aged amounts first.
 *
 * The aging value is a proxy, not full FIFO aging — see the backend
 * comment on PartyEntry.oldestEntryDays.
 */
export default function PartyTopCard({ title, total, entries, subtitle, entityLabel }: Props) {
  const visible = entries.slice(0, VISIBLE_ROWS);
  const rest = entries.slice(VISIBLE_ROWS);
  const restTotal = rest.reduce((sum, e) => sum + e.amount, 0);

  const overdueAmount = entries
    .filter((e) => (e.oldestEntryDays ?? 0) >= AGING_RED_THRESHOLD)
    .reduce((sum, e) => sum + e.amount, 0);
  const hasAgingData = entries.some((e) => e.oldestEntryDays != null);

  return (
    <div className="mt-card p-4 h-full flex flex-col">
      <div className="flex items-start justify-between gap-3 mb-1">
        <div className="text-sm font-medium" style={{ color: 'var(--mt-text-primary)' }}>
          {title}
        </div>
        <div className="text-sm font-mono font-medium" style={{ color: 'var(--mt-text-primary)' }}>
          {formatRs(total)}
        </div>
      </div>
      <div className="text-[11px] mb-3" style={{ color: 'var(--mt-text-faint)' }}>
        {entries.length} {entityLabel ?? 'parties'}
        {subtitle ? ` · ${subtitle}` : ''}
        {hasAgingData && overdueAmount > 0 && (
          <span style={{ color: 'var(--mt-danger-text)' }}>
            {' · '}{formatRsCompact(overdueAmount)} aged 60+ days
          </span>
        )}
      </div>

      {entries.length === 0 ? (
        <div className="text-[11px] py-8 text-center flex-1" style={{ color: 'var(--mt-text-faint)' }}>
          No outstanding parties in this group.
        </div>
      ) : (
        <div className="flex-1">
          {visible.map((e, i) => (
            <div
              key={`${e.party}-${i}`}
              className="flex items-center justify-between gap-2 py-2 text-[12px]"
              style={{ borderTop: '1px solid var(--mt-border)' }}
            >
              <span className="truncate flex-1" title={e.party} style={{ color: 'var(--mt-text-secondary)' }}>
                {e.party}
              </span>
              {e.oldestEntryDays != null && <AgingPill days={e.oldestEntryDays} />}
              <span className="font-mono shrink-0 w-24 text-right" style={{ color: 'var(--mt-text-primary)' }}>
                {formatRs(e.amount)}
              </span>
            </div>
          ))}
          {rest.length > 0 && (
            <div
              className="flex items-center justify-between py-2 text-[11px]"
              style={{ borderTop: '1px solid var(--mt-border)', color: 'var(--mt-text-faint)' }}
            >
              <span>+ {rest.length} more</span>
              <span className="font-mono">{formatRs(restTotal)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AgingPill({ days }: { days: number }) {
  const tone = days >= AGING_RED_THRESHOLD ? 'red'
    : days >= AGING_AMBER_THRESHOLD ? 'amber'
    : 'green';
  const palette = tone === 'red'
    ? { bg: 'var(--mt-trust-red-bg)',   color: 'var(--mt-trust-red-text)' }
    : tone === 'amber'
    ? { bg: 'var(--mt-trust-amber-bg)', color: 'var(--mt-trust-amber-text)' }
    : { bg: 'var(--mt-trust-green-bg)', color: 'var(--mt-trust-green-text)' };
  return (
    <span
      className="text-[10px] font-medium shrink-0 rounded"
      style={{
        background: palette.bg,
        color: palette.color,
        padding: '2px 6px',
      }}
      title={`Oldest entry ${days} days old`}
    >
      {days}d
    </span>
  );
}
