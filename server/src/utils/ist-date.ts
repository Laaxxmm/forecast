// India-time helpers used by the auto-sync scheduler.
// No external timezone library — Intl.DateTimeFormat with timeZone option
// gives correct results for Asia/Kolkata across DST-free India.

const IST_TZ = 'Asia/Kolkata';

function partsInIst(d: Date): { year: number; month: number; day: number; hour: number; minute: number } {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: IST_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const out: any = {};
  for (const p of fmt.formatToParts(d)) {
    if (p.type === 'year') out.year = parseInt(p.value);
    else if (p.type === 'month') out.month = parseInt(p.value);
    else if (p.type === 'day') out.day = parseInt(p.value);
    else if (p.type === 'hour') out.hour = parseInt(p.value === '24' ? '0' : p.value);
    else if (p.type === 'minute') out.minute = parseInt(p.value);
  }
  return out;
}

function pad(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

/** Today's date in Asia/Kolkata as YYYY-MM-DD. */
export function todayIst(): string {
  const p = partsInIst(new Date());
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Yesterday's date in Asia/Kolkata as YYYY-MM-DD (rolling, midnight-safe). */
export function yesterdayIst(): string {
  const now = new Date();
  // Subtract 24h then format in IST. Safe because IST has no DST.
  const yest = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const p = partsInIst(yest);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Current time in IST as HH:MM (24h). */
export function nowIstHHMM(): string {
  const p = partsInIst(new Date());
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/**
 * Returns true if "now" in Asia/Kolkata is at-or-past the given hour
 * (e.g. ist23pmTodayPassed() === true after 23:00 IST). Used by the
 * boot-time catch-up scan to decide whether the day's scheduled tick
 * should already have fired.
 */
export function istHourPassed(hour24: number): boolean {
  const p = partsInIst(new Date());
  return p.hour > hour24 || (p.hour === hour24 && p.minute >= 0);
}

/**
 * Pick the "report date" for an Insight PDF: the last fully-synced day
 * in IST. Auto-sync runs at 23:00 IST nightly, so before 23:00 the most
 * recent fully-synced day is yesterday; after 23:00 it's today.
 *
 * Returns the date as YYYY-MM-DD plus the YYYY-MM month string and the
 * day-of-month / days-in-month convenience fields callers need to drive
 * the rest of the operational-insights aggregation.
 */
export function reportDateIst(): {
  date: string;
  month: string;
  dayOfMonth: number;
  daysInMonth: number;
} {
  const p = partsInIst(new Date());
  // Treat 23:00 as the cutoff. Before 23:00, the day's sync hasn't run
  // yet, so we report on yesterday. At/after 23:00 (running or completed)
  // we report on today.
  let year = p.year;
  let month = p.month;
  let day = p.day;
  if (p.hour < 23) {
    // Roll back one day. Reuse yesterdayIst() so the IST math stays in
    // a single place.
    const y = yesterdayIst(); // YYYY-MM-DD
    const [yy, mm, dd] = y.split('-').map(Number);
    year = yy;
    month = mm;
    day = dd;
  }
  const date = `${year}-${pad(month)}-${pad(day)}`;
  const monthStr = `${year}-${pad(month)}`;
  const daysInMonth = new Date(year, month, 0).getDate();
  return { date, month: monthStr, dayOfMonth: day, daysInMonth };
}
