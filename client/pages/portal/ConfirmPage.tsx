/**
 * /portal/confirm/:token — the link in the weekly confirmation email. Works without a
 * session. Loading the page only READS the week (GET; email scanners prefetch links), and
 * confirming is an explicit POST, which also signs the comedian in.
 *
 * When the club allows declines, each spot has "Can't make it?" (optional note; a POST),
 * and the email's per-spot link (`?decline=<bookingId>`) opens that spot's form — it never
 * declines by itself. "Confirm my spots" confirms the rest; declined spots stay declined.
 *
 * States: the week's spots + "Confirm my spots" · confirmed 🎉 · already confirmed (or
 * all set, with some declined) · can't make any · no spots left this week · expired link
 * · invalid link.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, CircleCheck, LinkIcon, Mic, RotateCw, TimerOff } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { DECLINE_QUERY_PARAM, type ConfirmLinkInfo, type ConfirmLinkResult } from '../../../shared/api/portal';
import { formatDateShort, formatWeekday } from '../../../shared/time';
import { buttonClasses, Button, Card, PageSpinner } from '../../components/ui';
import { api, errorMessage, isApiError } from '../../lib/api';
import { usePageTitle } from '../../lib/usePageTitle';
import { useMe, useRefreshMe } from '../../lib/useMe';
import { portalKeys, useConfirmLink } from './portalQueries';
import { SpotList, weekLabel, weekRange, type SpotDeclineActions } from './SpotList';

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

/** "this week", "next week", "the week of Nov 16". */
function weekPhrase(weekStart: string, today: string): string {
  const label = weekLabel(weekStart, today);
  return label.startsWith('Week of') ? `the week of ${formatDateShort(weekStart)}` : label.toLowerCase();
}

export function ConfirmPage() {
  usePageTitle('Confirm your spots');
  const { token = '' } = useParams();
  const queryClient = useQueryClient();
  const refreshMe = useRefreshMe();
  const navigate = useNavigate();
  const info = useConfirmLink(token);
  const signedIn = Boolean(useMe().data?.comedian);
  const [params] = useSearchParams();
  const declineParam = Number(params.get(DECLINE_QUERY_PARAM));
  const openId = Number.isInteger(declineParam) && declineParam > 0 ? declineParam : null;

  const tokenPath = `/portal/confirm/${encodeURIComponent(token)}`;
  const afterDecline = (result: ConfirmLinkInfo) => {
    queryClient.setQueryData<ConfirmLinkInfo>(portalKeys.confirm(token), (old) =>
      // Keep the confirm result's extra fields (it's the same week).
      old ? { ...old, ...result } : result,
    );
    void queryClient.invalidateQueries({ queryKey: portalKeys.all, predicate: (q) => q.queryKey[1] !== 'confirm' });
  };
  const decline = useMutation({
    mutationFn: ({ bookingId, note }: { bookingId: number; note: string }) =>
      api.post<ConfirmLinkInfo>(`${tokenPath}/spots/${bookingId}/decline`, { note }),
    meta: { silent: true }, // the row toasts
    onSuccess: afterDecline,
  });
  const undoDecline = useMutation({
    mutationFn: (bookingId: number) => api.del<ConfirmLinkInfo>(`${tokenPath}/spots/${bookingId}/decline`),
    meta: { silent: true },
    onSuccess: afterDecline,
  });
  const { mutateAsync: declineAsync } = decline;
  const { mutateAsync: undoAsync } = undoDecline;
  const declineActions = useMemo<SpotDeclineActions>(
    () => ({
      openId,
      onDecline: (spot, note) => declineAsync({ bookingId: spot.bookingId, note }),
      onUndo: (spot) => undoAsync(spot.bookingId),
    }),
    [openId, declineAsync, undoAsync],
  );

  const confirm = useMutation({
    mutationFn: () => api.post<ConfirmLinkResult>(`/portal/confirm/${encodeURIComponent(token)}`),
    meta: { silent: true }, // shown inline
    onSuccess: async (result) => {
      queryClient.setQueryData<ConfirmLinkInfo>(portalKeys.confirm(token), result);
      void queryClient.invalidateQueries({ queryKey: portalKeys.all, predicate: (q) => q.queryKey[1] !== 'confirm' });
      await refreshMe(); // now signed in: the layout shows the portal tabs
    },
  });

  /** Already confirmed: the POST is harmless and signs them in, then open the portal. */
  const openPortal = useMutation({
    mutationFn: () => api.post<ConfirmLinkResult>(`/portal/confirm/${encodeURIComponent(token)}`),
    meta: { silent: true },
    onSuccess: async () => {
      await refreshMe();
      navigate('/portal/spots');
    },
  });

  if (info.isPending) return <PageSpinner />;

  if (info.isError) {
    const expired = isApiError(info.error, 'expired_token');
    const invalid = isApiError(info.error, 'invalid_token');
    if (expired || invalid) {
      return (
        <Panel
          icon={expired ? <TimerOff /> : <LinkIcon />}
          tone="muted"
          title={expired ? 'This confirmation link has expired' : "This link isn't valid"}
          description={`${
            expired
              ? 'Confirmation links stop working a couple of days after the week ends.'
              : 'It may have been copied incompletely.'
          } ${signedIn ? 'You can see and confirm your spots under My spots.' : 'Sign in to see and confirm your spots.'}`}
        >
          {signedIn ? (
            <Link to="/portal/spots" className={buttonClasses({ size: 'lg', className: 'w-full sm:w-auto' })}>
              <Mic /> Go to my spots
            </Link>
          ) : (
            <Link to="/portal/login?next=%2Fportal%2Fspots" className={buttonClasses({ size: 'lg', className: 'w-full sm:w-auto' })}>
              Sign in
            </Link>
          )}
        </Panel>
      );
    }
    return (
      <Panel icon={<RotateCw />} tone="muted" title="Couldn't load your spots" description={errorMessage(info.error)}>
        <Button variant="secondary" size="lg" onClick={() => void info.refetch()} loading={info.isFetching}>
          <RotateCw /> Try again
        </Button>
      </Panel>
    );
  }

  const data = info.data;
  const name = firstName(data.comedianName);
  const week = weekPhrase(data.weekStart, data.today);
  const justConfirmed = confirm.isSuccess;
  const playing = data.spots.filter((s) => s.declinedAt == null);
  const declinedCount = data.spots.length - playing.length;
  const nextSpot = playing.find((s) => s.startsAt > Date.now());
  const declines = data.allowDeclines ? declineActions : undefined;
  const spotList = <SpotList spots={data.spots} today={data.today} declines={declines} />;
  const declinedPhrase = `you can't make ${declinedCount === 1 ? 'one spot' : `${declinedCount} spots`}`;

  if (data.spots.length === 0) {
    return (
      <Panel
        icon={<CalendarDays />}
        tone="muted"
        title={`No spots ${week}`}
        description={`Hey ${name} — your spots for this week have changed and there's nothing to confirm. If that seems wrong, contact the club.`}
      >
        <Button variant="secondary" size="lg" onClick={() => openPortal.mutate()} loading={openPortal.isPending}>
          Open my portal
        </Button>
      </Panel>
    );
  }

  if (justConfirmed) {
    return (
      <Panel
        icon={<CircleCheck />}
        tone="success"
        title="You're confirmed!"
        description={`Thanks, ${name}.${nextSpot ? ` See you ${nextSpot.date === data.today ? 'tonight' : formatWeekday(nextSpot.date)}.` : ''}${
          declinedCount > 0 ? ` The club knows ${declinedPhrase}.` : ''
        }`}
        spots={spotList}
      >
        <Link to="/portal/spots" className={buttonClasses({ size: 'lg', className: 'w-full sm:w-auto' })}>
          <Mic /> See all my spots
        </Link>
        <Link to="/portal" className={buttonClasses({ variant: 'secondary', size: 'lg', className: 'w-full sm:w-auto' })}>
          <CalendarDays /> Mark my availability
        </Link>
      </Panel>
    );
  }

  if (data.unconfirmedCount === 0) {
    const allDeclined = playing.length === 0;
    return (
      <Panel
        icon={allDeclined ? <CalendarDays /> : <CircleCheck />}
        tone={allDeclined ? 'muted' : 'success'}
        title={allDeclined ? 'Thanks for letting the club know' : declinedCount > 0 ? "You're all set" : "You're already confirmed"}
        description={
          allDeclined
            ? `Hey ${name}, the club knows you can't make your ${data.spots.length === 1 ? 'spot' : 'spots'} ${week}.`
            : declinedCount > 0
              ? `Hey ${name}, the club knows ${declinedPhrase} ${week}; the rest are confirmed.`
              : `Hey ${name}, all your spots ${week} are confirmed. Nothing else to do.`
        }
        spots={spotList}
      >
        <Button variant="secondary" size="lg" className="w-full sm:w-auto" onClick={() => openPortal.mutate()} loading={openPortal.isPending}>
          Open my portal
        </Button>
      </Panel>
    );
  }

  const count = playing.length;
  const toConfirm = data.unconfirmedCount;
  return (
    <Panel
      title={`Hey ${name}, you're booked for ${count === 1 ? 'this spot' : 'these spots'} ${week}`}
      description={`${weekRange(data.weekStart)} · Please confirm so the club knows you're coming.`}
      spots={spotList}
    >
      <div className="w-full space-y-3">
        {confirm.isError && (
          <p role="alert" className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger">
            {errorMessage(confirm.error)}
          </p>
        )}
        <Button size="lg" className="h-12 w-full text-base" onClick={() => confirm.mutate()} loading={confirm.isPending}>
          <CircleCheck />{' '}
          {declinedCount > 0
            ? `Confirm the other ${toConfirm === 1 ? 'spot' : `${toConfirm} spots`}`
            : `Confirm my ${count === 1 ? 'spot' : 'spots'}`}
        </Button>
        <p className="text-center text-xs text-fg-muted">
          {data.allowDeclines
            ? 'Can’t make one? Tap “Can’t make it?” under that spot first.'
            : "Can't make one? Reply to the club's email to let them know."}
        </p>
      </div>
    </Panel>
  );
}

interface PanelProps {
  title: string;
  description?: ReactNode;
  icon?: ReactNode;
  tone?: 'success' | 'muted';
  /** The week's spots, in a card. */
  spots?: ReactNode;
  /** Actions. */
  children?: ReactNode;
}

function Panel({ title, description, icon, tone, spots, children }: PanelProps) {
  return (
    <div className="mx-auto w-full max-w-lg py-2 sm:py-6">
      {icon && (
        <div
          className={
            tone === 'success'
              ? 'mb-4 flex size-12 items-center justify-center rounded-full bg-confirmed-soft text-confirmed [&_svg]:size-6'
              : 'mb-4 flex size-12 items-center justify-center rounded-full bg-surface-2 text-fg-muted [&_svg]:size-6'
          }
          aria-hidden
        >
          {icon}
        </div>
      )}
      <h1 className="text-xl font-semibold tracking-tight text-balance text-fg">{title}</h1>
      {description && <p className="mt-1.5 text-[15px] text-fg-muted">{description}</p>}
      {spots && <Card className="mt-5 overflow-hidden">{spots}</Card>}
      {children && <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:flex-wrap">{children}</div>}
    </div>
  );
}
