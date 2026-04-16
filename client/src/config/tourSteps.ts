export interface TourStep {
  target: string;       // data-tour attribute value
  title: string;
  content: string;
  placement?: 'top' | 'bottom' | 'left' | 'right' | 'auto';
}

export const TOUR_STEPS: Record<string, TourStep[]> = {
  global: [
    {
      target: 'sidebar-nav',
      title: 'Navigation',
      content: 'Use the sidebar to navigate between Actuals, Forecast, Analysis, and more. Hover to expand, or pin it open.',
      placement: 'right',
    },
    {
      target: 'sidebar-pin',
      title: 'Pin Sidebar',
      content: 'Click here to pin the sidebar open. When unpinned, it collapses automatically when you move away.',
      placement: 'right',
    },
    {
      target: 'theme-toggle',
      title: 'Light / Dark Mode',
      content: 'Switch between light and dark themes to suit your preference.',
      placement: 'right',
    },
    {
      target: 'help-button',
      title: 'Need Help?',
      content: 'You can restart this tour anytime by clicking this help button.',
      placement: 'top',
    },
  ],
  forecast: [
    {
      target: 'forecast-tabs',
      title: 'Financial Views',
      content: 'Switch between Overview, Financial Tables, Profit & Loss, Balance Sheet, Cash Flow, and Budget vs Actual reports.',
      placement: 'bottom',
    },
    {
      target: 'view-mode',
      title: 'View Mode',
      content: 'Toggle between a yearly summary and detailed monthly breakdown of your financial data.',
      placement: 'bottom',
    },
    {
      target: 'scenario-select',
      title: 'Scenarios',
      content: 'Create and switch between different forecast scenarios to compare projections and plan for various outcomes.',
      placement: 'bottom',
    },
    {
      target: 'fy-select',
      title: 'Financial Year',
      content: 'Select which financial year to view. Use the arrow buttons to quickly navigate between years.',
      placement: 'bottom',
    },
    {
      target: 'print-button',
      title: 'Download & Print',
      content: 'Generate professional financial reports as PDF — including P&L, Balance Sheet, and Cash Flow statements.',
      placement: 'bottom',
    },
  ],
  analysis: [
    {
      target: 'analysis-tabs',
      title: 'Analysis Reports',
      content: 'Explore different analytical views — Overview, Trends, P&L comparison, Balance Sheet, Cash Flow, Monthly Review, and more.',
      placement: 'bottom',
    },
  ],
  actuals: [
    {
      target: 'kpi-cards',
      title: 'Key Metrics',
      content: 'Your key financial metrics at a glance. Click any stream card to drill into detailed analytics for that revenue stream.',
      placement: 'bottom',
    },
    {
      target: 'period-filter',
      title: 'Time Period',
      content: 'Filter your dashboard data by different time periods — current month, quarter, year-to-date, or full financial year.',
      placement: 'bottom',
    },
  ],
};

export function getTourSteps(pageKey: string): TourStep[] {
  return [...(TOUR_STEPS.global || []), ...(TOUR_STEPS[pageKey] || [])];
}

export function getPageKey(pathname: string): string | null {
  if (pathname.startsWith('/forecast')) return 'forecast';
  if (pathname.startsWith('/analysis')) return 'analysis';
  if (pathname === '/actuals') return 'actuals';
  return null;
}
