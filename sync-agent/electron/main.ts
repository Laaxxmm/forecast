// ─────────────────────────────────────────────────────────────────────────────
// VCFO Sync — Electron main process
// ─────────────────────────────────────────────────────────────────────────────
// Responsibilities:
//   • Tray icon + window lifecycle (hidden-by-default, show on click)
//   • IPC handlers that the renderer calls to drive Tally + cloud operations
//   • Periodic sync loop (setInterval; migrate to node-cron later)
//   • Config persistence to userData/config.json
//
// The main process is where all Node-only capabilities live: direct TCP/HTTP
// to Tally, filesystem for config, auto-launch. The renderer is a pure React
// status UI that only talks IPC.
// ─────────────────────────────────────────────────────────────────────────────

import { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { TallyConnector } from '../lib/tally/connector';
import { ApiClient } from '../lib/api-client';
import type { IngestBatchPayload, IngestBatchResponse, IngestKind } from '../lib/api-client';
import {
  extractCompanies,
  extractLedgers,
  extractVouchers,
  extractGroups,
  extractStockSummary,
  extractTrialBalance,
} from '../lib/tally/extractors';
import type { AgentClient, AgentConfig, AuthState, AuthUser, ChooseClientResult, ClientStructure, CompanyMapping, LoginResult, MyClient, MyClientsResult, RemoveClientResult, SyncClientSummary, SyncResult, SyncStepLog, TallyStatus } from '../lib/types';
import { OfflineQueue, isRetryableError } from '../lib/offline-queue';
import { Logger, errCtx } from '../lib/logger';
import { Notifier } from '../lib/notifier';
import { AuthClient, AuthHttpError, toAuthUser } from '../lib/auth-client';
import { BAKED } from './baked-defaults';

// ── Globals ─────────────────────────────────────────────────────────────────
let tray: Tray | null = null;
let mainWindow: BrowserWindow | null = null;
let syncTimer: NodeJS.Timeout | null = null;
let lastSync: SyncResult | null = null;
let syncHistory: SyncResult[] = []; // in-memory ring buffer; persisted lazily below
let syncInFlight = false;

// ── Auth state (Slice 1: RAM-only, never persisted) ─────────────────────────
// authToken is the 24h Bearer token from POST /api/auth/login. It only lives
// in the main process — never passed to the renderer, never written to disk.
// The renderer sees `authUser` via the IPC bridge; that's enough to render
// "logged in as X / logout".
let authToken: string | null = null;
let authUser: AuthUser | null = null;

const DEV = !app.isPackaged;
const DEV_URL = 'http://localhost:5174';
const SYNC_HISTORY_MAX = 25;

// ── Config ──────────────────────────────────────────────────────────────────
// Stored at %APPDATA%/vcfo-sync-agent/config.json on Windows.
const CONFIG_PATH = () => path.join(app.getPath('userData'), 'config.json');
const HISTORY_PATH = () => path.join(app.getPath('userData'), 'sync-history.json');
const QUEUE_PATH = () => path.join(app.getPath('userData'), 'offline-queue.json');
const LOG_DIR = () => path.join(app.getPath('userData'), 'logs');

// Default server URL: env var (dev override) → baked constant (prod default)
// → localhost fallback. See scripts/bake-defaults.js for how the baked value
// gets set at build time.
const DEFAULT_SERVER_URL =
  process.env.VCFO_DEFAULT_SERVER_URL || BAKED?.serverUrl || 'http://localhost:3001';

const DEFAULT_CONFIG: AgentConfig = {
  tallyHost: 'localhost',
  tallyPort: 9000,
  serverUrl: DEFAULT_SERVER_URL,
  clients: [], // empty = agent not yet linked to any tenant → ClientPickerView
  syncIntervalMinutes: 5,
  autoSyncEnabled: false, // off until at least one client is linked
  autoStartOnLogin: false,
  syncFromDate: defaultSyncFromDate(),
  notificationsEnabled: true, // OS notifications on sync fail/recover/dead-letter
};

function defaultSyncFromDate(): string {
  // Indian FY starts Apr 1. If today is before Apr, use last year's April.
  const now = new Date();
  const year = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return `${year}-04-01`;
}

/**
 * Bring a disk-read config up to the Slice 3 shape.
 *
 * Three input cases:
 *   1. Fresh install (no file / empty object) → DEFAULT_CONFIG with empty clients[].
 *   2. Slice 2 install: has flat `apiKey` + `clientSlug` + `selectedCompanies`
 *      + `lastSyncedByCompany`. Wrap those into a single-entry `clients` array
 *      so the existing linkage survives the refactor. The client name defaults
 *      to the slug (admin-UI fetches can reconcile it later via /my-clients).
 *   3. Slice 3 install: already has `clients` array. Merge defaults, normalise
 *      per-client shape, drop any leftover legacy fields.
 *
 * The migrated shape is written back to disk by the caller so subsequent
 * loads skip the legacy branch.
 */
function migrateLegacyConfig(parsed: any): { config: AgentConfig; migrated: boolean } {
  const rawClients = Array.isArray(parsed?.clients) ? parsed.clients : null;

  // Case 2 → one-entry array synthesised from legacy fields.
  if (!rawClients && typeof parsed?.apiKey === 'string' && parsed.apiKey && typeof parsed?.clientSlug === 'string' && parsed.clientSlug) {
    const legacyKey = String(parsed.apiKey);
    const legacySlug = String(parsed.clientSlug);
    const legacyClient: AgentClient = {
      slug: legacySlug,
      name: legacySlug, // best-effort until we can reconcile against /my-clients
      agentKey: legacyKey,
      agentKeyPrefix: legacyKey.slice(0, 14),
      tallyCompanyNames: Array.isArray(parsed.selectedCompanies) ? parsed.selectedCompanies.map(String) : [],
      lastSyncedByCompany: parsed.lastSyncedByCompany && typeof parsed.lastSyncedByCompany === 'object'
        ? { ...parsed.lastSyncedByCompany }
        : {},
      linkedAt: new Date().toISOString(),
    };
    const merged: AgentConfig = {
      ...DEFAULT_CONFIG,
      ...parsed,
      clients: [legacyClient],
    };
    // Remove legacy fields so the on-disk shape is clean after the next save.
    delete (merged as any).apiKey;
    delete (merged as any).clientSlug;
    delete (merged as any).selectedCompanies;
    delete (merged as any).lastSyncedByCompany;
    return { config: merged, migrated: true };
  }

  // Case 3 → already Slice 3. Just sanity-check per-client shape.
  if (rawClients) {
    const normalised: AgentClient[] = rawClients
      .filter((c: any) => c && typeof c === 'object' && typeof c.slug === 'string' && typeof c.agentKey === 'string')
      .map((c: any) => ({
        slug: String(c.slug),
        name: typeof c.name === 'string' && c.name ? c.name : String(c.slug),
        agentKey: String(c.agentKey),
        agentKeyPrefix: typeof c.agentKeyPrefix === 'string' && c.agentKeyPrefix
          ? c.agentKeyPrefix
          : String(c.agentKey).slice(0, 14),
        tallyCompanyNames: Array.isArray(c.tallyCompanyNames) ? c.tallyCompanyNames.map(String) : [],
        lastSyncedByCompany: c.lastSyncedByCompany && typeof c.lastSyncedByCompany === 'object'
          ? { ...c.lastSyncedByCompany }
          : {},
        linkedAt: typeof c.linkedAt === 'string' ? c.linkedAt : undefined,
      }));
    const merged: AgentConfig = {
      ...DEFAULT_CONFIG,
      ...parsed,
      clients: normalised,
    };
    // Strip legacy keys if they somehow survived (e.g. partial migration).
    delete (merged as any).apiKey;
    delete (merged as any).clientSlug;
    delete (merged as any).selectedCompanies;
    delete (merged as any).lastSyncedByCompany;
    return { config: merged, migrated: false };
  }

  // Case 1 → fresh install.
  return { config: { ...DEFAULT_CONFIG, clients: [] }, migrated: false };
}

function loadConfig(): AgentConfig {
  try {
    const raw = fs.readFileSync(CONFIG_PATH(), 'utf8');
    const parsed = JSON.parse(raw);
    const { config: migrated, migrated: didMigrate } = migrateLegacyConfig(parsed);
    if (didMigrate) {
      // Persist the new shape immediately so we don't re-migrate on every boot.
      try { saveConfig(migrated); } catch { /* saveConfig itself logs on failure */ }
    }
    return migrated;
  } catch {
    return { ...DEFAULT_CONFIG, clients: [] };
  }
}

function saveConfig(cfg: AgentConfig): void {
  const dir = path.dirname(CONFIG_PATH());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH(), JSON.stringify(cfg, null, 2), 'utf8');
}

function loadSyncHistory(): SyncResult[] {
  try {
    const raw = fs.readFileSync(HISTORY_PATH(), 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.slice(-SYNC_HISTORY_MAX) : [];
  } catch {
    return [];
  }
}

function saveSyncHistory(): void {
  try {
    const dir = path.dirname(HISTORY_PATH());
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(HISTORY_PATH(), JSON.stringify(syncHistory.slice(-SYNC_HISTORY_MAX), null, 2), 'utf8');
  } catch (err) { logError(err, 'saveSyncHistory'); }
}

let config = loadConfig();
syncHistory = loadSyncHistory();
lastSync = syncHistory[syncHistory.length - 1] || null;

// Disk-backed retry queue. Any ingest batch that fails with a transient error
// (network / 5xx) is appended here; the next runSync drains it BEFORE fresh
// extraction. See lib/offline-queue.ts for the full contract.
const offlineQueue = new OfflineQueue(QUEUE_PATH());

// Rolling NDJSON log at userData/logs/agent.log. One file, rotates at ~1 MB,
// keeps the last 5 rotations. See lib/logger.ts for details.
const logger = new Logger({
  dir: LOG_DIR(),
  maxBytes: 1_048_576,
  maxFiles: 5,
  mirrorConsole: DEV,
  minLevel: DEV ? 'debug' : 'info',
});
logger.info('agent.boot', {
  userData: app.getPath('userData'),
  version: app.getVersion?.() ?? 'unknown',
  electron: process.versions.electron,
  node: process.versions.node,
  dev: DEV,
  // Tag the ingest-URL convention so future diagnostics can tell old agents
  // (using /vcfo/api/ingest/*) apart from new ones (using /api/ingest/*).
  serverUrlVersion: 'v2-ingest-paths',
});

// Desktop notifier — surfaces actionable events (sync failed, sync restored,
// queue dead-letter) to the OS. Cooldown and channel state lives here; all
// fire calls route through this so we keep spam down to ~1 event per kind
// per 15 min. Click handler reopens the main window so the user can look
// at the log directly.
const notifier = new Notifier(
  () => config.notificationsEnabled !== false,
  { cooldownMs: 15 * 60 * 1000, onClick: () => showMainWindow() },
);
notifier.setLogger((msg, ctx) => logger.info(msg, ctx));

// ── Tray icon ───────────────────────────────────────────────────────────────
// Loads resources/icon.png in dev and {resources}/icon.png (via extraResources)
// in packaged builds. Falls back to an inline 16×16 emerald-square PNG if the
// file is missing so the agent still boots — useful during fresh clones before
// `node scripts/build-icon.js` has run.
function iconFilePath(): string | null {
  const candidates = DEV
    ? [path.join(__dirname, '..', '..', 'resources', 'icon.png')]
    : [
        path.join(process.resourcesPath, 'icon.png'),
        path.join(process.resourcesPath, 'resources', 'icon.png'),
      ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return null;
}

function createTrayIcon(): Electron.NativeImage {
  const file = iconFilePath();
  if (file) {
    const img = nativeImage.createFromPath(file);
    if (!img.isEmpty()) {
      // Tray needs a small image on Windows — resize to 16×16 (x2 on HiDPI).
      return img.resize({ width: 16, height: 16, quality: 'best' });
    }
  }
  // Fallback: 16×16 emerald PNG encoded inline.
  const emerald =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAHElEQVQ4jWNgGAWjYBSMglEwCkbB' +
    'KBgFwwsAAgAAQ7T6O+AAAAAASUVORK5CYII=';
  return nativeImage.createFromDataURL(emerald);
}

function createTray() {
  tray = new Tray(createTrayIcon());
  tray.setToolTip('VCFO Sync');
  rebuildTrayMenu();
  tray.on('click', toggleMainWindow);
}

function rebuildTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: 'Open VCFO Sync', click: showMainWindow },
    { type: 'separator' },
    { label: 'Sync Now', click: () => runSync().catch((e) => logError(e, 'tray.syncNow')) },
    {
      label: config.autoSyncEnabled ? 'Pause auto-sync' : 'Resume auto-sync',
      click: () => {
        config.autoSyncEnabled = !config.autoSyncEnabled;
        saveConfig(config);
        restartScheduler();
        rebuildTrayMenu();
        pushStatus();
      },
    },
    { type: 'separator' },
    { label: 'Open config folder', click: () => shell.openPath(path.dirname(CONFIG_PATH())) },
    { label: 'Open log folder', click: () => {
      try { if (!fs.existsSync(LOG_DIR())) fs.mkdirSync(LOG_DIR(), { recursive: true }); } catch { /* ignore */ }
      shell.openPath(LOG_DIR());
    } },
    { label: 'Quit', click: () => { app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

// ── Window ──────────────────────────────────────────────────────────────────
function createMainWindow() {
  const iconPath = iconFilePath();
  mainWindow = new BrowserWindow({
    width: 460,
    height: 620,
    show: false,
    resizable: false,
    fullscreenable: false,
    minimizable: true,
    maximizable: false,
    autoHideMenuBar: true,
    title: 'VCFO Sync',
    backgroundColor: '#0f172a',
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (DEV) {
    mainWindow.loadURL(DEV_URL);
    // mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    // __dirname at runtime is dist-electron/electron — go up two levels to
    // reach the app root, then into the Vite-built renderer at dist/.
    mainWindow.loadFile(path.join(__dirname, '..', '..', 'dist', 'index.html'));
  }

  // Hide to tray instead of quitting on window close
  mainWindow.on('close', (e) => {
    if (!(app as any).isQuitting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('ready-to-show', () => {
    pushStatus();
  });
}

function showMainWindow() {
  if (!mainWindow) { createMainWindow(); return; }
  mainWindow.show();
  mainWindow.focus();
}

function toggleMainWindow() {
  if (!mainWindow) { createMainWindow(); return; }
  if (mainWindow.isVisible()) mainWindow.hide();
  else showMainWindow();
}

// ── Sync ────────────────────────────────────────────────────────────────────
async function pingTally(): Promise<TallyStatus> {
  const conn = new TallyConnector({ host: config.tallyHost, port: config.tallyPort });
  try {
    const reachable = await conn.ping();
    if (!reachable) {
      return { reachable: false, error: 'TALLY_UNREACHABLE', host: config.tallyHost, port: config.tallyPort };
    }
    const [companies, version] = await Promise.all([
      conn.getCompanies().catch(() => []),
      conn.detectVersion().catch(() => 'unknown' as const),
    ]);
    return {
      reachable: true,
      version,
      companies,
      host: config.tallyHost,
      port: config.tallyPort,
    };
  } catch (err: any) {
    return {
      reachable: false,
      error: err?.message || 'unknown_error',
      host: config.tallyHost,
      port: config.tallyPort,
    };
  }
}

async function pingServer(): Promise<{ reachable: boolean; url: string; error?: string }> {
  // Cloud reachability probe — hits /api/ingest/ping (post-cutover path,
  // TallyVision retired). Uses the first client's agent-key so auth is
  // meaningful, but any 200/401 response from the server counts as reachable.
  const probeKey = config.clients[0]?.agentKey || '';
  const client = new ApiClient(config.serverUrl, probeKey);
  try {
    const ok = await client.ping();
    return { reachable: ok, url: config.serverUrl };
  } catch (err: any) {
    return { reachable: false, url: config.serverUrl, error: err?.message || 'unknown_error' };
  }
}

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function pushStep(step: SyncStepLog, steps: SyncStepLog[], counts: { rowsSent: number; anyFailure: boolean }) {
  steps.push(step);
  counts.rowsSent += step.rowsAccepted;
  if (!step.ok) counts.anyFailure = true;
}

/**
 * Resolve which companies this sync run should target for a single client.
 *   - If `selected` (the client's tallyCompanyNames) is non-empty: whitelist
 *     mode. Intersect with the live list; companies in the whitelist that
 *     Tally isn't currently showing become a `skipped` warning, not a failure.
 *   - If it's empty / missing: sync every company Tally reports (back-compat
 *     for clients that haven't had a Tally mapping set yet).
 * Returns the ordered list of company names to process.
 */
export function resolveSyncTargets(
  discovered: string[],
  selected: string[] | undefined,
): { targets: string[]; skipped: string[] } {
  if (!selected || selected.length === 0) {
    return { targets: discovered, skipped: [] };
  }
  const have = new Set(discovered);
  const targets = selected.filter((n) => have.has(n));
  const skipped = selected.filter((n) => !have.has(n));
  return { targets, skipped };
}

/**
 * Attempt to push a batch to the server. On a *retryable* failure (network
 * down, 5xx, 408/425/429) the payload is appended to the offline queue and
 * the original error is re-thrown with a " (queued for retry)" suffix so
 * the step log tells the user the batch wasn't lost. On a *non-retryable*
 * failure (4xx, malformed payload) the error is re-thrown as-is — queuing
 * a structurally broken payload would just replay the same failure forever.
 *
 * The `clientSlug` on the payload is agent-internal routing (so a queued
 * item can be replayed against the right ApiClient on the next drain).
 * ApiClient.ingestBatch strips it before serialisation.
 */
async function tryPush(
  client: ApiClient,
  payload: IngestBatchPayload,
): Promise<IngestBatchResponse> {
  try {
    return await client.ingestBatch(payload);
  } catch (err) {
    if (isRetryableError(err)) {
      const { evicted } = offlineQueue.enqueue(payload);
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('queue.enqueue', {
        kind: payload.kind,
        companyName: payload.companyName,
        clientSlug: payload.clientSlug,
        rowCount: Array.isArray(payload.rows) ? payload.rows.length : 0,
        queueSize: offlineQueue.size(),
        evicted: evicted ? {
          kind: evicted.payload.kind,
          companyName: evicted.payload.companyName,
          clientSlug: evicted.payload.clientSlug,
          attempts: evicted.attempts,
        } : undefined,
        error: msg,
      });
      throw new Error(`${msg} (queued for retry)`);
    }
    throw err;
  }
}

/**
 * Drain whatever was queued on previous runs before we extract fresh data.
 * Runs at the start of every sync, immediately after preflight and config
 * validation succeed. Each queued item becomes its own SyncStepLog with
 * `kind: 'retry'` and the original ingest kind preserved in `retryOfKind`.
 *
 * Multi-client routing (Slice 3): each queued payload carries a `clientSlug`
 * tag. The drainer looks up the matching AgentClient in the current config
 * and uses its ApiClient for replay. If the tag is missing (legacy queue
 * items from before the refactor) we fall back to the sole client when
 * exactly one is linked — otherwise we treat it as a poisoned payload so
 * we don't silently push it to the wrong tenant.
 *
 * Termination policy (per-item):
 *   • Success → pop the head, log a green 'retry' step, continue.
 *   • Retryable failure (server still down) → recordFailure (which may
 *     dead-letter after maxAttempts) and STOP draining. No point hammering
 *     a dead server with the rest of the queue on the same tick.
 *   • Non-retryable failure (shape error, auth problem) → pop the poisoned
 *     item, log a red step marked "(dropped from queue)", and continue with
 *     the next — one bad payload shouldn't stall subsequent replays.
 */
async function drainQueue(
  steps: SyncStepLog[],
  counts: { rowsSent: number; anyFailure: boolean },
): Promise<void> {
  if (offlineQueue.size() === 0) return;

  // Safety brake: never loop more than (queue size at start + 1) times.
  // Protects against any future logic bug where we forget to pop/break.
  const budget = offlineQueue.size() + 1;
  let iter = 0;

  // Map slug → {client, api} so we only instantiate ApiClient once per tenant
  // even if the queue holds many items per slug.
  const clientBySlug = new Map<string, AgentClient>(config.clients.map((c) => [c.slug, c]));
  const apiBySlug = new Map<string, ApiClient>();
  const getApi = (slug: string): ApiClient | null => {
    const rec = clientBySlug.get(slug);
    if (!rec) return null;
    let api = apiBySlug.get(slug);
    if (!api) {
      api = new ApiClient(config.serverUrl, rec.agentKey);
      apiBySlug.set(slug, api);
    }
    return api;
  };

  while (offlineQueue.size() > 0 && iter < budget) {
    iter += 1;
    const head = offlineQueue.peek();
    if (!head) break;
    const t0 = Date.now();
    const originalKind: IngestKind = head.payload.kind;
    const companyName = head.payload.companyName || '(masters)';
    const rowCount = Array.isArray(head.payload.rows) ? head.payload.rows.length : 0;

    // Resolve which client this payload belongs to. Fall back to sole client
    // for legacy (pre-Slice-3) queue entries that don't carry a slug.
    let slug = head.payload.clientSlug || '';
    if (!slug && config.clients.length === 1) slug = config.clients[0].slug;
    const clientRec = slug ? clientBySlug.get(slug) : undefined;
    const clientName = clientRec?.name || slug || '(unknown)';
    const api = slug ? getApi(slug) : null;

    if (!api) {
      // Unroutable — tenant was unlinked while this payload was in flight.
      // Dropping is safe because a fresh sync for this client (if it gets
      // re-linked) will re-extract and re-push the same rows idempotently.
      offlineQueue.pop();
      const durationMs = Date.now() - t0;
      pushStep(
        {
          company: companyName,
          clientSlug: slug || undefined,
          clientName: clientName,
          kind: 'retry',
          retryOfKind: originalKind,
          rowsSent: rowCount,
          rowsAccepted: 0,
          ok: false,
          error: slug
            ? `Queued batch for client "${slug}" has no linked agent-key anymore (dropped from queue)`
            : 'Queued batch has no client tag and multiple clients are linked (dropped from queue)',
          durationMs,
        },
        steps, counts,
      );
      logger.warn('queue.drain.unroutable', {
        retryOfKind: originalKind,
        companyName,
        clientSlug: slug || null,
        reason: slug ? 'client_unlinked' : 'ambiguous_legacy_item',
      });
      continue;
    }

    try {
      const res = await api.ingestBatch(head.payload);
      offlineQueue.pop();
      const durationMs = Date.now() - t0;
      pushStep(
        {
          company: companyName,
          clientSlug: slug,
          clientName,
          kind: 'retry',
          retryOfKind: originalKind,
          rowsSent: rowCount,
          rowsAccepted: res.rowsAccepted,
          ok: true,
          durationMs,
        },
        steps, counts,
      );
      logger.info('queue.drain.ok', {
        retryOfKind: originalKind,
        companyName,
        clientSlug: slug,
        rowsAccepted: res.rowsAccepted,
        attempts: head.attempts + 1,
        durationMs,
        queueSize: offlineQueue.size(),
      });
    } catch (err: any) {
      const msg = err?.message || 'unknown_error';
      const durationMs = Date.now() - t0;
      if (isRetryableError(err)) {
        const { dropped } = offlineQueue.recordFailure(msg);
        pushStep(
          {
            company: companyName,
            clientSlug: slug,
            clientName,
            kind: 'retry',
            retryOfKind: originalKind,
            rowsSent: rowCount,
            rowsAccepted: 0,
            ok: false,
            error: dropped ? `${msg} (dead-lettered after max attempts)` : msg,
            durationMs,
          },
          steps, counts,
        );
        if (dropped) {
          logger.error('queue.deadletter', {
            retryOfKind: originalKind,
            companyName,
            clientSlug: slug,
            enqueuedAt: head.enqueuedAt,
            attempts: head.attempts + 1,
            lastError: msg,
          });
          notifier.fire(
            'queue_deadletter',
            'VCFO Sync: batch dropped after retries',
            `A ${originalKind} batch for "${companyName}" (${clientName}) couldn't be pushed after ${head.attempts + 1} attempts and was discarded. Check the log for details.`,
            { urgent: true, bypassCooldown: true, logCtx: { retryOfKind: originalKind, companyName, clientSlug: slug } },
          );
        } else {
          logger.warn('queue.drain.retryable', {
            retryOfKind: originalKind,
            companyName,
            clientSlug: slug,
            attempts: head.attempts + 1,
            error: msg,
            queueSize: offlineQueue.size(),
          });
        }
        // Server still unreachable — stop draining this run.
        break;
      } else {
        // Shape / auth error: pop as poison and try the next item.
        offlineQueue.pop();
        pushStep(
          {
            company: companyName,
            clientSlug: slug,
            clientName,
            kind: 'retry',
            retryOfKind: originalKind,
            rowsSent: rowCount,
            rowsAccepted: 0,
            ok: false,
            error: `${msg} (dropped from queue)`,
            durationMs,
          },
          steps, counts,
        );
        logger.error('queue.drain.poison', {
          retryOfKind: originalKind,
          companyName,
          clientSlug: slug,
          enqueuedAt: head.enqueuedAt,
          attempts: head.attempts + 1,
          error: msg,
        });
        notifier.fire(
          'queue_poison',
          'VCFO Sync: batch rejected by server',
          `A queued ${originalKind} batch for "${companyName}" (${clientName}) was permanently rejected by the server. Check the log for details.`,
          { urgent: true, bypassCooldown: true, logCtx: { retryOfKind: originalKind, companyName, clientSlug: slug } },
        );
      }
    }
  }
}

async function runSync(): Promise<SyncResult> {
  if (syncInFlight) {
    logger.warn('sync.skipped', { reason: 'already_in_flight' });
    // Gentle no-op: don't stack syncs if one is already running.
    return lastSync ?? {
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      ok: false,
      rowsSent: 0,
      error: 'A sync is already in progress',
    };
  }
  syncInFlight = true;
  const startedAt = new Date().toISOString();
  const steps: SyncStepLog[] = [];
  const counts = { rowsSent: 0, anyFailure: false };
  logger.info('sync.start', {
    startedAt,
    clientCount: config.clients.length,
    clientSlugs: config.clients.map((c) => c.slug),
    serverUrl: config.serverUrl,
    queueSizeBefore: offlineQueue.size(),
  });

  try {
    // 1) Preflight: Tally + at-least-one-client
    const tally = await pingTally();
    if (!tally.reachable) {
      lastSync = buildResult(startedAt, false, 0, `Tally not reachable: ${tally.error}`, steps);
      return finishSync(lastSync);
    }
    if (config.clients.length === 0) {
      lastSync = buildResult(startedAt, false, 0, 'Agent not configured — link at least one client', steps);
      return finishSync(lastSync);
    }

    const discovered = (tally.companies || []).map((c) => c.name);
    if (discovered.length === 0) {
      lastSync = buildResult(startedAt, false, 0, 'No company open in Tally', steps);
      return finishSync(lastSync);
    }

    // 2) Drain the offline retry queue BEFORE fresh extraction. Each queued
    //    payload carries a clientSlug so the drainer routes it to the right
    //    per-client ApiClient. Idempotent server-side ingest makes this safe
    //    even if the fresh extract below re-pushes overlapping rows.
    await drainQueue(steps, counts);

    const conn = new TallyConnector({ host: config.tallyHost, port: config.tallyPort });
    // Upper bound of this run's window. Undefined syncToDate = run up to today
    // (legacy behaviour). An explicit syncToDate pins a closed window — used
    // when the operator picks a finished FY from the period dropdown.
    const toDate = config.syncToDate || todayIso();
    let firstWindowFrom: string | undefined;

    // 3) Per-client sync. Each client gets its own ApiClient (its own agent
    //    key), its own target whitelist, and its own cursor map. Failure in
    //    one client doesn't abort the others — we just tag the step as
    //    failed and continue so a broken tenant doesn't starve the rest.
    for (const client of config.clients) {
      const clientApi = new ApiClient(config.serverUrl, client.agentKey);
      const { targets, skipped } = resolveSyncTargets(discovered, client.tallyCompanyNames);

      // Record the informational "skipped" step before proceeding — a
      // whitelisted company not currently loaded in Tally is a warning,
      // not a failure. anyFailure stays false for these so the overall
      // run can still succeed.
      if (skipped.length > 0) {
        steps.push({
          company: skipped.join(', '),
          clientSlug: client.slug,
          clientName: client.name,
          kind: 'skipped',
          rowsSent: 0,
          rowsAccepted: 0,
          ok: true,
          error: `Skipped ${skipped.length} selected compan${skipped.length === 1 ? 'y' : 'ies'} not loaded in Tally`,
          durationMs: 0,
        });
      }

      if (targets.length === 0) {
        // Nothing for this client this tick. Still continue — other clients
        // may have loaded companies. Record a note so the log isn't silent
        // about "why did X do nothing".
        if (skipped.length === 0) {
          steps.push({
            company: '(none)',
            clientSlug: client.slug,
            clientName: client.name,
            kind: 'skipped',
            rowsSent: 0,
            rowsAccepted: 0,
            ok: true,
            error: (client.tallyCompanyNames && client.tallyCompanyNames.length > 0)
              ? 'Whitelist has no companies currently loaded in Tally'
              : 'No target companies selected and no companies loaded in Tally',
            durationMs: 0,
          });
        }
        continue;
      }

      // 3a) Companies master — filtered to this client's targets so tenants
      //     don't see other tenants' company lists in their /companies table.
      await runStep('companies', targets[0], client, steps, counts, async () => {
        const allRows = await extractCompanies(conn);
        const rows = allRows.filter((r) => targets.includes(r.name));
        if (rows.length === 0) return { sent: 0, accepted: 0 };
        const res = await tryPush(clientApi, { kind: 'companies', clientSlug: client.slug, rows });
        return { sent: rows.length, accepted: res.rowsAccepted };
      });

      // 3b) Per-company loop — ledgers, groups, vouchers, stockSummary.
      for (const companyName of targets) {
        await runStep('ledgers', companyName, client, steps, counts, async () => {
          const rows = await extractLedgers(conn, companyName);
          if (rows.length === 0) return { sent: 0, accepted: 0 };
          const res = await tryPush(clientApi, { kind: 'ledgers', companyName, clientSlug: client.slug, rows });
          return { sent: rows.length, accepted: res.rowsAccepted };
        });

        // Groups (chart-of-accounts). Small, static, cheap — safe to re-sync
        // every tick. Lets the dashboard map ledgers → BS/PL buckets with
        // Tally's authoritative classification instead of guessing from names.
        await runStep('groups', companyName, client, steps, counts, async () => {
          const rows = await extractGroups(conn, companyName);
          if (rows.length === 0) return { sent: 0, accepted: 0 };
          const res = await tryPush(clientApi, { kind: 'groups', companyName, clientSlug: client.slug, rows });
          return { sent: rows.length, accepted: res.rowsAccepted };
        });

        // Vouchers — per-client per-company cursor window, clamped to the
        // operator-selected period.
        //   windowFrom  = config.syncFromDate (period lower bound)
        //   toDate      = config.syncToDate || today (period upper bound)
        //   voucherFrom = max(cursor, windowFrom) so we never re-pull below
        //                 the selected period when the operator has widened
        //                 the range.
        const windowFrom = config.syncFromDate || defaultSyncFromDate();
        const cursor = client.lastSyncedByCompany?.[companyName];
        const voucherFrom = cursor && cursor > windowFrom ? cursor : windowFrom;
        if (!firstWindowFrom) firstWindowFrom = voucherFrom;

        let voucherStepOk = false;
        if (voucherFrom > toDate) {
          // Cursor has already advanced past the selected upper bound —
          // operator shrunk the window (e.g. from "current FY to today" down
          // to a finished historical FY). Skip vouchers with an explicit note
          // rather than silently pulling 0 rows; force-resync reopens the
          // window on demand.
          steps.push({
            company: companyName,
            clientSlug: client.slug,
            clientName: client.name,
            kind: 'skipped',
            rowsSent: 0,
            rowsAccepted: 0,
            ok: true,
            error: `Skipped vouchers: cursor ${cursor} is past sync window end ${toDate}. Force-resync to re-pull this company.`,
            durationMs: 0,
          });
        } else {
          await runStep('vouchers', companyName, client, steps, counts, async () => {
            const rows = await extractVouchers(conn, companyName, voucherFrom, toDate);
            if (rows.length === 0) { voucherStepOk = true; return { sent: 0, accepted: 0 }; }
            const res = await tryPush(clientApi, { kind: 'vouchers', companyName, clientSlug: client.slug, rows });
            voucherStepOk = true;
            return { sent: rows.length, accepted: res.rowsAccepted };
          });
        }

        // Stock summary — chunked into Indian FY quarters by the extractor.
        // Window: ALWAYS syncFromDate→today (not the voucher cursor). Stock
        // is a cumulative, point-in-time metric — asking Tally for just the
        // last day's delta would produce single-row "period = today/today"
        // entries that the dashboard's `MAX(period_to)` query would pick as
        // the entire stock picture.
        const stockFrom = config.syncFromDate || defaultSyncFromDate();
        await runStep('stockSummary', companyName, client, steps, counts, async () => {
          const rows = await extractStockSummary(conn, companyName, stockFrom, toDate);
          if (rows.length === 0) return { sent: 0, accepted: 0 };
          const res = await tryPush(clientApi, { kind: 'stockSummary', companyName, clientSlug: client.slug, rows });
          return { sent: rows.length, accepted: res.rowsAccepted };
        });

        // Trial balance — primary data source for every VCFO financial report
        // (TB / P&L / BS / CF all derive from vcfo_trial_balance). Same window
        // as stockSummary (syncFromDate → today), same quarter-chunking, same
        // "never advance the cursor based on this step" policy: TB is
        // point-in-time and must always reflect the full requested span.
        await runStep('trialBalance', companyName, client, steps, counts, async () => {
          const rows = await extractTrialBalance(conn, companyName, stockFrom, toDate);
          if (rows.length === 0) return { sent: 0, accepted: 0 };
          const res = await tryPush(clientApi, { kind: 'trialBalance', companyName, clientSlug: client.slug, rows });
          return { sent: rows.length, accepted: res.rowsAccepted };
        });

        // Advance THIS client's cursor for this company only on voucher success.
        // Deliberately keyed to vouchers, not stock — a stock failure shouldn't
        // re-fetch vouchers next time, and a voucher failure shouldn't commit
        // the window as synced. Applies to a fresh config snapshot so we don't
        // race with concurrent config:update IPCs.
        if (voucherStepOk) {
          config = {
            ...config,
            clients: config.clients.map((c) =>
              c.slug === client.slug
                ? {
                    ...c,
                    lastSyncedByCompany: {
                      ...(c.lastSyncedByCompany || {}),
                      [companyName]: toDate,
                    },
                  }
                : c,
            ),
          };
          saveConfig(config);
        }
      }
    }

    // 4) Aggregate per-client summaries from the step list for the result.
    const perClient: SyncClientSummary[] = config.clients.map((c) => {
      const ownSteps = steps.filter((s) => s.clientSlug === c.slug);
      const rows = ownSteps.reduce((n, s) => n + (s.rowsAccepted || 0), 0);
      const ok = ownSteps.every((s) => s.ok);
      const companies = Array.from(new Set(
        ownSteps
          .filter((s) => s.ok && s.kind !== 'skipped' && s.kind !== 'retry' && s.company && s.company !== '(none)' && s.company !== '(masters)')
          .map((s) => s.company),
      ));
      const firstFail = ownSteps.find((s) => !s.ok);
      return {
        clientSlug: c.slug,
        clientName: c.name,
        rowsSent: rows,
        ok,
        error: firstFail?.error,
        companies,
      };
    });

    // Build a top-line summary that makes sense for 1 or N clients. Single-
    // client runs keep the legacy "CompanyName" / "N companies" shape.
    const totalCompanies = new Set(perClient.flatMap((p) => p.companies)).size;
    const clientCount = config.clients.length;
    let companySummary: string;
    if (clientCount === 1) {
      companySummary = totalCompanies === 1 ? perClient[0].companies[0] : `${totalCompanies} companies`;
    } else {
      companySummary = `${totalCompanies} compan${totalCompanies === 1 ? 'y' : 'ies'} across ${clientCount} clients`;
    }

    lastSync = buildResult(
      startedAt,
      !counts.anyFailure,
      counts.rowsSent,
      counts.anyFailure ? 'One or more steps failed — see details' : undefined,
      steps,
      companySummary,
      firstWindowFrom,
      toDate,
      perClient,
    );
    return finishSync(lastSync);
  } catch (err: any) {
    lastSync = buildResult(startedAt, false, counts.rowsSent, err?.message || 'unknown_error', steps);
    return finishSync(lastSync);
  } finally {
    syncInFlight = false;
  }
}

async function runStep(
  kind: SyncStepLog['kind'],
  company: string,
  client: AgentClient,
  steps: SyncStepLog[],
  counts: { rowsSent: number; anyFailure: boolean },
  fn: () => Promise<{ sent: number; accepted: number }>,
): Promise<void> {
  const t0 = Date.now();
  try {
    const { sent, accepted } = await fn();
    const durationMs = Date.now() - t0;
    pushStep(
      {
        company,
        clientSlug: client.slug,
        clientName: client.name,
        kind,
        rowsSent: sent,
        rowsAccepted: accepted,
        ok: true,
        durationMs,
      },
      steps, counts,
    );
    logger.info('sync.step.ok', { kind, company, clientSlug: client.slug, rowsSent: sent, rowsAccepted: accepted, durationMs });
  } catch (err: any) {
    const durationMs = Date.now() - t0;
    const errMsg = err?.message || 'unknown_error';
    pushStep(
      {
        company,
        clientSlug: client.slug,
        clientName: client.name,
        kind,
        rowsSent: 0,
        rowsAccepted: 0,
        ok: false,
        error: errMsg,
        durationMs,
      },
      steps, counts,
    );
    logger.warn('sync.step.fail', { kind, company, clientSlug: client.slug, durationMs, error: errMsg });
  }
}

function buildResult(
  startedAt: string,
  ok: boolean,
  rowsSent: number,
  error: string | undefined,
  steps: SyncStepLog[],
  company?: string,
  windowFrom?: string,
  windowTo?: string,
  perClient?: SyncClientSummary[],
): SyncResult {
  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    ok,
    rowsSent,
    error,
    steps,
    company,
    windowFrom,
    windowTo,
    perClient,
  };
}

function finishSync(result: SyncResult): SyncResult {
  // Capture the previous run BEFORE we push the new one, so we can detect
  // transitions (ok → fail or fail → ok) for the OS notifier.
  const prev = syncHistory[syncHistory.length - 1] ?? null;

  syncHistory.push(result);
  if (syncHistory.length > SYNC_HISTORY_MAX) {
    syncHistory = syncHistory.slice(-SYNC_HISTORY_MAX);
  }
  saveSyncHistory();
  pushStatus();

  const durationMs = new Date(result.finishedAt).getTime() - new Date(result.startedAt).getTime();
  const logPayload: Record<string, unknown> = {
    ok: result.ok,
    rowsSent: result.rowsSent,
    durationMs,
    stepCount: result.steps?.length ?? 0,
    queueSizeAfter: offlineQueue.size(),
    company: result.company,
  };
  if (result.error) logPayload.error = result.error;
  if (result.ok) logger.info('sync.finish', logPayload);
  else           logger.warn('sync.finish', logPayload);

  // Transition-based notifications. We deliberately don't notify on every
  // successful sync (too noisy at 5-min intervals) — only on state changes
  // the user would care about.
  if (!result.ok && (prev === null || prev.ok)) {
    // Fresh failure: last state was ok (or we have no history).
    notifier.fire(
      'sync_fail',
      'VCFO Sync failed',
      result.error || 'One or more steps failed — see the Log tab for details.',
      { urgent: true, logCtx: { prevOk: prev?.ok ?? null } },
    );
  } else if (result.ok && prev && !prev.ok) {
    // Recovery: previous run failed, this one worked. Bypass cooldown so
    // the user always hears the good news even if a sync_fail just fired.
    notifier.fire(
      'sync_recovered',
      'VCFO Sync restored',
      `Sync is working again (${result.rowsSent} rows this run).`,
      { bypassCooldown: true, logCtx: { rowsSent: result.rowsSent } },
    );
  }

  return result;
}

function restartScheduler() {
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
  if (!config.autoSyncEnabled) {
    logger.info('scheduler.stop', { reason: 'autoSyncEnabled=false' });
    return;
  }
  const ms = Math.max(1, config.syncIntervalMinutes) * 60 * 1000;
  syncTimer = setInterval(() => { runSync().catch((e) => logError(e, 'scheduler.tick')); }, ms);
  logger.info('scheduler.start', { intervalMinutes: config.syncIntervalMinutes });
}

// ── Auto-start on login ─────────────────────────────────────────────────────
function applyLoginItemSetting(enabled: boolean) {
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      openAsHidden: true, // start silently in the tray, no window
      // args for auto-launch; empty on dev (Electron launches the dir)
      args: DEV ? [] : undefined,
    });
    logger.info('loginItem.apply', { enabled });
  } catch (err) { logError(err, 'applyLoginItemSetting'); }
}

// ── IPC → renderer pushes ───────────────────────────────────────────────────
async function getStatus() {
  const [tally, server] = await Promise.all([pingTally(), pingServer()]);
  return {
    tally,
    server,
    lastSync,
    config: redactConfig(config),
    // Surface the offline-queue depth so the renderer can show a "N batches
    // queued for retry" indicator. 0 = nothing pending.
    queueSize: offlineQueue.size(),
  };
}

function redactConfig(c: AgentConfig): AgentConfig {
  // Don't leak the agent-keys to the renderer. Each client's key is replaced
  // with a last-4 preview so the UI can still show which entry it's looking
  // at without ever having the plaintext.
  return {
    ...c,
    clients: c.clients.map((client) => ({
      ...client,
      agentKey: client.agentKey ? `••••${client.agentKey.slice(-4)}` : '',
    })),
  };
}

async function pushStatus() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const s = await getStatus();
    mainWindow.webContents.send('status:update', s);
  } catch (err) { logError(err, 'pushStatus'); }
}

// ── IPC handlers ────────────────────────────────────────────────────────────
ipcMain.handle('status:get', () => getStatus());

ipcMain.handle('sync:run', () => runSync());

ipcMain.handle('sync:history', () => syncHistory.slice(-SYNC_HISTORY_MAX).reverse());

/**
 * Cursor-reset IPC. Scopes:
 *   • No args → wipe every cursor on every linked client.
 *   • { clientSlug } → wipe every cursor on ONE client.
 *   • { clientSlug, companyName } → wipe ONE cursor on ONE client.
 *
 * Legacy call sites pass a bare companyName string (from pre-Slice-3 preload).
 * We treat that as "wipe this company across ALL clients" so the existing
 * SettingsView "Reset cursors" button keeps working unchanged.
 */
ipcMain.handle('sync:clearCursor', (_e, arg?: string | { clientSlug?: string; companyName?: string }) => {
  const legacyCompany = typeof arg === 'string' ? arg : undefined;
  const scoped = (arg && typeof arg === 'object') ? arg : undefined;
  const targetSlug = scoped?.clientSlug;
  const targetCompany = scoped?.companyName ?? legacyCompany;

  config = {
    ...config,
    clients: config.clients.map((c) => {
      if (targetSlug && c.slug !== targetSlug) return c;
      const cursors = { ...(c.lastSyncedByCompany || {}) };
      if (targetCompany) {
        delete cursors[targetCompany];
      } else {
        // No company specified → wipe everything on this client.
        for (const k of Object.keys(cursors)) delete cursors[k];
      }
      return { ...c, lastSyncedByCompany: cursors };
    }),
  };
  saveConfig(config);
  logger.info('cursor.clear', {
    clientSlug: targetSlug || '(all)',
    companyName: targetCompany || '(all)',
  });
  pushStatus();
  return redactConfig(config);
});

ipcMain.handle('config:update', (_e, patch: Partial<AgentConfig>) => {
  // Slice 3: clients are managed through dedicated IPCs (chooseClient /
  // removeClient / updateClientCompanies). If the renderer tries to patch
  // the clients array via this channel, we ignore it — preventing the
  // Settings form from accidentally clobbering the minted agent-keys with
  // their redacted previews. Top-level fields (tallyHost, port, serverUrl,
  // scheduler, notifications, etc.) go through as normal.
  const { clients: _droppedClients, ...safePatch } = patch as any;
  void _droppedClients;
  const prevAutoStart = config.autoStartOnLogin ?? false;
  const prevNotifications = config.notificationsEnabled !== false;
  config = { ...config, ...safePatch };
  saveConfig(config);
  const patchedKeys = Object.keys(safePatch);
  logger.info('config.update', {
    patchedKeys,
    autoSyncEnabled: config.autoSyncEnabled,
    syncIntervalMinutes: config.syncIntervalMinutes,
    serverUrl: config.serverUrl,
    clientCount: config.clients.length,
    notificationsEnabled: config.notificationsEnabled !== false,
  });
  restartScheduler();
  rebuildTrayMenu();
  if ((config.autoStartOnLogin ?? false) !== prevAutoStart) {
    applyLoginItemSetting(config.autoStartOnLogin ?? false);
  }
  // User just re-enabled notifications → clear stale cooldowns so the next
  // real event surfaces immediately rather than being suppressed by a
  // timestamp from the previous enabled session.
  const nowNotifications = config.notificationsEnabled !== false;
  if (nowNotifications && !prevNotifications) notifier.resetCooldown();
  pushStatus();
  return redactConfig(config);
});

ipcMain.handle('tally:test', () => pingTally());

// Queue diagnostics / escape hatches. `queue:snapshot` returns the list of
// pending items (for a future UI panel). `queue:clear` wipes the queue —
// useful if a poisoned batch somehow slipped through retryable classification
// and is blocking legitimate replays. Dropping queued batches is safe because
// the next fresh sync will re-extract and re-push the same windows.
ipcMain.handle('queue:snapshot', () => offlineQueue.snapshot().map((it) => ({
  kind: it.payload.kind,
  companyName: it.payload.companyName,
  rowCount: Array.isArray(it.payload.rows) ? it.payload.rows.length : 0,
  enqueuedAt: it.enqueuedAt,
  attempts: it.attempts,
  lastError: it.lastError,
})));

ipcMain.handle('queue:clear', () => {
  const n = offlineQueue.clear();
  logger.warn('queue.clear', { droppedCount: n });
  pushStatus();
  return n;
});

// Logs — open the log folder in the OS file manager, or tail the active file.
// Useful for users to share an agent.log when reporting a sync issue.
ipcMain.handle('logs:openFolder', async () => {
  try {
    if (!fs.existsSync(LOG_DIR())) fs.mkdirSync(LOG_DIR(), { recursive: true });
  } catch (err) { logError(err, 'logs.openFolder.mkdir'); }
  const res = await shell.openPath(LOG_DIR());
  // shell.openPath returns '' on success, an error message on failure.
  return { ok: res === '', error: res || undefined, path: LOG_DIR() };
});

ipcMain.handle('logs:tail', (_e, n?: number) => {
  const count = Math.min(500, Math.max(1, n ?? 100));
  return logger.tail(count);
});

// ── Auth (Slice 1 of team-member login flow) ────────────────────────────────
// These handlers manage the RAM-only Bearer token from /api/auth/login. They
// deliberately do NOT persist — on app restart the user logs in again. A
// minted per-client agent-key (Slice 2) is what survives restarts for ingest.

ipcMain.handle('auth:login', async (_e, args: { username: string; password: string }): Promise<LoginResult> => {
  const username = (args?.username || '').trim();
  const password = args?.password || '';
  if (!username || !password) {
    return { ok: false, error: 'Username and password are required.' };
  }
  const client = new AuthClient(config.serverUrl);
  try {
    const resp = await client.login(username, password);
    authToken = resp.token;
    authUser = toAuthUser(resp);
    logger.info('auth.login.ok', {
      username: authUser.username,
      userType: authUser.userType,
      isOwner: authUser.isOwner === true,
      assignedClientCount: authUser.assignedClientCount ?? null,
    });
    pushStatus();
    return { ok: true, user: authUser };
  } catch (err) {
    // Distinguish "wrong creds / rate-limited / server rejection" (HTTP status)
    // from "can't reach server" (network error). The renderer shows either
    // directly to the user.
    if (err instanceof AuthHttpError) {
      logger.warn('auth.login.fail', { username, status: err.status, reason: err.message });
      return { ok: false, error: err.message };
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('auth.login.error', { username, error: msg });
    return { ok: false, error: `Cannot reach server: ${msg}` };
  }
});

ipcMain.handle('auth:logout', () => {
  if (authUser) logger.info('auth.logout', { username: authUser.username });
  authToken = null;
  authUser = null;
  pushStatus();
  return { ok: true };
});

ipcMain.handle('auth:getState', (): AuthState => ({
  loggedIn: authToken !== null && authUser !== null,
  user: authUser,
}));

// ── Slice 2/3: client picker + per-client management ──────────────────────
// After login the agent fetches the list of clients this team member can
// sync for, and mints an agent-key for each one they link. Minted keys are
// appended to config.clients[] — the sync loop iterates that list per tick
// and authenticates each batch with the matching per-client Bearer key.
//
// All auth:* handlers are no-ops if the user isn't signed in — the renderer
// is expected to gate them behind authReady && authUser.

ipcMain.handle('auth:myClients', async (): Promise<MyClientsResult> => {
  if (!authToken) return { ok: false, error: 'Not signed in' };
  const client = new AuthClient(config.serverUrl);
  try {
    const clients = await client.getMyClients(authToken);
    logger.info('auth.myClients.ok', { count: clients.length });
    return { ok: true, clients };
  } catch (err) {
    if (err instanceof AuthHttpError) {
      logger.warn('auth.myClients.fail', { status: err.status, reason: err.message });
      // 401 means the token expired — drop RAM auth so the renderer re-logins.
      if (err.status === 401) { authToken = null; authUser = null; pushStatus(); }
      return { ok: false, error: err.message };
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('auth.myClients.error', { error: msg });
    return { ok: false, error: `Cannot reach server: ${msg}` };
  }
});

/**
 * Link a new client to this agent install — or re-mint a fresh key for one
 * that's already linked (upsert). The new plaintext agent-key is persisted
 * to config.clients[] and the redacted entry is returned to the renderer.
 *
 * Multi-client (Slice 3): calling this with a slug that's already in the
 * list will REPLACE that entry's agentKey with the fresh mint (useful for
 * recovering from revoked/rotated keys). Other clients stay untouched.
 */
ipcMain.handle('auth:chooseClient', async (_e, args: { clientSlug: string }): Promise<ChooseClientResult> => {
  const slug = String(args?.clientSlug || '').trim().toLowerCase();
  if (!authToken) return { ok: false, error: 'Not signed in' };
  if (!slug) return { ok: false, error: 'Client slug is required' };

  const client = new AuthClient(config.serverUrl);
  try {
    const minted = await client.mintAgentKey(
      authToken,
      slug,
      // Label encodes who minted and from where — shows up in the admin UI's
      // "last_used" view so we can track which agent install owns the key.
      `sync-agent: ${authUser?.username || 'unknown'}`,
    );

    // Find existing entry (re-mint case) so we can preserve its Tally
    // company whitelist + cursor history. Fresh links start with empty
    // whitelist (= sync all companies currently open in Tally).
    const existing = config.clients.find((c) => c.slug === minted.clientSlug);
    const nextEntry: AgentClient = {
      slug: minted.clientSlug,
      name: minted.clientName || existing?.name || minted.clientSlug,
      agentKey: minted.apiKey,
      agentKeyPrefix: minted.prefix,
      tallyCompanyNames: existing?.tallyCompanyNames ?? [],
      lastSyncedByCompany: existing?.lastSyncedByCompany ?? {},
      linkedAt: new Date().toISOString(),
    };

    const nextClients = existing
      ? config.clients.map((c) => (c.slug === minted.clientSlug ? nextEntry : c))
      : [...config.clients, nextEntry];

    config = { ...config, clients: nextClients };
    saveConfig(config);
    logger.info('auth.chooseClient.ok', {
      clientSlug: minted.clientSlug,
      clientName: minted.clientName,
      prefix: minted.prefix,
      linkedClientCount: nextClients.length,
      reMint: Boolean(existing),
    });
    pushStatus();

    return {
      ok: true,
      client: { ...nextEntry, agentKey: `••••${nextEntry.agentKey.slice(-4)}` }, // redacted for renderer
      clientSlug: minted.clientSlug,
      clientName: minted.clientName,
    };
  } catch (err) {
    if (err instanceof AuthHttpError) {
      logger.warn('auth.chooseClient.fail', { clientSlug: slug, status: err.status, reason: err.message });
      if (err.status === 401) { authToken = null; authUser = null; pushStatus(); }
      return { ok: false, error: err.message };
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('auth.chooseClient.error', { clientSlug: slug, error: msg });
    return { ok: false, error: `Cannot reach server: ${msg}` };
  }
});

/**
 * Unlink a single client — drops the entry from config.clients[]. The
 * server-side agent-key stays live (audit trail) and can be revoked from
 * the admin UI if desired. Returns the updated list.
 *
 * Special case: passing no slug (or an empty one) unlinks EVERY client —
 * equivalent to the old "clearClient" behaviour from Slice 2 when the user
 * hit "Change client" on the single-tenant shell.
 */
ipcMain.handle('auth:removeClient', async (_e, args?: { clientSlug?: string }): Promise<RemoveClientResult> => {
  const slug = String(args?.clientSlug || '').trim().toLowerCase();
  const before = config.clients.length;
  if (!slug) {
    config = { ...config, clients: [] };
  } else {
    config = { ...config, clients: config.clients.filter((c) => c.slug !== slug) };
  }
  const after = config.clients.length;
  saveConfig(config);
  logger.info('auth.removeClient', {
    clientSlug: slug || '(all)',
    removedCount: before - after,
    linkedClientCount: after,
  });
  pushStatus();
  return {
    ok: true,
    clients: redactConfig(config).clients,
  };
});

/**
 * Back-compat shim so pre-Slice-3 preload.clearClient() calls still work.
 * Equivalent to calling auth:removeClient with no slug (unlink everything).
 */
ipcMain.handle('auth:clearClient', async (): Promise<AgentConfig> => {
  config = { ...config, clients: [] };
  saveConfig(config);
  logger.info('auth.clearClient');
  pushStatus();
  return redactConfig(config);
});

// ── Slice 4: per-company Tally → (branch, stream) mapping ─────────────────
//
// Settings UI calls these four handlers when the user opens a client's
// per-company panel. Each wraps a new /api/auth/clients/:slug/... endpoint
// and shares the same 401-drops-auth pattern as auth:myClients above.
//
// The result envelope is `{ ok, error?, data? }` so the renderer can show
// inline errors on dropdown save failures without having to re-throw.

type StructureResult = { ok: true; structure: ClientStructure } | { ok: false; error: string };
type MappingsResult = { ok: true; mappings: CompanyMapping[] } | { ok: false; error: string };
type SetMappingResult = { ok: true; mapping: CompanyMapping } | { ok: false; error: string };
type RemoveMappingResult = { ok: true } | { ok: false; error: string };

ipcMain.handle('auth:getClientStructure', async (_e, slug: string): Promise<StructureResult> => {
  if (!authToken) return { ok: false, error: 'Not signed in' };
  const s = String(slug || '').trim().toLowerCase();
  if (!s) return { ok: false, error: 'clientSlug is required' };
  const client = new AuthClient(config.serverUrl);
  try {
    const structure = await client.getClientStructure(authToken, s);
    return { ok: true, structure };
  } catch (err) {
    if (err instanceof AuthHttpError) {
      logger.warn('auth.getClientStructure.fail', { clientSlug: s, status: err.status, reason: err.message });
      if (err.status === 401) { authToken = null; authUser = null; pushStatus(); }
      return { ok: false, error: err.message };
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('auth.getClientStructure.error', { clientSlug: s, error: msg });
    return { ok: false, error: `Cannot reach server: ${msg}` };
  }
});

ipcMain.handle('auth:getCompanyMappings', async (_e, slug: string): Promise<MappingsResult> => {
  if (!authToken) return { ok: false, error: 'Not signed in' };
  const s = String(slug || '').trim().toLowerCase();
  if (!s) return { ok: false, error: 'clientSlug is required' };
  const client = new AuthClient(config.serverUrl);
  try {
    const mappings = await client.getCompanyMappings(authToken, s);
    return { ok: true, mappings };
  } catch (err) {
    if (err instanceof AuthHttpError) {
      logger.warn('auth.getCompanyMappings.fail', { clientSlug: s, status: err.status, reason: err.message });
      if (err.status === 401) { authToken = null; authUser = null; pushStatus(); }
      return { ok: false, error: err.message };
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('auth.getCompanyMappings.error', { clientSlug: s, error: msg });
    return { ok: false, error: `Cannot reach server: ${msg}` };
  }
});

ipcMain.handle(
  'auth:setCompanyMapping',
  async (
    _e,
    args: { clientSlug: string; companyName: string; branchId: number | null; streamId: number | null },
  ): Promise<SetMappingResult> => {
    if (!authToken) return { ok: false, error: 'Not signed in' };
    const slug = String(args?.clientSlug || '').trim().toLowerCase();
    const companyName = String(args?.companyName || '').trim();
    if (!slug) return { ok: false, error: 'clientSlug is required' };
    if (!companyName) return { ok: false, error: 'companyName is required' };
    const branchId =
      args.branchId === null || args.branchId === undefined ? null : Number(args.branchId);
    const streamId =
      args.streamId === null || args.streamId === undefined ? null : Number(args.streamId);

    const client = new AuthClient(config.serverUrl);
    try {
      const mapping = await client.setCompanyMapping(authToken, slug, companyName, branchId, streamId);
      logger.info('auth.setCompanyMapping.ok', {
        clientSlug: slug,
        companyName,
        branchId,
        streamId,
      });
      return { ok: true, mapping };
    } catch (err) {
      if (err instanceof AuthHttpError) {
        logger.warn('auth.setCompanyMapping.fail', {
          clientSlug: slug,
          companyName,
          status: err.status,
          reason: err.message,
        });
        if (err.status === 401) { authToken = null; authUser = null; pushStatus(); }
        return { ok: false, error: err.message };
      }
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('auth.setCompanyMapping.error', { clientSlug: slug, companyName, error: msg });
      return { ok: false, error: `Cannot reach server: ${msg}` };
    }
  },
);

ipcMain.handle(
  'auth:removeCompanyMapping',
  async (_e, args: { clientSlug: string; companyName: string }): Promise<RemoveMappingResult> => {
    if (!authToken) return { ok: false, error: 'Not signed in' };
    const slug = String(args?.clientSlug || '').trim().toLowerCase();
    const companyName = String(args?.companyName || '').trim();
    if (!slug) return { ok: false, error: 'clientSlug is required' };
    if (!companyName) return { ok: false, error: 'companyName is required' };

    const client = new AuthClient(config.serverUrl);
    try {
      await client.removeCompanyMapping(authToken, slug, companyName);
      logger.info('auth.removeCompanyMapping.ok', { clientSlug: slug, companyName });
      return { ok: true };
    } catch (err) {
      if (err instanceof AuthHttpError) {
        logger.warn('auth.removeCompanyMapping.fail', {
          clientSlug: slug,
          companyName,
          status: err.status,
          reason: err.message,
        });
        if (err.status === 401) { authToken = null; authUser = null; pushStatus(); }
        return { ok: false, error: err.message };
      }
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('auth.removeCompanyMapping.error', { clientSlug: slug, companyName, error: msg });
      return { ok: false, error: `Cannot reach server: ${msg}` };
    }
  },
);

/**
 * Update a single client's per-tenant Tally company whitelist. The Settings
 * UI calls this per client when the user ticks/unticks companies. Empty
 * array = "sync every company currently open in Tally" (back-compat).
 */
ipcMain.handle('config:updateClientCompanies', async (_e, args: { clientSlug: string; tallyCompanyNames: string[] }): Promise<AgentConfig> => {
  const slug = String(args?.clientSlug || '').trim().toLowerCase();
  const names = Array.isArray(args?.tallyCompanyNames) ? args.tallyCompanyNames.map(String) : [];
  if (!slug) {
    logger.warn('config.updateClientCompanies.ignored', { reason: 'missing_slug' });
    return redactConfig(config);
  }
  if (!config.clients.some((c) => c.slug === slug)) {
    logger.warn('config.updateClientCompanies.ignored', { reason: 'unknown_slug', clientSlug: slug });
    return redactConfig(config);
  }
  config = {
    ...config,
    clients: config.clients.map((c) =>
      c.slug === slug ? { ...c, tallyCompanyNames: names } : c,
    ),
  };
  saveConfig(config);
  logger.info('config.updateClientCompanies', {
    clientSlug: slug,
    companyCount: names.length,
  });
  pushStatus();
  return redactConfig(config);
});

// ── Lifecycle ───────────────────────────────────────────────────────────────
function logError(err: unknown, where?: string) {
  // Route everything through the structured logger. `where` is a short tag
  // (e.g. "saveSyncHistory", "pushStatus") so we can grep by call site.
  logger.error(where || 'unhandled', errCtx(err));
}

// Single-instance: double-clicking the tray shouldn't spawn another agent.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());

  app.whenReady().then(() => {
    logger.info('app.ready');
    createTray();
    createMainWindow();
    restartScheduler();
    // Keep OS login-item state in sync with config on every launch.
    applyLoginItemSetting(config.autoStartOnLogin ?? false);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });

  app.on('before-quit', () => {
    (app as any).isQuitting = true;
    logger.info('app.beforeQuit');
  });

  // Keep running when the main window is closed — tray is the real app.
  // Electron's 'window-all-closed' typings are arg-less; we rely on NOT
  // calling app.quit() here to keep the process alive (default behaviour
  // only quits on non-macOS when no listener is attached).
  app.on('window-all-closed', () => {
    // intentional no-op: tray keeps the agent alive
  });
}
