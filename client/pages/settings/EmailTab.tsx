/**
 * Settings → Email: who emails come from (the company, or each booker), the company email
 * that replies go to, a preview of what comedians see, an optional mailbox to send from
 * (with provider presets), a test email, and (admins only) the email log, outbox included.
 * The log holds comedians' sign-in codes and links, so other bookers see a short note instead.
 *
 * In hosted mode emails already go out through the platform's sender with no setup, so the
 * mailbox is folded away until someone asks for it. Only admins can change these settings
 * (they decide where every sign-in link and confirmation goes); other bookers see them
 * read-only and can send themselves a test. Changing the server, port, security or
 * username needs the password again: the server drops a saved password rather than send
 * it somewhere new.
 */
import { Inbox, Lock, Mail, Plug, Send, Unplug } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { SENDER_MODES, type SenderMode, type SettingsDto, type UpdateSettingsInput } from '../../../shared/api/settings';
import { emailSchema } from '../../../shared/schemas';
import { formatRelative } from '../../../shared/time';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  ConfirmDialog,
  Field,
  Input,
  PageSpinner,
} from '../../components/ui';
import { errorMessage } from '../../lib/api';
import { cn } from '../../lib/cn';
import { useBooker } from '../../lib/useMe';
import { EmailLogCard, EmailViewerDialog } from './EmailLog';
import {
  MailboxConnectionFields,
  SenderLine,
  TestResultCallout,
  fromEmailHint,
  useTestEmail,
  type TestEmailState,
} from './MailboxFields';
import { connectionDraftFrom, connectionPatch, type ConnectionDraft } from './mailboxDraft';
import { Callout, SaveFooter } from './SettingsParts';
import {
  EMAIL_LOG_KEY,
  SETTINGS_KEY,
  apiFieldErrors,
  pick,
  useDraft,
  useSaveSettings,
  useSettings,
  validateSettingsPatch,
} from './settingsData';

export type { TestEmailState } from './MailboxFields';

const EMAIL_FIELDS = [
  'smtpHost',
  'smtpPort',
  'smtpSecure',
  'smtpUser',
  'smtpPassSet',
  'fromName',
  'fromEmail',
  'replyTo',
  'senderMode',
] as const;
type SavedEmail = Pick<SettingsDto, (typeof EMAIL_FIELDS)[number]>;

interface EmailDraft extends ConnectionDraft {
  fromName: string;
  fromEmail: string;
  /** The company email. */
  replyTo: string;
  senderMode: SenderMode;
}

function draftFrom(saved: SavedEmail): EmailDraft {
  return {
    ...connectionDraftFrom(saved),
    fromName: saved.fromName,
    fromEmail: saved.fromEmail,
    replyTo: saved.replyTo,
    senderMode: saved.senderMode,
  };
}

const SENDER_OPTIONS: Record<SenderMode, { label: string; description: (club: string) => string }> = {
  company: {
    label: 'Company',
    description: (club) => `Every email comes from ${club}. Replies go to the company email.`,
  },
  booker: {
    label: 'Each booker',
    description: () =>
      'Availability requests and confirmations come from the booker who sent or booked them, and replies go to that booker.',
  },
};

export function EmailTab() {
  const isAdmin = useBooker().role === 'admin';
  const settings = useSettings();
  const [openEmailId, setOpenEmailId] = useState<number | null>(null);
  /** Email-log id of the last real send when the settings were last saved: older results are stale. */
  const [staleUpToId, setStaleUpToId] = useState(0);
  // Lives here, not in the form: saving re-keys the form, and "Save & send test" must survive that.
  const test = useTestEmail('/settings/test-email', [EMAIL_LOG_KEY, SETTINGS_KEY]);

  if (!settings.data) return <PageSpinner />;
  const saved = pick(settings.data, EMAIL_FIELDS);
  const lastEmail = settings.data.lastEmail && settings.data.lastEmail.id > staleUpToId ? settings.data.lastEmail : null;
  return (
    <div className="space-y-4">
      <EmailSettingsForm
        key={JSON.stringify(saved)}
        settings={{ ...settings.data, lastEmail }}
        saved={saved}
        test={test}
        onOpenEmail={isAdmin ? setOpenEmailId : null}
        onSaved={(s) => setStaleUpToId(s.lastEmail?.id ?? 0)}
      />
      {isAdmin ? (
        <>
          <EmailLogCard onOpen={setOpenEmailId} />
          <EmailViewerDialog id={openEmailId} onClose={() => setOpenEmailId(null)} />
        </>
      ) : (
        <Card id="email-log" className="scroll-mt-4">
          <CardHeader title="Email log" />
          <CardBody>
            <p className="flex items-center gap-2 text-sm text-fg-muted">
              <Lock aria-hidden className="size-4 shrink-0" />
              Only admins can view the email log, because it contains comedians’ sign-in codes and links.
            </p>
          </CardBody>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

interface EmailSettingsFormProps {
  settings: SettingsDto;
  saved: SavedEmail;
  test: TestEmailState;
  /** Opens a logged email; null for non-admins (the email log is admin-only). */
  onOpenEmail: ((id: number) => void) | null;
  /** After any successful save (results of earlier sends no longer describe these settings). */
  onSaved: (settings: SettingsDto) => void;
}

function EmailSettingsForm({ settings, saved, test, onOpenEmail, onSaved }: EmailSettingsFormProps) {
  const booker = useBooker();
  const canEdit = booker.role === 'admin';
  const initial = draftFrom(saved);
  const { draft, set, setDraft, errors, setErrors, reset, dirty } = useDraft<EmailDraft>(initial);
  const save = useSaveSettings();
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const platform = settings.platformSender;
  // With the platform sending already, the mailbox form stays folded until it's wanted.
  const [mailboxOpen, setMailboxOpen] = useState(!platform || saved.smtpHost !== '');
  const showFromFields = draft.provider !== null || settings.emailSource === 'env';

  /** The PUT body for the current draft, or field errors. */
  function buildPatch(): { patch: UpdateSettingsInput } | { errors: Record<string, string | undefined> } {
    const connection = connectionPatch(draft, saved, { fromEmail: draft.fromEmail, fromField: 'fromEmail' });
    const patch: UpdateSettingsInput = {
      ...connection.patch,
      fromName: draft.fromName,
      fromEmail: draft.fromEmail,
      replyTo: draft.replyTo,
      senderMode: draft.senderMode,
    };
    const invalid = { ...validateSettingsPatch(patch), ...connection.errors };
    return Object.values(invalid).some(Boolean) ? { errors: invalid } : { patch };
  }

  async function saveDraft(): Promise<boolean> {
    const built = buildPatch();
    if ('errors' in built) {
      setErrors(built.errors);
      return false;
    }
    try {
      onSaved(await save.mutateAsync(built.patch));
      return true;
    } catch (err) {
      const fieldErrors = apiFieldErrors(err);
      if (fieldErrors) setErrors(fieldErrors);
      else toast.error(errorMessage(err));
      return false;
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const outbox = !draft.provider && !platform && settings.emailSource !== 'env';
    if (await saveDraft()) toast.success(outbox ? 'Email settings saved — using the outbox' : 'Email settings saved');
  }

  async function handleTest() {
    test.clear();
    if (canEdit && dirty && !(await saveDraft())) return;
    test.run();
  }

  const disconnect = () =>
    save.mutateAsync({ smtpHost: '', smtpUser: '', clearSmtpPass: true }).then((s) => {
      onSaved(s);
      test.clear();
      toast.success(
        platform ? `Disconnected — emails go out through ${platform.name} again` : 'Disconnected — emails go to the outbox now',
      );
    });

  return (
    <form onSubmit={(e) => void handleSubmit(e)} noValidate autoComplete="off">
      <Card>
        <CardHeader
          title="Sending email"
          description="Sign-in codes, availability requests, weekly confirmations and invites."
          actions={<EmailBadge settings={settings} />}
        />
        <CardBody className="space-y-5">
          <EmailStatus settings={settings} bookerEmail={booker.email} canReadLog={onOpenEmail != null} />

          {!canEdit && (
            <Callout icon={Lock} title="Only admins can change email settings">
              They decide where sign-in links and confirmations are sent from. You can still send yourself a test
              email to check it works.
            </Callout>
          )}

          <fieldset disabled={!canEdit} className="m-0 min-w-0 space-y-5 border-0 p-0">
            <fieldset>
              <legend className="mb-2 text-[13px] font-medium text-fg">Who emails come from</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {SENDER_MODES.map((mode) => {
                  const option = SENDER_OPTIONS[mode];
                  const checked = draft.senderMode === mode;
                  return (
                    <label
                      key={mode}
                      className={cn(
                        'relative flex flex-col gap-0.5 rounded-lg border px-3 py-2.5 transition-colors',
                        'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent',
                        canEdit ? 'cursor-pointer' : 'cursor-not-allowed',
                        checked
                          ? 'border-accent bg-accent-soft'
                          : cn('border-border-strong bg-surface', canEdit ? 'hover:bg-surface-2/60' : 'opacity-60'),
                      )}
                    >
                      <input
                        type="radio"
                        name="sender-mode"
                        value={mode}
                        checked={checked}
                        onChange={() => set('senderMode', mode)}
                        className="sr-only"
                      />
                      <span className={cn('text-sm font-medium', checked ? 'text-accent' : 'text-fg')}>{option.label}</span>
                      <span className="text-xs text-fg-muted">{option.description(settings.clubName || 'your club')}</span>
                    </label>
                  );
                })}
              </div>
              {draft.senderMode === 'booker' && (
                <p className="mt-2 text-xs text-fg-muted">
                  Sign-in links, codes and invites always come from the company. Each booker can connect their own
                  mailbox under Settings → Account.
                </p>
              )}
            </fieldset>

            <Field
              label="Company email"
              error={errors.replyTo}
              hint="Where replies to company emails go — comedians reply to confirmations when they can't make a spot."
            >
              <Input
                type="email"
                autoComplete="off"
                value={draft.replyTo}
                onChange={(e) => set('replyTo', e.target.value)}
                placeholder="booking@yourclub.com"
                className="sm:max-w-sm"
              />
            </Field>

            <SenderPreviewLines settings={settings} draft={draft} />

            <section aria-labelledby="connect-mailbox-heading" className="space-y-5 border-t border-border pt-5">
              <div>
                <h4 id="connect-mailbox-heading" className="text-sm font-semibold text-fg">
                  Connect a mailbox <span className="font-normal text-fg-muted">(optional)</span>
                </h4>
                <p className="mt-0.5 text-xs text-fg-muted">
                  To send from your own address and keep a copy in your Sent folder.{' '}
                  {platform
                    ? `Without one, emails go out through ${platform.name}.`
                    : settings.emailSource === 'env'
                      ? "Without one, the server's own email settings are used."
                      : 'Until you connect one, emails wait in the outbox.'}
                </p>
              </div>

              {!mailboxOpen ? (
                canEdit && (
                  <Button variant="secondary" onClick={() => setMailboxOpen(true)}>
                    <Plug aria-hidden /> Connect a mailbox
                  </Button>
                )
              ) : (
                <>
                  <MailboxConnectionFields
                    draft={draft}
                    setDraft={setDraft}
                    saved={saved}
                    errors={errors}
                    setErrors={setErrors}
                    canEdit={canEdit}
                    name="email-provider"
                  />
                  {showFromFields && (
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field label="From name" error={errors.fromName} hint="Comedians see this as the sender.">
                        <Input
                          value={draft.fromName}
                          onChange={(e) => set('fromName', e.target.value)}
                          placeholder={settings.clubName || 'Your club'}
                          maxLength={100}
                        />
                      </Field>
                      <Field label="From email" error={errors.fromEmail} hint={fromEmailHint(draft.provider)}>
                        <Input
                          type="email"
                          autoComplete="off"
                          value={draft.fromEmail}
                          onChange={(e) => set('fromEmail', e.target.value)}
                          placeholder={
                            emailSchema.safeParse(draft.smtpUser).success ? draft.smtpUser : 'bookings@yourclub.com'
                          }
                        />
                      </Field>
                    </div>
                  )}
                </>
              )}
            </section>
          </fieldset>

          {test.result && <TestResultCallout result={test.result} onOpenEmail={onOpenEmail} />}
        </CardBody>

        {canEdit ? (
          <SaveFooter
            dirty={dirty}
            saving={save.isPending}
            onDiscard={() => {
              reset();
              test.clear();
            }}
            start={
              saved.smtpHost ? (
                <Button variant="ghost" onClick={() => setConfirmDisconnect(true)} className="text-fg-muted">
                  <Unplug aria-hidden /> Disconnect
                </Button>
              ) : undefined
            }
            end={
              <Button
                variant="secondary"
                onClick={() => void handleTest()}
                loading={test.pending}
                title={`Sends a test email to ${booker.email}`}
              >
                <Send aria-hidden />
                {dirty ? 'Save & send test' : 'Send test email'}
              </Button>
            }
          />
        ) : (
          <CardFooter>
            <Button
              variant="secondary"
              onClick={() => void handleTest()}
              loading={test.pending}
              title={`Sends a test email to ${booker.email}`}
            >
              <Send aria-hidden />
              Send test email to me
            </Button>
          </CardFooter>
        )}
      </Card>

      <ConfirmDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        title="Disconnect the mailbox?"
        description={
          platform
            ? `The SMTP server and password are removed. Emails go out through ${platform.name} again.`
            : "The SMTP server and password are removed. Until you connect again, emails go to the outbox (the Email log) instead of comedians' inboxes."
        }
        confirmLabel="Disconnect"
        destructive
        onConfirm={disconnect}
      />
    </form>
  );
}

/**
 * The one-line preview of what comedians see, following the unsaved choice of sender and
 * company email (the server previews what's saved).
 */
function SenderPreviewLines({ settings, draft }: { settings: SettingsDto; draft: EmailDraft }) {
  const company = settings.senderPreview;
  if (!company) return null;
  const companyEmail = draft.replyTo.trim();
  const companyLine = companyEmail && emailSchema.safeParse(companyEmail).success ? { ...company, replyTo: companyEmail } : company;
  const you = settings.bookerSenderPreview;
  return (
    <div className="space-y-1 rounded-lg border border-border bg-surface-2/60 px-3.5 py-3">
      {draft.senderMode === 'booker' && you ? (
        <>
          <SenderLine preview={you} label="Emails you send:" />
          <SenderLine preview={companyLine} label="Sign-in links and invites:" />
        </>
      ) : (
        <SenderLine preview={companyLine} label="Comedians see:" />
      )}
    </div>
  );
}

function EmailBadge({ settings }: { settings: SettingsDto }) {
  if (!settings.emailConfigured) {
    return (
      <Badge variant="warning" dotColor="var(--awaiting)">
        Not configured
      </Badge>
    );
  }
  if (settings.lastEmail?.status === 'failed') {
    return (
      <Badge variant="danger" dotColor="var(--unconfirmed)">
        Email failing
      </Badge>
    );
  }
  return (
    <Badge variant="success" dotColor="var(--confirmed)">
      Email on
    </Badge>
  );
}

function EmailStatus({
  settings,
  bookerEmail,
  canReadLog,
}: {
  settings: SettingsDto;
  bookerEmail: string;
  canReadLog: boolean;
}) {
  if (!settings.emailConfigured) {
    return (
      <Callout tone="warning" icon={Inbox} title="Not connected — emails go to the outbox">
        Nothing reaches inboxes yet. Every email — sign-in codes, availability requests, confirmations, invites — is
        saved in the <a href="#email-log">Email log</a>
        {canReadLog ? ' below, where you can open and read it' : ', which admins can open and read'}.{' '}
        {canReadLog
          ? 'Connect a mailbox below to start sending for real.'
          : 'An admin can connect a mailbox to start sending for real.'}
      </Callout>
    );
  }
  const last = settings.lastEmail;
  const platformName = settings.platformSender?.name ?? 'the platform';
  const title =
    settings.emailSource === 'platform'
      ? `Email is on — it goes out through ${platformName}, no setup needed`
      : `Sending via ${settings.emailHost}${settings.emailSource === 'env' ? " (set by the server's SMTP_* environment variables)" : ''}`;
  if (last?.status === 'failed') {
    const failing =
      settings.emailSource === 'platform' ? `Email goes out through ${platformName}` : title;
    return (
      <Callout tone="danger" title={`${failing} — but the last email failed`}>
        {formatRelative(last.createdAt)}: <span className="font-mono text-xs break-words">{last.error}</span>.{' '}
        {settings.emailSource === 'platform'
          ? 'Contact support if it keeps happening.'
          : canReadLog
            ? `Fix the settings below, then send a test email to ${bookerEmail}.`
            : 'Ask an admin to fix the settings below.'}
      </Callout>
    );
  }
  return (
    <Callout tone={last ? 'success' : 'info'} icon={last ? undefined : Mail} title={title}>
      {last ? `Last email sent ${formatRelative(last.createdAt)}.` : `Send a test email to ${bookerEmail} to check it works.`}
      {settings.emailSource === 'env' && ' Connect a mailbox below to use different settings instead.'}
    </Callout>
  );
}
