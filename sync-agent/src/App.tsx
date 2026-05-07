import { useEffect, useState } from 'react';
import type { AgentConfig, AgentStatus, AuthUser, SyncResult } from '../lib/types';
import LoginView from './components/LoginView';
import ClientPickerView from './components/ClientPickerView';
import Sidebar, { type Page } from './components/Sidebar';
import HomePage from './components/HomePage';
import CompaniesPage from './components/CompaniesPage';
import HistoryPage from './components/HistoryPage';
import SettingsPage from './components/SettingsPage';

/**
 * App shell — top-level state machine:
 *   1. !authReady             → blank holding screen (avoids LoginView flash)
 *   2. !authUser              → LoginView (header + login card)
 *   3. !hasClient || managing → ClientPickerView (link / switch tenants)
 *   4. authenticated + linked → main shell (sidebar + 4 pages)
 *
 * This is the v0.4.0 redesign: a left sidebar with four pages (Home,
 * Companies, History, Settings) replaces the previous top-tabs layout.
 */
export default function App() {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [page, setPage] = useState<Page>('home');
  const [syncing, setSyncing] = useState(false);
  const [recent, setRecent] = useState<SyncResult[]>([]);
  const [managingClients, setManagingClients] = useState(false);

  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authReady, setAuthReady] = useState(false);

  // Initial fetch + status push subscription.
  useEffect(() => {
    window.vcfo.getStatus().then(setStatus).catch(console.error);
    const unsub = window.vcfo.onStatus(setStatus);
    window.vcfo.getAuthState()
      .then((s) => setAuthUser(s.user))
      .catch(console.error)
      .finally(() => setAuthReady(true));
    return () => unsub();
  }, []);

  // Pull sync history into App state so HomePage can show recent activity
  // without each tab switch refetching. Refreshed on every status push.
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      window.vcfo.getSyncHistory().then((h) => { if (!cancelled) setRecent(h); }).catch(() => {});
    };
    refresh();
    const unsub = window.vcfo.onStatus(() => refresh());
    return () => { cancelled = true; unsub(); };
  }, []);

  const handleSync = async () => {
    setSyncing(true);
    try { await window.vcfo.runSync(); } finally { setSyncing(false); }
  };

  const handleSaveSettings = async (patch: Partial<AgentConfig>) => {
    await window.vcfo.updateConfig(patch);
  };

  const handleResetCursor = async (
    arg?: string | { clientSlug?: string; companyName?: string },
  ) => { await window.vcfo.clearSyncCursor(arg); };

  const handleLogout = async () => {
    await window.vcfo.logout();
    setAuthUser(null);
    setPage('home');
    setManagingClients(false);
  };

  // 1. Holding screen.
  if (!authReady) return <div className="app" />;

  // 2. Not logged in.
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

  // 3. Client picker — startup mode (no clients yet) or managing (admin re-opened).
  const linkedClients = status?.config.clients || [];
  const hasClient = linkedClients.length > 0;
  const showPicker = !!status && (!hasClient || managingClients);
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
          canDismiss={hasClient}
          onDone={() => setManagingClients(false)}
        />
      </div>
    );
  }

  // 4. Main shell — sidebar + page.
  if (!status) return <div className="app" />;

  return (
    <div className="app">
      <div className="app-shell">
        <Sidebar
          active={page}
          onNavigate={setPage}
          authUser={authUser}
          clients={linkedClients}
          onManageClients={() => setManagingClients(true)}
          onLogout={handleLogout}
        />
        <main className="main">
          {page === 'home' && (
            <HomePage status={status} syncing={syncing} recent={recent} onSync={handleSync} />
          )}
          {page === 'companies' && (
            <CompaniesPage
              config={status.config}
              discoveredCompanies={status.tally.companies || []}
              tallyReachable={status.tally.reachable}
              onResetCursor={handleResetCursor}
            />
          )}
          {page === 'history' && <HistoryPage />}
          {page === 'settings' && (
            <SettingsPage config={status.config} onSave={handleSaveSettings} />
          )}
        </main>
      </div>
    </div>
  );
}
