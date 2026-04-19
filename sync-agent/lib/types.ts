// ─────────────────────────────────────────────────────────────────────────────
// Shared types between main, preload, and renderer.
// Keep this file free of any runtime code so it compiles under every tsconfig.
// ─────────────────────────────────────────────────────────────────────────────

export type TallyVersion = 'prime' | 'erp9' | 'unknown';

export interface TallyCompany {
  name: string;
  fyFrom?: string;
  fyTo?: string;
}

export interface TallyStatus {
  reachable: boolean;
  version?: TallyVersion;
  companies?: TallyCompany[];
  activeCompany?: string | null;
  host: string;
  port: number;
  error?: string;
}

export interface ServerStatus {
  reachable: boolean;
  url: string;
  error?: string;
}

export interface SyncStepLog {
  company: string;
  /**
   * `skipped` — informational row (e.g. whitelisted company not loaded in Tally). Not a failure.
   * `retry`   — a batch drained from the offline queue (replay of a previously-failed push).
   *             When `retry` is present, the original payload's kind is preserved in `retryOfKind`.
   * `voucherLedgerEntries` / `fyOpeningBalances` — feeds the voucher-driven dynamic TB.
   *   The fyOpeningBalances kind may appear with a `:YYYY-MM-DD` suffix when the
   *   window spans multiple FYs (one step per FY start).
   */
  kind:
    | 'companies'
    | 'ledgers'
    | 'vouchers'
    | 'groups'
    | 'stockSummary'
    | 'trialBalance'
    | 'voucherLedgerEntries'
    | 'fyOpeningBalances'
    | `fyOpeningBalances:${string}`
    | 'skipped'
    | 'retry';
  /** When kind='retry', this holds the original ingest kind being replayed. */
  retryOfKind?:
    | 'companies'
    | 'ledgers'
    | 'vouchers'
    | 'groups'
    | 'stockSummary'
    | 'trialBalance'
    | 'voucherLedgerEntries'
    | 'fyOpeningBalances';
  rowsSent: number;
  rowsAccepted: number;
  ok: boolean;
  error?: string;
  durationMs: number;
  /**
   * Multi-client context (Slice 3). Which tenant this step ran for — the agent
   * can sync several clients per tick, so every step is tagged with the owning
   * client so the Log tab can group by client. Optional for backward-compat
   * with history entries written before the refactor.
   */
  clientSlug?: string;
  clientName?: string;
}

/** Per-client summary inside a SyncResult — how many rows landed where. */
export interface SyncClientSummary {
  clientSlug: string;
  clientName: string;
  rowsSent: number;
  ok: boolean;
  error?: string;
  /** Company names this client contributed to this run (informational). */
  companies: string[];
}

export interface SyncResult {
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  rowsSent: number;
  error?: string;
  serverMessage?: string;
  steps?: SyncStepLog[];
  /** Which company was the focus of this run (first on the list, or configured). */
  company?: string;
  /** Date window used for voucher extraction. */
  windowFrom?: string;
  windowTo?: string;
  /**
   * Per-client roll-up for multi-client runs (Slice 3). One entry per linked
   * client that actually ran this tick. Empty / missing for single-client
   * legacy history and for runs that bailed in preflight.
   */
  perClient?: SyncClientSummary[];
}

/**
 * One tenant this agent install is currently linked to (Slice 3).
 *
 * Each entry pairs a cloud-side client with a freshly-minted agent-key and a
 * per-client whitelist of Tally company names. The sync loop iterates this
 * list — one ApiClient per entry, one cursor map per entry. An install can
 * hold zero (not configured yet → ClientPickerView) or many entries.
 *
 * The minted `agentKey` is the only plaintext we ever see; the server stores
 * a SHA-256 hash. If the user "unlinks" a client we simply drop the entry —
 * the key stays live on the server (cheap, and leaves an audit trail) and
 * can be revoked from the admin UI if needed.
 */
export interface AgentClient {
  slug: string;
  /** Display name from /api/auth/my-clients at link time. */
  name: string;
  /** Long-lived vcfo_live_* key. Redacted to "••••xxxx" when sent to renderer. */
  agentKey: string;
  /** First ~14 chars of the key for humane display ("ends with .abcd12"). */
  agentKeyPrefix: string;
  /**
   * Which Tally company names this client should receive. Empty = default to
   * all companies currently open in Tally (backward-compat with pre-Slice-3
   * installs). Populated = strict whitelist for THIS client.
   */
  tallyCompanyNames: string[];
  /**
   * Per-company cursor (YYYY-MM-DD of last successful voucher extract), scoped
   * to this client. Pre-Slice-3 installs carried a single top-level cursor
   * map; on migration that map becomes the cursor of the sole legacy client.
   */
  lastSyncedByCompany?: Record<string, string>;
  /** When the agent-key was minted — for diagnostics / stale-key detection. */
  linkedAt?: string;
}

export interface AgentConfig {
  tallyHost: string;
  tallyPort: number;
  serverUrl: string;
  /**
   * Multi-client list (Slice 3). Empty = not yet configured — App.tsx routes
   * to ClientPickerView. Populated = sync loop iterates one ApiClient per
   * entry. Legacy (Slice 2) installs are migrated on first load (see
   * `migrateLegacyConfig` in electron/main.ts).
   */
  clients: AgentClient[];
  syncIntervalMinutes: number;
  autoSyncEnabled: boolean;
  autoStartOnLogin?: boolean;
  /** ISO date (YYYY-MM-DD) — earliest date to fetch on first sync. Defaults to 1 Apr of current FY. */
  syncFromDate?: string;
  /**
   * ISO date (YYYY-MM-DD) — latest date to fetch. Undefined = run up to "today"
   * on each sync tick (the default; matches pre-period-picker behaviour). Set
   * explicitly when the operator pins a closed window, e.g. syncing a finished
   * FY: `syncFromDate=2024-04-01, syncToDate=2025-03-31`.
   *
   * Cursor interaction: if an existing per-company cursor is AFTER this upper
   * bound (operator shrunk the window), the voucher step for that company is
   * skipped with a structured warning rather than silently producing zero rows.
   * Masters (companies/ledgers/groups) still run — they snapshot "now", not a
   * historical window.
   */
  syncToDate?: string;
  /**
   * Show OS notifications on sync failure, sync recovery, and queue
   * dead-letter events. Default: true on first install, persists through
   * config saves. Set to false to silence all notifications.
   */
  notificationsEnabled?: boolean;
}

export interface AgentStatus {
  tally: TallyStatus;
  server: ServerStatus;
  lastSync: SyncResult | null;
  config: AgentConfig;
  /** Number of ingest batches currently buffered in the offline queue. 0 = nothing pending. */
  queueSize?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Authentication (Slice 1 of team-member login flow).
//
// A team member logs into the agent with their Magna_Tracker credentials. The
// server returns a 24-hour Bearer token that lives in the main process RAM
// only — never persisted to disk. Ingest auth (the long-lived vcfo_agent_keys
// Bearer token) is separate and handled by the pre-existing ApiClient.
//
// Rationale: the user token proves the human is who they claim, but the
// agent-key is what actually authorizes day-to-day sync. That way syncs
// survive the 24-hour token expiry without requiring overnight re-login.
// ─────────────────────────────────────────────────────────────────────────────

export type UserType = 'super_admin' | 'client_user';

export interface AuthUser {
  id: number;
  username: string;
  displayName: string;
  role: string;
  userType: UserType;
  /** True for super_admin owners — they see every client regardless of assignment. */
  isOwner?: boolean;
  /** Count of clients the team member is assigned to (owners: all active clients). */
  assignedClientCount?: number;
  /** Set for client_user type only (they are scoped to one tenant). */
  clientSlug?: string;
  clientId?: number;
  clientName?: string;
}

export interface AuthState {
  /** True when a valid token is held in main-process RAM. */
  loggedIn: boolean;
  user: AuthUser | null;
}

export interface LoginResult {
  ok: boolean;
  /** Present on ok=true. Populated from the login response. */
  user?: AuthUser;
  /** Present on ok=false. Human-readable explanation. */
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Slice 2: client picker + agent-key minting
//
// After login, the agent asks the server which clients the logged-in team
// member can sync for (GET /api/auth/my-clients). The user picks one, the
// main process POSTs to /api/auth/agent-keys to mint a fresh long-lived
// vcfo_live_* key, and drops it into AgentConfig.apiKey so the pre-existing
// sync pipe keeps working unchanged.
// ─────────────────────────────────────────────────────────────────────────────

/** A client this team member can see. Shape matches server response. */
export interface MyClient {
  id: number;
  slug: string;
  name: string;
}

export interface MyClientsResult {
  ok: boolean;
  clients?: MyClient[];
  error?: string;
}

export interface ChooseClientResult {
  ok: boolean;
  /**
   * Present on ok=true. The redacted ("••••xxxx") preview of the newly-linked
   * client — NOT the plaintext key. The plaintext is persisted into config on
   * the main side and never surfaces to the renderer.
   *
   * Slice 3: we always have a `clients` array on success; the renderer should
   * switch to consuming that. `client` is the freshly-added entry (redacted).
   */
  client?: AgentClient;
  clientSlug?: string;
  clientName?: string;
  error?: string;
}

/** Result of unlinking a client from this install. */
export interface RemoveClientResult {
  ok: boolean;
  /** The updated clients list after removal (empty on full unlink). */
  clients?: AgentClient[];
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Slice 4: per-company Tally → (branch, stream) mapping
//
// The agent's Settings view lets the operator pick a branch + stream for each
// Tally company that syncs under a client. The server is source-of-truth for
// these mappings; the agent fetches them via new /api/auth/clients/:slug/*
// endpoints and keeps a local cache only for the lifetime of the view.
// ─────────────────────────────────────────────────────────────────────────────

export interface Branch {
  id: number;
  name: string;
  code: string;
  city?: string;
}

export interface Stream {
  id: number;
  name: string;
}

/** Branch catalog, stream catalog, and the branch↔stream join rows for one client. */
export interface ClientStructure {
  branches: Branch[];
  streams: Stream[];
  branchStreams: { branchId: number; streamId: number }[];
}

/**
 * One company-mapping row. Either fk may be null so a row can be partially
 * filled while the operator collects info — the UI shows an "unmapped" badge
 * until both are set.
 */
export interface CompanyMapping {
  tallyCompanyName: string;
  branchId: number | null;
  streamId: number | null;
  updatedAt?: string;
}
