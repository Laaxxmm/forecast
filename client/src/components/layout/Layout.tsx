import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';

export default function Layout() {
  return (
    <div className="flex min-h-screen bg-dark-900">
      <Sidebar />
      <main className="flex-1 ml-16 p-8 transition-all duration-200">
        <Outlet />
      </main>
    </div>
  );
}
