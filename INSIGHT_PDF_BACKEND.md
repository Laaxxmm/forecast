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

**Status — rendered as "Cross-tab insight pending" empty states.**

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

## Notes for the next implementer

- The visual primitives added in this redesign (`drawHeroStatus`,
  `drawKpiStrip`, `drawSectionBar`, `drawSparkline`, `drawCalloutCard`)
  are reusable across all three templates and any future report types.
- Status-text logic is centralised in `composeStatusHeadline()` so
  Daily / Weekly / Monthly all emit consistent verdicts.
- All four deferred items above are **independent**. Each can land in
  its own commit without touching the others.
