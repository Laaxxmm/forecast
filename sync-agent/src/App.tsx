import { useEffect, useState } from 'react';
import type { AgentConfig, AgentStatus, AuthUser } from '../lib/types';
import StatusView from './components/StatusView';
import SettingsView from './components/SettingsView';
import LogView from './components/LogView';
import LoginView from './components/LoginView';
import ClientPickerView from './components/ClientPickerView';

type Tab = 'status' | 'log' | 'settings';

export default function App() {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [tab, setTab] = useState<Tab>('status');
  const [syncing, setSyncing] = useState(false);
  // Slice 3: "manage clients" overlay. Starts false. Users can re-open the
  // picker from the auth-strip once they already have clients linked, to
  // add/remove more. Implicitly true while config.clients is empty — the
  // picker is the landing screen after login in that case.
  const [managingClients, setManagingClients] = useState(false);

  // Auth (Slice 1). `null` = we haven't asked main yet; user=null+authReady=true
  // means "not logged in → show LoginView"; user set = logged-in shell.
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authReady, setAuthReady] = useState(false);

  useEffect(() => {
    // Initial fetch + subscribe to pushed updates
    window.vcfo.getStatus().then(setStatus).catch(console.error);
    const unsub = window.vcfo.onStatus(setStatus);

    // Auth bootstrap: ask main whether a token is already in RAM (e.g. user
    // logged in earlier this session and the renderer just reloaded).
    window.vcfo.getAuthState()
      .then((s) => { setAuthUser(s.user); })
      .catch(console.error)
      .finally(() => { setAuthReady(true); });

    return () => unsub();
  }, []);

  const handleSync = async () => {
    setSyncing(true);
    try {
      await window.vcfo.runSync();
    } finally {
      setSyncing(false);
    }
  };

  const handleSaveSettings = async (patch: Partial<AgentConfig>) => {
    await window.vcfo.updateConfig(patch);
    // Status pushes back automatically after config update.
  };

  const handleResetCursor = async (arg?: string | { clientSlug?: string; companyName?: string }) => {
    await window.vcfo.clearSyncCursor(arg);
  };

  const handleLogout = async () => {
    await window.vcfo.logout();
    setAuthUser(null);
    // Drop back to Status tab + close any manage-clients overlay so the
    // next login lands on a sensible screen.
    setTab('status');
    setManagingClients(false);
  };

  // Hold the first paint until we know whether the user is logged in — avoids
  // a brief LoginView flash when main already has a live token.
  if (!authReady) return <div className="app" />;

  // Not logged in → show the login card only. We still want the header so
  // the user sees which product they're in.
  if (!authUser) {
    return (
      <div className="app">
        <header className="app-header">
          <div className="app-logo">TV</div>
          <div>
            <div className="app-title">VCFO Sync</div>
            <div className="app-subtitle">Tally → Cloud agent</div>
          </div>
        </header>
        <LoginView
          serverUrl={status?.config.serverUrl || '(loading…)'}
          onLogin={setAuthUser}
          onChangeServer={async (url) => { await window.vcfo.updateConfig({ serverUrl: url }); }}
        />
      </div>
    );
  }

  // Between login and the main shell we require AT LEAST ONE client to be
  // linked. Linked = an entry present in config.clients. Unlike Slice 2
  // which gated on a single apiKey string, the Slice 3 gate watches the
  // list length so users can link several before entering the main shell.
  const linkedClients = status?.config.clients || [];
  const hasClientSelected = linkedClients.length > 0;
  const canShowShell = !!status;
  const showPicker = canShowShell && (!hasClientSelected || managingClients);

  if (showPicker) {
    return (
      <div className="app">
        <header className="app-header">
          <div className="app-logo">TV</div>
          <div>
            <div className="app-title">VCFO Sync</div>
            <div className="app-subtitle">Tally → Cloud agent</div>
          </div>
        </header>

        <div className="auth-strip">
          <div className="auth-user">
            <span>Signed in as</span>
            <span className="auth-user-name">{authUser.displayName || authUser.username}</span>
            {authUser.isOwner && <span className="auth-user-badge">Owner</span>}
          </div>
          <button className="link-btn" onClick={handleLogout}>Sign out</button>
        </div>

        <ClientPickerView
          userDisplayName={authUser.displayName || authUser.username}
          linkedClients={linkedClients}
          // In startup mode (no linked clients yet) the user must link at
          // least one to exit. In manage mode (opened from shell) the user
          // can unlink all and still dismiss — the gate above will flip
          // them back into startup mode automatically if they do.
          canDismiss={hasClientSelected}
          onDone={() => setManagingClients(false)}
        />
      </div>
    );
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-logo">TV</div>
        <div>
          <div className="app-title">VCFO Sync</div>
          <div className="app-subtitle">Tally → Cloud agent</div>
        </div>
      </header>

      <div className="auth-strip">
        <div className="auth-user">
          <span>Signed in as</span>
          <span className="auth-user-name">{authUser.displayName || authUser.username}</span>
          {authUser.isOwner && <span className="auth-user-badge">Owner</span>}
        </div>
        <div className="auth-strip-actions">
          <button
            className="link-btn"
            onClick={() => setManagingClients(true)}
            title="Add or remove clients this agent syncs for"
          >
            {linkedClients.length === 1 ? 'Change client' : `Manage clients (${linkedClients.length})`}
          </button>
          <button className="link-btn" onClick={handleLogout}>Sign out</button>
        </div>
      </div>

      <div className="tab-strip">
        <button
          className={`tab-btn ${tab === 'status' ? 'active' : ''}`}
          onClick={() => setTab('status')}
        >Status</button>
        <button
          className={`tab-btn ${tab === 'log' ? 'active' : ''}`}
          onClick={() => setTab('log')}
        >Sync log</button>
        <button
          className={`tab-btn ${tab === 'settings' ? 'active' : ''}`}
          onClick={() => setTab('settings')}
        >Settings</button>
      </div>

      {tab === 'status' && (
        <StatusView status={status} syncing={syncing} onSync={handleSync} />
      )}
      {tab === 'log' && <LogView />}
      {tab === 'settings' && status && (
        <SettingsView
          config={status.config}
          discoveredCompanies={(status.tally.companies || []).map((c) => c.name)}
          tallyReachable={status.tally.reachable}
          onSave={handleSaveSettings}
          onResetCursor={handleResetCursor}
          onOpenClientManager={() => setManagingClients(true)}
        />
      )}
    </div>
  );
}
