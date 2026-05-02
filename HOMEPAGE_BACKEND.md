# Homepage backend follow-ups

This file lists the **(B) needs new backend** and **(C) partial backend** items
that came out of the May 2026 redesign of the `/actuals` "All" view (the
doctor's homepage). Everything categorised **(A) buildable client-side**
already shipped in [`client/src/components/dashboard/ActualsAllOverview.tsx`](client/src/components/dashboard/ActualsAllOverview.tsx)
+ [`client/src/pages/DashboardPage.tsx`](client/src/pages/DashboardPage.tsx).

The redesign brief required: don't fabricate numbers, don't silently mutate
forecast values, ship whatever subset is buildable on day one. This list is
the rest.

---

## 1. Forecast comparison shows ~−96% deltas every period — diagnose at source

**Severity:** ships with workaround (advisory banner + demoted forecast row),
needs root-cause fix.

### Symptom
The previous KPI strip on `/actuals` showed `−96.3%` / `−96.8%` / `−95.7%`
forecast deltas for Total / Clinic / Pharmacy on every period. The numbers
themselves were not random — they consistently match the ratio
`actual_for_one_month ÷ (annual_target ÷ 1)`, which is the giveaway: a
twelfth of the actual is being compared against the whole-year target.

### Where it likely lives
[`server/src/routes/dashboard.ts`](server/src/routes/dashboard.ts), the
`/dashboard/overview` handler. The forecast sum query at the time of writing
is:

```sql
SELECT COALESCE(SUM(fv.amount), 0) as total
FROM forecast_values fv
JOIN forecast_items fi ON fv.item_id = fi.id
WHERE fi.scenario_id IN (...) AND fi.category = 'revenue'
  AND fv.month >= ? AND fv.month <= ?
```

That looks correct on paper — it's filtering forecast values to the same
month range as the actuals. So the bug is almost certainly in **what's
stored** in `forecast_values`, not in the comparison logic itself.

### What to check on the server
1. For one tenant where the bug reproduces (any of the magnacode-style
   tenants is fine), run:
   ```sql
   SELECT month, SUM(amount) FROM forecast_values fv
   JOIN forecast_items fi ON fv.item_id = fi.id
   WHERE fi.scenario_id = <default-scenario-id>
     AND fi.category = 'revenue'
   GROUP BY month ORDER BY month;
   ```
   - If every month has the **same** value and that value is roughly the
     annual target → the import path is replicating the annual figure
     across all 12 month rows. **Fix in the import / forecast-edit path,
     not on the dashboard.**
   - If only **one** month carries a large value and the rest are zero →
     the forecast was entered as a single annual sum on (e.g.) April. Same
     fix surface — the source of truth is the forecast table, not the
     dashboard query.
   - If the per-month split is genuinely uneven and the API just gets it
     wrong on the dashboard route → bug is in the dashboard query (less
     likely given the SQL above).

2. Check the forecast-input UI flow that wrote those rows:
   - `ForecastModulePage` and friends — does the user enter an annual
     number and we replicate it across months without dividing by 12?

### Don't do this from the client
The brief explicitly says "don't silently change the forecast value being
returned by the API — it may be referenced on other pages (Forecast /
Scenarios)." So the client-side workaround in this redesign is purely
visual: the forecast row is demoted from headline pill to a small footer
on the Total Revenue card, and a soft-amber advisory banner under the KPI
strip explains the situation.

### Removing the workaround
Once the underlying numbers are fixed, flip
`SHOW_FORECAST_ADVISORY = false` in
[`client/src/components/dashboard/ActualsAllOverview.tsx`](client/src/components/dashboard/ActualsAllOverview.tsx).
That single-line edit removes the banner without touching layout.

---

## 2. 6-month trend cannot show pre-FY history

**Severity:** non-blocking; trend shows "appears at 3+ months" placeholder
until enough current-FY data accumulates.

### Symptom
The new `6-month revenue trend` card hides itself when fewer than 3 months
of revenue exist. For a tenant in May 2026 (month 2 of FY 2026-27), only
April + May are visible, so the trend is hidden and a placeholder note
appears instead.

### Why it can't be done client-side
[`server/src/routes/dashboard.ts`](server/src/routes/dashboard.ts) scopes
all queries to scenarios in the **active** financial year (`fy_id`). When
the client passes `startMonth=2026-04` it gets months from FY 2026-27;
passing `startMonth=2025-12` does not transparently fall through to FY
2025-26 — those rows belong to a different `fy_id` and the route only
queries one FY at a time.

### Suggested server change
Add an opt-in parameter to `/dashboard/overview` (e.g.
`?historicalMonths=6`) that, when present, fetches monthly revenue across
the **prior FY too**, not just the current one. The aggregation can stay
in JS — the existing `for (const stream of clientStreams)` loop just needs
to pull scenarios from both FYs and union the monthly results.

When this lands, change
[`client/src/pages/DashboardPage.tsx`](client/src/pages/DashboardPage.tsx)
to pass `historicalMonths: 6` instead of `startMonth: fyStart` for the
trend fetch.

---

## 3. Alert deep-links don't pre-apply sub-tab filters yet

**Severity:** soft polish.

The redesign brief asks each alert click to deep-link to the sub-tab with
the relevant filter pre-applied:

| Alert | Pre-applied filter |
|---|---|
| Margin leak | Pharmacy → Sales & Profit → "Outliers only" |
| Sitting stock | Pharmacy → Cross-Report → status filter "Sitting" |
| Critical expiry | Pharmacy → Stock & Expiry → "Critical only" |
| Supplier concentration | Pharmacy → Purchases (sourcing card visible by default) |
| Cross-sell opportunity | Clinic view (no specific filter required) |

What ships today:
[`client/src/components/dashboard/ActualsAllOverview.tsx`](client/src/components/dashboard/ActualsAllOverview.tsx)
deep-links to the correct **stream** (Pharmacy/Clinic) but not to the
specific tab inside the stream. Once on the sub-tab the user has to click
the filter manually.

### Suggested implementation
A URL hash convention picked up by `PharmacyAnalytics` /
`ClinicAnalytics`:

```
/actuals#pharma-tab=sales&filter=outliers
/actuals#pharma-tab=stock&filter=critical
/actuals#pharma-tab=cross&filter=sitting
```

The sub-tab components already own their tab + filter state — they just
need a small `useEffect` on mount that reads `window.location.hash`,
parses the params, and seeds initial state. After consuming the hash they
should clear it (`history.replaceState(null, '', ...)`) so a refresh
doesn't re-apply the filter forever.

---

## 4. Sidebar stream pills duplicate the new top-right dropdown

**Severity:** cosmetic.

The redesign brief says:
> The All / Clinic / Pharmacy pills currently in the sidebar should be
> removed from the sidebar to avoid duplication.

What ships today: the new dropdown is added to the homepage header, but
the sidebar pills are **kept** because they're shared across every page
(Forecast, Analysis, Insights, Scenarios, Rev. Sharing). Removing them
from the sidebar without first adding equivalent UI to those pages would
strand multi-branch users with no stream filter on those routes.

### To remove the duplication safely
1. Audit every page that reads `localStorage.getItem('stream_id')` —
   confirm or add a top-right stream filter dropdown on each.
2. Once every page has its own filter UI, delete the stream-pills block
   in [`client/src/components/layout/Sidebar.tsx`](client/src/components/layout/Sidebar.tsx)
   (the `Stream selector` `div` around the `selectStream('all', ...)`
   button).

The new dropdown on the homepage already calls the same `selectStream`
helper (which writes to the same localStorage keys), so existing sidebar
pills and the new dropdown stay in sync until the sidebar version is
removed.
