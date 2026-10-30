/**
 * First-run setup wizard (/setup, only while setupComplete is false):
 * club → first location → admin account. `appUrl` is this browser's origin.
 *
 * It is step 1 of 3 of the setup guide (Club → Shows → Comedians, client/components/guide):
 * when it finishes, the new admin lands on Create shows for the month being planned, where the
 * guide picks up with step 2.
 */
import { useMutation } from '@tanstack/react-query';
import { ArrowLeft, Check } from 'lucide-react';
import { Fragment, useMemo, useState, type FormEvent } from 'react';
import type { z } from 'zod';
import { emailSchema, passwordSchema, setupSchema, timeZoneSchema, type SetupInput } from '../../../shared/schemas';
import { planningMonth, todayInTz } from '../../../shared/time';
import { AuthShell, FormError } from '../../components/AuthShell';
import { createShowsPath } from '../../components/guide';
import { Button, Field, Input, Select } from '../../components/ui';
import { api, errorMessage, isApiError } from '../../lib/api';
import { cn } from '../../lib/cn';
import { useRefreshMe } from '../../lib/useMe';

interface SetupForm {
  clubName: string;
  timezone: string;
  locationName: string;
  locationAddress: string;
  adminName: string;
  adminEmail: string;
  adminPassword: string;
}

type Errors = Partial<Record<keyof SetupForm, string>>;

const STEPS: { title: string; description: string; fields: (keyof SetupForm)[] }[] = [
  {
    title: 'Set up your club',
    description: 'This shows up in emails and on the comedian portal.',
    fields: ['clubName', 'timezone'],
  },
  {
    title: 'Your first location',
    description: 'A room or venue where shows happen. You can add more later in Settings.',
    fields: ['locationName', 'locationAddress'],
  },
  {
    title: 'Your admin account',
    description: 'You will sign in with this email and password.',
    fields: ['adminName', 'adminEmail', 'adminPassword'],
  },
];

const shape = setupSchema.shape;
const FIELD_SCHEMAS: Record<keyof SetupForm, z.ZodType> = {
  clubName: shape.clubName,
  timezone: timeZoneSchema,
  locationName: shape.location.shape.name,
  locationAddress: shape.location.shape.address,
  adminName: shape.admin.shape.name,
  adminEmail: emailSchema,
  adminPassword: passwordSchema,
};

function browserTimeZone(): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return tz && timeZoneSchema.safeParse(tz).success ? tz : 'America/New_York';
}

function validate(form: SetupForm, fields: (keyof SetupForm)[]): Errors {
  const errors: Errors = {};
  for (const field of fields) {
    const result = FIELD_SCHEMAS[field].safeParse(form[field]);
    if (!result.success) errors[field] = result.error.issues[0]?.message ?? 'Invalid value';
  }
  return errors;
}

export function SetupPage() {
  const refreshMe = useRefreshMe();
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<SetupForm>(() => ({
    clubName: '',
    timezone: browserTimeZone(),
    locationName: '',
    locationAddress: '',
    adminName: '',
    adminEmail: '',
    adminPassword: '',
  }));
  const [errors, setErrors] = useState<Errors>({});
  /** Set up: the next page is loading (keep the button busy). */
  const [leaving, setLeaving] = useState(false);
  const timeZones = useMemo(() => {
    const zones = Intl.supportedValuesOf('timeZone');
    return zones.includes(form.timezone) ? zones : [form.timezone, ...zones];
  }, [form.timezone]);

  const setup = useMutation({
    mutationFn: (input: SetupInput) => api.post('/setup', input),
    // On to step 2 of the setup guide: Create shows for the month being planned. A full page
    // load (like sign-out): the setup gate redirects /setup → / as soon as it sees the finished
    // club, before a client-side navigation could commit. The session cookie is already set, so
    // the new page opens signed in. (If someone else finished setup first, the gate redirects.)
    onSuccess: (_data, input) => {
      setLeaving(true);
      window.location.replace(createShowsPath(planningMonth(todayInTz(input.timezone))));
    },
    onError: (err) => {
      if (isApiError(err, 'already_setup')) void refreshMe();
    },
  });

  const current = STEPS[step]!;
  const isLast = step === STEPS.length - 1;

  function set<K extends keyof SetupForm>(key: K, value: SetupForm[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }));
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const stepErrors = validate(form, current.fields);
    setErrors(stepErrors);
    if (Object.keys(stepErrors).length) return;
    if (!isLast) {
      setStep(step + 1);
      return;
    }
    setup.mutate({
      clubName: form.clubName,
      timezone: form.timezone,
      appUrl: window.location.origin,
      location: { name: form.locationName, address: form.locationAddress },
      admin: { name: form.adminName, email: form.adminEmail, password: form.adminPassword },
    });
  }

  return (
    <AuthShell
      title={current.title}
      description={current.description}
      documentTitle="Set up"
      className="max-w-md"
      footer={<GuideSteps />}
    >
      <ol className="mb-5 flex items-center gap-2" aria-label="Setup progress">
        {STEPS.map((s, i) => (
          <li key={s.title} className="flex flex-1 items-center gap-2" aria-current={i === step ? 'step' : undefined}>
            <span
              className={cn(
                'flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                i < step && 'bg-accent-solid text-accent-solid-fg',
                i === step && 'border-2 border-accent text-accent',
                i > step && 'border border-border-strong text-fg-subtle',
              )}
            >
              {i < step ? <Check className="size-3.5" aria-label="Done" /> : i + 1}
            </span>
            {i < STEPS.length - 1 && <span className={cn('h-px flex-1', i < step ? 'bg-accent' : 'bg-border')} />}
          </li>
        ))}
      </ol>

      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        {step === 0 && (
          <>
            <Field label="Club name" error={errors.clubName}>
              <Input
                autoFocus
                value={form.clubName}
                onChange={(e) => set('clubName', e.target.value)}
                placeholder="The Laugh Track"
              />
            </Field>
            <Field label="Timezone" hint="Show times and dates use this timezone." error={errors.timezone}>
              <Select value={form.timezone} onChange={(e) => set('timezone', e.target.value)}>
                {timeZones.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz.replaceAll('_', ' ')}
                  </option>
                ))}
              </Select>
            </Field>
          </>
        )}

        {step === 1 && (
          <>
            <Field label="Location name" error={errors.locationName}>
              <Input
                autoFocus
                value={form.locationName}
                onChange={(e) => set('locationName', e.target.value)}
                placeholder="The Cellar"
              />
            </Field>
            <Field label="Address (optional)" hint="Included in confirmation emails." error={errors.locationAddress}>
              <Input
                value={form.locationAddress}
                onChange={(e) => set('locationAddress', e.target.value)}
                placeholder="214 Sullivan St, New York, NY"
              />
            </Field>
          </>
        )}

        {step === 2 && (
          <>
            <Field label="Your name" error={errors.adminName}>
              <Input autoFocus autoComplete="name" value={form.adminName} onChange={(e) => set('adminName', e.target.value)} />
            </Field>
            <Field label="Email" error={errors.adminEmail}>
              <Input
                type="email"
                autoComplete="email"
                value={form.adminEmail}
                onChange={(e) => set('adminEmail', e.target.value)}
              />
            </Field>
            <Field label="Password" hint="At least 8 characters." error={errors.adminPassword}>
              <Input
                type="password"
                autoComplete="new-password"
                value={form.adminPassword}
                onChange={(e) => set('adminPassword', e.target.value)}
              />
            </Field>
          </>
        )}

        <FormError>{setup.error && !isApiError(setup.error, 'already_setup') ? errorMessage(setup.error) : null}</FormError>

        <div className="flex items-center gap-2 pt-1">
          {step > 0 && (
            <Button variant="ghost" onClick={() => setStep(step - 1)} disabled={setup.isPending || leaving}>
              <ArrowLeft /> Back
            </Button>
          )}
          <Button type="submit" className="ml-auto" loading={setup.isPending || leaving}>
            {isLast ? 'Finish setup' : 'Continue'}
          </Button>
        </div>
      </form>
    </AuthShell>
  );
}

/** Under the card: this wizard is step 1 of the 3-step setup guide. */
function GuideSteps() {
  const steps = ['Club', 'Shows', 'Comedians'];
  return (
    <div className="space-y-2">
      <ol aria-label="Setup guide" className="flex items-center justify-center gap-2 text-xs">
        {steps.map((label, i) => (
          <Fragment key={label}>
            {i > 0 && <li aria-hidden className="h-px w-6 bg-border-strong" />}
            <li
              aria-current={i === 0 ? 'step' : undefined}
              className={cn('flex items-center gap-1.5', i === 0 ? 'font-semibold text-fg' : 'text-fg-muted')}
            >
              <span
                className={cn(
                  'flex size-5 items-center justify-center rounded-full text-[11px] font-semibold',
                  i === 0 ? 'bg-accent-solid text-accent-solid-fg' : 'border border-border-strong text-fg-subtle',
                )}
              >
                {i + 1}
              </span>
              {label}
            </li>
          </Fragment>
        ))}
      </ol>
      <p className="text-xs text-fg-subtle">Step 1 of 3. Next, a short guide walks you through your first shows and comedians.</p>
    </div>
  );
}
