/**
 * VCFO Filters Routes — Geographic filter endpoints for company dropdowns
 */

import { Router } from 'express';

const router = Router();

router.get('/states', (req, res) => {
  try {
    const db = (req as any).tenantDb;
    const rows = db.all("SELECT DISTINCT state FROM vcfo_companies WHERE is_active = 1 AND state != '' ORDER BY state");
    res.json(rows.map((r: any) => r.state));
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/cities', (req, res) => {
  try {
    const db = (req as any).tenantDb;
    const { state } = req.query;
    let q = "SELECT DISTINCT city FROM vcfo_companies WHERE is_active = 1 AND city != ''";
    const params: any[] = [];
    if (state) { q += ' AND state = ?'; params.push(state); }
    q += ' ORDER BY city';
    const rows = db.all(q, ...params);
    res.json(rows.map((r: any) => r.city));
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/locations', (req, res) => {
  try {
    const db = (req as any).tenantDb;
    const { state, city } = req.query;
    let q = "SELECT DISTINCT location FROM vcfo_companies WHERE is_active = 1 AND location != ''";
    const params: any[] = [];
    if (state) { q += ' AND state = ?'; params.push(state); }
    if (city) { q += ' AND city = ?'; params.push(city); }
    q += ' ORDER BY location';
    const rows = db.all(q, ...params);
    res.json(rows.map((r: any) => r.location));
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/types', (req, res) => {
  try {
    const db = (req as any).tenantDb;
    const rows = db.all("SELECT DISTINCT entity_type FROM vcfo_companies WHERE is_active = 1 AND entity_type != '' ORDER BY entity_type");
    res.json(rows.map((r: any) => r.entity_type));
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
