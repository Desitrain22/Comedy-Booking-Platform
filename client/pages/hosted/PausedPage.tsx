/**
 * A suspended club's host (hosted mode), whatever the path: bookers, comedians and anyone
 * arriving from an emailed link see this instead of the app. Its API answers 403
 * `club_suspended` meanwhile (all but /api/host).
 */
import { CirclePause } from 'lucide-react';
import type { HostContext } from '../../../shared/api/platform';
import { PlatformShell } from '../../platform/PlatformShell';

type ClubHost = Extract<HostContext, { mode: 'club' }>;

export function PausedPage({ host }: { host: ClubHost }) {
  return (
    <PlatformShell
      brand={host.clubName || host.platformName}
      icon={<CirclePause aria-hidden />}
      title="This account is paused"
      documentTitle="Paused"
      description={
        <>
          {host.clubName || 'This club'} isn't available right now. Your data is safe and nothing is being sent while
          it's paused.
        </>
      }
      footer={
        <a href={host.platformUrl} className="hover:text-fg">
          {host.platformName}
        </a>
      }
    >
      {host.supportEmail ? (
        <p className="text-sm text-fg">
          Questions? Contact{' '}
          <a className="font-medium text-accent hover:underline" href={`mailto:${host.supportEmail}`}>
            {host.supportEmail}
          </a>
          .
        </p>
      ) : (
        <p className="text-sm text-fg">Questions? Contact the people who run {host.platformName}.</p>
      )}
    </PlatformShell>
  );
}
