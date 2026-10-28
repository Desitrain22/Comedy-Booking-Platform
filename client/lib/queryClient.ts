/**
 * The app's TanStack Query client.
 *
 * Query keys are arrays starting with the API path segment (spec §3), e.g.
 * `['days', date]`, `['shows', from, to]`, `['comedians']`, `['auth', 'me']`.
 * Mutations invalidate the keys they affect.
 *
 * Global behavior:
 * - A 401 from any query or mutation refetches `['auth', 'me']`, so the route guards
 *   send the user to the right sign-in page when a session expires.
 * - A mutation that fails and has no `onError` of its own shows an error toast.
 *   Opt out with `meta: { silent: true }`.
 * - 4xx responses are never retried.
 */
import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ApiError, errorMessage } from './api';

declare module '@tanstack/react-query' {
  interface Register {
    mutationMeta: { silent?: boolean };
  }
}

export const ME_QUERY_KEY = ['auth', 'me'] as const;

function handleUnauthorized(err: unknown): void {
  if (err instanceof ApiError && err.status === 401) {
    void queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
  }
}

export const queryClient: QueryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (err, query) => {
      // /auth/me itself never 401s; avoid loops for any other auth query.
      if (query.queryKey[0] !== 'auth') handleUnauthorized(err);
    },
  }),
  mutationCache: new MutationCache({
    onError: (err, _variables, _context, mutation) => {
      handleUnauthorized(err);
      if (mutation.options.onError || mutation.meta?.silent) return;
      if (err instanceof ApiError && err.status === 401) return;
      toast.error(errorMessage(err));
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      retry: (failureCount, err) => {
        if (err instanceof ApiError && err.status < 500) return false;
        return failureCount < 2;
      },
    },
    mutations: {
      retry: false,
    },
  },
});
