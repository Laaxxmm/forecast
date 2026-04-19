import { useEffect, useRef, useState } from 'react';
import type {
  AgentClient,
  AgentConfig,
  ClientStructure,
  CompanyMapping,
} from '../../lib/types';

interface Props {
  config: AgentConfig;
  /** Names of the companies currently loaded in Tally, live from ping. */
  discoveredCompanies: string[];
  /** Only used to show a helpful hint when Tally is offline. */
  tallyReachable: boolean;
  /** Partial patch of top-level config fields (tallyHost/port, serverUrl, etc). */
  onSave: (patch: Partial<AgentConfig>) => Promise<void>;
  /**
   * Reset voucher cursor(s). Accepts three scopes:
   *   • no arg → wipe every cursor on every linked client
   *   • { clientSlug } → wipe every cursor on ONE client
   *   • { clientSlug, companyName } → wipe ONE cursor on ONE client
   */
  onResetCursor?: (arg?: string | { clientSlug?: string; companyName?: string }) => Promise<void>;
  /** Open the "Manage clients" picker overlay from Settings. */
  onOpenClientManager: () => void;
}

/** Local state shape: per-client caches of structure + mapping list. */
type StructureMap = Record<string, ClientStructure | undefined>;
type MappingsMap = Record<string, Record<string, CompanyMapping> | undefined>;
type LoadErrMap = Record<string, string | undefined>;
type RowErrMap = Record<string, string | undefined>; // key: `${slug}::${companyName}`

// ── Sync-period helpers ─────────────────────────────────────────────────────
// A syncFromDate/syncToDate pair is interpreted by the UI as one of four
// presets. The data model only knows about the two raw dates; these helpers
// keep the dropdown label in lock-step with whatever the operator (or a prior
// session) saved, and turn preset clicks back into date patches.
//
// Indian financial year: runs Apr 1 → Mar 31. If today's month is Jan–Mar,
// the "current" FY started in the previous calendar year.

type PresetKey = 'current' | 'custom' | `fy-${number}`;

function currentFyStartYear(): number {
  const now = new Date();
  return now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
}

function inferPreset(fromDate: string | undefined, toDate: string | undefined): PresetKey {
  const currentYear = currentFyStartYear();
  const currentFyFrom = `${currentYear}-04-01`;
  if (!toDate) {
    // "No upper bound" means sync-up-to-today — our "Current FY, to today"
    // preset. Map any from that looks like Apr 1 YYYY to 'current' if the
    // year matches the live FY; otherwise surface it as custom so operators
    // see the raw dates rather than being told a stale label.
    if (!fromDate || fromDate === currentFyFrom) return 'current';
    return 'custom';
  }
  // A closed FY preset writes fromDate = YYYY-04-01, toDate = (YYYY+1)-03-31.
  const fromMatch = /^(\d{4})-04-01$/.exec(fromDate || '');
  const toMatch = /^(\d{4})-03-31$/.exec(toDate);
  if (fromMatch && toMatch && Number(toMatch[1]) === Number(fromMatch[1]) + 1) {
    return `fy-${Number(fromMatch[1])}`;
  }
  return 'custom';
}

function fyLabel(year: number): string {
  // "FY 25-26" — two-digit years on both sides, no leading "20".
  const a = String(year).slice(2);
  const b = String(year + 1).slice(2);
  return `FY ${a}-${b}`;
}

function fmtIsoDate(iso: string | undefined, fallback: string): string {
  if (!iso) return fallback;
  // Render as the host locale's short date. Tolerant of malformed input —
  // fall back to the raw string so we never throw inside render.
  try {
    const d = new Date(iso + 'T00:00:00');
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return iso;
  }
}

/**
 * Slice 4 Settings view.
 *
 * Top-level fields (Tally host/port, serverUrl, scheduler, notifications,
 * syncFromDate) are edited on a form + "Save settings" button — same
 * dirty-tracking pattern as before so the auto-pushed config doesn't
 * clobber in-progress edits.
 *
 * Per-client Tally company mapping (Slice 4) is rendered as a grid below
 * with one row per company:
 *
 *   ☑ <company name>  | Branch ▾  | Stream ▾  | Force resync
 *
 * Dropdown changes auto-save via `setCompanyMapping` (optimistic update +
 * revert on error). The sync checkbox remains `tallyCompanyNames[]` per
 * client; it's orthogonal to mapping (a company can be mapped-but-not-
 * synced or synced-but-not-mapped). Force-resync reuses the pre-existing
 * `clearSyncCursor({clientSlug, companyName})` handler.
 */
export default function SettingsView({
  config,
  discoveredCompanies,
  tallyReachable,
  onSave,
  onResetCursor,
  onOpenClientManager,
}: Props) {
  // Form state only covers top-level fields. Per-client company lists live
  // in config.clients and are mutated directly via IPC (no form dirty
  // tracking needed — toggles are immediate).
  const [form, setForm] = useState<AgentConfig>(config);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [resetting, setResetting] = useState<string | null>(null); // clientSlug, '(all)', or `${slug}::${companyName}`
  // Per-client "refreshing branch/stream catalog" spinner. Tracks one slug at
  // a time because the user triggers it explicitly per card.
  const [refreshing, setRefreshing] = useState<string | null>(null);

  // Slice 4 caches — populated on mount + after successful mapping edits.
  const [structures, setStructures] = useState<StructureMap>({});
  const [mappings, setMappings] = useState<MappingsMap>({});
  const [loadErrors, setLoadErrors] = useState<LoadErrMap>({});
  const [rowErrors, setRowErrors] = useState<RowErrMap>({});

  // "Last-committed" snapshot for dirty tracking on top-level fields only.
  // clients[] intentionally excluded — that path auto-saves so there's
  // nothing to debounce or dirty-check.
  const committedRef = useRef<AgentConfig>(config);

  useEffect(() => {
    if (saving) return;
    // Re-sync ONLY if the user hasn't touched the form since the last
    // committed state. Otherwise we'd silently discard in-progress edits
    // on every auto-sync tick.
    const topLevelDirty = (
      form.tallyHost !== committedRef.current.tallyHost
      || form.tallyPort !== committedRef.current.tallyPort
      || form.serverUrl !== committedRef.current.serverUrl
      || form.syncIntervalMinutes !== committedRef.current.syncIntervalMinutes
      || form.autoSyncEnabled !== committedRef.current.autoSyncEnabled
      || (form.autoStartOnLogin ?? false) !== (committedRef.current.autoStartOnLogin ?? false)
      || (form.notificationsEnabled !== false) !== (committedRef.current.notificationsEnabled !== false)
      || (form.syncFromDate || '') !== (committedRef.current.syncFromDate || '')
      || (form.syncToDate || '') !== (committedRef.current.syncToDate || '')
    );
    if (topLevelDirty) return;
    setForm(config);
    committedRef.current = config;
    // form is deliberately excluded from deps — it's a read-only check
    // that would otherwise re-run on every edit and defeat dirty tracking.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, saving]);

  // ── Slice 4: fetch structure + mappings per linked client ─────────────
  // Runs on mount and whenever the set of linked slugs changes. Uses a
  // joined key so adding a client triggers a fresh fetch but other clients
  // don't re-fetch unnecessarily.
  const clientSlugsKey = config.clients.map((c) => c.slug).sort().join(',');
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const c of config.clients) {
        // Skip clients we already have structure for (avoid refetch on every render).
        if (structures[c.slug] && mappings[c.slug]) continue;
        try {
          const [sres, mres] = await Promise.all([
            window.vcfo.getClientStructure(c.slug),
            window.vcfo.getCompanyMappings(c.slug),
          ]);
          if (cancelled) return;
          if (!sres.ok) {
            setLoadErrors((e) => ({ ...e, [c.slug]: sres.error }));
            continue;
          }
          if (!mres.ok) {
            setLoadErrors((e) => ({ ...e, [c.slug]: mres.error }));
            continue;
          }
          setStructures((s) => ({ ...s, [c.slug]: sres.structure }));
          const map: Record<string, CompanyMapping> = {};
          for (const row of mres.mappings) map[row.tallyCompanyName] = row;
          setMappings((m) => ({ ...m, [c.slug]: map }));
          setLoadErrors((e) => ({ ...e, [c.slug]: undefined }));
        } catch (err) {
          if (cancelled) return;
          const msg = err instanceof Error ? err.message : String(err);
          setLoadErrors((e) => ({ ...e, [c.slug]: msg }));
        }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientSlugsKey]);

  const update = <K extends keyof AgentConfig>(k: K, v: AgentConfig[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const handleSave = async () => {
    setSaving(true);
    try {
      // Only patch top-level fields; clients are managed separately.
      await onSave({
        tallyHost: form.tallyHost,
        tallyPort: form.tallyPort,
        serverUrl: form.serverUrl,
        syncIntervalMinutes: form.syncIntervalMinutes,
        autoSyncEnabled: form.autoSyncEnabled,
        autoStartOnLogin: form.autoStartOnLogin,
        syncFromDate: form.syncFromDate,
        syncToDate: form.syncToDate,
        notificationsEnabled: form.notificationsEnabled,
      });
      committedRef.current = form;
      setSavedAt(Date.now());
    } finally {
      setSaving(false);
    }
  };

  const handleResetAll = async () => {
    if (!onResetCursor) return;
    setResetting('(all)');
    try { await onResetCursor(); } finally { setResetting(null); }
  };

  const handleResetClient = async (clientSlug: string) => {
    if (!onResetCursor) return;
    setResetting(clientSlug);
    try { await onResetCursor({ clientSlug }); } finally { setResetting(null); }
  };

  const handleForceResync = async (clientSlug: string, companyName: string) => {
    if (!onResetCursor) return;
    const ok = window.confirm(
      `Re-sync all data for "${companyName}" on the next run?\n\n` +
      `The current cursor will be cleared and the next sync will pull the full window. ` +
      `Data already synced is merged idempotently — no duplicates.`,
    );
    if (!ok) return;
    const key = `${clientSlug}::${companyName}`;
    setResetting(key);
    try {
      await onResetCursor({ clientSlug, companyName });
    } finally {
      setResetting(null);
    }
  };

  /**
   * Re-fetch the branch/stream catalog and mapping rows for ONE client.
   * Used after the operator creates a new branch in the admin UI — without
   * this they'd have to restart the agent before the dropdown shows the
   * new entries. The mount-effect already covers this on app launch; this
   * button just lets the user trigger it without relaunching.
   *
   * Keeps optimistic edits safe: we only overwrite state after both calls
   * succeed. On failure we surface the error via loadErrors and leave the
   * existing cache untouched.
   */
  const handleRefreshClient = async (clientSlug: string) => {
    setRefreshing(clientSlug);
    try {
      const [sres, mres] = await Promise.all([
        window.vcfo.getClientStructure(clientSlug),
        window.vcfo.getCompanyMappings(clientSlug),
      ]);
      if (!sres.ok) {
        setLoadErrors((e) => ({ ...e, [clientSlug]: sres.error }));
        return;
      }
      if (!mres.ok) {
        setLoadErrors((e) => ({ ...e, [clientSlug]: mres.error }));
        return;
      }
      setStructures((s) => ({ ...s, [clientSlug]: sres.structure }));
      const map: Record<string, CompanyMapping> = {};
      for (const row of mres.mappings) map[row.tallyCompanyName] = row;
      setMappings((m) => ({ ...m, [clientSlug]: map }));
      setLoadErrors((e) => ({ ...e, [clientSlug]: undefined }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLoadErrors((e) => ({ ...e, [clientSlug]: msg }));
    } finally {
      setRefreshing(null);
    }
  };

  const toggleClientCompany = async (client: AgentClient, name: string) => {
    const current = client.tallyCompanyNames || [];
    const next = current.includes(name)
      ? current.filter((n) => n !== name)
      : [...current, name];
    await window.vcfo.updateClientCompanies(client.slug, next);
    // Status push back will update config.clients → this component re-renders.
  };

  /**
   * Optimistic-update mapping dropdown. Applies local state immediately,
   * issues the PUT, then either commits (server row replaces local) or
   * reverts and shows an inline error.
   */
  const updateMapping = async (
    clientSlug: string,
    companyName: string,
    field: 'branchId' | 'streamId',
    nextValue: number | null,
  ) => {
    const clientMap = mappings[clientSlug] || {};
    const existing = clientMap[companyName] || { tallyCompanyName: companyName, branchId: null, streamId: null };
    const optimistic: CompanyMapping = { ...existing, [field]: nextValue };

    // Commit optimistic state.
    setMappings((m) => ({
      ...m,
      [clientSlug]: { ...(m[clientSlug] || {}), [companyName]: optimistic },
    }));
    const rowKey = `${clientSlug}::${companyName}`;
    setRowErrors((e) => ({ ...e, [rowKey]: undefined }));

    const res = await window.vcfo.setCompanyMapping({
      clientSlug,
      companyName,
      branchId: optimistic.branchId,
      streamId: optimistic.streamId,
    });

    if (!res.ok) {
      // Revert.
      setMappings((m) => ({
        ...m,
        [clientSlug]: { ...(m[clientSlug] || {}), [companyName]: existing },
      }));
      setRowErrors((e) => ({ ...e, [rowKey]: res.error }));
      return;
    }

    // Commit server truth (picks up updatedAt, etc).
    setMappings((m) => ({
      ...m,
      [clientSlug]: { ...(m[clientSlug] || {}), [companyName]: res.mapping },
    }));
  };

  // Total cursor count across every client, for the "Reset all cursors" summary.
  const totalCursorCount = (config.clients || []).reduce(
    (n, c) => n + Object.keys(c.lastSyncedByCompany || {}).length,
    0,
  );

  // ── Sync-period controls ────────────────────────────────────────────────
  // The dropdown is a view over the raw {syncFromDate, syncToDate} pair in
  // form state. Picking a preset writes dates; picking "Custom range" leaves
  // existing dates intact but reveals two editable pickers.
  const periodPreset = inferPreset(form.syncFromDate, form.syncToDate);
  const fyStartYear = currentFyStartYear();
  const fyOptions = [fyStartYear, fyStartYear - 1, fyStartYear - 2];

  const applyPeriodPreset = (next: PresetKey) => {
    if (next === 'custom') {
      // If the operator is moving from a preset (syncToDate = undefined or
      // Mar 31) into custom, seed a sensible syncToDate so both pickers
      // render immediately rather than blank. fromDate already exists.
      setForm((f) => ({
        ...f,
        syncFromDate: f.syncFromDate || `${fyStartYear}-04-01`,
        syncToDate: f.syncToDate || new Date().toISOString().slice(0, 10),
      }));
      return;
    }
    if (next === 'current') {
      // "Current FY, to today" — open-ended upper bound; sync loop uses today.
      setForm((f) => ({
        ...f,
        syncFromDate: `${fyStartYear}-04-01`,
        syncToDate: undefined,
      }));
      return;
    }
    // fy-YYYY: closed window pinned to that FY.
    const year = Number(next.slice(3));
    setForm((f) => ({
      ...f,
      syncFromDate: `${year}-04-01`,
      syncToDate: `${year + 1}-03-31`,
    }));
  };

  return (
    <>
      <div className="card">
        <div className="settings-row">
          <label>Tally host</label>
          <input
            value={form.tallyHost}
            onChange={(e) => update('tallyHost', e.target.value)}
            placeholder="localhost"
          />
        </div>
        <div className="settings-row">
          <label>Tally port</label>
          <input
            type="number"
            value={form.tallyPort}
            onChange={(e) => update('tallyPort', Number(e.target.value))}
            placeholder="9000"
          />
        </div>
      </div>

      <div className="card">
        <div className="settings-row">
          <label>Cloud server URL</label>
          <input
            value={form.serverUrl}
            onChange={(e) => update('serverUrl', e.target.value)}
            placeholder="http://localhost:3000"
          />
        </div>
      </div>

      <div className="card">
        <div className="settings-row">
          <label>Auto-sync every</label>
          <select
            value={form.syncIntervalMinutes}
            onChange={(e) => update('syncIntervalMinutes', Number(e.target.value))}
          >
            <option value={1}>1 minute</option>
            <option value={5}>5 minutes</option>
            <option value={15}>15 minutes</option>
            <option value={30}>30 minutes</option>
            <option value={60}>1 hour</option>
          </select>
        </div>
        <div className="settings-row">
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={form.autoSyncEnabled}
              onChange={(e) => update('autoSyncEnabled', e.target.checked)}
            />
            <span>Enable auto-sync</span>
          </label>
        </div>
        <div className="settings-row">
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={!!form.autoStartOnLogin}
              onChange={(e) => update('autoStartOnLogin', e.target.checked)}
            />
            <span>Launch at login (silent, in tray)</span>
          </label>
        </div>
        <div className="settings-row">
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={form.notificationsEnabled !== false}
              onChange={(e) => update('notificationsEnabled', e.target.checked)}
            />
            <span>Show desktop notifications (sync failure &amp; recovery)</span>
          </label>
        </div>
        <div className="settings-row">
          <label>Sync period</label>
          <select
            value={periodPreset}
            onChange={(e) => applyPeriodPreset(e.target.value as PresetKey)}
          >
            <option value="current">Current FY, to today</option>
            {fyOptions.map((yr) => (
              <option key={yr} value={`fy-${yr}`}>
                {fyLabel(yr)}{yr === fyStartYear ? ' (full year)' : ''}
              </option>
            ))}
            <option value="custom">Custom range…</option>
          </select>
        </div>
        {periodPreset === 'custom' ? (
          <>
            <div className="settings-row">
              <label>From</label>
              <input
                type="date"
                value={form.syncFromDate || ''}
                onChange={(e) => update('syncFromDate', e.target.value)}
                max={form.syncToDate || undefined}
              />
            </div>
            <div className="settings-row">
              <label>To</label>
              <input
                type="date"
                value={form.syncToDate || ''}
                onChange={(e) => update('syncToDate', e.target.value)}
                min={form.syncFromDate || undefined}
              />
            </div>
          </>
        ) : (
          <div className="settings-row">
            <span className="period-hint">
              {fmtIsoDate(form.syncFromDate, '—')} → {fmtIsoDate(form.syncToDate, 'today')}
              {periodPreset === 'current' && (
                <em className="period-hint-note"> (upper bound rolls with today on each sync)</em>
              )}
            </span>
          </div>
        )}
      </div>

      {/* ── Per-client Tally mapping ────────────────────────────────────── */}
      <div className="card">
        <div className="settings-row settings-row-header">
          <label>Linked clients ({config.clients.length})</label>
          <button
            className="btn btn-secondary btn-inline"
            onClick={onOpenClientManager}
            type="button"
            title="Link a new client, or unlink an existing one"
          >
            Manage…
          </button>
        </div>

        {config.clients.length === 0 && (
          <div className="client-picker-empty">
            No clients linked yet. Click "Manage…" above to add one.
          </div>
        )}

        {config.clients.map((client) => {
          const selected = client.tallyCompanyNames || [];
          const clientMap = mappings[client.slug] || {};
          const structure = structures[client.slug];
          const loadErr = loadErrors[client.slug];

          // Build the row list: live companies (from Tally) first, then
          // whitelisted-but-not-loaded, then mapped-but-unchecked-unloaded
          // (so a previously mapped company that's no longer in the
          // whitelist and not loaded still surfaces for the operator).
          const liveSet = new Set(discoveredCompanies);
          const whitelistedSet = new Set(selected);
          const mappedNames = Object.keys(clientMap);
          const seen = new Set<string>();
          const allRows: { name: string; live: boolean; whitelisted: boolean; mapped: boolean }[] = [];
          for (const name of discoveredCompanies) {
            if (seen.has(name)) continue;
            seen.add(name);
            allRows.push({ name, live: true, whitelisted: whitelistedSet.has(name), mapped: !!clientMap[name] });
          }
          for (const name of selected) {
            if (seen.has(name)) continue;
            seen.add(name);
            allRows.push({ name, live: liveSet.has(name), whitelisted: true, mapped: !!clientMap[name] });
          }
          for (const name of mappedNames) {
            if (seen.has(name)) continue;
            seen.add(name);
            allRows.push({ name, live: liveSet.has(name), whitelisted: whitelistedSet.has(name), mapped: true });
          }

          const cursorCount = Object.keys(client.lastSyncedByCompany || {}).length;
          const isResetting = resetting === client.slug;
          const isRefreshing = refreshing === client.slug;
          const branchCount = structure?.branches.length ?? 0;
          const streamCount = structure?.streams.length ?? 0;
          return (
            <div key={client.slug} className="client-settings-block">
              <div className="client-settings-head">
                <div>
                  <div className="client-picker-name">{client.name}</div>
                  <div className="client-picker-slug">
                    {client.slug}
                    {client.agentKeyPrefix && (
                      <span className="client-picker-keytag"> · {client.agentKeyPrefix}…</span>
                    )}
                    {structure && (
                      <span className="client-picker-keytag">
                        {' '}· {branchCount} branch{branchCount === 1 ? '' : 'es'}, {streamCount} stream{streamCount === 1 ? '' : 's'}
                      </span>
                    )}
                  </div>
                </div>
                <button
                  className="btn btn-secondary btn-inline"
                  type="button"
                  onClick={() => handleRefreshClient(client.slug)}
                  disabled={isRefreshing}
                  title="Re-fetch branches, streams, and mappings from the server (no app restart needed)"
                >
                  {isRefreshing ? 'Refreshing…' : 'Refresh'}
                </button>
              </div>

              {loadErr && (
                <div className="error-text" title="Failed to load branch/stream catalog or mappings">
                  Could not load mappings: {loadErr}
                </div>
              )}

              <div className="company-picker">
                {allRows.length === 0 ? (
                  <div className="company-empty">
                    {tallyReachable
                      ? 'No companies open in Tally. Open at least one to enable sync.'
                      : 'Tally is offline — open a company in Tally and the list will appear here.'}
                  </div>
                ) : (
                  <>
                    <div className="company-hint">
                      {selected.length === 0
                        ? `Sync every company Tally reports (${discoveredCompanies.length} right now).`
                        : `Only the ${selected.length} checked compan${selected.length === 1 ? 'y' : 'ies'} will sync to this client.`}
                    </div>
                    <div className="mapping-grid" role="list" aria-label="Tally company mapping">
                      {allRows.map((row) => {
                        const checked = selected.includes(row.name) || selected.length === 0;
                        const isSelected = selected.includes(row.name);
                        const mapping = clientMap[row.name];
                        const branchId = mapping?.branchId ?? null;
                        const streamId = mapping?.streamId ?? null;
                        const unmapped = branchId === null || streamId === null;
                        const rowKey = `${client.slug}::${row.name}`;
                        const rowErr = rowErrors[rowKey];
                        const rowResetKey = `${client.slug}::${row.name}`;
                        const rowResetting = resetting === rowResetKey;
                        const companyHasCursor = !!client.lastSyncedByCompany?.[row.name];
                        // Dropdowns disabled when row is unchecked (whitelist excludes
                        // the company) — keeps the UI honest about what will actually
                        // sync. Saved mapping stays in the DB for when it's re-enabled.
                        const disabled = selected.length > 0 && !isSelected;
                        return (
                          <div
                            key={row.name}
                            className={`mapping-grid-row ${disabled ? 'mapping-row-disabled' : ''}`}
                            role="listitem"
                          >
                            <div className="mapping-cell mapping-cell-name">
                              <label className="checkbox-row">
                                <input
                                  type="checkbox"
                                  checked={isSelected || (selected.length === 0 && row.live)}
                                  // When whitelist is empty every live company is
                                  // implicitly synced — ticking doesn't change anything
                                  // except the UI hint. So only expose the real toggle
                                  // when we're in explicit-whitelist mode OR the user
                                  // explicitly toggles something (flips us to explicit).
                                  onChange={() => toggleClientCompany(client, row.name)}
                                />
                                <span className="company-name" title={row.name}>{row.name}</span>
                              </label>
                              <div className="mapping-badges">
                                {!row.live && (
                                  <span className="company-badge" title="Not currently loaded in Tally">
                                    not loaded
                                  </span>
                                )}
                                {unmapped && (
                                  <span className="company-badge company-badge-warn" title="No branch or stream assigned — data will sync but won't be attributed">
                                    unmapped
                                  </span>
                                )}
                              </div>
                            </div>
                            <div className="mapping-controls">
                              <div className="mapping-cell">
                                <select
                                  value={branchId ?? ''}
                                  disabled={disabled || !structure}
                                  onChange={(e) => {
                                    const v = e.target.value;
                                    updateMapping(client.slug, row.name, 'branchId', v === '' ? null : Number(v));
                                  }}
                                  aria-label={`Branch for ${row.name}`}
                                >
                                  <option value="">— branch —</option>
                                  {structure?.branches.map((b) => (
                                    <option key={b.id} value={b.id}>
                                      {b.name}{b.city ? ` · ${b.city}` : ''}
                                    </option>
                                  ))}
                                </select>
                              </div>
                              <div className="mapping-cell">
                                <select
                                  value={streamId ?? ''}
                                  disabled={disabled || !structure}
                                  onChange={(e) => {
                                    const v = e.target.value;
                                    updateMapping(client.slug, row.name, 'streamId', v === '' ? null : Number(v));
                                  }}
                                  aria-label={`Stream for ${row.name}`}
                                >
                                  <option value="">— stream —</option>
                                  {structure?.streams.map((s) => (
                                    <option key={s.id} value={s.id}>{s.name}</option>
                                  ))}
                                </select>
                              </div>
                            </div>
                            <div className="mapping-cell mapping-cell-actions">
                              <button
                                className="btn btn-secondary btn-inline"
                                type="button"
                                disabled={rowResetting || !companyHasCursor}
                                onClick={() => handleForceResync(client.slug, row.name)}
                                title={
                                  companyHasCursor
                                    ? 'Clear this company\'s cursor so the next sync pulls the full window'
                                    : 'No cursor yet — nothing to reset'
                                }
                              >
                                {rowResetting ? 'Clearing…' : 'Force resync'}
                              </button>
                            </div>
                            {rowErr && (
                              <div className="mapping-row-error">
                                {rowErr}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>

              <div className="cursor-row">
                <span className="status-detail">
                  {cursorCount === 0
                    ? 'No cursor saved — next sync scans the full window.'
                    : `Tracking ${cursorCount} compan${cursorCount === 1 ? 'y' : 'ies'}.`}
                </span>
                <button
                  className="btn btn-secondary btn-inline"
                  onClick={() => handleResetClient(client.slug)}
                  disabled={isResetting || cursorCount === 0}
                  type="button"
                >
                  {isResetting ? 'Resetting…' : 'Reset cursors'}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {config.clients.length > 1 && (
        <div className="card">
          <div className="settings-row">
            <label>Reset all cursors</label>
            <div className="cursor-row">
              <span className="status-detail">
                {totalCursorCount === 0
                  ? 'No cursors saved across any client.'
                  : `Tracking ${totalCursorCount} company cursor${totalCursorCount === 1 ? '' : 's'} across all linked clients.`}
              </span>
              <button
                className="btn btn-secondary btn-inline"
                onClick={handleResetAll}
                disabled={resetting === '(all)' || totalCursorCount === 0}
                type="button"
              >
                {resetting === '(all)' ? 'Resetting…' : 'Reset all'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="btn-row">
        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : savedAt && Date.now() - savedAt < 2000 ? 'Saved ✓' : 'Save settings'}
        </button>
      </div>
    </>
  );
}
