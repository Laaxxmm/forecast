import { useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { formatRs } from '../../../pages/ForecastModulePage';

interface PartyEntry {
  party: string;
  amount: number;
}

interface Props {
  title: string;                      // 'Top 10 Receivables' | 'Top 10 Payables'
  total: number;
  entries: PartyEntry[];
  /** Bar colour — emerald for receivables, amber for payables. */
  color: string;
  /** When non-empty, shown under the title (e.g. 'Sundry Debtors'). */
  subtitle?: string;
}

/**
 * Top-N party ledgers — horizontal bar chart with party name on Y axis.
 * Used for both receivables and payables; the only differences are title,
 * total, and bar colour.
 */
export default function PartyTopCard({ title, total, entries, color, subtitle }: Props) {
  // Truncate long party names so the Y axis doesn't blow out the card.
  const data = useMemo(() => entries.map((e) => ({
    ...e,
    label: e.party.length > 22 ? e.party.slice(0, 21) + '…' : e.party,
  })), [entries]);

  const max = Math.max(...data.map((d) => d.amount), 1);

  return (
    <div className="mt-card p-4 h-full flex flex-col">
      <div className="flex items-start justify-between mb-3 gap-2">
        <div>
          <div className="text-sm font-semibold" style={{ color: 'var(--mt-text-primary)' }}>
            {title}
          </div>
          {subtitle && (
            <div className="text-[11px] mt-0.5" style={{ color: 'var(--mt-text-faint)' }}>
              {subtitle}
            </div>
          )}
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wide font-semibold" style={{ color: 'var(--mt-text-faint)' }}>Total</div>
          <div className="text-base font-mono font-semibold" style={{ color: 'var(--mt-text-primary)' }}>
            {formatRs(total)}
          </div>
        </div>
      </div>

      {data.length === 0 ? (
        <div className="text-[11px] py-8 text-center flex-1" style={{ color: 'var(--mt-text-faint)' }}>
          No outstanding parties in this group.
        </div>
      ) : (
        <div style={{ width: '100%', height: Math.max(180, data.length * 26) }}>
          <ResponsiveContainer>
            <BarChart
              data={data}
              layout="vertical"
              margin={{ top: 2, right: 12, left: 0, bottom: 2 }}
            >
              <XAxis type="number" hide domain={[0, max * 1.05]} />
              <YAxis
                type="category"
                dataKey="label"
                tick={{ fontSize: 11, fill: 'var(--mt-text-secondary)' }}
                stroke="var(--mt-border)"
                width={140}
                interval={0}
              />
              <Tooltip
                cursor={{ fill: 'var(--mt-bg-muted)' }}
                contentStyle={{
                  background: 'var(--mt-bg-raised)',
                  border: '1px solid var(--mt-border)',
                  borderRadius: 8,
                  fontSize: 12,
                }}
                labelStyle={{ color: 'var(--mt-text-faint)', fontSize: 11 }}
                formatter={(v: number, _name: string, item: any) => [formatRs(v), item?.payload?.party || '']}
              />
              <Bar dataKey="amount" radius={[0, 4, 4, 0]}>
                {data.map((_, i) => (
                  <Cell key={i} fill={color} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
