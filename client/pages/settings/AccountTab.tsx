/**
 * Settings → Account: who you're signed in as, your own mailbox (hosted MVP spec §5), and
 * changing your own password (`POST /api/auth/password`). Changing it signs you out on
 * every other device; this browser stays signed in (the server hands it a fresh session).
 *
 * "Your mailbox" (`/api/me/mailbox`): with the club's emails coming from each booker, your
 * availability requests and confirmations go out from your own address when you connect it
 * (same provider presets, test and disconnect as Settings → Email). It sits up front then,
 * and folds away as optional when the club sends everything as the company.
 */
import { useMutation } from '@tanstack/react-query';
import { KeyRound, Mail, Plug, Send, Unplug } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import {
  changePasswordSchema,
  type ChangePasswordInput,
  type ChangePasswordResponse,
  type MailboxDto,
  type UpdateMailboxInput,
} from '../../../shared/api/settings';
import { emailSchema } from '../../../shared/schemas';
import { formatRelative } from '../../../shared/time';
import { Badge, Button, Card, CardBody, CardFooter, CardHeader, ConfirmDialog, Field, Input } from '../../components/ui';
import { api, ApiError, errorMessage } from '../../lib/api';
import { useBooker } from '../../lib/useMe';
import {
  MailboxConnectionFields,
  SenderLine,
  TestResultCallout,
  fromEmailHint,
  useTestEmail,
  type TestEmailState,
} from './MailboxFields';
import { connectionDraftFrom, connectionPatch, type ConnectionDraft, type SavedConnection } from './mailboxDraft';
import { Callout, SaveFooter } from './SettingsParts';
import {
  MAILBOX_KEY,
  SETTINGS_KEY,
  apiFieldErrors,
  pick,
  useDraft,
  useMailbox,
  useSaveMailbox,
  validateMailbox,
  type FieldErrors,
} from './settingsData';

export function AccountTab() {
  const booker = useBooker();
  const isAdmin = booker.role === 'admin';
  const mailbox = useMailbox();
  // Lives here, not in the form: saving re-keys the form, and "Save & send test" must survive that.
  const test = useTestEmail('/me/mailbox/test', [MAILBOX_KEY, SETTINGS_KEY]);
  const prominent = mailbox.data?.senderMode === 'booker';
  const mailboxCard = mailbox.data ? <YourMailbox mailbox={mailbox.data} prominent={prominent} test={test} /> : null;
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Your account" description="You sign in with this email and your password." />
        <CardBody>
          <dl className="grid gap-4 text-sm sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto]">
            <div className="min-w-0">
              <dt className="text-xs text-fg-muted">Name</dt>
              <dd className="mt-0.5 truncate font-medium text-fg">{booker.name}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs text-fg-muted">Email</dt>
              <dd className="mt-0.5 truncate font-medium text-fg">{booker.email}</dd>
            </div>
            <div>
              <dt className="text-xs text-fg-muted">Role</dt>
              <dd className="mt-1">
                <Badge variant={isAdmin ? 'accent' : 'neutral'}>{isAdmin ? 'Admin' : 'Booker'}</Badge>
              </dd>
            </div>
          </dl>
          <p className="mt-4 text-xs text-fg-muted">
            {isAdmin ? (
              <>
                Change names and roles on the{' '}
                <Link to="/app/settings/bookers" className="font-medium text-accent hover:underline">
                  Bookers
                </Link>{' '}
                tab.
              </>
            ) : (
              'Ask an admin if your name or role needs to change.'
            )}
          </p>
        </CardBody>
      </Card>
      {prominent && mailboxCard}
      <ChangePasswordCard email={booker.email} />
      {!prominent && mailboxCard}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Your mailbox
// ---------------------------------------------------------------------------

const CONNECTION_FIELDS = ['smtpHost', 'smtpPort', 'smtpSecure', 'smtpUser', 'smtpPassSet'] as const;

interface MailboxDraft extends ConnectionDraft {
  /** The address it sends as ('' = the username). */
  smtpFromEmail: string;
}

function YourMailbox({ mailbox, prominent, test }: { mailbox: MailboxDto; prominent: boolean; test: TestEmailState }) {
  const saved = pick(mailbox, CONNECTION_FIELDS);
  return (
    <YourMailboxForm
      key={JSON.stringify([saved, mailbox.smtpFromEmail])}
      mailbox={mailbox}
      saved={saved}
      prominent={prominent}
      test={test}
    />
  );
}

interface YourMailboxFormProps {
  mailbox: MailboxDto;
  saved: SavedConnection;
  /** The club's emails come from each booker: this is how yours are sent. */
  prominent: boolean;
  test: TestEmailState;
}

function YourMailboxForm({ mailbox, saved, prominent, test }: YourMailboxFormProps) {
  const booker = useBooker();
  const initial: MailboxDraft = { ...connectionDraftFrom(saved), smtpFromEmail: mailbox.smtpFromEmail };
  const { draft, set, setDraft, errors, setErrors, reset, dirty } = useDraft<MailboxDraft>(initial);
  const save = useSaveMailbox();
  const [open, setOpen] = useState(prominent || mailbox.connected);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const fromAddress = mailbox.smtpFromEmail || mailbox.smtpUser;

  /** The PUT body for the current draft, or field errors. */
  function buildInput(): { input: UpdateMailboxInput } | { errors: FieldErrors } {
    if (!draft.provider) return { errors: { provider: 'Pick your email provider' } };
    const connection = connectionPatch(draft, saved, { fromEmail: draft.smtpFromEmail, fromField: 'smtpFromEmail' });
    const input: UpdateMailboxInput = { ...connection.patch, smtpFromEmail: draft.smtpFromEmail };
    const invalid = { ...validateMailbox(input), ...connection.errors };
    return Object.values(invalid).some(Boolean) ? { errors: invalid } : { input };
  }

  async function saveDraft(): Promise<boolean> {
    const built = buildInput();
    if ('errors' in built) {
      setErrors(built.errors);
      return false;
    }
    try {
      await save.mutateAsync(built.input);
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
    if (await saveDraft()) toast.success(mailbox.connected ? 'Mailbox saved' : 'Mailbox connected');
  }

  async function handleTest() {
    test.clear();
    if (dirty && !(await saveDraft())) return;
    test.run();
  }

  const disconnect = () =>
    save.mutateAsync(null).then(() => {
      test.clear();
      toast.success('Mailbox disconnected');
    });

  const last = mailbox.lastEmail;

  return (
    <form onSubmit={(e) => void handleSubmit(e)} noValidate autoComplete="off">
      <Card>
        <CardHeader
          title="Your mailbox"
          description={
            !prominent
              ? 'Optional. Your club sends everything as the company right now. If an admin switches to “Each booker”, emails you send go out from this mailbox.'
              : mailbox.connected
                ? 'Your availability requests and confirmations come from you, sent from your own mailbox so a copy stays in your Sent folder.'
                : 'Your availability requests and confirmations come from you. Connect your mailbox to send them from your own address and keep a copy in your Sent folder.'
          }
          actions={
            mailbox.connected ? (
              <Badge variant={last?.status === 'failed' ? 'danger' : 'success'} dotColor={last?.status === 'failed' ? 'var(--unconfirmed)' : 'var(--confirmed)'}>
                {last?.status === 'failed' ? 'Failing' : 'Connected'}
              </Badge>
            ) : prominent ? (
              <Badge variant="neutral">Not connected</Badge>
            ) : undefined
          }
        />
        <CardBody className="space-y-5">
          {mailbox.connected &&
            (last?.status === 'failed' ? (
              <Callout tone="danger" title={`The last email from ${fromAddress} failed`}>
                {formatRelative(last.createdAt)}: <span className="font-mono text-xs break-words">{last.error}</span>. Fix
                the settings below, then send a test email.
              </Callout>
            ) : (
              <Callout tone="success" title={`Connected: ${fromAddress}`}>
                {last ? `Last email sent ${formatRelative(last.createdAt)}.` : `Send a test email to ${booker.email} to check it works.`}
              </Callout>
            ))}

          {prominent &&
            (mailbox.preview ? (
              <div className="rounded-lg border border-border bg-surface-2/60 px-3.5 py-3">
                <SenderLine preview={mailbox.preview} label="Comedians see:" />
              </div>
            ) : (
              <Callout icon={Mail} title="Your emails wait in the outbox for now">
                Nothing reaches inboxes until an admin connects the club’s email or you connect your mailbox.
              </Callout>
            ))}

          {!open ? (
            <Button variant="secondary" onClick={() => setOpen(true)}>
              <Plug aria-hidden /> Connect your mailbox
            </Button>
          ) : (
            <>
              <MailboxConnectionFields
                draft={draft}
                setDraft={setDraft}
                saved={saved}
                errors={errors}
                setErrors={setErrors}
                canEdit
                name="my-email-provider"
              />
              {errors.provider && <p className="text-xs text-danger">{errors.provider}</p>}
              {draft.provider && (
                <Field label="From email" error={errors.smtpFromEmail} hint={fromEmailHint(draft.provider)} className="sm:max-w-sm">
                  <Input
                    type="email"
                    autoComplete="off"
                    value={draft.smtpFromEmail}
                    onChange={(e) => set('smtpFromEmail', e.target.value)}
                    placeholder={emailSchema.safeParse(draft.smtpUser).success ? draft.smtpUser : booker.email}
                  />
                </Field>
              )}
            </>
          )}

          {test.result && <TestResultCallout result={test.result} onOpenEmail={null} />}
        </CardBody>

        {open && (
          <SaveFooter
            dirty={dirty}
            saving={save.isPending}
            saveLabel={mailbox.connected ? 'Save changes' : 'Connect'}
            onDiscard={() => {
              reset();
              test.clear();
            }}
            start={
              mailbox.connected ? (
                <Button variant="ghost" onClick={() => setConfirmDisconnect(true)} className="text-fg-muted">
                  <Unplug aria-hidden /> Disconnect
                </Button>
              ) : undefined
            }
            end={
              mailbox.connected || draft.provider ? (
                <Button
                  variant="secondary"
                  onClick={() => void handleTest()}
                  loading={test.pending}
                  title={`Sends a test email to ${booker.email} through your mailbox`}
                >
                  <Send aria-hidden />
                  {dirty ? 'Save & send test' : 'Send test email'}
                </Button>
              ) : undefined
            }
          />
        )}
      </Card>

      <ConfirmDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        title="Disconnect your mailbox?"
        description="Your server and password are removed. Emails you send go out from the club’s email again."
        confirmLabel="Disconnect"
        destructive
        onConfirm={disconnect}
      />
    </form>
  );
}

function signedOutText(count: number): string {
  return count === 1 ? 'One other session was signed out.' : `${count} other sessions were signed out.`;
}

interface PasswordDraft {
  current: string;
  next: string;
  confirm: string;
}

const EMPTY: PasswordDraft = { current: '', next: '', confirm: '' };

function ChangePasswordCard({ email }: { email: string }) {
  const [draft, setDraft] = useState<PasswordDraft>(EMPTY);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [done, setDone] = useState<ChangePasswordResponse | null>(null);

  const change = useMutation({
    mutationFn: (input: ChangePasswordInput) => api.post<ChangePasswordResponse>('/auth/password', input),
    meta: { silent: true }, // errors are shown on the form
  });

  function set(key: keyof PasswordDraft, value: string) {
    setDraft((d) => ({ ...d, [key]: value }));
    setErrors((e) => (e[key] ? { ...e, [key]: undefined } : e));
    setFormError(null);
    setDone(null);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const input = { current: draft.current, next: draft.next };
    const parsed = changePasswordSchema.safeParse(input);
    const found: FieldErrors = {};
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? '');
        if (key && !found[key]) found[key] = issue.message;
      }
    }
    if (!found.next && draft.confirm !== draft.next) found.confirm = "The two new passwords don't match";
    if (Object.values(found).some(Boolean)) return setErrors(found);

    try {
      const result = await change.mutateAsync(input);
      setDraft(EMPTY);
      setErrors({});
      setDone(result);
      toast.success('Password changed');
    } catch (err) {
      const fieldErrors = apiFieldErrors(err);
      if (fieldErrors) setErrors(fieldErrors);
      else setFormError(err instanceof ApiError && err.status === 429 ? err.message : errorMessage(err));
    }
  }

  const filled = draft.current !== '' && draft.next !== '' && draft.confirm !== '';

  return (
    <form onSubmit={(e) => void handleSubmit(e)} noValidate>
      <Card>
        <CardHeader
          title="Password"
          description="Changing your password signs you out everywhere else — on other computers and phones."
        />
        <CardBody className="space-y-4">
          {/* Lets password managers file the new password under the right account. */}
          <input type="email" name="username" autoComplete="username" value={email} readOnly hidden />
          <Field label="Current password" error={errors.current} className="sm:max-w-sm">
            <Input
              type="password"
              autoComplete="current-password"
              value={draft.current}
              onChange={(e) => set('current', e.target.value)}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="New password" error={errors.next} hint="At least 8 characters.">
              <Input
                type="password"
                autoComplete="new-password"
                value={draft.next}
                onChange={(e) => set('next', e.target.value)}
              />
            </Field>
            <Field label="New password again" error={errors.confirm}>
              <Input
                type="password"
                autoComplete="new-password"
                value={draft.confirm}
                onChange={(e) => set('confirm', e.target.value)}
              />
            </Field>
          </div>
          {formError && (
            <Callout live tone="danger" title="Couldn't change your password">
              {formError}
            </Callout>
          )}
          {done && (
            <Callout live tone="success" title="Password changed">
              {done.signedOut > 0
                ? `You're still signed in here. ${signedOutText(done.signedOut)}`
                : "You're still signed in here. Use the new password next time you sign in."}
            </Callout>
          )}
        </CardBody>
        <CardFooter>
          <Button type="submit" loading={change.isPending} disabled={!filled}>
            <KeyRound aria-hidden />
            Change password
          </Button>
        </CardFooter>
      </Card>
    </form>
  );
}
