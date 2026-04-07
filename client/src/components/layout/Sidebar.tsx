import { NavLink, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, TrendingUp, Upload, Stethoscope, Pill, Settings, LogOut, BarChart3, Building2, ArrowLeftRight
} from 'lucide-react';
import api from '../../api/client';

const links = [
  { to: '/actuals', icon: LayoutDashboard, label: 'Actuals' },
  { to: '/forecast', icon: TrendingUp, label: 'Forecast' },
  { to: '/analysis', icon: BarChart3, label: 'Analysis' },
  { to: '/import', icon: Upload, label: 'Import Data' },
  { to: '/clinic', icon: Stethoscope, label: 'Clinic Details' },
  { to: '/pharmacy', icon: Pill, label: 'Pharmacy Details' },
  { to: '/settings', icon: Settings, label: 'Settings' },
];

export default function Sidebar() {
  const navigate = useNavigate();
  const userType = localStorage.getItem('user_type');
  const clientName = localStorage.getItem('client_name');
  const isSuperAdmin = userType === 'super_admin';

  const handleLogout = async () => {
    await api.post('/auth/logout').catch(() => {});
    localStorage.removeItem('auth_token');
    localStorage.removeItem('user_type');
    localStorage.removeItem('client_slug');
    localStorage.removeItem('client_name');
    window.location.href = '/login';
  };

  const switchClient = () => {
    localStorage.removeItem('client_slug');
    localStorage.removeItem('client_name');
    navigate('/select-client');
  };

  return (
    <aside className="w-60 bg-slate-900 text-white flex flex-col min-h-screen fixed left-0 top-0 z-40">
      <div className="p-5 border-b border-slate-700">
        <h1 className="text-xl font-bold text-primary-400">Magna Tracker</h1>
        <p className="text-xs text-slate-400 mt-1">Forecast & Performance</p>
      </div>

      {/* Client context indicator */}
      {clientName && (
        <div className="px-4 py-3 border-b border-slate-700 bg-slate-800/50">
          <div className="flex items-center gap-2">
            <Building2 size={14} className="text-primary-400" />
            <span className="text-xs font-medium text-primary-300 truncate">{clientName}</span>
          </div>
          {isSuperAdmin && (
            <button
              onClick={switchClient}
              className="flex items-center gap-1 text-xs text-slate-400 hover:text-white mt-1 transition-colors"
            >
              <ArrowLeftRight size={12} />
              Switch Client
            </button>
          )}
        </div>
      )}

      <nav className="flex-1 py-4">
        {links.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/actuals'}
            className={({ isActive }) =>
              `flex items-center gap-3 px-5 py-3 text-sm transition-colors ${
                isActive
                  ? 'bg-primary-600/20 text-primary-400 border-r-2 border-primary-400'
                  : 'text-slate-300 hover:bg-slate-800 hover:text-white'
              }`
            }
          >
            <Icon size={18} />
            {label}
          </NavLink>
        ))}

        {/* Admin section for super admins */}
        {isSuperAdmin && (
          <>
            <div className="px-5 pt-4 pb-2">
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Admin</span>
            </div>
            <NavLink
              to="/select-client"
              className={({ isActive }) =>
                `flex items-center gap-3 px-5 py-3 text-sm transition-colors ${
                  isActive
                    ? 'bg-primary-600/20 text-primary-400 border-r-2 border-primary-400'
                    : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                }`
              }
            >
              <Building2 size={18} />
              Manage Clients
            </NavLink>
          </>
        )}
      </nav>
      <button
        onClick={handleLogout}
        className="flex items-center gap-3 px-5 py-4 text-sm text-slate-400 hover:text-white hover:bg-slate-800 border-t border-slate-700"
      >
        <LogOut size={18} />
        Logout
      </button>
    </aside>
  );
}
