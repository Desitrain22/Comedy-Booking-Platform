import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import {
  COMEDIAN_BIO_MAX,
  updateComedianSchema,
  type ComedianDetail,
  type EmailTakenErrorExtra,
} from '../../../shared/api/comedians';
import { Avatar, Button, Dialog, Field, Input, Textarea } from '../../components/ui';
import { api, errorMessage, isApiError } from '../../lib/api';
import { cn } from '../../lib/cn';
import { comedianKeys, invalidateComedians } from './queries';

type FieldName = 'name' | 'email' | 'phone' | 'bio' | 'headshotUrl';
type Errors = Partial<Record<FieldName | 'form', string>>;

export interface EditComedianDialogProps {
  comedian: ComedianDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Bookers can change everything comedians can (name, phone, bio, headshot) plus the email. */
export function EditComedianDialog({ comedian, open, onOpenChange }: EditComedianDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Edit comedian"
      description="Comedians can also update their name, phone, bio and headshot from the portal."
      size="md"
    >
      {/* Remount per open so the form starts from the latest saved values. */}
      {open && <EditForm comedian={comedian} onDone={() => onOpenChange(false)} />}
    </Dialog>
  );
}

function EditForm({ comedian, onDone }: { comedian: ComedianDetail; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [values, setValues] = useState({
    name: comedian.name,
    email: comedian.email,
    phone: comedian.phone,
    headshotUrl: comedian.headshotUrl,
    bio: comedian.bio,
  });
  const [errors, setErrors] = useState<Errors>({});

  const save = useMutation({
    mutationFn: (patch: Record<string, string>) => api.patch<ComedianDetail>(`/comedians/${comedian.id}`, patch),
    onSuccess: (updated) => {
      queryClient.setQueryData(comedianKeys.detail(comedian.id), updated);
      invalidateComedians(queryClient);
      toast.success(
        'Saved',
        updated.email !== comedian.email
          ? { description: `${comedian.name} was signed out; send a sign-in link to ${updated.email}.` }
          : undefined,
      );
      onDone();
    },
    onError: (err) => {
      if (isApiError(err, 'email_taken')) {
        const { existing } = err.body as unknown as EmailTakenErrorExtra;
        setErrors({ email: `${existing.name}${existing.archived ? ' (archived)' : ''} already uses this email.` });
      } else {
        setErrors({ form: errorMessage(err) });
      }
    },
  });

  function set(field: FieldName, value: string) {
    setValues((v) => ({ ...v, [field]: value }));
    if (errors[field]) setErrors((e) => ({ ...e, [field]: undefined }));
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = updateComedianSchema.safeParse(values);
    if (!parsed.success) {
      const next: Errors = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] as FieldName;
        next[key] ??= issue.message;
      }
      setErrors(next);
      return;
    }
    // Send only what changed.
    const patch: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed.data)) {
      if (typeof value === 'string' && value !== comedian[key as FieldName]) patch[key] = value;
    }
    if (Object.keys(patch).length === 0) {
      onDone();
      return;
    }
    save.mutate(patch);
  }

  const previewUrl = values.headshotUrl.trim();
  const emailChanging = values.email.trim().toLowerCase() !== comedian.email;

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" error={errors.name}>
          <Input value={values.name} onChange={(e) => set('name', e.target.value)} autoComplete="off" />
        </Field>
        <Field
          label="Email"
          error={errors.email}
          hint={
            emailChanging
              ? 'Saving signs them out and voids their old sign-in and confirmation links.'
              : 'Where sign-in codes and booking emails go.'
          }
        >
          <Input type="email" value={values.email} onChange={(e) => set('email', e.target.value)} autoComplete="off" />
        </Field>
        <Field label="Phone" aside={<span className="text-xs text-fg-subtle">Optional</span>} error={errors.phone}>
          <Input
            type="tel"
            inputMode="tel"
            value={values.phone}
            onChange={(e) => set('phone', e.target.value)}
            autoComplete="off"
            placeholder="(212) 555-0142"
          />
        </Field>
      </div>
      <div className="flex items-start gap-3">
        <Avatar name={values.name || comedian.name} src={previewUrl} size="lg" className="mt-6" />
        <Field label="Headshot URL" error={errors.headshotUrl} hint="A link to an image (https://…)." className="flex-1">
          <Input
            type="url"
            value={values.headshotUrl}
            onChange={(e) => set('headshotUrl', e.target.value)}
            placeholder="https://"
            autoComplete="off"
          />
        </Field>
      </div>
      <Field
        label="Bio"
        error={errors.bio}
        aside={
          <span className={cn('text-xs tabular-nums', values.bio.length > COMEDIAN_BIO_MAX ? 'text-danger' : 'text-fg-subtle')}>
            {values.bio.length}/{COMEDIAN_BIO_MAX}
          </span>
        }
      >
        <Textarea value={values.bio} onChange={(e) => set('bio', e.target.value)} rows={4} />
      </Field>
      {errors.form && <p className="text-sm text-danger">{errors.form}</p>}
      <div className="-mx-5 -mb-4 flex flex-col-reverse gap-2 border-t border-border px-5 py-3 sm:flex-row sm:justify-end">
        <Button variant="secondary" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" loading={save.isPending}>
          Save changes
        </Button>
      </div>
    </form>
  );
}
