import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { getPlatformHelper } from '../db/platform-connection.js';
import { createToken, removeToken, getTokenData } from '../middleware/auth.js';

const router = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 attempts per window
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.post('/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const platformDb = await getPlatformHelper();

  // Stage 1: Check team_members (super admins)
  const teamMember = platformDb.get(
    'SELECT * FROM team_members WHERE username = ? AND is_active = 1',
    username
  );

  if (teamMember) {
    const valid = await bcrypt.compare(password, teamMember.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid username or password' });

    const token = createToken({
      id: teamMember.id,
      username: teamMember.username,
      display_name: teamMember.display_name,
      role: teamMember.role,
      userType: 'super_admin',
    });

    return res.json({
      id: teamMember.id,
      username: teamMember.username,
      displayName: teamMember.display_name,
      role: teamMember.role,
      userType: 'super_admin',
      token,
    });
  }

  // Stage 2: Check client_users
  const clientUser = platformDb.get(`
    SELECT cu.*, c.slug as client_slug, c.name as client_name, c.id as cid, c.is_multi_branch
    FROM client_users cu
    JOIN clients c ON cu.client_id = c.id
    WHERE cu.username = ? AND cu.is_active = 1 AND c.is_active = 1
  `, username);

  if (clientUser) {
    const valid = await bcrypt.compare(password, clientUser.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid username or password' });

    const token = createToken({
      id: clientUser.id,
      username: clientUser.username,
      display_name: clientUser.display_name,
      role: clientUser.role,
      userType: 'client_user',
      clientSlug: clientUser.client_slug,
      clientId: clientUser.cid,
      clientName: clientUser.client_name,
    });

    // Ensure default modules exist for this client
    const defaultModules = [
      { key: 'forecast_ops', enabled: 1 },
      { key: 'vcfo_portal', enabled: 0 },
      { key: 'audit_view', enabled: 0 },
    ];
    for (const m of defaultModules) {
      platformDb.run(
        'INSERT OR IGNORE INTO client_modules (client_id, module_key, is_enabled) VALUES (?, ?, ?)',
        clientUser.cid, m.key, m.enabled
      );
    }

    // Get enabled modules for this client
    const enabledModules = platformDb.all(
      'SELECT module_key FROM client_modules WHERE client_id = ? AND is_enabled = 1',
      clientUser.cid
    ).map((m: any) => m.module_key);

    // Get branch info for multi-branch clients
    let branches: any[] = [];
    let defaultBranchId: number | null = null;
    const isMultiBranch = !!clientUser.is_multi_branch;

    if (isMultiBranch) {
      if (clientUser.role === 'admin') {
        branches = platformDb.all(
          'SELECT id, name, code, city FROM branches WHERE client_id = ? AND is_active = 1 ORDER BY sort_order, name',
          clientUser.cid
        );
      } else {
        branches = platformDb.all(
          `SELECT b.id, b.name, b.code, b.city, uba.can_view_consolidated
           FROM branches b
           JOIN user_branch_access uba ON uba.branch_id = b.id
           WHERE b.client_id = ? AND b.is_active = 1 AND uba.user_id = ?
           ORDER BY b.sort_order, b.name`,
          clientUser.cid, clientUser.id
        );
      }
      if (branches.length > 0) {
        defaultBranchId = branches[0].id;
      }
    }

    return res.json({
      id: clientUser.id,
      username: clientUser.username,
      displayName: clientUser.display_name,
      role: clientUser.role,
      userType: 'client_user',
      clientSlug: clientUser.client_slug,
      clientName: clientUser.client_name,
      isMultiBranch,
      branches,
      defaultBranchId,
      enabledModules,
      token,
    });
  }

  // No match
  return res.status(401).json({ error: 'Invalid username or password' });
});

router.post('/logout', (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    removeToken(authHeader.slice(7));
  }
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/me', (req, res) => {
  // Check Bearer token
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const data = getTokenData(token);
    if (data) {
      return res.json({
        id: data.userId,
        username: data.username,
        displayName: data.displayName,
        role: data.role,
        userType: data.userType,
        clientSlug: data.clientSlug,
        clientName: data.clientName,
      });
    }
  }

  // Check session (local dev)
  if (req.session?.userId) {
    return res.json({
      id: req.session.userId,
      username: req.session.username,
      displayName: req.session.displayName,
      role: req.session.role,
    });
  }

  res.status(401).json({ error: 'Not authenticated' });
});

export default router;
