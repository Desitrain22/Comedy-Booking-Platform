/**
 * Dashboard: declined spots from tonight on ("Needs a replacement"). The comedian said they
 * can't make it; the booking keeps its slot (struck through) until the booker replaces them
 * on the day view. Hidden when there are none. Separate from "Unconfirmed tonight": declined
 * spots aren't chased and never count as unconfirmed.
 */
import { ArrowRight, UserX } from 'lucide-react';
import { Link } from 'react-router';
import type { NeedsReplacementRow } from '../../../shared/api/dashboard';
import { formatRelative } from '../../../shared/time';
import { ComedianHoverCard } from '../../components/ComedianHoverCard';
import { ColorDot, buttonClasses } from '../../components/ui';
import { cn } from '../../lib/cn';
import { BOOKING_STATUS_CLASSES } from '../../lib/statusStyles';
import { nightLabel, spotLabel } from './format';

export interface NeedsReplacementProps {
  rows: NeedsReplacementRow[];
  /** The club night ("Tonight"). */
  today: string;
}

export function NeedsReplacement({ rows, today }: NeedsReplacementProps) {
  if (rows.length === 0) return null;
  return (
    <section
      aria-labelledby="needs-replacement-title"
      className="overflow-hidden rounded-lg border border-declined/40 bg-surface shadow-xs"
    >
      <header className="flex items-center gap-2.5 border-b border-declined/25 bg-declined-soft px-4 py-3">
        <UserX className="size-5 shrink-0 text-declined-fg" aria-hidden />
        <h2 id="needs-replacement-title" className="flex-1 text-sm font-semibold text-declined-fg">
          Needs a replacement
        </h2>
        <span className="rounded-full bg-declined px-2 py-0.5 text-xs font-semibold text-white tabular-nums">
          {rows.length}
        </span>
      </header>
      <ul className="divide-y divide-border">
        {rows.map((row) => (
          <ReplacementRow key={row.bookingId} row={row} today={today} />
        ))}
      </ul>
    </section>
  );
}

function ReplacementRow({ row, today }: { row: NeedsReplacementRow; today: string }) {
  const spot = spotLabel(row.startMin, row.location.name);
  const night = nightLabel(row.date, today);
  return (
    <li className="relative flex flex-wrap items-center gap-x-4 gap-y-2 py-3 pr-4 pl-5">
      <span aria-hidden className="absolute inset-y-2 left-0 w-1 rounded-r-full bg-declined" />
      <div className="min-w-0 flex-[1_1_18rem]">
        <p className="flex flex-wrap items-center gap-x-1.5 text-sm text-fg">
          <ComedianHoverCard comedianId={row.comedianId}>
            <Link
              to={`/app/comedians/${row.comedianId}`}
              className={cn('font-semibold underline-offset-2 hover:underline', BOOKING_STATUS_CLASSES.declined.name)}
            >
              {row.comedianName}
            </Link>
          </ComedianHoverCard>
          <span aria-hidden className="text-fg-subtle">
            ·
          </span>
          <span className="inline-flex items-center gap-1.5">
            <ColorDot color={row.location.color} />
            {spot}
          </span>
          <span aria-hidden className="text-fg-subtle">
            ·
          </span>
          <span className={cn('font-medium', row.date === today ? 'text-unconfirmed-fg' : 'text-fg-muted')}>{night}</span>
        </p>
        <p className="mt-0.5 truncate text-xs text-fg-muted">
          {row.showName && <>{row.showName} · </>}
          Declined {formatRelative(row.declinedAt)}
          {row.declineNote && <> · “{row.declineNote}”</>}
        </p>
      </div>
      <Link
        to={`/app/day/${row.date}`}
        className={buttonClasses({ variant: 'secondary', size: 'sm' })}
        aria-label={`Find a replacement for ${row.comedianName}, ${night} ${spot}`}
      >
        Find a replacement <ArrowRight aria-hidden />
      </Link>
    </li>
  );
}
