// ─────────────────────────────────────────────────────────────────────────────
// AuthClient — thin HTTP wrapper for the server's Magna_Tracker auth routes.
//
// This is intentionally separate from ApiClient:
//   • ApiClient talks to /api/ingest/* with a long-lived agent-key Bearer
//     token (minted per-client, persisted on disk).
//   • AuthClient talks to /api/auth/* with the team member's username+password
//     and a short-lived user Bearer token (24h, RAM-only).
//
// Keeping the two clients apart means ingest auth can't accidentally leak the
// user token (different scope, different lifetime, different failure modes).
// ─────────────────────────────────────────────────────────────────────────────

import type { AuthUser, ClientStructure, CompanyMapping, MyClient } from './types';

export interface LoginResponse {
  /** 64-char hex Bearer token. 24-hour expiry on the server side. */
  token: string;
  /** User fields mirror what POST /api/auth/login returns. */
  id: number;
  username: string;
  displayName: string;
  role: string;
  userType: 'super_admin' | 'client_user';
  isOwner?: boolean;
  assignedClientCount?: number;
  clientSlug?: string;
  clientId?: number;
  clientName?: string;
}

/**
 * Thrown when the server returns a non-2xx. Callers can inspect `.status` to
 * decide between "wrong password" (401) and "server down" (network errors,
 * which surface as generic Error, not this class).
 */
export class AuthHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = 'AuthHttpError';
  }
}

export class AuthClient {
  constructor(private readonly baseUrl: string) {}

  private url(path: string): string {
    const base = this.baseUrl.replace(/\/+$/, '');
    const suffix = path.startsWith('/') ? path : `/${path}`;
    return `${base}${suffix}`;
  }

  /**
   * POST /api/auth/login. Returns the full response on 2xx; throws
   * AuthHttpError with the status code on 4xx/5xx. Network errors bubble up
   * as the native fetch error (TypeError on Node, same on browser).
   */
  async login(username: string, password: string): Promise<LoginResponse> {
    const res = await fetch(this.url('/api/auth/login'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'vcfo-sync-agent/0.1.0',
      },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let msg = `HTTP ${res.status}`;
      // The server sends { error: "..." } for 4xx from the auth route.
      try {
        const j = JSON.parse(text);
        if (j && typeof j.error === 'string') msg = j.error;
      } catch { /* not json — keep generic message */ }
      throw new AuthHttpError(msg, res.status, text);
    }
    return (await res.json()) as LoginResponse;
  }

  /**
   * GET /api/auth/my-clients — list the clients the logged-in team member
   * can sync for. Requires a valid Bearer token from login().
   */
  async getMyClients(token: string): Promise<MyClient[]> {
    const res = await fetch(this.url('/api/auth/my-clients'), {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'vcfo-sync-agent/0.1.0',
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let msg = `HTTP ${res.status}`;
      try {
        const j = JSON.parse(text);
        if (j && typeof j.error === 'string') msg = j.error;
      } catch { /* not json */ }
      throw new AuthHttpError(msg, res.status, text);
    }
    const json = await res.json() as { clients?: MyClient[] };
    return Array.isArray(json.clients) ? json.clients : [];
  }

  /**
   * POST /api/auth/agent-keys — mint a fresh long-lived vcfo_live_* key
   * for the chosen client slug. Plaintext is returned exactly once; the
   * caller is responsible for persisting it immediately.
   */
  async mintAgentKey(token: string, clientSlug: string, label?: string): Promise<{
    apiKey: string;
    prefix: string;
    clientSlug: string;
    clientName: string;
    label: string;
  }> {
    const res = await fetch(this.url('/api/auth/agent-keys'), {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'vcfo-sync-agent/0.1.0',
      },
      body: JSON.stringify({ clientSlug, label: label || '' }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let msg = `HTTP ${res.status}`;
      try {
        const j = JSON.parse(text);
        if (j && typeof j.error === 'string') msg = j.error;
      } catch { /* not json */ }
      throw new AuthHttpError(msg, res.status, text);
    }
    const json = await res.json() as {
      ok: boolean;
      apiKey: string;
      prefix: string;
      clientSlug: string;
      clientName: string;
      label: string;
    };
    if (!json.ok || !json.apiKey) {
      throw new AuthHttpError('Server did not return an API key', res.status);
    }
    return json;
  }

  // ─── Slice 4: per-company Tally → (branch, stream) mapping ─────────────────
  // Four endpoints under /api/auth/clients/:slug/... that the agent UI uses to
  // populate dropdowns and persist the operator's choices. All authed with the
  // same user Bearer token as login() / getMyClients().

  /** GET /api/auth/clients/:slug/structure — branch+stream catalog for dropdowns. */
  async getClientStructure(token: string, clientSlug: string): Promise<ClientStructure> {
    const res = await fetch(this.url(`/api/auth/clients/${encodeURIComponent(clientSlug)}/structure`), {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'vcfo-sync-agent/0.1.0',
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let msg = `HTTP ${res.status}`;
      try { const j = JSON.parse(text); if (j?.error) msg = j.error; } catch {}
      throw new AuthHttpError(msg, res.status, text);
    }
    const json = await res.json() as Partial<ClientStructure>;
    return {
      branches: Array.isArray(json.branches) ? json.branches : [],
      streams: Array.isArray(json.streams) ? json.streams : [],
      branchStreams: Array.isArray(json.branchStreams) ? json.branchStreams : [],
    };
  }

  /** GET /api/auth/clients/:slug/company-mappings — current per-company assignments. */
  async getCompanyMappings(token: string, clientSlug: string): Promise<CompanyMapping[]> {
    const res = await fetch(this.url(`/api/auth/clients/${encodeURIComponent(clientSlug)}/company-mappings`), {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'vcfo-sync-agent/0.1.0',
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let msg = `HTTP ${res.status}`;
      try { const j = JSON.parse(text); if (j?.error) msg = j.error; } catch {}
      throw new AuthHttpError(msg, res.status, text);
    }
    const json = await res.json() as { mappings?: CompanyMapping[] };
    return Array.isArray(json.mappings) ? json.mappings : [];
  }

  /**
   * PUT /api/auth/clients/:slug/company-mappings/:companyName — upsert one row.
   * Either id may be null to save a partial mapping; server validates that any
   * non-null id belongs to this client.
   */
  async setCompanyMapping(
    token: string,
    clientSlug: string,
    companyName: string,
    branchId: number | null,
    streamId: number | null,
  ): Promise<CompanyMapping> {
    const res = await fetch(
      this.url(`/api/auth/clients/${encodeURIComponent(clientSlug)}/company-mappings/${encodeURIComponent(companyName)}`),
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'vcfo-sync-agent/0.1.0',
        },
        body: JSON.stringify({ branchId, streamId }),
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let msg = `HTTP ${res.status}`;
      try { const j = JSON.parse(text); if (j?.error) msg = j.error; } catch {}
      throw new AuthHttpError(msg, res.status, text);
    }
    const json = await res.json() as { ok: boolean; mapping?: CompanyMapping };
    if (!json.ok || !json.mapping) {
      throw new AuthHttpError('Server did not return the updated mapping', res.status);
    }
    return json.mapping;
  }

  /** DELETE /api/auth/clients/:slug/company-mappings/:companyName — remove one row. */
  async removeCompanyMapping(
    token: string,
    clientSlug: string,
    companyName: string,
  ): Promise<void> {
    const res = await fetch(
      this.url(`/api/auth/clients/${encodeURIComponent(clientSlug)}/company-mappings/${encodeURIComponent(companyName)}`),
      {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`,
          'User-Agent': 'vcfo-sync-agent/0.1.0',
        },
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let msg = `HTTP ${res.status}`;
      try { const j = JSON.parse(text); if (j?.error) msg = j.error; } catch {}
      throw new AuthHttpError(msg, res.status, text);
    }
  }
}

/** Strip the token out of a LoginResponse to produce the renderer-safe AuthUser. */
export function toAuthUser(resp: LoginResponse): AuthUser {
  return {
    id: resp.id,
    username: resp.username,
    displayName: resp.displayName,
    role: resp.role,
    userType: resp.userType,
    isOwner: resp.isOwner,
    assignedClientCount: resp.assignedClientCount,
    clientSlug: resp.clientSlug,
    clientId: resp.clientId,
    clientName: resp.clientName,
  };
}
