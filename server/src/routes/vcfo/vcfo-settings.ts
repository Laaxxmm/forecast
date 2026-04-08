/**
 * VCFO Settings Routes — Per-client VCFO configuration (Tally host/port, etc.)
 */

import { Router } from 'express';
import { getSetting, setSetting } from '../../services/vcfo/company-resolver.js';

const router = Router();

// Get all settings
router.get('/', (req, res) => {
  try {
    const db = (req as any).tenantDb;
    const rows = db.all('SELECT key, value FROM vcfo_app_settings');
    const settings: Record<string, string> = {};
    for (const r of rows) settings[r.key] = r.value;
    res.json(settings);
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update settings (batch)
router.post('/', (req, res) => {
  try {
    const db = (req as any).tenantDb;
    const updates = req.body;
    if (typeof updates !== 'object') return res.status(400).json({ error: 'Object required' });
    for (const [key, value] of Object.entries(updates)) {
      setSetting(db, key, String(value));
    }
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get sync modules for a company
router.get('/companies/:id/modules', (req, res) => {
  try {
    const db = (req as any).tenantDb;
    const company: any = db.get('SELECT sync_modules FROM vcfo_companies WHERE id = ?', Number(req.params.id));
    if (!company) return res.status(404).json({ error: 'Company not found' });
    res.json(JSON.parse(company.sync_modules || '{}'));
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update sync modules for a company
router.post('/companies/:id/modules', (req, res) => {
  try {
    const db = (req as any).tenantDb;
    const modules = req.body;
    db.run('UPDATE vcfo_companies SET sync_modules = ? WHERE id = ?',
      JSON.stringify(modules), Number(req.params.id));
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
