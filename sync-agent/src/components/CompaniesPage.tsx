import { useEffect, useState } from 'react';
import type { AgentClient, AgentConfig, ClientStructure, CompanyMapping, TallyCompany } from '../../lib/types';
import ConfirmDialog from './ConfirmDialog';

interface Props {
  config: AgentConfig;
  discoveredCompanies: TallyCompany[];
  tallyReachable: boolean;
  onResetCursor: (arg?: string | { clientSlug?: string; companyName?: string }) => Promise<void>;
}

type StructureMap = Record<string, ClientStructure | undefined>;
type MappingsMap = Record<string, Record<string, CompanyMapping> | undefined>;

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

/**
 * Companies page — one card per Tally company with branch + stream mapping
 * and force-resync action. Replaces the cramped grid that lived inside the
 * old SettingsView.
 *
 * Refresh behaviour: re-pings Tally on mount and every 10s while open, so a
 * newly opened Tally company appears within seconds — no sign-out required.
 */
export default function CompaniesPage({
  config, discoveredCompanies, tallyReachable, onResetCursor,
}: Props) {
  const [structures, setStructures] = useState<StructureMap>({});
  const [mappings, setMappings] = useState<MappingsMap>({});
  const [loadErrors, setLoadErrors] = useState<Record<string, string | undefined>>({});
  const [rowErrors, setRowErrors] = useState<Record<string, string | undefined>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [resetting, setResetting] = useState<string | null>(null);
  const [flash, setFlash] = useState<Record<string, string>>({});
  const [confirmState, setConfirmState] = useState<
    | { open: false }
    | { open: true; clientSlug: string; companyName: string }
  >({ open: false });

  const clientSlugsKey = config.clients.map((c) => c.slug).sort().join(',');

  // Load branch/stream catalog + mapping rows for each client.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const c of config.clients) {
        if (structures[c.slug] && mappings[c.slug]) continue;
        try {
          const [sres, mres] = await Promise.all([
            window.vcfo.getClientStructure(c.slug),
            window.vcfo.getCompanyMappings(c.slug),
          ]);
          if (cancelled) return;
          if (!sres.ok) { setLoadErrors((e) => ({ ...e, [c.slug]: sres.error })); continue; }
          if (!mres.ok) { setLoadErrors((e) => ({ ...e, [c.slug]: mres.error })); continue; }
          setStructures((s) => ({ ...s, [c.slug]: sres.structure }));
          const map: Record<string, CompanyMapping> = {};
          for (const row of mres.mappings) map[row.tallyCompanyName] = row;
          setMappings((m) => ({ ...m, [c.slug]: map }));
          setLoadErrors((e) => ({ ...e, [c.slug]: undefined }));
        } catch (err: any) {
          if (cancelled) return;
          setLoadErrors((e) => ({ ...e, [c.slug]: err?.message || String(err) }));
        }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientSlugsKey]);

  // Auto re-ping Tally so newly-opened companies appear without sign-out.
  useEffect(() => {
    window.vcfo.repingTally().catch(() => {});
    const t = setInterval(() => { window.vcfo.repingTally().catch(() => {}); }, 10_000);
    return () => clearInterval(t);
  }, []);

  const handleManualRefresh = async () => {
    setRefreshing(true);
    try {
      await window.vcfo.repingTally();
      // Also refresh per-client structure/mappings.
      for (const c of config.clients) {
        const [sres, mres] = await Promise.all([
          window.vcfo.getClientStructure(c.slug),
          window.vcfo.getCompanyMappings(c.slug),
        ]);
        if (sres.ok) setStructures((s) => ({ ...s, [c.slug]: sres.structure }));
        if (mres.ok) {
          const map: Record<string, CompanyMapping> = {};
          for (const row of mres.mappings) map[row.tallyCompanyName] = row;
          setMappings((m) => ({ ...m, [c.slug]: map }));
        }
      }
    } finally {
      setRefreshing(false);
    }
  };

  const toggleClientCompany = async (client: AgentClient, name: string) => {
    const current = client.tallyCompanyNames || [];
    const next = current.includes(name) ? current.filter((n) => n !== name) : [...current, name];
    await window.vcfo.updateClientCompanies(client.slug, next);
  };

  const updateMapping = async (
    clientSlug: string, companyName: string,
    field: 'branchId' | 'streamId', nextValue: number | null,
  ) => {
    const clientMap = mappings[clientSlug] || {};
    const existing = clientMap[companyName] || { tallyCompanyName: companyName, branchId: null, streamId: null };
    const optimistic: CompanyMapping = { ...existing, [field]: nextValue };
    setMappings((m) => ({ ...m, [clientSlug]: { ...(m[clientSlug] || {}), [companyName]: optimistic } }));
    const rowKey = `${clientSlug}::${companyName}`;
    setRowErrors((e) => ({ ...e, [rowKey]: undefined }));

    const res = await window.vcfo.setCompanyMapping({
      clientSlug, companyName, branchId: optimistic.branchId, streamId: optimistic.streamId,
    });
    if (!res.ok) {
      setMappings((m) => ({ ...m, [clientSlug]: { ...(m[clientSlug] || {}), [companyName]: existing } }));
      setRowErrors((e) => ({ ...e, [rowKey]: res.error }));
      return;
    }
    setMappings((m) => ({ ...m, [clientSlug]: { ...(m[clientSlug] || {}), [companyName]: res.mapping } }));
  };

  const askForceResync = (clientSlug: string, companyName: string) => {
    setConfirmState({ open: true, clientSlug, companyName });
  };

  const performForceResync = async () => {
    if (!confirmState.open) return;
    const { clientSlug, companyName } = confirmState;
    const key = `${clientSlug}::${companyName}`;
    setResetting(key);
    try {
      await onResetCursor({ clientSlug, companyName });
      setFlash((f) => ({ ...f, [key]: 'Cursor cleared — full window pulls on next sync ✓' }));
      setTimeout(() => setFlash((f) => { const next = { ...f }; delete next[key]; return next; }), 3500);
    } finally {
      setResetting(null);
      setConfirmState({ open: false });
    }
  };

  const liveNames = new Set(discoveredCompanies.map((c) => c.name));

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Companies</div>
          <div className="page-subtitle">{discoveredCompanies.length} loaded in Tally</div>
        </div>
        <button className="btn btn-secondary" onClick={handleManualRefresh} disabled={refreshing}>
          {refreshing ? 'Refreshing…' : '⟳ Refresh'}
        </button>
      </div>

      <div className="page-content">
        {config.clients.length === 0 && (
          <div className="card" style={{ textAlign: 'center', color: 'var(--text-faint)', fontSize: 11 }}>
            No clients linked yet. Use the sidebar's "Manage clients" button to link one.
          </div>
        )}

        {config.clients.map((client) => {
          const selected = client.tallyCompanyNames || [];
          const clientMap = mappings[client.slug] || {};
          const structure = structures[client.slug];
          const loadErr = loadErrors[client.slug];

          // Build the row list: live first, then whitelisted-but-not-loaded, then mapped-only.
          const seen = new Set<string>();
          const rows: { name: string; live: boolean }[] = [];
          for (const c of discoveredCompanies) {
            if (seen.has(c.name)) continue;
            seen.add(c.name); rows.push({ name: c.name, live: true });
          }
          for (const name of selected) {
            if (seen.has(name)) continue;
            seen.add(name); rows.push({ name, live: liveNames.has(name) });
          }
          for (const name of Object.keys(clientMap)) {
            if (seen.has(name)) continue;
            seen.add(name); rows.push({ name, live: liveNames.has(name) });
          }

          return (
            <div key={client.slug} className="client-block">
              {config.clients.length > 1 && (
                <div className="client-block-head">
                  <div>
                    <div className="client-block-name">{client.name}</div>
                    <div className="client-block-meta">{client.slug}</div>
                  </div>
                </div>
              )}

              {loadErr && <div className="error-text">Couldn't load mappings: {loadErr}</div>}

              {rows.length === 0 ? (
                <div className="card" style={{ textAlign: 'center', color: 'var(--text-faint)', fontSize: 11 }}>
                  {tallyReachable
                    ? 'No companies open in Tally. Open at least one to enable sync.'
                    : 'Tally is offline. Open Tally and load at least one company.'}
                </div>
              ) : (
                rows.map((row) => {
                  const isSelected = selected.includes(row.name) || selected.length === 0;
                  const enabled = selected.length === 0 || isSelected;
                  const mapping = clientMap[row.name];
                  const branchId = mapping?.branchId ?? null;
                  const streamId = mapping?.streamId ?? null;
                  const unmapped = branchId === null || streamId === null;
                  const rowKey = `${client.slug}::${row.name}`;
                  const rowErr = rowErrors[rowKey];
                  const rowResetting = resetting === rowKey;
                  const cursorPresent = !!client.lastSyncedByCompany?.[row.name];
                  const flashMsg = flash[rowKey];
                  const lastSyncedAt = client.lastSyncedByCompany?.[row.name];

                  return (
                    <div key={row.name} className={`company-card ${!row.live && !isSelected ? 'dim' : ''}`}>
                      <div className="company-card-head">
                        <div
                          className={`checkbox ${isSelected ? 'checked' : ''}`}
                          onClick={() => toggleClientCompany(client, row.name)}
                          role="checkbox"
                          aria-checked={isSelected}
                        >
                          {isSelected ? '✓' : ''}
                        </div>
                        <div className="company-name-block">
                          <div className="company-name" title={row.name}>{row.name}</div>
                          <div className="company-meta">
                            <span className={`pill ${row.live ? 'live' : 'offline'}`}>
                              {row.live ? '● Live' : '○ Not loaded'}
                            </span>
                            {unmapped && enabled && row.live && <span className="pill warn">unmapped</span>}
                            {lastSyncedAt && <span>Last sync {timeAgo(lastSyncedAt)}</span>}
                          </div>
                        </div>
                      </div>
                      <div className="mapping-grid">
                        <div className="mapping-field">
                          <span className="mapping-label">Branch</span>
                          <select
                            className="mapping-select"
                            value={branchId ?? ''}
                            disabled={!enabled || !structure}
                            onChange={(e) => updateMapping(client.slug, row.name, 'branchId', e.target.value === '' ? null : Number(e.target.value))}
                          >
                            <option value="">— branch —</option>
                            {structure?.branches.map((b) => (
                              <option key={b.id} value={b.id}>
                                {b.name}{b.city ? ` · ${b.city}` : ''}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="mapping-field">
                          <span className="mapping-label">Stream</span>
                          <select
                            className="mapping-select"
                            value={streamId ?? ''}
                            disabled={!enabled || !structure}
                            onChange={(e) => updateMapping(client.slug, row.name, 'streamId', e.target.value === '' ? null : Number(e.target.value))}
                          >
                            <option value="">— stream —</option>
                            {structure?.streams.map((s) => (
                              <option key={s.id} value={s.id}>{s.name}</option>
                            ))}
                          </select>
                        </div>
                      </div>
                      <div className="company-card-foot">
                        <span className="last-synced">
                          {cursorPresent && <span className="micro-dot" />}
                          {cursorPresent ? `Cursor: ${client.lastSyncedByCompany?.[row.name]}` : 'No cursor yet'}
                          {flashMsg && <span className="feedback-flash">{flashMsg}</span>}
                        </span>
                        <button
                          className="btn-link"
                          disabled={rowResetting || !cursorPresent}
                          onClick={() => askForceResync(client.slug, row.name)}
                          title={cursorPresent
                            ? 'Clear this company\'s cursor so the next sync pulls the full window'
                            : 'No cursor yet — nothing to reset'}
                        >
                          {rowResetting ? 'Clearing…' : 'Force re-sync'}
                        </button>
                      </div>
                      {rowErr && <div className="row-error">{rowErr}</div>}
                    </div>
                  );
                })
              )}
            </div>
          );
        })}
      </div>

      <ConfirmDialog
        open={confirmState.open}
        title="Force re-sync this company?"
        body={
          confirmState.open ? (
            <>
              The cursor for <b>{confirmState.companyName}</b> will be cleared.
              The next sync will pull the full window from Tally.
              Existing data is merged idempotently — no duplicates.
            </>
          ) : ''
        }
        confirmLabel="Clear cursor"
        busy={resetting !== null}
        onConfirm={performForceResync}
        onCancel={() => setConfirmState({ open: false })}
      />
    </>
  );
}
