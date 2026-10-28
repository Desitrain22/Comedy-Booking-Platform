/**
 * Dashboard section 1 (top, red): one row per unconfirmed booking tonight,
 * "John · 7 PM @ The Cellar · unconfirmed", with [Resend] and [Mark confirmed].
 */
import { CircleAlert, CircleCheck, Check, Mail, MoonStar } from 'lucide-react';
import { Link } from 'react-router';
import type { DashboardResponse, UnconfirmedTonightRow } from '../../../shared/api/dashboard';
import { formatRelative } from '../../../shared/time';
import { ComedianHoverCard } from '../../components/ComedianHoverCard';
import { Button, ColorDot } from '../../components/ui';
import { cn } from '../../lib/cn';
import { spotLabel } from './format';
import { useMarkConfirmed, useResendConfirmation } from './useDashboard';

export interface UnconfirmedTonightProps {
  data: DashboardResponse;
}

export function UnconfirmedTonight({ data }: UnconfirmedTonightProps) {
  const rows = data.unconfirmedTonight;
  const bookedTonight = data.tonight.reduce((n, s) => n + (s.status === 'scheduled' ? s.bookedCount : 0), 0);
  const markConfirmed = useMarkConfirmed();
  const resend = useResendConfirmation(data.emailConfigured);

  if (rows.length === 0) {
    const nobodyBooked = bookedTonight === 0;
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
            {nobodyBooked ? 'Nobody is booked tonight' : "Everyone's confirmed for tonight 🎉"}
          </h2>
          <p className="text-sm text-fg-muted">
            {nobodyBooked
              ? 'Unconfirmed comedians for tonight will show up here in red.'
              : `All ${bookedTonight} comedians on tonight's lineups have confirmed.`}
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
            onResend={() =>
              resend.mutate({ comedianId: row.comedianId, weekStart: data.week.weekStart, comedianName: row.comedianName })
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
  onResend: () => void;
  resending: boolean;
  onConfirm: () => void;
  confirming: boolean;
}

function UnconfirmedRow({ row, onResend, resending, onConfirm, confirming }: UnconfirmedRowProps) {
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
          {row.confirmationSentAt != null ? (
            <>Confirmation emailed {formatRelative(row.confirmationSentAt)}</>
          ) : (
            <>Confirmation never sent</>
          )}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
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
