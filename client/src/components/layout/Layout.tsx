import { useState, useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Menu, BarChart3 } from 'lucide-react';
import Sidebar from './Sidebar';

export default function Layout() {
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
          <div className="sticky top-0 z-30 flex items-center gap-3 px-4 py-3 bg-dark-800/95 backdrop-blur border-b border-dark-400/30">
            <button
              onClick={() => setMobileOpen(true)}
              className="p-1.5 rounded-lg text-theme-muted hover:text-theme-primary hover:bg-dark-600 transition-colors"
              aria-label="Open menu"
            >
              <Menu size={20} />
            </button>
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-accent-500 flex items-center justify-center">
                <BarChart3 size={14} className="text-white" />
              </div>
              <span className="text-sm font-bold text-theme-heading">Vision</span>
            </div>
          </div>
        )}
        <div className={isMobile ? 'p-4' : 'p-8'}>
          <Outlet />
        </div>
      </main>
    </div>
  );
}
