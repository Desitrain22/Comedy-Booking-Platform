/**
 * Settings → Account: who you're signed in as, and changing your own password
 * (`POST /api/auth/password`). Changing it signs you out on every other device; this
 * browser stays signed in (the server hands it a fresh session).
 */
import { useMutation } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import {
  changePasswordSchema,
  type ChangePasswordInput,
  type ChangePasswordResponse,
} from '../../../shared/api/settings';
import { Badge, Button, Card, CardBody, CardFooter, CardHeader, Field, Input } from '../../components/ui';
import { api, ApiError, errorMessage } from '../../lib/api';
import { useBooker } from '../../lib/useMe';
import { Callout } from './SettingsParts';
import { apiFieldErrors, type FieldErrors } from './settingsData';

export function AccountTab() {
  const booker = useBooker();
  const isAdmin = booker.role === 'admin';
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
      <ChangePasswordCard email={booker.email} />
    </div>
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
