import { NavLink, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, TrendingUp, Upload, Settings, LogOut, BarChart3, Building2, ArrowLeftRight,
  ChevronLeft
} from 'lucide-react';
import api from '../../api/client';

// Main navigation — top section
const mainLinks = [
  { to: '/actuals', icon: LayoutDashboard, label: 'Actuals', clientAdminOnly: false },
  { to: '/forecast', icon: TrendingUp, label: 'Forecast', clientAdminOnly: false },
  { to: '/analysis', icon: BarChart3, label: 'Analysis', clientAdminOnly: false },
];

// Utility links — bottom section above logout
const utilityLinks = [
  { to: '/import', icon: Upload, label: 'Import Data', clientAdminOnly: true },
  { to: '/settings', icon: Settings, label: 'Settings', clientAdminOnly: true },
];

interface SidebarProps {
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}

export default function Sidebar({ expanded, onExpandedChange }: SidebarProps) {
  const navigate = useNavigate();
  const userType = localStorage.getItem('user_type');
  const userRole = localStorage.getItem('user_role');
  const clientName = localStorage.getItem('client_name');
  const isSuperAdmin = userType === 'super_admin';
  const isClientAdmin = userRole === 'admin';

  const visibleMain = isSuperAdmin ? [] : mainLinks;
  const visibleUtility = isSuperAdmin ? [] : utilityLinks.filter(l => isClientAdmin || !l.clientAdminOnly);

  const handleLogout = async () => {
    await api.post('/auth/logout').catch(() => {});
    localStorage.removeItem('auth_token');
    localStorage.removeItem('user_type');
    localStorage.removeItem('user_role');
    localStorage.removeItem('client_slug');
    localStorage.removeItem('client_name');
    window.location.href = '/login';
  };

  const switchClient = () => {
    localStorage.removeItem('client_slug');
    localStorage.removeItem('client_name');
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
            : 'text-slate-400 hover:bg-dark-600 hover:text-slate-200'
        }`
      }
    >
      <Icon size={17} className="flex-shrink-0" />
      {expanded && <span className="truncate">{label}</span>}
    </NavLink>
  );

  return (
    <aside
      className={`${w} bg-dark-800 text-white flex flex-col min-h-screen fixed left-0 top-0 z-40 border-r border-dark-400/30 transition-all duration-200 ease-in-out overflow-hidden`}
      onMouseEnter={() => onExpandedChange(true)}
      onMouseLeave={() => onExpandedChange(false)}
    >
      {/* Logo */}
      <div className="px-4 py-5 border-b border-dark-400/30">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-accent-500 flex items-center justify-center flex-shrink-0">
            <BarChart3 size={18} className="text-white" />
          </div>
          {expanded && (
            <div className="min-w-0">
              <h1 className="text-base font-bold text-white leading-tight">Vision</h1>
              <p className="text-[10px] text-slate-500 font-medium tracking-wide uppercase">by Indefine</p>
            </div>
          )}
          {expanded && (
            <ChevronLeft size={14} className="text-slate-500 ml-auto flex-shrink-0" />
          )}
        </div>
      </div>

      {/* Client context */}
      {clientName && expanded && (
        <div className="px-3 py-3 border-b border-dark-400/30">
          <div className="flex items-center gap-2.5 bg-dark-600 rounded-xl px-3 py-2.5">
            <div className="w-7 h-7 rounded-lg bg-accent-500/15 flex items-center justify-center flex-shrink-0">
              <Building2 size={13} className="text-accent-400" />
            </div>
            <div className="flex-1 min-w-0">
              <span className="text-xs font-semibold text-slate-200 truncate block">{clientName}</span>
              {isSuperAdmin && (
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
        <div className="px-3 py-3 border-b border-dark-400/30 flex justify-center">
          <div className="w-9 h-9 rounded-lg bg-dark-600 flex items-center justify-center" title={clientName}>
            <Building2 size={15} className="text-accent-400" />
          </div>
        </div>
      )}

      {/* Main navigation */}
      <nav className="flex-1 py-4 px-2">
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
                    : 'text-slate-400 hover:bg-dark-600 hover:text-slate-200'
                }`
              }
            >
              <Building2 size={17} className="flex-shrink-0" />
              {expanded && <span>Admin Panel</span>}
            </NavLink>
          </div>
        )}
      </nav>

      {/* Bottom utility links + logout */}
      <div className="px-2 pb-2 border-t border-dark-400/30 pt-3 space-y-1">
        {visibleUtility.map(renderLink)}
        <button
          onClick={handleLogout}
          title={!expanded ? 'Logout' : undefined}
          className={`flex items-center gap-3 px-3 py-2.5 text-[13px] font-medium text-slate-500 hover:text-red-400 hover:bg-red-500/10 rounded-xl w-full transition-all ${
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
