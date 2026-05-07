import { useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, Legend, CartesianGrid, ResponsiveContainer } from 'recharts';
import { formatRs } from '../../../pages/ForecastModulePage';

interface CompanyEntry {
  id: number;
  name: string;
  revenue: number;
  netProfit: number;
}

interface Props {
  entries: CompanyEntry[];
}

/**
 * Per-company contribution — when consolidating across 2+ companies, this
 * card breaks down which company contributed how much Revenue and Net
 * Profit for the period. Only meaningful in consolidation; the parent page
 * hides the card otherwise.
 */
export default function CompanyContributionCard({ entries }: Props) {
  const data = useMemo(() => entries.map((e) => ({
    ...e,
    label: e.name.length > 28 ? e.name.slice(0, 27) + '…' : e.name,
  })), [entries]);

  return (
    <div className="mt-card p-4 h-full">
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm font-semibold" style={{ color: 'var(--mt-text-primary)' }}>
          Per-company contribution
        </div>
        <div className="text-[11px]" style={{ color: 'var(--mt-text-faint)' }}>
          {entries.length} companies in scope
        </div>
      </div>
      <div style={{ width: '100%', height: 260 }}>
        <ResponsiveContainer>
          <BarChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 24 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--mt-border)" />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: 'var(--mt-text-faint)' }}
              stroke="var(--mt-border)"
              angle={-15}
              textAnchor="end"
              height={50}
              interval={0}
            />
            <YAxis
              tick={{ fontSize: 11, fill: 'var(--mt-text-faint)' }}
              stroke="var(--mt-border)"
              tickFormatter={(v: number) => formatRs(v).replace('Rs', '₹')}
              width={70}
            />
            <Tooltip
              contentStyle={{
                background: 'var(--mt-bg-raised)',
                border: '1px solid var(--mt-border)',
                borderRadius: 8,
                fontSize: 12,
              }}
              labelStyle={{ color: 'var(--mt-text-faint)', fontSize: 11 }}
              formatter={(v: number, key: string) => [formatRs(v), key === 'revenue' ? 'Revenue' : 'Net Profit']}
            />
            <Legend wrapperStyle={{ fontSize: 11, paddingTop: 4 }} />
            <Bar dataKey="revenue" name="Revenue" fill="#10b981" radius={[4, 4, 0, 0]} />
            <Bar dataKey="netProfit" name="Net Profit" fill="#6366f1" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
