/**
 * /admin/clubs/:id: one club in depth (bookers, locations, 8 weeks of usage, failed emails,
 * database size, history) and the owner's actions on it.
 */
import { ArrowLeft, ExternalLink, Store } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import type { AdminClubDetail } from '../../../shared/api/platformAdmin';
import { Badge, Card, CardHeader, EmptyState, PageSpinner } from '../../components/ui';
import { errorMessage, isApiError } from '../../lib/api';
import { usePlatformHost } from '../PlatformApp';
import { usePlatformTitle } from '../PlatformShell';
import { useAdminClub } from './adminApi';
import { ClubActions } from './ClubActions';
import {
  EVENT_LABEL,
  formatAgo,
  formatBytes,
  formatDateTime,
  formatDay,
  formatWeek,
  senderLabel,
  STATUS_BADGE,
  STATUS_LABEL,
  VIA_LABEL,
} from './format';

const BACK = (
  <Link to="/admin" className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg">
    <ArrowLeft className="size-4" aria-hidden /> All clubs
  </Link>
);

export function AdminClubPage() {
  const host = usePlatformHost();
  const id = Number(useParams().id);
  const query = useAdminClub(id);
  usePlatformTitle(query.data?.club.name ?? 'Club', host.platformName);

  if (query.isPending && Number.isInteger(id) && id > 0) return <PageSpinner />;
  if (!query.data) {
    const missing = !Number.isInteger(id) || id <= 0 || isApiError(query.error, 'not_found');
    return (
      <div className="space-y-4">
        {BACK}
        <div className="rounded-lg border border-border bg-surface">
          <EmptyState
            icon={Store}
            title={missing ? 'No such club' : "Couldn't load this club"}
            description={missing ? undefined : errorMessage(query.error)}
          />
        </div>
      </div>
    );
  }
  return <ClubDetail detail={query.data} />;
}

function ClubDetail({ detail }: { detail: AdminClubDetail }) {
  const { club } = detail;
  const s = club.stats;
  return (
    <div className="space-y-5">
      {BACK}
      <header className="flex flex-col gap-4 md:flex-row md:items-start">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="min-w-0 text-xl font-semibold tracking-tight break-words text-fg">{club.name}</h1>
            <Badge variant={STATUS_BADGE[club.status]}>{STATUS_LABEL[club.status]}</Badge>
          </div>
          <a
            href={club.url}
            target="_blank"
            rel="noreferrer"
            className="mt-0.5 inline-flex max-w-full items-center gap-1 text-sm text-accent hover:underline"
          >
            <span className="truncate">{club.host}</span>
            <ExternalLink className="size-3.5 shrink-0" aria-hidden />
          </a>
          <p className="mt-1 text-sm text-fg-muted">
            Signed up {formatDay(club.createdAt)} by {club.owner.name} ({club.owner.email})
          </p>
        </div>
        <ClubActions club={club} />
      </header>

      {club.status !== 'active' && (
        <p className="rounded-lg border border-awaiting/40 bg-awaiting-soft px-3 py-2 text-sm text-awaiting-fg" role="status">
          {STATUS_LABEL[club.status]}
          {club.statusChangedAt ? ` ${formatDateTime(club.statusChangedAt)}` : ''}
          {club.statusReason ? ` — ${club.statusReason}` : ''}
        </p>
      )}
      {detail.dataError && (
        <p role="alert" className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger">
          Couldn't read this club's database: {detail.dataError}
        </p>
      )}

      <section aria-label="At a glance" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Glance label="Comedians">{s?.comedians ?? '—'}</Glance>
        <Glance label="Upcoming shows" sub="Next 30 days">
          {s?.upcomingShows ?? '—'}
        </Glance>
        <Glance
          label="Emails sent"
          sub={
            s ? (
              <span className={s.emailsFailed30d ? 'font-medium text-danger' : undefined}>
                {s.emailsFailed30d} failed · last 30 days
              </span>
            ) : (
              'Last 30 days'
            )
          }
        >
          {s?.emailsSent30d ?? '—'}
        </Glance>
        <Glance label="Database" sub={s ? `Last active ${formatAgo(s.lastActiveAt).toLowerCase()}` : undefined}>
          {formatBytes(detail.dbSizeBytes)}
        </Glance>
      </section>
      {s && (
        <p className="text-sm text-fg-muted">
          Emails come from: <span className="text-fg">{senderLabel(s)}</span>. Platform sender, last 30 days:{' '}
          {s.platformSent30d} sent, {s.platformFailed30d} failed.
        </p>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title={`Bookers (${detail.bookers.length})`} />
          {detail.bookers.length ? (
            <ul className="divide-y divide-border">
              {detail.bookers.map((b) => (
                <li key={b.id} className="flex items-start gap-3 px-4 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-fg">{b.name}</p>
                    <p className="truncate text-xs text-fg-muted">{b.email}</p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <div className="flex gap-1">
                      {b.role === 'admin' && <Badge variant="accent">Admin</Badge>}
                      {b.status === 'invited' && <Badge variant="warning">Invite pending</Badge>}
                      {b.status === 'invite_expired' && <Badge variant="outline">Invite expired</Badge>}
                    </div>
                    {b.status === 'active' && (
                      <span className="text-xs text-fg-muted">Signed in {formatAgo(b.lastLoginAt).toLowerCase()}</span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No bookers.</Empty>
          )}
        </Card>

        <Card>
          <CardHeader title={`Locations (${detail.locations.filter((l) => !l.archived).length})`} />
          {detail.locations.length ? (
            <ul className="divide-y divide-border">
              {detail.locations.map((l) => (
                <li key={l.id} className="flex items-start gap-3 px-4 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-fg">{l.name}</p>
                    {l.address && <p className="truncate text-xs text-fg-muted">{l.address}</p>}
                  </div>
                  {l.archived && <Badge variant="outline">Archived</Badge>}
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No locations.</Empty>
          )}
        </Card>
      </div>

      <Card>
        <CardHeader title="Last 8 weeks" description={detail.timezone ? `Weeks start Monday, ${detail.timezone}` : undefined} />
        {detail.usage.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs whitespace-nowrap text-fg-muted">
                  <th scope="col" className="px-4 py-2 font-medium">Week of</th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">Emails</th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">Failed</th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">Bookings</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">
                    <span className="hidden sm:inline">Availability</span>
                    <span className="sm:hidden">Avail.</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border tabular-nums">
                {[...detail.usage].reverse().map((w) => (
                  <tr key={w.weekStart}>
                    <td className="px-4 py-2 whitespace-nowrap text-fg">{formatWeek(w.weekStart)}</td>
                    <td className="px-2 py-2 text-right">{w.emailsSent}</td>
                    <td className={`px-2 py-2 text-right ${w.emailsFailed ? 'font-medium text-danger' : 'text-fg-muted'}`}>
                      {w.emailsFailed}
                    </td>
                    <td className="px-2 py-2 text-right">{w.bookings}</td>
                    <td className="px-4 py-2 text-right">{w.availabilitySubmissions}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No usage to show.</Empty>
        )}
      </Card>

      <Card>
        <CardHeader title="Failed emails" description="The last 10. Bodies aren't shown." />
        {detail.failedEmails.length ? (
          <ul className="divide-y divide-border">
            {detail.failedEmails.map((e) => (
              <li key={e.id} className="px-4 py-2.5">
                <p className="truncate text-sm font-medium text-fg" title={e.subject}>
                  {e.subject}
                </p>
                <p className="truncate text-xs text-fg-muted">
                  To {e.toEmail} · {VIA_LABEL[e.via]} · {formatDateTime(e.createdAt)}
                </p>
                {e.error && <p className="mt-0.5 text-xs break-words text-danger">{e.error}</p>}
              </li>
            ))}
          </ul>
        ) : (
          <Empty>No failed emails.</Empty>
        )}
      </Card>

      <Card>
        <CardHeader title="History" description="What you and other owners did here." />
        {detail.events.length ? (
          <ul className="divide-y divide-border">
            {detail.events.map((e) => (
              <li key={e.id} className="px-4 py-2.5">
                <p className="text-sm text-fg">
                  <span className="font-medium">{EVENT_LABEL[e.action]}</span>
                  {e.reason ? ` — ${e.reason}` : ''}
                </p>
                <p className="text-xs text-fg-muted">
                  {formatDateTime(e.createdAt)} · {e.adminEmail}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>Nothing yet.</Empty>
        )}
      </Card>
    </div>
  );
}

function Glance({ label, sub, children }: { label: string; sub?: ReactNode; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-3 shadow-xs">
      <p className="text-xs font-medium text-fg-muted">{label}</p>
      <p className="mt-1 text-xl font-semibold text-fg tabular-nums">{children}</p>
      {sub && <p className="mt-0.5 text-xs text-fg-muted">{sub}</p>}
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-4 py-6 text-center text-sm text-fg-muted">{children}</p>;
}
