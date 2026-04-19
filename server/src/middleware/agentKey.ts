// ─────────────────────────────────────────────────────────────────────────────
// Agent-key Bearer authentication (Slice 5a).
//
// The desktop VCFO Sync agent authenticates every /api/ingest/* request with
// `Authorization: Bearer vcfo_live_<40 hex>`. This middleware:
//   1. Parses the header, SHA-256 hashes the token
//   2. Looks the hash up in platform.db.agent_keys
//   3. Rejects revoked or unknown keys
//   4. Bumps `last_used_at` (fire-and-forget)
//   5. Attaches `req.tenantSlug`, `req.tenantDb`, `req.clientId` so downstream
//      route handlers can write to the correct per-client DB without needing
//      the full session/resolveTenant chain (which requires a user token).
//
// This is the ingest counterpart to `requireAuth` — user-session auth is used
// for everything in the React app, agent-key auth is used only by the sync-
// agent. Keeping them in separate middleware files avoids a mixed auth matrix
// where one function has to handle three different auth shapes.
// ─────────────────────────────────────────────────────────────────────────────

import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { getPlatformHelper } from '../db/platform-connection.js';
import { getClientHelper } from '../db/connection.js';

/** Deterministic key hash — never store the plaintext anywhere. */
export function hashAgentKey(plaintext: string): string {
  return crypto.createHash('sha256').update(plaintext).digest('hex');
}

/** Mint a fresh plaintext key with the `vcfo_live_` prefix. */
export function mintAgentKeyPlaintext(): { plaintext: string; prefix: string } {
  const plaintext = 'vcfo_live_' + crypto.randomBytes(20).toString('hex');
  return { plaintext, prefix: plaintext.slice(0, 14) };
}

/**
 * Middleware for /api/ingest/* — authenticates the desktop agent via its
 * Bearer API key and resolves the corresponding tenant DB.
 *
 * On success: `req.tenantSlug`, `req.clientId`, `req.tenantDb` are set and
 * `req.agentKeyId` identifies which key was used (for audit logging).
 */
export async function requireAgentKey(
  req: Request & { agentKeyId?: number },
  res: Response,
  next: NextFunction,
) {
  const raw = String(req.headers['authorization'] || '');
  const match = /^Bearer\s+(\S+)$/i.exec(raw);
  if (!match) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }

  const hash = hashAgentKey(match[1]);
  const platformDb = await getPlatformHelper();
  const row = platformDb.get(
    `SELECT id, client_id, client_slug, revoked_at
     FROM agent_keys WHERE key_hash = ? LIMIT 1`,
    hash,
  );

  if (!row || row.revoked_at) {
    return res.status(401).json({ error: 'Invalid or revoked agent API key' });
  }

  // Confirm the owning client is still active — revoking the client should
  // also cut off its agent keys even if the row wasn't explicitly revoked.
  const client = platformDb.get(
    'SELECT id, slug, name, is_active FROM clients WHERE id = ?',
    row.client_id,
  );
  if (!client || !client.is_active) {
    return res.status(403).json({ error: 'Client is inactive or missing' });
  }

  // Fire-and-forget touch of last_used_at for diagnostics — an error here
  // must not fail the ingest request.
  try {
    platformDb.run(
      "UPDATE agent_keys SET last_used_at = datetime('now') WHERE id = ?",
      row.id,
    );
  } catch { /* ignore */ }

  // Attach tenant context so route handlers can write into the right per-
  // client DB. We intentionally bypass the full `resolveTenant` middleware —
  // the agent has no user session, and the key itself IS the client scope.
  try {
    req.tenantSlug = client.slug;
    req.clientId = client.id;
    req.clientName = client.name;
    req.tenantDb = await getClientHelper(client.slug);
    req.agentKeyId = row.id;
    next();
  } catch (err: any) {
    console.error('[agentKey] Failed to load tenant DB:', err?.message || err);
    res.status(500).json({ error: 'Failed to load tenant database' });
  }
}
