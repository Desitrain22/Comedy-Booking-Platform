/**
 * Data hooks and form helpers for the Settings tabs.
 *
 * Query keys: `['settings']`, `['email-log', filters]`, `['email-log', 'detail', id]`,
 * `['users']`, `['locations', { includeArchived: true }]`, `['mailbox']` (your own).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { z } from 'zod';
import type { MailboxDto, SettingsDto, UpdateMailboxInput, UpdateSettingsInput } from '../../../shared/api/settings';
import { updateMailboxSchema, updateSettingsSchema } from '../../../shared/api/settings';
import type { Location } from '../../../shared/types';
import { api, ApiError } from '../../lib/api';
import { useRefreshMe } from '../../lib/useMe';

export const SETTINGS_KEY = ['settings'] as const;
export const USERS_KEY = ['users'] as const;
export const EMAIL_LOG_KEY = ['email-log'] as const;
export const ALL_LOCATIONS_KEY = ['locations', { includeArchived: true }] as const;
export const MAILBOX_KEY = ['mailbox'] as const;

/** The signed-in booker's own mailbox (Settings → Account). */
export function useMailbox() {
  return useQuery({
    queryKey: MAILBOX_KEY,
    queryFn: ({ signal }) => api.get<MailboxDto>('/me/mailbox', { signal }),
  });
}

/**
 * Connect/change (`input`) or disconnect (`null`) your own mailbox. Settings refresh too:
 * their preview of emails sent as you follows your mailbox.
 */
export function useSaveMailbox() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateMailboxInput | null) =>
      input ? api.put<MailboxDto>('/me/mailbox', input) : api.del<MailboxDto>('/me/mailbox'),
    onSuccess: (data) => {
      queryClient.setQueryData(MAILBOX_KEY, data);
      void queryClient.invalidateQueries({ queryKey: SETTINGS_KEY });
    },
    // Callers show field errors / toasts themselves.
    meta: { silent: true },
  });
}

export function useSettings() {
  return useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: ({ signal }) => api.get<SettingsDto>('/settings', { signal }),
  });
}

/**
 * Save part of the settings. `refreshClub` re-reads `/auth/me` afterwards so the club
 * name, timezone and all-night range update across the app (and the day boards, whose
 * "today" follows the timezone). The dashboard always refreshes: it shows whether email is
 * set up and when confirmations go out next.
 */
export function useSaveSettings(options: { refreshClub?: boolean } = {}) {
  const queryClient = useQueryClient();
  const refreshMe = useRefreshMe();
  return useMutation({
    mutationFn: (input: UpdateSettingsInput) => api.put<SettingsDto>('/settings', input),
    onSuccess: async (data) => {
      queryClient.setQueryData(SETTINGS_KEY, data);
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      if (options.refreshClub) {
        void queryClient.invalidateQueries({ queryKey: ['days'] });
        await refreshMe();
      }
    },
    // Callers show field errors / toasts themselves.
    meta: { silent: true },
  });
}

export function useAllLocations() {
  return useQuery({
    queryKey: ALL_LOCATIONS_KEY,
    queryFn: ({ signal }) => api.get<Location[]>('/locations', { query: { includeArchived: true }, signal }),
  });
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

export type FieldErrors = Partial<Record<string, string>>;

function issuesToErrors(issues: readonly { path: readonly PropertyKey[] | string; message: string }[]): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of issues) {
    const key = Array.isArray(issue.path) ? String(issue.path[0] ?? '') : String(issue.path).split('.')[0]!;
    if (key && !errors[key]) errors[key] = issue.message;
  }
  return errors;
}

/** Field errors from a 400 `validation_error`/`from_email_required` API response, or null. */
export function apiFieldErrors(err: unknown): FieldErrors | null {
  if (!(err instanceof ApiError) || err.status !== 400) return null;
  const issues = err.body.issues;
  if (!Array.isArray(issues)) return null;
  const errors = issuesToErrors(issues as { path: string; message: string }[]);
  return Object.keys(errors).length ? errors : null;
}

/** Validate a settings patch on the client with the shared schema. Null when valid. */
export function validateSettingsPatch(patch: UpdateSettingsInput): FieldErrors | null {
  const result = updateSettingsSchema.safeParse(patch);
  return result.success ? null : issuesToErrors((result.error as z.ZodError).issues);
}

/** Validate a mailbox save on the client with the shared schema. Null when valid. */
export function validateMailbox(input: UpdateMailboxInput): FieldErrors | null {
  const result = updateMailboxSchema.safeParse(input);
  return result.success ? null : issuesToErrors((result.error as z.ZodError).issues);
}

function sameValues<T extends object>(a: T, b: T): boolean {
  return (Object.keys(a) as (keyof T)[]).every((k) => Object.is(a[k], b[k]));
}

/**
 * Local edit state for a form section. Key the component on the saved values so a
 * successful save (or someone else's change) starts a fresh draft.
 */
export function useDraft<T extends object>(initial: T) {
  const [draft, setDraft] = useState<T>(initial);
  const [errors, setErrors] = useState<FieldErrors>({});
  function set<K extends keyof T>(key: K, value: T[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
    setErrors((e) => (e[key as string] ? { ...e, [key as string]: undefined } : e));
  }
  function reset() {
    setDraft(initial);
    setErrors({});
  }
  return { draft, set, setDraft, errors, setErrors, reset, dirty: !sameValues(draft, initial) };
}

/** Pick some keys of an object (for keying/initialising form sections). */
export function pick<T extends object, K extends keyof T>(obj: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const key of keys) out[key] = obj[key];
  return out;
}
