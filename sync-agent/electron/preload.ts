// ─────────────────────────────────────────────────────────────────────────────
// Preload — the only bridge between the renderer and Node.
// Exposes a tiny, typed API on window.vcfo. No unrestricted ipcRenderer access.
// ─────────────────────────────────────────────────────────────────────────────

import { contextBridge, ipcRenderer } from 'electron';
import type { AgentConfig, AgentStatus, AuthState, ChooseClientResult, ClientStructure, CompanyMapping, LoginResult, MyClientsResult, RemoveClientResult, SyncResult, TallyStatus } from '../lib/types';

export interface QueueSnapshotItem {
  kind: string;
  companyName?: string;
  rowCount: number;
  enqueuedAt: string;
  attempts: number;
  lastError?: string;
}

export interface LogEntry {
  ts: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  [k: string]: unknown;
}

export interface OpenLogFolderResult {
  ok: boolean;
  error?: string;
  path: string;
}

const api = {
  getStatus: (): Promise<AgentStatus> => ipcRenderer.invoke('status:get'),
  runSync: (): Promise<SyncResult> => ipcRenderer.invoke('sync:run'),
  getSyncHistory: (): Promise<SyncResult[]> => ipcRenderer.invoke('sync:history'),
  /**
   * Reset voucher cursors. Accepts three shapes for Slice 3 per-client scoping:
   *   • no arg → wipe every cursor on every linked client
   *   • string → legacy: wipe that company name across ALL clients
   *   • { clientSlug?, companyName? } → scoped reset
   */
  clearSyncCursor: (
    arg?: string | { clientSlug?: string; companyName?: string },
  ): Promise<AgentConfig> => ipcRenderer.invoke('sync:clearCursor', arg),
  testTally: (): Promise<TallyStatus> => ipcRenderer.invoke('tally:test'),
  updateConfig: (patch: Partial<AgentConfig>): Promise<AgentConfig> =>
    ipcRenderer.invoke('config:update', patch),
  /** List items currently waiting in the offline retry queue. */
  getQueueSnapshot: (): Promise<QueueSnapshotItem[]> =>
    ipcRenderer.invoke('queue:snapshot'),
  /** Wipe all pending retries. Returns the number of items dropped. */
  clearOfflineQueue: (): Promise<number> =>
    ipcRenderer.invoke('queue:clear'),
  /** Reveal the userData/logs folder in the OS file manager. */
  openLogFolder: (): Promise<OpenLogFolderResult> =>
    ipcRenderer.invoke('logs:openFolder'),
  /** Return the most recent N log entries (default 100, capped 500). */
  tailLogs: (n?: number): Promise<LogEntry[]> =>
    ipcRenderer.invoke('logs:tail', n),
  onStatus: (cb: (s: AgentStatus) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, s: AgentStatus) => cb(s);
    ipcRenderer.on('status:update', listener);
    // Wrap in a void-returning closure — ipcRenderer.removeListener returns
    // `this` which confuses React's useEffect cleanup signature.
    return () => { ipcRenderer.removeListener('status:update', listener); };
  },

  // ── Auth (Slice 1) ────────────────────────────────────────────────────────
  /** POST /api/auth/login via main. Returns { ok, user? } or { ok:false, error }. */
  login: (username: string, password: string): Promise<LoginResult> =>
    ipcRenderer.invoke('auth:login', { username, password }),
  /** Drop in-memory token + user. Always resolves. */
  logout: (): Promise<{ ok: true }> => ipcRenderer.invoke('auth:logout'),
  /** Snapshot of current auth state. Used on renderer mount to decide login gate. */
  getAuthState: (): Promise<AuthState> => ipcRenderer.invoke('auth:getState'),

  // ── Slice 2/3: client picker + per-client management ──────────────────
  /** GET /api/auth/my-clients via main. Requires a live auth token. */
  getMyClients: (): Promise<MyClientsResult> => ipcRenderer.invoke('auth:myClients'),
  /**
   * Mint a fresh agent-key for the chosen client and APPEND it to
   * config.clients[]. If the slug is already linked, re-mints (upserts)
   * that entry with a fresh key, preserving the company whitelist and
   * cursor history. Returns the new redacted entry.
   */
  chooseClient: (clientSlug: string): Promise<ChooseClientResult> =>
    ipcRenderer.invoke('auth:chooseClient', { clientSlug }),
  /**
   * Unlink one client from this install. Passing no slug unlinks every
   * client — used by "Change client" on the legacy single-tenant shell.
   */
  removeClient: (clientSlug?: string): Promise<RemoveClientResult> =>
    ipcRenderer.invoke('auth:removeClient', clientSlug ? { clientSlug } : undefined),
  /**
   * Set the per-client Tally company whitelist. Empty array = sync every
   * company currently open in Tally (default for freshly-linked clients).
   * Call this from Settings when the user saves a per-client company list.
   */
  updateClientCompanies: (clientSlug: string, tallyCompanyNames: string[]): Promise<AgentConfig> =>
    ipcRenderer.invoke('config:updateClientCompanies', { clientSlug, tallyCompanyNames }),
  /**
   * Back-compat shim — clears ALL linked clients at once. Equivalent to
   * removeClient() with no slug. Retained for pre-Slice-3 callers.
   */
  clearClient: (): Promise<AgentConfig> => ipcRenderer.invoke('auth:clearClient'),

  // ── Slice 4: per-company Tally → (branch, stream) mapping ────────────────
  /** Branch+stream catalog for the given client — populates Settings dropdowns. */
  getClientStructure: (
    clientSlug: string,
  ): Promise<{ ok: true; structure: ClientStructure } | { ok: false; error: string }> =>
    ipcRenderer.invoke('auth:getClientStructure', clientSlug),
  /** Existing per-company assignments. Agent fetches once on Settings mount. */
  getCompanyMappings: (
    clientSlug: string,
  ): Promise<{ ok: true; mappings: CompanyMapping[] } | { ok: false; error: string }> =>
    ipcRenderer.invoke('auth:getCompanyMappings', clientSlug),
  /**
   * Upsert one mapping row. Either id may be null for partial mappings; the
   * server rejects ids that don't belong to this client.
   */
  setCompanyMapping: (args: {
    clientSlug: string;
    companyName: string;
    branchId: number | null;
    streamId: number | null;
  }): Promise<{ ok: true; mapping: CompanyMapping } | { ok: false; error: string }> =>
    ipcRenderer.invoke('auth:setCompanyMapping', args),
  /** Remove a mapping row entirely — used by the "Unmap" action in Settings. */
  removeCompanyMapping: (args: {
    clientSlug: string;
    companyName: string;
  }): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke('auth:removeCompanyMapping', args),
};

contextBridge.exposeInMainWorld('vcfo', api);

export type VcfoBridge = typeof api;
