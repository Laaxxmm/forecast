# Cross-Report — backend asks

The Cross-Report tab redesign at `/actuals` (Pharmacy Analytics) needed three
metrics that couldn't be honestly built client-side from the existing
`/dashboard/pharmacy-analytics` payload. Those three render with "Backend
join required" empty states today; everything else (KPIs 1-4, margin leak,
money cycle, days of cover, anomaly tiles 1+2, master table) ships fully
client-computed against the existing API.

This file lists exactly what backend work would unblock each blocked metric.
Once any of these lands, the corresponding stub in
[client/src/components/dashboard/PharmacyAnalytics.tsx](client/src/components/dashboard/PharmacyAnalytics.tsx)
(see `function CrossTab`) can switch from the empty-state branch to a real
render path — no other refactor needed.

The single underlying gap is **batch-to-sale lineage and a 90-day sales
lookback that crosses period boundaries**. Both items below are facets of
that gap.

---

## 1. Stockist sell-through

> *Card: "Which suppliers' stock actually sells"*

### What it should compute

For each stockist:

- `purchased` — sum of net purchase value sourced from this stockist this period
- `sold` — sales value of products that were originally supplied by this stockist
- `sell_through_pct` — `sold / purchased * 100`

### Why client-side can't do this honestly

`purchases.table` carries `stockiest_name` per purchase line, so we can
attribute *purchases* to a stockist. But `sales.table` carries no batch_no
that maps back to the purchase that supplied the inventory, and even where
batch_no is present (`pharmacy_sales_actuals.batch_no`), there's no FK or
naming convention guaranteeing it lines up with `pharmacy_purchase_actuals.batch_no`.

When a single drug has been bought from multiple stockists (which is the
norm), there's no fair way to allocate sales across stockists without
additional data — picking the dominant stockist or pro-rating both
overstate and understate different stockists' sell-through.

### What unblocks it

Either of the following would let the client (or a new endpoint) compute
this honestly:

**Option A — explicit batch lineage on sales rows.**

If `pharmacy_sales_actuals.batch_no` is reliably the same string as
`pharmacy_purchase_actuals.batch_no` for the same drug, expose a per-stockist
aggregation in the API:

```sql
SELECT pp.stockiest_name AS stockist,
       SUM(pp.net_purchase_value) AS purchased_value,
       COALESCE(stockist_sales.sold_value, 0) AS sold_value
  FROM pharmacy_purchase_actuals pp
  LEFT JOIN (
       SELECT pp2.stockiest_name AS stockist, SUM(ps.sales_amount - ps.sales_tax) AS sold_value
         FROM pharmacy_sales_actuals ps
         JOIN pharmacy_purchase_actuals pp2
           ON ps.drug_name = pp2.drug_name
          AND ps.batch_no  = pp2.batch_no
        WHERE ps.bill_month BETWEEN :start AND :end
        GROUP BY pp2.stockiest_name
       ) stockist_sales
    ON stockist_sales.stockist = pp.stockiest_name
 WHERE pp.invoice_month BETWEEN :start AND :end
 GROUP BY pp.stockiest_name
 ORDER BY purchased_value DESC;
```

Add the result as `crossInsights.stockistSellThrough: [{ stockist, purchased, sold, sellThroughPct }]`.

**Option B — explicit purchase_id FK on each sale line.**

If `pharmacy_sales_actuals.source_purchase_id` is added (populated at
import time when the matching batch is found), the join becomes
unambiguous and Option A's SQL collapses to `JOIN pharmacy_purchase_actuals
ON pp.id = ps.source_purchase_id`.

### Verification

Once landed, the percentages should add up: `sum(purchased)` across
stockists should equal `purchases.kpi.totalPurchaseValue` for the period.
If they don't, the join is dropping rows.

---

## 2. Dead stock (no sales in 90 days)

> *KPI 5 + Anomaly tile 3*

### What it should compute

- `dead_sku_count` — number of distinct drugs that are currently in stock
  (`pharmacy_stock_actuals.avl_qty > 0` at latest snapshot) AND have **zero
  sales in the last 90 days from snapshot date**
- `dead_stock_value` — sum of `stock_value` across those drugs
- `dead_stock_top` — top 1 drug by `stock_value` from the dead set, for
  the anomaly tile footer

### Why client-side can't do this

`/dashboard/pharmacy-analytics` only returns sales rows inside the
selected period (controlled by the period selector). When the user picks
"Current month (May '26)" we get May sales — we have no view of
March/April sales, so we can't tell whether a drug is "dead" or just
quiet this month.

Calling the endpoint a second time with a 90-day window doesn't help
either: the rest of the page would then either re-fetch on every period
change or get out of sync with the user-selected period.

### What unblocks it

A small auxiliary aggregate on `/dashboard/pharmacy-analytics` that
ignores the period selector and always reflects the last 90 days from
the latest snapshot:

```sql
WITH recent_sales AS (
  SELECT drug_name, SUM(sales_amount) AS recent_sales
    FROM pharmacy_sales_actuals
   WHERE bill_date >= date(:snapshot_date, '-90 days')
   GROUP BY drug_name
)
SELECT s.drug_name,
       SUM(s.stock_value) AS stock_value,
       COALESCE(r.recent_sales, 0) AS sales_90d
  FROM pharmacy_stock_actuals s
  LEFT JOIN recent_sales r ON r.drug_name = s.drug_name
 WHERE s.snapshot_date = (SELECT MAX(snapshot_date) FROM pharmacy_stock_actuals)
   AND s.avl_qty > 0
 GROUP BY s.drug_name
HAVING sales_90d = 0;
```

Expose as `crossInsights.deadStock90d: { count, value, top: { name, stockValue } }`.

### Verification

`count` and `value` should be ≥ what the existing "Purchased, not sold"
list shows — every "purchased but not sold this period" SKU is a
candidate for "dead 90 days" but the converse isn't true (something
might have been bought in April, not sold in May, but sold in March
— that's not dead).

---

## Notes for the backend team

- Both items can land independently. Each is gated behind its own
  visibility key (`pharma_stockist_sellthrough`, plus the dead-stock
  treatment is gated by `pharma_cross_kpis` and `pharma_anomaly_buckets`)
  so the client will start rendering real data the moment the field
  appears in the response.
- The client-side stubs check for the presence of the field before
  switching out of the empty-state branch — no client changes needed
  beyond removing the stub when the data lands.
- All other Cross-Report metrics (margin leak, money cycle, days of
  cover, anomaly tiles 1 + 2, master table) are fully client-computed
  today against the existing payload. No backend changes required for
  those.
