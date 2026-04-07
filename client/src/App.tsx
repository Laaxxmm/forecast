import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import api from './api/client';
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
        <div className="text-slate-400">Loading...</div>
      </div>
    );
  }

  return auth ? <>{children}</> : <Navigate to="/login" replace />;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/select-client" element={<ProtectedRoute><SelectClientPage /></ProtectedRoute>} />
        <Route
          element={
            <ProtectedRoute>
              <Layout />
            </ProtectedRoute>
          }
        >
          <Route path="/actuals" element={<DashboardPage />} />
          <Route path="/forecast/*" element={<ForecastModulePage />} />
          <Route path="/analysis/*" element={<DashboardModulePage />} />
          <Route path="/import" element={<ImportPage />} />
          <Route path="/clinic" element={<ClinicDetailPage />} />
          <Route path="/pharmacy" element={<PharmacyDetailPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/" element={<Navigate to="/actuals" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
