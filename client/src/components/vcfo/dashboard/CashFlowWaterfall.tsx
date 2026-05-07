import { useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, Cell, ResponsiveContainer, Tooltip, LabelList } from 'recharts';
import { formatRsCompact, formatRs } from '../../../pages/ForecastModulePage';

interface Props {
  opening: number;
  operating: number;
  investing: number;
  financing: number;
  closing: number;
}

/**
 * 5-bar waterfall: Open / +Operating / -Investing / Financing / Close.
 * Implemented with Recharts via the standard "transparent placeholder
 * stacked under a visible value bar" trick so positive and negative
 * deltas slot above/below the running cash level.
 *
 * Open and Close are absolute bars (full height from zero). The three
 * activity bars sit at their running-cumulative position.
 */
export default function CashFlowWaterfall({ opening, operating, investing, financing, closing }: Props) {
  const data = useMemo(() => {
    // Running cumulative starts at opening and applies each delta.
    const c1 = opening;
    const c2 = c1 + operating;
    const c3 = c2 + investing;
    const c4 = c3 + financing;

    // For each delta bar: the "base" is the lower of (before, after);
    // the "value" is the absolute delta. Recharts stacks them.
    const deltaRow = (label: string, before: number, delta: number) => {
      const after = before + delta;
      return {
        name: label,
        base: Math.min(before, after),
        value: Math.abs(delta),
        signed: delta,
        cumulative: after,
        kind: 'delta' as const,
      };
    };

    return [
      { name: 'Open',     base: 0, value: opening, signed: opening, cumulative: c1, kind: 'absolute' as const },
      deltaRow('+Op',     c1, operating),
      deltaRow('-Inv',    c2, investing),
      deltaRow('Fin',     c3, financing),
      { name: 'Close',    base: 0, value: closing, signed: closing, cumulative: closing, kind: 'absolute' as const },
    ];
  }, [opening, operating, investing, financing, closing]);

  const colorFor = (row: typeof data[number]) => {
    if (row.kind === 'absolute') {
      return row.signed >= 0 ? 'var(--mt-pl-indirect-gray)' : 'var(--mt-pl-direct-red)';
    }
    if (row.name === '+Op')   return 'var(--mt-pl-net-green)';
    if (row.name === '-Inv')  return 'var(--mt-pl-direct-red)';
    return 'var(--mt-pl-indirect-gray)';
  };

  return (
    <div style={{ width: '100%', height: 200 }}>
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 24, right: 12, left: 0, bottom: 4 }}>
          <XAxis
            dataKey="name"
            tick={{ fontSize: 11, fill: 'var(--mt-text-faint)' }}
            stroke="var(--mt-border)"
          />
          <YAxis
            tick={{ fontSize: 11, fill: 'var(--mt-text-faint)' }}
            stroke="var(--mt-border)"
            tickFormatter={(v: number) => formatRsCompact(v)}
            width={60}
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
            formatter={(_v: number, _k: string, item: any) => [formatRs(item?.payload?.signed ?? 0), item?.payload?.name || '']}
          />
          {/* Transparent placeholder positions the visible bar at the running level */}
          <Bar dataKey="base" stackId="wf" fill="transparent" isAnimationActive={false} />
          <Bar dataKey="value" stackId="wf" radius={[3, 3, 0, 0]} isAnimationActive={false}>
            {data.map((row, i) => (
              <Cell key={i} fill={colorFor(row)} />
            ))}
            <LabelList
              dataKey="signed"
              position="top"
              formatter={(v: number) => (v > 0 ? '+' : '') + formatRsCompact(v).replace('Rs', '')}
              style={{ fontSize: 10, fill: 'var(--mt-text-secondary)' }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
