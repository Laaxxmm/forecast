import { useMemo, useState } from 'react';
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend, ReferenceArea, Cell,
} from 'recharts';
import { formatRs, formatRsCompact, getMonthLabel } from '../../../pages/ForecastModulePage';

interface Props {
  columns: string[];                       // YYYY-MM strings
  revenue: Record<string, number>;
  netProfit: Record<string, number>;
}

type ViewMode = 'monthly' | 'quarterly' | 'cumulative';

const QUARTER_FOR_MONTH: Record<number, 'Q1' | 'Q2' | 'Q3' | 'Q4'> = {
  4: 'Q1', 5: 'Q1', 6: 'Q1',
  7: 'Q2', 8: 'Q2', 9: 'Q2',
  10: 'Q3', 11: 'Q3', 12: 'Q3',
  1: 'Q4', 2: 'Q4', 3: 'Q4',
};

/**
 * Revenue & net profit trend — full-width composed chart.
 *
 *  - In Monthly mode, months with no data render as faint bars overlaid
 *    by a labelled ReferenceArea ("Future periods — no data yet"), so
 *    the FY frame stays intact without faking flat-zero performance.
 *  - The toggle group exposes Quarterly (Indian FY: Apr-Jun = Q1, etc.)
 *    and Cumulative (running totals) — both derived client-side from the
 *    monthly columns.
 */
export default function TrendCard({ columns, revenue, netProfit }: Props) {
  const [view, setView] = useState<ViewMode>('monthly');

  const monthlyData = useMemo(() => columns.map((col) => ({
    key: col,
    label: getMonthLabel(col),
    revenue: revenue[col] || 0,
    netProfit: netProfit[col] || 0,
    isEmpty: (revenue[col] || 0) === 0 && (netProfit[col] || 0) === 0,
  })), [columns, revenue, netProfit]);

  const quarterlyData = useMemo(() => {
    const buckets: Record<string, { revenue: number; netProfit: number }> = {
      Q1: { revenue: 0, netProfit: 0 }, Q2: { revenue: 0, netProfit: 0 },
      Q3: { revenue: 0, netProfit: 0 }, Q4: { revenue: 0, netProfit: 0 },
    };
    columns.forEach((col) => {
      const m = parseInt(col.split('-')[1], 10);
      const q = QUARTER_FOR_MONTH[m];
      if (q) {
        buckets[q].revenue += revenue[col] || 0;
        buckets[q].netProfit += netProfit[col] || 0;
      }
    });
    return (['Q1', 'Q2', 'Q3', 'Q4'] as const).map((q) => ({
      key: q,
      label: q,
      revenue: buckets[q].revenue,
      netProfit: buckets[q].netProfit,
      isEmpty: buckets[q].revenue === 0 && buckets[q].netProfit === 0,
    }));
  }, [columns, revenue, netProfit]);

  const cumulativeData = useMemo(() => {
    let r = 0, n = 0;
    return columns.map((col) => {
      r += revenue[col] || 0;
      n += netProfit[col] || 0;
      return { key: col, label: getMonthLabel(col), revenue: r, netProfit: n, isEmpty: false };
    });
  }, [columns, revenue, netProfit]);

  const data =
    view === 'monthly' ? monthlyData :
    view === 'quarterly' ? quarterlyData :
    cumulativeData;

  const monthsWithData = monthlyData.filter((d) => !d.isEmpty).length;
  const totalMonths = monthlyData.length;

  // Find contiguous empty range for the ReferenceArea (only in monthly view).
  const emptyRange = useMemo(() => {
    if (view !== 'monthly') return null;
    const firstEmpty = monthlyData.findIndex((d) => d.isEmpty);
    if (firstEmpty < 0) return null;
    let lastEmpty = firstEmpty;
    for (let i = firstEmpty; i < monthlyData.length; i++) {
      if (monthlyData[i].isEmpty) lastEmpty = i;
    }
    return { x1: monthlyData[firstEmpty].label, x2: monthlyData[lastEmpty].label };
  }, [monthlyData, view]);

  return (
    <div className="mt-card p-4 h-full">
      <div className="flex items-start justify-between mb-3 gap-3 flex-wrap">
        <div>
          <div className="text-sm font-semibold" style={{ color: 'var(--mt-text-primary)' }}>
            Revenue &amp; net profit
          </div>
          <div className="text-[11px] mt-0.5" style={{ color: 'var(--mt-text-faint)' }}>
            Showing months with data · {monthsWithData} of {totalMonths}
          </div>
        </div>
        <ViewToggle view={view} onChange={setView} />
      </div>
      <div style={{ width: '100%', height: 240 }}>
        <ResponsiveContainer>
          <ComposedChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--mt-border)" />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--mt-text-faint)' }} stroke="var(--mt-border)" />
            <YAxis
              tick={{ fontSize: 11, fill: 'var(--mt-text-faint)' }}
              stroke="var(--mt-border)"
              tickFormatter={(v: number) => formatRsCompact(v)}
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
            {emptyRange && (
              <ReferenceArea
                x1={emptyRange.x1}
                x2={emptyRange.x2}
                fill="var(--mt-bg-muted)"
                fillOpacity={0.6}
                stroke="none"
                ifOverflow="extendDomain"
                label={{
                  value: 'Future periods — no data yet',
                  position: 'center',
                  fontSize: 11,
                  fill: 'var(--mt-text-faint)',
                }}
              />
            )}
            <Bar dataKey="revenue" name="Revenue" fill="var(--mt-pl-net-green)" radius={[4, 4, 0, 0]}>
              {data.map((d, i) => (
                <Cell key={i} fillOpacity={d.isEmpty ? 0.15 : 1} />
              ))}
            </Bar>
            <Line
              type="monotone"
              dataKey="netProfit"
              name="Net Profit"
              stroke="#534AB7"
              strokeWidth={2}
              dot={{ r: 3, fill: '#534AB7' }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function ViewToggle({ view, onChange }: { view: ViewMode; onChange: (v: ViewMode) => void }) {
  const opts: { key: ViewMode; label: string }[] = [
    { key: 'monthly',    label: 'Monthly' },
    { key: 'quarterly',  label: 'Quarterly' },
    { key: 'cumulative', label: 'Cumulative' },
  ];
  return (
    <div
      className="inline-flex rounded-md text-[11px] font-medium overflow-hidden"
      style={{ border: '1px solid var(--mt-border)', background: 'var(--mt-bg-muted)' }}
    >
      {opts.map((o) => {
        const active = view === o.key;
        return (
          <button
            key={o.key}
            onClick={() => onChange(o.key)}
            className="px-2.5 py-1 transition-colors"
            style={{
              background: active ? 'var(--mt-bg-raised)' : 'transparent',
              color: active ? 'var(--mt-text-primary)' : 'var(--mt-text-faint)',
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
