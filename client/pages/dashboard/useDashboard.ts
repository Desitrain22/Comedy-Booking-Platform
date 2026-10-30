/**
 * Dashboard data + mutations (TanStack Query). The whole page is one payload,
 * `GET /api/dashboard` under `['dashboard']`, refreshed every minute so confirmations
 * coming in from comedians show up without a reload.
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type {
  AvailabilityPreviewQuery,
  AvailabilityRequestPreview,
  CreateAvailabilityRequestInput,
  CreateAvailabilityRequestResponse,
  DashboardResponse,
  ResendConfirmationResponse,
  SendConfirmationsInput,
  SendConfirmationsResponse,
  UnconfirmedTonightRow,
} from '../../../shared/api/dashboard';
import { firstNameOf, plural } from './format';
import { api, errorMessage } from '../../lib/api';

export const DASHBOARD_KEY = ['dashboard'] as const;

export function useDashboard() {
  return useQuery({
    queryKey: DASHBOARD_KEY,
    queryFn: ({ signal }) => api.get<DashboardResponse>('/dashboard', { signal }),
    refetchInterval: 60_000,
  });
}

/** Lineup data elsewhere in the app that a confirmation changes. */
function invalidateBookingViews(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: DASHBOARD_KEY });
  void queryClient.invalidateQueries({ queryKey: ['days'] });
  void queryClient.invalidateQueries({ queryKey: ['shows'] });
  void queryClient.invalidateQueries({ queryKey: ['comedians'] }); // profiles' upcoming spots
}

/** Where an email went, for toasts: real inbox, or the dev outbox. */
export function outboxNote(emailConfigured: boolean): string | undefined {
  return emailConfigured ? undefined : "Email isn't set up yet, so it's in the outbox (Settings → Email).";
}

// ---------------------------------------------------------------------------
// Unconfirmed tonight: Mark confirmed (F2's endpoint) and Resend
// ---------------------------------------------------------------------------

/** Mark a booking confirmed (booker override). Optimistically drops the red row. */
export function useMarkConfirmed() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (row: UnconfirmedTonightRow) => api.post(`/bookings/${row.bookingId}/confirm`),
    onMutate: async (row) => {
      await queryClient.cancelQueries({ queryKey: DASHBOARD_KEY });
      const previous = queryClient.getQueryData<DashboardResponse>(DASHBOARD_KEY);
      if (previous) {
        queryClient.setQueryData<DashboardResponse>(DASHBOARD_KEY, {
          ...previous,
          unconfirmedTonight: previous.unconfirmedTonight.filter((r) => r.bookingId !== row.bookingId),
          tonight: previous.tonight.map((show) =>
            show.id !== row.showId
              ? show
              : {
                  ...show,
                  confirmedCount: show.confirmedCount + 1,
                  bookings: show.bookings.map((b) => (b.id === row.bookingId ? { ...b, status: 'confirmed' } : b)),
                },
          ),
        });
      }
      return { previous };
    },
    onError: (err, row, context) => {
      if (context?.previous) queryClient.setQueryData(DASHBOARD_KEY, context.previous);
      toast.error(`Couldn't confirm ${firstNameOf(row.comedianName)}`, { description: errorMessage(err) });
    },
    onSuccess: (_data, row) => {
      toast.success(`${row.comedianName} is confirmed for tonight`);
    },
    onSettled: () => invalidateBookingViews(queryClient),
  });
}

export function useResendConfirmation(emailConfigured: boolean) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { comedianId: number; weekStart: string; comedianName: string }) =>
      api.post<ResendConfirmationResponse>('/confirmations/resend', {
        comedianId: input.comedianId,
        weekStart: input.weekStart,
      }),
    onSuccess: (result, input) => {
      const first = firstNameOf(input.comedianName);
      if (result.status === 'failed') {
        toast.error(`Couldn't email ${first}`, { description: result.error });
      } else if (result.status === 'skipped') {
        toast.info(`${first} has nothing left to confirm this week`);
      } else {
        toast.success(`Sent ${first} a new confirmation email`, {
          description: result.status === 'outbox' ? outboxNote(emailConfigured) : undefined,
        });
      }
    },
    onError: (err, input) => {
      toast.error(`Couldn't email ${firstNameOf(input.comedianName)}`, { description: errorMessage(err) });
    },
    // Resending marks the week's spots as sent ("Awaiting"), here and on the day boards.
    onSettled: () => invalidateBookingViews(queryClient),
  });
}

// ---------------------------------------------------------------------------
// Weekly confirmations
// ---------------------------------------------------------------------------

export function useSendConfirmations(emailConfigured: boolean) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SendConfirmationsInput) => api.post<SendConfirmationsResponse>('/confirmations/send', input),
    onSuccess: (result) => {
      if (result.sent === 0 && result.failed === 0) {
        toast.info('Nobody to email: every spot this week is confirmed');
      } else if (result.failed > 0) {
        toast.warning(`Sent ${plural(result.sent, 'confirmation email')}; ${result.failed} failed`, {
          description: 'Check Settings → Email for the error.',
        });
      } else {
        toast.success(`Sent ${plural(result.sent, 'confirmation email')}`, { description: outboxNote(emailConfigured) });
      }
    },
    onSettled: () => invalidateBookingViews(queryClient),
  });
}

// ---------------------------------------------------------------------------
// Availability requests
// ---------------------------------------------------------------------------

export function useSendAvailabilityRequest(emailConfigured: boolean) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateAvailabilityRequestInput) =>
      api.post<CreateAvailabilityRequestResponse>('/availability-requests', input),
    onSuccess: (result) => {
      const what = result.request.kind === 'reminder' ? 'Reminder' : 'Availability request';
      if (result.failed > 0) {
        toast.warning(`${what} sent to ${result.sent}; ${result.failed} failed`, {
          description: 'Check Settings → Email for the error.',
        });
      } else {
        toast.success(`${what} sent to ${plural(result.sent, 'comedian')}`, {
          description: outboxNote(emailConfigured),
        });
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: DASHBOARD_KEY });
      void queryClient.invalidateQueries({ queryKey: ['availability-requests'] });
    },
  });
}

/** Rendered email for the request dialog's preview pane. */
export function useAvailabilityPreview(params: Required<AvailabilityPreviewQuery>, enabled: boolean) {
  return useQuery({
    queryKey: ['availability-requests', 'preview', params.month, params.kind, params.audience, params.message],
    queryFn: ({ signal }) =>
      api.get<AvailabilityRequestPreview>('/availability-requests/preview', { query: { ...params }, signal }),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}
