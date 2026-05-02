// HealthPlix sync runner. Single code path used by both the manual HTTP
// handler (routes/sync.ts) and the auto-sync scheduler (services/scheduler).
//
// Extracted verbatim from the body of POST /api/sync/healthplix so the
// behaviour — dedup + insert + dashboard rollup — is identical for manual
// and scheduled runs.

import { decrypt } from '../../utils/crypto.js';
import { branchFilter, branchSettingsKey, type BranchContext } from '../../utils/branch.js';
import { findActiveScenarioForStream } from '../../utils/scenarios.js';
import { getClientHelper } from '../../db/connection.js';
import { getPlatformHelper } from '../../db/platform-connection.js';
import { parseHealthplix } from '../parsers/healthplix.js';

export type ProgressFn = (step: string, message: string, pct: number) => void;

export interface HealthplixRunOpts {
  tenantSlug: string;
  clientId: number;
  ctx: BranchContext;
  branchId: number | null;
  fromDate: string; // YYYY-MM-DD
  toDate: string;   // YYYY-MM-DD
  trigger: 'manual' | 'auto-schedule' | 'auto-catchup' | 'auto-test';
  onProgress?: ProgressFn;
}

export interface HealthplixRunResult {
  importId: number;
  rowsImported: number;
  dateRange?: { start?: string; end?: string };
  summary: any;
}

export async function runHealthplixSync(opts: HealthplixRunOpts): Promise<HealthplixRunResult> {
  const { tenantSlug, clientId, ctx, branchId, fromDate, toDate, onProgress } = opts;
  const progress: ProgressFn = onProgress || (() => {});

  const db = await getClientHelper(tenantSlug);

  const usernameRow = db.get("SELECT value FROM app_settings WHERE key = ?", branchSettingsKey('healthplix_username', ctx));
  const passwordRow = db.get("SELECT value FROM app_settings WHERE key = ?", branchSettingsKey('healthplix_password', ctx));
  const clinicRow = db.get("SELECT value FROM app_settings WHERE key = ?", branchSettingsKey('healthplix_clinic', ctx));

  if (!usernameRow?.value || !passwordRow?.value) {
    throw new Error('Healthplix credentials not configured');
  }

  const username = usernameRow.value;
  const password = decrypt(passwordRow.value);
  const clinicName = clinicRow?.value || 'MagnaCode Bangalore';

  // Lazy-import Playwright module — keeps it out of cloud hosts that lack browsers.
  const { syncHealthplix } = await import('./healthplix-sync.js');

  const result = await syncHealthplix({
    username,
    password,
    clinicName,
    fromDate,
    toDate,
    headless: true,
    onProgress: progress,
  });

  progress('parsing', 'Parsing downloaded report...', 92);
  const { rows, summary } = parseHealthplix(result.filePath);

  progress('saving', `Saving ${rows.length} rows to database...`, 95);

  // Branch-scoped dedup before insert. branch_id IS ? handles NULL too.
  const clinicDatesToReplace = [...new Set(rows.map((r: any) => r.bill_date).filter(Boolean))];
  if (clinicDatesToReplace.length > 0) {
    const ph = clinicDatesToReplace.map(() => '?').join(',');
    db.run(
      `DELETE FROM clinic_actuals WHERE branch_id IS ? AND bill_date IN (${ph})`,
      branchId, ...clinicDatesToReplace
    );
    console.log(`[hp-sync] Cleared existing clinic data for branch=${branchId}, dates=${clinicDatesToReplace.length}`);
  }

  db.run(
    `INSERT INTO import_logs (source, filename, rows_imported, date_range_start, date_range_end, status, branch_id, file_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    'HEALTHPLIX_SYNC', result.filename, rows.length,
    summary.dateRange?.start || null, summary.dateRange?.end || null, 'completed', branchId, result.filePath
  );
  const importLogRow = db.get("SELECT id FROM import_logs WHERE source = 'HEALTHPLIX_SYNC' ORDER BY id DESC LIMIT 1");
  const importId = importLogRow?.id || 0;

  db.beginBatch();
  try {
    for (const r of rows) {
      db.run(
        `INSERT INTO clinic_actuals (import_id, bill_date, bill_month, patient_id, patient_name, order_number,
          billed, paid, discount, tax, refund, due, addl_disc, item_price, item_disc,
          department, service_name, billed_doctor, service_owner, branch_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        importId, r.bill_date, r.bill_month, r.patient_id, r.patient_name,
        r.order_number, r.billed, r.paid, r.discount, r.tax, r.refund, r.due,
        r.addl_disc, r.item_price, r.item_disc, r.department, r.service_name,
        r.billed_doctor, r.service_owner, branchId
      );
    }
    db.endBatch();
  } catch (e) { db.rollbackBatch(); throw e; }

  const verifyCount = db.get('SELECT COUNT(*) as n FROM clinic_actuals WHERE import_id = ?', importId)?.n || 0;
  console.log(`[hp-sync] Post-insert verification: expected=${rows.length}, actual=${verifyCount}, importId=${importId}`);
  if (verifyCount === 0) {
    console.error(`[hp-sync] ⚠ CRITICAL: 0 rows in clinic_actuals after batch insert — data may not have persisted`);
  }

  // Auto-add doctors (branch-scoped).
  const doctors = [...new Set(rows.map((r: any) => r.billed_doctor).filter((d: any) => d && d !== '-'))];
  for (const d of doctors) {
    db.run('INSERT OR IGNORE INTO doctors (name, branch_id) VALUES (?, ?)', d, branchId);
  }

  // Roll up Clinic Revenue into the dashboard's active scenario.
  // Strict: NULL-branch legacy rows are not re-aggregated under the active
  // branch during the post-import rebuild.
  const bf = branchFilter(ctx, { strict: true });
  const platformDb = await getPlatformHelper();
  const clinicStream = clientId ? platformDb.get(
    "SELECT id FROM business_streams WHERE client_id = ? AND (LOWER(name) LIKE '%clinic%' OR LOWER(name) LIKE '%health%') AND is_active = 1 LIMIT 1",
    clientId
  ) : null;
  const clinicStreamId = clinicStream?.id || null;
  const activeScenario = findActiveScenarioForStream(db, ctx, clinicStreamId);
  if (activeScenario) {
    db.run(
      `DELETE FROM dashboard_actuals WHERE scenario_id = ? AND category = 'revenue' AND item_name = 'Clinic Revenue'${bf.where}`,
      activeScenario.id, ...bf.params
    );
    const clinicMonthly = db.all(
      `SELECT bill_month as month, COALESCE(SUM(item_price), 0) as total
       FROM clinic_actuals WHERE bill_month IS NOT NULL AND bill_month != ''${bf.where} GROUP BY bill_month`,
      ...bf.params
    );
    for (const row of clinicMonthly) {
      if (!row.month) continue;
      db.run(
        `INSERT INTO dashboard_actuals (scenario_id, category, item_name, month, amount, branch_id, stream_id, updated_at)
         VALUES (?, 'revenue', 'Clinic Revenue', ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(scenario_id, category, item_name, month, COALESCE(branch_id, 0))
         DO UPDATE SET amount = excluded.amount, stream_id = excluded.stream_id, updated_at = datetime('now')`,
        activeScenario.id, row.month, row.total, branchId, clinicStreamId
      );
    }
  }

  return {
    importId,
    rowsImported: rows.length,
    dateRange: summary.dateRange || undefined,
    summary,
  };
}
