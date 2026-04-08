/**
 * VCFO P&L Statement Builder — Ported from TallyVision server.js (lines 2429-2663)
 * Builds columnar P&L statements with city/location/entity-type groupings.
 */

import { DbHelper } from '../../db/connection.js';
import { idPh } from './company-resolver.js';
import { computeKPIData, buildPLGroupSets, getGroupTree } from './kpi-engine.js';

export const PL_LINES = [
  { key: 'revenue',          label: 'Revenue (Sales)',   bold: false },
  { key: 'directIncome',     label: 'Direct Income',     bold: false },
  { key: 'purchase',         label: 'COGS (Purchase)',   bold: false },
  { key: 'directExpenses',   label: 'Direct Expenses',   bold: false },
  { key: 'openingStock',     label: 'Opening Stock',     bold: false },
  { key: 'closingStock',     label: 'Closing Stock',     bold: false },
  { key: 'grossProfit',      label: 'GROSS PROFIT',      bold: true,  line: 'top' },
  { key: 'indirectExpenses', label: 'Indirect Expenses', bold: false },
  { key: 'indirectIncome',   label: 'Indirect Income',   bold: false },
  { key: 'netProfit',        label: 'NET PROFIT',        bold: true,  line: 'both' },
];

/**
 * Build a columnar P&L statement with up to three header levels.
 * Level 1: City, Level 2: Location, Level 3: Stream type
 */
export function buildPLStatement(db: DbHelper, query: any, ids: number[], from: string, to: string): any {
  const type = query.type || 'All';

  const companies: any[] = db.all(
    `SELECT id, city, location, entity_type FROM vcfo_companies
     WHERE id IN (${idPh(ids)}) AND is_active = 1`,
    ...ids
  );

  const cities    = [...new Set(companies.filter(c => c.city).map(c => c.city))].sort();
  const locations = [...new Set(companies.filter(c => c.location).map(c => c.location))].sort();
  const types     = [...new Set(companies.filter(c => c.entity_type).map(c => c.entity_type))].sort();

  const multiCity = cities.length > 1;
  const multiLoc  = locations.length > 1;
  const multiType = (!type || type === 'All') && types.length > 1;

  const anyMultiLoc = cities.some(city => {
    const locs = [...new Set(companies.filter(c => c.city === city && c.location).map(c => c.location))];
    return locs.length > 1;
  });

  if (multiType && (multiCity || multiLoc)) {
    const columns: any[] = [];
    const level1 = multiCity ? [] as any[] : null;
    const level2 = anyMultiLoc ? [] as any[] : null;

    for (const city of cities) {
      const cityLocs = [...new Set(
        companies.filter(c => c.city === city && c.location).map(c => c.location)
      )].sort();

      let citySpan = 0;

      for (const loc of cityLocs) {
        const locTypes = [...new Set(
          companies.filter(c => c.city === city && c.location === loc && c.entity_type).map(c => c.entity_type)
        )].sort();

        if (level2) level2.push({ label: loc, span: locTypes.length });

        for (const et of locTypes) {
          const etIds = companies.filter(c => c.city === city && c.location === loc && c.entity_type === et).map(c => c.id);
          if (etIds.length > 0) {
            columns.push({ name: et, data: computeKPIData(db, etIds, from, to), _ids: etIds });
            citySpan++;
          }
        }
      }

      if (level1) level1.push({ label: city, span: citySpan });
    }

    if (level1) level1.push({ label: 'Total', span: 1 });
    if (level2) level2.push({ label: '', span: 1 });
    columns.push({ name: 'Total', data: computeKPIData(db, ids, from, to), _ids: ids });

    return { columnar: true, level1, level2, columns, lines: PL_LINES };

  } else if (multiType) {
    const columns: any[] = [];
    for (const et of types) {
      const etIds = companies.filter(c => c.entity_type === et).map(c => c.id);
      if (etIds.length > 0) {
        columns.push({ name: et, data: computeKPIData(db, etIds, from, to), _ids: etIds });
      }
    }
    columns.push({ name: 'Total', data: computeKPIData(db, ids, from, to), _ids: ids });
    return { columnar: true, level1: null, level2: null, columns, lines: PL_LINES };

  } else if (multiCity || multiLoc) {
    const columns: any[] = [];
    const level1 = multiCity ? [] as any[] : null;

    for (const city of cities) {
      const cityLocs = [...new Set(
        companies.filter(c => c.city === city && c.location).map(c => c.location)
      )].sort();

      let citySpan = 0;

      for (const loc of cityLocs) {
        const locIds = companies.filter(c => c.city === city && c.location === loc).map(c => c.id);
        if (locIds.length > 0) {
          columns.push({ name: loc, data: computeKPIData(db, locIds, from, to), _ids: locIds });
          citySpan++;
        }
      }

      if (level1) level1.push({ label: city, span: citySpan });
    }

    if (level1) level1.push({ label: 'Total', span: 1 });
    columns.push({ name: 'Total', data: computeKPIData(db, ids, from, to), _ids: ids });

    return { columnar: true, level1, level2: null, columns, lines: PL_LINES };

  } else {
    const label = type !== 'All' ? type : (types[0] || 'All');
    return {
      columnar: false, level1: null, level2: null,
      columns: [{ name: label, data: computeKPIData(db, ids, from, to), _ids: ids }],
      lines: PL_LINES
    };
  }
}

/**
 * Compute monthly P&L trend data using TB-based approach.
 */
export function computeMonthlyTrendData(db: DbHelper, ids: number[], from: string, to: string): any[] {
  const plSets = buildPLGroupSets(db, ids);
  const salesSet    = new Set(getGroupTree(db, ids, 'Sales Accounts'));
  const purchaseSet = new Set(getGroupTree(db, ids, 'Purchase Accounts'));

  const tbRows: any[] = db.all(`
    SELECT period_from as month, group_name,
           SUM(net_debit) as net_debit, SUM(net_credit) as net_credit
    FROM vcfo_trial_balance t
    WHERE company_id IN (${idPh(ids)})
      AND period_from >= ? AND period_to <= ?
      AND group_name IS NOT NULL
      AND NOT EXISTS (
          SELECT 1 FROM vcfo_trial_balance t2
          WHERE t2.company_id = t.company_id
            AND t2.ledger_name = t.ledger_name
            AND t2.period_from = t.period_from
            AND t2.period_to < t.period_to
      )
    GROUP BY period_from, group_name
  `, ...ids, from, to);

  const months: Record<string, any> = {};
  for (const row of tbRows) {
    const grp = row.group_name;
    if (!months[row.month]) months[row.month] = { sales: 0, directInc: 0, purchase: 0, directExp: 0, indirectInc: 0, indirectExp: 0 };
    const m = months[row.month];
    const dr = row.net_debit  || 0;
    const cr = row.net_credit || 0;
    if (salesSet.has(grp))                  m.sales      += (cr - dr);
    else if (plSets.directCredit.has(grp))  m.directInc  += (cr - dr);
    if (purchaseSet.has(grp))               m.purchase   -= (dr - cr);
    else if (plSets.directDebit.has(grp))   m.directExp  -= (dr - cr);
    if (plSets.indirectCredit.has(grp))     m.indirectInc += (cr - dr);
    if (plSets.indirectDebit.has(grp))      m.indirectExp -= (dr - cr);
  }

  return Object.entries(months)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, d]: [string, any]) => {
      const allDC = d.sales + d.directInc;
      const allDD = d.purchase + d.directExp;
      const grossProfit = allDC + allDD;
      const netProfit   = grossProfit + d.indirectInc + d.indirectExp;
      return {
        month,
        revenue: allDC,
        sales: d.sales,
        directIncome: d.directInc,
        purchase: -d.purchase,
        directExpenses: -d.directExp,
        indirectExpenses: -d.indirectExp,
        indirectIncome: d.indirectInc,
        grossProfit,
        netProfit
      };
    });
}
