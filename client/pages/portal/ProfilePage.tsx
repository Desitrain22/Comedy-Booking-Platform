/**
 * /portal/profile — how the club sees the comedian: name, bio (≤ 1000 chars) and a
 * headshot link with a live preview (falls back to initials when the image won't load).
 * Email is read-only ("Contact the club to change it").
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ImageOff, RotateCw } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import {
  isHttpUrl,
  PORTAL_BIO_MAX,
  updatePortalProfileSchema,
  type PortalProfile,
  type UpdatePortalProfileInput,
} from '../../../shared/api/portal';
import { Avatar, Button, Card, CardBody, CardFooter, EmptyState, Field, Input, PageHeader, PageSpinner, Textarea } from '../../components/ui';
import { api, errorMessage, isApiError } from '../../lib/api';
import { cn } from '../../lib/cn';
import { ME_QUERY_KEY } from '../../lib/useMe';
import { portalKeys, useProfile } from './portalQueries';
import { useUnsavedChangesGuard } from './useUnsavedChangesGuard';

type Form = { name: string; bio: string; headshotUrl: string };
type FormErrors = Partial<Record<keyof Form, string>>;

const header = <PageHeader title="Profile" description="This is what the club sees when they book you." />;

export function ProfilePage() {
  const profile = useProfile();
  if (profile.data) return <ProfileForm key={profile.data.id} profile={profile.data} />;
  return (
    <>
      {header}
      {profile.isError ? (
        <EmptyState
          title="Couldn't load your profile"
          description={errorMessage(profile.error)}
          action={
            <Button variant="secondary" onClick={() => void profile.refetch()} loading={profile.isFetching}>
              <RotateCw /> Try again
            </Button>
          }
        />
      ) : (
        <PageSpinner />
      )}
    </>
  );
}

const toForm = (p: PortalProfile): Form => ({ name: p.name, bio: p.bio, headshotUrl: p.headshotUrl });

/** zod issues (client-side parse or the server's 400 body) → one message per field. */
function fieldErrors(issues: readonly { path: readonly PropertyKey[] | string; message: string }[]): FormErrors {
  const out: FormErrors = {};
  for (const issue of issues) {
    const key = (typeof issue.path === 'string' ? issue.path : String(issue.path[0] ?? '')) as keyof Form;
    if (key in { name: 1, bio: 1, headshotUrl: 1 } && !out[key]) out[key] = issue.message;
  }
  return out;
}

function ProfileForm({ profile }: { profile: PortalProfile }) {
  const queryClient = useQueryClient();
  const [saved, setSaved] = useState<Form>(() => toForm(profile));
  const [form, setForm] = useState<Form>(saved);
  const [errors, setErrors] = useState<FormErrors>({});
  const dirty = form.name !== saved.name || form.bio !== saved.bio || form.headshotUrl !== saved.headshotUrl;

  const save = useMutation({
    mutationFn: (input: UpdatePortalProfileInput) => api.put<PortalProfile>('/portal/profile', input),
    meta: { silent: true },
    onSuccess: (res) => {
      const next = toForm(res);
      setSaved(next);
      setForm(next);
      queryClient.setQueryData(portalKeys.profile, res);
      void queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY }); // the header greets by name
      void queryClient.invalidateQueries({ queryKey: portalKeys.me });
      toast.success('Profile saved');
    },
  });

  /** Validate, then save. Rejects (after showing field errors) when invalid. */
  async function submit(): Promise<PortalProfile> {
    const parsed = updatePortalProfileSchema.safeParse(form);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error.issues));
      throw new Error('Fix the highlighted fields first');
    }
    setErrors({});
    try {
      return await save.mutateAsync(form);
    } catch (err) {
      const issues = isApiError(err, 'validation_error') ? (err.body.issues as { path: string; message: string }[] | undefined) : undefined;
      if (issues) setErrors(fieldErrors(issues));
      throw err;
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    submit().catch((err: unknown) => {
      if (!(err instanceof Error && err.message === 'Fix the highlighted fields first')) {
        toast.error(errorMessage(err, "Couldn't save. Try again."));
      }
    });
  }

  const guard = useUnsavedChangesGuard({
    dirty,
    onSave: submit,
    title: 'Save your profile?',
    description: "Your profile changes haven't been saved yet.",
  });

  function set<K extends keyof Form>(key: K, value: Form[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }));
  }

  const headshot = useHeadshotStatus(form.headshotUrl);
  const bioLength = form.bio.length;

  return (
    <>
      {header}
      <form onSubmit={onSubmit} noValidate>
        <Card>
          <CardBody className="space-y-5">
            <div className="flex items-center gap-4">
              <Avatar name={form.name || profile.name} src={headshot.src} size="xl" className="size-20 text-xl sm:size-24 sm:text-2xl" />
              <div className="min-w-0">
                <p className="truncate text-base font-semibold text-fg">{form.name.trim() || 'Your name'}</p>
                <p className="truncate text-sm text-fg-muted">{profile.email}</p>
              </div>
            </div>

            <Field label="Name" error={errors.name}>
              <Input
                className="h-11 sm:h-9"
                autoComplete="name"
                value={form.name}
                onChange={(e) => set('name', e.target.value)}
              />
            </Field>

            <Field
              label="Bio"
              hint="A few lines about you: credits, style, where you've performed."
              error={errors.bio}
              aside={
                <span className={cn('text-xs tabular-nums', bioLength > PORTAL_BIO_MAX ? 'font-medium text-danger' : 'text-fg-muted')}>
                  {bioLength}/{PORTAL_BIO_MAX}
                </span>
              }
            >
              <Textarea rows={6} value={form.bio} onChange={(e) => set('bio', e.target.value)} />
            </Field>

            <Field
              label="Headshot link"
              hint={
                headshot.status === 'error' ? (
                  <span className="inline-flex items-center gap-1 text-awaiting-fg">
                    <ImageOff aria-hidden className="size-3.5" /> Couldn't load an image from that link. Check that it opens in your browser.
                  </span>
                ) : (
                  'Paste a link to a photo of you (starting with https://).'
                )
              }
              error={errors.headshotUrl}
            >
              <Input
                type="url"
                inputMode="url"
                autoComplete="url"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="https://…"
                className="h-11 sm:h-9"
                value={form.headshotUrl}
                onChange={(e) => set('headshotUrl', e.target.value)}
              />
            </Field>

            <Field label="Email" hint="Contact the club to change it.">
              <Input className="h-11 sm:h-9" value={profile.email} readOnly disabled />
            </Field>
          </CardBody>
          <CardFooter className="flex-col items-stretch sm:flex-row sm:items-center">
            {dirty && (
              <span className="text-center text-xs text-awaiting-fg sm:mr-auto sm:text-left sm:text-sm">
                <span aria-hidden className="mr-1.5 inline-block size-2 rounded-full bg-awaiting align-middle" />
                Unsaved changes
              </span>
            )}
            <Button type="submit" size="lg" className="w-full sm:h-10 sm:w-auto" disabled={!dirty} loading={save.isPending}>
              Save
            </Button>
          </CardFooter>
        </Card>
      </form>
      {guard.dialog}
    </>
  );
}

/**
 * Live headshot preview: waits for typing to pause, then tries to load the image.
 * `src` is the URL to show (undefined → initials); `status` drives the hint.
 */
function useHeadshotStatus(url: string): { src: string | undefined; status: 'none' | 'loading' | 'ok' | 'error' } {
  const [debounced, setDebounced] = useState(url.trim());
  const [result, setResult] = useState<{ url: string; ok: boolean } | null>(null);

  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(url.trim()), 400);
    return () => window.clearTimeout(id);
  }, [url]);

  useEffect(() => {
    if (!debounced || !isHttpUrl(debounced)) return;
    let cancelled = false;
    const img = new Image();
    img.referrerPolicy = 'no-referrer';
    img.onload = () => !cancelled && setResult({ url: debounced, ok: true });
    img.onerror = () => !cancelled && setResult({ url: debounced, ok: false });
    img.src = debounced;
    return () => {
      cancelled = true;
    };
  }, [debounced]);

  if (!debounced || !isHttpUrl(debounced)) return { src: undefined, status: 'none' };
  if (result?.url !== debounced) return { src: undefined, status: 'loading' };
  return result.ok ? { src: debounced, status: 'ok' } : { src: undefined, status: 'error' };
}
