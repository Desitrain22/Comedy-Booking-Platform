/**
 * /welcome#<token> on a hosted club's host: the landing page right after sign-up on the
 * platform site. The token (one-time, 2 minutes) is read from the URL fragment, taken out of
 * the address bar, and posted to `POST /api/auth/handoff`, which sets this club's booker
 * session cookie. Then on to the same place first-run setup lands: Create shows for the month
 * being planned, where the setup guide picks up with step 2.
 */
import { LogIn } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router';
import type { HandoffResponse } from '../../../shared/api/platform';
import { planningMonth, todayInTz } from '../../../shared/time';
import { AuthShell, FormError } from '../../components/AuthShell';
import { createShowsPath } from '../../components/guide';
import { buttonClasses, Spinner } from '../../components/ui';
import { api, errorMessage, isApiError } from '../../lib/api';
import { useMe } from '../../lib/useMe';

let capturedToken: string | null = null;

/** The token from the URL fragment, read once; the fragment is removed from the address bar and history. */
function takeToken(): string {
  if (capturedToken === null) {
    capturedToken = window.location.hash.replace(/^#/, '');
    if (window.location.hash) {
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`);
    }
  }
  return capturedToken;
}

const redemptions = new Map<string, Promise<HandoffResponse>>();

/** Post the token once, however many times React mounts the page (StrictMode). */
function redeem(token: string): Promise<HandoffResponse> {
  let pending = redemptions.get(token);
  if (!pending) {
    pending = api.post<HandoffResponse>('/auth/handoff', { token });
    redemptions.set(token, pending);
  }
  return pending;
}

export function WelcomePage() {
  const { data: me } = useMe();
  const [token] = useState(takeToken);
  const [error, setError] = useState<string | null>(null);
  const timezone = me?.club.timezone;

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    redeem(token).then(
      () => {
        // A full page load (like the setup wizard): the new session cookie is picked up fresh.
        if (!cancelled) window.location.replace(createShowsPath(planningMonth(todayInTz(timezone ?? 'UTC'))));
      },
      (err: unknown) => {
        // An expired or used link needs no explanation beyond the title.
        if (!cancelled) setError(isApiError(err, 'invalid_handoff') ? '' : errorMessage(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [token, timezone]);

  if (!token && me?.booker) return <Navigate to="/app" replace />;

  if (!token || error !== null) {
    return (
      <AuthShell
        title="This sign-in link has expired"
        description="Your club is ready. Sign in with the email and password you just chose."
        documentTitle="Welcome"
      >
        <div className="space-y-4">
          {error && <FormError>{error}</FormError>}
          <Link to="/login" className={buttonClasses({ className: 'w-full' })}>
            <LogIn /> Sign in
          </Link>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Welcome!" description="Signing you in to your new club…" documentTitle="Welcome">
      <div className="flex justify-center py-2">
        <Spinner className="size-6" label="Signing you in" />
      </div>
    </AuthShell>
  );
}
