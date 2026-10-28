/**
 * Route guards (all read `useMe()`):
 *
 * - <SetupGate>: wraps every route. Until setup is complete everything redirects to
 *   /setup; afterwards /setup redirects to /.
 * - <RequireBooker>: /app/* → /login?next=… when there is no booker session.
 * - <RequireComedian>: guarded /portal/* → /portal/login?next=… without a comedian session.
 * - <RootRedirect>: / → /app (booker) or /portal (comedian) or /portal/login.
 *
 * /portal/magic/:token and /portal/confirm/:token are deliberately not behind
 * RequireComedian: they work from an emailed link without a session.
 */
import { RotateCw } from 'lucide-react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { errorMessage } from '../lib/api';
import { useMe } from '../lib/useMe';
import { Button } from './ui/Button';
import { PageSpinner } from './ui/Spinner';

/** Only same-app paths are allowed as `?next=` targets. */
export function safeNext(value: string | null | undefined, fallback: string): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return fallback;
  return value;
}

/** The `?next=` target from the current URL, sanitized. */
export function useNextPath(fallback: string): string {
  const { search } = useLocation();
  return safeNext(new URLSearchParams(search).get('next'), fallback);
}

function signInPath(loginPath: string, location: { pathname: string; search: string }): string {
  const next = `${location.pathname}${location.search}`;
  return `${loginPath}?next=${encodeURIComponent(next)}`;
}

export function SetupGate() {
  const { data: me, error, isPending, refetch, isFetching } = useMe();
  const location = useLocation();

  if (isPending) return <PageSpinner className="min-h-dvh" />;
  // Only block on the very first load; a failed background refetch keeps the cached `me`.
  if (!me) {
    return (
      <div role="alert" className="flex min-h-dvh flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="font-medium text-fg">Can't reach the server.</p>
        <p className="text-sm text-fg-muted">{errorMessage(error)}</p>
        <Button variant="secondary" onClick={() => void refetch()} loading={isFetching}>
          <RotateCw /> Try again
        </Button>
      </div>
    );
  }

  const onSetup = location.pathname === '/setup';
  if (!me.setupComplete && !onSetup) return <Navigate to="/setup" replace />;
  if (me.setupComplete && onSetup) return <Navigate to="/" replace />;
  return <Outlet />;
}

export function RequireBooker() {
  const { data: me } = useMe();
  const location = useLocation();
  if (!me?.booker) return <Navigate to={signInPath('/login', location)} replace />;
  return <Outlet />;
}

export function RequireComedian() {
  const { data: me } = useMe();
  const location = useLocation();
  if (!me?.comedian) return <Navigate to={signInPath('/portal/login', location)} replace />;
  return <Outlet />;
}

export function RootRedirect() {
  const { data: me } = useMe();
  if (me?.booker) return <Navigate to="/app" replace />;
  if (me?.comedian) return <Navigate to="/portal" replace />;
  return <Navigate to="/portal/login" replace />;
}
