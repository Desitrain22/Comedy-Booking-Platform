/** /accept-invite/:token — an invited booker sets their password and lands in /app. */
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { AcceptInviteInput } from '../../../shared/schemas';
import type { InviteInfo } from '../../../shared/types';
import { AuthShell, FormError } from '../../components/AuthShell';
import { Button, buttonClasses, Field, Input, PageSpinner } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { useRefreshMe } from '../../lib/useMe';

export function AcceptInvitePage() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const refreshMe = useRefreshMe();
  const invite = useQuery({
    queryKey: ['auth', 'invite', token],
    queryFn: ({ signal }) => api.get<InviteInfo>(`/auth/invite/${encodeURIComponent(token)}`, { signal }),
    retry: false,
    staleTime: Infinity,
  });

  const [name, setName] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const accept = useMutation({
    mutationFn: (input: AcceptInviteInput) => api.post('/auth/accept-invite', input),
    onSuccess: async () => {
      await refreshMe();
      navigate('/app', { replace: true });
    },
    onError: (err) => setFormError(errorMessage(err)),
  });

  if (invite.isPending) return <PageSpinner className="min-h-dvh" />;

  if (invite.isError) {
    return (
      <AuthShell title="This invite link doesn't work" description="It may have expired or already been used.">
        <p className="text-sm text-fg-muted">Ask a club admin to send you a fresh invite.</p>
        <Link to="/login" className={buttonClasses({ variant: 'secondary', className: 'mt-5 w-full' })}>
          Go to sign in
        </Link>
      </AuthShell>
    );
  }

  const info = invite.data;
  const displayName = name ?? info.name;

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (password.length < 8) return setFormError('Use at least 8 characters for your password.');
    if (password !== confirm) return setFormError("The passwords don't match.");
    setFormError(null);
    accept.mutate({ token, password, name: displayName.trim() || undefined });
  }

  return (
    <AuthShell
      title={`Join ${info.clubName || 'the club'}`}
      description={`You've been invited to book shows as ${info.email}. Choose a password to get started.`}
      documentTitle="Accept invite"
    >
      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <Field label="Your name">
          <Input autoComplete="name" value={displayName} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Password" hint="At least 8 characters.">
          <Input
            type="password"
            autoComplete="new-password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Field label="Confirm password">
          <Input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
        <FormError>{formError}</FormError>
        <Button type="submit" className="w-full" loading={accept.isPending}>
          Accept invite
        </Button>
      </form>
    </AuthShell>
  );
}
