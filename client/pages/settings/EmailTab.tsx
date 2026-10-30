/**
 * Settings → Email: connect an SMTP server (with provider presets), see whether email is
 * set up, send a test email, and (admins only) read the email log, outbox included. The log
 * holds comedians' sign-in codes and links, so other bookers see a short note instead.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Inbox, Lock, Mail, Send, Unplug } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { toast } from 'sonner';
import type {
  SettingsDto,
  TestEmailErrorExtra,
  TestEmailResponse,
  UpdateSettingsInput,
} from '../../../shared/api/settings';
import { emailSchema } from '../../../shared/schemas';
import { formatRelative } from '../../../shared/time';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  Field,
  Input,
  PageSpinner,
  Select,
} from '../../components/ui';
import { api, ApiError, errorMessage } from '../../lib/api';
import { cn } from '../../lib/cn';
import { useBooker } from '../../lib/useMe';
import { EmailLogCard, EmailViewerDialog } from './EmailLog';
import {
  EMAIL_PROVIDERS,
  detectEmailProvider,
  getEmailProvider,
  secureForPort,
  type EmailProviderId,
} from './emailProviders';
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
  type FieldErrors,
} from './settingsData';

const EMAIL_FIELDS = [
  'smtpHost',
  'smtpPort',
  'smtpSecure',
  'smtpUser',
  'smtpPassSet',
  'fromName',
  'fromEmail',
  'replyTo',
] as const;
type SavedEmail = Pick<SettingsDto, (typeof EMAIL_FIELDS)[number]>;

interface EmailDraft {
  provider: EmailProviderId | null;
  smtpHost: string;
  /** Text in the input; converted on save. */
  smtpPort: string;
  smtpSecure: boolean;
  smtpUser: string;
  /** A new password ('' keeps the saved one). */
  smtpPass: string;
  /** Remove the saved password on save. */
  clearPass: boolean;
  fromName: string;
  fromEmail: string;
  replyTo: string;
}

function draftFrom(saved: SavedEmail): EmailDraft {
  return {
    provider: detectEmailProvider(saved.smtpHost),
    smtpHost: saved.smtpHost,
    smtpPort: String(saved.smtpPort),
    smtpSecure: saved.smtpSecure,
    smtpUser: saved.smtpUser,
    smtpPass: '',
    clearPass: false,
    fromName: saved.fromName,
    fromEmail: saved.fromEmail,
    replyTo: saved.replyTo,
  };
}

type TestResult =
  | { kind: 'sent' | 'outbox'; to: string; logId: number }
  | { kind: 'error'; title: string; hint?: string; smtpError?: string; logId?: number };

export interface TestEmailState {
  run: () => void;
  pending: boolean;
  result: TestResult | null;
  clear: () => void;
}

export function EmailTab() {
  const isAdmin = useBooker().role === 'admin';
  const settings = useSettings();
  const queryClient = useQueryClient();
  const [openEmailId, setOpenEmailId] = useState<number | null>(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  /** Email-log id of the last real send when SMTP settings were last saved: older results are stale. */
  const [staleUpToId, setStaleUpToId] = useState(0);

  // Lives here, not in the form: saving re-keys the form, and "Save & send test" must survive that.
  const test = useMutation({
    mutationFn: () => api.post<TestEmailResponse>('/settings/test-email', {}),
    meta: { silent: true },
    onMutate: () => setTestResult(null),
    onSuccess: (res) => setTestResult({ kind: res.status, to: res.to, logId: res.logId }),
    onError: (err) => {
      const extra = (err instanceof ApiError ? err.body : {}) as TestEmailErrorExtra;
      const timedOut = err instanceof ApiError && err.code === 'email_timeout';
      setTestResult({
        kind: 'error',
        title: timedOut ? err.message : "Couldn't send the test email",
        hint: extra.hint ?? (timedOut ? undefined : errorMessage(err)),
        smtpError: extra.smtpError,
        logId: extra.logId,
      });
    },
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: EMAIL_LOG_KEY }),
        queryClient.invalidateQueries({ queryKey: SETTINGS_KEY }),
      ]),
  });
  const testState: TestEmailState = {
    run: () => test.mutate(),
    pending: test.isPending,
    result: testResult,
    clear: () => setTestResult(null),
  };

  if (!settings.data) return <PageSpinner />;
  const saved = pick(settings.data, EMAIL_FIELDS);
  const lastEmail = settings.data.lastEmail && settings.data.lastEmail.id > staleUpToId ? settings.data.lastEmail : null;
  return (
    <div className="space-y-4">
      <EmailSettingsForm
        key={JSON.stringify(saved)}
        settings={{ ...settings.data, lastEmail }}
        saved={saved}
        test={testState}
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
  const initial = draftFrom(saved);
  const { draft, set, setDraft, errors, setErrors, reset, dirty } = useDraft<EmailDraft>(initial);
  const save = useSaveSettings();
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const provider = draft.provider ? getEmailProvider(draft.provider) : null;

  function chooseProvider(id: EmailProviderId) {
    const preset = getEmailProvider(id);
    const savedProvider = detectEmailProvider(saved.smtpHost);
    setErrors({});
    if (id === savedProvider) {
      // Back to what's saved.
      setDraft((d) => ({ ...d, ...pick(draftFrom(saved), ['provider', 'smtpHost', 'smtpPort', 'smtpSecure', 'smtpUser']) }));
      return;
    }
    setDraft((d) => {
      const previous = getEmailProvider(d.provider ?? 'custom');
      // A fixed username or token from another provider is meaningless here.
      const keepUser = !preset.tokenAsUserAndPass && !previous.fixedUser && !previous.tokenAsUserAndPass;
      return {
        ...d,
        provider: id,
        smtpHost: preset.host,
        smtpPort: String(preset.port),
        smtpSecure: preset.secure,
        smtpUser: preset.fixedUser ?? (keepUser ? d.smtpUser : ''),
      };
    });
  }

  function changePort(value: string) {
    const suggested = secureForPort(Number(value));
    setDraft((d) => ({ ...d, smtpPort: value, smtpSecure: suggested ?? d.smtpSecure }));
    setErrors((e) => ({ ...e, smtpPort: undefined }));
  }

  /** The PUT body for the current draft, or field errors. */
  function buildPatch(): { patch: UpdateSettingsInput } | { errors: FieldErrors } {
    const patch: UpdateSettingsInput = {
      smtpHost: draft.provider ? draft.smtpHost.trim() : '',
      smtpPort: Number(draft.smtpPort),
      smtpSecure: draft.smtpSecure,
      smtpUser: draft.smtpUser.trim(),
      fromName: draft.fromName,
      fromEmail: draft.fromEmail,
      replyTo: draft.replyTo,
    };
    const found: FieldErrors = {};
    if (provider?.tokenAsUserAndPass) {
      if (!patch.smtpUser) found.smtpUser = `Paste your ${provider.userLabel}`;
      else if (patch.smtpUser !== saved.smtpUser || !saved.smtpPassSet) patch.smtpPass = patch.smtpUser;
    } else {
      const pass = provider?.stripPassSpaces ? draft.smtpPass.replace(/\s+/g, '') : draft.smtpPass;
      const hasPassword = saved.smtpPassSet && !draft.clearPass;
      if (pass) patch.smtpPass = pass;
      else if (draft.clearPass) patch.clearSmtpPass = true;
      if (!pass && !hasPassword && provider && provider.id !== 'custom') {
        found.smtpPass = `Paste your ${provider.passLabel}`;
      }
    }
    if (provider) {
      if (!patch.smtpHost) found.smtpHost = 'Enter the SMTP server, like smtp.yourprovider.com';
      if (provider.id === 'gmail' && !patch.smtpUser) found.smtpUser = 'Enter the Gmail address you send from';
      const fromOk = emailSchema.safeParse(draft.fromEmail || patch.smtpUser).success;
      if (!fromOk) found.fromEmail = 'Enter the email address messages come from';
    }
    const invalid = { ...validateSettingsPatch(patch), ...found };
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
    if (await saveDraft()) toast.success(draft.provider ? 'Email settings saved' : 'Email settings saved — using the outbox');
  }

  async function handleTest() {
    test.clear();
    if (dirty && !(await saveDraft())) return;
    test.run();
  }

  const disconnect = () =>
    save.mutateAsync({ smtpHost: '', smtpUser: '', clearSmtpPass: true }).then((s) => {
      onSaved(s);
      test.clear();
      toast.success('Disconnected — emails go to the outbox now');
    });

  return (
    <form onSubmit={(e) => void handleSubmit(e)} noValidate autoComplete="off">
      <Card>
        <CardHeader
          title="Sending email"
          description="Sign-in codes, availability requests, weekly confirmations and invites are sent from this address."
          actions={<EmailBadge settings={settings} />}
        />
        <CardBody className="space-y-5">
          <EmailStatus settings={settings} bookerEmail={booker.email} canReadLog={onOpenEmail != null} />

          <fieldset>
            <legend className="mb-2 text-[13px] font-medium text-fg">Email provider</legend>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {EMAIL_PROVIDERS.map((p) => (
                <label
                  key={p.id}
                  className={cn(
                    'relative flex cursor-pointer flex-col gap-0.5 rounded-lg border px-3 py-2.5 transition-colors',
                    'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent',
                    draft.provider === p.id
                      ? 'border-accent bg-accent-soft'
                      : 'border-border-strong bg-surface hover:bg-surface-2/60',
                  )}
                >
                  <input
                    type="radio"
                    name="email-provider"
                    value={p.id}
                    checked={draft.provider === p.id}
                    onChange={() => chooseProvider(p.id)}
                    className="sr-only"
                  />
                  <span className={cn('text-sm font-medium', draft.provider === p.id ? 'text-accent' : 'text-fg')}>
                    {p.label}
                  </span>
                  <span className="text-xs text-fg-muted">{p.tagline}</span>
                </label>
              ))}
            </div>
          </fieldset>

          {provider && (
            <>
              <ProviderHelp id={provider.id} />

              <div className="grid gap-4 sm:grid-cols-2">
                {provider.id === 'custom' ? (
                  <>
                    <Field label="SMTP server" error={errors.smtpHost} className="sm:col-span-2">
                      <Input
                        value={draft.smtpHost}
                        onChange={(e) => set('smtpHost', e.target.value)}
                        placeholder="smtp.yourprovider.com"
                        autoCapitalize="none"
                        spellCheck={false}
                      />
                    </Field>
                    <Field label="Port" error={errors.smtpPort}>
                      <Input
                        inputMode="numeric"
                        value={draft.smtpPort}
                        onChange={(e) => changePort(e.target.value.replace(/\D/g, ''))}
                        placeholder="587"
                      />
                    </Field>
                    <Field label="Security" hint="Match your provider: 465 uses SSL/TLS, 587 uses STARTTLS.">
                      <Select
                        value={draft.smtpSecure ? 'tls' : 'starttls'}
                        onChange={(e) => set('smtpSecure', e.target.value === 'tls')}
                        options={[
                          { value: 'tls', label: 'SSL/TLS (usually port 465)' },
                          { value: 'starttls', label: 'STARTTLS (usually port 587)' },
                        ]}
                      />
                    </Field>
                  </>
                ) : (
                  <p className="text-xs text-fg-muted sm:col-span-2">
                    Server <span className="font-mono text-fg">{provider.host}</span>, port{' '}
                    <span className="font-mono text-fg">{provider.port}</span>,{' '}
                    {provider.secure ? 'SSL/TLS' : 'STARTTLS'}
                    {provider.fixedUser && (
                      <>
                        , username <span className="font-mono text-fg">{provider.fixedUser}</span>
                      </>
                    )}
                    . These are filled in for you.
                  </p>
                )}

                {provider.tokenAsUserAndPass ? (
                  <Field
                    label={provider.userLabel}
                    error={errors.smtpUser ?? errors.smtpPass}
                    hint="Used as both the username and the password."
                    className="sm:col-span-2"
                  >
                    <Input
                      type="password"
                      autoComplete="new-password"
                      value={draft.smtpUser}
                      onChange={(e) => set('smtpUser', e.target.value)}
                      placeholder={provider.userPlaceholder}
                      spellCheck={false}
                    />
                  </Field>
                ) : (
                  <>
                    {!provider.fixedUser && (
                      <Field label={provider.userLabel} error={errors.smtpUser}>
                        <Input
                          autoComplete="off"
                          autoCapitalize="none"
                          spellCheck={false}
                          value={draft.smtpUser}
                          onChange={(e) => set('smtpUser', e.target.value)}
                          placeholder={provider.userPlaceholder}
                        />
                      </Field>
                    )}
                    <Field
                      label={provider.passLabel}
                      error={errors.smtpPass}
                      className={provider.fixedUser ? 'sm:col-span-2' : undefined}
                      hint={
                        !saved.smtpPassSet
                          ? undefined
                          : draft.clearPass
                            ? 'The saved password will be removed when you save.'
                            : 'Saved. Leave blank to keep it, or paste a new one to replace it.'
                      }
                      aside={
                        saved.smtpPassSet ? (
                          <Button variant="link" className="text-xs" onClick={() => set('clearPass', !draft.clearPass)}>
                            {draft.clearPass ? 'Undo' : 'Remove saved'}
                          </Button>
                        ) : undefined
                      }
                    >
                      <Input
                        type="password"
                        autoComplete="new-password"
                        spellCheck={false}
                        value={draft.smtpPass}
                        onChange={(e) => set('smtpPass', e.target.value)}
                        placeholder={saved.smtpPassSet && !draft.clearPass ? '•••••••• (saved)' : provider.passPlaceholder}
                      />
                    </Field>
                  </>
                )}
              </div>
            </>
          )}

          <div className="grid gap-4 border-t border-border pt-5 sm:grid-cols-2">
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
                placeholder={emailSchema.safeParse(draft.smtpUser).success ? draft.smtpUser : 'bookings@yourclub.com'}
              />
            </Field>
            <Field
              label="Reply-to"
              error={errors.replyTo}
              hint="Optional. Where replies go — comedians reply to confirmations when they can't make a spot."
              className="sm:col-span-2"
            >
              <Input
                type="email"
                autoComplete="off"
                value={draft.replyTo}
                onChange={(e) => set('replyTo', e.target.value)}
                placeholder="you@yourclub.com"
                className="sm:max-w-sm"
              />
            </Field>
          </div>

          {test.result && <TestResultCallout result={test.result} onOpenEmail={onOpenEmail} />}
        </CardBody>

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
      </Card>

      <ConfirmDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        title="Stop sending email?"
        description="The SMTP server and password are removed. Until you connect again, emails go to the outbox (the Email log) instead of comedians' inboxes."
        confirmLabel="Disconnect"
        destructive
        onConfirm={disconnect}
      />
    </form>
  );
}

function fromEmailHint(provider: EmailProviderId | null): string {
  switch (provider) {
    case 'gmail':
      return 'Your Gmail address, or an alias you’ve added to that Gmail account.';
    case 'resend':
      return 'Must be on the domain you verified in Resend.';
    case 'postmark':
      return 'Must be a verified sender signature or domain in Postmark.';
    default:
      return 'Blank uses the username, if it’s an email address.';
  }
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
      <Callout tone="warning" icon={Inbox} title="Not configured — emails go to the outbox">
        Nothing reaches inboxes yet. Every email — sign-in codes, availability requests, confirmations, invites — is
        saved in the <a href="#email-log">Email log</a>
        {canReadLog ? ' below, where you can open and read it' : ', which admins can open and read'}. Pick your email
        provider to start sending for real.
      </Callout>
    );
  }
  const fromEnv = settings.emailSource === 'env';
  const last = settings.lastEmail;
  const title = `Sending via ${settings.emailHost}${fromEnv ? " (set by the server's SMTP_* environment variables)" : ''}`;
  if (last?.status === 'failed') {
    return (
      <Callout tone="danger" title={`${title} — but the last email failed`}>
        {formatRelative(last.createdAt)}: <span className="font-mono text-xs break-words">{last.error}</span>. Fix the
        settings below, then send a test email to {bookerEmail}.
      </Callout>
    );
  }
  return (
    <Callout tone={last ? 'success' : 'info'} icon={last ? undefined : Mail} title={title}>
      {settings.emailFrom && <>Messages come from {settings.emailFrom}. </>}
      {last ? `Last email sent ${formatRelative(last.createdAt)}.` : `Send a test email to ${bookerEmail} to check it works.`}
      {fromEnv && ' Pick a provider below to use different settings instead.'}
    </Callout>
  );
}

function TestResultCallout({
  result,
  onOpenEmail,
}: {
  result: TestResult;
  onOpenEmail: ((id: number) => void) | null;
}) {
  const openLink = (id: number, label: string) => (
    onOpenEmail ? (
      <Button variant="link" className="text-sm" onClick={() => onOpenEmail(id)}>
        {label}
      </Button>
    ) : (
      'An admin can read it in the Email log.'
    )
  );
  if (result.kind !== 'error') {
    if (result.kind === 'sent') {
      return (
        <Callout live tone="success" title={`Test email sent to ${result.to}`}>
          Check that inbox — and the spam folder, just in case.
        </Callout>
      );
    }
    return (
      <Callout live tone="info" icon={Inbox} title="Email isn't set up, so the test went to the outbox">
        {openLink(result.logId, 'Open it in the Email log')}
      </Callout>
    );
  }
  return (
    <Callout live tone="danger" title={result.title}>
      {result.hint && <p>{result.hint}</p>}
      {result.smtpError && (
        <p className="mt-2 text-xs">
          <span className="font-medium">The server said: </span>
          <code className="font-mono break-words whitespace-pre-wrap opacity-90">{result.smtpError.trim()}</code>
        </p>
      )}
    </Callout>
  );
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-accent">
      {children}
    </a>
  );
}

function ProviderHelp({ id }: { id: EmailProviderId }) {
  switch (id) {
    case 'gmail':
      return (
        <Callout title="Gmail needs an App Password">
          <ol className="list-decimal space-y-0.5 pl-4">
            <li>
              Turn on{' '}
              <ExternalLink href="https://myaccount.google.com/signinoptions/two-step-verification">
                2-Step Verification
              </ExternalLink>{' '}
              for the Google account you’ll send from.
            </li>
            <li>
              Create an <ExternalLink href="https://myaccount.google.com/apppasswords">App Password</ExternalLink> (call
              it “Comedy booking”).
            </li>
            <li>Paste the 16-letter password below. Your normal Google password won’t work.</li>
          </ol>
          <p className="mt-1 text-xs text-fg-muted">Gmail sends up to about 500 emails a day (2,000 with Google Workspace).</p>
        </Callout>
      );
    case 'resend':
      return (
        <Callout title="Connect Resend">
          <ol className="list-decimal space-y-0.5 pl-4">
            <li>
              Add and verify your domain at <ExternalLink href="https://resend.com/domains">resend.com/domains</ExternalLink>.
            </li>
            <li>
              Create an API key with “Sending access” at{' '}
              <ExternalLink href="https://resend.com/api-keys">resend.com/api-keys</ExternalLink>.
            </li>
            <li>Paste the key (it starts with re_) below.</li>
          </ol>
        </Callout>
      );
    case 'postmark':
      return (
        <Callout title="Connect Postmark">
          <ol className="list-decimal space-y-0.5 pl-4">
            <li>
              In <ExternalLink href="https://account.postmarkapp.com/servers">Postmark</ExternalLink>, create a server and
              verify a sender signature or your domain.
            </li>
            <li>Open the server’s API Tokens tab and copy the Server API token.</li>
            <li>Paste it below.</li>
          </ol>
        </Callout>
      );
    case 'custom':
      return (
        <Callout title="Any SMTP server works">
          Your provider’s help pages list these as “SMTP settings”: a server name, a port (usually 465 or 587), and a
          username and password. Many providers want an app password or API key here rather than your login password.
        </Callout>
      );
  }
}
