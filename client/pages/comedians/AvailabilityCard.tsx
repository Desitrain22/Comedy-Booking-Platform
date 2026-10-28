/** Read-only month view of a comedian's availability (green ranges) plus their booked spots. */
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ComedianBooking } from '../../../shared/api/comedians';
import { formatAvailability } from '../../../shared/availability';
import {
  addMonths,
  formatDateShort,
  formatMonthLong,
  formatMonthName,
  formatTime,
  monthOf,
  todayInTz,
} from '../../../shared/time';
import { MonthGrid } from '../../components/MonthGrid';
import { Badge, Button, Card, CardBody, CardHeader } from '../../components/ui';
import { cn } from '../../lib/cn';
import { useClub } from '../../lib/useMe';
import { comedianAvailabilityQuery } from './queries';

/** "The Cellar" → "Cellar", to fit day cells (the full name is in the tooltip). */
function shortLocation(name: string): string {
  return name.replace(/^the\s+/i, '') || name;
}

export function AvailabilityCard({ comedianId }: { comedianId: number }) {
  const club = useClub();
  const timezone = club?.timezone ?? 'America/New_York';
  const thisMonth = monthOf(todayInTz(timezone));
  const [month, setMonth] = useState(thisMonth);
  const query = useQuery(comedianAvailabilityQuery(comedianId, month));
  const data = query.data?.month === month ? query.data : undefined;

  const entries = useMemo(() => new Map(data?.entries.map((e) => [e.date, e]) ?? []), [data]);
  const spotsByDate = useMemo(() => {
    const map = new Map<string, ComedianBooking[]>();
    for (const b of data?.bookings ?? []) map.set(b.date, [...(map.get(b.date) ?? []), b]);
    return map;
  }, [data]);

  const nights = data?.entries.length ?? 0;

  return (
    <Card>
      <CardHeader
        title="Availability"
        description={
          !data ? (
            'Loading…'
          ) : data.submittedAt ? (
            <span className="inline-flex flex-wrap items-center gap-1.5">
              <Badge variant="success">Submitted {formatDateShort(todayInTz(timezone, new Date(data.submittedAt)))}</Badge>
              <span>
                {nights} night{nights === 1 ? '' : 's'} marked in {formatMonthName(month)}
              </span>
            </span>
          ) : (
            <span className="inline-flex flex-wrap items-center gap-1.5">
              <Badge variant="neutral">Hasn't submitted {formatMonthName(month)}</Badge>
              {nights > 0 && <span>{nights} nights marked so far</span>}
            </span>
          )
        }
        actions={
          <div className="flex items-center gap-1">
            {month !== thisMonth && (
              <Button variant="ghost" size="sm" onClick={() => setMonth(thisMonth)}>
                This month
              </Button>
            )}
            <Button variant="ghost" size="icon-sm" aria-label="Previous month" onClick={() => setMonth(addMonths(month, -1))}>
              <ChevronLeft />
            </Button>
            <span className="w-32 text-center text-sm font-medium text-fg tabular-nums" aria-live="polite">
              {formatMonthLong(month)}
            </span>
            <Button variant="ghost" size="icon-sm" aria-label="Next month" onClick={() => setMonth(addMonths(month, 1))}>
              <ChevronRight />
            </Button>
          </div>
        }
      />
      <CardBody className={cn('transition-opacity', !data && 'opacity-60')}>
        <MonthGrid
          month={month}
          today={data?.today}
          weekdayLabels="short"
          cellClassName="min-h-[4.25rem]"
          aria-label={`${formatMonthLong(month)} availability`}
          dayClassName={(date) => entries.has(date) && 'border-available/50 bg-available-soft'}
          renderDay={(date) => {
            const entry = entries.get(date);
            const spots = spotsByDate.get(date);
            return (
              <>
                {entry && (
                  <span
                    className="truncate text-[11px] leading-tight font-medium text-available-fg"
                    title={`Available ${formatAvailability(entry, data?.allNight)}`}
                  >
                    {formatAvailability(entry, data?.allNight)}
                  </span>
                )}
                {spots?.map((b) => (
                  <span
                    key={b.id}
                    className="flex min-w-0 items-center gap-1 text-[11px] leading-tight text-fg"
                    title={`${formatTime(b.startMin)} at ${b.location.name}${b.showName ? ` (${b.showName})` : ''}`}
                  >
                    <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: b.location.color }} />
                    <span className="truncate">
                      {formatTime(b.startMin)} {shortLocation(b.location.name)}
                    </span>
                  </span>
                ))}
              </>
            );
          }}
        />
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-muted">
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="size-3 rounded border border-available/50 bg-available-soft" /> Available
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="size-1.5 rounded-full bg-fg-muted" /> Booked spot
          </span>
          <span>Blank nights count as not available.</span>
        </div>
      </CardBody>
    </Card>
  );
}
