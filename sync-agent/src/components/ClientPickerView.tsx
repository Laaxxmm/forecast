import { useEffect, useMemo, useState } from 'react';
import type { AgentClient, MyClient } from '../../lib/types';

interface Props {
  /**
   * Display name of the signed-in user — shown in the subheader so the user
   * knows which account is about to bind this agent install.
   */
  userDisplayName: string;
  /**
   * Currently linked clients from status.config.clients. Redacted keys — the
   * renderer never sees plaintext. Used to drive the "already linked" list
   * and to compute the "available" list (all minus linked).
   */
  linkedClients: AgentClient[];
  /**
   * True when the user can dismiss without linking anything (they opened
   * this from the main shell). False during startup — at least one link
   * is required to exit.
   */
  canDismiss: boolean;
  /** Close the picker overlay (no-op in startup mode — App drives the gate). */
  onDone: () => void;
}

/**
 * Multi-client link/unlink surface.
 *
 * This is both the startup gate (shown when config.clients is empty after
 * login) AND the "manage clients" overlay when re-opened from the shell. In
 * either mode it fetches /api/auth/my-clients on mount, partitions into
 * "already linked" vs "available", and lets the user link/unlink rows one
 * at a time. Each link mints a fresh agent-key on the server; each unlink
 * drops the local entry (server-side key stays alive for audit).
 *
 * Slice 3 deliberately keeps this one-click-per-row rather than a multi-
 * select batch — simpler error surface (per-row status), no surprising
 * partial-failure states.
 */
export default function ClientPickerView({ userDisplayName, linkedClients, canDismiss, onDone }: Props) {
  const [available, setAvailable] = useState<MyClient[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Slug that's currently being mutated (link OR unlink) so buttons can spinner. */
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ slug: string; message: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.vcfo.getMyClients()
      .then((r) => {
        if (cancelled) return;
        if (r.ok && r.clients) {
          setAvailable(r.clients);
        } else {
          setLoadError(r.error || 'Failed to load clients');
          setAvailable([]);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
        setAvailable([]);
      });
    return () => { cancelled = true; };
  }, []);

  // Partition available into "not yet linked" (rendered in the picker list)
  // vs. "already linked" (rendered in the linked section). The union of
  // linkedClients' slugs and availableClients' slugs covers everything the
  // current user has access to; entries in linkedClients that aren't in
  // available (e.g. legacy-migrated clients the user lost access to) still
  // render in the linked section so they can be unlinked cleanly.
  const linkedSlugs = useMemo(() => new Set(linkedClients.map((c) => c.slug)), [linkedClients]);
  const unlinked = useMemo(
    () => (available || []).filter((c) => !linkedSlugs.has(c.slug)),
    [available, linkedSlugs],
  );

  const handleLink = async (clientSlug: string) => {
    if (busySlug) return;
    setBusySlug(clientSlug);
    setRowError(null);
    try {
      const result = await window.vcfo.chooseClient(clientSlug);
      if (!result.ok) {
        setRowError({ slug: clientSlug, message: result.error || 'Failed to link this client' });
      }
      // On ok: status:update pushes back from main → linkedClients prop
      // updates → this client moves from "unlinked" to "linked" on re-render.
    } catch (err) {
      setRowError({ slug: clientSlug, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusySlug(null);
    }
  };

  const handleUnlink = async (clientSlug: string) => {
    if (busySlug) return;
    setBusySlug(clientSlug);
    setRowError(null);
    try {
      const result = await window.vcfo.removeClient(clientSlug);
      if (!result.ok) {
        setRowError({ slug: clientSlug, message: result.error || 'Failed to unlink this client' });
      }
    } catch (err) {
      setRowError({ slug: clientSlug, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusySlug(null);
    }
  };

  const hasAnyLinked = linkedClients.length > 0;
  const canContinue = hasAnyLinked; // at least one link to exit startup mode

  return (
    <div className="card client-picker-card">
      <h2 className="login-title">
        {hasAnyLinked ? 'Manage linked clients' : 'Choose a client'}
      </h2>
      <p className="login-subtitle">
        Signed in as <strong>{userDisplayName}</strong>. Link the client(s) this agent
        should sync for — we'll generate a connection key for each automatically.
      </p>

      {/* Linked section — always rendered when there's at least one. */}
      {hasAnyLinked && (
        <>
          <div className="client-picker-section-title">Linked ({linkedClients.length})</div>
          <ul className="client-picker-list">
            {linkedClients.map((c) => {
              const isBusy = busySlug === c.slug;
              return (
                <li key={c.slug} className="client-picker-item client-picker-item-linked">
                  <div className="client-picker-item-main">
                    <div className="client-picker-name">{c.name}</div>
                    <div className="client-picker-slug">
                      {c.slug}
                      {c.agentKeyPrefix && (
                        <span className="client-picker-keytag" title="Agent key prefix">
                          {' · '}{c.agentKeyPrefix}…
                        </span>
                      )}
                    </div>
                  </div>
                  <button
                    className="btn btn-secondary btn-inline"
                    disabled={busySlug !== null}
                    onClick={() => handleUnlink(c.slug)}
                    title="Remove this agent-key binding from this install"
                  >
                    {isBusy ? 'Unlinking…' : 'Unlink'}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {/* Available section — only rendered once the my-clients fetch returns. */}
      {available === null && (
        <div className="client-picker-loading">Loading your clients…</div>
      )}

      {available !== null && loadError && (
        <div className="login-error" role="alert">{loadError}</div>
      )}

      {available !== null && !loadError && unlinked.length === 0 && !hasAnyLinked && (
        <div className="client-picker-empty">
          No clients are assigned to your account yet. Ask an owner to assign you
          in the admin console, then return here.
        </div>
      )}

      {available !== null && unlinked.length > 0 && (
        <>
          <div className="client-picker-section-title">
            {hasAnyLinked ? 'Link another' : 'Available'}
          </div>
          <ul className="client-picker-list">
            {unlinked.map((c) => {
              const isBusy = busySlug === c.slug;
              return (
                <li key={c.id} className="client-picker-item">
                  <div className="client-picker-item-main">
                    <div className="client-picker-name">{c.name}</div>
                    <div className="client-picker-slug">{c.slug}</div>
                  </div>
                  <button
                    className="btn btn-primary btn-inline"
                    disabled={busySlug !== null}
                    onClick={() => handleLink(c.slug)}
                  >
                    {isBusy ? 'Linking…' : 'Link'}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {rowError && (
        <div className="login-error" role="alert">
          {rowError.slug}: {rowError.message}
        </div>
      )}

      <div className="btn-row client-picker-actions">
        <button
          className="btn btn-primary"
          disabled={!canContinue}
          onClick={onDone}
          title={canContinue ? undefined : 'Link at least one client to continue'}
        >
          {canDismiss ? 'Done' : canContinue ? 'Continue' : 'Link a client to continue'}
        </button>
        {canDismiss && !canContinue && (
          <button className="btn btn-secondary" onClick={onDone}>
            Close
          </button>
        )}
      </div>
    </div>
  );
}
