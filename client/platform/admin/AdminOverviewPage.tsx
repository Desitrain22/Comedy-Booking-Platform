/**
 * /admin: totals, then the clubs, filtered by status (Active by default) and searchable by
 * name, address or owner. A table on wide screens, stacked cards on phones. The filter and
 * search live in the URL (`?status=…&q=…`), so Back from a club returns to the same list.
 */
import { ExternalLink, Search, Store } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  ADMIN_CLUB_FILTERS,
  type AdminClubFilter,
  type AdminClubRow,
  type AdminClubStats,
  type AdminTotals,
} from '../../../shared/api/platformAdmin';
import { Badge, EmptyState, Input, PageSpinner } from '../../components/ui';
import { errorMessage } from '../../lib/api';
import { cn } from '../../lib/cn';
import { usePlatformHost } from '../PlatformApp';
import { usePlatformTitle } from '../PlatformShell';
import { useAdminOverview, useDebounced } from './adminApi';
import { formatAgo, formatDay, senderLabel, STATUS_BADGE, STATUS_LABEL } from './format';

const FILTER_LABEL: Record<AdminClubFilter, string> = {
  active: 'Active',
  suspended: 'Suspended',
  archived: 'Archived',
  all: 'All',
};

function parseFilter(raw: string | null): AdminClubFilter {
  return ADMIN_CLUB_FILTERS.includes(raw as AdminClubFilter) ? (raw as AdminClubFilter) : 'active';
}

export function AdminOverviewPage() {
  const host = usePlatformHost();
  usePlatformTitle('Owner console', host.platformName);
  const [params, setParams] = useSearchParams();
  const status = parseFilter(params.get('status'));
  const [search, setSearch] = useState(params.get('q') ?? '');
  const q = useDebounced(search.trim(), 250);

  // Keep the URL in step with the (debounced) search, without piling up history entries.
  useEffect(() => {
    if ((params.get('q') ?? '') === q) return;
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (q) next.set('q', q);
        else next.delete('q');
        return next;
      },
      { replace: true },
    );
  }, [q, params, setParams]);

  const setStatus = (value: AdminClubFilter) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value === 'active') next.delete('status');
        else next.set('status', value);
        return next;
      },
      { replace: true },
    );

  const overview = useAdminOverview(status, q);
  const data = overview.data;

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold tracking-tight text-fg">Overview</h1>

      {overview.isPending ? (
        <PageSpinner />
      ) : overview.isError && !data ? (
        <p role="alert" className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger">
          Couldn't load the clubs: {errorMessage(overview.error)}
        </p>
      ) : data ? (
        <>
          <Totals totals={data.totals} />

          <section aria-labelledby="clubs-heading" className="space-y-3">
            <h2 id="clubs-heading" className="text-base font-semibold text-fg">
              Clubs
            </h2>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <div role="group" aria-label="Status" className="flex flex-wrap gap-1.5">
                {ADMIN_CLUB_FILTERS.map((value) => {
                  const count =
                    value === 'all'
                      ? data.totals.clubs.active + data.totals.clubs.suspended + data.totals.clubs.archived
                      : data.totals.clubs[value];
                  const selected = status === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => setStatus(value)}
                      className={cn(
                        'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-sm font-medium transition-colors',
                        selected
                          ? 'border-accent bg-accent-soft text-accent'
                          : 'border-border-strong bg-surface text-fg hover:bg-surface-2',
                      )}
                    >
                      {FILTER_LABEL[value]}
                      <span className={cn('tabular-nums', selected ? 'text-accent' : 'text-fg-muted')}>{count}</span>
                    </button>
                  );
                })}
              </div>
              <div className="relative sm:ml-auto sm:w-72">
                <Search
                  aria-hidden
                  className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-fg-subtle"
                />
                <Input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Name, address or owner email"
                  aria-label="Search clubs"
                  className="pl-8"
                />
              </div>
            </div>

            {data.clubs.length === 0 ? (
              <div className="rounded-lg border border-border bg-surface">
                <EmptyState
                  icon={Store}
                  title={q ? 'No matching clubs' : `No ${status === 'all' ? '' : `${FILTER_LABEL[status].toLowerCase()} `}clubs`}
                  description={q ? 'Try another name, address or email.' : undefined}
                />
              </div>
            ) : (
              <>
                <ClubTable clubs={data.clubs} />
                <ClubCards clubs={data.clubs} />
              </>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Tile({ label, value, sub }: { label: string; value: number; sub?: ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-3 shadow-xs">
      <p className="text-xs font-medium text-fg-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-fg tabular-nums">{value.toLocaleString()}</p>
      {sub && <p className="mt-0.5 text-xs text-fg-muted">{sub}</p>}
    </div>
  );
}

function Totals({ totals }: { totals: AdminTotals }) {
  const { suspended, archived } = totals.clubs;
  return (
    <section aria-label="Totals" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      <Tile label="Active clubs" value={totals.clubs.active} sub={`${suspended} suspended · ${archived} archived`} />
      <Tile label="Bookers" value={totals.bookers} />
      <Tile label="Comedians" value={totals.comedians} />
      <Tile label="Upcoming shows" value={totals.upcomingShows} sub="Next 30 days" />
      <Tile label="Emails sent" value={totals.emailsSent7d} sub="Last 7 days" />
      <Tile label="Emails sent" value={totals.emailsSent30d} sub="Last 30 days" />
    </section>
  );
}

// ---------------------------------------------------------------------------

function ClubLinks({ club }: { club: AdminClubRow }) {
  return (
    <div className="min-w-0">
      <Link to={`/admin/clubs/${club.id}`} className="block truncate font-medium text-fg hover:text-accent">
        {club.name}
      </Link>
      <a
        href={club.url}
        target="_blank"
        rel="noreferrer"
        className="inline-flex max-w-full items-center gap-1 text-xs text-fg-muted hover:text-accent"
        aria-label={`Open ${club.host}`}
      >
        <span className="truncate">{club.host}</span>
        <ExternalLink className="size-3 shrink-0" aria-hidden />
      </a>
    </div>
  );
}

function Emails({ stats }: { stats: AdminClubStats }) {
  const title = `Platform sender: ${stats.platformSent30d} sent, ${stats.platformFailed30d} failed`;
  return (
    <span title={title} className="whitespace-nowrap tabular-nums">
      {stats.emailsSent30d.toLocaleString()}
      {stats.emailsFailed30d > 0 && (
        <span className="ml-1.5 rounded bg-danger-soft px-1 font-medium text-danger">
          {stats.emailsFailed30d} failed
        </span>
      )}
    </span>
  );
}

const NUMBER_CELL = 'px-3 py-2.5 text-right tabular-nums';

function ClubTable({ clubs }: { clubs: AdminClubRow[] }) {
  return (
    <div className="hidden overflow-x-auto rounded-lg border border-border bg-surface shadow-xs lg:block">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs whitespace-nowrap text-fg-muted">
            <th scope="col" className="px-4 py-2 font-medium">Club</th>
            <th scope="col" className="px-3 py-2 font-medium">Status</th>
            <th scope="col" className="px-3 py-2 font-medium">Owner</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Bookers</th>
            <th scope="col" className="px-3 py-2 font-medium">Last active</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Locations</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Comedians</th>
            <th scope="col" className="px-3 py-2 text-right font-medium" title="Next 30 days">Shows</th>
            <th scope="col" className="px-3 py-2 text-right font-medium" title="Last 30 days">Emails</th>
            <th scope="col" className="px-4 py-2 font-medium">Sender</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {clubs.map((club) => {
            const s = club.stats;
            return (
              <tr key={club.id} className="align-top">
                <td className="max-w-56 px-4 py-2.5">
                  <ClubLinks club={club} />
                  <p className="mt-0.5 text-xs text-fg-subtle">Since {formatDay(club.createdAt)}</p>
                </td>
                <td className="px-3 py-2.5">
                  <Badge variant={STATUS_BADGE[club.status]}>{STATUS_LABEL[club.status]}</Badge>
                </td>
                <td className="max-w-48 px-3 py-2.5">
                  <p className="truncate text-fg">{club.owner.name}</p>
                  <p className="truncate text-xs text-fg-muted">{club.owner.email}</p>
                </td>
                {s ? (
                  <>
                    <td className={NUMBER_CELL}>{s.bookers}</td>
                    <td className="px-3 py-2.5 whitespace-nowrap text-fg-muted">{formatAgo(s.lastActiveAt)}</td>
                    <td className={NUMBER_CELL}>{s.locations}</td>
                    <td className={NUMBER_CELL}>{s.comedians}</td>
                    <td className={NUMBER_CELL}>{s.upcomingShows}</td>
                    <td className={NUMBER_CELL}>
                      <Emails stats={s} />
                    </td>
                    <td className="px-4 py-2.5 text-xs text-fg-muted">{senderLabel(s)}</td>
                  </>
                ) : (
                  <td colSpan={7} className="px-3 py-2.5 text-xs text-fg-muted">
                    Couldn't read this club's database.
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function CardStat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-[11px] text-fg-muted">{label}</dt>
      <dd className="text-sm font-medium text-fg tabular-nums">{children}</dd>
    </div>
  );
}

function ClubCards({ clubs }: { clubs: AdminClubRow[] }) {
  return (
    <ul className="space-y-3 lg:hidden">
      {clubs.map((club) => {
        const s = club.stats;
        return (
          <li key={club.id} className="rounded-lg border border-border bg-surface p-4 shadow-xs">
            <div className="flex items-start justify-between gap-3">
              <ClubLinks club={club} />
              <Badge variant={STATUS_BADGE[club.status]}>{STATUS_LABEL[club.status]}</Badge>
            </div>
            <p className="mt-2 truncate text-xs text-fg-muted">
              {club.owner.name} · {club.owner.email}
            </p>
            {s ? (
              <>
                <dl className="mt-3 grid grid-cols-3 gap-x-3 gap-y-2">
                  <CardStat label="Bookers">{s.bookers}</CardStat>
                  <CardStat label="Comedians">{s.comedians}</CardStat>
                  <CardStat label="Locations">{s.locations}</CardStat>
                  <CardStat label="Shows (30d)">{s.upcomingShows}</CardStat>
                  <CardStat label="Emails (30d)">
                    <Emails stats={s} />
                  </CardStat>
                  <CardStat label="Last active">
                    <span className="font-normal">{formatAgo(s.lastActiveAt)}</span>
                  </CardStat>
                </dl>
                <p className="mt-3 text-xs text-fg-muted">
                  Since {formatDay(club.createdAt)} · {senderLabel(s)}
                </p>
              </>
            ) : (
              <p className="mt-3 text-xs text-fg-muted">Couldn't read this club's database.</p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
