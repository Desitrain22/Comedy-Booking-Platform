/**
 * The platform site (hosted mode, `<domain>` and `www.<domain>`; hosted MVP spec §4):
 *
 *   /          landing: what this is, Create your club, Sign in
 *   /signup    create a club → lands signed in on the club's own address
 *   /signin    find my club: emails the sign-in links of every club an address belongs to
 *   /admin/*   the owner console (client/platform/admin/AdminApp.tsx)
 */
import { Route, Routes } from 'react-router';
import type { HostContext } from '../../shared/api/platform';
import { buttonClasses } from '../components/ui';
import { useHost } from '../lib/host';
import { AdminApp } from './admin/AdminApp';
import { FindClubPage } from './FindClubPage';
import { LandingPage } from './LandingPage';
import { PlatformShell } from './PlatformShell';
import { SignupPage } from './SignupPage';

export type PlatformHost = Extract<HostContext, { mode: 'platform' }>;

/** The platform host context. Only use under PlatformApp. */
export function usePlatformHost(): PlatformHost {
  const host = useHost();
  if (host.mode !== 'platform') throw new Error('usePlatformHost() used outside the platform site');
  return host;
}

/** `comedybook.app` (with the port in dev) from the platform URL. */
export function platformHostName(host: PlatformHost): string {
  try {
    return new URL(host.platformUrl).host;
  } catch {
    return window.location.host;
  }
}

export function PlatformApp() {
  return (
    <Routes>
      <Route index element={<LandingPage />} />
      <Route path="signup" element={<SignupPage />} />
      <Route path="signin" element={<FindClubPage />} />
      <Route path="admin/*" element={<AdminApp />} />
      <Route path="*" element={<PlatformNotFound />} />
    </Routes>
  );
}

function PlatformNotFound() {
  const host = usePlatformHost();
  return (
    <PlatformShell
      brand={host.platformName}
      brandHref="/"
      title="Page not found"
      description="That link doesn't go anywhere. It may be mistyped or out of date."
    >
      <a href="/" className={buttonClasses({ variant: 'secondary', className: 'w-full' })}>
        Go home
      </a>
    </PlatformShell>
  );
}
