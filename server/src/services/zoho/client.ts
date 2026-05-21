// ─────────────────────────────────────────────────────────────────────────────
// Zoho Books API client (stateless, region-aware).
//
// Pure HTTP layer for the Zoho Books v3 REST API + Zoho OAuth2. No DB, no
// secrets storage — callers (services/zoho/connections.ts) hold the tokens and
// pass them in. Kept side-effect-free so it's trivially testable.
//
// Data centers: Zoho hosts per-region. The region string IS the domain suffix
// (in | com | eu | com.au | jp), so both hosts derive from it cleanly:
//   accounts host : accounts.zoho.<region>      (OAuth)
//   api host      : www.zohoapis.<region>/books/v3   (data)
// Default region is 'in' (India) — that's where this deployment's clients are.
//
// Auth header (exact, per Zoho docs): `Authorization: Zoho-oauthtoken <token>`
// — the token may ONLY be passed in the header, never as a query param.
// ─────────────────────────────────────────────────────────────────────────────

// Node 20+ provides a global fetch (undici); better-sqlite3 v12 already pins the
// runtime to Node 20+. Declared (module-scoped, so it shadows nothing global)
// with just the surface we use, so the type-check passes regardless of whether
// the TS lib config surfaces the undici/DOM fetch typings.
declare function fetch(
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  headers: { get(name: string): string | null };
  json(): Promise<any>;
  text(): Promise<string>;
}>;

export const DEFAULT_REGION = 'in';
const ALLOWED_REGIONS = new Set(['in', 'com', 'eu', 'com.au', 'jp']);

/** Least-privilege READ-only scopes covering everything the sync pulls. */
export const ZOHO_READ_SCOPES = [
  'ZohoBooks.accountants.READ', // chart of accounts, journals, account transactions
  'ZohoBooks.settings.READ', // opening balances, currencies, taxes, org details
  'ZohoBooks.invoices.READ',
  'ZohoBooks.bills.READ',
  'ZohoBooks.expenses.READ',
  'ZohoBooks.customerpayments.READ',
  'ZohoBooks.vendorpayments.READ',
  'ZohoBooks.banking.READ',
  'ZohoBooks.creditnotes.READ',
  'ZohoBooks.debitnotes.READ',
  'ZohoBooks.salesorders.READ',
  'ZohoBooks.purchaseorders.READ',
  'ZohoBooks.contacts.READ',
];

// Inter-page delay to respect Zoho's 100-req/min-per-org cap. Tunable via env;
// the runner adds its own pacing across accounts on top of this.
const THROTTLE_MS = Math.max(0, parseInt(process.env.ZOHO_THROTTLE_MS || '700', 10) || 700);
const MAX_RETRIES = 4;

export interface ZohoTokenResponse {
  access_token: string;
  refresh_token?: string; // only present on authorization_code exchange
  api_domain?: string;
  token_type?: string;
  expires_in: number; // seconds (Zoho returns 3600)
}

export interface ZohoOrganization {
  organization_id: string;
  name: string;
  currency_code?: string;
  fiscal_year_start_month?: string; // e.g. "april" on some endpoints
  [k: string]: unknown;
}

export function normalizeRegion(region?: string | null): string {
  const r = (region || DEFAULT_REGION).trim().toLowerCase();
  return ALLOWED_REGIONS.has(r) ? r : DEFAULT_REGION;
}

function accountsBase(region: string): string {
  return `https://accounts.zoho.${normalizeRegion(region)}`;
}

function apiBase(region: string): string {
  return `https://www.zohoapis.${normalizeRegion(region)}/books/v3`;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function buildQuery(query?: Record<string, string | number | undefined | null>): string {
  if (!query) return '';
  const parts = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

function formBody(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

// ─── OAuth ───────────────────────────────────────────────────────────────────

/**
 * Build the Zoho authorization URL the browser is redirected to. We force
 * `access_type=offline` + `prompt=consent` so Zoho returns a refresh token
 * (needed for unattended scheduled syncs). `state` is our CSRF/correlation
 * token, validated on callback.
 */
export function buildAuthUrl(opts: {
  region: string;
  clientId: string;
  redirectUri: string;
  state: string;
  scopes?: string[];
}): string {
  const scope = (opts.scopes && opts.scopes.length ? opts.scopes : ZOHO_READ_SCOPES).join(',');
  const query = buildQuery({
    scope,
    client_id: opts.clientId,
    response_type: 'code',
    redirect_uri: opts.redirectUri,
    access_type: 'offline',
    prompt: 'consent',
    state: opts.state,
  });
  return `${accountsBase(opts.region)}/oauth/v2/auth${query}`;
}

async function postToken(region: string, fields: Record<string, string>): Promise<ZohoTokenResponse> {
  const res = await fetch(`${accountsBase(region)}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody(fields),
  });
  const json = await res.json();
  // Zoho returns 200 with an `error` field on bad grants (e.g. "invalid_code").
  if (!res.ok || json?.error) {
    throw new Error(`Zoho OAuth token error: ${json?.error || res.statusText} (HTTP ${res.status})`);
  }
  if (!json?.access_token) {
    throw new Error('Zoho OAuth: no access_token in response');
  }
  return json as ZohoTokenResponse;
}

/** Exchange an authorization code for access + refresh tokens. */
export function exchangeCode(opts: {
  region: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
}): Promise<ZohoTokenResponse> {
  return postToken(opts.region, {
    grant_type: 'authorization_code',
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    redirect_uri: opts.redirectUri,
    code: opts.code,
  });
}

/** Mint a fresh access token from a stored refresh token. */
export function refreshAccessToken(opts: {
  region: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<ZohoTokenResponse> {
  return postToken(opts.region, {
    grant_type: 'refresh_token',
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    refresh_token: opts.refreshToken,
  });
}

// ─── Data API ──────────────────────────────────────────────────────────────

/**
 * Authenticated GET against the Books API with retry/backoff on 429 (rate
 * limit) and 5xx. Honors a `Retry-After` header when present. Throws on
 * non-retryable errors and on Zoho's non-zero `code` envelope.
 */
export async function zohoGet(opts: {
  region: string;
  accessToken: string;
  path: string; // e.g. '/chartofaccounts'
  query?: Record<string, string | number | undefined | null>;
}): Promise<any> {
  const url = `${apiBase(opts.region)}${opts.path}${buildQuery(opts.query)}`;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Zoho-oauthtoken ${opts.accessToken}` },
      });
    } catch (e) {
      // Network blip — back off and retry.
      lastErr = e;
      await sleep(500 * (attempt + 1));
      continue;
    }

    if (res.status === 429 || res.status >= 500) {
      const retryAfter = parseInt(res.headers.get('Retry-After') || '', 10);
      const waitMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : 1000 * Math.pow(2, attempt);
      lastErr = new Error(`Zoho HTTP ${res.status}`);
      await sleep(waitMs);
      continue;
    }

    const json = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(`Zoho API ${res.status}: ${json?.message || res.statusText}`);
    }
    // Success envelope is { code: 0, message: 'success', <data> }. A non-zero
    // code is an application error even on HTTP 200.
    if (json && typeof json.code === 'number' && json.code !== 0) {
      throw new Error(`Zoho API error ${json.code}: ${json.message || 'unknown'}`);
    }
    return json;
  }
  throw new Error(`Zoho GET ${opts.path} failed after ${MAX_RETRIES + 1} attempts: ${(lastErr as Error)?.message || lastErr}`);
}

/**
 * GET every page of a list endpoint, concatenating `json[listKey]`. Zoho
 * paginates via `page` + `per_page` (max 200) and reports `page_context.
 * has_more_page`. A short throttle between pages keeps us under the
 * 100-req/min cap.
 */
export async function zohoGetAllPages(opts: {
  region: string;
  accessToken: string;
  path: string;
  listKey: string; // e.g. 'chartofaccounts', 'journals', 'invoices'
  query?: Record<string, string | number | undefined | null>;
  perPage?: number;
  maxPages?: number;
}): Promise<any[]> {
  const out: any[] = [];
  const perPage = opts.perPage ?? 200;
  const maxPages = opts.maxPages ?? 500; // hard safety cap (~100k rows)
  for (let page = 1; page <= maxPages; page++) {
    const json = await zohoGet({
      region: opts.region,
      accessToken: opts.accessToken,
      path: opts.path,
      query: { ...(opts.query || {}), page, per_page: perPage },
    });
    const rows = Array.isArray(json?.[opts.listKey]) ? json[opts.listKey] : [];
    out.push(...rows);
    const hasMore = json?.page_context?.has_more_page === true;
    if (!hasMore || rows.length === 0) break;
    if (THROTTLE_MS > 0) await sleep(THROTTLE_MS);
  }
  return out;
}

/** List the organizations (sets of books) the connected account can access. */
export async function listOrganizations(opts: {
  region: string;
  accessToken: string;
}): Promise<ZohoOrganization[]> {
  const json = await zohoGet({ region: opts.region, accessToken: opts.accessToken, path: '/organizations' });
  return Array.isArray(json?.organizations) ? (json.organizations as ZohoOrganization[]) : [];
}
