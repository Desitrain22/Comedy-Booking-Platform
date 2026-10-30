/**
 * Settings → Email → Email log: the latest 100 emails (sent, failed or outbox) and a
 * viewer that renders the body in a sandboxed iframe. Until SMTP is set up this is how
 * club staff read comedians' sign-in codes.
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ExternalLink, Inbox, RefreshCw, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  EMAIL_KIND_LABELS,
  EMAIL_STATUS_LABELS,
  type EmailLogDetail,
  type EmailLogItem,
} from '../../../shared/api/settings';
import { formatRelative } from '../../../shared/time';
import { EMAIL_KINDS, type EmailKind, type EmailStatus } from '../../../shared/types';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Dialog,
  EmptyState,
  Input,
  PageSpinner,
  Select,
  Spinner,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  type BadgeVariant,
} from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { cn } from '../../lib/cn';
import { useClub } from '../../lib/useMe';
import { describeVia, extractLinks, extractLoginCode, previewDocument } from './emailProviders';
import { Callout, CopyButton, CopyField } from './SettingsParts';
import { EMAIL_LOG_KEY } from './settingsData';

const STATUS_VARIANTS: Record<EmailStatus, BadgeVariant> = {
  sent: 'success',
  failed: 'danger',
  outbox: 'neutral',
};

export function EmailStatusBadge({ status }: { status: EmailStatus }) {
  return <Badge variant={STATUS_VARIANTS[status]}>{EMAIL_STATUS_LABELS[status]}</Badge>;
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

function useFormatDateTime() {
  const timeZone = useClub()?.timezone;
  return (ms: number) => {
    try {
      return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(ms);
    } catch {
      return new Date(ms).toLocaleString();
    }
  };
}

export function EmailLogCard({ onOpen }: { onOpen: (id: number) => void }) {
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState<EmailKind | ''>('');
  const q = useDebounced(search.trim(), 250);
  const formatDateTime = useFormatDateTime();

  const log = useQuery({
    queryKey: [...EMAIL_LOG_KEY, { q, kind }],
    queryFn: ({ signal }) =>
      api.get<EmailLogItem[]>('/email-log', { query: { q: q || undefined, kind: kind || undefined }, signal }),
    placeholderData: keepPreviousData,
    // New sign-in codes show up without a reload.
    refetchInterval: 10_000,
  });
  const filtered = Boolean(q || kind);

  return (
    <Card id="email-log" className="scroll-mt-4">
      <CardHeader
        title="Email log"
        description="The latest 100 emails, newest first. Open one to read it — including outbox emails that were never sent."
        actions={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Refresh email log"
            onClick={() => void log.refetch()}
            disabled={log.isFetching}
          >
            <RefreshCw aria-hidden className={cn(log.isFetching && 'animate-spin')} />
          </Button>
        }
      />
      <div className="flex flex-wrap gap-2 border-b border-border px-4 py-3">
        <div className="relative min-w-48 flex-1">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-fg-subtle" />
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by recipient or subject"
            aria-label="Search emails"
            className="pl-8"
          />
        </div>
        <Select
          aria-label="Email type"
          value={kind}
          onChange={(e) => setKind(e.target.value as EmailKind | '')}
          wrapperClassName="w-48"
        >
          <option value="">All types</option>
          {EMAIL_KINDS.map((k) => (
            <option key={k} value={k}>
              {EMAIL_KIND_LABELS[k]}
            </option>
          ))}
        </Select>
      </div>

      {log.isPending ? (
        <PageSpinner className="min-h-32" />
      ) : log.isError ? (
        <div className="p-4">
          <Callout tone="danger" title="Couldn't load the email log">
            {errorMessage(log.error)}
          </Callout>
        </div>
      ) : log.data.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title={filtered ? 'No matching emails' : 'No emails yet'}
          description={
            filtered
              ? 'Try a different search or type.'
              : 'Sign-in codes, availability requests, confirmations and invites will show up here.'
          }
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-fg-muted">
                <th scope="col" className="px-4 py-2 font-medium">
                  When
                </th>
                <th scope="col" className="px-2 py-2 font-medium">
                  To
                </th>
                <th scope="col" className="px-2 py-2 font-medium">
                  Subject
                </th>
                <th scope="col" className="hidden px-2 py-2 font-medium md:table-cell">
                  Type
                </th>
                <th scope="col" className="hidden px-2 py-2 font-medium lg:table-cell">
                  Sent via
                </th>
                <th scope="col" className="px-4 py-2 text-right font-medium">
                  Status
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {log.data.map((email) => (
                <tr
                  key={email.id}
                  onClick={() => onOpen(email.id)}
                  className="cursor-pointer transition-colors hover:bg-surface-2/60"
                >
                  <td className="px-4 py-2.5 whitespace-nowrap text-fg-muted" title={formatDateTime(email.createdAt)}>
                    {formatRelative(email.createdAt)}
                  </td>
                  <td className="max-w-48 truncate px-2 py-2.5 text-fg">{email.toEmail}</td>
                  <td className="max-w-0 w-full px-2 py-2.5">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpen(email.id);
                      }}
                      className="block w-full truncate rounded text-left font-medium text-fg hover:text-accent"
                      title={email.subject}
                    >
                      {email.subject}
                    </button>
                  </td>
                  <td className="hidden px-2 py-2.5 whitespace-nowrap text-fg-muted md:table-cell">
                    {EMAIL_KIND_LABELS[email.kind]}
                  </td>
                  <td className="hidden max-w-48 truncate px-2 py-2.5 text-fg-muted lg:table-cell" title={describeVia(email)}>
                    {describeVia(email)}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <EmailStatusBadge status={email.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------

export function EmailViewerDialog({ id, onClose }: { id: number | null; onClose: () => void }) {
  const formatDateTime = useFormatDateTime();
  const detail = useQuery({
    queryKey: [...EMAIL_LOG_KEY, 'detail', id],
    queryFn: ({ signal }) => api.get<EmailLogDetail>(`/email-log/${id}`, { signal }),
    enabled: id !== null,
    staleTime: Infinity,
  });
  const email = detail.data;

  return (
    <Dialog
      open={id !== null}
      onOpenChange={(open) => !open && onClose()}
      title={email?.subject ?? 'Email'}
      description={email ? `To ${email.toEmail}` : undefined}
      size="xl"
    >
      {detail.isPending ? (
        <div className="flex min-h-48 items-center justify-center">
          <Spinner />
        </div>
      ) : detail.isError ? (
        <Callout tone="danger" title="Couldn't load this email">
          {errorMessage(detail.error)}
        </Callout>
      ) : email ? (
        <EmailDetail email={email} sentAt={formatDateTime(email.createdAt)} />
      ) : null}
    </Dialog>
  );
}

function EmailDetail({ email, sentAt }: { email: EmailLogDetail; sentAt: string }) {
  const code = email.kind === 'login_code' ? extractLoginCode(email.bodyText) : null;
  const links = email.kind === 'login_code' ? [] : extractLinks(email.bodyText);

  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[auto_1fr_auto_1fr]">
        <dt className="text-fg-muted">When</dt>
        <dd className="text-fg">{sentAt}</dd>
        <dt className="text-fg-muted">Type</dt>
        <dd className="text-fg">{EMAIL_KIND_LABELS[email.kind]}</dd>
        <dt className="text-fg-muted">Status</dt>
        <dd>
          <EmailStatusBadge status={email.status} />
        </dd>
        {email.via && (
          <>
            <dt className="text-fg-muted">Sent via</dt>
            <dd className="min-w-0 break-words text-fg">{describeVia(email)}</dd>
          </>
        )}
      </dl>

      {email.status === 'outbox' && (
        <Callout icon={Inbox}>
          This email was <strong>not sent</strong> — email isn’t set up, so it was saved here instead.
          {code || links.length ? ' Pass on what the recipient needs:' : ''}
        </Callout>
      )}
      {email.status === 'failed' && email.error && (
        <Callout tone="danger" title="Sending failed">
          <code className="font-mono text-xs break-words whitespace-pre-wrap">{email.error}</code>
        </Callout>
      )}

      {code && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface-2/60 px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="text-xs text-fg-muted">Sign-in code</p>
            <p className="font-mono text-2xl font-semibold tracking-[0.3em] text-fg">{code}</p>
          </div>
          <CopyButton value={code} label="Sign-in code" />
        </div>
      )}

      {links.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-fg-muted">Links in this email</p>
          {links.map((link) => (
            <div key={link} className="flex items-center gap-2">
              <CopyField value={link} label="Link" className="min-w-0 flex-1" />
              <a
                href={link}
                target="_blank"
                rel="noreferrer"
                className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-fg-muted hover:bg-surface-2 hover:text-fg"
                aria-label="Open link in a new tab"
              >
                <ExternalLink className="size-4" aria-hidden />
              </a>
            </div>
          ))}
        </div>
      )}

      <Tabs defaultValue={email.bodyHtml ? 'html' : 'text'}>
        <TabsList>
          <TabsTrigger value="html" disabled={!email.bodyHtml}>
            Email
          </TabsTrigger>
          <TabsTrigger value="text">Plain text</TabsTrigger>
        </TabsList>
        <TabsContent value="html">
          <iframe
            title={`Preview of “${email.subject}”`}
            // No scripts, no same-origin access, no forms; links open in a new tab.
            sandbox="allow-popups allow-popups-to-escape-sandbox"
            srcDoc={previewDocument(email.bodyHtml)}
            className="h-[28rem] w-full rounded-lg border border-border bg-white"
          />
        </TabsContent>
        <TabsContent value="text">
          <pre className="max-h-[28rem] overflow-auto rounded-lg border border-border bg-surface-2/60 p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap text-fg">
            {email.bodyText || '(no plain-text version)'}
          </pre>
        </TabsContent>
      </Tabs>
    </div>
  );
}
