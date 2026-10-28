/**
 * /portal/magic/:token — the landing page for emailed sign-in links. POSTs the token
 * (never a GET side effect, so email scanners can't use it up), then goes to the
 * link's `redirectTo` (e.g. /portal?month=2026-12). Works without a session.
 */
import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { MagicLinkResponse } from '../../../shared/types';
import { AuthShell } from '../../components/AuthShell';
import { safeNext } from '../../components/guards';
import { buttonClasses, Spinner } from '../../components/ui';
import { api } from '../../lib/api';
import { useRefreshMe } from '../../lib/useMe';

export function MagicPage() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const refreshMe = useRefreshMe();
  const started = useRef(false);

  const magic = useMutation({
    mutationFn: () => api.post<MagicLinkResponse>('/auth/magic', { token }),
    onSuccess: async ({ redirectTo }) => {
      await refreshMe();
      navigate(safeNext(redirectTo, '/portal'), { replace: true });
    },
    onError: () => {}, // shown below
  });

  useEffect(() => {
    if (started.current) return; // StrictMode runs effects twice in dev
    started.current = true;
    magic.mutate();
  }, [magic]);

  if (magic.isError) {
    return (
      <AuthShell title="This sign-in link doesn't work" description="It may have expired. Sign in with your email instead.">
        <Link to="/portal/login" className={buttonClasses({ size: 'lg', className: 'w-full' })}>
          Sign in with email
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Signing you in…" documentTitle="Signing in">
      <div className="flex justify-center py-4">
        <Spinner className="size-6" />
      </div>
    </AuthShell>
  );
}
