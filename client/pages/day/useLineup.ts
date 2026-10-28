/**
 * Day data (`['days', date]`) and the lineup mutations, all optimistic:
 * the cache changes first, the request follows, and a failure rolls back.
 *
 * Several mutations can be in flight at once (fast drags). Each snapshots the cache; a
 * failure restores its snapshot only when it is the sole pending lineup mutation (otherwise
 * that would undo the others) and the day is refetched once the last one settles.
 */
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { toast } from 'sonner';
import type {
  DayResponse,
  LineupBooking,
  MoveBookingResponse,
  UnavailableConflict,
  UnavailableErrorBody,
} from '../../../shared/api/lineup';
import { isValidDate } from '../../../shared/time';
import { api, errorMessage, isApiError } from '../../lib/api';
import {
  applyBook,
  applyMove,
  applySlotCount,
  indexDay,
  removeBooking,
  replaceBooking,
  showTitle,
  upsertBookings,
} from './lineupModel';

export const dayQueryKey = (date: string) => ['days', date] as const;

export function fetchDay(date: string, signal?: AbortSignal): Promise<DayResponse> {
  return api.get<DayResponse>(`/days/${date}`, { signal });
}

export function useDay(date: string) {
  return useQuery({
    queryKey: dayQueryKey(date),
    queryFn: ({ signal }) => fetchDay(date, signal),
    enabled: isValidDate(date),
  });
}

/** Warm the cache for neighboring days so prev/next feel instant. */
export function prefetchDay(queryClient: QueryClient, date: string): void {
  void queryClient.prefetchQuery({ queryKey: dayQueryKey(date), queryFn: ({ signal }) => fetchDay(date, signal) });
}

let tempSeq = 0;
/** Negative ids mark optimistic bookings the server hasn't confirmed yet. */
const nextTempId = () => --tempSeq;
export const isTempId = (id: number) => id < 0;

export interface BookVars {
  comedianId: number;
  showId: number;
  position: number;
  force?: boolean;
}
export interface MoveVars {
  bookingId: number;
  showId: number;
  position: number;
  force?: boolean;
}

interface Snapshot {
  previous: DayResponse | undefined;
}

export interface LineupHandlers {
  /** The server says someone isn't available (our data was stale): ask, then `retry()` with force. */
  onUnavailable: (conflicts: UnavailableConflict[], retry: () => void) => void;
}

export function useLineupActions(date: string, handlers: LineupHandlers) {
  const queryClient = useQueryClient();
  const key = dayQueryKey(date);
  const mutationKey = ['lineup', date];

  const getDay = () => queryClient.getQueryData<DayResponse>(key);

  async function begin(update: (day: DayResponse) => DayResponse): Promise<Snapshot> {
    await queryClient.cancelQueries({ queryKey: key });
    const previous = getDay();
    queryClient.setQueryData<DayResponse>(key, (day) => (day ? update(day) : day));
    return { previous };
  }

  const isOnlyMutation = () => queryClient.isMutating({ mutationKey }) <= 1;

  function rollback(snapshot: Snapshot | undefined) {
    if (snapshot?.previous && isOnlyMutation()) queryClient.setQueryData(key, snapshot.previous);
  }

  function settle() {
    if (isOnlyMutation()) void queryClient.invalidateQueries({ queryKey: key });
    // Other screens that show lineups refresh next time they are opened.
    for (const k of ['shows', 'dashboard', 'comedians']) {
      void queryClient.invalidateQueries({ queryKey: [k], refetchType: 'none' });
    }
  }

  function reportError(err: unknown, retry: () => void): void {
    if (isApiError(err, 'unavailable')) {
      const body = err.body as unknown as UnavailableErrorBody;
      handlers.onUnavailable(body.conflicts?.length ? body.conflicts : [body], retry);
      return;
    }
    toast.error(errorMessage(err));
  }

  const book = useMutation({
    mutationKey,
    mutationFn: ({ force, ...vars }: BookVars & { tempId: number }) =>
      api.post<LineupBooking>('/bookings', { comedianId: vars.comedianId, showId: vars.showId, position: vars.position, force }),
    onMutate: (vars) => begin((day) => applyBook(day, vars)),
    onSuccess: (booking, vars) => {
      queryClient.setQueryData<DayResponse>(key, (day) => (day ? replaceBooking(day, vars.tempId, booking) : day));
    },
    onError: (err, vars, snapshot) => {
      rollback(snapshot);
      queryClient.setQueryData<DayResponse>(key, (day) => (day ? removeBooking(day, vars.tempId) : day));
      reportError(err, () => book.mutate({ ...vars, tempId: nextTempId(), force: true }));
    },
    onSettled: settle,
  });

  const move = useMutation({
    mutationKey,
    mutationFn: ({ bookingId, showId, position, force }: MoveVars) =>
      api.patch<MoveBookingResponse>(`/bookings/${bookingId}`, { showId, position, force }),
    onMutate: (vars) => begin((day) => applyMove(day, vars)),
    onSuccess: ({ booking, swapped }) => {
      queryClient.setQueryData<DayResponse>(key, (day) =>
        day ? upsertBookings(day, swapped ? [booking, swapped] : [booking]) : day,
      );
    },
    onError: (err, vars, snapshot) => {
      rollback(snapshot);
      reportError(err, () => move.mutate({ ...vars, force: true }));
    },
    onSettled: settle,
  });

  const unbook = useMutation({
    mutationKey,
    mutationFn: ({ bookingId }: { bookingId: number }) => api.del(`/bookings/${bookingId}`),
    onMutate: async ({ bookingId }) => {
      const removed = getDay() && indexDay(getDay()!).bookings.get(bookingId);
      const snapshot = await begin((day) => removeBooking(day, bookingId));
      return { ...snapshot, removed };
    },
    onSuccess: (_data, _vars, context) => {
      const removed = context?.removed;
      const show = removed && context.previous ? indexDay(context.previous).shows.get(removed.showId) : undefined;
      if (!removed || !show) return;
      toast(`Removed ${removed.comedianName} from the ${showTitle(show)}`, {
        id: `unbook-${removed.id}`,
        action: {
          label: 'Undo',
          onClick: () =>
            book.mutate({
              comedianId: removed.comedianId,
              showId: removed.showId,
              position: removed.position,
              force: true,
              tempId: nextTempId(),
            }),
        },
      });
    },
    onError: (err, _vars, snapshot) => {
      rollback(snapshot);
      toast.error(errorMessage(err));
    },
    onSettled: settle,
  });

  const setSlotCount = useMutation({
    mutationKey,
    mutationFn: ({ showId, slotCount }: { showId: number; slotCount: number }) =>
      api.patch(`/shows/${showId}`, { slotCount }),
    onMutate: ({ showId, slotCount }) => begin((day) => applySlotCount(day, showId, slotCount)),
    onError: (err, _vars, snapshot) => {
      rollback(snapshot);
      toast.error(
        isApiError(err, 'slots_occupied')
          ? 'That slot is booked. Move or remove the comedian first.'
          : errorMessage(err),
      );
    },
    onSettled: settle,
  });

  const bookMutate = book.mutate;
  const moveMutate = move.mutate;
  const unbookMutate = unbook.mutate;
  const slotMutate = setSlotCount.mutate;

  const actions = useMemo(
    () => ({
      book: (vars: BookVars) => bookMutate({ ...vars, tempId: nextTempId() }),
      move: (vars: MoveVars) => moveMutate(vars),
      unbook: (bookingId: number) => unbookMutate({ bookingId }),
      setSlotCount: (showId: number, slotCount: number) => slotMutate({ showId, slotCount }),
    }),
    [bookMutate, moveMutate, unbookMutate, slotMutate],
  );
  return actions;
}

/** Copy text to the clipboard with a toast either way. */
export function useCopy() {
  return useCallback(async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${what} copied`);
    } catch {
      toast.error('Could not copy to the clipboard');
    }
  }, []);
}
