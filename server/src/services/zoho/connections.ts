// ─────────────────────────────────────────────────────────────────────────────
// Zoho connection store — the DB + secrets layer for the Zoho integration.
//
// Owns everything in platform.db's zoho_connections / zoho_org_mappings tables.
// Refresh + access tokens are stored AES-256-GCM-encrypted (utils/crypto.ts);
// plaintext never touches disk. getValidAccessToken() transparently reuses a
// cached access token until it's near expiry, then refreshes from the stored
// refresh token. The Zoho APP credentials (client id/secret/redirect) live in
// environment variables, never in the DB — same convention as SESSION_SECRET.
// ─────────────────────────────────────────────────────────────────────────────

import { getPlatformHelper } from '../../db/platform-connection.js';
import { encrypt, decrypt } from '../../utils/crypto.js';
import {
  refreshAccessToken,
  listOrganizations,
  normalizeRegion,
} from './client.js';
import type { ZohoTokenResponse, ZohoOrganization } from './client.js';

export interface ZohoAppCredentials {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** Read the registered Zoho app credentials from env. Throws if unconfigured. */
export function getZohoAppCredentials(): ZohoAppCredentials {
  const clientId = process.env.ZOHO_CLIENT_ID;
  const clientSecret = process.env.ZOHO_CLIENT_SECRET;
  const redirectUri = process.env.ZOHO_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      'Zoho app not configured — set ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET and ZOHO_REDIRECT_URI in the server environment.',
    );
  }
  return { clientId, clientSecret, redirectUri };
}

export function isZohoConfigured(): boolean {
  return !!(process.env.ZOHO_CLIENT_ID && process.env.ZOHO_CLIENT_SECRET && process.env.ZOHO_REDIRECT_URI);
}

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];
function monthNameToNumber(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return v >= 1 && v <= 12 ? v : null;
  const s = String(v).trim().toLowerCase();
  if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10);
    return n >= 1 && n <= 12 ? n : null;
  }
  const idx = MONTHS.indexOf(s);
  return idx >= 0 ? idx + 1 : null;
}

function accessTokenExpiryIso(expiresInSeconds: number | undefined): string {
  // Subtract a 60s safety margin so we refresh slightly early.
  const ttl = Math.max(0, (expiresInSeconds || 3600) - 60);
  return new Date(Date.now() + ttl * 1000).toISOString();
}

// ─── Connections ─────────────────────────────────────────────────────────────

export async function createConnection(opts: {
  label: string;
  region?: string;
  scope?: 'firm' | 'client';
  clientId?: number | null;
}): Promise<number> {
  const db = await getPlatformHelper();
  const res = db.run(
    `INSERT INTO zoho_connections (label, dc_region, scope, client_id, status)
     VALUES (?, ?, ?, ?, 'pending')`,
    opts.label,
    normalizeRegion(opts.region),
    opts.scope === 'client' ? 'client' : 'firm',
    opts.scope === 'client' ? (opts.clientId ?? null) : null,
  );
  return res.lastInsertRowid;
}

/** Public connection listing — never includes token ciphertext. */
export async function listConnections(): Promise<any[]> {
  const db = await getPlatformHelper();
  return db.all(
    `SELECT c.id, c.label, c.dc_region, c.scope, c.client_id, cl.name AS client_name,
            c.status, c.last_error, c.created_at, c.updated_at,
            (SELECT COUNT(*) FROM zoho_org_mappings m WHERE m.connection_id = c.id) AS org_count,
            (SELECT COUNT(*) FROM zoho_org_mappings m WHERE m.connection_id = c.id AND m.is_enabled = 1) AS enabled_org_count
       FROM zoho_connections c
       LEFT JOIN clients cl ON cl.id = c.client_id
      ORDER BY c.created_at DESC`,
  );
}

/** Public connection fields for one connection (never token ciphertext). */
export async function getConnection(id: number): Promise<any> {
  const db = await getPlatformHelper();
  return db.get(
    `SELECT id, label, dc_region, scope, client_id, status, last_error, created_at, updated_at
       FROM zoho_connections WHERE id = ?`,
    id,
  );
}

/** Internal — includes encrypted token columns. Do not return over HTTP. */
async function getConnectionRaw(id: number): Promise<any> {
  const db = await getPlatformHelper();
  return db.get('SELECT * FROM zoho_connections WHERE id = ?', id);
}

export async function deleteConnection(id: number): Promise<void> {
  const db = await getPlatformHelper();
  db.run('DELETE FROM zoho_connections WHERE id = ?', id); // cascades to org_mappings
}

export async function setConnectionStatus(id: number, status: string, error?: string | null): Promise<void> {
  const db = await getPlatformHelper();
  db.run(
    `UPDATE zoho_connections SET status = ?, last_error = ?, updated_at = datetime('now') WHERE id = ?`,
    status, error ?? null, id,
  );
}

/**
 * Persist tokens from the initial authorization-code exchange. The refresh
 * token is only returned on this first exchange, so we always store it here.
 */
export async function storeTokensFromExchange(connectionId: number, tok: ZohoTokenResponse): Promise<void> {
  const db = await getPlatformHelper();
  db.run(
    `UPDATE zoho_connections
        SET refresh_token_enc = ?, access_token_enc = ?, access_token_expires_at = ?,
            status = 'connected', last_error = NULL, updated_at = datetime('now')
      WHERE id = ?`,
    tok.refresh_token ? encrypt(tok.refresh_token) : null,
    encrypt(tok.access_token),
    accessTokenExpiryIso(tok.expires_in),
    connectionId,
  );
}

/**
 * Return a usable access token for a connection: reuse the cached one until
 * it's near expiry, otherwise refresh from the stored refresh token and cache
 * the new one. Marks the connection 'error' (with the message) on failure.
 */
export async function getValidAccessToken(connectionId: number): Promise<string> {
  const db = await getPlatformHelper();
  const row = await getConnectionRaw(connectionId);
  if (!row) throw new Error(`Zoho connection ${connectionId} not found`);
  if (!row.refresh_token_enc) throw new Error(`Zoho connection ${connectionId} is not authorized yet`);

  // Reuse the cached access token while it's still valid.
  if (row.access_token_enc && row.access_token_expires_at) {
    const exp = Date.parse(row.access_token_expires_at);
    if (Number.isFinite(exp) && exp > Date.now()) {
      try {
        return decrypt(row.access_token_enc);
      } catch {
        /* corrupt ciphertext — fall through and refresh */
      }
    }
  }

  const { clientId, clientSecret } = getZohoAppCredentials();
  const refreshToken = decrypt(row.refresh_token_enc);
  try {
    const tok = await refreshAccessToken({ region: row.dc_region, clientId, clientSecret, refreshToken });
    db.run(
      `UPDATE zoho_connections
          SET access_token_enc = ?, access_token_expires_at = ?,
              status = 'connected', last_error = NULL, updated_at = datetime('now')
        WHERE id = ?`,
      encrypt(tok.access_token), accessTokenExpiryIso(tok.expires_in), connectionId,
    );
    return tok.access_token;
  } catch (e: any) {
    await setConnectionStatus(connectionId, 'error', e?.message || String(e));
    throw e;
  }
}

// ─── Org mappings ──────────────────────────────────────────────────────────

/**
 * Fetch the connection's organizations from Zoho and upsert one row per org.
 * Deliberately preserves operator-set fields (target_client_id,
 * target_company_name, is_enabled) on conflict so re-discovery never wipes a
 * mapping the operator already configured.
 */
export async function discoverAndUpsertOrgs(connectionId: number): Promise<ZohoOrganization[]> {
  const db = await getPlatformHelper();
  const row = await getConnectionRaw(connectionId);
  if (!row) throw new Error(`Zoho connection ${connectionId} not found`);

  const accessToken = await getValidAccessToken(connectionId);
  const orgs = await listOrganizations({ region: row.dc_region, accessToken });

  for (const o of orgs) {
    const fyMonth = monthNameToNumber(o.fiscal_year_start_month) ?? 4;
    db.run(
      `INSERT INTO zoho_org_mappings
         (connection_id, zoho_org_id, zoho_org_name, base_currency, fiscal_year_start_month, target_client_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(connection_id, zoho_org_id) DO UPDATE SET
         zoho_org_name = excluded.zoho_org_name,
         base_currency = excluded.base_currency,
         fiscal_year_start_month = excluded.fiscal_year_start_month,
         updated_at = datetime('now')`,
      connectionId,
      String(o.organization_id),
      o.name ?? null,
      o.currency_code ?? null,
      fyMonth,
      // Pre-fill the target for client-scoped connections; firm connections
      // leave it null for the operator to assign per org.
      row.scope === 'client' ? row.client_id : null,
    );
  }
  return orgs;
}

export async function listOrgMappings(connectionId?: number): Promise<any[]> {
  const db = await getPlatformHelper();
  if (connectionId != null) {
    return db.all(
      `SELECT m.*, cl.name AS target_client_name, cl.slug AS target_client_slug
         FROM zoho_org_mappings m
         LEFT JOIN clients cl ON cl.id = m.target_client_id
        WHERE m.connection_id = ?
        ORDER BY m.zoho_org_name`,
      connectionId,
    );
  }
  return db.all(
    `SELECT m.*, cl.name AS target_client_name, cl.slug AS target_client_slug
       FROM zoho_org_mappings m
       LEFT JOIN clients cl ON cl.id = m.target_client_id
      ORDER BY m.connection_id, m.zoho_org_name`,
  );
}

export async function setOrgMappingTarget(
  mappingId: number,
  targetClientId: number | null,
  targetCompanyName: string | null,
): Promise<void> {
  const db = await getPlatformHelper();
  db.run(
    `UPDATE zoho_org_mappings
        SET target_client_id = ?, target_company_name = ?, updated_at = datetime('now')
      WHERE id = ?`,
    targetClientId, targetCompanyName, mappingId,
  );
}

export async function setOrgMappingEnabled(mappingId: number, enabled: boolean): Promise<void> {
  const db = await getPlatformHelper();
  db.run(
    `UPDATE zoho_org_mappings SET is_enabled = ?, updated_at = datetime('now') WHERE id = ?`,
    enabled ? 1 : 0, mappingId,
  );
}

export async function stampOrgSync(mappingId: number, status: string): Promise<void> {
  const db = await getPlatformHelper();
  db.run(
    `UPDATE zoho_org_mappings
        SET last_synced_at = datetime('now'), last_sync_status = ?, updated_at = datetime('now')
      WHERE id = ?`,
    status, mappingId,
  );
}

/**
 * Every org mapping that is ready to sync: enabled, fully targeted, and on a
 * connected connection. Used by the sync runner + scheduler. Includes the
 * connection region and the target client slug needed to open the tenant DB.
 */
export async function getSyncableOrgMappings(): Promise<any[]> {
  const db = await getPlatformHelper();
  return db.all(
    `SELECT m.id, m.connection_id, m.zoho_org_id, m.zoho_org_name, m.base_currency,
            m.fiscal_year_start_month, m.target_client_id, m.target_company_name,
            c.dc_region, c.status AS connection_status,
            cl.slug AS target_client_slug, cl.name AS target_client_name
       FROM zoho_org_mappings m
       JOIN zoho_connections c ON c.id = m.connection_id
       LEFT JOIN clients cl ON cl.id = m.target_client_id
      WHERE m.is_enabled = 1
        AND m.target_client_id IS NOT NULL
        AND m.target_company_name IS NOT NULL
        AND c.status = 'connected'`,
  );
}
