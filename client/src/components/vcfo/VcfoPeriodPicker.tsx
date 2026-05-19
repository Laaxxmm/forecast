import { useEffect, useMemo, useRef, useState } from 'react';
import { Calendar, ChevronDown } from 'lucide-react';
import VcfoRangeCalendar from './VcfoRangeCalendar';

// Discriminated string union — `'month'` requires `monthIndex` (1–12, calendar
// month, not fiscal). `'fy'` and `'mtd'` map to the legacy "Full year" /
// "This month" quick views. `'ytd'` was removed because it duplicates
// `'fy'` when viewing the current FY and is undefined for past FYs.
export type PeriodPreset =
  | 'fy'
  | 'q1' | 'q2' | 'q3' | 'q4'
  | 'mtd'
  | 'month'
  | 'custom';

export interface PeriodValue {
  preset: PeriodPreset;
  from: string; // YYYY-MM-DD
  to: string;
  /** Calendar month 1–12 (1 = January). Only meaningful when preset === 'month'. */
  monthIndex?: number;
}

interface Props {
  fyStart: string; // YYYY-MM-DD for the April-start of the selected FY
  fyEnd: string;
  value: PeriodValue;
  onChange: (v: PeriodValue) => void;
  /** Hide the calendar icon / compact styling for dense toolbars. */
  compact?: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

const SHORT_MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const FULL_MONTH = ['January','February','March','April','May','June','July','August','September','October','November','December'];

// Indian-FY month order (Apr first, Mar last). Each entry is the 1-based
// calendar month index (Apr=4, ..., Mar=3) so the grid renders in FY order
// while the `monthIndex` we persist stays an unambiguous Jan=1..Dec=12.
const FY_MONTHS: number[] = [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3];

function pad2(n: number): string { return String(n).padStart(2, '0'); }

function lastDayOfMonth(year: number, month1: number): number {
  return new Date(year, month1, 0).getDate();
}

function formatDDMMMYY(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso + 'T00:00:00');
  return `${pad2(d.getDate())} ${SHORT_MONTH[d.getMonth()]} ${String(d.getFullYear()).slice(-2)}`;
}

function formatDDMMM(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso + 'T00:00:00');
  return `${pad2(d.getDate())} ${SHORT_MONTH[d.getMonth()]}`;
}

// ─── Component ────────────────────────────────────────────────────────────

export default function VcfoPeriodPicker({ fyStart, fyEnd, value, onChange, compact }: Props) {
  const [open, setOpen] = useState(false);
  // Whether the inline calendar is expanded. Auto-expands when user clicks
  // the "Custom range" segment; auto-collapses on Apply/Cancel.
  const [calendarOpen, setCalendarOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const today = useMemo(() => new Date(), []);
  const todayIso = today.toISOString().slice(0, 10);
  const fyYear = parseInt(fyStart.slice(0, 4), 10); // e.g. 2026 for FY 26-27
  const fyLabel = `FY ${String(fyYear).slice(-2)}-${String(fyYear + 1).slice(-2)}`;

  // For each FY-ordered month slot, compute the calendar year (Apr-Dec stay
  // in fyYear; Jan-Mar roll into fyYear+1) and whether it has started yet.
  const monthMeta = useMemo(() => FY_MONTHS.map(m1 => {
    const year = m1 >= 4 ? fyYear : fyYear + 1;
    const monthStartIso = `${year}-${pad2(m1)}-01`;
    const isFuture = monthStartIso > todayIso;
    const isCurrent = today.getFullYear() === year && (today.getMonth() + 1) === m1;
    return { m1, year, isFuture, isCurrent, monthStartIso };
  }), [fyYear, todayIso, today]);

  // ─── Range computation ──────────────────────────────────────────────────
  // Quarters use canonical Indian-FY boundaries; 'month' uses the explicit
  // monthIndex+year captured at click time. 'mtd' = current calendar month
  // up to today. 'fy' = the parent-anchored FY. 'custom' preserves whatever
  // the caller supplied.

  function rangeForPreset(preset: PeriodPreset, monthIndex?: number): { from: string; to: string } {
    switch (preset) {
      case 'fy':  return { from: fyStart, to: fyEnd };
      case 'q1': return { from: `${fyYear}-04-01`,     to: `${fyYear}-06-30` };
      case 'q2': return { from: `${fyYear}-07-01`,     to: `${fyYear}-09-30` };
      case 'q3': return { from: `${fyYear}-10-01`,     to: `${fyYear}-12-31` };
      case 'q4': return { from: `${fyYear + 1}-01-01`, to: `${fyYear + 1}-03-31` };
      case 'mtd': {
        const first = `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-01`;
        return { from: first, to: todayIso };
      }
      case 'month': {
        const mi = monthIndex || (today.getMonth() + 1);
        const year = mi >= 4 ? fyYear : fyYear + 1;
        const start = `${year}-${pad2(mi)}-01`;
        const endDay = lastDayOfMonth(year, mi);
        const fullEnd = `${year}-${pad2(mi)}-${pad2(endDay)}`;
        // For the current month, clip end to today so we don't show a stale
        // "future-end" date range for an in-progress month.
        const end = fullEnd > todayIso ? todayIso : fullEnd;
        return { from: start, to: end };
      }
      case 'custom':
      default:
        return { from: value.from, to: value.to };
    }
  }

  function pick(preset: PeriodPreset, monthIndex?: number) {
    if (preset === 'custom') {
      // Don't commit a new range yet — open the inline calendar and let the
      // user pick + Apply. We seed temp state with whatever from/to is
      // currently active (so the calendar opens on a sensible month).
      setCalendarOpen(true);
      return;
    }
    setCalendarOpen(false);
    const r = rangeForPreset(preset, monthIndex);
    onChange({ preset, from: r.from, to: r.to, monthIndex: preset === 'month' ? monthIndex : undefined });
    // Per spec: close after 150ms so the selected state is briefly visible
    // before the popover collapses.
    window.setTimeout(() => setOpen(false), 150);
  }

  function applyCustomRange(from: string, to: string) {
    setCalendarOpen(false);
    onChange({ preset: 'custom', from, to });
    window.setTimeout(() => setOpen(false), 150);
  }

  function cancelCustomRange() {
    setCalendarOpen(false);
  }

  // ─── Label resolution ───────────────────────────────────────────────────

  function periodName(): string {
    switch (value.preset) {
      case 'fy':  return `${fyLabel} · Full year`;
      case 'q1': return `Q1 · Apr–Jun ${fyYear}`;
      case 'q2': return `Q2 · Jul–Sep ${fyYear}`;
      case 'q3': return `Q3 · Oct–Dec ${fyYear}`;
      case 'q4': return `Q4 · Jan–Mar ${fyYear + 1}`;
      case 'mtd': return `This month`;
      case 'month': {
        const mi = value.monthIndex || (today.getMonth() + 1);
        const year = mi >= 4 ? fyYear : fyYear + 1;
        return `${FULL_MONTH[mi - 1]} ${year}`;
      }
      case 'custom':
        return `Custom · ${formatDDMMM(value.from)} – ${formatDDMMM(value.to)} ${value.to.slice(0, 4)}`;
    }
  }

  // Compact button label shown on the toolbar trigger.
  const buttonLabel = (() => {
    if (value.preset === 'custom') return `${formatDDMMMYY(value.from)} → ${formatDDMMMYY(value.to)}`;
    return periodName();
  })();

  const dateRangePretty = `${formatDDMMMYY(value.from)} → ${formatDDMMMYY(value.to)}`;

  // ─── Render ─────────────────────────────────────────────────────────────

  const isQuarter = (p: PeriodPreset) => p === 'q1' || p === 'q2' || p === 'q3' || p === 'q4';
  const quarterMeta: Array<{ key: 'q1' | 'q2' | 'q3' | 'q4'; label: string; sub: string }> = [
    { key: 'q1', label: 'Q1', sub: 'Apr–Jun' },
    { key: 'q2', label: 'Q2', sub: 'Jul–Sep' },
    { key: 'q3', label: 'Q3', sub: 'Oct–Dec' },
    { key: 'q4', label: 'Q4', sub: 'Jan–Mar' },
  ];

  // Quick-view segment: derives "active" from the current preset family.
  // Quarters and explicit months stay inert under this segment (they have
  // their own dedicated rows below).
  const quickActive: 'fy' | 'mtd' | 'custom' | null =
    value.preset === 'fy' ? 'fy'
    : value.preset === 'mtd' ? 'mtd'
    : value.preset === 'custom' ? 'custom'
    : null;

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
        <div
          className="absolute z-50 mt-1 right-0 bg-dark-800 border border-dark-400/50 rounded-xl shadow-elev-3"
          style={{ width: 400, padding: '14px 16px' }}
        >
          {/* ── Section A: Active selection bar ───────────────────────── */}
          <div
            className="flex items-center justify-between pb-3"
            style={{ borderBottom: '0.5px solid rgba(148, 163, 184, 0.25)' }}
          >
            <div className="flex items-baseline gap-2 min-w-0">
              <span className="text-[11px] uppercase tracking-wide text-theme-faint">Showing</span>
              <span className="text-[14px] font-medium text-theme-primary truncate">{periodName()}</span>
            </div>
            <span className="text-[11px] text-theme-faint whitespace-nowrap ml-2">{dateRangePretty}</span>
          </div>

          {/* ── Section B: Quick view segment ─────────────────────────── */}
          <div className="mt-3">
            <div className="text-[11px] uppercase tracking-wider text-theme-faint mb-1.5">Quick view</div>
            <div className="grid grid-cols-3 gap-1 p-0.5 rounded-lg bg-dark-700/60">
              {([
                { key: 'fy' as const,     label: 'Full year' },
                { key: 'mtd' as const,    label: 'This month' },
                { key: 'custom' as const, label: 'Custom range' },
              ]).map(opt => {
                const isActive = quickActive === opt.key;
                return (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => pick(opt.key)}
                    className={`px-2 py-1.5 rounded-md text-[12px] font-medium transition-colors ${
                      isActive
                        ? 'bg-dark-800 text-theme-primary shadow-sm'
                        : 'text-theme-secondary hover:bg-dark-700'
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* ── Section C: By quarter ──────────────────────────────────── */}
          <div className="mt-3">
            <div className="text-[11px] uppercase tracking-wider text-theme-faint mb-1.5">By quarter</div>
            <div className="grid grid-cols-4" style={{ gap: 6 }}>
              {quarterMeta.map(q => {
                const isActive = value.preset === q.key;
                return (
                  <button
                    key={q.key}
                    type="button"
                    onClick={() => pick(q.key)}
                    className="flex flex-col items-start text-left rounded-lg transition-all"
                    style={{
                      padding: '7px 8px',
                      border: isActive ? '1px solid #1D9E75' : '0.5px solid rgba(148, 163, 184, 0.3)',
                      background: isActive ? '#EAF3DE' : 'transparent',
                      borderRadius: 8,
                    }}
                  >
                    <span
                      className="text-[12px] font-medium"
                      style={{ color: isActive ? '#04342C' : 'inherit' }}
                    >
                      {q.label}
                    </span>
                    <span
                      className="text-[10px]"
                      style={{ color: isActive ? '#04342C' : 'var(--mt-text-tertiary, rgba(148, 163, 184, 0.7))' }}
                    >
                      {q.sub}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* ── Section D: By month (Apr first, FY order) ─────────────── */}
          <div className="mt-3">
            <div className="text-[11px] uppercase tracking-wider text-theme-faint mb-1.5">By month</div>
            <div className="grid grid-cols-6" style={{ gap: 6 }}>
              {monthMeta.map(({ m1, year, isFuture, isCurrent }) => {
                const isActive = value.preset === 'month' && value.monthIndex === m1;
                return (
                  <button
                    key={`${year}-${m1}`}
                    type="button"
                    disabled={isFuture}
                    onClick={() => !isFuture && pick('month', m1)}
                    className="relative flex items-center justify-center rounded-md transition-all"
                    style={{
                      padding: '6px 4px',
                      border: isActive ? '1px solid #1D9E75' : '0.5px solid rgba(148, 163, 184, 0.3)',
                      background: isActive ? '#EAF3DE' : 'transparent',
                      borderRadius: 6,
                      opacity: isFuture ? 0.5 : 1,
                      cursor: isFuture ? 'not-allowed' : 'pointer',
                    }}
                    title={isFuture ? `${SHORT_MONTH[m1 - 1]} ${year} — not yet started` : `${SHORT_MONTH[m1 - 1]} ${year}`}
                  >
                    <span
                      className="text-[11px] font-medium"
                      style={{ color: isActive ? '#04342C' : 'inherit' }}
                    >
                      {SHORT_MONTH[m1 - 1]}
                    </span>
                    {isCurrent && (
                      <span
                        aria-hidden
                        style={{
                          position: 'absolute',
                          top: 3,
                          right: 4,
                          width: 5,
                          height: 5,
                          borderRadius: '50%',
                          background: '#1D9E75',
                        }}
                      />
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Inline range calendar — expanded when the user picks
              "Custom range" from the Quick view segment. Selection stays
              uncommitted until Apply, so a second-thoughts user can Cancel
              without disturbing the outer period state. */}
          {calendarOpen && (
            <VcfoRangeCalendar
              fyStart={fyStart}
              fyEnd={fyEnd}
              initialFrom={value.preset === 'custom' ? value.from : ''}
              initialTo={value.preset === 'custom' ? value.to : ''}
              onApply={applyCustomRange}
              onCancel={cancelCustomRange}
            />
          )}
        </div>
      )}
    </div>
  );
}
