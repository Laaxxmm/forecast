// ─────────────────────────────────────────────────────────────────────────────
// VCFO Cost-Allocation Rules routes.
//
// Admin-managed CRUD for the P&L Adjustments engine
// (services/vcfo-allocation-engine.ts). Each tenant maintains its own set of
// rules; the engine reads them on every /api/vcfo/profit-loss?withAdjustments=1
// call and emits an adjusted PLStatement alongside the books view.
//
// Two rule kinds are supported by the schema:
//   pool_split   — one source bucket fanned out across many destinations
//                  (Rent split by sqft, HO redistribution, etc.)
//   cross_charge — many destinations charged X% of their OWN metric,
//                  sum credited to a single provider (central lab fees, etc.)
//
// Endpoints (mounted under /api/vcfo/cost-allocation-rules):
//   GET    /                — list rules with destinations nested
//   GET    /:id             — single rule + destinations
//   POST   /                — create rule + destinations in one txn
//   PUT    /:id             — update rule; replace destinations atomically
//   PATCH  /:id/toggle      — flip `enabled` without full edit
//   DELETE /:id             — hard-delete (FK cascade drops destinations)
//
// Authn: every /api/vcfo/* route is already gated by the vcfoOps middleware
// stack (requireAuth + resolveTenant + vcfo_portal module). Write routes
// additionally gate on canWriteVcfo (admin/accountant/super_admin).
// ─────────────────────────────────────────────────────────────────────────────

import { Router, Request, Response } from 'express';
import { canWriteVcfo } from '../middleware/auth.js';
import { buildProfitLossMulti, type PLSection } from '../services/vcfo-report-builder.js';
import { listAccessibleCompanies } from '../services/accessible-companies.js';
import { applyAllocationRules, type LoadedRule } from '../services/vcfo-allocation-engine.js';

const router = Router();

// ─── Types ──────────────────────────────────────────────────────────────────

type RuleKind = 'pool_split' | 'cross_charge';
type SourceType = 'ledger' | 'pl_line' | 'custom_amount';
type AllocMethod =
  | 'fixed_pct'
  | 'equal_split'
  | 'revenue_share'
  | 'weighted_ratio'
  | 'manual_amounts';

interface DestinationInput {
  destination_company_id: number;
  weight: number;
  weight_basis_label?: string | null;
  sort_order?: number;
}

/** One entry in `branch_configs`. Carries fields for BOTH rule kinds so the
 *  same schema works for multi-branch pool_split (one rule, many sqft-split
 *  branches) and multi-branch cross_charge (one rule, many regional lab
 *  providers). The engine reads only the subset matching the parent rule's
 *  rule_kind. */
interface BranchConfigInput {
  label?: string | null;
  // pool_split — source for this branch
  source_type?: SourceType;
  source_company_id?: number | null;
  source_ledger_name?: string | null;
  source_pl_section_key?: string | null;
  source_custom_amount?: number | null;
  source_all_companies?: boolean | number | null;
  // cross_charge — provider + per-branch overrides for basis/pct/credit
  provider_company_id?: number | null;
  charge_basis_section_key?: string | null;
  charge_pct?: number | null;
  provider_credit_section_key?: string | null;
  // common
  destinations: DestinationInput[];
}

interface RuleInput {
  name: string;
  description?: string | null;
  enabled?: boolean;
  effective_from?: string | null;
  effective_to?: string | null;
  priority?: number;
  rule_kind: RuleKind;

  // pool_split (single-source mode)
  source_type?: SourceType | null;
  source_company_id?: number | null;
  source_ledger_name?: string | null;
  source_pl_section_key?: string | null;
  source_custom_amount?: number | null;
  source_all_companies?: boolean | number | null;

  // cross_charge
  provider_company_id?: number | null;
  charge_basis_section_key?: string | null;
  charge_pct?: number | null;
  provider_credit_section_key?: string | null;

  alloc_method?: AllocMethod | null;
  target_pl_section_key?: string | null;

  /** Single-source mode destinations. Required for single-source pool_split
   *  rules and all cross_charge rules. Ignored when branch_configs is present
   *  (multi-branch mode). */
  destinations: DestinationInput[];

  /** Multi-branch mode: one config per branch. When present and non-empty,
   *  takes precedence over rule-level source_* and the destinations array.
   *  Only meaningful for pool_split rules. */
  branch_configs?: BranchConfigInput[];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function toIntOrNull(v: any): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = parseInt(String(v), 10);
  return Number.isNaN(n) ? null : n;
}

function toIntRequired(v: any, name: string): number {
  const n = toIntOrNull(v);
  if (n === null) throw new Error(`${name} must be an integer`);
  return n;
}

function toNumOrNull(v: any): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

function isoDateOrNull(v: any): string | null {
  if (!v) return null;
  const s = String(v).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return s;
}

/**
 * Validate an incoming rule payload. Throws Error on the first failure with a
 * caller-friendly message. Server-side validation backs up the client-side
 * checks in RuleEditorModal (and protects against direct API callers).
 */
function validateRulePayload(p: RuleInput): void {
  if (!p || typeof p !== 'object') throw new Error('Body must be a JSON object');
  if (!p.name || typeof p.name !== 'string' || !p.name.trim()) {
    throw new Error('name is required');
  }
  if (p.rule_kind !== 'pool_split' && p.rule_kind !== 'cross_charge') {
    throw new Error("rule_kind must be 'pool_split' or 'cross_charge'");
  }
  if (p.effective_from && p.effective_to && p.effective_to < p.effective_from) {
    throw new Error('effective_to must be on or after effective_from');
  }

  // Multi-branch mode: validate branch_configs and skip rule-level fields.
  // Supported for BOTH pool_split (each branch = one source-destinations
  // group) and cross_charge (each branch = one provider-consumers group).
  const isMultiBranch = Array.isArray(p.branch_configs) && p.branch_configs.length > 0;
  if (isMultiBranch) {
    if (p.rule_kind === 'pool_split') {
      if (!p.alloc_method) throw new Error('alloc_method is required for pool_split');
      if (!['fixed_pct', 'equal_split', 'revenue_share', 'weighted_ratio', 'manual_amounts'].includes(p.alloc_method)) {
        throw new Error("alloc_method must be 'fixed_pct' | 'equal_split' | 'revenue_share' | 'weighted_ratio' | 'manual_amounts'");
      }
    }
    for (const [i, bc] of (p.branch_configs as BranchConfigInput[]).entries()) {
      const tag = bc.label || `branch ${i + 1}`;
      if (!Array.isArray(bc.destinations) || bc.destinations.length === 0) {
        throw new Error(`${tag}: at least one destination is required`);
      }
      const bcDestIds = new Set<number>();
      for (const d of bc.destinations) {
        if (!Number.isFinite(d.destination_company_id)) {
          throw new Error(`${tag}: each destination needs a destination_company_id`);
        }
        if (bcDestIds.has(d.destination_company_id)) {
          throw new Error(`${tag}: duplicate destination_company_id ${d.destination_company_id}`);
        }
        bcDestIds.add(d.destination_company_id);
      }

      if (p.rule_kind === 'pool_split') {
        if (!bc.source_type) throw new Error(`${tag}: source_type is required`);
        if (!['ledger', 'pl_line', 'custom_amount'].includes(bc.source_type)) {
          throw new Error(`${tag}: source_type must be ledger|pl_line|custom_amount`);
        }
        if (bc.source_type === 'ledger') {
          if (!bc.source_company_id) throw new Error(`${tag}: source_company_id is required when source_type=ledger`);
          if (!bc.source_ledger_name || !String(bc.source_ledger_name).trim()) {
            throw new Error(`${tag}: source_ledger_name is required when source_type=ledger`);
          }
        } else if (bc.source_type === 'pl_line') {
          if (!bc.source_pl_section_key) throw new Error(`${tag}: source_pl_section_key is required when source_type=pl_line`);
          // Pooled (all-companies) pl_line needs no source company.
          if (!bc.source_all_companies && !bc.source_company_id) {
            throw new Error(`${tag}: source_company_id is required when source_type=pl_line (or tick "pool across all companies")`);
          }
        } else if (bc.source_type === 'custom_amount') {
          if (!Number.isFinite(bc.source_custom_amount)) {
            throw new Error(`${tag}: source_custom_amount must be a number when source_type=custom_amount`);
          }
        }
        if (p.alloc_method === 'fixed_pct') {
          const sum = bc.destinations.reduce((a, d) => a + Number(d.weight || 0), 0);
          if (Math.abs(sum - 100) > 0.01) {
            throw new Error(`${tag}: fixed_pct destinations must sum to 100 (got ${sum.toFixed(2)})`);
          }
        }
        if (p.alloc_method === 'weighted_ratio') {
          const sum = bc.destinations.reduce((a, d) => a + Number(d.weight || 0), 0);
          if (sum <= 0) throw new Error(`${tag}: weighted_ratio destinations must have at least one non-zero weight`);
        }
      } else {
        // cross_charge per-branch validation. Each branch needs a provider
        // and may either inherit basis/pct/credit from the rule envelope OR
        // override on its own.
        if (!bc.provider_company_id) throw new Error(`${tag}: provider_company_id is required`);
        if (bcDestIds.has(bc.provider_company_id)) {
          throw new Error(`${tag}: provider cannot also be a consumer`);
        }
        const effectivePct = bc.charge_pct ?? p.charge_pct;
        if (!Number.isFinite(effectivePct) || (effectivePct as number) <= 0 || (effectivePct as number) > 100) {
          throw new Error(`${tag}: charge_pct must be in (0, 100] (got ${effectivePct})`);
        }
        const effectiveBasis = bc.charge_basis_section_key ?? p.charge_basis_section_key;
        if (!effectiveBasis) {
          throw new Error(`${tag}: charge_basis_section_key is required (set on branch or rule)`);
        }
      }
    }
    return;
  }

  // Single-source mode: validate rule-level fields + destinations table.
  if (!Array.isArray(p.destinations) || p.destinations.length === 0) {
    throw new Error('at least one destination is required');
  }

  const destIds = new Set<number>();
  for (const d of p.destinations) {
    if (!Number.isFinite(d.destination_company_id)) {
      throw new Error('each destination needs a destination_company_id');
    }
    if (destIds.has(d.destination_company_id)) {
      throw new Error(`duplicate destination_company_id ${d.destination_company_id}`);
    }
    destIds.add(d.destination_company_id);
  }

  if (p.rule_kind === 'pool_split') {
    if (!p.source_type) throw new Error('source_type is required for pool_split');
    if (!['ledger', 'pl_line', 'custom_amount'].includes(p.source_type)) {
      throw new Error("source_type must be 'ledger' | 'pl_line' | 'custom_amount'");
    }
    if (p.source_type === 'ledger') {
      if (!p.source_company_id) throw new Error('source_company_id is required when source_type=ledger');
      if (!p.source_ledger_name || !String(p.source_ledger_name).trim()) {
        throw new Error('source_ledger_name is required when source_type=ledger');
      }
    } else if (p.source_type === 'pl_line') {
      if (!p.source_pl_section_key) throw new Error('source_pl_section_key is required when source_type=pl_line');
      // Pooled (all-companies) pl_line needs no source company.
      if (!p.source_all_companies && !p.source_company_id) {
        throw new Error('source_company_id is required when source_type=pl_line (or enable "pool across all companies")');
      }
    } else if (p.source_type === 'custom_amount') {
      if (!Number.isFinite(p.source_custom_amount)) {
        throw new Error('source_custom_amount must be a number when source_type=custom_amount');
      }
    }
    if (!p.alloc_method) throw new Error('alloc_method is required for pool_split');
    if (!['fixed_pct', 'equal_split', 'revenue_share', 'weighted_ratio', 'manual_amounts'].includes(p.alloc_method)) {
      throw new Error("alloc_method must be 'fixed_pct' | 'equal_split' | 'revenue_share' | 'weighted_ratio' | 'manual_amounts'");
    }
    // Source company IS allowed as a destination — standard rent-split
    // case where source keeps its share. Engine handles it by draining
    // the full pool then adding back the source's allocated portion.
    if (p.alloc_method === 'fixed_pct') {
      const sum = p.destinations.reduce((a, d) => a + Number(d.weight || 0), 0);
      if (Math.abs(sum - 100) > 0.01) {
        throw new Error(`fixed_pct destinations must sum to 100 (got ${sum.toFixed(2)})`);
      }
    }
    if (p.alloc_method === 'weighted_ratio') {
      const sum = p.destinations.reduce((a, d) => a + Number(d.weight || 0), 0);
      if (sum <= 0) throw new Error('weighted_ratio destinations must have at least one non-zero weight');
    }
  } else {
    // cross_charge
    if (!p.provider_company_id) throw new Error('provider_company_id is required for cross_charge');
    if (!p.charge_basis_section_key) throw new Error('charge_basis_section_key is required for cross_charge');
    if (!Number.isFinite(p.charge_pct) || (p.charge_pct as number) <= 0 || (p.charge_pct as number) > 100) {
      throw new Error('charge_pct must be a number in (0, 100]');
    }
    if (destIds.has(p.provider_company_id)) {
      throw new Error('provider_company_id cannot also appear in destinations');
    }
  }
}

/**
 * Hydrate a rule row with its destinations array, ready to send to the client.
 * Returns null if the row doesn't exist (e.g. after a DELETE race).
 *
 * `branch_configs` is stored as JSON text in the DB; we parse it back into an
 * array here so the client can consume it directly. Falsy / malformed JSON
 * becomes `null` — the client treats null as single-source mode.
 */
function loadRuleWithDestinations(db: any, ruleId: number): any | null {
  const rule = db.get(`SELECT * FROM vcfo_allocation_rules WHERE id = ?`, ruleId);
  if (!rule) return null;
  const destinations = db.all(
    `SELECT * FROM vcfo_allocation_rule_destinations
       WHERE rule_id = ?
       ORDER BY sort_order ASC, id ASC`,
    ruleId,
  );
  let branch_configs = null;
  if (rule.branch_configs) {
    try { branch_configs = JSON.parse(rule.branch_configs); }
    catch { branch_configs = null; }
  }
  return { ...rule, destinations, branch_configs };
}

function writeRule(
  db: any,
  ruleId: number,
  p: RuleInput,
  userId: number | null,
): number {
  const enabled = p.enabled === false ? 0 : 1;
  const priority = Number.isFinite(p.priority) ? p.priority! : 100;

  // For cross_charge rules, the pool_split fields stay NULL (and vice versa).
  // Normalising here keeps the row honest regardless of what the client sent.
  const isPool = p.rule_kind === 'pool_split';
  const isCross = p.rule_kind === 'cross_charge';

  // Multi-branch mode: rule-level provider/source fields stay NULL because
  // the engine ignores them. The branch_configs JSON column carries the
  // per-branch data. Supported for both pool_split and cross_charge.
  const isMultiBranch = Array.isArray(p.branch_configs) && p.branch_configs.length > 0;

  // Rule-level aggregate-source flag — only meaningful for a single-source
  // pool_split with source_type='pl_line'. (Multi-branch carries its own
  // per-branch source_all_companies inside branch_configs.)
  const ruleLevelPooled = isPool && !isMultiBranch && p.source_type === 'pl_line' && !!p.source_all_companies;
  const branchConfigsJson = isMultiBranch
    ? JSON.stringify(p.branch_configs!.map(bc => {
        if (isPool) {
          const pooled = bc.source_type === 'pl_line' && !!bc.source_all_companies;
          return {
            label: bc.label?.trim() || null,
            source_type: bc.source_type,
            // Pooled pl_line has no single source company.
            source_company_id: (bc.source_type === 'custom_amount' || pooled) ? null : toIntOrNull(bc.source_company_id),
            source_ledger_name: bc.source_type === 'ledger' ? (bc.source_ledger_name?.trim() || null) : null,
            source_pl_section_key: bc.source_type === 'pl_line' ? (bc.source_pl_section_key || null) : null,
            source_custom_amount: bc.source_type === 'custom_amount' ? toNumOrNull(bc.source_custom_amount) : null,
            source_all_companies: pooled ? 1 : 0,
            destinations: bc.destinations.map((d, i) => ({
              destination_company_id: d.destination_company_id,
              weight: Number.isFinite(d.weight) ? d.weight : 0,
              weight_basis_label: d.weight_basis_label?.trim() || null,
              sort_order: Number.isFinite(d.sort_order) ? d.sort_order : i,
            })),
          };
        }
        // cross_charge branch: provider + per-branch overrides + consumers list.
        // weight is unused in the cross_charge engine path but keep the shape
        // consistent with pool_split for the destinations array.
        return {
          label: bc.label?.trim() || null,
          provider_company_id: toIntOrNull(bc.provider_company_id),
          charge_basis_section_key: bc.charge_basis_section_key?.trim() || null,
          charge_pct: toNumOrNull(bc.charge_pct),
          provider_credit_section_key: bc.provider_credit_section_key?.trim() || null,
          destinations: bc.destinations.map((d, i) => ({
            destination_company_id: d.destination_company_id,
            weight: 0,
            weight_basis_label: null,
            sort_order: Number.isFinite(d.sort_order) ? d.sort_order : i,
          })),
        };
      }))
    : null;

  if (ruleId === 0) {
    const info = db.run(
      `INSERT INTO vcfo_allocation_rules (
         name, description, enabled, effective_from, effective_to, priority, rule_kind,
         source_type, source_company_id, source_ledger_name, source_pl_section_key, source_custom_amount,
         source_all_companies,
         provider_company_id, charge_basis_section_key, charge_pct, provider_credit_section_key,
         alloc_method, target_pl_section_key,
         branch_configs,
         created_by
       ) VALUES (?,?,?,?,?,?,?, ?,?,?,?,?, ?, ?,?,?,?, ?,?, ?, ?)`,
      p.name.trim(),
      p.description?.trim() || null,
      enabled,
      isoDateOrNull(p.effective_from),
      isoDateOrNull(p.effective_to),
      priority,
      p.rule_kind,
      // In multi-branch mode the rule-level source fields are NOT used by the
      // engine, so we deliberately store them as NULL even if the client
      // happened to send them. Keeps the row honest.
      isPool && !isMultiBranch ? p.source_type || null : null,
      // Pooled (all-companies) pl_line has no single source company.
      isPool && !isMultiBranch && !ruleLevelPooled ? toIntOrNull(p.source_company_id) : null,
      isPool && !isMultiBranch ? p.source_ledger_name?.trim() || null : null,
      isPool && !isMultiBranch ? p.source_pl_section_key || null : null,
      isPool && !isMultiBranch ? toNumOrNull(p.source_custom_amount) : null,
      ruleLevelPooled ? 1 : 0,
      // For multi-branch cross_charge: provider_company_id is per-branch so
      // rule-level value is NULL. The other fields (basis/pct/credit) stay
      // as rule-level defaults that branches can inherit or override.
      isCross && !isMultiBranch ? toIntOrNull(p.provider_company_id) : null,
      isCross ? p.charge_basis_section_key || null : null,
      isCross ? toNumOrNull(p.charge_pct) : null,
      isCross ? p.provider_credit_section_key || 'directCosts' : null,
      isPool ? p.alloc_method || null : null,
      p.target_pl_section_key || (isCross ? 'directCosts' : 'indirectExpenses'),
      branchConfigsJson,
      userId,
    );
    ruleId = info.lastInsertRowid;
  } else {
    db.run(
      `UPDATE vcfo_allocation_rules SET
         name = ?, description = ?, enabled = ?,
         effective_from = ?, effective_to = ?, priority = ?, rule_kind = ?,
         source_type = ?, source_company_id = ?, source_ledger_name = ?,
         source_pl_section_key = ?, source_custom_amount = ?,
         source_all_companies = ?,
         provider_company_id = ?, charge_basis_section_key = ?, charge_pct = ?,
         provider_credit_section_key = ?,
         alloc_method = ?, target_pl_section_key = ?,
         branch_configs = ?,
         updated_at = datetime('now')
       WHERE id = ?`,
      p.name.trim(),
      p.description?.trim() || null,
      enabled,
      isoDateOrNull(p.effective_from),
      isoDateOrNull(p.effective_to),
      priority,
      p.rule_kind,
      isPool && !isMultiBranch ? p.source_type || null : null,
      isPool && !isMultiBranch && !ruleLevelPooled ? toIntOrNull(p.source_company_id) : null,
      isPool && !isMultiBranch ? p.source_ledger_name?.trim() || null : null,
      isPool && !isMultiBranch ? p.source_pl_section_key || null : null,
      isPool && !isMultiBranch ? toNumOrNull(p.source_custom_amount) : null,
      ruleLevelPooled ? 1 : 0,
      isCross && !isMultiBranch ? toIntOrNull(p.provider_company_id) : null,
      isCross ? p.charge_basis_section_key || null : null,
      isCross ? toNumOrNull(p.charge_pct) : null,
      isCross ? p.provider_credit_section_key || 'directCosts' : null,
      isPool ? p.alloc_method || null : null,
      p.target_pl_section_key || (isCross ? 'directCosts' : 'indirectExpenses'),
      branchConfigsJson,
      ruleId,
    );
    // Wipe-and-rewrite destinations is simpler than diffing — the table is
    // tiny (≤ 15 rows per rule for Magna). In multi-branch mode we wipe
    // anyway since the destinations table is unused; the JSON column is
    // the source of truth.
    db.run(`DELETE FROM vcfo_allocation_rule_destinations WHERE rule_id = ?`, ruleId);
  }

  // Only write destinations table rows in single-source mode. Multi-branch
  // rules carry their destinations inside the branch_configs JSON.
  if (!isMultiBranch) {
    for (const [i, d] of p.destinations.entries()) {
      db.run(
        `INSERT INTO vcfo_allocation_rule_destinations
           (rule_id, destination_company_id, weight, weight_basis_label, sort_order)
           VALUES (?, ?, ?, ?, ?)`,
        ruleId,
        d.destination_company_id,
        Number.isFinite(d.weight) ? d.weight : 0,
        d.weight_basis_label?.trim() || null,
        Number.isFinite(d.sort_order) ? d.sort_order : i,
      );
    }
  }

  return ruleId;
}

// ─── Endpoints ──────────────────────────────────────────────────────────────

router.get('/', async (req: Request, res: Response) => {
  try {
    const db = req.tenantDb!;
    const rules = db.all(
      `SELECT * FROM vcfo_allocation_rules ORDER BY priority ASC, id ASC`,
    );
    const ruleIds = rules.map((r: any) => r.id);
    let destinations: any[] = [];
    if (ruleIds.length > 0) {
      destinations = db.all(
        `SELECT * FROM vcfo_allocation_rule_destinations
           WHERE rule_id IN (${ruleIds.map(() => '?').join(',')})
           ORDER BY rule_id ASC, sort_order ASC, id ASC`,
        ...ruleIds,
      );
    }
    const byRule = new Map<number, any[]>();
    for (const d of destinations) {
      if (!byRule.has(d.rule_id)) byRule.set(d.rule_id, []);
      byRule.get(d.rule_id)!.push(d);
    }
    res.json(
      rules.map((r: any) => {
        let branch_configs = null;
        if (r.branch_configs) {
          try { branch_configs = JSON.parse(r.branch_configs); }
          catch { branch_configs = null; }
        }
        return { ...r, destinations: byRule.get(r.id) || [], branch_configs };
      }),
    );
  } catch (err: any) {
    console.error('[cost-allocation] GET / error', err);
    res.status(500).json({ error: err?.message || 'Failed to list rules' });
  }
});

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = toIntRequired(req.params.id, 'id');
    const rule = loadRuleWithDestinations(req.tenantDb!, id);
    if (!rule) return res.status(404).json({ error: 'Rule not found' });
    res.json(rule);
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Failed to load rule' });
  }
});

router.post('/', async (req: Request, res: Response) => {
  if (!canWriteVcfo(req)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const payload = req.body as RuleInput;
    validateRulePayload(payload);
    const db = req.tenantDb!;
    db.exec('BEGIN');
    let newId = 0;
    try {
      newId = writeRule(db, 0, payload, req.session?.userId || null);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    const rule = loadRuleWithDestinations(db, newId);
    res.status(201).json(rule);
  } catch (err: any) {
    console.error('[cost-allocation] POST / error', err);
    res.status(400).json({ error: err?.message || 'Failed to create rule' });
  }
});

router.put('/:id', async (req: Request, res: Response) => {
  if (!canWriteVcfo(req)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const id = toIntRequired(req.params.id, 'id');
    const payload = req.body as RuleInput;
    validateRulePayload(payload);
    const db = req.tenantDb!;
    const existing = db.get(`SELECT id FROM vcfo_allocation_rules WHERE id = ?`, id);
    if (!existing) return res.status(404).json({ error: 'Rule not found' });
    db.exec('BEGIN');
    try {
      writeRule(db, id, payload, req.session?.userId || null);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    res.json(loadRuleWithDestinations(db, id));
  } catch (err: any) {
    console.error('[cost-allocation] PUT /:id error', err);
    res.status(400).json({ error: err?.message || 'Failed to update rule' });
  }
});

router.patch('/:id/toggle', async (req: Request, res: Response) => {
  if (!canWriteVcfo(req)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const id = toIntRequired(req.params.id, 'id');
    const db = req.tenantDb!;
    const existing = db.get(
      `SELECT enabled FROM vcfo_allocation_rules WHERE id = ?`,
      id,
    );
    if (!existing) return res.status(404).json({ error: 'Rule not found' });
    const next = existing.enabled ? 0 : 1;
    db.run(
      `UPDATE vcfo_allocation_rules SET enabled = ?, updated_at = datetime('now') WHERE id = ?`,
      next,
      id,
    );
    res.json(loadRuleWithDestinations(db, id));
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Failed to toggle rule' });
  }
});

router.delete('/:id', async (req: Request, res: Response) => {
  if (!canWriteVcfo(req)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const id = toIntRequired(req.params.id, 'id');
    const db = req.tenantDb!;
    db.run(`DELETE FROM vcfo_allocation_rules WHERE id = ?`, id);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Failed to delete rule' });
  }
});

// ─── Bonus: dry-run preview for an unsaved rule ─────────────────────────────
// Lets the RuleEditorModal show "if you save this, here's what changes"
// before the admin commits. Builds the bifurcated PL fresh, then runs the
// engine with the in-progress rule as the only active rule (rulesOverride).
// No DB writes, no rule sequence advance, no transaction rollback needed.
router.post('/_preview', async (req: Request, res: Response) => {
  try {
    const accessible = await listAccessibleCompanies(req);
    if (accessible.length === 0) return res.json({ events: [], warnings: [], deltas: {} });

    // Default period: current FY.
    const today = new Date();
    const fyYear = today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1;
    const from = typeof req.body.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.body.from)
      ? req.body.from : `${fyYear}-04-01`;
    const to = typeof req.body.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.body.to)
      ? req.body.to : `${fyYear + 1}-03-31`;

    const payload = req.body.rule as RuleInput;
    if (!payload || !payload.rule_kind) {
      return res.status(400).json({ error: 'rule payload required' });
    }

    // Construct a synthetic LoadedRule from the payload. Use id=0 — it never
    // hits the DB so collisions don't matter; the engine just needs a value.
    const loadedRule: LoadedRule = {
      id: 0,
      name: payload.name || '(preview)',
      description: payload.description || null,
      enabled: 1,
      effective_from: payload.effective_from || null,
      effective_to: payload.effective_to || null,
      priority: payload.priority ?? 100,
      rule_kind: payload.rule_kind,
      source_type: payload.source_type ?? null,
      source_company_id: payload.source_company_id ?? null,
      source_ledger_name: payload.source_ledger_name ?? null,
      source_pl_section_key: payload.source_pl_section_key ?? null,
      source_custom_amount: payload.source_custom_amount ?? null,
      source_all_companies: payload.source_all_companies ? 1 : 0,
      provider_company_id: payload.provider_company_id ?? null,
      charge_basis_section_key: payload.charge_basis_section_key ?? null,
      charge_pct: payload.charge_pct ?? null,
      provider_credit_section_key: payload.provider_credit_section_key ?? null,
      alloc_method: payload.alloc_method ?? null,
      target_pl_section_key: payload.target_pl_section_key ?? null,
      destinations: (payload.destinations || []).map((d, i) => ({
        id: 0,
        rule_id: 0,
        destination_company_id: d.destination_company_id,
        weight: d.weight,
        weight_basis_label: d.weight_basis_label || null,
        sort_order: d.sort_order ?? i,
      })),
      // Multi-branch: pass parsed configs directly so loadActiveRules's JSON
      // parse isn't needed. branch_configs (the raw string column) stays null.
      // IMPORTANT: include BOTH pool_split and cross_charge fields — the
      // engine reads the subset matching the parent rule's rule_kind. Missing
      // cross_charge fields here was the cause of a "missing
      // provider_company_id" warning in Preview impact for cross_charge rules.
      branch_configs: null,
      parsedBranchConfigs: Array.isArray(payload.branch_configs) && payload.branch_configs.length > 0
        ? payload.branch_configs.map(bc => ({
            label: bc.label || undefined,
            // pool_split fields
            source_type: bc.source_type,
            source_company_id: bc.source_company_id ?? null,
            source_ledger_name: bc.source_ledger_name ?? null,
            source_pl_section_key: bc.source_pl_section_key ?? null,
            source_custom_amount: bc.source_custom_amount ?? null,
            source_all_companies: bc.source_all_companies ? 1 : 0,
            // cross_charge fields
            provider_company_id: bc.provider_company_id ?? null,
            charge_basis_section_key: bc.charge_basis_section_key ?? null,
            charge_pct: bc.charge_pct ?? null,
            provider_credit_section_key: bc.provider_credit_section_key ?? null,
            destinations: bc.destinations.map(d => ({
              destination_company_id: d.destination_company_id,
              weight: d.weight,
              weight_basis_label: d.weight_basis_label ?? null,
            })),
          }))
        : null,
    };

    const companies = accessible.map(c => ({ id: c.id, name: c.name }));
    const base = buildProfitLossMulti(req.tenantDb!, companies, from, to, 'yearly', true);
    const result = applyAllocationRules(req.tenantDb!, base, {
      effectiveFrom: from,
      effectiveTo: to,
      rulesOverride: [loadedRule],
    });

    // Compute per-column NP deltas so the UI can show a compact summary.
    const deltas: Record<string, number> = {};
    for (const col of base.columns) {
      deltas[col] = (result.adjusted.computed.netProfit[col] || 0) - (base.computed.netProfit[col] || 0);
    }

    res.json({
      period: { from, to },
      events: result.events,
      warnings: result.warnings,
      deltas,
      columnLabels: base.columnLabels || {},
    });
  } catch (err: any) {
    console.error('[cost-allocation] preview error', err);
    res.status(400).json({ error: err?.message || 'Preview failed' });
  }
});

// ─── Bonus: section-tree picker for the rule editor ────────────────────────
// Returns a flat depth-tagged list of the PL section keys from a real
// bifurcated build — used by the editor to populate dropdowns for
// `source_pl_section_key`, `charge_basis_section_key`, `target_pl_section_key`,
// and `provider_credit_section_key`. Lets the user pick nested sub-lines
// like 'revenue:Sales:Diagnostics' from a tree rather than typing keys.
router.get('/_helpers/section-tree', async (req: Request, res: Response) => {
  try {
    const accessible = await listAccessibleCompanies(req);
    if (accessible.length === 0) return res.json([]);
    // Default to current FY if no period given.
    const today = new Date();
    const fy = today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1;
    const defaultFrom = `${fy}-04-01`;
    const defaultTo = `${fy + 1}-03-31`;
    const from = typeof req.query.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from)
      ? req.query.from : defaultFrom;
    const to = typeof req.query.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to)
      ? req.query.to : defaultTo;
    const companies = accessible.map(c => ({ id: c.id, name: c.name }));
    const pl = buildProfitLossMulti(req.tenantDb!, companies, from, to, 'yearly', true);

    interface Node { key: string; label: string; depth: number; isExpense: boolean }
    const nodes: Node[] = [];
    const walk = (secs: PLSection[], depth: number) => {
      for (const s of secs) {
        nodes.push({ key: s.key, label: s.label, depth, isExpense: s.isExpense });
        if (s.children && s.children.length > 0) walk(s.children, depth + 1);
      }
    };
    walk(pl.sections, 0);
    res.json(nodes);
  } catch (err: any) {
    console.error('[cost-allocation] section-tree error', err);
    res.status(400).json({ error: err?.message || 'Failed to fetch section tree' });
  }
});

// ─── Bonus: ledger picker for the rule editor ───────────────────────────────
// The RuleEditorModal needs the list of ledgers for a given company to populate
// the `source_ledger_name` dropdown when source_type=ledger. We could re-use
// the /api/vcfo/trial-balance endpoint but that's expensive — this is a thin,
// cached read directly from vcfo_ledgers.
router.get('/_helpers/ledgers/:companyId', async (req: Request, res: Response) => {
  try {
    const companyId = toIntRequired(req.params.companyId, 'companyId');
    const db = req.tenantDb!;
    const ledgers = db.all(
      `SELECT name, group_name, parent_group FROM vcfo_ledgers
         WHERE company_id = ? ORDER BY name ASC`,
      companyId,
    );
    res.json(ledgers);
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Failed to list ledgers' });
  }
});

export default router;
