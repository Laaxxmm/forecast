import { useState, useEffect, useRef } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, TrendingUp, Upload, Settings, LogOut, BarChart3, Building2, ArrowLeftRight,
  MapPin, ChevronDown, Sun, Moon, ArrowRight, Activity, PieChart,
  Pin, PinOff, X,
} from 'lucide-react';
import api from '../../api/client';
import { useTheme } from '../../contexts/ThemeContext';

// Forecast & Operations navigation
const forecastLinks = [
  { to: '/actuals', icon: LayoutDashboard, label: 'Actuals', clientAdminOnly: false, requiresModule: '' },
  { to: '/forecast', icon: TrendingUp, label: 'Forecast', clientAdminOnly: false, requiresModule: '' },
  { to: '/analysis', icon: BarChart3, label: 'Analysis', clientAdminOnly: false, requiresModule: 'user_analysis' },
  { to: '/insights', icon: Activity, label: 'Insights', clientAdminOnly: false, requiresModule: 'user_insights' },
  { to: '/revenue-sharing', icon: PieChart, label: 'Rev. Sharing', clientAdminOnly: false, requiresModule: '' },
];

// VCFO Portal is served by the mounted TallyVision sub-app at /vcfo/* and has its own sidebar.

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

  const activeModule = localStorage.getItem('active_module') || 'forecast_ops';
  const enabledModules: string[] = (() => {
    try { return JSON.parse(localStorage.getItem('enabled_modules') || '[]'); } catch { return []; }
  })();
  const mainLinks = forecastLinks;
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

  const renderLink = ({ to, icon: Icon, label }: { to: string; icon: any; label: string }) => (
    <NavLink
      key={to}
      to={to}
      end={to === '/actuals'}
      title={!expanded ? label : undefined}
      className={({ isActive }) =>
        `flex items-center gap-3 px-3 py-2.5 text-[13px] font-medium rounded-xl transition-all ${
          expanded ? '' : 'justify-center'
        } ${
          isActive
            ? 'bg-accent-500/15 text-accent-400 shadow-sm'
            : 'text-theme-muted hover:bg-dark-600 hover:text-theme-primary'
        }`
      }
    >
      <Icon size={17} className="flex-shrink-0" />
      {expanded && <span className="truncate">{label}</span>}
    </NavLink>
  );

  return (
    <aside
      className={
        isMobile
          ? `w-72 bg-dark-800 flex flex-col h-screen fixed left-0 top-0 z-50 border-r border-dark-400/30 shadow-2xl transition-transform duration-300 ease-in-out ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`
          : `${w} bg-dark-800 flex flex-col min-h-screen fixed left-0 top-0 z-40 border-r border-dark-400/30 transition-all duration-200 ease-in-out overflow-hidden`
      }
      onMouseEnter={isMobile ? undefined : () => onExpandedChange(true)}
      onMouseLeave={isMobile ? undefined : () => { if (!showBranchDropdown) onExpandedChange(false); }}
    >
      {/* Logo */}
      <div className="px-4 py-5 border-b border-dark-400/30 flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-accent-500 flex items-center justify-center flex-shrink-0 overflow-hidden">
            {platformLogo ? (
              <img src={platformLogo} alt="Vision" className="w-full h-full object-contain p-1" />
            ) : (
              <BarChart3 size={18} className="text-white" />
            )}
          </div>
          {expanded && (
            <div className="min-w-0">
              <h1 className="text-base font-bold text-theme-heading leading-tight">Vision</h1>
              <p className="text-[10px] text-theme-faint font-medium tracking-wide uppercase">by Indefine</p>
            </div>
          )}
          {/* Pin toggle (desktop) or Close (mobile) */}
          {expanded && !isMobile && (
            <button
              onClick={(e) => { e.stopPropagation(); onPinnedChange(!pinned); }}
              className={`ml-auto flex-shrink-0 p-1.5 rounded-lg transition-colors ${
                pinned
                  ? 'text-accent-400 bg-accent-500/10 hover:bg-accent-500/20'
                  : 'text-theme-faint hover:text-theme-primary hover:bg-dark-600'
              }`}
              title={pinned ? 'Unpin sidebar' : 'Pin sidebar open'}
            >
              {pinned ? <PinOff size={14} /> : <Pin size={14} />}
            </button>
          )}
          {isMobile && (
            <button
              onClick={onMobileClose}
              className="ml-auto flex-shrink-0 p-1.5 rounded-lg text-theme-faint hover:text-theme-primary hover:bg-dark-600 transition-colors"
              aria-label="Close menu"
            >
              <X size={16} />
            </button>
          )}
        </div>
      </div>

      {/* Client context */}
      {clientName && expanded && (
        <div className="px-3 py-3 border-b border-dark-400/30 flex-shrink-0">
          <div className="flex items-center gap-2.5 bg-dark-600 rounded-xl px-3 py-2.5">
            <div className="w-7 h-7 rounded-lg bg-accent-500/15 flex items-center justify-center flex-shrink-0 overflow-hidden">
              {clientLogo ? (
                <img src={clientLogo} alt={clientName || ''} className="w-full h-full object-contain" />
              ) : (
                <Building2 size={13} className="text-accent-400" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <span className="text-xs font-semibold text-theme-primary truncate block">{clientName}</span>
              {isSuperAdmin && !isOwner && (
                <button
                  onClick={switchClient}
                  className="flex items-center gap-1 text-[10px] text-accent-400 hover:text-accent-300 mt-0.5 transition-colors"
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
        <div className="px-3 py-3 border-b border-dark-400/30 flex justify-center flex-shrink-0">
          <div className="w-9 h-9 rounded-lg bg-dark-600 flex items-center justify-center" title={clientName}>
            <Building2 size={15} className="text-accent-400" />
          </div>
        </div>
      )}

      {/* Branch selector — multi-branch clients only */}
      {isMultiBranch && !(isSuperAdmin && isOwner) && branches.length > 0 && expanded && (
        <div className="px-3 py-2 border-b border-dark-400/30 flex-shrink-0">
          <div className="relative" ref={branchDropdownRef}>
            <button
              onClick={() => setShowBranchDropdown(!showBranchDropdown)}
              className="w-full flex items-center gap-2 bg-dark-600 rounded-xl px-3 py-2 hover:bg-dark-500 transition-colors"
            >
              <MapPin size={13} className="text-accent-400 flex-shrink-0" />
              <span className="text-xs font-medium text-theme-primary truncate flex-1 text-left">{selectedBranchName}</span>
              <ChevronDown size={12} className={`text-theme-faint transition-transform ${showBranchDropdown ? 'rotate-180' : ''}`} />
            </button>
            {showBranchDropdown && (
              <div className="absolute left-0 right-0 top-full mt-1 bg-dark-700 border border-dark-400/30 rounded-xl shadow-xl z-50 max-h-60 overflow-y-auto">
                {canViewConsolidated && (
                  <button
                    onClick={() => selectBranch('all', 'All Branches')}
                    className={`w-full text-left px-3 py-2 text-xs font-medium transition-colors ${
                      selectedBranchId === 'all' ? 'text-accent-400 bg-accent-500/10' : 'text-theme-secondary hover:bg-dark-600'
                    }`}
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
                        <div className="px-3 py-1.5 text-[10px] font-semibold text-theme-faint uppercase tracking-wider">{state}</div>
                      )}
                      {stateBranches.map((branch: any) => (
                        <button
                          key={branch.id}
                          onClick={() => selectBranch(String(branch.id), branch.name)}
                          className={`w-full text-left px-3 py-2 text-xs font-medium transition-colors ${
                            selectedBranchId === String(branch.id) ? 'text-accent-400 bg-accent-500/10' : 'text-theme-secondary hover:bg-dark-600'
                          } ${hasMultipleStates && state ? 'pl-5' : ''}`}
                        >
                          <span>{branch.name}</span>
                          {branch.city && <span className="text-theme-faint ml-1">· {branch.city}</span>}
                        </button>
                      ))}
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
        <div className="px-3 py-2 border-b border-dark-400/30 flex-shrink-0">
          <div className="flex gap-1 flex-wrap">
            <button
              onClick={() => selectStream('all', 'All Streams')}
              className={`text-[10px] px-2 py-1 rounded-lg font-medium transition-all ${
                selectedStreamId === 'all'
                  ? 'bg-accent-500/15 text-accent-400'
                  : 'bg-dark-600 text-theme-faint hover:text-theme-secondary'
              }`}
            >
              All
            </button>
            {getBranchStreams().map((stream: any) => (
              <button
                key={stream.id}
                onClick={() => selectStream(String(stream.id), stream.name)}
                className={`text-[10px] px-2 py-1 rounded-lg font-medium transition-all ${
                  selectedStreamId === String(stream.id)
                    ? 'bg-accent-500/15 text-accent-400'
                    : 'bg-dark-600 text-theme-faint hover:text-theme-secondary'
                }`}
              >
                {stream.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Collapsed branch icon */}
      {isMultiBranch && !(isSuperAdmin && isOwner) && branches.length > 0 && !expanded && (
        <div className="px-3 py-2 border-b border-dark-400/30 flex justify-center flex-shrink-0">
          <div className="w-9 h-9 rounded-lg bg-dark-600 flex items-center justify-center" title={selectedBranchName}>
            <MapPin size={13} className="text-accent-400" />
          </div>
        </div>
      )}

      {/* Switch Module link */}
      {!isSuperAdmin && expanded && (
        <div className="px-3 py-2 border-b border-dark-400/30 flex-shrink-0">
          <button
            onClick={() => navigate('/modules')}
            className="w-full flex items-center gap-2 text-xs font-medium text-theme-muted hover:text-accent-400 transition-colors px-2 py-1.5"
          >
            <ArrowRight size={12} />
            <span>Switch Module</span>
          </button>
        </div>
      )}

      {/* Main navigation — scrollable */}
      <nav className="flex-1 py-4 px-2 overflow-y-auto">
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
                `flex items-center gap-3 px-3 py-2.5 text-[13px] font-medium rounded-xl transition-all ${
                  expanded ? '' : 'justify-center'
                } ${
                  isActive
                    ? 'bg-accent-500/15 text-accent-400 shadow-sm'
                    : 'text-theme-muted hover:bg-dark-600 hover:text-theme-primary'
                }`
              }
            >
              <Building2 size={17} className="flex-shrink-0" />
              {expanded && <span>Admin Panel</span>}
            </NavLink>
          </div>
        )}
      </nav>

      {/* Bottom utility links + theme toggle + logout */}
      <div className="px-2 pb-2 border-t border-dark-400/30 pt-3 space-y-1 flex-shrink-0">
        {visibleUtility.map(renderLink)}

        {/* Theme toggle */}
        <button
          onClick={toggleTheme}
          title={!expanded ? (theme === 'dark' ? 'Light mode' : 'Dark mode') : undefined}
          className={`flex items-center gap-3 px-3 py-2.5 text-[13px] font-medium text-theme-muted hover:bg-dark-600 hover:text-theme-primary rounded-xl w-full transition-all ${
            expanded ? '' : 'justify-center'
          }`}
        >
          {theme === 'dark' ? <Sun size={17} className="flex-shrink-0" /> : <Moon size={17} className="flex-shrink-0" />}
          {expanded && <span>{theme === 'dark' ? 'Light Mode' : 'Dark Mode'}</span>}
        </button>

        <button
          onClick={handleLogout}
          title={!expanded ? 'Logout' : undefined}
          className={`flex items-center gap-3 px-3 py-2.5 text-[13px] font-medium text-theme-faint hover:text-red-400 hover:bg-red-500/10 rounded-xl w-full transition-all ${
            expanded ? '' : 'justify-center'
          }`}
        >
          <LogOut size={17} className="flex-shrink-0" />
          {expanded && <span>Logout</span>}
        </button>
      </div>
    </aside>
  );
}
