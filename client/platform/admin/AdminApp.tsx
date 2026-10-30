/**
 * The owner console (hosted MVP spec §6), under `/admin` on the platform host:
 *
 *   /admin/login        email, then the 6-digit code
 *   /admin              totals and the clubs (table; stacked cards on phones)
 *   /admin/clubs/:id    one club: bookers, usage, failed emails, history, actions
 *
 * Everything but /admin/login needs an owner session; without one it goes to the sign-in page
 * and comes back afterwards.
 */
import { LogOut, ShieldCheck } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router';
import { Button, PageSpinner } from '../../components/ui';
import { api } from '../../lib/api';
import { usePlatformHost } from '../PlatformApp';
import { useAdminMe, useWatchAdminSession } from './adminApi';
import { AdminClubPage } from './AdminClubPage';
import { AdminLoginPage } from './AdminLoginPage';
import { AdminOverviewPage } from './AdminOverviewPage';

export function AdminApp() {
  useWatchAdminSession();
  return (
    <Routes>
      <Route path="login" element={<AdminLoginPage />} />
      <Route element={<RequireOwner />}>
        <Route index element={<AdminOverviewPage />} />
        <Route path="clubs/:id" element={<AdminClubPage />} />
        <Route path="*" element={<Navigate to="/admin" replace />} />
      </Route>
    </Routes>
  );
}

function RequireOwner() {
  const me = useAdminMe();
  const location = useLocation();
  if (me.isPending) return <PageSpinner className="min-h-dvh" />;
  if (!me.data?.admin) {
    const next = `${location.pathname}${location.search}`;
    const to = next === '/admin' || next === '/admin/' ? '/admin/login' : `/admin/login?next=${encodeURIComponent(next)}`;
    return <Navigate to={to} replace />;
  }
  return (
    <AdminLayout email={me.data.admin.email}>
      <Outlet />
    </AdminLayout>
  );
}

function AdminLayout({ email, children }: { email: string; children: ReactNode }) {
  const host = usePlatformHost();
  const [signingOut, setSigningOut] = useState(false);

  async function signOut() {
    setSigningOut(true);
    try {
      await api.post('/platform/admin/logout');
    } finally {
      // A full load: no console data survives in the cache.
      window.location.replace('/admin/login');
    }
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 border-b border-border bg-surface">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4">
          <a href="/admin" className="flex min-w-0 items-center gap-2 text-fg">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent-solid text-accent-solid-fg">
              <ShieldCheck className="size-4" aria-hidden />
            </span>
            <span className="truncate text-sm font-semibold">{host.platformName}</span>
            <span className="hidden text-sm text-fg-muted sm:inline">· Owner console</span>
          </a>
          <div className="ml-auto flex min-w-0 items-center gap-2">
            <span className="hidden truncate text-sm text-fg-muted md:inline" title={email}>
              {email}
            </span>
            <Button variant="ghost" size="sm" onClick={() => void signOut()} loading={signingOut}>
              <LogOut aria-hidden /> Sign out
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl min-w-0 flex-1 px-4 py-5 sm:py-6">{children}</main>
    </div>
  );
}
