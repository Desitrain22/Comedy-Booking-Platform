/**
 * Dashboard section 2: tonight's shows as compact cards with status-colored lineup chips
 * (declined comedians struck through: they still hold the slot until replaced).
 */
import { ArrowRight, CalendarPlus, TriangleAlert } from 'lucide-react';
import { Link } from 'react-router';
import type { TonightShow } from '../../../shared/api/dashboard';
import { BOOKING_STATUS_LABELS } from '../../../shared/bookingStatus';
import { formatTime } from '../../../shared/time';
import { ComedianHoverCard } from '../../components/ComedianHoverCard';
import { Badge, Card, CardHeader, EmptyState, buttonClasses } from '../../components/ui';
import { cn } from '../../lib/cn';
import { BOOKING_STATUS_CLASSES } from '../../lib/statusStyles';
import { plural } from './format';

export interface TonightShowsProps {
  today: string;
  shows: TonightShow[];
}

export function TonightShows({ today, shows }: TonightShowsProps) {
  const dayLink = `/app/day/${today}`;
  return (
    <Card>
      <CardHeader
        title="Tonight's shows"
        description={
          shows.length
            ? `${plural(shows.filter((s) => s.status === 'scheduled').length, 'show')} across ${plural(
                new Set(shows.map((s) => s.location.id)).size,
                'room',
              )}`
            : undefined
        }
        actions={
          shows.length > 0 && (
            <Link to={dayLink} className={buttonClasses({ variant: 'ghost', size: 'sm' })}>
              Open lineups <ArrowRight aria-hidden />
            </Link>
          )
        }
      />
      {shows.length === 0 ? (
        <EmptyState
          icon={CalendarPlus}
          title="No shows tonight"
          description="Enjoy the night off, or add shows from the calendar."
          action={
            <Link to="/app/calendar" className={buttonClasses({ variant: 'secondary', size: 'sm' })}>
              Open calendar
            </Link>
          }
          className="py-8"
        />
      ) : (
        <ul className="grid gap-3 p-4 sm:grid-cols-2">
          {shows.map((show) => (
            <li key={show.id}>
              <ShowCard show={show} dayLink={dayLink} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ShowCard({ show, dayLink }: { show: TonightShow; dayLink: string }) {
  const cancelled = show.status === 'cancelled';
  const open = Math.max(0, show.slotCount - show.bookedCount);
  const full = open === 0;
  return (
    <div
      className={cn(
        'group relative h-full overflow-hidden rounded-lg border border-border bg-surface transition-colors hover:border-border-strong',
        cancelled && 'bg-surface-2/60',
      )}
    >
      <span aria-hidden className="absolute inset-y-0 left-0 w-1" style={{ backgroundColor: show.location.color }} />
      <div className="py-3 pr-3 pl-4">
        <div className="flex items-start gap-2">
          <Link
            to={dayLink}
            className="min-w-0 flex-1 rounded-sm after:absolute after:inset-0 after:content-[''] focus-visible:outline-offset-4"
          >
            <span className={cn('block text-sm font-semibold text-fg', cancelled && 'text-fg-muted line-through')}>
              {formatTime(show.startMin)}
              {show.name && <span className="font-normal text-fg-muted"> · {show.name}</span>}
            </span>
            <span className="mt-0.5 block truncate text-xs text-fg-muted">{show.location.name}</span>
          </Link>
          {cancelled ? (
            <Badge variant="outline">Cancelled</Badge>
          ) : (
            <span
              className={cn(
                'shrink-0 rounded-md px-1.5 py-0.5 text-xs font-semibold tabular-nums',
                full ? 'bg-confirmed-soft text-confirmed-fg' : 'bg-surface-2 text-fg-muted',
              )}
              title={full ? 'Full lineup' : `${plural(open, 'open slot')}`}
            >
              {show.bookedCount}/{show.slotCount}
            </span>
          )}
        </div>

        {!cancelled && (
          <ul aria-label={`Lineup for ${formatTime(show.startMin)} at ${show.location.name}`} className="mt-2.5 flex flex-wrap gap-1.5">
            {show.bookings.map((b) => {
              const s = BOOKING_STATUS_CLASSES[b.status];
              return (
                <li key={b.id} className="relative z-10">
                  <ComedianHoverCard comedianId={b.comedianId}>
                    <Link
                      to={`/app/comedians/${b.comedianId}`}
                      className={cn(
                        'inline-flex max-w-44 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium',
                        s.chip,
                      )}
                    >
                      <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', s.dot)} />
                      <span className={cn('truncate', s.name)}>{b.comedianName}</span>
                      {b.overrideUnavailable && (
                        <TriangleAlert className="size-3 shrink-0" aria-label="Booked while unavailable" />
                      )}
                      <span className="sr-only">, {BOOKING_STATUS_LABELS[b.status]}</span>
                    </Link>
                  </ComedianHoverCard>
                </li>
              );
            })}
            {open > 0 && (
              <li className="inline-flex items-center rounded-full border border-dashed border-border-strong px-2 py-0.5 text-xs text-fg-subtle">
                {plural(open, 'open slot')}
              </li>
            )}
          </ul>
        )}
      </div>
    </div>
  );
}
