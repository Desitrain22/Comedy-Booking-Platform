/**
 * Who is signed in. `GET /api/auth/me` → `{ booker, comedian, setupComplete, club }`,
 * cached under `['auth', 'me']`.
 *
 *   const { data: me } = useMe();          // anywhere (may be loading)
 *   const booker = useBooker();            // inside /app/* (guarded: never null)
 *   const comedian = useComedian();        // inside guarded /portal/* routes
 *   const club = useClub();                // { name, timezone, allNight }
 *   const refreshMe = useRefreshMe();      // after sign-in: await refreshMe()
 *   const signOut = useSignOut('booker');  // await signOut() → reloads on the sign-in page
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import type { ClubInfo, MeBooker, MeComedian, MeResponse, SessionKind } from '../../shared/types';
import { api } from './api';
import { ME_QUERY_KEY } from './queryClient';

export { ME_QUERY_KEY };

export function fetchMe(signal?: AbortSignal): Promise<MeResponse> {
  return api.get<MeResponse>('/auth/me', { signal });
}

export function useMe() {
  return useQuery({
    queryKey: ME_QUERY_KEY,
    queryFn: ({ signal }) => fetchMe(signal),
    staleTime: 5 * 60_000,
  });
}

/** The signed-in booker. Only use under the booker route guard (throws otherwise). */
export function useBooker(): MeBooker {
  const { data } = useMe();
  if (!data?.booker) throw new Error('useBooker() used outside the booker route guard');
  return data.booker;
}

/** The signed-in comedian. Only use under the portal route guard (throws otherwise). */
export function useComedian(): MeComedian {
  const { data } = useMe();
  if (!data?.comedian) throw new Error('useComedian() used outside the portal route guard');
  return data.comedian;
}

/** Public club info (name, timezone, all-night range); undefined while loading. */
export function useClub(): ClubInfo | undefined {
  return useMe().data?.club;
}

/** Refetch `/auth/me` now and resolve with the fresh value (use right after sign-in). */
export function useRefreshMe(): () => Promise<MeResponse> {
  const queryClient = useQueryClient();
  return useCallback(
    () => queryClient.fetchQuery({ queryKey: ME_QUERY_KEY, queryFn: ({ signal }) => fetchMe(signal), staleTime: 0 }),
    [queryClient],
  );
}

const SIGN_OUT: Record<SessionKind, { path: string; redirect: string }> = {
  booker: { path: '/auth/logout', redirect: '/login' },
  comedian: { path: '/auth/comedian/logout', redirect: '/portal/login' },
};

/**
 * Sign out of one session kind (the other cookie is untouched) and load that kind's
 * sign-in page. A full page load (not a client-side navigate) so no cached data
 * survives and the route guards never see a half-signed-out state.
 */
export function useSignOut(kind: SessionKind): () => Promise<void> {
  return useCallback(async () => {
    const { path, redirect } = SIGN_OUT[kind];
    try {
      await api.post(path);
    } finally {
      window.location.replace(redirect);
    }
  }, [kind]);
}
