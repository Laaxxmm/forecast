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
import VcfoDashboardPage from './pages/vcfo/VcfoDashboardPage';
import TallySyncPage from './pages/vcfo/TallySyncPage';
import TrialBalancePage from './pages/vcfo/TrialBalancePage';
import VcfoProfitLossPage from './pages/vcfo/VcfoProfitLossPage';
import VcfoBalanceSheetPage from './pages/vcfo/VcfoBalanceSheetPage';
import VcfoBillsPage from './pages/vcfo/VcfoBillsPage';
import VcfoTrackerPage from './pages/vcfo/VcfoTrackerPage';
import VcfoAuditPage from './pages/vcfo/VcfoAuditPage';
import CompanyGroupsPage from './pages/vcfo/CompanyGroupsPage';
import AllocationRulesPage from './pages/vcfo/AllocationRulesPage';
import WriteoffRulesPage from './pages/vcfo/WriteoffRulesPage';
import ExcelUploadsPage from './pages/vcfo/ExcelUploadsPage';
import BudgetsPage from './pages/vcfo/BudgetsPage';
import CFOReviewPage from './pages/vcfo/CFOReviewPage';
import VcfoSettingsPage from './pages/vcfo/VcfoSettingsPage';
import TableViewPage from './pages/vcfo/TableViewPage';
import AdjustmentsPage from './pages/vcfo/AdjustmentsPage';
import PublishCloudPage from './pages/vcfo/PublishCloudPage';
import VcfoForecastViewPage from './pages/vcfo/VcfoForecastViewPage';

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
          {/* VCFO Portal — internal module */}
          <Route path="/vcfo" element={<ClientRoute><ModuleRoute moduleKey="vcfo_portal"><VcfoDashboardPage /></ModuleRoute></ClientRoute>} />
          <Route path="/vcfo/table-view" element={<ClientRoute><ModuleRoute moduleKey="vcfo_portal"><TableViewPage /></ModuleRoute></ClientRoute>} />
          <Route path="/vcfo/adjustments" element={<ClientRoute><ModuleRoute moduleKey="vcfo_portal"><AdjustmentsPage /></ModuleRoute></ClientRoute>} />
          <Route path="/vcfo/publish" element={<ClientRoute><ModuleRoute moduleKey="vcfo_portal"><PublishCloudPage /></ModuleRoute></ClientRoute>} />
          <Route path="/vcfo/sync" element={<ClientRoute><ClientAdminRoute><ModuleRoute moduleKey="vcfo_portal"><TallySyncPage /></ModuleRoute></ClientAdminRoute></ClientRoute>} />
          <Route path="/vcfo/trial-balance" element={<ClientRoute><ModuleRoute moduleKey="vcfo_portal"><TrialBalancePage /></ModuleRoute></ClientRoute>} />
          <Route path="/vcfo/profit-loss" element={<ClientRoute><ModuleRoute moduleKey="vcfo_portal"><VcfoProfitLossPage /></ModuleRoute></ClientRoute>} />
          <Route path="/vcfo/balance-sheet" element={<ClientRoute><ModuleRoute moduleKey="vcfo_portal"><VcfoBalanceSheetPage /></ModuleRoute></ClientRoute>} />
          <Route path="/vcfo/bills" element={<ClientRoute><ModuleRoute moduleKey="vcfo_portal"><VcfoBillsPage /></ModuleRoute></ClientRoute>} />
          <Route path="/vcfo/tracker" element={<ClientRoute><ModuleRoute moduleKey="vcfo_portal"><VcfoTrackerPage /></ModuleRoute></ClientRoute>} />
          <Route path="/vcfo/audit" element={<ClientRoute><ModuleRoute moduleKey="vcfo_portal"><VcfoAuditPage /></ModuleRoute></ClientRoute>} />
          <Route path="/vcfo/groups" element={<ClientRoute><ClientAdminRoute><ModuleRoute moduleKey="vcfo_portal"><CompanyGroupsPage /></ModuleRoute></ClientAdminRoute></ClientRoute>} />
          <Route path="/vcfo/allocation-rules" element={<ClientRoute><ClientAdminRoute><ModuleRoute moduleKey="vcfo_portal"><AllocationRulesPage /></ModuleRoute></ClientAdminRoute></ClientRoute>} />
          <Route path="/vcfo/writeoff-rules" element={<ClientRoute><ClientAdminRoute><ModuleRoute moduleKey="vcfo_portal"><WriteoffRulesPage /></ModuleRoute></ClientAdminRoute></ClientRoute>} />
          <Route path="/vcfo/uploads" element={<ClientRoute><ModuleRoute moduleKey="vcfo_portal"><ExcelUploadsPage /></ModuleRoute></ClientRoute>} />
          <Route path="/vcfo/budgets" element={<ClientRoute><ModuleRoute moduleKey="vcfo_portal"><BudgetsPage /></ModuleRoute></ClientRoute>} />
          <Route path="/vcfo/cfo-review" element={<ClientRoute><ModuleRoute moduleKey="vcfo_portal"><CFOReviewPage /></ModuleRoute></ClientRoute>} />
          <Route path="/vcfo/forecast" element={<ClientRoute><ModuleRoute moduleKey="vcfo_portal"><VcfoForecastViewPage /></ModuleRoute></ClientRoute>} />
          <Route path="/vcfo/settings" element={<ClientRoute><ModuleRoute moduleKey="vcfo_portal"><VcfoSettingsPage /></ModuleRoute></ClientRoute>} />
          <Route path="/settings" element={<ClientRoute><ClientAdminRoute><SettingsPage /></ClientAdminRoute></ClientRoute>} />
          <Route path="/admin/*" element={<SuperAdminRoute><AdminPage /></SuperAdminRoute>} />
          <Route path="/" element={<DefaultRedirect />} />
        </Route>
      </Routes>
    </BrowserRouter>
    </ThemeProvider>
  );
}
