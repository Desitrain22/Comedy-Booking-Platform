/**
 * The "connect a mailbox" pieces shared by Settings → Email (the company's mailbox) and
 * Settings → Account (your own): the provider picker with its presets and help, the
 * server/login fields, the test-email mutation and its result.
 */
import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { Inbox } from 'lucide-react';
import { useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import type { SenderPreview, TestEmailErrorExtra, TestEmailResponse } from '../../../shared/api/settings';
import { Button, Field, Input, Select } from '../../components/ui';
import { api, ApiError, errorMessage } from '../../lib/api';
import { cn } from '../../lib/cn';
import { EMAIL_PROVIDERS, getEmailProvider, type EmailProviderId } from './emailProviders';
import { isPassNeededAgain, withPort, withProvider, type ConnectionDraft, type SavedConnection } from './mailboxDraft';
import { Callout } from './SettingsParts';
import type { FieldErrors } from './settingsData';

// ---------------------------------------------------------------------------
// Provider picker + server and login fields
// ---------------------------------------------------------------------------

export interface MailboxConnectionFieldsProps<T extends ConnectionDraft> {
  draft: T;
  setDraft: Dispatch<SetStateAction<T>>;
  saved: SavedConnection;
  errors: FieldErrors;
  setErrors: Dispatch<SetStateAction<FieldErrors>>;
  canEdit: boolean;
  /** Name of the provider radio group (unique on the page). */
  name: string;
  /** Legend over the provider picker. */
  legend?: string;
}

export function MailboxConnectionFields<T extends ConnectionDraft>({
  draft,
  setDraft,
  saved,
  errors,
  setErrors,
  canEdit,
  name,
  legend = 'Email provider',
}: MailboxConnectionFieldsProps<T>) {
  const provider = draft.provider ? getEmailProvider(draft.provider) : null;
  const passNeededAgain = isPassNeededAgain(saved, draft);

  function set<K extends keyof ConnectionDraft>(key: K, value: ConnectionDraft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
    setErrors((e) => (e[key] ? { ...e, [key]: undefined } : e));
  }

  function chooseProvider(id: EmailProviderId) {
    setErrors({});
    setDraft((d) => withProvider(d, saved, id));
  }

  function changePort(value: string) {
    setDraft((d) => withPort(d, value));
    setErrors((e) => ({ ...e, smtpPort: undefined }));
  }

  return (
    <>
      <fieldset>
        <legend className="mb-2 text-[13px] font-medium text-fg">{legend}</legend>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {EMAIL_PROVIDERS.map((p) => (
            <label
              key={p.id}
              className={cn(
                'relative flex flex-col gap-0.5 rounded-lg border px-3 py-2.5 transition-colors',
                'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent',
                canEdit ? 'cursor-pointer' : 'cursor-not-allowed',
                draft.provider === p.id
                  ? 'border-accent bg-accent-soft'
                  : cn('border-border-strong bg-surface', canEdit ? 'hover:bg-surface-2/60' : 'opacity-60'),
              )}
            >
              <input
                type="radio"
                name={name}
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
          {canEdit && <ProviderHelp id={provider.id} />}

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
                <span className="font-mono text-fg">{provider.port}</span>, {provider.secure ? 'SSL/TLS' : 'STARTTLS'}
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
                        : passNeededAgain
                          ? 'Enter it again: a saved password only goes to the server it was entered for.'
                          : canEdit
                            ? 'Saved. Leave blank to keep it, or paste a new one to replace it.'
                            : 'Saved.'
                  }
                  aside={
                    saved.smtpPassSet && canEdit ? (
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
                    placeholder={
                      saved.smtpPassSet && !draft.clearPass && !passNeededAgain
                        ? '•••••••• (saved)'
                        : canEdit
                          ? provider.passPlaceholder
                          : ''
                    }
                  />
                </Field>
              </>
            )}
          </div>
        </>
      )}
    </>
  );
}

export function fromEmailHint(provider: EmailProviderId | null): string {
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

// ---------------------------------------------------------------------------
// What comedians see
// ---------------------------------------------------------------------------

/** "From: Broadway Comedy <bookings@mail.…> · Replies go to booking@bwaygroup.com" */
export function SenderLine({ preview, label }: { preview: SenderPreview; label?: ReactNode }) {
  return (
    <p className="text-sm break-words text-fg-muted">
      {label && <span className="font-medium text-fg">{label} </span>}
      From: <span className="text-fg">{preview.fromName}</span>{' '}
      <span className="text-fg">&lt;{preview.fromEmail}&gt;</span>
      <span aria-hidden> · </span>
      <span className="sr-only">. </span>
      Replies go to <span className="text-fg">{preview.replyTo}</span>
    </p>
  );
}

// ---------------------------------------------------------------------------
// Test email
// ---------------------------------------------------------------------------

export type TestResult =
  | { kind: 'sent' | 'outbox'; to: string; logId: number }
  | { kind: 'error'; title: string; hint?: string; smtpError?: string; logId?: number };

export interface TestEmailState {
  run: () => void;
  pending: boolean;
  result: TestResult | null;
  clear: () => void;
}

/** POST a test email to `path` and keep its result (outlives the form, which re-keys on save). */
export function useTestEmail(path: string, invalidate: QueryKey[]): TestEmailState {
  const queryClient = useQueryClient();
  const [result, setResult] = useState<TestResult | null>(null);
  const test = useMutation({
    mutationFn: () => api.post<TestEmailResponse>(path, {}),
    meta: { silent: true },
    onMutate: () => setResult(null),
    onSuccess: (res) => setResult({ kind: res.status, to: res.to, logId: res.logId }),
    onError: (err) => {
      const extra = (err instanceof ApiError ? err.body : {}) as TestEmailErrorExtra;
      const timedOut = err instanceof ApiError && err.code === 'email_timeout';
      setResult({
        kind: 'error',
        title: timedOut ? err.message : "Couldn't send the test email",
        hint: extra.hint ?? (timedOut ? undefined : errorMessage(err)),
        smtpError: extra.smtpError,
        logId: extra.logId,
      });
    },
    onSettled: () => Promise.all(invalidate.map((queryKey) => queryClient.invalidateQueries({ queryKey }))),
  });
  return { run: () => test.mutate(), pending: test.isPending, result, clear: () => setResult(null) };
}

export function TestResultCallout({
  result,
  onOpenEmail,
}: {
  result: TestResult;
  onOpenEmail: ((id: number) => void) | null;
}) {
  const openLink = (id: number, label: string) =>
    onOpenEmail ? (
      <Button variant="link" className="text-sm" onClick={() => onOpenEmail(id)}>
        {label}
      </Button>
    ) : (
      'An admin can read it in the Email log.'
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

// ---------------------------------------------------------------------------
// Provider help
// ---------------------------------------------------------------------------

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-accent">
      {children}
    </a>
  );
}

export function ProviderHelp({ id }: { id: EmailProviderId }) {
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
