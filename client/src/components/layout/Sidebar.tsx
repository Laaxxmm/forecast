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
    <aside className="w-64 bg-dark-800 text-white flex flex-col min-h-screen fixed left-0 top-0 z-40 border-r border-dark-400/30">
      {/* Logo */}
      <div className="p-6 border-b border-dark-400/30">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-accent-500 flex items-center justify-center">
            <BarChart3 size={18} className="text-white" />
          </div>
          <div>
            <h1 className="text-base font-bold text-white">Vision</h1>
            <p className="text-[10px] text-slate-500 font-medium tracking-wide uppercase">by Indefine</p>
          </div>
        </div>
      </div>

      {/* Client context indicator */}
      {clientName && (
        <div className="px-5 py-3 border-b border-dark-400/30">
          <div className="flex items-center gap-2.5 bg-dark-600 rounded-xl px-3 py-2.5">
            <div className="w-7 h-7 rounded-lg bg-accent-500/15 flex items-center justify-center">
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

      <nav className="flex-1 py-4 px-3">
        <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider px-3 mb-3">Menu</p>
        <div className="space-y-1">
          {links.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/actuals'}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2.5 text-[13px] font-medium rounded-xl transition-all ${
                  isActive
                    ? 'bg-accent-500/15 text-accent-400 shadow-sm'
                    : 'text-slate-400 hover:bg-dark-600 hover:text-slate-200'
                }`
              }
            >
              <Icon size={17} />
              {label}
            </NavLink>
          ))}
        </div>

        {/* Admin section for super admins */}
        {isSuperAdmin && (
          <div className="mt-6">
            <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider px-3 mb-3">Admin</p>
            <NavLink
              to="/select-client"
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2.5 text-[13px] font-medium rounded-xl transition-all ${
                  isActive
                    ? 'bg-accent-500/15 text-accent-400 shadow-sm'
                    : 'text-slate-400 hover:bg-dark-600 hover:text-slate-200'
                }`
              }
            >
              <Building2 size={17} />
              Manage Clients
            </NavLink>
          </div>
        )}
      </nav>

      {/* Logout */}
      <div className="p-3 border-t border-dark-400/30">
        <button
          onClick={handleLogout}
          className="flex items-center gap-3 px-3 py-2.5 text-[13px] font-medium text-slate-500 hover:text-red-400 hover:bg-red-500/10 rounded-xl w-full transition-all"
        >
          <LogOut size={17} />
          Logout
        </button>
      </div>
    </aside>
  );
}
