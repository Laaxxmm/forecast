/**
 * VCFO Allocation & Writeoff Engine — Ported from TallyVision server.js (lines 3570-3736)
 * Handles inter-company allocation rules and writeoff/addback rules.
 */

import { DbHelper } from '../../db/connection.js';
import { idPh } from './company-resolver.js';

/** Resolve ledger_names from config (supports both legacy single and new multi-select) */
export function resolveLedgerNames(config: any): string[] {
  if (config.ledger_names && config.ledger_names.length) return config.ledger_names;
  if (config.ledger_name) return [config.ledger_name];
  return [];
}

/** Look up a specific ledger's net debit flow for a company in a date range */
export function getLedgerAmount(db: DbHelper, companyId: number, ledgerName: string, from: string, to: string): number {
  const row: any = db.get(`
    SELECT SUM(net_debit) - SUM(net_credit) as total
    FROM vcfo_trial_balance t
    WHERE company_id = ? AND ledger_name = ?
      AND period_from >= ? AND period_to <= ?
      AND NOT EXISTS (
          SELECT 1 FROM vcfo_trial_balance t2
          WHERE t2.company_id = t.company_id
            AND t2.ledger_name = t.ledger_name
            AND t2.period_from = t.period_from
            AND t2.period_to < t.period_to
      )
  `, companyId, ledgerName, from, to);
  return row?.total || 0;
}

/** Look up multiple ledgers' combined net debit flow */
export function getLedgerAmountMulti(db: DbHelper, companyId: number, ledgerNames: string[], from: string, to: string): number {
  if (!ledgerNames || !ledgerNames.length) return 0;
  const ph = ledgerNames.map(() => '?').join(',');
  const row: any = db.get(`
    SELECT SUM(net_debit) - SUM(net_credit) as total
    FROM vcfo_trial_balance t
    WHERE company_id = ? AND ledger_name IN (${ph})
      AND period_from >= ? AND period_to <= ?
      AND NOT EXISTS (
          SELECT 1 FROM vcfo_trial_balance t2
          WHERE t2.company_id = t.company_id
            AND t2.ledger_name = t.ledger_name
            AND t2.period_from = t.period_from
            AND t2.period_to < t.period_to
      )
  `, companyId, ...ledgerNames, from, to);
  return row?.total || 0;
}

/** Returns overlapping months between rule's effective period and the query range */
export function getEffectiveOverlap(config: any, fromDate: string, toDate: string) {
  const qStart = fromDate ? new Date(fromDate + 'T00:00:00') : new Date('2000-01-01');
  const qEnd = toDate ? new Date(toDate + 'T00:00:00') : new Date('2099-12-31');

  let eStart = new Date('2000-01-01');
  if (config.effective_from) {
    const [y, m] = config.effective_from.split('-').map(Number);
    eStart = new Date(y, m - 1, 1);
  }
  let eEnd = new Date('2099-12-31');
  if (config.effective_to) {
    const [y, m] = config.effective_to.split('-').map(Number);
    eEnd = new Date(y, m, 0);
  }

  const overlapStart = new Date(Math.max(qStart.getTime(), eStart.getTime()));
  const overlapEnd = new Date(Math.min(qEnd.getTime(), eEnd.getTime()));

  if (overlapStart > overlapEnd) return { overlaps: false, months: [] as string[], monthCount: 0 };

  const months: string[] = [];
  const cur = new Date(overlapStart.getFullYear(), overlapStart.getMonth(), 1);
  const lastMonth = new Date(overlapEnd.getFullYear(), overlapEnd.getMonth(), 1);
  while (cur <= lastMonth) {
    months.push(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}`);
    cur.setMonth(cur.getMonth() + 1);
  }
  return { overlaps: true, months, monthCount: months.length };
}

/** Resolve the total fixed amount for the given months */
export function resolveFixedAmount(config: any, months: string[]): number {
  if (config.monthly_amounts && typeof config.monthly_amounts === 'object') {
    return months.reduce((sum: number, m: string) => sum + (Number(config.monthly_amounts[m]) || 0), 0);
  }
  return (Number(config.amount) || 0) * months.length;
}

/** Apply a single allocation rule to units array (mutates in-place) */
export function applyAllocationRule(db: DbHelper, units: any[], ruleType: string, config: any, from: string, to: string): void {
  const overlap = getEffectiveOverlap(config, from, to);
  if (!overlap.overlaps) return;

  const findUnit = (id: number) => units.find(u => u.companyId === id);

  if (ruleType === 'fixed') {
    const source = findUnit(config.source_company_id);
    const target = findUnit(config.target_company_id);
    if (!source || !target) return;
    const amount = resolveFixedAmount(config, overlap.months);
    source.indirectExpenses = (source.indirectExpenses || 0) - amount;
    target.indirectExpenses = (target.indirectExpenses || 0) + amount;
  }

  if (ruleType === 'ratio') {
    const source = findUnit(config.source_company_id);
    if (!source) return;
    const targets = config.targets || [];
    const totalRatio = targets.reduce((s: number, t: any) => s + (Number(t.ratio) || 0), 0);
    if (!totalRatio) return;

    const ledgerNms = resolveLedgerNames(config);
    const ledgerAmount = (from && to && ledgerNms.length)
      ? getLedgerAmountMulti(db, config.source_company_id, ledgerNms, from, to)
      : (source.indirectExpenses || 0);

    const sourceTarget = targets.find((t: any) => t.company_id === config.source_company_id);
    const sourceRatio = sourceTarget ? Number(sourceTarget.ratio) : 0;
    const sourceShare = (sourceRatio / totalRatio) * ledgerAmount;
    const redistributed = ledgerAmount - sourceShare;

    source.indirectExpenses = (source.indirectExpenses || 0) - redistributed;

    const otherTargets = targets.filter((t: any) => t.company_id !== config.source_company_id);
    for (const t of otherTargets) {
      const targetUnit = findUnit(t.company_id);
      if (!targetUnit) continue;
      const share = (Number(t.ratio) / totalRatio) * ledgerAmount;
      targetUnit.indirectExpenses = (targetUnit.indirectExpenses || 0) + share;
    }
  }

  if (ruleType === 'percent_income') {
    const target = findUnit(config.target_company_id);
    if (!target) return;
    const pct = (Number(config.percentage) || 0) / 100;
    const sourceIds = config.source_company_ids || [];
    const ledgerNms = resolveLedgerNames(config);

    for (const sid of sourceIds) {
      const source = findUnit(sid);
      if (!source) continue;
      let incomeBase: number;
      if (from && to && ledgerNms.length) {
        incomeBase = Math.abs(getLedgerAmountMulti(db, sid, ledgerNms, from, to));
      } else {
        incomeBase = source.directIncome || source.revenue || 0;
      }
      const chargeAmount = incomeBase * pct;
      source.indirectExpenses = (source.indirectExpenses || 0) + chargeAmount;
      target.indirectIncome = (target.indirectIncome || 0) + chargeAmount;
    }
  }
}

/** Get dashboard-affecting allocation rules for a group */
export function getDashboardAllocRules(db: DbHelper, groupId: number): any[] | null {
  const rules: any[] = db.all(
    'SELECT * FROM vcfo_allocation_rules WHERE group_id = ? AND is_active = 1 AND affects_dashboard = 1 ORDER BY sort_order',
    groupId
  );
  return rules.length ? rules : null;
}

/** Get dashboard-affecting writeoff rules for a group */
export function getDashboardWriteoffRules(db: DbHelper, groupId: number): any[] | null {
  const rules: any[] = db.all(
    'SELECT * FROM vcfo_writeoff_rules WHERE group_id = ? AND is_active = 1 AND affects_dashboard = 1 ORDER BY sort_order',
    groupId
  );
  return rules.length ? rules : null;
}

/** Apply all active allocation rules for a group to the units array */
export function applyDashboardAllocations(db: DbHelper, groupId: number, units: any[], from: string, to: string): void {
  const rules = getDashboardAllocRules(db, groupId);
  if (!rules) return;
  for (const rule of rules) {
    const config = JSON.parse(rule.config || '{}');
    applyAllocationRule(db, units, rule.rule_type, config, from, to);
  }
}
