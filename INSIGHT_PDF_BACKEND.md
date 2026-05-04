# Insight PDF — backend asks + deferred items

The Daily / Weekly / Monthly PDF redesign at `/insights` ships as a pure
client-side rewrite of [InsightDownloadPanel.tsx](client/src/components/dashboard/InsightDownloadPanel.tsx).
Every section that can be honestly built from the existing
`/dashboard/operational-insights` payload is fully redesigned. A few
sections are deferred because they need data the current pipeline
doesn't expose, or they conflict with a binding constraint in the brief.

This file documents those deferrals so the team can pick up each one
independently.

---

## 1. Rupee symbol vs WinAnsi font (₹ vs "Rs.")

**Status — kept "Rs. " prefix (deferred ₹ rendering).**

The brief asks for the ₹ symbol everywhere ("Use the rupee symbol ₹
(U+20B9) consistently. Never use 'Rs.' prefix") **and** asks not to
introduce new font dependencies if the existing setup doesn't support
them. These two rules are in direct conflict: jsPDF's default Helvetica
is WinAnsi-encoded and has no ₹ glyph, and the existing `safeText()`
helper deliberately strips ₹ → "Rs. " to avoid empty-box renders
(see [InsightDownloadPanel.tsx:200-211](client/src/components/dashboard/InsightDownloadPanel.tsx)).

The "no new font dependencies" rule is binding (binary, specific) so the
redesign keeps "Rs. " for now. To switch to ₹, embed a Unicode TTF in
the bundle:

### How to land ₹ in a follow-up

1. Pick a font subset that covers Latin + ₹ + the punctuation we use
   (em dash, middle dot, arrows). Roboto-Regular subset is ~80–120 KB
   base64-encoded; Inter-Regular is similar.
2. Register it with jsPDF on dialog open:
   ```ts
   import RobotoBase64 from './fonts/Roboto-Regular.b64';
   doc.addFileToVFS('Roboto-Regular.ttf', RobotoBase64);
   doc.addFont('Roboto-Regular.ttf', 'Roboto', 'normal');
   doc.addFont('Roboto-Medium.ttf',  'Roboto', 'bold');
   doc.setFont('Roboto', 'normal');
   ```
3. Drop the `₹ → 'Rs. '` line from `safeText()` and switch every
   `'Rs. ' + indianNumber(n)` site to `'₹' + indianNumber(n)`.
4. The bundle weight should be lazy-loaded — only fetch the font when
   `<InsightDownloadPanel open>` mounts.

The visual redesign is independent of this — the layout, hierarchy,
charts, and storytelling all work fine with "Rs. ". Switching to ₹ is
a one-commit polish pass once the team picks a font.

---

## 2. Monthly Page 3 + Page 4 — cross-tab insights

**Status — RESOLVED.** The Insight PDF panel now parallel-fetches
`/dashboard/clinic-analytics` and `/dashboard/pharmacy-analytics` on
dialog open and threads the bundle through to all three `generate*PDF`
entry points via the new `crossBundle` parameter. The Daily report's
new "Stream deep-dive" section consumes this bundle. Monthly Pages 3-4
can drop the "pending" empty states and start populating from the same
bundle (the data is now in scope).

The historical context of this section is kept below for the next
implementer.

---

### Original deferral notes (now resolved)

### What's blocked

Pages 3 (Clinic deep dive) and 4 (Pharmacy deep dive) are supposed to
include synthesized insight cards that pull from the dashboard sub-tabs:

- **Clinic** — cross-sell rate, top doctor, multi-dept revenue lift,
  doctor performance variance. Source: `/dashboard/clinic-analytics`.
- **Pharmacy Sales & Profit** — margin leak top 5 SKUs, total leak
  rupees. Source: per-drug margin join across `purchases.table` and
  `sales.table`.
- **Pharmacy Stock & Expiry** — at-risk inventory rupee value,
  largest at-risk SKU. Source: `/dashboard/pharmacy-analytics` `stock`
  block.
- **Pharmacy Purchases** — top stockist concentration, free goods
  captured. Source: `purchases.topStockists` + `freeQtyAnalysis`.
- **Pharmacy Cross-Report** — money cycle classification counts
  (Healthy / Sitting / Leaking / Dead). Source: same per-drug join used
  in the dashboard CrossTab.

The PDF generator runs entirely client-side and currently only fetches
`/dashboard/operational-insights`. To populate these pages it needs to
also fetch (and cache) `clinic-analytics` and `pharmacy-analytics` for
the report period.

### What unblocks it

Two equally good options:

**Option A — pre-fetch in InsightDownloadPanel.**

When the dialog opens, fire two extra `api.get()` calls in parallel:

```ts
useEffect(() => {
  if (!open) return;
  Promise.all([
    api.get('/dashboard/clinic-analytics',   { params: { startMonth: data.month, endMonth: data.month } }),
    api.get('/dashboard/pharmacy-analytics', { params: { startMonth: data.month, endMonth: data.month } }),
  ]).then(([c, p]) => setCrossBundle({ clinic: c.data, pharma: p.data }));
}, [open, data.month]);
```

Then thread `crossBundle` into `generateMonthlyPDF()`. Pages 3+4 compute
their cards from this bundle. No backend changes required.

This is the **recommended** option: pure client work, zero new
endpoints, lazy-loaded so it only happens when a user clicks Download.

**Option B — single bundle endpoint.**

Add `/dashboard/operational-insights/bundle?month=YYYY-MM` that returns
the operational-insights payload plus the cross-tab payloads in one
JSON blob. Cleaner one-shot fetch; only worth doing if the parallel
fetch latency in Option A becomes painful. Same SQL, same numbers,
just batched.

Either way the existing aggregation logic in
[server/src/routes/dashboard.ts](server/src/routes/dashboard.ts)
(`/clinic-analytics` lines 274-552, `/pharmacy-analytics` lines
556-972) is already correct — no new SQL needed, just plumbing.

### What landed today

Pages 3 and 4 render the section structure (header, section bars,
narrative paragraph, scorecard table, "One actionable insight"
amber callout) but the four cross-tab insight cards in each page show
`Cross-tab insight pending — see INSIGHT_PDF_BACKEND.md`. The moment
either pre-fetch lands, the empty-state branch drops out and the
numbers populate from the bundle.

---

## 3. Monthly Page 2 — 3-month trend cards + comparison table

**Status — rendered as "3-month history pending" empty state.**

### What's blocked

The 3-month trend section needs the prior 2 months' totals (revenue,
margin, avg ticket) alongside the current month, plus the same per-stream
breakdown.

`/dashboard/operational-insights` currently takes `month=YYYY-MM` and
returns a single month's view. There's no bundled history endpoint,
and the per-month payload is already heavy (~50 KB) so calling it three
times to assemble a comparison adds noticeable load time on the PDF
modal.

### What unblocks it

Either option works:

**Option A — extend operational-insights with `historyMonths` param.**

```ts
GET /dashboard/operational-insights?month=2026-04&historyMonths=2
```

Returns the current-month payload plus a `history: [{ month, monthLabel,
combined, streams: [{ name, mtdRevenue, target, marginPct, avgTicket }] }]`
array of length 2 (the two months prior to `month`). The array entries
are deliberately compact — no daily breakdown, no actions, no alerts —
just enough to render the trend cards.

**Option B — call /operational-insights three times in parallel.**

Same as the Pages 3+4 pattern. Roughly 3× the latency and 3× the
payload, but zero backend work. Acceptable if the user already accepts
~1.5s for the existing single-month fetch.

### What landed today

Page 2 renders the page-1-style sparkline for the current month plus
a placeholder trend block: `3-month trend pending — see
INSIGHT_PDF_BACKEND.md`. The page footer math (peak day, daily avg,
days above target) is fully populated from the existing single-month
data.

---

## 4. Weekly Page 3 — rollover items

**Status — section auto-hides when no rollover state is available.**

### What's blocked

The brief asks Page 3 to list "items rolled over from last week" — i.e.,
alerts that appeared in last week's PDF and are still open this week.

Persisting last week's alert list across PDF generations would require
either (a) storing each generated PDF's alerts in the database, or (b)
deriving rollovers by recomputing last week's alerts from last week's
data. Both are doable but neither is on the critical path.

### What landed today

The redesign skips the rollover section in Weekly Page 3. The
remaining content (3 priority actions for next week, forward
indicators) populates fully. If the rollover store lands later, the
section can be slotted in without restructuring.

---

## 5. Newsletter-voice addendum — deferred items

**Status — partial. Voice + "Three things" + action cards shipped; logo fetch + forward-looking pages + 3-month trend + page consolidation deferred.**

### What landed in this addendum

- Newsletter voice across all 3 reports — "Dear team — here's …" hero
  salutations, sentence-form headlines, lowercase "you / your"
  framing throughout, KPI labels rewritten ("You earned" / "On track
  to finish at" / "Short by" / "Need per day").
- "Three things" numbered story-card component on Page 1 of all 3
  reports. Replaces the previous flat alert lists. Mixes positive +
  negative observations, every story carries a rupee/volume number.
- Action card structure with category-coloured left border and a
  rupee-impact pill in the top-right of each card. Applied to Daily
  Page 1's "What today calls for".
- "Powered by Indefine" text wordmark on every page footer of every
  report. Renders as plain text — no logo fetch yet (see below).

### What's still deferred

#### 5a. Client logo + Indefine logo fetching — RESOLVED

The Insight PDF rebuild (May 2026) addresses this in full:

- `/api/auth/me` now returns `clientLogoUrl` (pre-resolved server-side
  via `fs.existsSync` against the same five extensions the panel used
  to probe with HEAD) and `indefineLogoUrl` (read once from the
  `INDEFINE_LOGO_URL` env var).
- `/dashboard/operational-insights` returns the same two fields so the
  PDF panel doesn't need a separate /me round-trip.
- The panel's `useEffect` now: (a) prefers the pre-resolved URL and
  skips the HEAD-probe loop; (b) renders an initials-circle in the
  header when fetch fails; (c) `console.error`'s every failure with
  the URL + error context.
- `addFooter` accepts a pre-loaded Indefine wordmark image — the
  panel calls `loadIndefineLogo(data.indefineLogoUrl)` on open and
  passes the result through. On failure (or when the env var is
  unset), the existing text wordmark "indefine." renders as the
  fallback.

The historical deferral notes are kept below.

---

### Original deferral notes (now resolved)

To swap text for images:

1. Add a `client_logo_url` column to the platform's `clients` table (or
   reuse existing `config` JSON if there's already a slot for it).
2. Surface the URL via `/auth/me` so the client can read it without an
   extra round-trip.
3. Add an `INDEFINE_LOGO_URL` env var on the server, surfaced via the
   same payload (or a new `/branding` endpoint).
4. In InsightDownloadPanel, pre-fetch both URLs as a `Blob` →
   `dataURL` when the dialog opens (5s timeout each, in-memory cache
   for the lifetime of the dialog).
5. Pass the data URLs into `generateDailyPDF` / `generateWeeklyPDF` /
   `generateMonthlyPDF`. The header / footer renderers then decide:
   if the data URL exists, `doc.addImage(...)`; otherwise fall back to
   the existing text path.

The fallbacks are already in place — adding the images is a pure
additive change.

#### 5b. Forward-looking pages — Weekly Page 3 and Monthly Page 4

The brief calls for a dedicated "What [period] needs from you" page on
Weekly (Page 3) and Monthly (Page 4) with: math callout (next-period
pace target), stream-by-stream table with concrete volume needs, three
action cards, combined-upside callout.

Today's Weekly Page 3 retains the existing structure (priority actions
+ forward indicators). Today's Monthly Page 4 retains the Pharmacy
deep-dive content.

To unblock these:

1. Compute next-period totals: `nextTarget = currentTarget * trendFactor`
   where `trendFactor` defaults to 1.0 (next month equals this month's
   target) until the multi-month endpoint lands.
2. Stream-share allocation: split the next-period total across streams
   pro-rata to the current period's stream mix.
3. Volume needs: derive from per-stream daily revenue / per-unit
   average ticket (visits, tests, services, bills). All these averages
   are already in the `/operational-insights` payload.
4. Three action cards reuse the action-card primitive shipped in this
   addendum.

The data is on the client today. The deferral is purely scope.

#### 5c. 3-month trend (Monthly Page 2)

Previously documented. Two unblock paths still apply:

- **Backend Option A:** extend `/dashboard/operational-insights` with a
  `lookbackMonths` param that returns a compact `history: [...]` array
  alongside the current month payload. Recommended.
- **Client-side fallback:** parallel-fetch the endpoint three times in
  the InsightDownloadPanel mount and combine the responses. ~3× the
  payload, but zero backend work.

#### 5d. Monthly Page 3 consolidation

The brief calls for merging Pages 3 (Clinic deep dive) and 4 (Pharmacy
deep dive) into a single "Where the money came from" page with
two-column narratives + a 4-card cross-tab insight grid (per-card
empty states when data is unavailable, instead of one big "pending"
block).

Today's structure keeps the two pages separate. The consolidation is a
pure layout refactor — no data work — and is independent of the
forward-looking pages.

#### 5e. Monthly Page 5 strategic outlook

Page 5 currently shows a projection-pending stub plus the top
management actions. The brief asks for: quarterly outlook (3 KPI
tiles), target-adjustment recommendations (conditional on 2+ months
hitting/missing by 15%+), and a purple-tinted "From the Indefine team"
advisory note.

This is downstream of the 3-month trend (5c) — the quarterly outlook
needs the historical series to make any honest projection. Once 5c
lands, 5e is straightforward composition over the same data.

---

## Notes for the next implementer

- The visual primitives added across the two passes (`drawHeroStatus`,
  `drawKpiStrip`, `drawSectionBar`, `drawSparkline`, `drawCalloutCard`,
  `drawNumberedAlert`, plus the new "Three things" story card and
  action-card primitives) are reusable across all three templates and
  any future report types.
- Status-text logic is centralised in `composeStatusHeadline()` and the
  newsletter-voice equivalents so Daily / Weekly / Monthly all emit
  consistent verdicts.
- All deferred items above are **independent**. Each can land in its
  own commit without touching the others.

---

## 7. The 11 PM IST sync contract (Insight PDF rebuild)

Documenting the sync-aware report-date logic that the May 2026 rebuild
introduced. The whole point: the dashboard at `/insights` shows
"today's" partial-day numbers because users want to see what's
happening right now; the PDF reports represent a finished day, so they
must anchor to the last fully-synced day instead.

### How it works

`reportDateIst()` in [server/src/utils/ist-date.ts](server/src/utils/ist-date.ts)
returns yesterday-IST when `nowIstHHMM() < '23:00'`, today-IST
otherwise. The 23:00 IST cutoff is the `auto-sync.ts` schedule.

`/dashboard/operational-insights` accepts a `?asOf=last_synced` query
param (PDF callers only — the live dashboard sends nothing and stays
on its today's-calendar behaviour). When the flag is set, the
endpoint:

1. Calls `reportDateIst()` to compute the report's reference day.
2. Routes the same day-of-month into all the existing aggregations
   (MTD totals, last-month-MTD cumulative cap, weekly anchor, daily
   pace math). `lastMonthMtd` per card was already day-N cumulative
   cap'd, so Frame 2 ("vs same point last month") needed no further
   server work.
3. Looks up the latest row in `auto_sync_runs` (scoped via
   `branchFilter`) and computes a `reportSource` enum:
   - `'sync_completed'` — last successful sync covers the report day.
   - `'sync_pending_today'` — current-day sync hasn't run yet
     (pre-23:00 IST after a previous-day sync_completed). Header
     renders neutrally.
   - `'sync_gap'` — yesterday's expected sync is missing or failed.
     Header renders an amber warning line with the age in days.
4. Emits `lastSync: { dateIst, finishedAtIst, status, source, ageDays }`
   so the PDF can show "Last synced 11 PM" exactly.

### Edge cases

- **Brand-new tenant (day 1, no prior data):** Frame-2 section renders
  "No data for this period — same-point comparison unavailable" rather
  than hiding. Frame-1 renders "No prior-day comparison available —
  first day of period".
- **Sync gap (auto_sync_runs missing yesterday's row):** The header
  shows the amber warning. Today's data is still rendered with whatever
  the database has — the PDF doesn't fall back to a different report
  date because `reportDateIst()` is purely time-based, not data-based.
  The amber line tells the user the freshness is stale.
- **Past-month snapshot (`?month=2026-04`):** `asOf=last_synced` is
  ignored because the period is closed; `dayOfMonth` resolves to
  `daysInMonth` as before. `reportDate` returns the last day of that
  month.

### Related env / config

- `INDEFINE_LOGO_URL` — optional. When set, `/auth/me` and
  `/dashboard/operational-insights` return it as `indefineLogoUrl`;
  the PDF footer fetches and renders the image (falls back to the
  text wordmark on any failure).
- `auto_sync_runs` table — required. Contains `run_date_ist`,
  `finished_at`, `status`, `source`, `branch_id`. The dashboard
  endpoint scopes its lookup with the request's branch filter.

### What's NOT in this rebuild

- The 3-month trend on Monthly Page 2 (§3 above) is still pending.
  Per the plan, this needs a `?lookbackMonths=2` extension to the
  operational-insights endpoint or a parallel-fetch on the client.
- Monthly Pages 3-4 cross-tab insight cards now have the data
  (resolved §2) but the layout still uses the older two-page
  structure rather than the spec's consolidated "Where the money
  came from" page. Pure layout work; no data dependency.
