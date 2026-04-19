import { useEffect, useRef, useState } from 'react';
import { Calendar, ChevronDown } from 'lucide-react';

export type PeriodPreset = 'fy' | 'q1' | 'q2' | 'q3' | 'q4' | 'mtd' | 'ytd' | 'custom';

export interface PeriodValue {
  preset: PeriodPreset;
  from: string; // YYYY-MM-DD
  to: string;
}

interface Props {
  fyStart: string; // YYYY-MM-DD for the April-start of the selected FY
  fyEnd: string;
  value: PeriodValue;
  onChange: (v: PeriodValue) => void;
  /** Hide the calendar icon / compact styling for dense toolbars. */
  compact?: boolean;
}

/**
 * Date-range picker with fiscal-year aware presets.
 *
 * The "anchor" FY comes from the parent (VcfoModulePage). Presets derive
 * their ranges from that anchor — e.g. Q1 = Apr-Jun of fyStart's year,
 * YTD = fyStart → today, MTD = 1st of current month → today.
 *
 * "Custom" exposes two native date inputs for arbitrary ranges. Changes
 * to from/to in custom mode flow back through onChange immediately — no
 * "Apply" button, mirroring ForecastModulePage's inline-edit pattern.
 */
export default function VcfoPeriodPicker({ fyStart, fyEnd, value, onChange, compact }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const today = new Date().toISOString().slice(0, 10);
  const fyYear = parseInt(fyStart.slice(0, 4), 10);

  const rangeForPreset = (preset: PeriodPreset): { from: string; to: string } => {
    switch (preset) {
      case 'fy':
        return { from: fyStart, to: fyEnd };
      case 'q1':
        return { from: `${fyYear}-04-01`, to: `${fyYear}-06-30` };
      case 'q2':
        return { from: `${fyYear}-07-01`, to: `${fyYear}-09-30` };
      case 'q3':
        return { from: `${fyYear}-10-01`, to: `${fyYear}-12-31` };
      case 'q4':
        return { from: `${fyYear + 1}-01-01`, to: `${fyYear + 1}-03-31` };
      case 'mtd': {
        const d = new Date();
        const first = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
        return { from: first, to: today };
      }
      case 'ytd':
        return { from: fyStart, to: today };
      case 'custom':
      default:
        return { from: value.from, to: value.to };
    }
  };

  const pick = (preset: PeriodPreset) => {
    const r = rangeForPreset(preset);
    onChange({ preset, from: r.from, to: r.to });
    if (preset !== 'custom') setOpen(false);
  };

  const presetLabel = (p: PeriodPreset): string => {
    switch (p) {
      case 'fy':
        return `FY ${String(fyYear).slice(-2)}-${String(fyYear + 1).slice(-2)}`;
      case 'q1': return 'Q1 (Apr-Jun)';
      case 'q2': return 'Q2 (Jul-Sep)';
      case 'q3': return 'Q3 (Oct-Dec)';
      case 'q4': return 'Q4 (Jan-Mar)';
      case 'mtd': return 'MTD';
      case 'ytd': return 'YTD';
      case 'custom': return 'Custom';
    }
  };

  const fmt = (s: string) => {
    if (!s) return '—';
    try {
      return new Date(s).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' });
    } catch { return s; }
  };

  const buttonLabel =
    value.preset === 'custom'
      ? `${fmt(value.from)} → ${fmt(value.to)}`
      : presetLabel(value.preset);

  const presets: PeriodPreset[] = ['fy', 'q1', 'q2', 'q3', 'q4', 'mtd', 'ytd', 'custom'];

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className={`flex items-center gap-1.5 rounded-lg border border-dark-400/50 bg-dark-700 hover:bg-dark-600 text-theme-secondary transition-colors ${
          compact ? 'px-2.5 py-1 text-xs' : 'px-3 py-1.5 text-xs md:text-sm'
        }`}
        title="Period"
      >
        <Calendar size={13} className="text-theme-faint" />
        <span className="font-medium whitespace-nowrap">{buttonLabel}</span>
        <ChevronDown size={12} className="text-theme-faint" />
      </button>

      {open && (
        <div className="absolute z-50 mt-1 right-0 bg-dark-800 border border-dark-400/50 rounded-xl shadow-elev-3 p-2 min-w-[240px]">
          <div className="grid grid-cols-2 gap-1">
            {presets.map(p => (
              <button
                key={p}
                type="button"
                onClick={() => pick(p)}
                className={`text-xs px-2.5 py-1.5 rounded-lg transition-colors text-left ${
                  value.preset === p
                    ? 'bg-accent-500/15 text-accent-300 border border-accent-500/30'
                    : 'text-theme-secondary hover:bg-dark-700 border border-transparent'
                }`}
              >
                {presetLabel(p)}
              </button>
            ))}
          </div>
          {value.preset === 'custom' && (
            <div className="mt-2 pt-2 border-t border-dark-400/30 space-y-1.5">
              <div className="flex items-center gap-1.5">
                <label className="text-[10px] uppercase tracking-wide text-theme-faint w-8">From</label>
                <input
                  type="date"
                  value={value.from}
                  max={value.to || undefined}
                  onChange={e => onChange({ ...value, preset: 'custom', from: e.target.value })}
                  className="input text-xs py-1 flex-1"
                />
              </div>
              <div className="flex items-center gap-1.5">
                <label className="text-[10px] uppercase tracking-wide text-theme-faint w-8">To</label>
                <input
                  type="date"
                  value={value.to}
                  min={value.from || undefined}
                  onChange={e => onChange({ ...value, preset: 'custom', to: e.target.value })}
                  className="input text-xs py-1 flex-1"
                />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
