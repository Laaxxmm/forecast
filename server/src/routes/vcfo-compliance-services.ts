// ─────────────────────────────────────────────────────────────────────────────
// VCFO Compliance *Services* routes.
//
// A "service" is the high-level registration that generates one or more
// tracker rows (entries in vcfo_compliances). Enabling GST in Karnataka, for
// example, spawns GSTR-1 + GSTR-3B + GSTR-9 rows for the KA scope — the user
// doesn't pick those individually. See SERVICES below for the full mapping.
//
// Identity of a service row: (service_key, scope_type, state|branch_id).
// - state-scope row: one per (service_key, state) — GST-KA, TDS-KA, …
// - branch-scope row: one per (service_key, branch_id) — PF at branch 12, …
//
// Endpoints:
//   GET  /api/vcfo/compliance-services              — list services (scoped to sidebar branch)
//   GET  /api/vcfo/compliance-services/definitions  — the static service catalogue (keys + labels)
//   PUT  /api/vcfo/compliance-services              — upsert a service row (config only; enabled untouched)
//   POST /api/vcfo/compliance-services/enable       — upsert row, set enabled=1, spawn tracker rows
//   POST /api/vcfo/compliance-services/disable      — set enabled=0, soft-cancel pending tracker rows
// ─────────────────────────────────────────────────────────────────────────────

import { Router, Request, Response } from 'express';
import { getPlatformHelper } from '../db/platform-connection.js';
import { requireRole } from '../middleware/auth.js';

const router = Router();

// Write-gate for every mutating endpoint in this router.
// admin + accountant can mutate; operational_head has no VCFO access at all
// (blocked upstream by the route mount) and legacy 'user' is read-only.
const vcfoWrite = requireRole('admin', 'accountant');

// ── Static service catalogue ────────────────────────────────────────────────
// Each service maps to a set of catalog keys that materialise as tracker rows
// when enabled. GST is preference-dependent (monthly vs quarterly QRMP).
export type ServiceKey =
  | 'gst' | 'mca' | 'tds' | 'pt' | 'pf' | 'esi'
  | 'it' | 'advance_tax' | 's_e' | 'drug' | 'clinical' | 'lwf' | 'manual';

interface ServiceDef {
  key: ServiceKey;
  name: string;
  category: string;
  scope: 'state' | 'branch';
  hasPreference?: boolean;          // GST only
  preferenceOptions?: string[];
  defaultPreference?: string;
  description?: string;
}

export const SERVICES: ServiceDef[] = [
  { key: 'gst',         name: 'GST',                  category: 'GST',     scope: 'state',  hasPreference: true, preferenceOptions: ['monthly', 'quarterly'], defaultPreference: 'monthly', description: 'GSTR-1, GSTR-3B & GSTR-9 per state GSTIN' },
  { key: 'mca',         name: 'MCA',                  category: 'MCA',     scope: 'state',  description: 'MGT-7 (Annual Return) + AOC-4 (Financials)' },
  { key: 'tds',         name: 'TDS / TCS',            category: 'TDS',     scope: 'state',  description: 'Monthly deposit + quarterly 24Q/26Q per state TAN' },
  { key: 'pt',          name: 'Professional Tax',     category: 'Labour',  scope: 'state',  description: 'Monthly PT deposit + annual return (KA)' },
  { key: 'pf',          name: 'PF',                   category: 'Labour',  scope: 'branch', description: 'Monthly PF contribution & ECR — per establishment' },
  { key: 'esi',         name: 'ESI',                  category: 'Labour',  scope: 'branch', description: 'Monthly ESI contribution — per establishment' },
  { key: 'it',          name: 'Income Tax',           category: 'IT',      scope: 'state',  description: 'Annual income tax return' },
  { key: 'advance_tax', name: 'Advance Tax',          category: 'IT',      scope: 'state',  description: 'Quarterly advance tax instalments' },
  { key: 's_e',         name: 'Shop & Establishment', category: 'Licence', scope: 'branch', description: 'S&E licence renewal — per establishment' },
  { key: 'drug',        name: 'Drug Licence',         category: 'Licence', scope: 'branch', description: 'Drug licence renewal — per outlet' },
  { key: 'clinical',    name: 'Clinical Estd. Act',   category: 'Licence', scope: 'branch', description: 'Clinical Establishments Act registration — per clinic' },
  { key: 'lwf',         name: 'Labour Welfare Fund',  category: 'Labour',  scope: 'branch', description: 'Half-yearly LWF deposit — per establishment' },
  { key: 'manual',      name: 'Manual',               category: 'Other',   scope: 'branch', description: 'Ad-hoc compliances you track manually' },
];

// Service → catalog keys. For prefs, value is a record keyed by preference.
type CatalogMap = { default: string[] } & Record<string, string[]>;
function catalogKeysFor(service: ServiceKey, preference: string | null): string[] {
  const maps: Record<ServiceKey, CatalogMap> = {
    gst:         { default: ['gstr3b_monthly', 'gstr1_monthly', 'gstr9_annual'],
                   monthly: ['gstr3b_monthly', 'gstr1_monthly', 'gstr9_annual'],
                   quarterly: ['gstr3b_quarterly', 'gstr1_iff_quarterly', 'gstr9_annual'] },
    mca:         { default: ['mca_mgt7_annual', 'mca_aoc4_annual'] },
    tds:         { default: ['tds_payment', 'tds_return'] },
    pt:          { default: ['pt_monthly', 'pt_annual_ka'] },
    pf:          { default: ['pf_monthly'] },
    esi:         { default: ['esi_monthly'] },
    it:          { default: ['itr_annual'] },
    advance_tax: { default: ['advance_tax'] },
    s_e:         { default: ['shop_est_renewal'] },
    drug:        { default: ['drug_licence_renewal'] },
    clinical:    { default: ['clinical_est_renewal'] },
    lwf:         { default: ['labour_welfare_hy'] },
    manual:      { default: [] },
  };
  const m = maps[service];
  if (!m) return [];
  if (preference && m[preference]) return m[preference];
  return m.default;
}

// ── Helpers ────────────────────────────────────────────────────────────────
interface BranchRow { id: number; name: string; code: string | null; city: string | null; state: string | null }

async function clientBranches(req: Request): Promise<BranchRow[]> {
  const platformDb = await getPlatformHelper();
  return platformDb.all(
    `SELECT id, name, code, city, state FROM branches
     WHERE client_id = ? AND is_active = 1
     ORDER BY sort_order, name`,
    req.clientId,
  ) as BranchRow[];
}

function toInt(val: any): number | null {
  const n = parseInt(String(val), 10);
  return Number.isNaN(n) ? null : n;
}

// ── Period math (same semantics as vcfo-compliances.ts) ────────────────────
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function autoPeriodLabel(dueDate: string, frequency: string): string {
  const [y, m] = dueDate.split('-').map(n => parseInt(n, 10));
  if (frequency === 'monthly')    return `${MONTHS[m - 1]} ${y}`;
  if (frequency === 'quarterly')  return `Q${Math.floor((m - 1) / 3) + 1} ${y}`;
  if (frequency === 'half-yearly')return `${m <= 6 ? 'H1' : 'H2'} ${y}`;
  return `${y}`;
}

function defaultDueDate(cat: any): string {
  const now = new Date();
  const day = cat.default_due_day || 15;
  const freq = cat.frequency;
  if (freq === 'annual' || freq === 'half-yearly') {
    const m = cat.default_due_month || (freq === 'annual' ? 3 : 1);
    let y = now.getUTCFullYear();
    const candidate = new Date(Date.UTC(y, m - 1, Math.min(day, 28)));
    if (candidate < now) y += 1;
    return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  const m = now.getUTCMonth() + 1;
  const y = now.getUTCFullYear();
  return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// ── Upsert helpers ─────────────────────────────────────────────────────────
interface ServiceKeyFields {
  service_key: string;
  scope_type: 'state' | 'branch';
  state: string | null;
  branch_id: number;
}

function findServiceRow(db: any, k: ServiceKeyFields): any {
  return db.get(
    `SELECT * FROM vcfo_compliance_services
     WHERE service_key = ? AND scope_type = ?
       AND COALESCE(state,'') = COALESCE(?, '')
       AND branch_id = ?`,
    k.service_key, k.scope_type, k.state, k.branch_id,
  );
}

function upsertServiceRow(db: any, k: ServiceKeyFields, fields: Record<string, any>): any {
  const existing = findServiceRow(db, k);
  if (existing) {
    const sets: string[] = [];
    const params: any[] = [];
    for (const [col, val] of Object.entries(fields)) {
      if (val === undefined) continue;
      sets.push(`${col} = ?`);
      params.push(val);
    }
    sets.push(`updated_at = datetime('now')`);
    params.push(existing.id);
    db.run(`UPDATE vcfo_compliance_services SET ${sets.join(', ')} WHERE id = ?`, params);
    return findServiceRow(db, k);
  }
  const cols = ['service_key', 'scope_type', 'state', 'branch_id', ...Object.keys(fields)];
  const values = [k.service_key, k.scope_type, k.state, k.branch_id, ...Object.values(fields)];
  db.run(
    `INSERT INTO vcfo_compliance_services (${cols.join(', ')})
     VALUES (${cols.map(() => '?').join(', ')})`,
    values,
  );
  return findServiceRow(db, k);
}

// ── Spawn / cancel tracker rows ────────────────────────────────────────────
function spawnTrackerRows(
  db: any,
  service: ServiceDef,
  k: ServiceKeyFields,
  svcRow: any,
): number {
  const catalogKeys = catalogKeysFor(service.key, svcRow.preference || null);
  if (catalogKeys.length === 0) return 0;
  let spawned = 0;
  for (const catKey of catalogKeys) {
    const cat = db.get(`SELECT * FROM vcfo_compliance_catalog WHERE key = ?`, catKey);
    if (!cat) continue;
    // Skip catalog entries restricted to a different state (e.g. pt_annual_ka).
    if (cat.state && cat.state !== (k.state || '').toUpperCase()) continue;
    // Look for an existing cancelled row for this (service, scope, catalog)
    // — resurrect it instead of inserting a duplicate.
    const existing = db.get(
      `SELECT * FROM vcfo_compliances
       WHERE branch_id = ? AND catalog_id = ? AND scope_type = ?
         AND COALESCE(state,'') = COALESCE(?, '')
         AND status IN ('pending', 'cancelled', 'overdue')
       ORDER BY due_date DESC LIMIT 1`,
      k.branch_id, cat.id, k.scope_type, k.state,
    );
    if (existing) {
      if (existing.status === 'cancelled') {
        db.run(`UPDATE vcfo_compliances SET status = 'pending' WHERE id = ?`, existing.id);
        spawned += 1;
      }
      continue;
    }
    const dueDate = defaultDueDate(cat);
    const periodLabel = autoPeriodLabel(dueDate, cat.frequency);
    db.run(
      `INSERT INTO vcfo_compliances
       (branch_id, scope_type, state, stream_id, catalog_id, name, category, frequency,
        due_date, period_label, status, amount, assignee, notes)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL)`,
      [
        k.branch_id, k.scope_type, k.state, cat.id,
        cat.name, cat.category, cat.frequency,
        dueDate, periodLabel,
        svcRow.amount ?? null,
        svcRow.assignee ?? null,
      ],
    );
    spawned += 1;
  }
  return spawned;
}

function cancelTrackerRows(db: any, service: ServiceDef, k: ServiceKeyFields, preference: string | null): number {
  const catalogKeys = catalogKeysFor(service.key, preference);
  if (catalogKeys.length === 0) return 0;
  const catIds = (db.all(
    `SELECT id FROM vcfo_compliance_catalog WHERE key IN (${catalogKeys.map(() => '?').join(',')})`,
    ...catalogKeys,
  ) as Array<{ id: number }>).map(r => r.id);
  if (catIds.length === 0) return 0;
  const res = db.run(
    `UPDATE vcfo_compliances SET status = 'cancelled'
     WHERE branch_id = ? AND scope_type = ? AND COALESCE(state,'') = COALESCE(?, '')
       AND catalog_id IN (${catIds.join(',')})
       AND status = 'pending'`,
    k.branch_id, k.scope_type, k.state,
  );
  return (res as any)?.changes ?? 0;
}

// ── Endpoints ──────────────────────────────────────────────────────────────

// Static service list — client uses this to render the table shell even when
// no rows exist yet. Enabled=0 for services the tenant hasn't configured.
router.get('/definitions', async (_req: Request, res: Response) => {
  res.json(SERVICES);
});

// List services for the sidebar-picked scope. Honours req.branchId /
// req.streamId populated by the resolveBranch middleware.
router.get('/', async (req: Request, res: Response) => {
  const db = req.tenantDb!;
  const branches = await clientBranches(req);
  if (branches.length === 0) return res.json({ scope: null, rows: [] });

  const overrideBranch = toInt(req.query.branchId);
  const branchCtx =
    overrideBranch !== null ? overrideBranch :
    req.branchId != null ? req.branchId :
    null;

  // No branch picked → return all configured services across all scopes.
  if (branchCtx === null) {
    const rows = db.all(
      `SELECT * FROM vcfo_compliance_services
       WHERE branch_id IN (${branches.map(b => b.id).join(',')})
       ORDER BY service_key, scope_type, state, branch_id`,
    );
    return res.json({ scope: { branchId: null }, rows });
  }

  const branch = branches.find(b => b.id === branchCtx);
  if (!branch) return res.json({ scope: null, rows: [] });
  const state = (branch.state || '').toUpperCase();

  // For a picked branch we return:
  //   - all state-scope services for that branch's state
  //   - all branch-scope services for that branch
  const stateRows = state
    ? db.all(
        `SELECT * FROM vcfo_compliance_services
         WHERE scope_type = 'state' AND state = ?
         ORDER BY service_key`,
        state,
      )
    : [];
  const branchRows = db.all(
    `SELECT * FROM vcfo_compliance_services
     WHERE scope_type = 'branch' AND branch_id = ?
     ORDER BY service_key`,
    branchCtx,
  );
  res.json({
    scope: { branchId: branchCtx, branchName: branch.name, state },
    rows: [...stateRows, ...branchRows],
  });
});

// Upsert config (does NOT toggle enabled). Body:
//   { serviceKey, scope: { type, state?, branchId }, config: {...} }
router.put('/', vcfoWrite, async (req: Request, res: Response) => {
  const db = req.tenantDb!;
  const branches = await clientBranches(req);
  const branchById = new Map(branches.map(b => [b.id, b] as const));

  const serviceKey = String(req.body.serviceKey || '') as ServiceKey;
  const service = SERVICES.find(s => s.key === serviceKey);
  if (!service) return res.status(400).json({ error: 'unknown serviceKey' });

  const k = resolveScope(req.body.scope, service, branchById);
  if ('error' in k) return res.status(400).json({ error: k.error });

  const cfg = req.body.config || {};
  const fields: Record<string, any> = {
    registration_no: cfg.registrationNo ?? null,
    registration_date: cfg.registrationDate ?? null,
    reg_type: cfg.regType ?? null,
    status_label: cfg.statusLabel ?? null,
    preference: service.hasPreference ? (cfg.preference || service.defaultPreference || null) : null,
    assignee: cfg.assignee ?? null,
    reviewer: cfg.reviewer ?? null,
    frequency_override: cfg.frequencyOverride ?? null,
    start_day: cfg.startDay != null ? toInt(cfg.startDay) : null,
    end_day: cfg.endDay != null ? toInt(cfg.endDay) : null,
    amount: cfg.amount != null ? Number(cfg.amount) : null,
    notes: cfg.notes ?? null,
  };
  const row = upsertServiceRow(db, k, fields);
  res.json(row);
});

// Enable a service — upsert config, set enabled=1, spawn tracker rows.
router.post('/enable', vcfoWrite, async (req: Request, res: Response) => {
  const db = req.tenantDb!;
  const branches = await clientBranches(req);
  const branchById = new Map(branches.map(b => [b.id, b] as const));

  const serviceKey = String(req.body.serviceKey || '') as ServiceKey;
  const service = SERVICES.find(s => s.key === serviceKey);
  if (!service) return res.status(400).json({ error: 'unknown serviceKey' });

  const k = resolveScope(req.body.scope, service, branchById);
  if ('error' in k) return res.status(400).json({ error: k.error });

  const cfg = req.body.config || {};
  const fields: Record<string, any> = {
    enabled: 1,
    registration_no: cfg.registrationNo ?? null,
    registration_date: cfg.registrationDate ?? null,
    reg_type: cfg.regType ?? null,
    status_label: cfg.statusLabel ?? 'Active',
    preference: service.hasPreference ? (cfg.preference || service.defaultPreference || null) : null,
    assignee: cfg.assignee ?? null,
    reviewer: cfg.reviewer ?? null,
    frequency_override: cfg.frequencyOverride ?? null,
    start_day: cfg.startDay != null ? toInt(cfg.startDay) : null,
    end_day: cfg.endDay != null ? toInt(cfg.endDay) : null,
    amount: cfg.amount != null ? Number(cfg.amount) : null,
    notes: cfg.notes ?? null,
  };
  const row = upsertServiceRow(db, k, fields);
  const spawned = spawnTrackerRows(db, service, k, row);
  res.json({ service: row, spawned });
});

// Disable — set enabled=0 and soft-cancel pending tracker rows.
router.post('/disable', vcfoWrite, async (req: Request, res: Response) => {
  const db = req.tenantDb!;
  const branches = await clientBranches(req);
  const branchById = new Map(branches.map(b => [b.id, b] as const));

  const serviceKey = String(req.body.serviceKey || '') as ServiceKey;
  const service = SERVICES.find(s => s.key === serviceKey);
  if (!service) return res.status(400).json({ error: 'unknown serviceKey' });

  const k = resolveScope(req.body.scope, service, branchById);
  if ('error' in k) return res.status(400).json({ error: k.error });

  const existing = findServiceRow(db, k);
  if (!existing) return res.json({ service: null, cancelled: 0 });
  const row = upsertServiceRow(db, k, { enabled: 0 });
  const cancelled = cancelTrackerRows(db, service, k, existing.preference || null);
  res.json({ service: row, cancelled });
});

// ── Scope resolution ───────────────────────────────────────────────────────
function resolveScope(
  scope: any,
  service: ServiceDef,
  branchById: Map<number, BranchRow>,
): ServiceKeyFields | { error: string } {
  const branchId = toInt(scope?.branchId);
  if (branchId === null || !branchById.has(branchId)) {
    return { error: 'scope.branchId is required and must belong to this client' };
  }
  const branch = branchById.get(branchId)!;
  if (service.scope === 'state') {
    const state = String(scope?.state || branch.state || '').toUpperCase() || null;
    if (!state) return { error: 'scope.state is required for state-scope service' };
    return { service_key: service.key, scope_type: 'state', state, branch_id: branchId };
  }
  return { service_key: service.key, scope_type: 'branch', state: null, branch_id: branchId };
}

export default router;
