import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';

export default function Layout() {
  const [sidebarExpanded, setSidebarExpanded] = useState(false);

  return (
    <div className="flex min-h-screen bg-dark-900">
      <Sidebar expanded={sidebarExpanded} onExpandedChange={setSidebarExpanded} />
      <main className={`flex-1 p-8 transition-all duration-200 ${sidebarExpanded ? 'ml-56' : 'ml-16'}`}>
        <Outlet />
      </main>
    </div>
  );
}
