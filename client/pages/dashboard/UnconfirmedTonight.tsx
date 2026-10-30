/**
 * Dashboard section 1 (top, red): one row per unconfirmed booking tonight,
 * "John · 7 PM @ The Cellar · unconfirmed", with [Resend] and [Mark confirmed] (Undo in the
 * toast). Archived comedians are never emailed, so their rows say "Archived" instead of
 * offering Resend; nor is a spot whose show has started (emails only list spots ahead).
 * Declined spots live in "Needs a replacement", not here.
 */
import { CircleAlert, CircleCheck, Check, Mail, MoonStar } from 'lucide-react';
import { Link } from 'react-router';
import type { DashboardResponse, UnconfirmedTonightRow } from '../../../shared/api/dashboard';
import { CLUB_NIGHT_CUTOFF_MIN, formatRelative, MINUTES_PER_DAY } from '../../../shared/time';
import { ComedianHoverCard } from '../../components/ComedianHoverCard';
import { Badge, Button, ColorDot } from '../../components/ui';
import { cn } from '../../lib/cn';
import { plural, spotLabel, tonightCounts } from './format';
import { useMarkConfirmed, useResendConfirmation } from './useDashboard';

export interface UnconfirmedTonightProps {
  data: DashboardResponse;
}

export function UnconfirmedTonight({ data }: UnconfirmedTonightProps) {
  const rows = data.unconfirmedTonight;
  const counts = tonightCounts(data);
  const markConfirmed = useMarkConfirmed();
  const resend = useResendConfirmation(data.emailConfigured);
  // Minutes into tonight's club night (after midnight, the night's date is yesterday's).
  const nightMin = data.nowMin < CLUB_NIGHT_CUTOFF_MIN ? data.nowMin + MINUTES_PER_DAY : data.nowMin;

  if (rows.length === 0) {
    const nobodyBooked = counts.booked === 0;
    return (
      <section
        aria-labelledby="unconfirmed-tonight-title"
        className={cn(
          'flex items-center gap-3 rounded-lg border px-4 py-3.5 shadow-xs',
          nobodyBooked ? 'border-border bg-surface' : 'border-confirmed/30 bg-confirmed-soft',
        )}
      >
        <span
          className={cn(
            'flex size-9 shrink-0 items-center justify-center rounded-full',
            nobodyBooked ? 'bg-surface-2 text-fg-muted' : 'bg-confirmed/15 text-confirmed-fg',
          )}
        >
          {nobodyBooked ? <MoonStar className="size-5" aria-hidden /> : <CircleCheck className="size-5" aria-hidden />}
        </span>
        <div className="min-w-0">
          <h2 id="unconfirmed-tonight-title" className="text-sm font-semibold text-fg">
            {nobodyBooked
              ? 'No one is booked tonight'
              : counts.declined > 0
                ? 'Everyone else is confirmed for tonight'
                : "Everyone's confirmed for tonight 🎉"}
          </h2>
          <p className="text-sm text-fg-muted">
            {nobodyBooked
              ? counts.shows > 0
                ? 'Book comedians on the day view; anyone unconfirmed tonight shows up here in red.'
                : 'Anyone unconfirmed tonight shows up here in red.'
              : counts.declined > 0
                ? `${plural(counts.confirmed, 'comedian')} confirmed · ${counts.declined} declined (see Needs a replacement).`
                : `All ${plural(counts.booked, 'comedian')} on tonight's lineups ${counts.booked === 1 ? 'has' : 'have'} confirmed.`}
          </p>
        </div>
      </section>
    );
  }

  return (
    <section
      aria-labelledby="unconfirmed-tonight-title"
      className="overflow-hidden rounded-lg border border-unconfirmed/40 bg-surface shadow-xs"
    >
      <header className="flex items-center gap-2.5 border-b border-unconfirmed/25 bg-unconfirmed-soft px-4 py-3">
        <CircleAlert className="size-5 shrink-0 text-unconfirmed" aria-hidden />
        <h2 id="unconfirmed-tonight-title" className="flex-1 text-sm font-semibold text-unconfirmed-fg">
          Unconfirmed tonight
        </h2>
        <span className="rounded-full bg-unconfirmed px-2 py-0.5 text-xs font-semibold text-white tabular-nums">
          {rows.length}
        </span>
      </header>
      <ul className="divide-y divide-border">
        {rows.map((row) => (
          <UnconfirmedRow
            key={row.bookingId}
            row={row}
            started={row.startMin <= nightMin}
            onResend={
              row.comedianArchived || row.startMin <= nightMin
                ? undefined
                : () =>
                    resend.mutate({
                      comedianId: row.comedianId,
                      weekStart: data.week.weekStart,
                      comedianName: row.comedianName,
                    })
            }
            resending={resend.isPending && resend.variables?.comedianId === row.comedianId}
            onConfirm={() => markConfirmed.mutate(row)}
            confirming={markConfirmed.isPending && markConfirmed.variables?.bookingId === row.bookingId}
          />
        ))}
      </ul>
    </section>
  );
}

interface UnconfirmedRowProps {
  row: UnconfirmedTonightRow;
  /** The show has started: too late to email (Mark confirmed still works). */
  started: boolean;
  /** Absent for archived comedians (they're never emailed) and once the show has started. */
  onResend?: () => void;
  resending: boolean;
  onConfirm: () => void;
  confirming: boolean;
}

function UnconfirmedRow({ row, started, onResend, resending, onConfirm, confirming }: UnconfirmedRowProps) {
  const spot = spotLabel(row.startMin, row.location.name);
  return (
    <li className="relative flex flex-wrap items-center gap-x-4 gap-y-2 py-3 pr-4 pl-5">
      <span aria-hidden className="absolute inset-y-2 left-0 w-1 rounded-r-full bg-unconfirmed" />
      <div className="min-w-0 flex-[1_1_18rem]">
        <p className="flex flex-wrap items-center gap-x-1.5 text-sm text-fg">
          <ComedianHoverCard comedianId={row.comedianId}>
            <Link
              to={`/app/comedians/${row.comedianId}`}
              className="font-semibold text-fg underline-offset-2 hover:underline"
            >
              {row.comedianName}
            </Link>
          </ComedianHoverCard>
          {row.comedianArchived && (
            <Badge variant="outline" className="py-0 text-[11px]">
              Archived
            </Badge>
          )}
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
          <span className="font-medium text-unconfirmed-fg">unconfirmed</span>
        </p>
        <p className="mt-0.5 truncate text-xs text-fg-muted">
          {row.showName && <>{row.showName} · </>}
          {row.comedianArchived ? (
            <>Archived comedians don't get emails. Replace them or mark them confirmed.</>
          ) : row.confirmationSentAt != null ? (
            <>Confirmation emailed {formatRelative(row.confirmationSentAt)}</>
          ) : (
            <>Confirmation never sent</>
          )}
          {started && !row.comedianArchived && <> · The show has started</>}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {onResend && (
          <Button
            size="sm"
            variant="ghost"
            onClick={onResend}
            loading={resending}
            aria-label={`Resend confirmation email to ${row.comedianName}`}
          >
            {!resending && <Mail aria-hidden />}
            Resend
          </Button>
        )}
        <Button
          size="sm"
          variant="secondary"
          onClick={onConfirm}
          loading={confirming}
          aria-label={`Mark ${row.comedianName} confirmed for ${spot}`}
        >
          {!confirming && <Check aria-hidden />}
          Mark confirmed
        </Button>
      </div>
    </li>
  );
}
