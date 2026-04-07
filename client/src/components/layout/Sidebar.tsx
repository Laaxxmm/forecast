import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard, TrendingUp, Upload, Stethoscope, Pill, Settings, LogOut, BarChart3
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
  const handleLogout = async () => {
    await api.post('/auth/logout').catch(() => {});
    localStorage.removeItem('auth_token');
    window.location.href = '/login';
  };

  return (
    <aside className="w-60 bg-slate-900 text-white flex flex-col min-h-screen fixed left-0 top-0 z-40">
      <div className="p-5 border-b border-slate-700">
        <h1 className="text-xl font-bold text-primary-400">Magna Tracker</h1>
        <p className="text-xs text-slate-400 mt-1">Forecast & Performance</p>
      </div>
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
