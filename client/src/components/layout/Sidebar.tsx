import { useState, useEffect, useRef } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, TrendingUp, Upload, Settings, LogOut, BarChart3, Building2, ArrowLeftRight,
  MapPin, ChevronDown, Sun, Moon, ArrowRight, Activity, PieChart,
  Pin, PinOff, X, Table, CalendarCheck, ClipboardList,
} from 'lucide-react';
import api from '../../api/client';
import { useTheme } from '../../contexts/ThemeContext';
import { canSeeVcfo, canSeeForecast } from '../../utils/roles';

// Forecast & Operations navigation
const forecastLinks = [
  { to: '/actuals', icon: LayoutDashboard, label: 'Actuals', clientAdminOnly: false, requiresModule: '' },
  { to: '/forecast', icon: TrendingUp, label: 'Forecast', clientAdminOnly: false, requiresModule: '' },
  { to: '/analysis', icon: BarChart3, label: 'Analysis', clientAdminOnly: false, requiresModule: 'user_analysis' },
  { to: '/insights', icon: Activity, label: 'Insights', clientAdminOnly: false, requiresModule: 'user_insights' },
  { to: '/revenue-sharing', icon: PieChart, label: 'Rev. Sharing', clientAdminOnly: false, requiresModule: '' },
];

// VCFO module navigation
//   Table View holds the 4 reports under /vcfo, /vcfo/trial-balance, etc.
//   matchPrefix keeps it highlighted across sub-routes; matchExclude prevents
//   the prefix from bleeding into sibling routes like /vcfo/compliances.
const vcfoLinks = [
  { to: '/vcfo', icon: Table, label: 'Table View', clientAdminOnly: false, requiresModule: '', matchPrefix: '/vcfo', matchExclude: ['/vcfo/compliances', '/vcfo/accounting-tasks'] },
  { to: '/vcfo/compliances', icon: CalendarCheck, label: 'Compliances', clientAdminOnly: false, requiresModule: '' },
  { to: '/vcfo/accounting-tasks', icon: ClipboardList, label: 'Accounting Tracker', clientAdminOnly: false, requiresModule: '' },
];

// Utility links — bottom section above logout
const utilityLinks = [
  { to: '/import', icon: Upload, label: 'Import Data', clientAdminOnly: true, module: 'forecast_ops' },
  { to: '/settings', icon: Settings, label: 'Settings', clientAdminOnly: true },
];

interface SidebarProps {
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  pinned: boolean;
  onPinnedChange: (pinned: boolean) => void;
  isMobile: boolean;
  mobileOpen: boolean;
  onMobileClose: () => void;
}

export default function Sidebar({ expanded, onExpandedChange, pinned, onPinnedChange, isMobile, mobileOpen, onMobileClose }: SidebarProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { theme, toggleTheme } = useTheme();
  const userType = localStorage.getItem('user_type');
  const userRole = localStorage.getItem('user_role');
  const clientName = localStorage.getItem('client_name');
  const isMultiBranch = localStorage.getItem('is_multi_branch') === '1';
  const isSuperAdmin = userType === 'super_admin';
  const isClientAdmin = userRole === 'admin';
  const isOwner = localStorage.getItem('is_owner') === '1';

  const [platformLogo, setPlatformLogo] = useState<string | null>(null);
  const [clientLogo, setClientLogo] = useState<string | null>(null);

  const [branches, setBranches] = useState<any[]>([]);
  const [canViewConsolidated, setCanViewConsolidated] = useState(false);
  const [selectedBranchId, setSelectedBranchId] = useState<string>(localStorage.getItem('branch_id') || 'all');
  const [showBranchDropdown, setShowBranchDropdown] = useState(false);
  const branchDropdownRef = useRef<HTMLDivElement>(null);

  // Click-outside handler for branch dropdown
  useEffect(() => {
    if (!showBranchDropdown) return;
    const handleClick = (e: MouseEvent) => {
      if (branchDropdownRef.current && !branchDropdownRef.current.contains(e.target as Node)) {
        setShowBranchDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showBranchDropdown]);

  useEffect(() => {
    // Fetch platform logo
    api.get('/logo').then(res => setPlatformLogo(res.data.platformLogo)).catch(() => {});
  }, []);

  useEffect(() => {
    // Check for client logo
    if (!clientName) return;
    const slug = localStorage.getItem('client_slug');
    if (!slug) return;
    const checkLogo = async () => {
      for (const ext of ['png', 'jpg', 'jpeg', 'svg', 'webp']) {
        const url = `/api/logos/clients/${slug}.${ext}`;
        try {
          const res = await fetch(url, { method: 'HEAD' });
          if (res.ok) { setClientLogo(url); return; }
        } catch {}
      }
    };
    checkLogo();
  }, [clientName]);

  useEffect(() => {
    if (!isMultiBranch || (isSuperAdmin && isOwner)) return;
    api.get('/branches').then(res => {
      if (res.data.isMultiBranch) {
        setBranches(res.data.branches || []);
        setCanViewConsolidated(res.data.canViewConsolidated);
        // Auto-select first branch if none selected
        if (!localStorage.getItem('branch_id') && res.data.branches?.length > 0) {
          const defaultId = String(res.data.branches[0].id);
          setSelectedBranchId(defaultId);
          localStorage.setItem('branch_id', defaultId);
          localStorage.setItem('branch_name', res.data.branches[0].name);
        }
      }
    }).catch(() => {});
  }, [isMultiBranch, isSuperAdmin]);

  const [selectedStreamId, setSelectedStreamId] = useState<string>(localStorage.getItem('stream_id') || 'all');

  const selectBranch = (id: string, name: string) => {
    setSelectedBranchId(id);
    localStorage.setItem('branch_id', id);
    localStorage.setItem('branch_name', name);
    // Reset stream when branch changes
    localStorage.removeItem('stream_id');
    localStorage.removeItem('stream_name');
    setSelectedStreamId('all');
    setShowBranchDropdown(false);
    window.location.reload();
  };

  const selectStream = (id: string, name: string) => {
    setSelectedStreamId(id);
    if (id === 'all') {
      localStorage.removeItem('stream_id');
      localStorage.removeItem('stream_name');
    } else {
      localStorage.setItem('stream_id', id);
      localStorage.setItem('stream_name', name);
    }
    window.location.reload();
  };

  // Get streams for current branch
  const getBranchStreams = (): any[] => {
    const currentBranch = branches.find(b => String(b.id) === selectedBranchId);
    if (currentBranch?.streams) return currentBranch.streams;
    // Fallback to stored streams
    try { return JSON.parse(localStorage.getItem('streams') || '[]'); } catch { return []; }
  };

  const enabledModules: string[] = (() => {
    try { return JSON.parse(localStorage.getItem('enabled_modules') || '[]'); } catch { return []; }
  })();

  // Coerce `active_module` back to forecast_ops when the cached module is one
  // the current role no longer has access to. Happens when an admin switches
  // to a user who was just promoted from `accountant` to `operational_head`,
  // or when the tenant disables the VCFO module mid-session.
  let activeModule = localStorage.getItem('active_module') || 'forecast_ops';
  if (activeModule === 'vcfo_portal' && !canSeeVcfo()) {
    activeModule = 'forecast_ops';
    localStorage.setItem('active_module', 'forecast_ops');
  }
  const mainLinks = activeModule === 'vcfo_portal' ? vcfoLinks : forecastLinks;

  // "Switch Module" link only makes sense when the user can actually reach
  // both modules AND both are live on the tenant. OH never sees it (VCFO-less),
  // accountant sees it only when a tenant runs both Forecast + VCFO.
  const showModuleSwitcher =
    !isSuperAdmin
    && canSeeForecast()
    && canSeeVcfo()
    && enabledModules.includes('forecast_ops')
    && enabledModules.includes('vcfo_portal');
  // Owner super_admin sees nothing (they use Admin Panel only).
  // Non-owner super_admin in client context sees module links like a client admin.
  const isOwnerAdmin = isSuperAdmin && isOwner;
  const visibleMain = isOwnerAdmin ? [] : mainLinks.filter(l => {
    if (!isClientAdmin && !isSuperAdmin && l.clientAdminOnly) return false;
    // Hide Analysis/Insights for regular users when their respective module is disabled
    if (l.requiresModule && !isClientAdmin && !isSuperAdmin && !enabledModules.includes(l.requiresModule)) return false;
    return true;
  });
  const visibleUtility = isOwnerAdmin ? [] : utilityLinks.filter(l => {
    if (!isClientAdmin && !isSuperAdmin && l.clientAdminOnly) return false;
    if ((l as any).module && (l as any).module !== activeModule) return false;
    return true;
  });

  const selectedBranchName = selectedBranchId === 'all'
    ? 'All Branches'
    : branches.find(b => String(b.id) === selectedBranchId)?.name || localStorage.getItem('branch_name') || 'Branch';

  const handleLogout = async () => {
    await api.post('/auth/logout').catch(() => {});
    localStorage.removeItem('auth_token');
    localStorage.removeItem('user_type');
    localStorage.removeItem('user_role');
    localStorage.removeItem('is_owner');
    localStorage.removeItem('client_slug');
    localStorage.removeItem('client_name');
    localStorage.removeItem('is_multi_branch');
    localStorage.removeItem('branch_id');
    localStorage.removeItem('branch_name');
    localStorage.removeItem('stream_id');
    localStorage.removeItem('stream_name');
    localStorage.removeItem('streams');
    localStorage.removeItem('stream_access');
    localStorage.removeItem('enabled_modules');
    localStorage.removeItem('enabled_integrations');
    localStorage.removeItem('active_module');
    window.location.href = '/login';
  };

  const switchClient = () => {
    localStorage.removeItem('client_slug');
    localStorage.removeItem('client_name');
    localStorage.removeItem('is_multi_branch');
    localStorage.removeItem('branch_id');
    localStorage.removeItem('branch_name');
    localStorage.removeItem('stream_id');
    localStorage.removeItem('stream_name');
    localStorage.removeItem('streams');
    localStorage.removeItem('stream_access');
    localStorage.removeItem('enabled_modules');
    localStorage.removeItem('enabled_integrations');
    localStorage.removeItem('active_module');
    navigate('/select-client');
  };

  const w = expanded ? 'w-56' : 'w-16';

  const renderLink = (link: { to: string; icon: any; label: string; matchPrefix?: string; matchExclude?: string[] }) => {
    const { to, icon: Icon, label, matchPrefix, matchExclude } = link;
    const path = location.pathname;
    const customActive = matchPrefix
      ? (path === matchPrefix || path.startsWith(matchPrefix + '/'))
        && !(matchExclude || []).some(ex => path === ex || path.startsWith(ex + '/'))
      : undefined;
    return (
      <NavLink
        key={to}
        to={to}
        end={to === '/actuals'}
        title={!expanded ? label : undefined}
        className={({ isActive }) => {
          const active = customActive !== undefined ? customActive : isActive;
          return `mt-nav-link group relative flex items-center gap-3 px-3 py-2.5 text-[13px] font-medium rounded-xl transition-colors duration-150 ${
            expanded ? '' : 'justify-center'
          } ${active ? 'mt-nav-link--active' : ''}`;
        }}
      >
        {({ isActive }) => {
          const active = customActive !== undefined ? customActive : isActive;
          return (
            <>
              {active && (
                <span
                  className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r"
                  style={{
                    background: 'var(--mt-accent)',
                    boxShadow: '0 0 8px color-mix(in srgb, var(--mt-accent) 60%, transparent)',
                  }}
                />
              )}
              <Icon size={17} className={`flex-shrink-0 transition-transform duration-150 ${active ? 'scale-105' : 'group-hover:scale-105'}`} />
              {expanded && <span className="truncate">{label}</span>}
            </>
          );
        }}
      </NavLink>
    );
  };

  return (
    <aside
      className={
        isMobile
          ? `w-72 surface-glass flex flex-col h-screen fixed left-0 top-0 z-50 border-r shadow-2xl transition-transform duration-300 ease-in-out ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`
          : `${w} surface-glass flex flex-col min-h-screen fixed left-0 top-0 z-40 border-r transition-all duration-200 ease-in-out overflow-hidden`
      }
      onMouseEnter={isMobile ? undefined : () => onExpandedChange(true)}
      onMouseLeave={isMobile ? undefined : () => { if (!showBranchDropdown) onExpandedChange(false); }}
    >
      {/* Logo */}
      <div
        className="px-4 py-5 flex-shrink-0"
        style={{ borderBottom: '1px solid var(--mt-border)' }}
      >
        <div className="flex items-center gap-3">
          <div
            className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 overflow-hidden"
            style={{
              background: 'linear-gradient(135deg, #10b981, #059669)',
              boxShadow: '0 4px 14px -4px rgba(16,185,129,0.45), inset 0 1px 0 rgba(255,255,255,0.18)',
              border: '1px solid rgba(16,185,129,0.35)',
            }}
          >
            {platformLogo ? (
              <img src={platformLogo} alt="Vision" className="w-full h-full object-contain p-1" />
            ) : (
              <BarChart3 size={18} className="text-white" />
            )}
          </div>
          {expanded && (
            <div className="min-w-0">
              <h1 className="mt-heading text-base leading-tight">Vision</h1>
              <p
                className="text-[10px] font-medium tracking-wide uppercase"
                style={{ color: 'var(--mt-text-faint)' }}
              >
                by Indefine
              </p>
            </div>
          )}
          {/* Pin toggle (desktop) or Close (mobile) */}
          {expanded && !isMobile && (
            <button
              data-tour="sidebar-pin"
              onClick={(e) => { e.stopPropagation(); onPinnedChange(!pinned); }}
              className="ml-auto flex-shrink-0 p-1.5 rounded-lg transition-colors"
              style={{
                color: pinned ? 'var(--mt-accent-text)' : 'var(--mt-text-faint)',
                background: pinned ? 'var(--mt-accent-soft)' : 'transparent',
              }}
              title={pinned ? 'Unpin sidebar' : 'Pin sidebar open'}
            >
              {pinned ? <PinOff size={14} /> : <Pin size={14} />}
            </button>
          )}
          {isMobile && (
            <button
              onClick={onMobileClose}
              className="ml-auto flex-shrink-0 p-1.5 rounded-lg transition-colors"
              style={{ color: 'var(--mt-text-faint)' }}
              aria-label="Close menu"
            >
              <X size={16} />
            </button>
          )}
        </div>
      </div>

      {/* Client context */}
      {clientName && expanded && (
        <div
          className="px-3 py-3 flex-shrink-0"
          style={{ borderBottom: '1px solid var(--mt-border)' }}
        >
          <div
            className="flex items-center gap-2.5 rounded-xl px-3 py-2.5"
            style={{ background: 'var(--mt-bg-muted)', border: '1px solid var(--mt-border)' }}
          >
            <div
              className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 overflow-hidden"
              style={{ background: 'var(--mt-accent-soft)' }}
            >
              {clientLogo ? (
                <img src={clientLogo} alt={clientName || ''} className="w-full h-full object-contain" />
              ) : (
                <Building2 size={13} style={{ color: 'var(--mt-accent-text)' }} />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <span
                className="text-xs font-semibold truncate block"
                style={{ color: 'var(--mt-text-primary)' }}
              >
                {clientName}
              </span>
              {isSuperAdmin && !isOwner && (
                <button
                  onClick={switchClient}
                  className="flex items-center gap-1 text-[10px] mt-0.5 transition-colors"
                  style={{ color: 'var(--mt-accent-text)' }}
                >
                  <ArrowLeftRight size={9} />
                  Switch
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Collapsed client icon */}
      {clientName && !expanded && (
        <div
          className="px-3 py-3 flex justify-center flex-shrink-0"
          style={{ borderBottom: '1px solid var(--mt-border)' }}
        >
          <div
            className="w-9 h-9 rounded-lg flex items-center justify-center"
            style={{ background: 'var(--mt-bg-muted)', border: '1px solid var(--mt-border)' }}
            title={clientName}
          >
            <Building2 size={15} style={{ color: 'var(--mt-accent-text)' }} />
          </div>
        </div>
      )}

      {/* Branch selector — multi-branch clients only */}
      {isMultiBranch && !(isSuperAdmin && isOwner) && branches.length > 0 && expanded && (
        <div
          className="px-3 py-2 flex-shrink-0"
          style={{ borderBottom: '1px solid var(--mt-border)' }}
        >
          <div className="relative" ref={branchDropdownRef}>
            <button
              onClick={() => setShowBranchDropdown(!showBranchDropdown)}
              className="w-full flex items-center gap-2 rounded-xl px-3 py-2 transition-colors"
              style={{
                background: 'var(--mt-bg-muted)',
                border: '1px solid var(--mt-border)',
              }}
            >
              <MapPin size={13} style={{ color: 'var(--mt-accent-text)' }} className="flex-shrink-0" />
              <span
                className="text-xs font-medium truncate flex-1 text-left"
                style={{ color: 'var(--mt-text-primary)' }}
              >
                {selectedBranchName}
              </span>
              <ChevronDown
                size={12}
                style={{ color: 'var(--mt-text-faint)' }}
                className={`transition-transform ${showBranchDropdown ? 'rotate-180' : ''}`}
              />
            </button>
            {showBranchDropdown && (
              <div
                className="absolute left-0 right-0 top-full mt-1 rounded-xl shadow-xl z-50 max-h-60 overflow-y-auto"
                style={{
                  background: 'var(--mt-bg-raised)',
                  border: '1px solid var(--mt-border)',
                  boxShadow: 'var(--mt-shadow-card)',
                }}
              >
                {canViewConsolidated && (
                  <button
                    onClick={() => selectBranch('all', 'All Branches')}
                    className="w-full text-left px-3 py-2 text-xs font-medium transition-colors"
                    style={{
                      color: selectedBranchId === 'all' ? 'var(--mt-accent-text)' : 'var(--mt-text-muted)',
                      background: selectedBranchId === 'all' ? 'var(--mt-accent-soft)' : 'transparent',
                    }}
                  >
                    All Branches
                  </button>
                )}
                {(() => {
                  // Group branches by state
                  const states = new Map<string, any[]>();
                  for (const b of branches) {
                    const st = b.state || '';
                    if (!states.has(st)) states.set(st, []);
                    states.get(st)!.push(b);
                  }
                  const stateEntries = Array.from(states.entries());
                  const hasMultipleStates = stateEntries.filter(([s]) => s).length > 1;
                  return stateEntries.map(([state, stateBranches]) => (
                    <div key={state || '__none'}>
                      {hasMultipleStates && state && (
                        <div
                          className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider"
                          style={{ color: 'var(--mt-text-faint)' }}
                        >
                          {state}
                        </div>
                      )}
                      {stateBranches.map((branch: any) => {
                        const isActive = selectedBranchId === String(branch.id);
                        return (
                          <button
                            key={branch.id}
                            onClick={() => selectBranch(String(branch.id), branch.name)}
                            className={`w-full text-left px-3 py-2 text-xs font-medium transition-colors ${hasMultipleStates && state ? 'pl-5' : ''}`}
                            style={{
                              color: isActive ? 'var(--mt-accent-text)' : 'var(--mt-text-muted)',
                              background: isActive ? 'var(--mt-accent-soft)' : 'transparent',
                            }}
                          >
                            <span>{branch.name}</span>
                            {branch.city && (
                              <span className="ml-1" style={{ color: 'var(--mt-text-faint)' }}>· {branch.city}</span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  ));
                })()}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Stream selector — shows when branch is selected and has streams */}
      {isMultiBranch && !(isSuperAdmin && isOwner) && expanded && getBranchStreams().length > 0 && selectedBranchId !== 'all' && (
        <div
          className="px-3 py-2 flex-shrink-0"
          style={{ borderBottom: '1px solid var(--mt-border)' }}
        >
          <div className="flex gap-1 flex-wrap">
            <button
              onClick={() => selectStream('all', 'All Streams')}
              className={`mt-chip ${selectedStreamId === 'all' ? 'mt-chip--active' : ''}`}
              style={{ fontSize: 10, padding: '3px 8px' }}
            >
              All
            </button>
            {getBranchStreams().map((stream: any) => (
              <button
                key={stream.id}
                onClick={() => selectStream(String(stream.id), stream.name)}
                className={`mt-chip ${selectedStreamId === String(stream.id) ? 'mt-chip--active' : ''}`}
                style={{ fontSize: 10, padding: '3px 8px' }}
              >
                {stream.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Collapsed branch icon */}
      {isMultiBranch && !(isSuperAdmin && isOwner) && branches.length > 0 && !expanded && (
        <div
          className="px-3 py-2 flex justify-center flex-shrink-0"
          style={{ borderBottom: '1px solid var(--mt-border)' }}
        >
          <div
            className="w-9 h-9 rounded-lg flex items-center justify-center"
            style={{ background: 'var(--mt-bg-muted)', border: '1px solid var(--mt-border)' }}
            title={selectedBranchName}
          >
            <MapPin size={13} style={{ color: 'var(--mt-accent-text)' }} />
          </div>
        </div>
      )}

      {/* Switch Module link */}
      {showModuleSwitcher && expanded && (
        <div
          className="px-3 py-2 flex-shrink-0"
          style={{ borderBottom: '1px solid var(--mt-border)' }}
        >
          <button
            onClick={() => navigate('/modules')}
            className="w-full flex items-center gap-2 text-xs font-medium transition-colors px-2 py-1.5"
            style={{ color: 'var(--mt-text-muted)' }}
          >
            <ArrowRight size={12} />
            <span>Switch Module</span>
          </button>
        </div>
      )}

      {/* Main navigation — scrollable */}
      <nav data-tour="sidebar-nav" className="flex-1 py-4 px-2 overflow-y-auto">
        <div className="space-y-1">
          {visibleMain.map(renderLink)}
        </div>

        {/* Admin section for super admins */}
        {isSuperAdmin && (
          <div className="mt-4">
            <NavLink
              to="/admin"
              title={!expanded ? 'Admin Panel' : undefined}
              className={({ isActive }) =>
                `mt-nav-link flex items-center gap-3 px-3 py-2.5 text-[13px] font-medium rounded-xl transition-colors ${
                  expanded ? '' : 'justify-center'
                } ${isActive ? 'mt-nav-link--active' : ''}`
              }
            >
              <Building2 size={17} className="flex-shrink-0" />
              {expanded && <span>Admin Panel</span>}
            </NavLink>
          </div>
        )}
      </nav>

      {/* Bottom utility links + theme toggle + logout */}
      <div
        className="px-2 pb-2 pt-3 space-y-1 flex-shrink-0"
        style={{ borderTop: '1px solid var(--mt-border)' }}
      >
        {visibleUtility.map(renderLink)}

        {/* Theme toggle */}
        <button
          data-tour="theme-toggle"
          onClick={toggleTheme}
          title={!expanded ? (theme === 'dark' ? 'Light mode' : 'Dark mode') : undefined}
          className={`mt-nav-link flex items-center gap-3 px-3 py-2.5 text-[13px] font-medium rounded-xl w-full transition-colors ${
            expanded ? '' : 'justify-center'
          }`}
        >
          {theme === 'dark' ? <Sun size={17} className="flex-shrink-0" /> : <Moon size={17} className="flex-shrink-0" />}
          {expanded && <span>{theme === 'dark' ? 'Light Mode' : 'Dark Mode'}</span>}
        </button>

        <button
          onClick={handleLogout}
          title={!expanded ? 'Logout' : undefined}
          className={`flex items-center gap-3 px-3 py-2.5 text-[13px] font-medium rounded-xl w-full transition-colors ${
            expanded ? '' : 'justify-center'
          }`}
          style={{ color: 'var(--mt-text-faint)' }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = 'var(--mt-danger-text)';
            e.currentTarget.style.background = 'var(--mt-danger-soft)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = 'var(--mt-text-faint)';
            e.currentTarget.style.background = 'transparent';
          }}
        >
          <LogOut size={17} className="flex-shrink-0" />
          {expanded && <span>Logout</span>}
        </button>
      </div>
    </aside>
  );
}
