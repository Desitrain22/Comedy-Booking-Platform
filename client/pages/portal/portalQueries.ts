/** TanStack Query keys and fetchers for the comedian portal (spec §3: keys start with the API path). */
import { useQuery } from '@tanstack/react-query';
import type {
  ConfirmLinkInfo,
  PortalAvailabilityResponse,
  PortalMeResponse,
  PortalProfile,
  PortalSpotsResponse,
} from '../../../shared/api/portal';
import { api } from '../../lib/api';

export const portalKeys = {
  all: ['portal'] as const,
  me: ['portal', 'me'] as const,
  availability: (month: string) => ['portal', 'availability', month] as const,
  spots: ['portal', 'spots'] as const,
  profile: ['portal', 'profile'] as const,
  confirm: (token: string) => ['portal', 'confirm', token] as const,
};

export function usePortalMe() {
  return useQuery({
    queryKey: portalKeys.me,
    queryFn: ({ signal }) => api.get<PortalMeResponse>('/portal/me', { signal }),
  });
}

export function useAvailability(month: string) {
  return useQuery({
    queryKey: portalKeys.availability(month),
    queryFn: ({ signal }) => api.get<PortalAvailabilityResponse>('/portal/availability', { query: { month }, signal }),
    // The page keeps its own draft; a refetch on focus would only be ignored while editing.
    refetchOnWindowFocus: false,
  });
}

export function useSpots() {
  return useQuery({
    queryKey: portalKeys.spots,
    queryFn: ({ signal }) => api.get<PortalSpotsResponse>('/portal/spots', { signal }),
  });
}

export function useProfile() {
  return useQuery({
    queryKey: portalKeys.profile,
    queryFn: ({ signal }) => api.get<PortalProfile>('/portal/profile', { signal }),
    refetchOnWindowFocus: false,
  });
}

export function useConfirmLink(token: string) {
  return useQuery({
    queryKey: portalKeys.confirm(token),
    // Read-only GET: safe for email scanners; confirming is a POST.
    queryFn: ({ signal }) => api.get<ConfirmLinkInfo>(`/portal/confirm/${encodeURIComponent(token)}`, { signal }),
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}
