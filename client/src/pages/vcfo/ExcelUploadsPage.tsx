import { useState, useEffect, useCallback } from 'react';
import {
  Upload, FileSpreadsheet, Trash2, Eye, BarChart3, RefreshCw,
  ChevronDown, X, Plus, Database, TrendingUp, Users, Calendar
} from 'lucide-react';
import api from '../../api/client';

// ── Formatting helpers ───────────────────────────────────────────────────────

function fmt(num: number | undefined | null): string {
  if (num === undefined || num === null || isNaN(num)) return '\u20B90';
  const abs = Math.abs(num);
  const sign = num < 0 ? '-' : '';
  if (abs >= 10000000) return sign + '\u20B9' + parseFloat((abs / 10000000).toFixed(2)) + ' Cr';
  if (abs >= 100000) return sign + '\u20B9' + parseFloat((abs / 100000).toFixed(2)) + ' L';
  if (abs >= 1000) return sign + '\u20B9' + parseFloat((abs / 1000).toFixed(1)) + ' K';
  return sign + '\u20B9' + abs.toFixed(0);
}

function fmtNum(num: number | undefined | null): string {
  if (num === undefined || num === null || isNaN(num)) return '0';
  return num.toLocaleString('en-IN');
}

// ── Types ────────────────────────────────────────────────────────────────────

interface Category {
  slug: string;
  display_name: string;
  description: string;
  expected_columns: string[];
}

interface UploadRecord {
  id: number;
  filename: string;
  category: string;
  period_month: string;
  row_count: number;
  company_id?: number;
  company_name?: string;
  created_at: string;
  uploaded_by?: string;
}

interface Company {
  id: number;
  name: string;
}

type ViewMode = 'list' | 'grid' | 'data' | 'analytics' | 'upload';

// ── Component ────────────────────────────────────────────────────────────────

export default function ExcelUploadsPage() {
  // Data state
  const [categories, setCategories] = useState<Category[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [uploads, setUploads] = useState<UploadRecord[]>([]);
  const [gridData, setGridData] = useState<Record<string, any>>({});
  const [uploadData, setUploadData] = useState<{ upload: any; data: any[] } | null>(null);
  const [analytics, setAnalytics] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Filter state
  const [selectedCategory, setSelectedCategory] = useState('');
  const [periodMonth, setPeriodMonth] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [selectedUploadId, setSelectedUploadId] = useState<number | null>(null);

  // Upload form state
  const [uploadForm, setUploadForm] = useState({
    category: '',
    periodMonth: '',
    companyId: '',
    filename: '',
    jsonData: '',
  });

  // Analytics filter state
  const [analyticsFrom, setAnalyticsFrom] = useState('');
  const [analyticsTo, setAnalyticsTo] = useState('');

  // ── Load categories + companies on mount ─────────────────────────────────

  useEffect(() => {
    Promise.all([
      api.get('/vcfo/uploads/categories').catch(() => ({ data: [] })),
      api.get('/vcfo/companies').catch(() => ({ data: [] })),
    ]).then(([catRes, compRes]) => {
      const cats = Array.isArray(catRes.data) ? catRes.data : catRes.data?.categories || [];
      setCategories(cats);
      if (cats.length > 0) setSelectedCategory(cats[0].slug);

      const comps = Array.isArray(compRes.data) ? compRes.data : compRes.data?.companies || [];
      setCompanies(comps);
    });
  }, []);

  // ── Load uploads when category / period changes ──────────────────────────

  const loadUploads = useCallback(async () => {
    if (!selectedCategory) return;
    setLoading(true);
    setError('');
    try {
      const params: any = { category: selectedCategory };
      if (periodMonth) params.periodMonth = periodMonth;
      const res = await api.get('/vcfo/uploads/list', { params });
      setUploads(Array.isArray(res.data) ? res.data : res.data?.uploads || []);
    } catch (e: any) {
      setError(e.response?.data?.error || 'Failed to load uploads');
      setUploads([]);
    } finally {
      setLoading(false);
    }
  }, [selectedCategory, periodMonth]);

  useEffect(() => {
    if (viewMode === 'list') loadUploads();
  }, [loadUploads, viewMode]);

  // ── Load grid data ───────────────────────────────────────────────────────

  const loadGrid = useCallback(async () => {
    if (!selectedCategory) return;
    setLoading(true);
    setError('');
    try {
      const res = await api.get('/vcfo/uploads/grid', { params: { category: selectedCategory } });
      setGridData(res.data || {});
    } catch (e: any) {
      setError(e.response?.data?.error || 'Failed to load grid');
      setGridData({});
    } finally {
      setLoading(false);
    }
  }, [selectedCategory]);

  useEffect(() => {
    if (viewMode === 'grid') loadGrid();
  }, [loadGrid, viewMode]);

  // ── Load upload data ─────────────────────────────────────────────────────

  const loadUploadData = useCallback(async (uploadId: number) => {
    setLoading(true);
    setError('');
    setSelectedUploadId(uploadId);
    try {
      const res = await api.get(`/vcfo/uploads/data/${uploadId}`);
      setUploadData(res.data);
      setViewMode('data');
    } catch (e: any) {
      setError(e.response?.data?.error || 'Failed to load upload data');
    } finally {
      setLoading(false);
    }
  }, []);

  // ── Load analytics ───────────────────────────────────────────────────────

  const loadAnalytics = useCallback(async () => {
    if (!selectedCategory) return;
    setLoading(true);
    setError('');
    try {
      const params: any = { category: selectedCategory };
      if (analyticsFrom) params.fromDate = analyticsFrom;
      if (analyticsTo) params.toDate = analyticsTo;
      const res = await api.get('/vcfo/uploads/analytics', { params });
      setAnalytics(res.data);
    } catch (e: any) {
      setError(e.response?.data?.error || 'Failed to load analytics');
      setAnalytics(null);
    } finally {
      setLoading(false);
    }
  }, [selectedCategory, analyticsFrom, analyticsTo]);

  useEffect(() => {
    if (viewMode === 'analytics') loadAnalytics();
  }, [loadAnalytics, viewMode]);

  // ── Delete upload ────────────────────────────────────────────────────────

  const handleDelete = async (uploadId: number) => {
    if (!window.confirm('Delete this upload? This cannot be undone.')) return;
    try {
      await api.delete(`/vcfo/uploads/${uploadId}`);
      loadUploads();
      if (selectedUploadId === uploadId) {
        setUploadData(null);
        setViewMode('list');
      }
    } catch (e: any) {
      setError(e.response?.data?.error || 'Failed to delete upload');
    }
  };

  // ── Handle upload submit ─────────────────────────────────────────────────

  const handleUploadSubmit = async () => {
    setError('');
    const { category, periodMonth: pm, companyId, filename, jsonData } = uploadForm;
    if (!category || !pm) {
      setError('Category and Period Month are required');
      return;
    }
    let rows: any[] = [];
    let headers: string[] = [];
    try {
      const parsed = JSON.parse(jsonData || '[]');
      if (Array.isArray(parsed) && parsed.length > 0) {
        rows = parsed;
        headers = Object.keys(parsed[0]);
      }
    } catch {
      setError('Invalid JSON data. Please provide a valid JSON array.');
      return;
    }
    setLoading(true);
    try {
      await api.post('/vcfo/uploads/excel', {
        category,
        periodMonth: pm,
        companyId: companyId ? Number(companyId) : undefined,
        filename: filename || `upload-${pm}.json`,
        rows,
        headers,
      });
      setUploadForm({ category: '', periodMonth: '', companyId: '', filename: '', jsonData: '' });
      setViewMode('list');
      loadUploads();
    } catch (e: any) {
      setError(e.response?.data?.error || 'Upload failed');
    } finally {
      setLoading(false);
    }
  };

  // ── Helpers ──────────────────────────────────────────────────────────────

  const currentCat = categories.find(c => c.slug === selectedCategory);

  const viewTabs: { key: ViewMode; label: string; icon: React.ReactNode }[] = [
    { key: 'list', label: 'Uploads', icon: <FileSpreadsheet size={16} /> },
    { key: 'grid', label: 'Grid View', icon: <Database size={16} /> },
    { key: 'analytics', label: 'Analytics', icon: <BarChart3 size={16} /> },
    { key: 'upload', label: 'New Upload', icon: <Plus size={16} /> },
  ];

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-theme-heading flex items-center gap-2">
            <FileSpreadsheet size={28} /> Excel Uploads
          </h1>
          <p className="text-theme-muted text-sm mt-1">
            Manage uploaded data, view analytics, and track upload history
          </p>
        </div>
        <button
          onClick={() => { loadUploads(); loadGrid(); }}
          className="flex items-center gap-2 px-4 py-2 bg-dark-600 hover:bg-dark-500 text-theme-body rounded-lg transition"
        >
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {/* Category Selector + View Tabs */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
        <div className="relative">
          <select
            value={selectedCategory}
            onChange={e => { setSelectedCategory(e.target.value); setViewMode('list'); }}
            className="appearance-none bg-dark-700 border border-dark-500 text-theme-body rounded-lg px-4 py-2 pr-10 focus:ring-2 focus:ring-blue-500 focus:outline-none"
          >
            <option value="">Select Category</option>
            {categories.map(c => (
              <option key={c.slug} value={c.slug}>{c.display_name}</option>
            ))}
          </select>
          <ChevronDown size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-theme-muted pointer-events-none" />
        </div>

        {viewMode !== 'upload' && viewMode !== 'data' && (
          <input
            type="month"
            value={periodMonth}
            onChange={e => setPeriodMonth(e.target.value)}
            placeholder="Filter by month"
            className="bg-dark-700 border border-dark-500 text-theme-body rounded-lg px-4 py-2 focus:ring-2 focus:ring-blue-500 focus:outline-none"
          />
        )}

        <div className="flex bg-dark-700 rounded-lg p-1 gap-1">
          {viewTabs.map(tab => (
            <button
              key={tab.key}
              onClick={() => setViewMode(tab.key)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition ${
                viewMode === tab.key
                  ? 'bg-blue-600 text-white'
                  : 'text-theme-muted hover:text-theme-body hover:bg-dark-600'
              }`}
            >
              {tab.icon} {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Category description */}
      {currentCat && (
        <div className="bg-dark-700 rounded-xl p-4 border border-dark-500">
          <p className="text-theme-body text-sm">{currentCat.description}</p>
          {currentCat.expected_columns?.length > 0 && (
            <p className="text-theme-muted text-xs mt-2">
              Expected columns: {currentCat.expected_columns.join(', ')}
            </p>
          )}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="bg-red-900/30 border border-red-700 rounded-lg p-3 flex items-center justify-between">
          <span className="text-red-400 text-sm">{error}</span>
          <button onClick={() => setError('')}><X size={16} className="text-red-400" /></button>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-8">
          <RefreshCw size={24} className="animate-spin text-blue-500" />
          <span className="ml-3 text-theme-muted">Loading...</span>
        </div>
      )}

      {/* ── LIST VIEW ─────────────────────────────────────────────────────── */}
      {viewMode === 'list' && !loading && (
        <div className="bg-dark-700 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-dark-600">
                  <th className="text-left text-theme-muted font-medium px-4 py-3">Filename</th>
                  <th className="text-left text-theme-muted font-medium px-4 py-3">Period</th>
                  <th className="text-left text-theme-muted font-medium px-4 py-3">Company</th>
                  <th className="text-right text-theme-muted font-medium px-4 py-3">Rows</th>
                  <th className="text-left text-theme-muted font-medium px-4 py-3">Uploaded</th>
                  <th className="text-center text-theme-muted font-medium px-4 py-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {uploads.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="text-center text-theme-muted py-12">
                      No uploads found for this category
                    </td>
                  </tr>
                ) : (
                  uploads.map(u => (
                    <tr key={u.id} className="border-t border-dark-500 hover:bg-dark-600/50 transition">
                      <td className="px-4 py-3 text-theme-body font-medium">{u.filename}</td>
                      <td className="px-4 py-3 text-theme-body">{u.period_month}</td>
                      <td className="px-4 py-3 text-theme-muted">{u.company_name || '-'}</td>
                      <td className="px-4 py-3 text-right text-theme-body">{fmtNum(u.row_count)}</td>
                      <td className="px-4 py-3 text-theme-muted text-xs">
                        {u.created_at ? new Date(u.created_at).toLocaleDateString('en-IN') : '-'}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <div className="flex items-center justify-center gap-2">
                          <button
                            onClick={() => loadUploadData(u.id)}
                            className="p-1.5 rounded-md hover:bg-blue-900/30 text-blue-400 transition"
                            title="View data"
                          >
                            <Eye size={16} />
                          </button>
                          <button
                            onClick={() => handleDelete(u.id)}
                            className="p-1.5 rounded-md hover:bg-red-900/30 text-red-400 transition"
                            title="Delete"
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── GRID VIEW ─────────────────────────────────────────────────────── */}
      {viewMode === 'grid' && !loading && (
        <div className="bg-dark-700 rounded-xl overflow-hidden">
          <div className="px-4 py-3 bg-dark-600 border-b border-dark-500">
            <h3 className="text-theme-heading font-semibold flex items-center gap-2">
              <Database size={18} /> Period Grid
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-dark-600/50">
                  <th className="text-left text-theme-muted font-medium px-4 py-3">Period Month</th>
                  <th className="text-left text-theme-muted font-medium px-4 py-3">Filename</th>
                  <th className="text-right text-theme-muted font-medium px-4 py-3">Row Count</th>
                  <th className="text-left text-theme-muted font-medium px-4 py-3">Upload ID</th>
                  <th className="text-center text-theme-muted font-medium px-4 py-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {Object.keys(gridData).length === 0 ? (
                  <tr>
                    <td colSpan={5} className="text-center text-theme-muted py-12">
                      No grid data available
                    </td>
                  </tr>
                ) : (
                  Object.entries(gridData).map(([month, info]: [string, any]) => (
                    <tr key={month} className="border-t border-dark-500 hover:bg-dark-600/50 transition">
                      <td className="px-4 py-3 text-theme-body font-medium">
                        <span className="flex items-center gap-2">
                          <Calendar size={14} className="text-blue-400" /> {month}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-theme-body">{info.filename || '-'}</td>
                      <td className="px-4 py-3 text-right text-theme-body">{fmtNum(info.rowCount)}</td>
                      <td className="px-4 py-3 text-theme-muted">#{info.id}</td>
                      <td className="px-4 py-3 text-center">
                        <button
                          onClick={() => loadUploadData(info.id)}
                          className="p-1.5 rounded-md hover:bg-blue-900/30 text-blue-400 transition"
                          title="View data"
                        >
                          <Eye size={16} />
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── DATA VIEW ─────────────────────────────────────────────────────── */}
      {viewMode === 'data' && !loading && uploadData && (
        <div className="space-y-4">
          {/* Data header */}
          <div className="bg-dark-700 rounded-xl p-4 flex items-center justify-between">
            <div>
              <h3 className="text-theme-heading font-semibold">
                {uploadData.upload?.filename || 'Upload Data'}
              </h3>
              <p className="text-theme-muted text-sm mt-1">
                Period: {uploadData.upload?.period_month} | Rows: {fmtNum(uploadData.data?.length)}
              </p>
            </div>
            <button
              onClick={() => { setViewMode('list'); setUploadData(null); }}
              className="flex items-center gap-2 px-3 py-1.5 bg-dark-600 hover:bg-dark-500 text-theme-body rounded-lg transition text-sm"
            >
              <X size={14} /> Close
            </button>
          </div>

          {/* Data table */}
          <div className="bg-dark-700 rounded-xl overflow-hidden">
            <div className="overflow-x-auto max-h-[60vh] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0">
                  <tr className="bg-dark-600">
                    <th className="text-left text-theme-muted font-medium px-4 py-3">#</th>
                    {uploadData.data?.[0] &&
                      Object.keys(uploadData.data[0])
                        .filter(k => k !== 'row_num')
                        .map(col => (
                          <th key={col} className="text-left text-theme-muted font-medium px-4 py-3 whitespace-nowrap">
                            {col}
                          </th>
                        ))}
                  </tr>
                </thead>
                <tbody>
                  {uploadData.data?.map((row: any, idx: number) => (
                    <tr key={idx} className="border-t border-dark-500 hover:bg-dark-600/50 transition">
                      <td className="px-4 py-2 text-theme-muted">{row.row_num ?? idx + 1}</td>
                      {Object.entries(row)
                        .filter(([k]) => k !== 'row_num')
                        .map(([k, v]: [string, any]) => (
                          <td key={k} className="px-4 py-2 text-theme-body whitespace-nowrap">
                            {typeof v === 'number' ? v.toLocaleString('en-IN') : String(v ?? '')}
                          </td>
                        ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ── ANALYTICS VIEW ────────────────────────────────────────────────── */}
      {viewMode === 'analytics' && !loading && (
        <div className="space-y-6">
          {/* Date range filters */}
          <div className="flex items-center gap-4">
            <div>
              <label className="text-theme-muted text-xs mb-1 block">From</label>
              <input
                type="date"
                value={analyticsFrom}
                onChange={e => setAnalyticsFrom(e.target.value)}
                className="bg-dark-700 border border-dark-500 text-theme-body rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="text-theme-muted text-xs mb-1 block">To</label>
              <input
                type="date"
                value={analyticsTo}
                onChange={e => setAnalyticsTo(e.target.value)}
                className="bg-dark-700 border border-dark-500 text-theme-body rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none"
              />
            </div>
            <button
              onClick={loadAnalytics}
              className="mt-5 flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition text-sm"
            >
              <BarChart3 size={16} /> Load Analytics
            </button>
          </div>

          {analytics ? (
            <>
              {/* KPI Cards */}
              {analytics.kpis && (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                  {Object.entries(analytics.kpis).map(([key, value]: [string, any]) => (
                    <div key={key} className="bg-dark-700 rounded-xl p-5 border border-dark-500">
                      <p className="text-theme-muted text-xs uppercase tracking-wider mb-1">
                        {key.replace(/_/g, ' ')}
                      </p>
                      <p className="text-2xl font-bold text-theme-heading">
                        {typeof value === 'number' ? fmt(value) : String(value)}
                      </p>
                    </div>
                  ))}
                </div>
              )}

              {/* Department breakdown */}
              {analytics.departments && analytics.departments.length > 0 && (
                <div className="bg-dark-700 rounded-xl overflow-hidden">
                  <div className="px-4 py-3 bg-dark-600 border-b border-dark-500">
                    <h3 className="text-theme-heading font-semibold flex items-center gap-2">
                      <Users size={18} /> Department Breakdown
                    </h3>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-dark-600/50">
                          <th className="text-left text-theme-muted font-medium px-4 py-3">Department</th>
                          {analytics.departments[0] &&
                            Object.keys(analytics.departments[0])
                              .filter(k => k !== 'department' && k !== 'name')
                              .map(col => (
                                <th key={col} className="text-right text-theme-muted font-medium px-4 py-3">
                                  {col.replace(/_/g, ' ')}
                                </th>
                              ))}
                        </tr>
                      </thead>
                      <tbody>
                        {analytics.departments.map((dept: any, idx: number) => (
                          <tr key={idx} className="border-t border-dark-500 hover:bg-dark-600/50 transition">
                            <td className="px-4 py-3 text-theme-body font-medium">
                              {dept.department || dept.name}
                            </td>
                            {Object.entries(dept)
                              .filter(([k]) => k !== 'department' && k !== 'name')
                              .map(([k, v]: [string, any]) => (
                                <td key={k} className="px-4 py-3 text-right text-theme-body">
                                  {typeof v === 'number' ? fmt(v) : String(v ?? '')}
                                </td>
                              ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Weekly trend */}
              {analytics.weeklyTrend && analytics.weeklyTrend.length > 0 && (
                <div className="bg-dark-700 rounded-xl overflow-hidden">
                  <div className="px-4 py-3 bg-dark-600 border-b border-dark-500">
                    <h3 className="text-theme-heading font-semibold flex items-center gap-2">
                      <TrendingUp size={18} /> Weekly Trend
                    </h3>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-dark-600/50">
                          {analytics.weeklyTrend[0] &&
                            Object.keys(analytics.weeklyTrend[0]).map(col => (
                              <th key={col} className="text-left text-theme-muted font-medium px-4 py-3">
                                {col.replace(/_/g, ' ')}
                              </th>
                            ))}
                        </tr>
                      </thead>
                      <tbody>
                        {analytics.weeklyTrend.map((row: any, idx: number) => (
                          <tr key={idx} className="border-t border-dark-500 hover:bg-dark-600/50 transition">
                            {Object.values(row).map((v: any, ci: number) => (
                              <td key={ci} className="px-4 py-3 text-theme-body">
                                {typeof v === 'number' ? fmt(v) : String(v ?? '')}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Doctors */}
              {analytics.doctors && analytics.doctors.length > 0 && (
                <div className="bg-dark-700 rounded-xl overflow-hidden">
                  <div className="px-4 py-3 bg-dark-600 border-b border-dark-500">
                    <h3 className="text-theme-heading font-semibold flex items-center gap-2">
                      <Users size={18} /> Doctors
                    </h3>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-dark-600/50">
                          {analytics.doctors[0] &&
                            Object.keys(analytics.doctors[0]).map(col => (
                              <th key={col} className="text-left text-theme-muted font-medium px-4 py-3">
                                {col.replace(/_/g, ' ')}
                              </th>
                            ))}
                        </tr>
                      </thead>
                      <tbody>
                        {analytics.doctors.map((row: any, idx: number) => (
                          <tr key={idx} className="border-t border-dark-500 hover:bg-dark-600/50 transition">
                            {Object.values(row).map((v: any, ci: number) => (
                              <td key={ci} className="px-4 py-3 text-theme-body">
                                {typeof v === 'number' ? fmt(v) : String(v ?? '')}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          ) : (
            !loading && (
              <div className="bg-dark-700 rounded-xl p-12 text-center">
                <BarChart3 size={48} className="mx-auto text-theme-muted mb-4" />
                <p className="text-theme-muted">Select a date range and click "Load Analytics" to view insights</p>
              </div>
            )
          )}
        </div>
      )}

      {/* ── UPLOAD FORM ───────────────────────────────────────────────────── */}
      {viewMode === 'upload' && (
        <div className="bg-dark-700 rounded-xl p-6 max-w-2xl space-y-5">
          <h3 className="text-theme-heading font-semibold text-lg flex items-center gap-2">
            <Upload size={20} /> New Data Upload
          </h3>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Category */}
            <div>
              <label className="text-theme-muted text-xs mb-1 block">Category *</label>
              <select
                value={uploadForm.category}
                onChange={e => setUploadForm(f => ({ ...f, category: e.target.value }))}
                className="w-full bg-dark-600 border border-dark-500 text-theme-body rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none"
              >
                <option value="">Select category</option>
                {categories.map(c => (
                  <option key={c.slug} value={c.slug}>{c.display_name}</option>
                ))}
              </select>
            </div>

            {/* Period Month */}
            <div>
              <label className="text-theme-muted text-xs mb-1 block">Period Month *</label>
              <input
                type="month"
                value={uploadForm.periodMonth}
                onChange={e => setUploadForm(f => ({ ...f, periodMonth: e.target.value }))}
                className="w-full bg-dark-600 border border-dark-500 text-theme-body rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none"
              />
            </div>

            {/* Company */}
            <div>
              <label className="text-theme-muted text-xs mb-1 block">Company (optional)</label>
              <select
                value={uploadForm.companyId}
                onChange={e => setUploadForm(f => ({ ...f, companyId: e.target.value }))}
                className="w-full bg-dark-600 border border-dark-500 text-theme-body rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none"
              >
                <option value="">All companies</option>
                {companies.map(c => (
                  <option key={c.id} value={String(c.id)}>{c.name}</option>
                ))}
              </select>
            </div>

            {/* Filename */}
            <div>
              <label className="text-theme-muted text-xs mb-1 block">Filename</label>
              <input
                type="text"
                value={uploadForm.filename}
                onChange={e => setUploadForm(f => ({ ...f, filename: e.target.value }))}
                placeholder="e.g., payroll-mar-2026.json"
                className="w-full bg-dark-600 border border-dark-500 text-theme-body rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none"
              />
            </div>
          </div>

          {/* JSON data */}
          <div>
            <label className="text-theme-muted text-xs mb-1 block">
              Data (JSON array of objects) *
            </label>
            <textarea
              value={uploadForm.jsonData}
              onChange={e => setUploadForm(f => ({ ...f, jsonData: e.target.value }))}
              rows={10}
              placeholder={'[\n  {"department": "Clinic", "amount": 50000, "type": "Revenue"},\n  {"department": "Pharmacy", "amount": 30000, "type": "Revenue"}\n]'}
              className="w-full bg-dark-600 border border-dark-500 text-theme-body rounded-lg px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:outline-none resize-y"
            />
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={handleUploadSubmit}
              disabled={loading}
              className="flex items-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg transition text-sm font-medium"
            >
              <Upload size={16} /> Upload Data
            </button>
            <button
              onClick={() => setViewMode('list')}
              className="px-4 py-2.5 bg-dark-600 hover:bg-dark-500 text-theme-body rounded-lg transition text-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
