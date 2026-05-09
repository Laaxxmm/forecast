// Routes that serve the morning Daily Brief.
//
// Phase 1 ships:
//   • GET /preview         — renders the brief as HTML for in-browser review
//   • GET /preview.pdf     — same content, served as a PDF download
// Phase 2 will add: recipients CRUD, send-test, send-history.
//
// The endpoint is admin-gated — same restriction as Insight downloads.

import { Router } from 'express';
import { requireRole } from '../middleware/auth.js';
import { getPlatformHelper } from '../db/platform-connection.js';
import { reportDateIst, todayIst, yesterdayIst } from '../utils/ist-date.js';
import { buildDailyBriefData } from '../services/daily-brief/data.js';
import { renderDailyBriefHtml, renderDailyBriefPdf, dailyBriefFilename } from '../services/daily-brief/render.js';
import { requireInt, requireString, optionalString, optionalNumber } from '../middleware/validate.js';

const router = Router();

// Resolve the (clientName, branchName) pair from the platform DB so the
// masthead shows the right labels. The branch name is optional —
// single-branch tenants and consolidated views fall back to "All branches".
async function resolveLabels(clientId: number, branchId: number | null): Promise<{ clientName: string; branchName: string }> {
  const platformDb = await getPlatformHelper();
  const client = platformDb.get('SELECT name FROM clients WHERE id = ?', clientId);
  let branchName = 'All branches';
  if (branchId) {
    const b = platformDb.get('SELECT name FROM branches WHERE id = ?', branchId);
    if (b?.name) branchName = b.name;
  }
  return { clientName: client?.name || '', branchName };
}

async function loadStreams(clientId: number): Promise<{ id: number; name: string }[]> {
  const platformDb = await getPlatformHelper();
  return platformDb.all(
    'SELECT id, name FROM business_streams WHERE client_id = ? AND is_active = 1 ORDER BY sort_order',
    clientId
  );
}

// Decide which day the brief is summarising.
//   • Default: yesterday-IST (the just-closed day, what the 8 AM cron
//     reports on)
//   • ?date=YYYY-MM-DD: explicit date for backfill / testing previous days
function resolveReportDates(req: any): { today: string; yesterday: string } {
  const explicit = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
    ? req.query.date
    : null;
  if (explicit) {
    // The "today" of the brief is the day after the date being reported on,
    // because the brief is dated for the morning that summarises yesterday.
    // Use component-wise math so the result doesn't drift on servers in
    // non-IST timezones (new Date('YYYY-MM-DD') parses as UTC midnight).
    const [yy, mm, dd] = explicit.split('-').map(Number);
    const d = new Date(yy, mm - 1, dd);
    d.setDate(d.getDate() + 1);
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return { today, yesterday: explicit };
  }
  return { today: todayIst(), yesterday: yesterdayIst() };
}

router.get('/preview', requireRole('admin'), async (req, res, next) => {
  try {
    const db = req.tenantDb!;
    const { clientName, branchName } = await resolveLabels(req.clientId!, req.branchId ?? null);
    const streams = await loadStreams(req.clientId!);
    const { today, yesterday } = resolveReportDates(req);
    const reportAnchor = reportDateIst();
    const data = buildDailyBriefData(db, req, {
      clientName,
      branchName,
      branchId: req.branchId ?? null,
      streams,
      today,
      yesterday,
      syncedAtLabel: reportAnchor.date === yesterday ? 'last night' : 'today',
      filedAtLabel: '8:00 AM',
    });
    const html = renderDailyBriefHtml(data);
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    next(err);
  }
});

router.get('/preview.pdf', requireRole('admin'), async (req, res, next) => {
  try {
    const db = req.tenantDb!;
    const { clientName, branchName } = await resolveLabels(req.clientId!, req.branchId ?? null);
    const streams = await loadStreams(req.clientId!);
    const { today, yesterday } = resolveReportDates(req);
    const data = buildDailyBriefData(db, req, {
      clientName,
      branchName,
      branchId: req.branchId ?? null,
      streams,
      today,
      yesterday,
      filedAtLabel: '8:00 AM',
    });
    const pdf = await renderDailyBriefPdf(data);
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `inline; filename="${dailyBriefFilename(data)}"`);
    res.send(pdf);
  } catch (err) {
    next(err);
  }
});

// ══════════════════════════════════════════════════════════════════════
//  RECIPIENTS — admin manages who receives the 8 AM brief
// ══════════════════════════════════════════════════════════════════════
//
// branch_id semantics:
//   • Specific branch id → recipient gets that branch's brief
//   • NULL                → recipient gets the consolidated (all-branches)
//                           brief if the tenant is multi-branch, or the
//                           single brief if not
// The Settings UI surfaces a dropdown with "All branches" + each branch.

// List recipients. ?branch_id= scopes the result; otherwise returns every
// row across the tenant so the Settings page can show a single combined
// table with a "Branch" column.
router.get('/recipients', requireRole('admin'), (req, res) => {
  const db = req.tenantDb!;
  const branchFilterId = req.query.branch_id !== undefined
    ? (req.query.branch_id === 'null' || req.query.branch_id === '' ? null : requireInt(req.query.branch_id, 'branch_id'))
    : undefined;
  let sql = `SELECT id, branch_id, email, name, is_active, created_at FROM daily_brief_recipients`;
  const params: any[] = [];
  if (branchFilterId !== undefined) {
    if (branchFilterId === null) sql += ` WHERE branch_id IS NULL`;
    else { sql += ` WHERE branch_id = ?`; params.push(branchFilterId); }
  }
  sql += ` ORDER BY branch_id IS NULL DESC, branch_id, email COLLATE NOCASE`;
  res.json(db.all(sql, ...params));
});

// Email format check — accepts the common shape, rejects obvious garbage.
// Server-side only; the UI already does a softer check before posting.
function validateEmail(email: string): string {
  const trimmed = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    throw new Error('Invalid email address');
  }
  return trimmed;
}

router.post('/recipients', requireRole('admin'), (req, res, next) => {
  try {
    const db = req.tenantDb!;
    const email = validateEmail(requireString(req.body.email, 'email', 200));
    const name = optionalString(req.body.name, 'name', 100) || null;
    const branchId = optionalNumber(req.body.branch_id, 'branch_id') ?? null;
    const createdBy = req.session?.username || req.session?.displayName || null;
    const result = db.run(
      `INSERT INTO daily_brief_recipients (branch_id, email, name, is_active, created_by)
         VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(branch_id, email) DO UPDATE SET
           name = excluded.name,
           is_active = 1`,
      branchId, email, name, createdBy
    );
    res.json({ ok: true, id: Number(result.lastInsertRowid) });
  } catch (err: any) {
    if (err.message?.includes('Invalid email')) return res.status(400).json({ error: err.message });
    next(err);
  }
});

router.put('/recipients/:id', requireRole('admin'), (req, res, next) => {
  try {
    const db = req.tenantDb!;
    const id = requireInt(req.params.id, 'id');
    const name = optionalString(req.body.name, 'name', 100);
    const isActive = req.body.is_active === undefined ? null : (req.body.is_active ? 1 : 0);
    if (name !== undefined) {
      db.run('UPDATE daily_brief_recipients SET name = ? WHERE id = ?', name || null, id);
    }
    if (isActive !== null) {
      db.run('UPDATE daily_brief_recipients SET is_active = ? WHERE id = ?', isActive, id);
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/recipients/:id', requireRole('admin'), (req, res) => {
  const db = req.tenantDb!;
  const id = requireInt(req.params.id, 'id');
  db.run('DELETE FROM daily_brief_recipients WHERE id = ?', id);
  res.json({ ok: true });
});

// Branches list for the recipients dropdown. Mirrors the structure used by
// other settings dropdowns — name + id only, sorted by sort_order.
router.get('/branches', requireRole('admin'), async (req, res, next) => {
  try {
    const platformDb = await getPlatformHelper();
    const rows = platformDb.all(
      'SELECT id, name FROM branches WHERE client_id = ? AND is_active = 1 ORDER BY sort_order, name COLLATE NOCASE',
      req.clientId
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Recent send history — the Settings page uses this to show "Last sent: 8:00
// AM today / failed / skipped" under each branch, mirroring auto-sync's UX.
router.get('/sends', requireRole('admin'), (req, res) => {
  const db = req.tenantDb!;
  const limit = Math.min(50, optionalNumber(req.query.limit, 'limit') || 20);
  const rows = db.all(
    `SELECT id, run_date_ist, branch_id, trigger, status, recipient_count,
            started_at, finished_at, error
       FROM daily_brief_sends
      ORDER BY started_at DESC
      LIMIT ?`,
    limit
  );
  res.json(rows);
});

// JSON view of the same data — useful for debugging the gatherer without
// having to read through the rendered HTML.
router.get('/data', requireRole('admin'), async (req, res, next) => {
  try {
    const db = req.tenantDb!;
    const { clientName, branchName } = await resolveLabels(req.clientId!, req.branchId ?? null);
    const streams = await loadStreams(req.clientId!);
    const { today, yesterday } = resolveReportDates(req);
    const data = buildDailyBriefData(db, req, {
      clientName,
      branchName,
      branchId: req.branchId ?? null,
      streams,
      today,
      yesterday,
    });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

export default router;
