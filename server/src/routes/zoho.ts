// ─────────────────────────────────────────────────────────────────────────────
// Zoho Books integration routes (firm / super-admin only).
//
// Connection management + the OAuth dance + org→tenant mapping. Most endpoints
// are gated by requireAuth + requireSuperAdmin (managing Zoho logins that may
// span multiple clients is a firm-level operation). The ONE exception is
// GET /oauth/callback, which Zoho's browser redirect hits with no auth header —
// it's declared BEFORE the gate and protected instead by a one-time `state`
// token we mint in /authorize.
//
// Mounted in index.ts as: app.use('/api/zoho', zohoRoutes)  — note: NO auth
// middleware at the mount, because the callback must stay public.
// ─────────────────────────────────────────────────────────────────────────────

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { requireAuth, requireSuperAdmin } from '../middleware/auth.js';
import {
  isZohoConfigured,
  getZohoAppCredentials,
  createConnection,
  listConnections,
  getConnection,
  deleteConnection,
  storeTokensFromExchange,
  discoverAndUpsertOrgs,
  listOrgMappings,
  setOrgMappingTarget,
  setOrgMappingEnabled,
} from '../services/zoho/connections.js';
import { buildAuthUrl, exchangeCode } from '../services/zoho/client.js';
import { runZohoSyncByMappingId } from '../services/zoho/runner.js';

const router = Router();

// ── OAuth state store — CSRF + correlation, in-memory with a 10-min TTL.
//    Mirrors the token-store pattern in middleware/auth.ts. ──────────────────
interface PendingAuth {
  connectionId: number;
  region: string;
  createdAt: number;
}
const pendingAuth = new Map<string, PendingAuth>();
const STATE_TTL_MS = 10 * 60 * 1000;
const stateSweep = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingAuth) {
    if (now - v.createdAt > STATE_TTL_MS) pendingAuth.delete(k);
  }
}, 5 * 60 * 1000);
stateSweep.unref();

function parseId(v: unknown): number | null {
  const n = parseInt(String(v), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** SPA origin derived from the configured redirect URI (strip the API path). */
function spaOrigin(): string {
  const uri = process.env.ZOHO_REDIRECT_URI || '';
  return uri.split('/api/zoho/oauth/callback')[0] || '';
}

// ─── PUBLIC: OAuth callback ──────────────────────────────────────────────────
// Declared before the auth gate so Zoho's browser redirect (no auth header)
// reaches it. Security comes from validating the one-time `state` token.
router.get('/oauth/callback', async (req: Request, res: Response) => {
  const origin = spaOrigin();
  const back = (params: string) => res.redirect(`${origin}/admin?${params}`);
  try {
    const code = req.query.code ? String(req.query.code) : '';
    const state = req.query.state ? String(req.query.state) : '';
    const oauthErr = req.query.error ? String(req.query.error) : '';
    if (oauthErr) return back(`zoho=error&message=${encodeURIComponent(oauthErr)}`);
    if (!code || !state) return back('zoho=error&message=missing_code_or_state');

    const pending = pendingAuth.get(state);
    pendingAuth.delete(state);
    if (!pending || Date.now() - pending.createdAt > STATE_TTL_MS) {
      return back('zoho=error&message=expired_or_invalid_state');
    }

    const { clientId, clientSecret, redirectUri } = getZohoAppCredentials();
    const tok = await exchangeCode({ region: pending.region, clientId, clientSecret, redirectUri, code });
    await storeTokensFromExchange(pending.connectionId, tok);

    // Best-effort: pull the org list immediately so the UI shows the books.
    try {
      await discoverAndUpsertOrgs(pending.connectionId);
    } catch (e) {
      console.warn('[zoho] post-connect org discovery failed (non-fatal):', (e as Error)?.message);
    }
    return back(`zoho=connected&connection=${pending.connectionId}`);
  } catch (e: any) {
    console.error('[zoho] oauth callback error:', e?.message || e);
    return back(`zoho=error&message=${encodeURIComponent(e?.message || 'oauth_failed')}`);
  }
});

// ─── Everything below requires a logged-in super admin ───────────────────────
router.use(requireAuth, requireSuperAdmin);

/** Is the server configured with the Zoho app env vars? */
router.get('/config-status', (_req: Request, res: Response) => {
  res.json({ configured: isZohoConfigured(), redirectUri: process.env.ZOHO_REDIRECT_URI || null });
});

router.get('/connections', async (_req: Request, res: Response) => {
  res.json({ connections: await listConnections() });
});

router.post('/connections', async (req: Request, res: Response) => {
  const { label, region, scope, clientId } = req.body || {};
  if (!label || !String(label).trim()) return res.status(400).json({ error: 'label is required' });
  const isClient = scope === 'client';
  if (isClient && !clientId) {
    return res.status(400).json({ error: 'clientId is required for a client-scoped connection' });
  }
  const id = await createConnection({
    label: String(label).trim(),
    region,
    scope: isClient ? 'client' : 'firm',
    clientId: isClient ? Number(clientId) : null,
  });
  res.json({ id });
});

router.delete('/connections/:id', async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid id' });
  await deleteConnection(id);
  res.json({ ok: true });
});

/** Begin OAuth — returns the Zoho consent URL the browser should navigate to. */
router.post('/connections/:id/authorize', async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid id' });
  if (!isZohoConfigured()) {
    return res.status(400).json({ error: 'Server is missing ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET / ZOHO_REDIRECT_URI' });
  }
  const conn = await getConnection(id);
  if (!conn) return res.status(404).json({ error: 'connection not found' });

  const { clientId, redirectUri } = getZohoAppCredentials();
  const state = crypto.randomBytes(24).toString('hex');
  pendingAuth.set(state, { connectionId: id, region: conn.dc_region, createdAt: Date.now() });
  const authUrl = buildAuthUrl({ region: conn.dc_region, clientId, redirectUri, state });
  res.json({ authUrl });
});

/** Manually re-pull the org list for a connection. */
router.post('/connections/:id/discover', async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid id' });
  try {
    const orgs = await discoverAndUpsertOrgs(id);
    res.json({ ok: true, count: orgs.length, mappings: await listOrgMappings(id) });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'discovery failed' });
  }
});

router.get('/connections/:id/orgs', async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid id' });
  res.json({ mappings: await listOrgMappings(id) });
});

router.get('/orgs', async (_req: Request, res: Response) => {
  res.json({ mappings: await listOrgMappings() });
});

/** Point a Zoho org at a tenant company (which client's books it becomes). */
router.put('/orgs/:id/target', async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid id' });
  const { targetClientId, targetCompanyName } = req.body || {};
  await setOrgMappingTarget(
    id,
    targetClientId ? Number(targetClientId) : null,
    targetCompanyName ? String(targetCompanyName).trim() : null,
  );
  res.json({ ok: true });
});

router.put('/orgs/:id/enabled', async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid id' });
  await setOrgMappingEnabled(id, !!(req.body && req.body.enabled));
  res.json({ ok: true });
});

/**
 * Manual "Sync now" for one org mapping — pulls COA + transactions into the
 * target tenant's vcfo_* tables. Runs synchronously; for a large first
 * backfill this can take a while (the scheduled tick, task 8, will run these
 * in the background). Returns row counts + any field-mapping warnings.
 */
router.post('/orgs/:id/sync', async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid id' });
  try {
    const result = await runZohoSyncByMappingId(id);
    res.json({ ok: true, result });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'sync failed' });
  }
});

export default router;
