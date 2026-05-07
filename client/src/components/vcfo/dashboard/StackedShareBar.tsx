interface Segment {
  label: string;
  value: number;          // absolute amount (any sign — abs is used for width)
  color: string;          // CSS color
  textColor?: string;     // Inline label color; default white-ish
}

interface Props {
  /** Total used as the 100% reference (typically Revenue). */
  total: number;
  segments: Segment[];
  /** Bar height in px. Default 28. */
  height?: number;
}

/**
 * Single horizontal stacked bar — each segment occupies a width
 * proportional to abs(value)/total of the parent. Pure CSS flex; no
 * chart library. Used by CompositionCard for the P&L composition.
 *
 * Segments narrower than ~12% suppress their inline label so the bar
 * reads cleanly. The 0% / 50% / 100% scale ticks live in the parent.
 */
export default function StackedShareBar({ total, segments, height = 28 }: Props) {
  const ref = Math.max(Math.abs(total), 1);
  const widths = segments.map((s) => Math.min(100, (Math.abs(s.value) / ref) * 100));

  return (
    <div className="w-full" style={{ height, display: 'flex', borderRadius: 8, overflow: 'hidden' }}>
      {segments.map((s, i) => {
        const w = widths[i];
        if (w < 0.5) return null;
        const showLabel = w >= 12;
        const pctLabel = `${Math.round(w)}%`;
        return (
          <div
            key={s.label + i}
            title={`${s.label} · ${pctLabel}`}
            className="flex items-center justify-center text-[11px] font-medium px-2"
            style={{
              width: `${w}%`,
              background: s.color,
              color: s.textColor ?? 'rgba(255,255,255,0.92)',
              minWidth: 2,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
            }}
          >
            {showLabel && `${s.label} ${pctLabel}`}
          </div>
        );
      })}
    </div>
  );
}
