/**
 * VCFO Company Groups Routes — Ported from TallyVision server.js
 * Manages logical groupings of Tally companies within a client's tenant DB.
 */

import { Router } from 'express';

const router = Router();

// List all groups with member count
router.get('/', (req, res) => {
  try {
    const db = (req as any).tenantDb;
    const groups = db.all(`
      SELECT g.*, COUNT(m.company_id) as member_count
      FROM vcfo_company_groups g
      LEFT JOIN vcfo_company_group_members m ON m.group_id = g.id
      GROUP BY g.id
      ORDER BY g.name
    `);
    // Enrich with member details
    for (const g of groups) {
      g.members = db.all(`
        SELECT c.id, c.name, c.state, c.city, c.location, c.entity_type
        FROM vcfo_company_group_members m
        JOIN vcfo_companies c ON c.id = m.company_id
        WHERE m.group_id = ? AND c.is_active = 1
        ORDER BY c.name
      `, g.id);
    }
    res.json(groups);
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create group
router.post('/', (req, res) => {
  try {
    const db = (req as any).tenantDb;
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const result = db.run(
      'INSERT INTO vcfo_company_groups (name, description) VALUES (?, ?)',
      name, description || ''
    );
    res.json({ id: result.lastInsertRowid, name, description: description || '' });
  } catch (err: any) {
    if (err.message?.includes('UNIQUE')) return res.status(409).json({ error: 'Group name already exists' });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update group
router.put('/:id', (req, res) => {
  try {
    const db = (req as any).tenantDb;
    const { name, description } = req.body;
    db.run(
      'UPDATE vcfo_company_groups SET name = COALESCE(?, name), description = COALESCE(?, description), updated_at = datetime(\'now\') WHERE id = ?',
      name || null, description !== undefined ? description : null, Number(req.params.id)
    );
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete group
router.delete('/:id', (req, res) => {
  try {
    const db = (req as any).tenantDb;
    db.run('DELETE FROM vcfo_company_groups WHERE id = ?', Number(req.params.id));
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Set members (replace all)
router.put('/:id/members', (req, res) => {
  try {
    const db = (req as any).tenantDb;
    const groupId = Number(req.params.id);
    const { companyIds } = req.body;
    if (!Array.isArray(companyIds)) return res.status(400).json({ error: 'companyIds array required' });

    db.exec('BEGIN');
    db.run('DELETE FROM vcfo_company_group_members WHERE group_id = ?', groupId);
    for (const cid of companyIds) {
      db.run('INSERT OR IGNORE INTO vcfo_company_group_members (group_id, company_id) VALUES (?, ?)', groupId, Number(cid));
    }
    db.exec('COMMIT');
    res.json({ success: true, count: companyIds.length });
  } catch (err: any) {
    try { (req as any).tenantDb.exec('ROLLBACK'); } catch {}
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Add single member
router.post('/:id/members/add', (req, res) => {
  try {
    const db = (req as any).tenantDb;
    const { companyId } = req.body;
    db.run('INSERT OR IGNORE INTO vcfo_company_group_members (group_id, company_id) VALUES (?, ?)',
      Number(req.params.id), Number(companyId));
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Remove company from all groups
router.delete('/members/company/:companyId', (req, res) => {
  try {
    const db = (req as any).tenantDb;
    db.run('DELETE FROM vcfo_company_group_members WHERE company_id = ?', Number(req.params.companyId));
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
