/**
 * /app — the booker's dashboard (spec §6 F5): tonight at a glance.
 *
 *   ┌ Getting started (new clubs) / email outbox banner (admins) ───────────┐
 *   ┌ Unconfirmed tonight (red) ─────────┐ ┌ This week ────────┐
 *   ├ Needs a replacement (declined) ────┤ ├ Availability ─────┤
 *   ├ Tonight's shows ───────────────────┤
 *
 * One payload (`GET /api/dashboard`, key `['dashboard']`), refreshed every minute. "Tonight"
 * is the club night: until 6 AM the dashboard still shows last night's late shows.
 *
 * Getting started reads the setup guide's state (`GET /api/onboarding`, the one source of
 * truth), and the guide's last step asks this page to open Request availability on the month
 * that has the shows (`useGuideAction('request-availability')`).
 */
import { CalendarDays, CircleAlert } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { formatDateLong } from '../../../shared/time';
import { useGuide, useGuideAction, useOnboarding } from '../../components/guide';
import { Button, Card, EmptyState, PageHeader, PageSpinner, buttonClasses } from '../../components/ui';
import { errorMessage } from '../../lib/api';
import { useBooker } from '../../lib/useMe';
import { AvailabilityPanel, type RequestDialogTarget } from './AvailabilityPanel';
import { AvailabilityRequestDialog } from './AvailabilityRequestDialog';
import { defaultRequestKind, showGettingStarted, tonightCounts, tonightSummary } from './format';
import { GettingStarted, OutboxBanner } from './GettingStarted';
import { NeedsReplacement } from './NeedsReplacement';
import { ThisWeek } from './ThisWeek';
import { TonightShows } from './TonightShows';
import { UnconfirmedTonight } from './UnconfirmedTonight';
import { useDashboard } from './useDashboard';

export function DashboardPage() {
  const { data, isPending, isError, error, refetch, isRefetching } = useDashboard();
  const isAdmin = useBooker().role === 'admin';
  const [requestDialog, setRequestDialog] = useState<RequestDialogTarget | null>(null);
  const onboarding = useOnboarding().data;
  const guide = useGuide();

  /** Request availability for the setup guide's month (the one with shows), audience everyone. */
  function requestGuideMonth() {
    if (!data) return;
    const month = onboarding?.suggestedMonth ?? data.planningMonth;
    setRequestDialog({ kind: defaultRequestKind(data.availability.find((p) => p.month === month)), month });
  }
  useGuideAction('request-availability', requestGuideMonth);

  if (isPending) {
    return (
      <div>
        <PageHeader title="Dashboard" />
        <PageSpinner />
      </div>
    );
  }

  if (isError) {
    return (
      <div>
        <PageHeader title="Dashboard" />
        <Card>
          <EmptyState
            icon={CircleAlert}
            title="Couldn't load the dashboard"
            description={errorMessage(error)}
            action={
              <Button variant="secondary" onClick={() => void refetch()} loading={isRefetching}>
                Try again
              </Button>
            }
          />
        </Card>
      </div>
    );
  }

  // null while the guide's state loads (so the banner doesn't flash before the checklist).
  const checklist = onboarding ? showGettingStarted(onboarding) : null;
  const guidePaused = guide != null && guide.mode === 'setup' && (!guide.open || guide.minimized);
  const resumeGuide = guidePaused ? (guide.minimized ? guide.restore : guide.start) : null;
  const guideRequesting = guide?.open && guide.mark?.id === 'request';

  return (
    <div>
      <PageHeader
        eyebrow="Dashboard"
        title={formatDateLong(data.today)}
        documentTitle="Dashboard"
        description={tonightSummary(tonightCounts(data))}
        actions={
          <Link to={`/app/day/${data.today}`} className={buttonClasses({ variant: 'secondary' })}>
            <CalendarDays aria-hidden />
            Tonight's lineups
          </Link>
        }
      />

      {(checklist || (checklist === false && isAdmin && !data.emailConfigured)) && (
        <div className="mb-5">
          {checklist && onboarding ? (
            <GettingStarted
              onboarding={onboarding}
              isAdmin={isAdmin}
              onRequestAvailability={requestGuideMonth}
              onResumeGuide={resumeGuide}
            />
          ) : (
            <OutboxBanner />
          )}
        </div>
      )}

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_23rem]">
        <div className="min-w-0 space-y-5">
          <UnconfirmedTonight data={data} />
          <NeedsReplacement rows={data.needsReplacement} today={data.today} />
          <TonightShows today={data.today} shows={data.tonight} />
        </div>
        <div className="min-w-0 space-y-5">
          <ThisWeek data={data} />
          <AvailabilityPanel
            data={data}
            onRequest={setRequestDialog}
            requestMonth={guideRequesting ? onboarding?.suggestedMonth : undefined}
          />
        </div>
      </div>

      {requestDialog && (
        <AvailabilityRequestDialog
          key={`${requestDialog.kind}-${requestDialog.month}`}
          open
          onOpenChange={(open) => !open && setRequestDialog(null)}
          kind={requestDialog.kind}
          initialMonth={requestDialog.month}
          data={data}
        />
      )}
    </div>
  );
}
