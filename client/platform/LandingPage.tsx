/** The platform site's one screen (`/`): what it is, Create your club, Sign in. */
import { CalendarDays, Code, MailCheck, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { buttonClasses } from '../components/ui';
import { usePlatformHost } from './PlatformApp';
import { Brand, usePlatformTitle } from './PlatformShell';

export const REPO_URL = 'https://github.com/Desitrain22/Comedy-Booking-Platform';

export function LandingPage() {
  const host = usePlatformHost();
  usePlatformTitle(undefined, host.platformName);
  return (
    <div className="flex min-h-dvh flex-col px-4 py-10 sm:py-16">
      <main className="mx-auto flex w-full max-w-xl flex-1 flex-col items-center justify-center text-center">
        <Brand name={host.platformName} />
        <h1 className="mt-8 text-3xl font-semibold tracking-tight text-balance text-fg sm:text-4xl">
          Book your comedy club in one place.
        </h1>
        <p className="mt-3 max-w-md text-base text-pretty text-fg-muted">
          Shows, lineups, comedian availability and weekly confirmation emails, for every booker and location in your
          club.
        </p>
        <div className="mt-8 flex w-full max-w-xs flex-col gap-2 sm:max-w-none sm:flex-row sm:justify-center">
          {host.signupsOpen ? (
            <Link to="/signup" className={buttonClasses({ size: 'lg' })}>
              Create your club
            </Link>
          ) : null}
          <Link to="/signin" className={buttonClasses({ variant: host.signupsOpen ? 'secondary' : 'primary', size: 'lg' })}>
            Sign in
          </Link>
        </div>
        {!host.signupsOpen && (
          <p className="mt-4 text-sm text-fg-muted">
            New sign-ups are closed right now
            {host.supportEmail ? (
              <>
                {' '}— write to{' '}
                <a className="text-accent hover:underline" href={`mailto:${host.supportEmail}`}>
                  {host.supportEmail}
                </a>
              </>
            ) : null}
            .
          </p>
        )}
        <ul className="mt-12 grid w-full gap-3 text-left sm:grid-cols-3">
          <Feature icon={<CalendarDays />} title="Shows & lineups">
            Plan the month, then drag comedians into each show.
          </Feature>
          <Feature icon={<Users />} title="Your comedians">
            They mark their own availability and see their spots.
          </Feature>
          <Feature icon={<MailCheck />} title="Confirmations">
            Weekly emails go out on their own. Comedians confirm in a click.
          </Feature>
        </ul>
      </main>
      <footer className="mt-10 text-center text-sm text-fg-muted">
        <a href={REPO_URL} className="inline-flex items-center gap-1.5 hover:text-fg" target="_blank" rel="noreferrer">
          <Code className="size-4" aria-hidden /> Open source on GitHub
        </a>
      </footer>
    </div>
  );
}

function Feature({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <li className="rounded-lg border border-border bg-surface p-4 shadow-xs">
      <div className="flex items-center gap-2 text-sm font-semibold text-fg [&_svg]:size-4 [&_svg]:text-accent">
        {icon}
        {title}
      </div>
      <p className="mt-1 text-sm text-fg-muted">{children}</p>
    </li>
  );
}
