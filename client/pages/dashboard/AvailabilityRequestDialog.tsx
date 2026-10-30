/**
 * Request availability / Remind dialog: month, request-or-reminder, audience (everyone or a
 * tag), optional personal message, and a live preview of the email the first recipient will
 * get. When the month was already asked for it says so ("You asked on Oct 22 · 18 of 29 have
 * submitted") and starts on Reminder, so a second click doesn't quietly re-email everyone.
 */
import { BellRing, History, Megaphone, Send } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  AVAILABILITY_MESSAGE_MAX,
  type AudienceProgress,
  type DashboardResponse,
} from '../../../shared/api/dashboard';
import { formatMonthLong, formatMonthName } from '../../../shared/time';
import type { AvailabilityAudience, AvailabilityRequestKind } from '../../../shared/types';
import { Button, Dialog, Field, Select, Spinner, Textarea } from '../../components/ui';
import { errorMessage } from '../../lib/api';
import { cn } from '../../lib/cn';
import { useClub } from '../../lib/useMe';
import { askedLine, defaultRequestKind, plural } from './format';
import { outboxNote, useAvailabilityPreview, useSendAvailabilityRequest } from './useDashboard';

export interface AvailabilityRequestDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Where the dialog starts; the booker can switch between request and reminder. */
  kind: AvailabilityRequestKind;
  initialMonth: string;
  data: DashboardResponse;
}

const KIND_OPTIONS: { value: AvailabilityRequestKind; label: string; icon: typeof Megaphone }[] = [
  { value: 'request', label: 'Request', icon: Megaphone },
  { value: 'reminder', label: 'Reminder', icon: BellRing },
];

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

/** Recipients for an audience from the dashboard's progress numbers (when we have the month). */
function audienceCount(a: AudienceProgress | undefined, kind: AvailabilityRequestKind): number | undefined {
  if (!a) return undefined;
  return kind === 'reminder' ? a.total - a.submitted : a.total;
}

export function AvailabilityRequestDialog({
  open,
  onOpenChange,
  kind: initialKind,
  initialMonth,
  data,
}: AvailabilityRequestDialogProps) {
  const timeZone = useClub()?.timezone ?? 'America/New_York';
  // The months the dashboard tracks: this month through the month after the planning month.
  const months = data.availability.map((p) => p.month);
  if (!months.includes(initialMonth)) months.push(initialMonth);

  const [month, setMonth] = useState(initialMonth);
  const [kind, setKind] = useState<AvailabilityRequestKind>(initialKind);
  const [audience, setAudience] = useState<AvailabilityAudience>('all');
  const [message, setMessage] = useState('');
  const debouncedMessage = useDebouncedValue(message.trim(), 400);

  const preview = useAvailabilityPreview({ month, kind, audience, message: debouncedMessage }, open);
  const send = useSendAvailabilityRequest(data.emailConfigured);

  const progress = data.availability.find((p) => p.month === month);
  const asked = askedLine(progress, timeZone);

  function changeMonth(next: string) {
    setMonth(next);
    // Each month starts on its own sensible kind (a reminder once it has been asked for).
    setKind(defaultRequestKind(data.availability.find((p) => p.month === next)));
  }

  const audienceOptions = [
    { value: 'all', label: 'Everyone', count: audienceCount(progress?.audiences[0], kind) },
    ...data.tags.map((tag) => ({
      value: `tag:${tag.id}`,
      label: tag.name,
      count: audienceCount(
        progress?.audiences.find((a) => a.audience === `tag:${tag.id}`),
        kind,
      ),
    })),
  ];
  const recipientCount =
    preview.data && !preview.isPlaceholderData
      ? preview.data.recipientCount
      : audienceOptions.find((o) => o.value === audience)?.count;
  const monthName = formatMonthName(month);
  const reminder = kind === 'reminder';
  const nobody = recipientCount === 0;
  const tooLong = message.length > AVAILABILITY_MESSAGE_MAX;

  function submit() {
    send.mutate(
      { month, audience, message: message.trim(), kind },
      { onSuccess: () => onOpenChange(false) },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !send.isPending && onOpenChange(next)}
      size="xl"
      title={reminder ? `Remind comedians about ${monthName}` : 'Request availability'}
      description={
        reminder
          ? `Emails only the comedians in the audience who haven't submitted ${monthName} yet.`
          : 'Emails each comedian a link that signs them in and opens their calendar for the month.'
      }
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={send.isPending}>
            Cancel
          </Button>
          <Button onClick={submit} loading={send.isPending} disabled={nobody || recipientCount === undefined || tooLong}>
            {!send.isPending && <Send aria-hidden />}
            {recipientCount === undefined ? 'Send' : `Send to ${plural(recipientCount, 'comedian')}`}
          </Button>
        </>
      }
    >
      <div className="grid gap-5 md:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]">
        <div className="space-y-4">
          <Field label="Month">
            <Select
              value={month}
              onChange={(e) => changeMonth(e.target.value)}
              options={months.map((m) => ({
                value: m,
                label: `${formatMonthLong(m)}${m === data.planningMonth ? ' (planning)' : ''}`,
              }))}
            />
          </Field>
          {asked && (
            <p className="-mt-2 flex items-start gap-1.5 text-xs text-fg-muted" data-testid="asked-line">
              <History className="mt-px size-3.5 shrink-0" aria-hidden />
              <span>{asked}</span>
            </p>
          )}
          <div role="radiogroup" aria-label="What to send" className="grid grid-cols-2 gap-1 rounded-lg bg-surface-2 p-1">
            {KIND_OPTIONS.map((option) => {
              const selected = option.value === kind;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setKind(option.value)}
                  className={cn(
                    'inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors',
                    selected ? 'bg-surface text-fg shadow-xs' : 'text-fg-muted hover:text-fg',
                  )}
                >
                  <option.icon className="size-3.5" aria-hidden />
                  {option.label}
                </button>
              );
            })}
          </div>
          {!reminder && progress?.lastRequest && progress.submitted > 0 && (
            <p className="rounded-md border border-awaiting/35 bg-awaiting-soft px-2.5 py-2 text-xs text-awaiting-fg">
              {monthName} was already requested. Asking again emails everyone in the audience, including the{' '}
              {progress.submitted} who already submitted.
            </p>
          )}
          <Field
            label="Send to"
            hint={reminder ? 'Only those who haven’t submitted are emailed.' : 'Archived comedians are never emailed.'}
          >
            <Select
              value={audience}
              onChange={(e) => setAudience(e.target.value as AvailabilityAudience)}
              options={audienceOptions.map((o) => ({
                value: o.value,
                label: o.count === undefined ? o.label : `${o.label} (${o.count})`,
              }))}
            />
          </Field>
          <Field
            label="Personal message"
            aside={
              <span className={tooLong ? 'text-xs text-danger' : 'text-xs text-fg-subtle'}>
                {message.length}/{AVAILABILITY_MESSAGE_MAX}
              </span>
            }
            hint="Optional. Shown above the button."
            error={tooLong ? 'That message is too long.' : undefined}
          >
            <Textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={5}
              placeholder={reminder ? 'We’re locking lineups on Friday!' : 'Holiday shows are filling up fast.'}
            />
          </Field>
          <div className="rounded-lg bg-surface-2 px-3 py-2.5 text-xs text-fg-muted" aria-live="polite">
            {nobody ? (
              reminder ? (
                `Everyone in this audience has already submitted ${monthName}.`
              ) : (
                'Nobody is in this audience.'
              )
            ) : recipientCount === undefined ? (
              'Counting recipients…'
            ) : (
              <>
                <span className="font-semibold text-fg">{plural(recipientCount, 'comedian')}</span> will get this email
                {reminder ? ` (those who haven't submitted ${monthName})` : ''}.
              </>
            )}
            {!data.emailConfigured && <p className="mt-1">{outboxNote(false)}</p>}
          </div>
        </div>

        <div className="min-w-0">
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <p className="text-[13px] font-medium text-fg">Preview</p>
            {preview.data && <p className="truncate text-xs text-fg-muted">To {preview.data.sampleName}</p>}
          </div>
          <div className="overflow-hidden rounded-lg border border-border bg-surface-2">
            <div className="border-b border-border bg-surface px-3 py-2 text-xs">
              <span className="text-fg-muted">Subject: </span>
              <span className="font-medium text-fg">{preview.data?.subject ?? '…'}</span>
            </div>
            <div className="relative h-[26rem]">
              {preview.data ? (
                <iframe
                  title="Email preview"
                  sandbox=""
                  srcDoc={preview.data.html}
                  className="size-full bg-white"
                />
              ) : preview.isError ? (
                <p className="p-4 text-sm text-danger">{errorMessage(preview.error)}</p>
              ) : (
                <div className="flex size-full items-center justify-center">
                  <Spinner label="Loading preview" />
                </div>
              )}
              {preview.isFetching && preview.data && (
                <Spinner className="absolute top-2 right-2 size-4" label="Updating preview" />
              )}
            </div>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
