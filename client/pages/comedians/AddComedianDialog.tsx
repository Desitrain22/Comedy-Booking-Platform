import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { createComedianSchema, type CreateComedianResponse, type EmailTakenErrorExtra } from '../../../shared/api/comedians';
import { Button, Dialog, Field, Input } from '../../components/ui';
import { api, errorMessage, isApiError } from '../../lib/api';
import { useBooker } from '../../lib/useMe';
import { addedToast } from './loginLinks';
import { invalidateComedians } from './queries';
import { SendLinkCheckbox } from './SendLinkCheckbox';

export interface AddComedianDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface FieldErrors {
  name?: string;
  email?: string;
  phone?: string;
  form?: string;
}

/**
 * Name + email is all it takes (phone is optional); comedians add their own bio and
 * headshot in the portal. "Email them a sign-in link" (on by default) invites them to the
 * portal right away.
 */
export function AddComedianDialog({ open, onOpenChange }: AddComedianDialogProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const isAdmin = useBooker().role === 'admin';
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [sendLink, setSendLink] = useState(true);
  const [errors, setErrors] = useState<FieldErrors>({});

  const create = useMutation({
    mutationFn: (input: { name: string; email: string; phone: string; sendLoginLink: boolean }) =>
      api.post<CreateComedianResponse>('/comedians', input),
    onSuccess: (comedian) => {
      invalidateComedians(queryClient);
      const t = addedToast(comedian.name, comedian.email, comedian.loginLink, isAdmin);
      toast[t.tone](t.title, {
        description: t.description,
        action: { label: 'Open profile', onClick: () => void navigate(`/app/comedians/${comedian.id}`) },
      });
      close(false);
    },
    onError: (err) => {
      if (isApiError(err, 'email_taken')) {
        const { existing } = err.body as unknown as EmailTakenErrorExtra;
        setErrors({
          email: `${existing.name}${existing.archived ? ' (archived)' : ''} already uses this email.`,
        });
      } else {
        setErrors({ form: errorMessage(err) });
      }
    },
  });

  function close(next: boolean) {
    if (!next) {
      setName('');
      setEmail('');
      setPhone('');
      setSendLink(true);
      setErrors({});
      create.reset();
    }
    onOpenChange(next);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = createComedianSchema.safeParse({ name, email, phone });
    if (!parsed.success) {
      const next: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0];
        if ((key === 'name' || key === 'email' || key === 'phone') && !next[key]) next[key] = issue.message;
      }
      setErrors(next);
      return;
    }
    setErrors({});
    create.mutate({ name: parsed.data.name, email: parsed.data.email, phone: parsed.data.phone ?? '', sendLoginLink: sendLink });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title="Add comedian"
      description="Just a name and email. They can add a bio and headshot themselves from the portal."
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button type="submit" form="add-comedian-form" loading={create.isPending}>
            Add comedian
          </Button>
        </>
      }
    >
      <form id="add-comedian-form" onSubmit={submit} className="space-y-4" noValidate>
        <Field label="Name" error={errors.name}>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" autoFocus placeholder="Jason Lee" />
        </Field>
        <Field label="Email" error={errors.email}>
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="off"
            placeholder="jason@example.com"
          />
        </Field>
        <Field label="Phone" aside={<span className="text-xs text-fg-subtle">Optional</span>} error={errors.phone}>
          <Input
            type="tel"
            inputMode="tel"
            value={phone}
            onChange={(e) => {
              setPhone(e.target.value);
              if (errors.phone) setErrors((prev) => ({ ...prev, phone: undefined }));
            }}
            autoComplete="off"
            placeholder="(212) 555-0142"
          />
        </Field>
        <SendLinkCheckbox checked={sendLink} onChange={setSendLink} />
        {errors.form && <p className="text-sm text-danger">{errors.form}</p>}
      </form>
    </Dialog>
  );
}
