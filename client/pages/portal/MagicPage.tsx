/**
 * /portal/magic/:token — the landing page for emailed sign-in links. POSTs the token
 * (never a GET side effect, so email scanners can't use it up), then goes to the
 * link's `redirectTo` (e.g. /portal?month=2026-12). Works without a session.
 */
import { useMutation } from '@tanstack/react-query';
import { Mail, RotateCw } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { MagicLinkResponse } from '../../../shared/types';
import { AuthShell } from '../../components/AuthShell';
import { safeNext } from '../../components/guards';
import { Button, buttonClasses, Spinner } from '../../components/ui';
import { api, errorMessage, isApiError } from '../../lib/api';
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
    onError: () => {}, // shown below (and no global error toast)
  });

  useEffect(() => {
    if (started.current) return; // StrictMode runs effects twice in dev
    started.current = true;
    magic.mutate();
  }, [magic]);

  if (magic.isError) {
    const invalid = isApiError(magic.error, 'invalid_token');
    return (
      <AuthShell
        title="This sign-in link doesn't work"
        description={
          invalid
            ? "It may have expired (links last 30 days). We'll email you a fresh code instead — it only takes a moment."
            : errorMessage(magic.error)
        }
        documentTitle="Sign in"
      >
        <div className="space-y-2">
          <Link to="/portal/login" className={buttonClasses({ size: 'lg', className: 'w-full' })}>
            <Mail /> Sign in with email
          </Link>
          {!invalid && (
            <Button variant="secondary" size="lg" className="w-full" onClick={() => magic.mutate()} loading={magic.isPending}>
              <RotateCw /> Try again
            </Button>
          )}
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Signing you in…" description="One moment." documentTitle="Signing in">
      <div className="flex justify-center py-4">
        <Spinner className="size-6" label="Signing you in" />
      </div>
    </AuthShell>
  );
}
