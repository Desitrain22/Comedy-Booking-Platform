/**
 * `GET /api/onboarding` under `['onboarding']`: the one source of truth for the setup guide,
 * the welcome tour and the dashboard's Getting started card.
 *
 * The guide advances on data, so this refetches whenever something it depends on may have
 * changed: after any successful mutation, when a related query (`['shows']`, `['comedians']`,
 * `['dashboard']`, settings…) is invalidated, and on route changes (the provider). Never on a
 * timer.
 */
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { OnboardingResponse } from '../../../shared/api/onboarding';
import { api } from '../../lib/api';

export const ONBOARDING_KEY = ['onboarding'] as const;

export function useOnboarding() {
  return useQuery({
    queryKey: ONBOARDING_KEY,
    queryFn: ({ signal }) => api.get<OnboardingResponse>('/onboarding', { signal }),
    staleTime: 15_000,
  });
}

export type GuideServerAction = 'dismiss' | 'resume' | 'complete';

/** Skip / resume / finish (per booker). The response is the fresh onboarding state. */
export function useGuideServerAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: ONBOARDING_KEY,
    mutationFn: (action: GuideServerAction) => api.post<OnboardingResponse>(`/onboarding/${action}`),
    onSuccess: (data) => queryClient.setQueryData(ONBOARDING_KEY, data),
  });
}

/** Query families whose invalidation can move a guide step (club data). */
const RELATED_KEYS = new Set<unknown>([
  'shows',
  'comedians',
  'dashboard',
  'availability-requests',
  'settings',
  'locations',
  'users',
]);

/** Refetch the onboarding state now (in-flight fetches are reused, not restarted). */
export function refreshOnboarding(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: ONBOARDING_KEY }, { cancelRefetch: false });
}

/**
 * Keep `['onboarding']` in step with the club's data (see the file comment) while `enabled`
 * (the guide is running or a setup step is left; a set-up club doesn't pay for it).
 */
export function useOnboardingAutoRefresh(enabled: boolean): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    // Coalesce bursts (a mutation usually invalidates several keys at once).
    let queued = false;
    const refresh = () => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        refreshOnboarding(queryClient);
      });
    };
    const unsubscribeQueries = queryClient.getQueryCache().subscribe((event) => {
      if (event.type === 'updated' && event.action.type === 'invalidate' && RELATED_KEYS.has(event.query.queryKey[0])) {
        refresh();
      }
    });
    const unsubscribeMutations = queryClient.getMutationCache().subscribe((event) => {
      if (event.type !== 'updated' || event.action.type !== 'success') return;
      if (event.mutation.options.mutationKey?.[0] === ONBOARDING_KEY[0]) return;
      refresh();
    });
    return () => {
      unsubscribeQueries();
      unsubscribeMutations();
    };
  }, [queryClient, enabled]);
}
