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
import ClinicDetailPage from './pages/ClinicDetailPage';
import PharmacyDetailPage from './pages/PharmacyDetailPage';
import SettingsPage from './pages/SettingsPage';
import SelectClientPage from './pages/SelectClientPage';
import AdminPage from './pages/AdminPage';
import ModuleSelectPage from './pages/ModuleSelectPage';

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

// Client admins (client_user with role=admin) can access import, settings, etc.
function ClientAdminRoute({ children }: { children: React.ReactNode }) {
  const userRole = localStorage.getItem('user_role');
  return userRole === 'admin' ? <>{children}</> : <Navigate to="/actuals" replace />;
}

// Block super_admin from client working routes — they only use Admin Portal
function ClientRoute({ children }: { children: React.ReactNode }) {
  const userType = localStorage.getItem('user_type');
  return userType === 'super_admin' ? <Navigate to="/admin" replace /> : <>{children}</>;
}

// Require a specific module to be enabled for the client
function ModuleRoute({ moduleKey, children }: { moduleKey: string; children: React.ReactNode }) {
  const enabledModules: string[] = (() => {
    try { return JSON.parse(localStorage.getItem('enabled_modules') || '[]'); } catch { return []; }
  })();
  return enabledModules.includes(moduleKey) ? <>{children}</> : <Navigate to="/modules" replace />;
}

// Smart default redirect based on role
function DefaultRedirect() {
  const userType = localStorage.getItem('user_type');
  return userType === 'super_admin' ? <Navigate to="/admin" replace /> : <Navigate to="/actuals" replace />;
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
          <Route path="/analysis/*" element={<ClientRoute><ModuleRoute moduleKey="forecast_ops"><DashboardModulePage /></ModuleRoute></ClientRoute>} />
          <Route path="/import" element={<ClientRoute><ClientAdminRoute><ModuleRoute moduleKey="forecast_ops"><ImportPage /></ModuleRoute></ClientAdminRoute></ClientRoute>} />
          <Route path="/clinic" element={<ClientRoute><ModuleRoute moduleKey="forecast_ops"><ClinicDetailPage /></ModuleRoute></ClientRoute>} />
          <Route path="/pharmacy" element={<ClientRoute><ModuleRoute moduleKey="forecast_ops"><PharmacyDetailPage /></ModuleRoute></ClientRoute>} />
          <Route path="/settings" element={<ClientRoute><ClientAdminRoute><SettingsPage /></ClientAdminRoute></ClientRoute>} />
          <Route path="/admin/*" element={<SuperAdminRoute><AdminPage /></SuperAdminRoute>} />
          <Route path="/" element={<DefaultRedirect />} />
        </Route>
      </Routes>
    </BrowserRouter>
    </ThemeProvider>
  );
}
