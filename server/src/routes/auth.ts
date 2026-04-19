import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { getPlatformHelper } from '../db/platform-connection.js';
import { createToken, removeToken, getTokenData, requireAuth } from '../middleware/auth.js';
import { getVcfoBridge } from '../services/vcfo-bridge.js';

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

    const isOwner = !!teamMember.is_owner;

    // Count assigned clients for non-owner team members
    const assignedClientCount = isOwner
      ? platformDb.all('SELECT id FROM clients WHERE is_active = 1').length
      : platformDb.all('SELECT id FROM team_member_clients WHERE team_member_id = ?', teamMember.id).length;

    const token = createToken({
      id: teamMember.id,
      username: teamMember.username,
      display_name: teamMember.display_name,
      role: teamMember.role,
      userType: 'super_admin',
      isOwner,
    });

    return res.json({
      id: teamMember.id,
      username: teamMember.username,
      displayName: teamMember.display_name,
      role: teamMember.role,
      userType: 'super_admin',
      isOwner,
      assignedClientCount,
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
      { key: 'litigation_tool', enabled: 0 },
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

    // Get enabled integrations/settings for this client
    const allIntegrationRows = platformDb.all(
      'SELECT integration_key, is_enabled FROM client_integrations WHERE client_id = ?',
      clientUser.cid
    );
    const enabledIntegrations = allIntegrationRows
      .filter((i: any) => i.is_enabled)
      .map((i: any) => i.integration_key);

    // For backward compat: if new core keys have no DB row yet, treat as enabled by default
    const existingKeys = new Set(allIntegrationRows.map((i: any) => i.integration_key));
    const clientObj = platformDb.get('SELECT industry FROM clients WHERE id = ?', clientUser.cid);
    const clientIndustry = clientObj?.industry || 'custom';
    const defaultOnKeys = ['financial_years', 'manual_upload'];
    if (clientIndustry === 'healthcare') defaultOnKeys.push('doctors');
    for (const key of defaultOnKeys) {
      if (!existingKeys.has(key)) enabledIntegrations.push(key);
    }

    // Get branch info for multi-branch clients
    let branches: any[] = [];
    let defaultBranchId: number | null = null;
    const isMultiBranch = !!clientUser.is_multi_branch;

    if (isMultiBranch) {
      if (clientUser.role === 'admin') {
        branches = platformDb.all(
          'SELECT id, name, code, city, state FROM branches WHERE client_id = ? AND is_active = 1 ORDER BY sort_order, name',
          clientUser.cid
        );
      } else {
        branches = platformDb.all(
          `SELECT b.id, b.name, b.code, b.city, b.state, uba.can_view_consolidated
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

      // Attach branch streams to each branch
      for (const branch of branches) {
        const branchStreams = platformDb.all(
          `SELECT bs.id, bs.name FROM branch_streams bst
           JOIN business_streams bs ON bst.stream_id = bs.id
           WHERE bst.branch_id = ? AND bs.is_active = 1`,
          branch.id
        );
        branch.streams = branchStreams;
      }
    }

    // Get client streams
    const streams = platformDb.all(
      'SELECT id, name, icon, color FROM business_streams WHERE client_id = ? AND is_active = 1 ORDER BY sort_order',
      clientUser.cid
    );

    // Get stream access for non-admin users
    let streamAccess: any[] = [];
    if (clientUser.role !== 'admin') {
      streamAccess = platformDb.all(
        `SELECT ubsa.branch_id, ubsa.stream_id
         FROM user_branch_stream_access ubsa
         JOIN branches b ON ubsa.branch_id = b.id
         WHERE ubsa.user_id = ? AND b.client_id = ?`,
        clientUser.id, clientUser.cid
      );
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
      streams,
      streamAccess,
      enabledModules,
      enabledIntegrations,
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
        isOwner: data.isOwner,
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

// ═════════════════════════════════════════════════════════════════════════════
// Sync-agent endpoints (used by the desktop VCFO Sync app after login).
//
// The desktop agent logs in with team-member credentials (handled above),
// then calls these two endpoints to (1) find out which clients it can sync
// for, and (2) mint a long-lived agent API key bound to the chosen client.
// The minted key is stored locally by the agent and used for subsequent
// per-tenant /vcfo/* calls.
//
// Both routes require a live Bearer token. Only super_admin users (team
// members) are allowed — client_user logins have no business driving an
// agent install, so we 403 them early.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Shared authorization helper for sync-agent client-scoped endpoints.
 *
 * Every new endpoint below needs the exact same gate: super_admin login +
 * owner-or-assigned-to-this-client. Centralising it means the 4 new mapping
 * routes stay concise and there's exactly one place to tighten the rules.
 *
 * Returns `{ client }` on success; returns `null` and writes an error
 * response on failure — the caller must `return` immediately in that case.
 */
async function requireClientAccess(
  req: any,
  res: any,
  clientSlug: string,
): Promise<{ client: { id: number; slug: string; name: string } } | null> {
  if (req.userType !== 'super_admin') {
    res.status(403).json({ error: 'Team-member login required' });
    return null;
  }
  const slug = String(clientSlug || '').trim().toLowerCase();
  if (!slug) {
    res.status(400).json({ error: 'clientSlug is required' });
    return null;
  }
  const platformDb = await getPlatformHelper();
  const client = platformDb.get(
    'SELECT id, slug, name FROM clients WHERE slug = ? AND is_active = 1',
    slug,
  );
  if (!client) {
    res.status(404).json({ error: 'Client not found' });
    return null;
  }
  if (!req.isOwner) {
    const assignment = platformDb.get(
      'SELECT id FROM team_member_clients WHERE team_member_id = ? AND client_id = ?',
      [req.session.userId, client.id],
    );
    if (!assignment) {
      res.status(403).json({ error: 'You are not assigned to this client' });
      return null;
    }
  }
  return { client };
}

/** GET /api/auth/my-clients — clients visible to the logged-in team member. */
router.get('/my-clients', requireAuth, async (req, res) => {
  if (req.userType !== 'super_admin') {
    return res.status(403).json({ error: 'Team-member login required' });
  }

  const platformDb = await getPlatformHelper();
  const rows = req.isOwner
    // Owners see every active client on the platform.
    ? platformDb.all(`
        SELECT id, slug, name
        FROM clients
        WHERE is_active = 1
        ORDER BY name
      `)
    // Non-owner team members see only the clients they've been assigned to.
    : platformDb.all(`
        SELECT c.id, c.slug, c.name
        FROM team_member_clients tmc
        JOIN clients c ON c.id = tmc.client_id
        WHERE tmc.team_member_id = ? AND c.is_active = 1
        ORDER BY c.name
      `, req.session.userId);

  res.json({ clients: rows });
});

/**
 * POST /api/auth/agent-keys — mint a fresh agent API key for a chosen client.
 *
 * Body: { clientSlug: string, label?: string }
 * Returns the plaintext key exactly once — the agent must persist it
 * immediately. The server stores only a SHA-256 hash.
 *
 * Authorization rules mirror /my-clients: Owners can mint for any client;
 * non-owner team members must have the slug in team_member_clients.
 */
router.post('/agent-keys', requireAuth, async (req, res) => {
  if (req.userType !== 'super_admin') {
    return res.status(403).json({ error: 'Team-member login required' });
  }

  const clientSlug = String(req.body?.clientSlug || '').trim().toLowerCase();
  const label = typeof req.body?.label === 'string' ? req.body.label.slice(0, 120) : '';
  if (!clientSlug) return res.status(400).json({ error: 'clientSlug is required' });

  const platformDb = await getPlatformHelper();
  const client = platformDb.get(
    'SELECT id, slug, name FROM clients WHERE slug = ? AND is_active = 1',
    clientSlug
  );
  if (!client) return res.status(404).json({ error: 'Client not found' });

  // Non-owners need an explicit team_member_clients row for this slug.
  if (!req.isOwner) {
    const assignment = platformDb.get(
      'SELECT id FROM team_member_clients WHERE team_member_id = ? AND client_id = ?',
      [req.session.userId, client.id]
    );
    if (!assignment) {
      return res.status(403).json({ error: 'You are not assigned to this client' });
    }
  }

  // TallyVision owns the vcfo_agent_keys table and the hash+label insert path.
  // We reach into it via the bridge captured at mount time.
  const bridge = getVcfoBridge();
  if (!bridge) {
    return res.status(503).json({ error: 'VCFO sub-app not available' });
  }

  try {
    const created = bridge.createAgentKey(clientSlug, label || `sync-agent (${req.session.username})`);
    return res.json({
      ok: true,
      apiKey: created.plaintext,        // shown exactly once
      prefix: created.prefix,
      clientSlug: created.clientSlug,
      clientName: client.name,
      label: created.label,
    });
  } catch (err: any) {
    return res.status(400).json({ error: err?.message || 'Failed to create agent key' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// Slice 4: per-company Tally → (branch, stream) mapping.
//
// The sync-agent desktop UI needs to let the operator assign each Tally
// data file (company) to a specific branch and business stream for the
// client. These 4 endpoints let the agent (a) fetch the branch/stream
// catalog to populate dropdowns, (b) fetch existing mappings, and
// (c) upsert/delete one mapping at a time.
//
// All routes live under /api/auth/clients/:slug/... and reuse the user
// session token the agent already has. Authorization is delegated to
// `requireClientAccess` above: super_admin + owner-or-assigned.
// ═════════════════════════════════════════════════════════════════════════════

/** GET /api/auth/clients/:slug/structure — branches + streams + join rows for a client. */
router.get('/clients/:slug/structure', requireAuth, async (req, res) => {
  const ok = await requireClientAccess(req, res, String(req.params.slug));
  if (!ok) return;
  const platformDb = await getPlatformHelper();

  const branches = platformDb.all(
    `SELECT id, name, code, city
     FROM branches
     WHERE client_id = ? AND is_active = 1
     ORDER BY sort_order, name`,
    ok.client.id,
  );
  const streams = platformDb.all(
    `SELECT id, name
     FROM business_streams
     WHERE client_id = ? AND is_active = 1
     ORDER BY sort_order, name`,
    ok.client.id,
  );
  // Join rows scoped to this client via the branches they reference.
  const branchStreams = platformDb.all(
    `SELECT bs.branch_id AS branchId, bs.stream_id AS streamId
     FROM branch_streams bs
     JOIN branches b ON b.id = bs.branch_id
     WHERE b.client_id = ? AND bs.is_active = 1`,
    ok.client.id,
  );

  res.json({ branches, streams, branchStreams });
});

/** GET /api/auth/clients/:slug/company-mappings — existing per-company assignments. */
router.get('/clients/:slug/company-mappings', requireAuth, async (req, res) => {
  const ok = await requireClientAccess(req, res, String(req.params.slug));
  if (!ok) return;
  const platformDb = await getPlatformHelper();

  const rows = platformDb.all(
    `SELECT tally_company_name AS tallyCompanyName,
            branch_id          AS branchId,
            stream_id          AS streamId,
            updated_at         AS updatedAt
     FROM vcfo_company_mapping
     WHERE client_id = ?
     ORDER BY tally_company_name`,
    ok.client.id,
  );

  res.json({ mappings: rows });
});

/**
 * PUT /api/auth/clients/:slug/company-mappings/:companyName — upsert one mapping.
 *
 * Body: `{ branchId: number | null, streamId: number | null }`. Validates
 * that any non-null id belongs to THIS client's platform.db rows so a
 * non-owner team member can't trick the server into attaching another
 * client's branch/stream.
 */
router.put('/clients/:slug/company-mappings/:companyName', requireAuth, async (req, res) => {
  const ok = await requireClientAccess(req, res, String(req.params.slug));
  if (!ok) return;

  const companyName = String(req.params.companyName ?? '').trim();
  if (!companyName) return res.status(400).json({ error: 'companyName is required' });

  const rawBranchId = req.body?.branchId;
  const rawStreamId = req.body?.streamId;
  const branchId = rawBranchId === null || rawBranchId === undefined ? null : Number(rawBranchId);
  const streamId = rawStreamId === null || rawStreamId === undefined ? null : Number(rawStreamId);
  if (branchId !== null && !Number.isInteger(branchId)) {
    return res.status(400).json({ error: 'branchId must be an integer or null' });
  }
  if (streamId !== null && !Number.isInteger(streamId)) {
    return res.status(400).json({ error: 'streamId must be an integer or null' });
  }

  const platformDb = await getPlatformHelper();

  // Cross-client isolation: ensure any supplied id belongs to THIS client.
  if (branchId !== null) {
    const b = platformDb.get(
      'SELECT id FROM branches WHERE id = ? AND client_id = ?',
      [branchId, ok.client.id],
    );
    if (!b) return res.status(400).json({ error: 'branchId does not belong to this client' });
  }
  if (streamId !== null) {
    const s = platformDb.get(
      'SELECT id FROM business_streams WHERE id = ? AND client_id = ?',
      [streamId, ok.client.id],
    );
    if (!s) return res.status(400).json({ error: 'streamId does not belong to this client' });
  }

  platformDb.run(
    `INSERT INTO vcfo_company_mapping (client_id, tally_company_name, branch_id, stream_id, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(client_id, tally_company_name) DO UPDATE SET
       branch_id  = excluded.branch_id,
       stream_id  = excluded.stream_id,
       updated_at = datetime('now')`,
    [ok.client.id, companyName, branchId, streamId],
  );

  const row = platformDb.get(
    `SELECT tally_company_name AS tallyCompanyName,
            branch_id          AS branchId,
            stream_id          AS streamId,
            updated_at         AS updatedAt
     FROM vcfo_company_mapping
     WHERE client_id = ? AND tally_company_name = ?`,
    [ok.client.id, companyName],
  );

  res.json({ ok: true, mapping: row });
});

/** DELETE /api/auth/clients/:slug/company-mappings/:companyName — remove one mapping row. */
router.delete('/clients/:slug/company-mappings/:companyName', requireAuth, async (req, res) => {
  const ok = await requireClientAccess(req, res, String(req.params.slug));
  if (!ok) return;

  const companyName = String(req.params.companyName ?? '').trim();
  if (!companyName) return res.status(400).json({ error: 'companyName is required' });

  const platformDb = await getPlatformHelper();
  const result = platformDb.run(
    'DELETE FROM vcfo_company_mapping WHERE client_id = ? AND tally_company_name = ?',
    [ok.client.id, companyName],
  );

  res.json({ ok: true, removed: result?.changes ?? 0 });
});

export default router;
