/**
 * Owner console data (shared/api/platformAdmin.ts). Query keys start with `platform-admin`:
 *
 *   ['platform-admin', 'me']                       who is signed in ({ admin: null } when nobody)
 *   ['platform-admin', 'overview', status, search]
 *   ['platform-admin', 'club', id]
 *
 * A 401 from any console query refetches `me`, so the guard sends the owner back to sign in.
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type {
  AdminActionResponse,
  AdminArchiveRequest,
  AdminClubDetail,
  AdminClubFilter,
  AdminMeResponse,
  AdminOverview,
} from '../../../shared/api/platformAdmin';
import { ApiError, api, apiUrl } from '../../lib/api';

export const ADMIN_KEY = 'platform-admin';
export const ADMIN_ME_KEY = [ADMIN_KEY, 'me'] as const;

export function useAdminMe() {
  return useQuery({
    queryKey: ADMIN_ME_KEY,
    queryFn: ({ signal }) => api.get<AdminMeResponse>('/platform/admin/me', { signal }),
    staleTime: 5 * 60_000,
  });
}

/** Back to the sign-in page when a console call says the session is gone. */
export function useWatchAdminSession(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    const check = (error: unknown) => {
      if (error instanceof ApiError && error.status === 401) {
        void queryClient.invalidateQueries({ queryKey: ADMIN_ME_KEY });
      }
    };
    const queries = queryClient.getQueryCache().subscribe((event) => {
      if (event.type === 'updated' && event.action.type === 'error' && event.query.queryKey[0] === ADMIN_KEY) {
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

export function useAdminOverview(status: AdminClubFilter, search: string) {
  return useQuery({
    queryKey: [ADMIN_KEY, 'overview', status, search],
    queryFn: ({ signal }) =>
      api.get<AdminOverview>('/platform/admin/overview', { query: { status, search: search || undefined }, signal }),
    placeholderData: keepPreviousData,
  });
}

export function useAdminClub(id: number) {
  return useQuery({
    queryKey: [ADMIN_KEY, 'club', id],
    queryFn: ({ signal }) => api.get<AdminClubDetail>(`/platform/admin/clubs/${id}`, { signal }),
    enabled: Number.isInteger(id) && id > 0,
  });
}

export type AdminActionInput =
  | { action: 'suspend'; reason: string }
  | { action: 'reactivate' }
  | { action: 'restore' }
  | ({ action: 'archive' } & AdminArchiveRequest);

/** Suspend / reactivate / archive / restore; refreshes the console's data. */
export function useAdminAction(clubId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ action, ...body }: AdminActionInput) =>
      api.post<AdminActionResponse>(`/platform/admin/clubs/${clubId}/${action}`, body),
    onSettled: () => queryClient.invalidateQueries({ queryKey: [ADMIN_KEY] }),
    meta: { silent: true },
  });
}

function filenameFrom(disposition: string | null): string {
  return /filename="([^"]+)"/.exec(disposition ?? '')?.[1] ?? 'club-backup.db';
}

/** Fetch the club's backup and hand it to the browser as a file download. Resolves with the file name. */
export async function downloadClubBackup(clubId: number): Promise<string> {
  const res = await fetch(apiUrl(`/platform/admin/clubs/${clubId}/backup`), { credentials: 'same-origin' });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: res.statusText }))) as { error: string; code?: string };
    throw new ApiError(res.status, body);
  }
  const filename = filenameFrom(res.headers.get('content-disposition'));
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return filename;
}

export function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}
