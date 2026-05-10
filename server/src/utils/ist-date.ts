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
 * The "anchor date" of the auto-sync tick currently active in Asia/Kolkata
 * — i.e. the IST date of the most recent scheduled tick firing.
 *
 * The auto-sync scheduler fires a primary tick at `scheduleHour` IST every
 * night, plus retry firings at +30 min, +2 hr, +6 hr (i.e. 23:30, 01:00,
 * 05:00 IST by default). Both the *data window* a retry should sync and
 * the *audit row date* it should write to must be anchored to the ORIGINAL
 * 23:00 firing's date, NOT to the wall-clock date when the retry happens
 * to fire — otherwise a 01:00 retry shifts to the next calendar day, asks
 * for the wrong data window, and looks like a fresh tick that runs the
 * sync twice (once at 23:00 against the right window, once at 01:00
 * against the wrong window).
 *
 * Returns `{ today, yesterday }` where `today` is the anchor date and
 * `yesterday` is one day earlier. For the standard 2-day rolling window
 * (today + yesterday), pass these directly as `toDate` / `fromDate`.
 *
 * Behaviour with scheduleHour=23:
 *   23:00 IST May 8 (primary fires)         → anchor = May 8
 *   23:30 IST May 8 (retry 1)                → anchor = May 8
 *   00:30 IST May 9 (long tick spanning midnight) → anchor = May 8
 *   01:00 IST May 9 (retry 2)                → anchor = May 8
 *   05:00 IST May 9 (retry 3)                → anchor = May 8
 *   22:59 IST May 9 (still pre-tonight-tick) → anchor = May 8
 *   23:00 IST May 9 (next primary fires)     → anchor = May 9
 */
export function tickAnchorIst(scheduleHour: number = 23): { today: string; yesterday: string } {
  const now = new Date();
  const p = partsInIst(now);
  // If we're at or past today's scheduleHour, today's tick has already
  // fired (or is firing right now) — anchor is today. Otherwise we're
  // still in the retry tail of yesterday's tick — anchor is yesterday.
  const inTodaysTick = p.hour >= scheduleHour;
  const anchorMs = inTodaysTick ? now.getTime() : now.getTime() - 24 * 60 * 60 * 1000;
  const ap = partsInIst(new Date(anchorMs));
  const yp = partsInIst(new Date(anchorMs - 24 * 60 * 60 * 1000));
  return {
    today: `${ap.year}-${pad(ap.month)}-${pad(ap.day)}`,
    yesterday: `${yp.year}-${pad(yp.month)}-${pad(yp.day)}`,
  };
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
