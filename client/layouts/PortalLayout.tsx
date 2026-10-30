/**
 * Comedian portal shell (/portal/*), mobile-first: club name header, tabs
 * Availability / My spots / Profile, sign out.
 *
 * Also wraps /portal/confirm/:token, which works without a session: with no comedian
 * signed in it shows just the club header (no tabs, no sign out).
 *
 * The My spots tab shows how many spots are waiting to be confirmed (declined spots don't
 * count), so a comedian sees it from any tab without scrolling.
 *
 * Content column is max-w-3xl; pages that need a sticky footer (Availability) can use
 * `sticky bottom-0` inside it.
 */
import { CalendarDays, LogOut, Mic, UserRound } from 'lucide-react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { Button } from '../components/ui/Button';
import { cn } from '../lib/cn';
import { useMe, useSignOut } from '../lib/useMe';
import { usePortalMe } from '../pages/portal/portalQueries';

const TABS = [
  { to: '/portal', label: 'Availability', icon: CalendarDays, end: true },
  { to: '/portal/spots', label: 'My spots', icon: Mic, end: false },
  { to: '/portal/profile', label: 'Profile', icon: UserRound, end: false },
] as const;

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

export function PortalLayout() {
  const { data: me } = useMe();
  const comedian = me?.comedian ?? null;
  const signOut = useSignOut('comedian');
  const { pathname } = useLocation();
  const toConfirm = usePortalMe({ enabled: comedian != null }).data?.spots.unconfirmed ?? 0;

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 pt-3 pb-2">
          <div className="min-w-0">
            {comedian && <p className="truncate text-base font-semibold text-fg">Hey {firstName(comedian.name)}</p>}
            <p className={cn('truncate', comedian ? 'text-xs text-fg-muted' : 'py-1 text-base font-semibold text-fg')}>
              {me?.club.name || 'Comedy Booking'}
            </p>
          </div>
          {comedian && (
            <Button variant="ghost" size="sm" onClick={() => void signOut()} className="h-11 text-fg-muted sm:h-8">
              <LogOut /> Sign out
            </Button>
          )}
        </div>
        {comedian && (
          <nav aria-label="Portal" className="mx-auto flex max-w-3xl gap-1 px-2 sm:gap-4 sm:px-4">
            {TABS.map((tab) => (
              <NavLink
                key={tab.to}
                to={tab.to}
                end={tab.end}
                className={({ isActive }) =>
                  cn(
                    '-mb-px flex min-h-11 min-w-0 flex-1 items-center justify-center gap-1 border-b-2 px-1 text-sm font-medium whitespace-nowrap transition-colors sm:flex-none sm:gap-1.5 sm:px-0.5',
                    isActive ? 'border-accent text-fg' : 'border-transparent text-fg-muted hover:text-fg',
                  )
                }
              >
                <tab.icon className="size-4 shrink-0" aria-hidden />
                {tab.label}
                {tab.to === '/portal/spots' && toConfirm > 0 && (
                  <span
                    className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-awaiting px-1.5 text-[11px] leading-none font-semibold text-white tabular-nums dark:text-zinc-950"
                    data-testid="spots-to-confirm"
                  >
                    {toConfirm}
                    <span className="sr-only"> to confirm</span>
                  </span>
                )}
              </NavLink>
            ))}
          </nav>
        )}
      </header>

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 py-5">
        <ErrorBoundary resetKey={pathname}>
          <Outlet />
        </ErrorBoundary>
      </main>
    </div>
  );
}
