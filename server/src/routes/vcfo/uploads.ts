/**
 * VCFO Uploads Routes — Excel file upload, data grid, and analytics
 */

import { Router } from 'express';
import { idPh, resolveIds } from '../../services/vcfo/company-resolver.js';

const router = Router();

// Get active upload categories
router.get('/categories', (req, res) => {
  try {
    const db = (req as any).tenantDb;
    const cats = db.all(
      'SELECT slug, display_name, description, expected_columns FROM vcfo_upload_categories WHERE is_active = 1 ORDER BY sort_order'
    );
    res.json(cats.map((c: any) => ({ ...c, expected_columns: JSON.parse(c.expected_columns || '[]') })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Upload Excel data (expects pre-parsed JSON rows from frontend)
router.post('/excel', (req, res) => {
  try {
    const db = (req as any).tenantDb;
    const { category, periodMonth, companyId, filename, rows, headers, sheetName } = req.body;
    if (!category || !periodMonth || !rows || !Array.isArray(rows)) {
      return res.status(400).json({ error: 'category, periodMonth, and rows are required' });
    }

    // Validate category
    const cat = db.get('SELECT slug FROM vcfo_upload_categories WHERE slug = ?', category);
    if (!cat) return res.status(400).json({ error: 'Invalid category' });

    const cid = companyId && companyId !== '' && companyId !== '0' ? Number(companyId) : null;

    // Replace: delete old upload for same company+category+month
    let existing: any;
    if (cid) {
      existing = db.get(
        'SELECT id FROM vcfo_excel_uploads WHERE company_id = ? AND category = ? AND period_month = ?',
        cid, category, periodMonth
      );
    } else {
      existing = db.get(
        'SELECT id FROM vcfo_excel_uploads WHERE company_id IS NULL AND category = ? AND period_month = ?',
        category, periodMonth
      );
    }

    db.exec('BEGIN');
    try {
      if (existing) {
        db.run('DELETE FROM vcfo_excel_data WHERE upload_id = ?', existing.id);
        db.run('DELETE FROM vcfo_excel_uploads WHERE id = ?', existing.id);
      }

      const result = db.run(
        `INSERT INTO vcfo_excel_uploads (company_id, category, period_month, original_filename, stored_filename, file_size, sheet_name, row_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        cid, category, periodMonth, filename || 'upload.xlsx', 'inline_' + Date.now(),
        JSON.stringify(rows).length, sheetName || 'Sheet1', rows.length
      );
      const uploadId = (result as any).lastInsertRowid;

      for (let idx = 0; idx < rows.length; idx++) {
        db.run(
          'INSERT INTO vcfo_excel_data (upload_id, company_id, period_month, category, row_num, row_data) VALUES (?, ?, ?, ?, ?, ?)',
          uploadId, cid, periodMonth, category, idx + 1, JSON.stringify(rows[idx])
        );
      }

      db.exec('COMMIT');
      res.json({
        success: true, uploadId,
        filename: filename || 'upload.xlsx',
        rowCount: rows.length,
        headers: headers || Object.keys(rows[0] || {}),
        sheetName: sheetName || 'Sheet1',
        replaced: !!existing
      });
    } catch (innerErr) {
      db.exec('ROLLBACK');
      throw innerErr;
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// List uploads with optional filters
router.get('/list', (req, res) => {
  try {
    const db = (req as any).tenantDb;
    const { companyId, category, periodMonth } = req.query;
    let q = `SELECT u.*, c.name as company_name, uc.display_name as category_name
             FROM vcfo_excel_uploads u
             LEFT JOIN vcfo_companies c ON c.id = u.company_id
             JOIN vcfo_upload_categories uc ON uc.slug = u.category
             WHERE 1=1`;
    const params: any[] = [];
    if (companyId) { q += ' AND u.company_id = ?'; params.push(Number(companyId)); }
    if (category) { q += ' AND u.category = ?'; params.push(category); }
    if (periodMonth) { q += ' AND u.period_month = ?'; params.push(periodMonth); }
    q += ' ORDER BY u.period_month DESC, u.uploaded_at DESC';
    res.json(db.all(q, ...params));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Upload grid (calendar-style status for months)
router.get('/grid', (req, res) => {
  try {
    const db = (req as any).tenantDb;
    const { category, companyId } = req.query;
    if (!category) return res.status(400).json({ error: 'category is required' });

    let q: string, params: any[];
    if (companyId) {
      q = `SELECT id, period_month, original_filename, file_size, row_count, uploaded_at
           FROM vcfo_excel_uploads WHERE category = ? AND company_id = ? ORDER BY period_month`;
      params = [category, Number(companyId)];
    } else {
      q = `SELECT id, period_month, original_filename, file_size, row_count, uploaded_at
           FROM vcfo_excel_uploads WHERE category = ? AND company_id IS NULL ORDER BY period_month`;
      params = [category as string];
    }
    const rows = db.all(q, ...params);
    const grid: Record<string, any> = {};
    for (const r of rows) {
      grid[r.period_month] = {
        id: r.id, filename: r.original_filename,
        size: r.file_size, rowCount: r.row_count, uploadedAt: r.uploaded_at
      };
    }
    res.json(grid);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get data for a specific upload
router.get('/data/:uploadId', (req, res) => {
  try {
    const db = (req as any).tenantDb;
    const upl = db.get('SELECT * FROM vcfo_excel_uploads WHERE id = ?', Number(req.params.uploadId));
    if (!upl) return res.status(404).json({ error: 'Upload not found' });
    const rows = db.all(
      'SELECT row_num, row_data FROM vcfo_excel_data WHERE upload_id = ? ORDER BY row_num',
      upl.id
    );
    res.json({
      upload: upl,
      data: rows.map((r: any) => ({ row_num: r.row_num, ...JSON.parse(r.row_data) }))
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Delete an upload and its data
router.delete('/:uploadId', (req, res) => {
  try {
    const db = (req as any).tenantDb;
    const upl = db.get('SELECT * FROM vcfo_excel_uploads WHERE id = ?', Number(req.params.uploadId));
    if (!upl) return res.status(404).json({ error: 'Upload not found' });

    db.exec('BEGIN');
    try {
      db.run('DELETE FROM vcfo_excel_data WHERE upload_id = ?', upl.id);
      db.run('DELETE FROM vcfo_excel_uploads WHERE id = ?', upl.id);
      db.exec('COMMIT');
    } catch (innerErr) {
      db.exec('ROLLBACK');
      throw innerErr;
    }
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Analytics from uploaded data
router.get('/analytics', (req, res) => {
  try {
    const db = (req as any).tenantDb;
    const { category, fromDate, toDate } = req.query;
    if (!category || !fromDate || !toDate) {
      return res.status(400).json({ error: 'category, fromDate, toDate required' });
    }

    // Resolve company IDs from geo filters
    const companyIds = resolveIds(db, req.query);

    // Build list of period months between fromDate and toDate
    const periodMonths: string[] = [];
    const startD = new Date(fromDate + 'T00:00:00');
    const endD = new Date(toDate + 'T00:00:00');
    const cur = new Date(startD.getFullYear(), startD.getMonth(), 1);
    while (cur <= endD) {
      periodMonths.push(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}`);
      cur.setMonth(cur.getMonth() + 1);
    }
    if (!periodMonths.length) return res.json({ hasData: false });

    const monthPh = periodMonths.map(() => '?').join(',');

    // Query excel_data rows
    let q: string, params: any[];
    if (companyIds && companyIds.length) {
      const cPh = idPh(companyIds);
      q = `SELECT row_data FROM vcfo_excel_data WHERE category = ? AND period_month IN (${monthPh}) AND (company_id IN (${cPh}) OR company_id IS NULL)`;
      params = [category as string, ...periodMonths, ...companyIds];
    } else {
      q = `SELECT row_data FROM vcfo_excel_data WHERE category = ? AND period_month IN (${monthPh})`;
      params = [category as string, ...periodMonths];
    }
    const rawRows = db.all(q, ...params);
    if (!rawRows.length) return res.json({ hasData: false });

    // Count uploads
    let uq: string, uParams: any[];
    if (companyIds && companyIds.length) {
      const cPh = idPh(companyIds);
      uq = `SELECT COUNT(*) as cnt FROM vcfo_excel_uploads WHERE category = ? AND period_month IN (${monthPh}) AND (company_id IN (${cPh}) OR company_id IS NULL)`;
      uParams = [category as string, ...periodMonths, ...companyIds];
    } else {
      uq = `SELECT COUNT(*) as cnt FROM vcfo_excel_uploads WHERE category = ? AND period_month IN (${monthPh})`;
      uParams = [category as string, ...periodMonths];
    }
    const uploadCount = db.get(uq, ...uParams)?.cnt || 0;

    // Get actual period months
    let amq: string, amParams: any[];
    if (companyIds && companyIds.length) {
      const cPh = idPh(companyIds);
      amq = `SELECT DISTINCT period_month FROM vcfo_excel_uploads WHERE category = ? AND period_month IN (${monthPh}) AND (company_id IN (${cPh}) OR company_id IS NULL) ORDER BY period_month`;
      amParams = [category as string, ...periodMonths, ...companyIds];
    } else {
      amq = `SELECT DISTINCT period_month FROM vcfo_excel_uploads WHERE category = ? AND period_month IN (${monthPh}) ORDER BY period_month`;
      amParams = [category as string, ...periodMonths];
    }
    const actualMonths = db.all(amq, ...amParams).map((r: any) => r.period_month);

    // Parse all rows
    const rows = rawRows.map((r: any) => JSON.parse(r.row_data));

    const num = (v: any): number => {
      if (v === null || v === undefined || v === '') return 0;
      if (typeof v === 'object' && v.formula) return Number(v.result) || 0;
      return Number(v) || 0;
    };

    // Separate order-level rows (have Bill Date) vs line-item rows
    const orderRows = rows.filter((r: any) => {
      const bd = r['Bill Date'];
      return bd && bd !== '' && typeof bd !== 'object';
    });

    // KPI computations
    let totalBilled = 0, totalCollections = 0, totalRefunds = 0, totalReturns = 0;
    const patientNames = new Set<string>();

    for (const r of orderRows) {
      totalBilled += num(r['Billed']);
      totalCollections += num(r['Paid']);
      const refund = num(r['Refund']);
      totalRefunds += refund;
      if (refund > 0) totalReturns++;
      const name = (r['Name'] || '').toString().trim();
      if (name) patientNames.add(name.toLowerCase());
    }

    const totalOrders = orderRows.length;
    const uniquePatients = patientNames.size;
    const avgBillingValue = totalOrders ? totalBilled / totalOrders : 0;
    const collectionRate = totalBilled ? (totalCollections / totalBilled) * 100 : 0;

    // Department-wise Performance
    const deptMap: Record<string, { total: number; count: number }> = {};
    for (const r of rows) {
      const dept = (r['Dept.'] || r['Dept'] || '').toString().trim();
      if (!dept) continue;
      const price = num(r['Item Price']);
      if (!deptMap[dept]) deptMap[dept] = { total: 0, count: 0 };
      deptMap[dept].total += price;
      deptMap[dept].count++;
    }
    const departments = Object.entries(deptMap)
      .map(([name, d]) => ({ name, total: d.total, count: d.count }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 15);

    // Parse date helper
    function parseDate(val: any): Date | null {
      if (!val) return null;
      if (val instanceof Date) return val;
      const s = String(val).trim();
      const dmyMatch = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/);
      if (dmyMatch) return new Date(Number(dmyMatch[3]), Number(dmyMatch[2]) - 1, Number(dmyMatch[1]));
      const isoMatch = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
      if (isoMatch) return new Date(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3]));
      const d = new Date(s);
      return isNaN(d.getTime()) ? null : d;
    }

    // Weekly Billing Trend
    const weekMap: Record<string, { label: string; weekStart: string; billed: number; collected: number }> = {};
    for (const r of orderRows) {
      const bd = r['Bill Date'];
      if (!bd) continue;
      const d = parseDate(bd);
      if (!d) continue;
      const day = d.getDay();
      const diff = d.getDate() - day + (day === 0 ? -6 : 1);
      const weekStart = new Date(d);
      weekStart.setDate(diff);
      const wsKey = weekStart.toISOString().slice(0, 10);
      const wsDay = String(weekStart.getDate()).padStart(2, '0');
      const wsMonth = weekStart.toLocaleString('en-IN', { month: 'short' });
      const label = `${wsDay} ${wsMonth}`;

      if (!weekMap[wsKey]) weekMap[wsKey] = { label, weekStart: wsKey, billed: 0, collected: 0 };
      weekMap[wsKey].billed += num(r['Billed']);
      weekMap[wsKey].collected += num(r['Paid']);
    }
    const weeklyTrend = Object.values(weekMap).sort((a, b) => a.weekStart.localeCompare(b.weekStart));

    // Doctor-wise Revenue
    const docMap: Record<string, { total: number; count: number }> = {};
    for (const r of rows) {
      const doc = (r['Billed Doctor'] || '').toString().trim();
      if (!doc) continue;
      const price = num(r['Item Price']);
      if (!docMap[doc]) docMap[doc] = { total: 0, count: 0 };
      docMap[doc].total += price;
      docMap[doc].count++;
    }
    const doctors = Object.entries(docMap)
      .map(([name, d]) => ({ name, total: d.total, itemCount: d.count }))
      .sort((a, b) => b.total - a.total);

    res.json({
      hasData: true,
      periodMonths: actualMonths,
      uploadCount,
      kpis: {
        totalBilled: Math.round(totalBilled),
        totalCollections: Math.round(totalCollections),
        collectionRate: Math.round(collectionRate * 10) / 10,
        totalOrders,
        uniquePatients,
        avgBillingValue: Math.round(avgBillingValue),
        totalReturns,
        totalRefunds: Math.round(totalRefunds)
      },
      departments,
      weeklyTrend,
      doctors
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
