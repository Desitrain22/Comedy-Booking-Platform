import { useQuery } from '@tanstack/react-query';
import { CalendarX2, TriangleAlert } from 'lucide-react';
import { Link } from 'react-router';
import { MONTH_SHORT, WEEKDAY_SHORT, formatTime, weekdayOf } from '../../../shared/time';
import { BookingStatusBadge } from '../../components/BookingStatusBadge';
import { Card, CardHeader, EmptyState, Spinner } from '../../components/ui';
import { upcomingQuery } from './queries';

/** A comedian's booked spots from today on, soonest first, linking to each day's lineup. */
export function UpcomingSpots({ comedianId }: { comedianId: number }) {
  const { data, isPending } = useQuery(upcomingQuery(comedianId));
  const count = data?.length ?? 0;

  return (
    <Card>
      <CardHeader
        title="Upcoming spots"
        description={isPending ? undefined : count === 0 ? 'Nothing booked' : `${count} booked`}
      />
      {isPending ? (
        <div className="flex justify-center p-6">
          <Spinner />
        </div>
      ) : count === 0 ? (
        <EmptyState icon={CalendarX2} title="No upcoming spots" description="Book them from a day's lineup." className="py-8" />
      ) : (
        <ul className="divide-y divide-border">
          {data!.map((b) => {
            const [, m, d] = b.date.split('-').map(Number);
            return (
              <li key={b.id}>
                <Link
                  to={`/app/day/${b.date}`}
                  className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-surface-2/60"
                >
                  <div className="flex w-11 shrink-0 flex-col items-center rounded-md border border-border bg-surface-2/50 py-1 leading-none">
                    <span className="text-[10px] font-medium text-fg-muted uppercase">{WEEKDAY_SHORT[weekdayOf(b.date)]}</span>
                    <span className="mt-0.5 text-base font-semibold text-fg tabular-nums">{d}</span>
                    <span className="text-[10px] text-fg-muted uppercase">{MONTH_SHORT[m! - 1]}</span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1.5 truncate text-sm font-medium text-fg">
                      {formatTime(b.startMin)}
                      <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: b.location.color }} />
                      <span className="truncate">{b.location.name}</span>
                    </p>
                    <p className="flex items-center gap-1 truncate text-xs text-fg-muted">
                      {b.showName ? `${b.showName} · ` : ''}Slot {b.position + 1}
                      {b.overrideUnavailable && (
                        <span className="inline-flex items-center gap-0.5 text-awaiting-fg" title="Booked while marked unavailable">
                          · <TriangleAlert className="size-3" aria-hidden /> booked anyway
                        </span>
                      )}
                    </p>
                  </div>
                  <BookingStatusBadge status={b.status} short />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
