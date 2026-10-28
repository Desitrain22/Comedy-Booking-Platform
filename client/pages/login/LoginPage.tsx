/** Booker sign-in (/login). Redirects to `?next=` (default /app) once signed in. */
import { useMutation } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, Navigate } from 'react-router';
import type { LoginInput } from '../../../shared/schemas';
import { AuthShell, FormError } from '../../components/AuthShell';
import { useNextPath } from '../../components/guards';
import { Button, Field, Input } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { useMe, useRefreshMe } from '../../lib/useMe';

export function LoginPage() {
  const { data: me } = useMe();
  const next = useNextPath('/app');
  const refreshMe = useRefreshMe();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const login = useMutation({
    mutationFn: (input: LoginInput) => api.post('/auth/login', input),
    // Once /auth/me has the booker, the redirect below kicks in.
    onSuccess: () => refreshMe(),
    onError: () => setPassword(''),
  });

  if (me?.booker) return <Navigate to={next.startsWith('/app') ? next : '/app'} replace />;

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    login.mutate({ email, password });
  }

  return (
    <AuthShell
      title="Sign in"
      description="For club staff who book shows."
      footer={
        <>
          Comedian?{' '}
          <Link to="/portal/login" className="font-medium text-accent hover:underline">
            Sign in to the portal
          </Link>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="Email">
          <Input
            type="email"
            autoComplete="username"
            autoFocus
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label="Password">
          <Input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <FormError>{login.error ? errorMessage(login.error) : null}</FormError>
        <Button type="submit" className="w-full" loading={login.isPending}>
          Sign in
        </Button>
      </form>
    </AuthShell>
  );
}
