/**
 * Before any routing: what is this host? (`GET /api/host`, client/lib/host.tsx)
 *
 *   single club (self-hosted)        → the club app (App.tsx), as always
 *   hosted, an active club           → the club app
 *   hosted, a suspended club         → "This account is paused" (every path)
 *   hosted, no club here (404)       → "There's no club at this address"
 *   hosted, the platform site        → PlatformApp (landing, sign-up, find my club, /admin)
 *
 * A club suspended or archived while someone is using it: the next API call answers 403
 * `club_suspended` / 404 `club_not_found`, which refetches the host and swaps the page.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCw } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { createBrowserRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import type { ClubNotFoundBody, HostContext } from '../shared/api/platform';
import { App } from './App';
import { Button, PageSpinner } from './components/ui';
import { ApiError, errorMessage, isApiError } from './lib/api';
import { fetchHost, HOST_QUERY_KEY, HostProvider } from './lib/host';
import { NoClubPage } from './pages/hosted/NoClubPage';
import { PausedPage } from './pages/hosted/PausedPage';
import { PlatformApp } from './platform/PlatformApp';

type Router = ReturnType<typeof createBrowserRouter>;
const routers = new Map<'club' | 'platform', Router>();

/**
 * A data router (so pages can block navigation) with one splat route rendering `element`.
 * Made once per page load, outside React: a router listens to the browser history from the
 * moment it exists, so a second one (StrictMode runs state initializers twice) would too.
 */
function routerFor(kind: 'club' | 'platform', element: () => ReactNode): Router {
  let router = routers.get(kind);
  if (!router) {
    router = createBrowserRouter([{ path: '*', element: element() }]);
    routers.set(kind, router);
  }
  return router;
}

function ClubRouter() {
  return <RouterProvider router={routerFor('club', () => <App />)} />;
}

function PlatformRouter() {
  return <RouterProvider router={routerFor('platform', () => <PlatformApp />)} />;
}

const HOST_GONE = new Set(['club_suspended', 'club_not_found']);

/** Refetch the host when any API call says this club was suspended or removed. */
function useWatchForHostChanges() {
  const queryClient = useQueryClient();
  useEffect(() => {
    const check = (error: unknown) => {
      if (error instanceof ApiError && error.code && HOST_GONE.has(error.code)) {
        void queryClient.invalidateQueries({ queryKey: HOST_QUERY_KEY });
      }
    };
    const queries = queryClient.getQueryCache().subscribe((event) => {
      if (event.type === 'updated' && event.action.type === 'error' && event.query.queryKey[0] !== HOST_QUERY_KEY[0]) {
        check(event.action.error);
      }
    });
    const mutations = queryClient.getMutationCache().subscribe((event) => {
      if (event.type === 'updated' && event.action.type === 'error') check(event.action.error);
    });
    return () => {
      queries();
      mutations();
    };
  }, [queryClient]);
}

export function HostGate() {
  useWatchForHostChanges();
  const host = useQuery<HostContext>({
    queryKey: HOST_QUERY_KEY,
    queryFn: ({ signal }) => fetchHost(signal),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  if (isApiError(host.error, 'club_not_found')) {
    return <NoClubPage platform={host.error.body as Partial<ClubNotFoundBody>} />;
  }
  if (!host.data) {
    if (host.isPending) return <PageSpinner className="min-h-dvh" />;
    return (
      <div role="alert" className="flex min-h-dvh flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="font-medium text-fg">Can't reach the server.</p>
        <p className="text-sm text-fg-muted">{errorMessage(host.error)}</p>
        <Button variant="secondary" onClick={() => void host.refetch()} loading={host.isFetching}>
          <RotateCw /> Try again
        </Button>
      </div>
    );
  }

  const context = host.data;
  if (context.mode === 'club' && context.status === 'suspended') return <PausedPage host={context} />;
  return (
    <HostProvider value={context}>{context.mode === 'platform' ? <PlatformRouter /> : <ClubRouter />}</HostProvider>
  );
}
