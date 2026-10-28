/**
 * /app — the booker's dashboard (spec §6 F5): tonight at a glance.
 *
 *   ┌ Unconfirmed tonight (red) ─────────┐ ┌ This week ────────┐
 *   ├ Tonight's shows ───────────────────┤ ├ Availability ─────┤
 *
 * One payload (`GET /api/dashboard`, key `['dashboard']`), refreshed every minute.
 */
import { CalendarDays, CircleAlert } from 'lucide-react';
import { Link } from 'react-router';
import { formatDateLong } from '../../../shared/time';
import { Button, Card, EmptyState, PageHeader, PageSpinner, buttonClasses } from '../../components/ui';
import { errorMessage } from '../../lib/api';
import { AvailabilityPanel } from './AvailabilityPanel';
import { plural } from './format';
import { ThisWeek } from './ThisWeek';
import { TonightShows } from './TonightShows';
import { UnconfirmedTonight } from './UnconfirmedTonight';
import { useDashboard } from './useDashboard';

export function DashboardPage() {
  const { data, isPending, isError, error, refetch, isRefetching } = useDashboard();

  if (isPending) {
    return (
      <div className="mx-auto w-full max-w-7xl">
        <PageHeader title="Dashboard" />
        <PageSpinner />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="mx-auto w-full max-w-7xl">
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

  const scheduled = data.tonight.filter((s) => s.status === 'scheduled');
  const booked = scheduled.reduce((n, s) => n + s.bookedCount, 0);
  const summary = scheduled.length
    ? [
        `${plural(scheduled.length, 'show')} tonight`,
        `${booked} booked`,
        data.unconfirmedTonight.length ? `${data.unconfirmedTonight.length} unconfirmed` : 'all confirmed',
      ].join(' · ')
    : 'No shows tonight';

  return (
    <div className="mx-auto w-full max-w-7xl">
      <PageHeader
        eyebrow="Dashboard"
        title={formatDateLong(data.today)}
        documentTitle="Dashboard"
        description={summary}
        actions={
          <Link to={`/app/day/${data.today}`} className={buttonClasses({ variant: 'secondary' })}>
            <CalendarDays aria-hidden />
            Tonight's lineups
          </Link>
        }
      />

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_23rem]">
        <div className="min-w-0 space-y-5">
          <UnconfirmedTonight data={data} />
          <TonightShows today={data.today} shows={data.tonight} />
        </div>
        <div className="min-w-0 space-y-5">
          <ThisWeek data={data} />
          <AvailabilityPanel data={data} />
        </div>
      </div>
    </div>
  );
}
