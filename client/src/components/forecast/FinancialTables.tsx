import { NavLink, Routes, Route, Navigate } from 'react-router-dom';
import { Scenario, ForecastItem } from '../../pages/ForecastModulePage';
import CategoryTab from './CategoryTab';

const subTabs = [
  { path: 'revenue', label: 'Revenue', category: 'revenue' },
  { path: 'direct-costs', label: 'Direct Costs', category: 'direct_costs' },
  { path: 'personnel', label: 'Personnel', category: 'personnel' },
  { path: 'expenses', label: 'Expenses', category: 'expenses' },
  { path: 'assets', label: 'Assets', category: 'assets' },
  { path: 'taxes', label: 'Taxes', category: 'taxes' },
  { path: 'dividends', label: 'Dividends', category: 'dividends' },
  { path: 'cash-flow-assumptions', label: 'Cash Flow Assumptions', category: 'cash_flow_assumptions' },
  { path: 'initial-balances', label: 'Initial Balances', category: 'initial_balances' },
  { path: 'financing', label: 'Financing', category: 'financing' },
];

interface Props {
  scenario: Scenario | null;
  months: string[];
  viewMode: 'monthly' | 'yearly';
  items: ForecastItem[];
  allValues: Record<number, Record<string, number>>;
  settings: Record<string, any>;
  onReload: () => Promise<void>;
}

export default function FinancialTables({ scenario, months, viewMode, items, allValues, settings, onReload }: Props) {
  return (
    <div>
      {/* Sub-tabs */}
      <div className="flex gap-1 overflow-x-auto pb-2 mb-4 border-b border-dark-400/50 -mx-6 px-6">
        {subTabs.map(tab => (
          <NavLink
            key={tab.path}
            to={`/forecast/tables/${tab.path}`}
            className={({ isActive }) =>
              `px-4 py-2 text-xs font-medium rounded-t-lg whitespace-nowrap border-b-2 transition-colors ${
                isActive
                  ? 'border-accent-500 text-accent-400 bg-accent-500/10/50'
                  : 'border-transparent text-slate-500 hover:text-slate-300 hover:bg-dark-600'
              }`
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </div>

      <Routes>
        <Route index element={<Navigate to="revenue" replace />} />
        {subTabs.map(tab => (
          <Route
            key={tab.path}
            path={tab.path}
            element={
              <CategoryTab
                category={tab.category}
                label={tab.label}
                scenario={scenario}
                months={months}
                viewMode={viewMode}
                items={items.filter(i => i.category === tab.category)}
                allItems={items}
                allValues={allValues}
                settings={settings}
                onReload={onReload}
              />
            }
          />
        ))}
      </Routes>
    </div>
  );
}
