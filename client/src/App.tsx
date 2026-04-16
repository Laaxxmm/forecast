import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import api from './api/client';
import { ThemeProvider } from './contexts/ThemeContext';
import Layout from './components/layout/Layout';
import LoginPage from './pages/LoginPage';
import DashboardModulePage from './pages/DashboardModulePage';
import DashboardPage from './pages/DashboardPage';
import ForecastModulePage from './pages/ForecastModulePage';
import ImportPage from './pages/ImportPage';
import StreamDetailPage from './pages/StreamDetailPage';
import SettingsPage from './pages/SettingsPage';
import SelectClientPage from './pages/SelectClientPage';
import AdminPage from './pages/AdminPage';
import ModuleSelectPage from './pages/ModuleSelectPage';
import OperationalInsightsPage from './pages/OperationalInsightsPage';
import RevenueSharingPage from './pages/RevenueSharingPage';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const [auth, setAuth] = useState<boolean | null>(null);

  useEffect(() => {
    api.get('/auth/me')
      .then(() => setAuth(true))
      .catch(() => setAuth(false));
  }, []);

  if (auth === null) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-theme-muted">Loading...</div>
      </div>
    );
  }

  return auth ? <>{children}</> : <Navigate to="/login" replace />;
}

// Only super_admin can access the Admin Portal
function SuperAdminRoute({ children }: { children: React.ReactNode }) {
  const userType = localStorage.getItem('user_type');
  return userType === 'super_admin' ? <>{children}</> : <Navigate to="/actuals" replace />;
}

// Client admins and team members (super_admin) can access import, settings, etc.
function ClientAdminRoute({ children }: { children: React.ReactNode }) {
  const userRole = localStorage.getItem('user_role');
  const userType = localStorage.getItem('user_type');
  return (userRole === 'admin' || userType === 'super_admin') ? <>{children}</> : <Navigate to="/actuals" replace />;
}

// Block owner super_admin from client working routes — non-owner admins can work in client context
function ClientRoute({ children }: { children: React.ReactNode }) {
  const userType = localStorage.getItem('user_type');
  const isOwner = localStorage.getItem('is_owner') === '1';
  // Owner super_admin goes to admin panel; non-owner super_admin can work in client context
  if (userType === 'super_admin' && isOwner) return <Navigate to="/admin" replace />;
  return <>{children}</>;
}

// Require a specific module to be enabled for the client
function ModuleRoute({ moduleKey, children }: { moduleKey: string; children: React.ReactNode }) {
  const enabledModules: string[] = (() => {
    try { return JSON.parse(localStorage.getItem('enabled_modules') || '[]'); } catch { return []; }
  })();
  return enabledModules.includes(moduleKey) ? <>{children}</> : <Navigate to="/modules" replace />;
}

// Block regular users from a page when its module toggle is disabled
// Admins and super_admins always have access
function UserModuleRoute({ moduleKey, children }: { moduleKey: string; children: React.ReactNode }) {
  const userRole = localStorage.getItem('user_role');
  const userType = localStorage.getItem('user_type');
  const isAdmin = userRole === 'admin' || userType === 'super_admin';
  if (isAdmin) return <>{children}</>;
  const enabledModules: string[] = (() => {
    try { return JSON.parse(localStorage.getItem('enabled_modules') || '[]'); } catch { return []; }
  })();
  return enabledModules.includes(moduleKey) ? <>{children}</> : <Navigate to="/actuals" replace />;
}

// Smart default redirect based on role
function DefaultRedirect() {
  const userType = localStorage.getItem('user_type');
  const isOwner = localStorage.getItem('is_owner') === '1';
  if (userType === 'super_admin') {
    return isOwner ? <Navigate to="/admin" replace /> : <Navigate to="/select-client" replace />;
  }
  return <Navigate to="/actuals" replace />;
}

export default function App() {
  return (
    <ThemeProvider>
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/select-client" element={<ProtectedRoute><SelectClientPage /></ProtectedRoute>} />
        <Route path="/modules" element={<ProtectedRoute><ModuleSelectPage /></ProtectedRoute>} />
        <Route
          element={
            <ProtectedRoute>
              <Layout />
            </ProtectedRoute>
          }
        >
          <Route path="/actuals" element={<ClientRoute><ModuleRoute moduleKey="forecast_ops"><DashboardPage /></ModuleRoute></ClientRoute>} />
          <Route path="/forecast/*" element={<ClientRoute><ModuleRoute moduleKey="forecast_ops"><ForecastModulePage /></ModuleRoute></ClientRoute>} />
          <Route path="/analysis/*" element={<ClientRoute><ModuleRoute moduleKey="forecast_ops"><UserModuleRoute moduleKey="user_analysis"><DashboardModulePage /></UserModuleRoute></ModuleRoute></ClientRoute>} />
          <Route path="/insights" element={<ClientRoute><ModuleRoute moduleKey="forecast_ops"><UserModuleRoute moduleKey="user_insights"><OperationalInsightsPage /></UserModuleRoute></ModuleRoute></ClientRoute>} />
          <Route path="/revenue-sharing" element={<ClientRoute><ModuleRoute moduleKey="forecast_ops"><RevenueSharingPage /></ModuleRoute></ClientRoute>} />
          <Route path="/import" element={<ClientRoute><ClientAdminRoute><ModuleRoute moduleKey="forecast_ops"><ImportPage /></ModuleRoute></ClientAdminRoute></ClientRoute>} />
          <Route path="/stream/:streamId" element={<ClientRoute><ModuleRoute moduleKey="forecast_ops"><StreamDetailPage /></ModuleRoute></ClientRoute>} />
          {/* VCFO Portal is served by the mounted TallyVision sub-app at /vcfo/* (non-React) */}
          <Route path="/settings" element={<ClientRoute><ClientAdminRoute><SettingsPage /></ClientAdminRoute></ClientRoute>} />
          <Route path="/admin/*" element={<SuperAdminRoute><AdminPage /></SuperAdminRoute>} />
          <Route path="/" element={<DefaultRedirect />} />
        </Route>
      </Routes>
    </BrowserRouter>
    </ThemeProvider>
  );
}
