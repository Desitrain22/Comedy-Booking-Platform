/**
 * Hosted mode, a host with no club behind it: an unknown or archived address (`GET /api/host`
 * answered 404 `club_not_found`, whose body carries the platform's name and URL).
 */
import { SearchX } from 'lucide-react';
import type { ClubNotFoundBody } from '../../../shared/api/platform';
import { buttonClasses } from '../../components/ui';
import { PlatformShell } from '../../platform/PlatformShell';

export function NoClubPage({ platform }: { platform: Partial<Pick<ClubNotFoundBody, 'platformName' | 'platformUrl'>> }) {
  const name = platform.platformName || 'Comedy Booking';
  const url = platform.platformUrl || null;
  return (
    <PlatformShell
      brand={name}
      brandHref={url ?? undefined}
      icon={<SearchX aria-hidden />}
      title="There's no club at this address"
      documentTitle="No club here"
      description={
        <>
          <span className="font-medium text-fg">{window.location.host}</span> isn't a club on {name}. Check the address,
          or find your club from the home page.
        </>
      }
    >
      {url && (
        <div className="flex flex-col gap-2">
          <a href={`${url}/signin`} className={buttonClasses({ className: 'w-full' })}>
            Find my club
          </a>
          <a href={url} className={buttonClasses({ variant: 'secondary', className: 'w-full' })}>
            Go to {name}
          </a>
        </div>
      )}
    </PlatformShell>
  );
}
