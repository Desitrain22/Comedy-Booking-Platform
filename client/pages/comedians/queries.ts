/**
 * F3 query keys, fetchers and cache helpers (comedians, notes, tags).
 *
 *   ['comedians', 'list', params]               roster
 *   ['comedians', id]                           profile
 *   ['comedians', id, 'card']                   hover card (ComedianHoverCard)
 *   ['comedians', id, 'notes']
 *   ['comedians', id, 'availability', month]
 *   ['comedians', id, 'bookings', 'upcoming']
 *   ['tags']
 *
 * Invalidating `['comedians', id]` refreshes everything about one comedian (card included).
 */
import { keepPreviousData, queryOptions, useQuery, type QueryClient } from '@tanstack/react-query';
import type {
  ComedianAvailability,
  ComedianBooking,
  ComedianDetail,
  ComedianListItem,
  NoteDto,
  TagWithCount,
} from '../../../shared/api/comedians';
import { api } from '../../lib/api';

/** The hover card's query (`['comedians', id, 'card']`) lives with the component. */
export { cardQuery } from '../../components/ComedianHoverCard';

export interface RosterParams {
  search: string;
  tagIds: number[];
  archived: boolean;
}

export const comedianKeys = {
  all: ['comedians'] as const,
  lists: ['comedians', 'list'] as const,
  list: (params: RosterParams) => ['comedians', 'list', params] as const,
  detail: (id: number) => ['comedians', id] as const,
  card: (id: number) => ['comedians', id, 'card'] as const,
  notes: (id: number) => ['comedians', id, 'notes'] as const,
  availability: (id: number, month: string) => ['comedians', id, 'availability', month] as const,
  upcoming: (id: number) => ['comedians', id, 'bookings', 'upcoming'] as const,
};

export const TAGS_KEY = ['tags'] as const;

export function rosterQuery(params: RosterParams) {
  return queryOptions({
    queryKey: comedianKeys.list(params),
    queryFn: ({ signal }) =>
      api.get<ComedianListItem[]>('/comedians', {
        query: { search: params.search || undefined, tagIds: params.tagIds, archived: params.archived || undefined },
        signal,
      }),
    placeholderData: keepPreviousData,
  });
}

export function comedianQuery(id: number) {
  return queryOptions({
    queryKey: comedianKeys.detail(id),
    queryFn: ({ signal }) => api.get<ComedianDetail>(`/comedians/${id}`, { signal }),
  });
}

export function notesQuery(id: number) {
  return queryOptions({
    queryKey: comedianKeys.notes(id),
    queryFn: ({ signal }) => api.get<NoteDto[]>(`/comedians/${id}/notes`, { signal }),
  });
}

export function comedianAvailabilityQuery(id: number, month: string) {
  return queryOptions({
    queryKey: comedianKeys.availability(id, month),
    queryFn: ({ signal }) => api.get<ComedianAvailability>(`/comedians/${id}/availability`, { query: { month }, signal }),
    placeholderData: keepPreviousData,
  });
}

export function upcomingQuery(id: number) {
  return queryOptions({
    queryKey: comedianKeys.upcoming(id),
    queryFn: ({ signal }) => api.get<ComedianBooking[]>(`/comedians/${id}/bookings`, { query: { upcoming: true }, signal }),
  });
}

export const tagsQuery = queryOptions({
  queryKey: TAGS_KEY,
  queryFn: ({ signal }) => api.get<TagWithCount[]>('/tags', { signal }),
});

export function useTags() {
  return useQuery(tagsQuery);
}

/**
 * After a comedian's name/email/archived/tags change: the roster, profiles, cards, and
 * other features' screens that show comedians (day view pool, dashboard).
 */
export function invalidateComedians(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: comedianKeys.all });
  void queryClient.invalidateQueries({ queryKey: ['days'] });
  void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
}

/** After tags themselves change (create/rename/recolor/delete) or memberships change. */
export function invalidateTags(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: TAGS_KEY });
  invalidateComedians(queryClient);
}
