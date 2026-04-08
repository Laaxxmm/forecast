/**
 * VCFO Allocation Rules Routes — Inter-company allocation rule management
 */

import { Router } from 'express';

const router = Router();

router.get('/', (req, res) => {
  try {
    const db = (req as any).tenantDb;
    const groupId = Number(req.query.groupId);
    if (!groupId) return res.status(400).json({ error: 'groupId required' });
    const rules = db.all(
      'SELECT * FROM vcfo_allocation_rules WHERE group_id = ? ORDER BY sort_order, id',
      groupId
    );
    for (const r of rules) {
      try { r.config = JSON.parse(r.config); } catch { r.config = {}; }
    }
    res.json(rules);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', (req, res) => {
  try {
    const db = (req as any).tenantDb;
    const { group_id, rule_name, rule_type, config, sort_order, affects_dashboard } = req.body;
    if (!group_id || !rule_name || !rule_type) return res.status(400).json({ error: 'group_id, rule_name, rule_type required' });
    const result = db.run(
      `INSERT INTO vcfo_allocation_rules (group_id, rule_name, rule_type, config, sort_order, affects_dashboard)
       VALUES (?, ?, ?, ?, ?, ?)`,
      group_id, rule_name, rule_type, JSON.stringify(config || {}), sort_order || 0, affects_dashboard || 0
    );
    res.json({ id: result.lastInsertRowid });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', (req, res) => {
  try {
    const db = (req as any).tenantDb;
    const { rule_name, rule_type, config, sort_order, affects_dashboard } = req.body;
    db.run(
      `UPDATE vcfo_allocation_rules SET rule_name = COALESCE(?, rule_name), rule_type = COALESCE(?, rule_type),
       config = COALESCE(?, config), sort_order = COALESCE(?, sort_order), affects_dashboard = COALESCE(?, affects_dashboard),
       updated_at = datetime('now') WHERE id = ?`,
      rule_name || null, rule_type || null, config ? JSON.stringify(config) : null,
      sort_order !== undefined ? sort_order : null, affects_dashboard !== undefined ? affects_dashboard : null,
      Number(req.params.id)
    );
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id/toggle', (req, res) => {
  try {
    const db = (req as any).tenantDb;
    db.run('UPDATE vcfo_allocation_rules SET is_active = 1 - is_active, updated_at = datetime(\'now\') WHERE id = ?',
      Number(req.params.id));
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const db = (req as any).tenantDb;
    db.run('DELETE FROM vcfo_allocation_rules WHERE id = ?', Number(req.params.id));
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
