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
import { toast } from 'sonner';
import {
  BULK_DATES_MAX,
  type BulkCreateShowsInput,
  type BulkCreateShowsResponse,
  type BulkDeleteShowsInput,
  type BulkDeleteShowsResponse,
  type CopyPatternInput,
  type CopyPatternResponse,
  type ShowDetail,
  type ShowDto,
  type UpdateShowInput,
  type UpdateShowResponse,
} from '../../../shared/api/shows';
import { firstDayOfMonth, lastDayOfMonth, todayInTz } from '../../../shared/time';
import type { Location, OkResponse } from '../../../shared/types';
import { api, errorMessage } from '../../lib/api';
import { useClub } from '../../lib/useMe';
import { plural } from './showFormat';

/** Today in the club timezone (falls back to the browser's zone while /auth/me loads). */
export function useClubToday(): string {
  const timezone = useClub()?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return todayInTz(timezone);
}

export { monthParam } from './showFormat';

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

/**
 * Scheduled shows a copy-pattern from `fromMonth` would read (non-archived locations), or
 * undefined while loading. Copy buttons are disabled with an explanation when it's 0.
 */
export function useCopySourceCount(fromMonth: string): number | undefined {
  const { data } = useQuery(showsQueryOptions(fromMonth));
  return data?.filter((s) => s.status === 'scheduled' && !s.location.archived && s.date.startsWith(fromMonth)).length;
}

export { copySourceEmptyReason } from './showFormat';

/**
 * Undo a bulk create (create-shows, copy-pattern): delete the shows just made. Shows someone
 * booked in the meantime are kept, and the toast says so.
 */
export async function undoCreatedShows(queryClient: QueryClient, ids: number[]): Promise<void> {
  try {
    // Copy-pattern can make more shows than one bulk-delete takes (3 rooms × 5 a night).
    const result: BulkDeleteShowsResponse = { deleted: [], kept: [] };
    for (let i = 0; i < ids.length; i += BULK_DATES_MAX) {
      const chunk = ids.slice(i, i + BULK_DATES_MAX);
      const part = await api.post<BulkDeleteShowsResponse>('/shows/bulk-delete', { ids: chunk } satisfies BulkDeleteShowsInput);
      result.deleted.push(...part.deleted);
      result.kept.push(...part.kept);
    }
    if (result.kept.length) {
      toast.warning(
        `Removed ${plural(result.deleted.length, 'show')}; kept ${plural(result.kept.length, 'show')} that already ${result.kept.length === 1 ? 'has' : 'have'} bookings.`,
      );
    } else {
      toast.success(`Removed ${plural(result.deleted.length, 'show')}`);
    }
  } catch (err) {
    toast.error(errorMessage(err));
  } finally {
    await invalidateShowData(queryClient);
  }
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
