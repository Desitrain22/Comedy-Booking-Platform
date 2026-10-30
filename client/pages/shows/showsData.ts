/**
 * F1 data layer: TanStack Query hooks for shows and locations, shared by the month
 * calendar (/app/calendar) and the create-shows painter (/app/shows/new).
 *
 * Keys (spec §3): `['shows', from, to]` for a range, `['shows', 'detail', id]` for one
 * show, `['shows', 'copy-pattern', …]` for a preview, `['locations']` for active locations.
 * Every show mutation invalidates `['shows']`, `['days']` and `['dashboard']`, so the
 * day view (F2) and dashboard (F5) pick up the change.
 */
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type {
  BulkCreateShowsInput,
  BulkCreateShowsResponse,
  CopyPatternInput,
  CopyPatternResponse,
  ShowDetail,
  ShowDto,
  UpdateShowInput,
  UpdateShowResponse,
} from '../../../shared/api/shows';
import { firstDayOfMonth, isValidMonth, lastDayOfMonth, monthOf, todayInTz } from '../../../shared/time';
import type { Location, OkResponse } from '../../../shared/types';
import { api } from '../../lib/api';
import { useClub } from '../../lib/useMe';

/** Today in the club timezone (falls back to the browser's zone while /auth/me loads). */
export function useClubToday(): string {
  const timezone = useClub()?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return todayInTz(timezone);
}

/** `?month=` if valid, else the month containing `today`. */
export function monthParam(value: string | null, today: string): string {
  return value && isValidMonth(value) ? value : monthOf(today);
}

export function monthRange(month: string): { from: string; to: string } {
  return { from: firstDayOfMonth(month), to: lastDayOfMonth(month) };
}

export function showsQueryOptions(month: string) {
  const { from, to } = monthRange(month);
  return {
    queryKey: ['shows', from, to] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) => api.get<ShowDto[]>('/shows', { query: { from, to }, signal }),
  };
}

/** Every show (scheduled + cancelled) in a month. */
export function useMonthShows(month: string) {
  return useQuery({ ...showsQueryOptions(month), placeholderData: (previous) => previous });
}

/** Active (non-archived) locations in sort order. */
export function useLocations() {
  return useQuery({
    queryKey: ['locations'],
    queryFn: ({ signal }) => api.get<Location[]>('/locations', { signal }),
    staleTime: 5 * 60_000,
  });
}

export function useShowDetail(id: number | null) {
  return useQuery({
    queryKey: ['shows', 'detail', id],
    queryFn: ({ signal }) => api.get<ShowDetail>(`/shows/${id}`, { signal }),
    enabled: id != null,
  });
}

/** Refresh everything a show change can affect. `deletedId`'s detail query is left alone (it would 404). */
export function invalidateShowData(queryClient: QueryClient, deletedId?: number): Promise<unknown> {
  return Promise.all([
    queryClient.invalidateQueries({
      queryKey: ['shows'],
      predicate: (q) => !(deletedId != null && q.queryKey[1] === 'detail' && q.queryKey[2] === deletedId),
    }),
    queryClient.invalidateQueries({ queryKey: ['days'] }),
    queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
    queryClient.invalidateQueries({ queryKey: ['comedians'] }), // profiles' upcoming spots
  ]);
}

export function useBulkCreateShows() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: BulkCreateShowsInput) => api.post<BulkCreateShowsResponse>('/shows/bulk', input),
    onSettled: () => invalidateShowData(queryClient),
  });
}

/** Preview of a copy (POST with dryRun, read-only, so it is a query). */
export function useCopyPatternPreview(input: Omit<CopyPatternInput, 'dryRun'>, enabled: boolean) {
  const ids = input.locationIds?.length ? [...input.locationIds].sort((a, b) => Number(a) - Number(b)) : [];
  return useQuery({
    queryKey: ['shows', 'copy-pattern', input.fromMonth, input.toMonth, ids],
    queryFn: () => api.post<CopyPatternResponse>('/shows/copy-pattern', { ...input, locationIds: ids, dryRun: true }),
    enabled,
    staleTime: 0,
  });
}

export function useCopyPattern() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Omit<CopyPatternInput, 'dryRun'>) =>
      api.post<CopyPatternResponse>('/shows/copy-pattern', { ...input, dryRun: false }),
    meta: { silent: true }, // the dialog shows the error inline
    onSettled: () => invalidateShowData(queryClient),
  });
}

export function useUpdateShow(id: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: UpdateShowInput) => api.patch<UpdateShowResponse>(`/shows/${id}`, patch),
    meta: { silent: true }, // the edit dialog shows errors inline
    onSuccess: (detail) => {
      queryClient.setQueryData(['shows', 'detail', id], detail);
    },
    onSettled: () => invalidateShowData(queryClient),
  });
}

export function useDeleteShow(id: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.del<OkResponse>(`/shows/${id}`),
    meta: { silent: true }, // the confirm dialog shows errors inline
    onSettled: () => invalidateShowData(queryClient, id),
  });
}
