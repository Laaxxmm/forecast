import { formatRs } from '../../../pages/ForecastModulePage';

interface PartyEntry {
  party: string;
  amount: number;
}

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

/**
 * Top party ledgers — clean table (top 5 with "+ N more" footer) replacing
 * the previous horizontal bar chart. Aging pills are deferred to Phase 2;
 * the column slot is reserved with a TODO so the structure is ready when
 * backend support lands.
 */
export default function PartyTopCard({ title, total, entries, subtitle, entityLabel }: Props) {
  const visible = entries.slice(0, VISIBLE_ROWS);
  const rest = entries.slice(VISIBLE_ROWS);
  const restTotal = rest.reduce((sum, e) => sum + e.amount, 0);

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
        {/* TODO Phase 2: aging summary, e.g. "· Rs2.4L overdue 60+ days" */}
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
              className="flex items-center justify-between py-2 text-[12px]"
              style={{ borderTop: '1px solid var(--mt-border)' }}
            >
              <span className="truncate flex-1 pr-3" title={e.party} style={{ color: 'var(--mt-text-secondary)' }}>
                {e.party}
              </span>
              {/* TODO Phase 2: aging pill column goes here */}
              <span className="font-mono shrink-0" style={{ color: 'var(--mt-text-primary)' }}>
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
