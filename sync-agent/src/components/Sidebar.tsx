import { useState } from 'react';
import type { AuthUser, AgentClient } from '../../lib/types';

export type Page = 'home' | 'companies' | 'history' | 'settings';

interface Props {
  active: Page;
  onNavigate: (page: Page) => void;
  authUser: AuthUser;
  clients: AgentClient[];
  onManageClients: () => void;
  onLogout: () => void;
}

/**
 * Icon-only collapsing sidebar — expands on hover (or `pinned`) to reveal labels,
 * footer user-card, and Manage / Sign-out actions. Clicking an item switches
 * the page in the parent <App>.
 */
export default function Sidebar({
  active, onNavigate, authUser, clients, onManageClients, onLogout,
}: Props) {
  const [pinned, setPinned] = useState(false);

  const Item = ({
    page, label, icon, badge,
  }: { page: Page; label: string; icon: JSX.Element; badge?: string | number }) => (
    <button
      type="button"
      className={`nav-item ${active === page ? 'active' : ''}`}
      onClick={() => onNavigate(page)}
      title={label}
    >
      <span className="nav-icon">{icon}</span>
      <span className="nav-label">{label}</span>
      {badge != null && badge !== '' && <span className="nav-badge">{badge}</span>}
    </button>
  );

  return (
    <aside className={`sidebar ${pinned ? 'expanded' : ''}`}>
      <div className="sidebar-brand">
        <div className="brand-logo">TV</div>
        <div className="brand-text">
          <div className="brand-name">VCFO Sync</div>
          <div className="brand-version">Tally → Cloud</div>
        </div>
      </div>

      <nav className="sidebar-nav">
        <Item page="home" label="Home" icon={
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
            <path d="M3 12L12 4l9 8M5 10v10h14V10" />
          </svg>
        } />
        <Item page="companies" label="Companies" badge={clients.length > 0 ? clients.length : undefined} icon={
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M9 8h.01M9 12h.01M9 16h.01M14 8h6M14 12h6M14 16h6" />
          </svg>
        } />
        <Item page="history" label="History" icon={
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 3" />
          </svg>
        } />
        <Item page="settings" label="Settings" icon={
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
          </svg>
        } />
      </nav>

      <div className="sidebar-footer">
        <div className="user-card">
          <div className="user-avatar">{(authUser.displayName || authUser.username).charAt(0).toUpperCase()}</div>
          <div className="user-info">
            <div className="user-name">{authUser.displayName || authUser.username}</div>
            <div className="user-tenant" title={clients.map((c) => c.name).join(', ') || 'No clients linked'}>
              {clients.length === 0 ? 'No client linked' : clients.length === 1 ? clients[0].name : `${clients.length} clients`}
            </div>
          </div>
        </div>
        <button className="manage-btn" onClick={onManageClients} title="Add or remove clients">
          {clients.length === 1 ? 'Change client' : 'Manage clients'}
        </button>
        <button className="signout-btn" onClick={onLogout}>Sign out</button>
        <button
          className="manage-btn"
          onClick={() => setPinned((p) => !p)}
          title={pinned ? 'Unpin sidebar' : 'Keep sidebar open'}
          style={{ fontSize: 10 }}
        >
          {pinned ? '⇤ Unpin' : '⇥ Pin'}
        </button>
      </div>
    </aside>
  );
}
