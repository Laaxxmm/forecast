import { useState, useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Menu, BarChart3, HelpCircle } from 'lucide-react';
import Sidebar from './Sidebar';
import { TourProvider, useTour } from '../../contexts/TourContext';
import { getTourSteps, getPageKey } from '../../config/tourSteps';

export default function Layout() {
  return (
    <TourProvider>
      <LayoutInner />
    </TourProvider>
  );
}

function LayoutInner() {
  const [sidebarExpanded, setSidebarExpanded] = useState(false);
  const [sidebarPinned, setSidebarPinned] = useState(() => {
    return localStorage.getItem('sidebar_pinned') === '1';
  });
  const [mobileOpen, setMobileOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(
    typeof window !== 'undefined' ? window.innerWidth < 768 : false
  );
  const location = useLocation();

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  // Close mobile drawer on navigation
  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  // Persist pin preference
  useEffect(() => {
    localStorage.setItem('sidebar_pinned', sidebarPinned ? '1' : '0');
  }, [sidebarPinned]);

  const effectiveExpanded = sidebarPinned || sidebarExpanded;

  const { startTour, hasPageSeen, markPageSeen } = useTour();
  const pageKey = getPageKey(location.pathname);

  const handleHelp = () => {
    const key = pageKey || 'global';
    const steps = getTourSteps(key);
    startTour(steps);
    markPageSeen(key);
  };

  // Auto-prompt on first visit (only once ever)
  useEffect(() => {
    if (!localStorage.getItem('tour_seen_global')) {
      const timer = setTimeout(() => {
        const steps = getTourSteps(pageKey || 'global');
        startTour(steps);
        localStorage.setItem('tour_seen_global', '1');
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex min-h-screen bg-dark-900 text-theme-primary">
      {/* Mobile backdrop */}
      {isMobile && mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
          onClick={() => setMobileOpen(false)}
        />
      )}

      <Sidebar
        expanded={isMobile ? true : effectiveExpanded}
        onExpandedChange={isMobile ? () => {} : setSidebarExpanded}
        pinned={sidebarPinned}
        onPinnedChange={setSidebarPinned}
        isMobile={isMobile}
        mobileOpen={mobileOpen}
        onMobileClose={() => setMobileOpen(false)}
      />

      <main
        className={`flex-1 min-w-0 transition-all duration-200 ${
          isMobile ? 'ml-0' : effectiveExpanded ? 'ml-56' : 'ml-16'
        }`}
      >
        {/* Mobile top bar */}
        {isMobile && (
          <div className="sticky top-0 z-30 flex items-center gap-3 px-4 py-3 surface-glass border-b">
            <button
              onClick={() => setMobileOpen(true)}
              className="p-1.5 rounded-lg text-theme-muted hover:text-theme-primary hover:bg-dark-600 transition-colors"
              aria-label="Open menu"
            >
              <Menu size={20} />
            </button>
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-accent-gradient flex items-center justify-center shadow-glow ring-1 ring-accent-400/30">
                <BarChart3 size={14} className="text-white" />
              </div>
              <span className="text-sm font-bold text-theme-heading tracking-tight">Vision</span>
            </div>
          </div>
        )}
        <div className={isMobile ? 'p-4' : 'p-8'}>
          <Outlet />
        </div>
        {/* Floating help button */}
        <button
          onClick={handleHelp}
          data-tour="help-button"
          className="fixed bottom-6 right-6 z-30 w-11 h-11 rounded-full bg-accent-gradient text-white shadow-glow-soft hover:scale-110 hover:shadow-glow-lg flex items-center justify-center transition-all duration-200 ring-1 ring-accent-400/30"
          title="Take a guided tour"
        >
          <HelpCircle size={18} />
        </button>
      </main>
    </div>
  );
}
