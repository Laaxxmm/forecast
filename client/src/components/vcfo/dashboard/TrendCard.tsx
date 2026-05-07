import { useMemo } from 'react';
import { ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { formatRs, getMonthLabel } from '../../../pages/ForecastModulePage';

interface Props {
  columns: string[];                       // YYYY-MM strings
  revenue: Record<string, number>;
  netProfit: Record<string, number>;
}

/**
 * Revenue & Net Profit monthly trend — bars (Revenue) plus an overlay line
 * (Net Profit). Both in INR; same axis. Tooltip uses formatRs for crores/lakhs
 * grouping.
 */
export default function TrendCard({ columns, revenue, netProfit }: Props) {
  const data = useMemo(() => columns.map((col) => ({
    month: getMonthLabel(col),
    revenue: revenue[col] || 0,
    netProfit: netProfit[col] || 0,
  })), [columns, revenue, netProfit]);

  const empty = data.every((d) => d.revenue === 0 && d.netProfit === 0);

  return (
    <div className="mt-card p-4 h-full">
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm font-semibold" style={{ color: 'var(--mt-text-primary)' }}>
          Revenue &amp; Net Profit
        </div>
        <div className="text-[11px]" style={{ color: 'var(--mt-text-faint)' }}>
          Monthly · {data.length} {data.length === 1 ? 'month' : 'months'}
        </div>
      </div>
      <div style={{ width: '100%', height: 240 }}>
        <ResponsiveContainer>
          <ComposedChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--mt-border)" />
            <XAxis dataKey="month" tick={{ fontSize: 11, fill: 'var(--mt-text-faint)' }} stroke="var(--mt-border)" />
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
            <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />
            <Bar dataKey="revenue" name="Revenue" fill="#10b981" radius={[4, 4, 0, 0]} />
            <Line
              type="monotone"
              dataKey="netProfit"
              name="Net Profit"
              stroke="#6366f1"
              strokeWidth={2}
              dot={{ r: 3, fill: '#6366f1' }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      {empty && (
        <div className="text-[11px] text-center mt-2" style={{ color: 'var(--mt-text-faint)' }}>
          No activity in this period
        </div>
      )}
    </div>
  );
}
