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
