import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

interface Props {
  /** FY-start boundary (inclusive). Dates before this are disabled. */
  fyStart: string; // YYYY-MM-DD
  /** FY-end boundary, informational only — used for the "crosses FY" warning. */
  fyEnd: string;
  /** Existing from/to (or '' on first open). */
  initialFrom: string;
  initialTo: string;
  onApply: (from: string, to: string) => void;
  onCancel: () => void;
}

const SHORT_MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const FULL_MONTH = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function pad2(n: number): string { return String(n).padStart(2, '0'); }

function toIso(year: number, month0: number, day: number): string {
  return `${year}-${pad2(month0 + 1)}-${pad2(day)}`;
}

function formatLong(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso + 'T00:00:00');
  return `${pad2(d.getDate())} ${SHORT_MONTH[d.getMonth()]} ${d.getFullYear()}`;
}

/** Days in a month, accounting for leap years (month0 is 0-indexed). */
function daysInMonth(year: number, month0: number): number {
  return new Date(year, month0 + 1, 0).getDate();
}

/** JS getDay() returns 0=Sun..6=Sat. We want Mon=0..Sun=6 for an MTWTFSS layout. */
function mondayFirstDay(year: number, month0: number): number {
  const dow = new Date(year, month0, 1).getDay(); // 0=Sun..6=Sat
  return (dow + 6) % 7; // 0=Mon..6=Sun
}

/**
 * Range calendar used inside the period picker's "Custom range" mode.
 *
 * Selection flow (spec):
 *   1st click  → sets `tempFrom`, clears `tempTo`
 *   2nd click  → if >= tempFrom, sets `tempTo`. If < tempFrom, swaps (the
 *                earlier date becomes tempFrom, previous tempFrom becomes
 *                tempTo)
 *   3rd click  → starts a new selection
 *
 * The parent commits the selection only when the user clicks Apply, so the
 * picker's outer `value` doesn't churn on every click during selection.
 */
export default function VcfoRangeCalendar({ fyStart, fyEnd, initialFrom, initialTo, onApply, onCancel }: Props) {
  const today = useMemo(() => new Date(), []);
  const todayIso = today.toISOString().slice(0, 10);

  const [tempFrom, setTempFrom] = useState(initialFrom);
  const [tempTo, setTempTo] = useState(initialTo);
  // Which input the next click targets — used to highlight the "To" card
  // when the user has set From and is now picking the end of the range.
  const [activeSide, setActiveSide] = useState<'from' | 'to'>(initialFrom && !initialTo ? 'to' : 'from');

  // Calendar view month. Anchors on the From date when present, otherwise
  // today's month. Doesn't re-anchor as the user navigates with ‹/›.
  const initialAnchor = useMemo(() => {
    const anchor = initialFrom || todayIso;
    const d = new Date(anchor + 'T00:00:00');
    return { year: d.getFullYear(), month0: d.getMonth() };
  }, [initialFrom, todayIso]);
  const [viewYear, setViewYear] = useState(initialAnchor.year);
  const [viewMonth0, setViewMonth0] = useState(initialAnchor.month0);

  // Keep `activeSide` in sync if the parent reopens the calendar with new
  // initial values mid-session.
  useEffect(() => {
    setTempFrom(initialFrom);
    setTempTo(initialTo);
    setActiveSide(initialFrom && !initialTo ? 'to' : 'from');
  }, [initialFrom, initialTo]);

  function gotoPrev() {
    if (viewMonth0 === 0) { setViewYear(y => y - 1); setViewMonth0(11); }
    else setViewMonth0(m => m - 1);
  }
  function gotoNext() {
    if (viewMonth0 === 11) { setViewYear(y => y + 1); setViewMonth0(0); }
    else setViewMonth0(m => m + 1);
  }

  function handleDayClick(iso: string) {
    // First click — or third+ click that's "starting over"
    if (!tempFrom || (tempFrom && tempTo)) {
      setTempFrom(iso);
      setTempTo('');
      setActiveSide('to');
      return;
    }
    // Second click — From set, To empty
    if (iso < tempFrom) {
      // Click is before From → swap so From is always <= To.
      setTempTo(tempFrom);
      setTempFrom(iso);
    } else {
      setTempTo(iso);
    }
    setActiveSide('from');
  }

  // Cell-state helpers ─────────────────────────────────────────────────────

  function inSelectedRange(iso: string): boolean {
    if (!tempFrom || !tempTo) return false;
    return iso > tempFrom && iso < tempTo;
  }
  function isSelectedEdge(iso: string): boolean {
    return iso === tempFrom || iso === tempTo;
  }
  function isDisabled(iso: string): boolean {
    // Future dates beyond today, OR before FY start. Single-day ranges are
    // still allowed, hence strict inequality on `> todayIso` (today itself
    // is selectable).
    return iso > todayIso || iso < fyStart;
  }

  // Range warnings ─────────────────────────────────────────────────────────

  const crossesFy = useMemo(() => {
    if (!tempFrom || !tempTo) return false;
    return tempFrom < fyStart || tempTo > fyEnd;
  }, [tempFrom, tempTo, fyStart, fyEnd]);

  const exceedsTwoYears = useMemo(() => {
    if (!tempFrom || !tempTo) return false;
    const days = (new Date(tempTo + 'T00:00:00').getTime() - new Date(tempFrom + 'T00:00:00').getTime()) / 86400000;
    return days > 730;
  }, [tempFrom, tempTo]);

  // Calendar grid build ────────────────────────────────────────────────────

  const days = daysInMonth(viewYear, viewMonth0);
  const leadingBlank = mondayFirstDay(viewYear, viewMonth0); // 0..6
  const prevMonthDays = daysInMonth(viewMonth0 === 0 ? viewYear - 1 : viewYear, (viewMonth0 + 11) % 12);

  // Build 42 cells (6 weeks × 7 days). Cells before the 1st render as
  // trailing days of the previous month at 50% opacity; cells after the
  // last render as leading days of the next month, same opacity.
  const cells: Array<{ iso: string; day: number; outOfMonth: boolean }> = [];
  for (let i = 0; i < leadingBlank; i++) {
    const day = prevMonthDays - leadingBlank + 1 + i;
    const py = viewMonth0 === 0 ? viewYear - 1 : viewYear;
    const pm = (viewMonth0 + 11) % 12;
    cells.push({ iso: toIso(py, pm, day), day, outOfMonth: true });
  }
  for (let d = 1; d <= days; d++) {
    cells.push({ iso: toIso(viewYear, viewMonth0, d), day: d, outOfMonth: false });
  }
  while (cells.length < 42) {
    const day = cells.length - (leadingBlank + days) + 1;
    const ny = viewMonth0 === 11 ? viewYear + 1 : viewYear;
    const nm = (viewMonth0 + 1) % 12;
    cells.push({ iso: toIso(ny, nm, day), day, outOfMonth: true });
  }

  const canApply = !!tempFrom && !!tempTo;

  // ─── Render ─────────────────────────────────────────────────────────────

  return (
    <div
      className="mt-3 pt-3"
      style={{ borderTop: '0.5px solid rgba(148, 163, 184, 0.25)' }}
    >
      {/* From / arrow / To input row */}
      <div className="flex items-center gap-2">
        <InputCard
          label="FROM"
          value={tempFrom}
          active={activeSide === 'from'}
          onClick={() => setActiveSide('from')}
        />
        <span className="text-[14px] text-theme-faint">→</span>
        <InputCard
          label="TO"
          value={tempTo}
          active={activeSide === 'to'}
          onClick={() => setActiveSide('to')}
        />
      </div>

      {/* Calendar */}
      <div
        className="mt-2"
        style={{
          background: 'var(--mt-surface-2, rgba(148, 163, 184, 0.08))',
          borderRadius: 8,
          padding: 10,
        }}
      >
        {/* Header: prev / month-year label / next */}
        <div className="flex items-center justify-between mb-2">
          <button
            type="button"
            onClick={gotoPrev}
            className="p-1 rounded hover:bg-dark-700 text-theme-secondary"
            aria-label="Previous month"
          >
            <ChevronLeft size={14} />
          </button>
          <div className="text-[13px] font-medium text-theme-primary">
            {FULL_MONTH[viewMonth0]} {viewYear}
          </div>
          <button
            type="button"
            onClick={gotoNext}
            className="p-1 rounded hover:bg-dark-700 text-theme-secondary"
            aria-label="Next month"
          >
            <ChevronRight size={14} />
          </button>
        </div>

        {/* Day-of-week row (Mon-first) */}
        <div className="grid grid-cols-7" style={{ gap: 2 }}>
          {['M','T','W','T','F','S','S'].map((d, i) => (
            <div key={i} className="text-center text-[10px] text-theme-faint">{d}</div>
          ))}
        </div>

        {/* Date cells */}
        <div className="grid grid-cols-7 mt-1" style={{ gap: 2 }}>
          {cells.map((c, i) => {
            const disabled = isDisabled(c.iso);
            const isEdge = isSelectedEdge(c.iso);
            const inRange = inSelectedRange(c.iso);
            const isToday = c.iso === todayIso;

            // Style cascade: disabled > out-of-month > edge > in-range > default.
            const baseStyle: React.CSSProperties = {
              padding: '6px 0',
              fontSize: 10,
              textAlign: 'center',
              borderRadius: 4,
              cursor: disabled ? 'not-allowed' : 'pointer',
              opacity: disabled ? 0.3 : (c.outOfMonth ? 0.5 : 1),
              userSelect: 'none',
              position: 'relative',
            };
            if (isEdge) {
              baseStyle.background = '#185FA5';
              baseStyle.color = '#FFFFFF';
              baseStyle.fontWeight = 500;
            } else if (inRange) {
              baseStyle.background = '#E6F1FB';
              baseStyle.color = '#042C53';
            }

            return (
              <button
                key={i}
                type="button"
                disabled={disabled}
                onClick={() => !disabled && handleDayClick(c.iso)}
                style={baseStyle}
                title={c.iso}
              >
                {c.day}
                {isToday && !isEdge && (
                  <span
                    aria-hidden
                    style={{
                      position: 'absolute',
                      bottom: 2,
                      left: '50%',
                      transform: 'translateX(-50%)',
                      width: 3,
                      height: 3,
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

      {/* Warnings */}
      {crossesFy && (
        <div className="mt-2 text-[10px] text-theme-faint">
          This range crosses FY boundaries — data may include partial entries from a different fiscal year. Confirm before applying.
        </div>
      )}
      {exceedsTwoYears && (
        <div className="mt-1 text-[10px] text-theme-faint">
          Long date range may be slow to load (&gt;2 years).
        </div>
      )}

      {/* Action buttons */}
      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 rounded-md text-[12px] font-medium text-theme-secondary border border-dark-400/40 hover:bg-dark-700 transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={!canApply}
          onClick={() => canApply && onApply(tempFrom, tempTo)}
          className="px-3 py-1.5 rounded-md text-[12px] font-medium text-white transition-opacity"
          style={{
            background: '#185FA5',
            opacity: canApply ? 1 : 0.4,
            cursor: canApply ? 'pointer' : 'not-allowed',
          }}
        >
          Apply range
        </button>
      </div>
    </div>
  );
}

// ─── From/To input card ──────────────────────────────────────────────────

function InputCard({
  label, value, active, onClick,
}: { label: string; value: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex-1 flex flex-col items-start rounded-lg text-left transition-colors"
      style={{
        padding: '7px 10px',
        border: active ? '0.5px solid #185FA5' : '0.5px solid rgba(148, 163, 184, 0.3)',
        background: active ? '#E6F1FB' : 'transparent',
        borderRadius: 8,
      }}
    >
      <span className="text-[10px] uppercase tracking-wider text-theme-faint">{label}</span>
      <span
        className="text-[13px]"
        style={{ color: active ? '#042C53' : 'inherit' }}
      >
        {value ? formatLong(value) : '—'}
      </span>
    </button>
  );
}
