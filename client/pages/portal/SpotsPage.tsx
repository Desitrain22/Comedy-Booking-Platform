/**
 * /portal/spots — the comedian's booked spots, grouped by week ("This week", "Week of
 * Nov 16"), with a "Confirm these spots" button per week that still has unconfirmed ones.
 * The past two weeks are collapsed at the bottom.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, Check, ChevronRight, Mic, RotateCw } from 'lucide-react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import type { ConfirmWeekResponse, PortalSpotWeek } from '../../../shared/api/portal';
import { buttonClasses, Button, Card, EmptyState, PageHeader, PageSpinner } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { portalKeys, useSpots } from './portalQueries';
import { SpotList, weekLabel, weekRange } from './SpotList';

export function SpotsPage() {
  const spots = useSpots();
  const queryClient = useQueryClient();

  const confirm = useMutation({
    mutationFn: (weekStart: string) => api.post<ConfirmWeekResponse>('/portal/spots/confirm', { weekStart }),
    onSuccess: ({ confirmedCount }) => {
      toast.success(
        confirmedCount > 0
          ? `Confirmed ${confirmedCount} ${confirmedCount === 1 ? 'spot' : 'spots'} — thanks!`
          : 'Those spots were already confirmed',
      );
      void queryClient.invalidateQueries({ queryKey: portalKeys.spots });
      void queryClient.invalidateQueries({ queryKey: portalKeys.me });
    },
  });

  const header = <PageHeader title="My spots" description="Confirm each week's spots so the club knows you're coming." />;

  if (!spots.data) {
    return (
      <>
        {header}
        {spots.isError ? (
          <EmptyState
            title="Couldn't load your spots"
            description={errorMessage(spots.error)}
            action={
              <Button variant="secondary" onClick={() => void spots.refetch()} loading={spots.isFetching}>
                <RotateCw /> Try again
              </Button>
            }
          />
        ) : (
          <PageSpinner />
        )}
      </>
    );
  }

  const { today, weeks } = spots.data;
  const upcoming = weeks.filter((w) => !w.past);
  const past = weeks.filter((w) => w.past).reverse(); // most recent first
  const pastCount = past.reduce((n, w) => n + w.spots.length, 0);

  return (
    <>
      {header}

      {upcoming.length === 0 ? (
        <Card>
          <EmptyState
            icon={Mic}
            title="No upcoming spots"
            description="When the club books you, your spots show up here."
            action={
              <Link to="/portal" className={buttonClasses({ variant: 'secondary', size: 'lg' })}>
                <CalendarDays /> Mark your availability
              </Link>
            }
          />
        </Card>
      ) : (
        <div className="space-y-6">
          {upcoming.map((week) => (
            <WeekSection
              key={week.weekStart}
              week={week}
              today={today}
              onConfirm={() => confirm.mutate(week.weekStart)}
              confirming={confirm.isPending && confirm.variables === week.weekStart}
            />
          ))}
        </div>
      )}

      {past.length > 0 && (
        <details className="group mt-8">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1.5 rounded-lg text-sm font-medium text-fg-muted select-none hover:text-fg [&::-webkit-details-marker]:hidden">
            <ChevronRight aria-hidden className="size-4 transition-transform group-open:rotate-90" />
            Past 2 weeks · {pastCount} {pastCount === 1 ? 'spot' : 'spots'}
          </summary>
          <div className="mt-3 space-y-6">
            {past.map((week) => (
              <WeekSection key={week.weekStart} week={week} today={today} />
            ))}
          </div>
        </details>
      )}
    </>
  );
}

interface WeekSectionProps {
  week: PortalSpotWeek;
  today: string;
  onConfirm?: () => void;
  confirming?: boolean;
}

function WeekSection({ week, today, onConfirm, confirming = false }: WeekSectionProps) {
  const headingId = `week-${week.weekStart}`;
  const needsConfirming = !week.past && week.unconfirmedCount > 0;
  return (
    <section aria-labelledby={headingId}>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 id={headingId} className="text-base font-semibold text-fg">
          {weekLabel(week.weekStart, today)}
          <span className="ml-2 text-sm font-normal text-fg-muted">{weekRange(week.weekStart)}</span>
        </h2>
        {!week.past &&
          (needsConfirming ? (
            <span className="text-xs font-medium text-awaiting-fg">
              {week.unconfirmedCount} to confirm
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-confirmed-fg">
              <Check aria-hidden className="size-3.5" /> All confirmed
            </span>
          ))}
      </div>
      <Card className={week.past ? 'opacity-80' : undefined}>
        <SpotList spots={week.spots} today={today} />
        {needsConfirming && onConfirm && (
          <div className="flex items-center justify-end border-t border-border px-4 py-3">
            <Button size="lg" className="w-full sm:h-10 sm:w-auto" onClick={onConfirm} loading={confirming}>
              <Check /> Confirm these spots
            </Button>
          </div>
        )}
      </Card>
    </section>
  );
}
