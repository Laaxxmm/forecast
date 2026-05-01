import { useEffect, useState } from 'react';
import { Routes, Route, NavLink, Navigate } from 'react-router-dom';
import { ListChecks, GitCompare, Sliders, FileDown } from 'lucide-react';
import api from '../api/client';
import { FY, Scenario } from './ForecastModulePage';
import ScenarioListPanel from '../components/scenario-analysis/ScenarioListPanel';
import CompareView from './scenario-analysis/CompareView';
import WhatIfView from './scenario-analysis/WhatIfView';
import ReportView from './scenario-analysis/ReportView';

const tabs = [
  { path: 'manage', label: 'Manage', icon: ListChecks },
  { path: 'compare', label: 'Compare', icon: GitCompare },
  { path: 'what-if', label: 'What-if', icon: Sliders },
  { path: 'report', label: 'Report', icon: FileDown },
];

export default function ScenarioAnalysisPage() {
  const [fys, setFYs] = useState<FY[]>([]);
  const [selectedFY, setSelectedFY] = useState<FY | null>(null);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);

  // Single-branch tenants don't have a branch picker at all — they're
  // implicitly scoped to their lone branch. Only treat the view as
  // "all branches" for multi-branch tenants who haven't picked one yet.
  // (Same convention as ForecastModulePage's `isMultiBranchAllView`.)
  const isMultiBranch = typeof window !== 'undefined'
    && localStorage.getItem('is_multi_branch') === '1';
  const isAllBranches = isMultiBranch && !localStorage.getItem('branch_id');
  const isAllStreams = !localStorage.getItem('stream_id');
  const isConsolidated = isAllBranches || isAllStreams;
  const branchName = (typeof window !== 'undefined' && localStorage.getItem('branch_name')) || '';
  const streamName = (typeof window !== 'undefined' && localStorage.getItem('stream_name')) || '';

  useEffect(() => {
    api.get('/settings/fy').then(res => {
      setFYs(res.data);
      const active = res.data.find((f: FY) => f.is_active);
      if (active) setSelectedFY(active);
      else if (res.data.length) setSelectedFY(res.data[0]);
    });
  }, []);

  const reloadScenarios = () => {
    if (!selectedFY || isConsolidated) return;
    api.get('/forecast-module/scenarios', { params: { fy_id: selectedFY.id } })
      .then(res => setScenarios(res.data))
      .catch(() => setScenarios([]));
  };

  useEffect(() => {
    reloadScenarios();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFY, isConsolidated]);

  return (
    <div className="scenario-analysis-module animate-fade-in">
      {/* Top Navigation */}
      <div
        className="-mx-4 -mt-4 px-4 md:-mx-8 md:-mt-8 md:px-8 mb-0"
        style={{ background: 'var(--mt-bg-raised)', borderBottom: '1px solid var(--mt-border)' }}
      >
        <div className="flex flex-col md:flex-row md:items-center md:justify-between">
          <div className="flex overflow-x-auto scrollbar-hide">
            {tabs.map(tab => (
              <NavLink
                key={tab.path}
                to={`/scenario-analysis/${tab.path}`}
                className={({ isActive }) => `mt-tab${isActive ? ' mt-tab--active' : ''}`}
              >
                <tab.icon size={15} />
                {tab.label}
              </NavLink>
            ))}
          </div>
          <div className="flex items-center gap-2 md:gap-3 pb-2 md:pb-0 px-1 md:px-0 flex-shrink-0">
            {streamName && !isAllStreams && !isAllBranches && (
              <span className="mt-pill mt-pill--success">
                {branchName ? `${branchName} · ${streamName}` : streamName}
              </span>
            )}
            <select
              value={selectedFY?.id || ''}
              onChange={e => {
                const fy = fys.find(f => f.id === Number(e.target.value));
                if (fy) setSelectedFY(fy);
              }}
              className="mt-input"
              style={{ padding: '6px 10px', fontSize: 12, width: '9rem' }}
            >
              {fys.map(fy => <option key={fy.id} value={fy.id}>{fy.label}</option>)}
            </select>
          </div>
        </div>
      </div>

      {/* Consolidated-mode banner — scenario analysis is single-branch/stream only in v1 */}
      {isConsolidated && (
        <div
          className="mt-4 px-4 py-3 rounded-lg flex items-center gap-3 text-sm"
          style={{
            background: 'color-mix(in srgb, #f59e0b 12%, transparent)',
            border: '1px solid color-mix(in srgb, #f59e0b 35%, transparent)',
            color: 'var(--mt-text-heading)',
          }}
        >
          <span style={{ fontSize: 18, lineHeight: 1, color: '#f59e0b' }}>⚠</span>
          <div>
            <div style={{ fontWeight: 600 }}>Pick a specific branch and stream to use Scenario Analysis</div>
            <div style={{ color: 'var(--mt-text-muted)', marginTop: 2 }}>
              Scenarios are scoped to a single branch & stream. Switch from "All Branches" / "All Streams" using the selectors in the sidebar.
            </div>
          </div>
        </div>
      )}

      {/* Content */}
      <div className="mt-4 md:mt-6">
        <Routes>
          <Route index element={<Navigate to="manage" replace />} />
          <Route
            path="manage"
            element={
              <ScenarioListPanel
                disabled={isConsolidated}
                fy={selectedFY}
                scenarios={scenarios}
                onReload={reloadScenarios}
              />
            }
          />
          <Route
            path="compare"
            element={<CompareView disabled={isConsolidated} fy={selectedFY} scenarios={scenarios} />}
          />
          <Route
            path="what-if"
            element={<WhatIfView disabled={isConsolidated} fy={selectedFY} scenarios={scenarios} />}
          />
          <Route
            path="report"
            element={<ReportView disabled={isConsolidated} fy={selectedFY} scenarios={scenarios} />}
          />
        </Routes>
      </div>
    </div>
  );
}
