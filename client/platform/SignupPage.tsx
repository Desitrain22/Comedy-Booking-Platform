/**
 * /signup on the platform site: create a club (hosted MVP spec §4). The same three pages as
 * the first-run setup wizard (client/pages/setup/SetupPage.tsx) — company, first location,
 * your account — plus the club's web address, checked live. On success the browser goes to
 * the handoff URL on the club's own address (`<slug>.<domain>/welcome#<token>`), which signs
 * the new booker in and lands on step 2 of the setup guide.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, LoaderCircle } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import type { z } from 'zod';
import {
  signupSchema,
  slugSchema,
  suggestSlug,
  type SignupRequest,
  type SignupResponse,
  type SlugCheckResponse,
} from '../../shared/api/platform';
import { emailSchema, passwordSchema, timeZoneSchema } from '../../shared/schemas';
import { FormError } from '../components/AuthShell';
import { Button, Field, Input, Select, type InputProps } from '../components/ui';
import { api, errorMessage, isApiError } from '../lib/api';
import { browserTimeZone, GuideSteps, WizardProgress } from '../pages/setup/SetupPage';
import { platformHostName, usePlatformHost } from './PlatformApp';
import { PlatformShell } from './PlatformShell';

interface SignupForm {
  clubName: string;
  slug: string;
  timezone: string;
  locationName: string;
  locationAddress: string;
  adminName: string;
  adminEmail: string;
  adminPassword: string;
  /** Honeypot (hidden). */
  website: string;
}

type FieldKey = Exclude<keyof SignupForm, 'website'>;
type Errors = Partial<Record<FieldKey, string>>;

const STEPS: { title: string; label: string; description: string; fields: FieldKey[] }[] = [
  {
    title: 'Create your club',
    label: 'Your club',
    description: 'Your company name shows up in emails and on the comedian portal.',
    fields: ['clubName', 'slug', 'timezone'],
  },
  {
    title: 'Your first location',
    label: 'Location',
    description: 'A room or venue where shows happen. You can add more later in Settings.',
    fields: ['locationName', 'locationAddress'],
  },
  {
    title: 'Your account',
    label: 'Your login',
    description: 'You will sign in with this email and password.',
    fields: ['adminName', 'adminEmail', 'adminPassword'],
  },
];

const shape = signupSchema.shape;
const FIELD_SCHEMAS: Record<FieldKey, z.ZodType> = {
  clubName: shape.clubName,
  slug: slugSchema,
  timezone: timeZoneSchema,
  locationName: shape.location.shape.name,
  locationAddress: shape.location.shape.address,
  adminName: shape.admin.shape.name,
  adminEmail: emailSchema,
  adminPassword: passwordSchema,
};

/** API issue paths → form fields. */
const ISSUE_FIELDS: Record<string, FieldKey> = {
  clubName: 'clubName',
  slug: 'slug',
  timezone: 'timezone',
  'location.name': 'locationName',
  'location.address': 'locationAddress',
  'admin.name': 'adminName',
  'admin.email': 'adminEmail',
  'admin.password': 'adminPassword',
};

function validate(form: SignupForm, fields: FieldKey[]): Errors {
  const errors: Errors = {};
  for (const field of fields) {
    const result = FIELD_SCHEMAS[field].safeParse(form[field]);
    if (!result.success) errors[field] = result.error.issues[0]?.message ?? 'Invalid value';
  }
  return errors;
}

const slugQueryKey = (slug: string) => ['platform', 'slug', slug] as const;
const fetchSlug = (slug: string, signal?: AbortSignal) =>
  api.get<SlugCheckResponse>('/platform/slug', { query: { slug }, signal });

/** `value`, once it has stopped changing for `ms`. */
function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

export function SignupPage() {
  const host = usePlatformHost();
  const domain = platformHostName(host);
  const queryClient = useQueryClient();
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<SignupForm>(() => ({
    clubName: '',
    slug: '',
    timezone: browserTimeZone(),
    locationName: '',
    locationAddress: '',
    adminName: '',
    adminEmail: '',
    adminPassword: '',
    website: '',
  }));
  const [slugEdited, setSlugEdited] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [checking, setChecking] = useState(false);
  /** Created: the club's address is loading (keep the button busy). */
  const [leaving, setLeaving] = useState(false);

  const timeZones = useMemo(() => {
    const zones = Intl.supportedValuesOf('timeZone');
    return zones.includes(form.timezone) ? zones : [form.timezone, ...zones];
  }, [form.timezone]);

  // Live address check: once the slug is well-formed and has settled.
  const slug = form.slug.trim().toLowerCase();
  const debouncedSlug = useDebounced(slug, 300);
  const slugWellFormed = slugSchema.safeParse(debouncedSlug).success;
  const slugCheck = useQuery({
    queryKey: slugQueryKey(debouncedSlug),
    queryFn: ({ signal }) => fetchSlug(debouncedSlug, signal),
    enabled: slugWellFormed && step === 0,
    staleTime: 10_000,
  });
  const liveSlug = slugWellFormed && debouncedSlug === slug ? slugCheck.data : undefined;

  const signup = useMutation({
    mutationFn: (input: SignupRequest) => api.post<SignupResponse>('/platform/signup', input),
    onSuccess: (data) => {
      setLeaving(true);
      window.location.assign(data.handoffUrl);
    },
    onError: (err) => {
      if (isApiError(err, 'slug_taken')) {
        void queryClient.invalidateQueries({ queryKey: slugQueryKey(slug) });
        setErrors({ slug: err.message });
        setStep(0);
        return;
      }
      const issues = isApiError(err, 'validation_error')
        ? ((err.body.issues as { path: string; message: string }[] | undefined) ?? [])
        : [];
      const fieldErrors: Errors = {};
      for (const issue of issues) {
        const field = ISSUE_FIELDS[issue.path];
        if (field && !fieldErrors[field]) fieldErrors[field] = issue.message;
      }
      const first = STEPS.findIndex((s) => s.fields.some((f) => fieldErrors[f]));
      if (first >= 0) {
        setErrors(fieldErrors);
        setStep(first);
      }
    },
  });

  function set<K extends keyof SignupForm>(key: K, value: SignupForm[K]) {
    setForm((f) => {
      const next = { ...f, [key]: value };
      if (key === 'clubName' && !slugEdited) next.slug = suggestSlug(String(value));
      return next;
    });
    if (key in errors) setErrors((e) => ({ ...e, [key]: undefined, ...(key === 'clubName' && !slugEdited ? { slug: undefined } : {}) }));
  }

  /** Is the address free right now? Asks the server when the live check hasn't answered yet. */
  async function slugError(): Promise<string | undefined> {
    try {
      setChecking(true);
      const result = await queryClient.fetchQuery({
        queryKey: slugQueryKey(slug),
        queryFn: ({ signal }) => fetchSlug(slug, signal),
        staleTime: 5_000,
      });
      return result.available ? undefined : result.reason;
    } catch {
      return undefined; // the server checks again on sign-up
    } finally {
      setChecking(false);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const current = STEPS[step]!;
    const stepErrors = validate(form, current.fields);
    if (step === 0 && !stepErrors.slug) {
      const taken = await slugError();
      if (taken) stepErrors.slug = taken;
    }
    setErrors(stepErrors);
    if (Object.keys(stepErrors).length) return;
    if (step < STEPS.length - 1) {
      setStep(step + 1);
      return;
    }
    signup.mutate({
      clubName: form.clubName,
      slug,
      timezone: form.timezone,
      location: { name: form.locationName, address: form.locationAddress },
      admin: { name: form.adminName, email: form.adminEmail, password: form.adminPassword },
      website: form.website,
    });
  }

  const footer = (
    <div className="space-y-4">
      <GuideSteps />
      <p>
        Already have a club?{' '}
        <Link to="/signin" className="font-medium text-accent hover:underline">
          Find it
        </Link>
      </p>
    </div>
  );

  if (!host.signupsOpen) {
    return (
      <PlatformShell
        brand={host.platformName}
        brandHref="/"
        title="Sign-ups are closed"
        description="We're not taking new clubs right now."
      >
        {host.supportEmail && (
          <p className="text-sm text-fg">
            To get a club set up, write to{' '}
            <a className="font-medium text-accent hover:underline" href={`mailto:${host.supportEmail}`}>
              {host.supportEmail}
            </a>
            .
          </p>
        )}
      </PlatformShell>
    );
  }

  const current = STEPS[step]!;
  const isLast = step === STEPS.length - 1;
  const busy = signup.isPending || leaving;
  const formError =
    signup.error && !isApiError(signup.error, 'slug_taken') && !isApiError(signup.error, 'validation_error')
      ? errorMessage(signup.error)
      : null;

  return (
    <PlatformShell
      brand={host.platformName}
      brandHref="/"
      title={current.title}
      description={current.description}
      documentTitle="Create your club"
      className="max-w-md"
      footer={footer}
    >
      <WizardProgress steps={STEPS} step={step} />

      <form onSubmit={(e) => void handleSubmit(e)} noValidate className="space-y-4">
        {step === 0 && (
          <>
            <Field label="Company name" error={errors.clubName}>
              <Input
                autoFocus
                value={form.clubName}
                onChange={(e) => set('clubName', e.target.value)}
                placeholder="Broadway Comedy"
                maxLength={100}
              />
            </Field>
            <Field
              label="Web address"
              error={errors.slug}
              hint={<SlugHint slug={slug} domain={domain} live={liveSlug} pending={slugWellFormed && slugCheck.isFetching} />}
            >
              <SlugInput
                suffix={`.${domain}`}
                value={form.slug}
                onChange={(e) => {
                  setSlugEdited(true);
                  set('slug', e.target.value.toLowerCase().replace(/\s+/g, '-'));
                }}
                placeholder="broadway"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                maxLength={30}
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
                placeholder="Broadway Comedy Club"
              />
            </Field>
            <Field label="Address (optional)" hint="Included in confirmation emails." error={errors.locationAddress}>
              <Input
                value={form.locationAddress}
                onChange={(e) => set('locationAddress', e.target.value)}
                placeholder="318 W 53rd St, New York, NY"
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
            {/* Honeypot: people never see it; bots fill every field. */}
            <div aria-hidden="true" className="absolute -left-[9999px] h-px w-px overflow-hidden">
              <label>
                Website
                <input
                  type="text"
                  name="website"
                  tabIndex={-1}
                  autoComplete="off"
                  value={form.website}
                  onChange={(e) => set('website', e.target.value)}
                />
              </label>
            </div>
          </>
        )}

        <FormError>{formError}</FormError>

        <div className="flex items-center gap-2 pt-1">
          {step > 0 && (
            <Button variant="ghost" onClick={() => setStep(step - 1)} disabled={busy}>
              <ArrowLeft /> Back
            </Button>
          )}
          <Button type="submit" className="ml-auto" loading={busy || checking}>
            {isLast ? 'Create club' : 'Continue'}
          </Button>
        </div>
      </form>
    </PlatformShell>
  );
}

/** An input with the platform domain after it: [broadway][.comedybook.app] */
function SlugInput({ suffix, className, ...props }: InputProps & { suffix: string }) {
  return (
    <div className="flex min-w-0 items-stretch">
      <Input {...props} className={`min-w-0 rounded-r-none ${className ?? ''}`} />
      <span className="flex max-w-[55%] shrink-0 items-center truncate rounded-r-lg border border-l-0 border-border-strong bg-surface-2 px-2.5 text-sm text-fg-muted">
        {suffix}
      </span>
    </div>
  );
}

function SlugHint({
  slug,
  domain,
  live,
  pending,
}: {
  slug: string;
  domain: string;
  live: SlugCheckResponse | undefined;
  pending: boolean;
}) {
  if (!slug) return <>Your club's own address. Letters, numbers and dashes.</>;
  if (live?.available) {
    return (
      <span className="inline-flex items-center gap-1 text-confirmed-fg">
        <Check aria-hidden className="size-3.5" /> {slug}.{domain} is available
      </span>
    );
  }
  if (live && !live.available) return <span className="text-danger">{live.reason ?? 'Not available'}</span>;
  if (pending) {
    return (
      <span className="inline-flex items-center gap-1">
        <LoaderCircle aria-hidden className="size-3.5 animate-spin" /> Checking {slug}.{domain}…
      </span>
    );
  }
  return (
    <>
      Your club will be at {slug}.{domain}
    </>
  );
}
