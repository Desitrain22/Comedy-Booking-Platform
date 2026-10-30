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
 */
import { CalendarDays, CircleAlert } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { formatDateLong } from '../../../shared/time';
import { Button, Card, EmptyState, PageHeader, PageSpinner, buttonClasses } from '../../components/ui';
import { errorMessage } from '../../lib/api';
import { useBooker } from '../../lib/useMe';
import { AvailabilityPanel, type RequestDialogTarget } from './AvailabilityPanel';
import { AvailabilityRequestDialog } from './AvailabilityRequestDialog';
import { defaultRequestKind, setupSteps, showChecklist, tonightCounts, tonightSummary } from './format';
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

  const steps = setupSteps(data, isAdmin);
  const checklist = showChecklist(steps);
  const planningProgress = data.availability.find((p) => p.month === data.planningMonth);

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

      {(checklist || (isAdmin && !data.emailConfigured)) && (
        <div className="mb-5">
          {checklist ? (
            <GettingStarted
              steps={steps}
              canRequestAvailability={data.setup.comedians > 0}
              onRequestAvailability={() =>
                setRequestDialog({ kind: defaultRequestKind(planningProgress), month: data.planningMonth })
              }
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
          <AvailabilityPanel data={data} onRequest={setRequestDialog} />
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
