import { useEffect, useState } from 'react';
import type { AuthUser } from '../../lib/types';

interface Props {
  /** Base URL being used — shown so the user sees where they're authenticating. */
  serverUrl: string;
  /** Called with the authenticated user after a successful login. */
  onLogin: (user: AuthUser) => void;
  /**
   * Persist a new serverUrl. Used by the inline "change server" editor — the
   * user must be able to flip localhost ↔ production BEFORE signing in,
   * otherwise the first login hits the wrong database and mints an agent-key
   * against the wrong tenant. Wired to `window.vcfo.updateConfig` from App.
   */
  onChangeServer: (url: string) => Promise<void>;
}

/**
 * Full-screen login gate for the sync-agent. Shown whenever the main process
 * has no valid user token in RAM (first launch, after logout, after restart).
 *
 * Slice 1 scope: just proves the login pipe works end-to-end. Later slices
 * will replace the "paste an agent key in Settings" flow with a client picker
 * reached after this form.
 */
export default function LoginView({ serverUrl, onLogin, onChangeServer }: Props) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Inline server-URL editor — collapsed by default so the login form stays
  // visually clean; the operator taps "change" to reveal the input.
  const [editingServer, setEditingServer] = useState(false);
  const [serverDraft, setServerDraft] = useState(serverUrl);
  const [savingServer, setSavingServer] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  // Sync the draft whenever the prop refreshes (e.g. after a successful save
  // pushes a new status). Without this, reopening the editor would show the
  // old pre-save value.
  useEffect(() => {
    if (!editingServer) setServerDraft(serverUrl);
  }, [serverUrl, editingServer]);

  const canSubmit = username.trim().length > 0 && password.length > 0 && !submitting && !editingServer;

  /**
   * Minimal URL guard — must be http:// or https:// and have a host part.
   * We don't verify reachability here; if the URL is wrong, the login call
   * will fail with a clear transport error and the user can correct it.
   */
  const validateServerUrl = (raw: string): string | null => {
    const v = raw.trim().replace(/\/+$/, '');
    if (!v) return 'Server URL cannot be blank.';
    if (!/^https?:\/\//i.test(v)) return 'URL must start with http:// or https://';
    try {
      const u = new URL(v);
      if (!u.host) return 'URL is missing a host.';
    } catch {
      return 'That doesn\'t look like a valid URL.';
    }
    return null;
  };

  const handleSaveServer = async () => {
    const trimmed = serverDraft.trim().replace(/\/+$/, '');
    const err = validateServerUrl(trimmed);
    if (err) { setServerError(err); return; }
    setServerError(null);
    setSavingServer(true);
    try {
      await onChangeServer(trimmed);
      setServerDraft(trimmed);
      setEditingServer(false);
      // Clear any stale transport error from the prior URL — the next login
      // attempt is a clean slate.
      setError(null);
    } catch (e) {
      setServerError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingServer(false);
    }
  };

  const handleCancelServer = () => {
    setServerDraft(serverUrl);
    setServerError(null);
    setEditingServer(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await window.vcfo.login(username.trim(), password);
      if (result.ok && result.user) {
        onLogin(result.user);
      } else {
        setError(result.error || 'Login failed.');
      }
    } catch (err) {
      // This catches IPC transport failures (should be rare); HTTP + network
      // errors are already reported through LoginResult.error.
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="card login-card">
      <h2 className="login-title">Sign in</h2>
      <p className="login-subtitle">
        Use your team-member credentials to connect this agent to your assigned clients.
      </p>

      <form onSubmit={handleSubmit}>
        <div className="settings-row">
          <label htmlFor="login-username">Username</label>
          <input
            id="login-username"
            autoComplete="username"
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={submitting}
            placeholder="e.g. teamadmin"
          />
        </div>
        <div className="settings-row">
          <label htmlFor="login-password">Password</label>
          <input
            id="login-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={submitting}
            placeholder="••••••••"
          />
        </div>

        {error && <div className="login-error" role="alert">{error}</div>}

        <div className="btn-row">
          <button
            className="btn btn-primary"
            type="submit"
            disabled={!canSubmit}
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </div>
      </form>

      <div className="login-server">
        {editingServer ? (
          <div className="login-server-edit">
            <label htmlFor="login-server-url">Cloud server URL</label>
            <input
              id="login-server-url"
              type="url"
              value={serverDraft}
              onChange={(e) => setServerDraft(e.target.value)}
              disabled={savingServer}
              placeholder="https://vision.indefine.in"
              autoFocus
            />
            {serverError && <div className="login-error" role="alert">{serverError}</div>}
            <div className="login-server-actions">
              <button
                className="btn btn-primary btn-inline"
                type="button"
                onClick={handleSaveServer}
                disabled={savingServer}
              >
                {savingServer ? 'Saving…' : 'Save'}
              </button>
              <button
                className="btn btn-secondary btn-inline"
                type="button"
                onClick={handleCancelServer}
                disabled={savingServer}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <>
            Server: <code>{serverUrl}</code>
            <button
              className="login-server-change"
              type="button"
              onClick={() => { setServerDraft(serverUrl); setEditingServer(true); }}
              disabled={submitting}
              title="Change the cloud server this agent authenticates against"
            >
              change
            </button>
          </>
        )}
      </div>
    </div>
  );
}
