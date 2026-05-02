# Operational Insights backend follow-ups

This file lists the **(B) needs new backend** and **(C) partial backend**
items that came out of the May 2026 redesign of the `/insights` page (the
pace-adjusted target tracking page).

Everything categorised **(A) buildable client-side** already shipped in
[`client/src/pages/OperationalInsightsPage.tsx`](client/src/pages/OperationalInsightsPage.tsx).

The redesign brief required: don't fabricate numbers, don't show alarmist
status when it's just early in the month, ship whatever subset is
buildable on day one. This list is the rest.

---

## 1. Historical day-N comparison — needs prior-month MTD-as-of-day-N

**Severity:** non-blocking; the dependent KPI tile and "How does this look
vs prior months?" card simply don't render until the data is available.

### What ships today
The headline KPI strip surfaces four tiles (Earned / Projected / Gap /
Streams at risk). The redesign brief asks for a fifth tile —
"vs prior 3-mo avg (day-N)" — and a full-card "How does this look vs
prior months?" comparison. Both are deferred because the
`/dashboard/operational-insights` endpoint only returns one prior month's
MTD (`lastMonthMtd` per card), not three; and even that single prior
month is the per-card field, not a structured day-N rollup.

### What the server needs to expose
A new field on the response (or a new endpoint) that returns, for each
prior month in a fixed window, **the revenue total as of the same day-of-
month and the eventual full-month attainment**. Shape:

```jsonc
{
  "historicalDayN": [
    {
      "month": "2026-02",
      "monthLabel": "Feb '26",
      "dayOfMonth": 2,                 // matches today's day-of-month
      "actualThroughDayN": 145320,     // revenue summed across all streams
      "fullMonthActual": 3210560,      // for "finished at X% of target"
      "monthlyTarget": 3050000,
      "attainmentPct": 105.3
    },
    { "month": "2026-03", "...": "..." },
    { "month": "2026-04", "...": "..." }
  ]
}
```

The server already computes `monthlyTarget` per stream for the current
month; the same query, rerun against `bill_month = ?` for each of the
prior 3 calendar months with `bill_date` cut off at the day-of-month
matching today, gives the answer.

### How to wire it on the client
Once the field is present:

1. Render the fifth KPI tile in the summary strip — the file already has
   the `<SummaryKpi>` slot reserved; pass `tone="purple"` per the brief.
2. Add a "How does this look vs prior months?" card under the stream grid
   that consumes `historicalDayN` (3 prior tiles + 1 current-month tile,
   tinted by today's actual vs the 3-month average).

The data shape is the only thing blocking both — the layout is already
designed in the redesign brief and can be added inline once the field
lands.

---

## 2. Pharmacy outlier rupee leak inside `/dashboard/operational-insights`

**Severity:** soft; Lever 3 (margin fix) currently fetches
`/dashboard/pharmacy-analytics` separately to get the leak figure.

### What ships today
[`client/src/pages/OperationalInsightsPage.tsx`](client/src/pages/OperationalInsightsPage.tsx)
makes a parallel call to `/dashboard/pharmacy-analytics` so the Recovery
Lever 3 ("Re-price N outlier pharmacy SKUs") can compute the rupee leak
from low-margin sales. This works but is a second round-trip on every
page load.

### Suggested server change
Add a `recovery` block to the `/dashboard/operational-insights` response
with the pharmacy leak pre-aggregated:

```jsonc
{
  "recovery": {
    "pharmacy": {
      "lowMarginRupees": 17350,      // sum of sales_amount where margin < 5%
      "lowMarginSkuCount": 8,
      "lowMarginThreshold": 5
    }
  }
}
```

The threshold should match `LOW_MARGIN_THRESHOLD` in
[`client/src/components/dashboard/PharmacyAnalytics.tsx`](client/src/components/dashboard/PharmacyAnalytics.tsx)
(currently 5%). Once available, drop the parallel fetch on the client
and read from this block.

---

## 3. Daily progression — combined daily total from server

**Severity:** soft; client-side aggregation works fine for the volumes
this page sees.

### What ships today
The daily progression chart sums per-stream `daily[]` arrays client-side
to build the combined timeline. This is fine for the current data
volumes (one row per day per stream) but means we move ~60 rows over the
wire that the server could collapse into 31.

### Suggested server change
Add a `combinedDaily` field that pre-sums per-day revenue across all
streams:

```jsonc
{
  "combinedDaily": [
    { "date": "2026-05-01", "revenue": 65430 },
    { "date": "2026-05-02", "revenue": 67732 }
  ]
}
```

This is a pure perf optimisation — no UI change required.

---

## 4. Day-matched weekly comparison — needs per-day breakdown of last week

**Severity:** non-blocking; the weekly comparison currently hides the
"% change" column when the current week has fewer than 5 weekdays
elapsed.

### What ships today
The redesign brief asks for a day-matched weekly comparison: when the
current week has only Mon-Wed, the comparison should be against last
week's Mon-Wed (not the full Mon-Sun). Today the server returns
`thisWeek` and `lastWeek` as full-week aggregates with no day-by-day
breakdown — so a Mon-Wed-only sum for last week isn't reconstructible
client-side without an extra fetch.

What the page does instead, per the redesign brief's escalation path:

| Days elapsed in current week | Behaviour |
|---|---|
| < 2 | Hide the comparison entirely with a placeholder note |
| 2–4 | Show this week's totals only, no last-week column or % change, with a "comparison appears after Friday" note |
| ≥ 5 | Full week-vs-week comparison (existing behaviour) |

### Suggested server change
Either:

* Add `lastWeekDaily: { date: "...", revenue: X, ... }[]` so the client
  can sum the matching weekdays itself, OR
* Add a `daysElapsedThisWeek` parameter (or always pass it) and have the
  server return `lastWeekMatchedDays` (last week's totals capped to the
  same number of weekdays).

Option 2 is the smaller payload but pushes the date logic to the
server. Option 1 keeps the server simpler but adds a few rows.

When this lands, change `WeeklyComparison` in
[`client/src/pages/OperationalInsightsPage.tsx`](client/src/pages/OperationalInsightsPage.tsx)
to use the new field instead of hiding the comparison column.

---

## Notes on what was fixed client-side (no backend needed)

For posterity, the methodology fixes that did NOT require backend
changes:

* **Pacing math** — server already computes per-card
  `projected = dailyRate × daysInMonth`, so re-deriving status thresholds
  to 90 / 60 instead of 95 / 80 was a one-helper change in
  `statusByProjected()`.
* **Header status pill** — text + colour now derived from the projected
  end-of-month attainment (`projected / target`), with a four-state
  ladder (On track / On pace, watch / On pace, slow start / Behind
  target).
* **Stream pill labels** — switched from "−X%" (raw delta vs full-month
  target, which was alarmist) to "X% projected" (pace-adjusted
  attainment).
* **Combined Revenue Progress** — added a black "Today" marker at the
  % of month elapsed and an amber "Projected end" marker at the
  projected attainment %.
* **Pharmacy Gross Margin** — moved out of the orphan slot in the stream
  grid into a full-width strip with green / amber / red tinting based on
  margin-vs-forecast.
