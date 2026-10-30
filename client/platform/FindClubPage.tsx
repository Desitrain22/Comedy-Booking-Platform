/**
 * /signin on the platform site: "find my club". Every account lives on its club's own
 * address, so this emails the sign-in links of every club the address belongs to. The answer
 * is the same whether or not it has any (POST /api/platform/find-club always says ok).
 */
import { useMutation } from '@tanstack/react-query';
import { MailCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import type { FindClubRequest } from '../../shared/api/platform';
import { emailSchema } from '../../shared/schemas';
import { FormError } from '../components/AuthShell';
import { Button, Field, Input } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { usePlatformHost } from './PlatformApp';
import { PlatformShell } from './PlatformShell';

export function FindClubPage() {
  const host = usePlatformHost();
  const [email, setEmail] = useState('');
  const [fieldError, setFieldError] = useState<string>();
  const [sentTo, setSentTo] = useState<string | null>(null);
  const find = useMutation({
    mutationFn: (input: FindClubRequest) => api.post('/platform/find-club', input),
    onSuccess: (_data, input) => setSentTo(input.email),
    meta: { silent: true },
  });

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const parsed = emailSchema.safeParse(email);
    if (!parsed.success) return setFieldError(parsed.error.issues[0]?.message ?? 'Enter your email');
    setFieldError(undefined);
    find.mutate({ email: parsed.data });
  }

  const footer = host.signupsOpen ? (
    <>
      New here?{' '}
      <Link to="/signup" className="font-medium text-accent hover:underline">
        Create your club
      </Link>
    </>
  ) : (
    <Link to="/" className="hover:text-fg">
      {host.platformName}
    </Link>
  );

  if (sentTo) {
    return (
      <PlatformShell
        brand={host.platformName}
        brandHref="/"
        icon={<MailCheck aria-hidden />}
        title="Check your email"
        documentTitle="Find your club"
        footer={footer}
      >
        <p className="text-sm text-fg" role="status">
          If <span className="font-medium">{sentTo}</span> has an account, we've emailed you a link.
        </p>
        <p className="mt-2 text-sm text-fg-muted">It lists each club you belong to, with its sign-in page.</p>
        <Button
          variant="secondary"
          className="mt-5 w-full"
          onClick={() => {
            setSentTo(null);
            find.reset();
          }}
        >
          Try another address
        </Button>
      </PlatformShell>
    );
  }

  return (
    <PlatformShell
      brand={host.platformName}
      brandHref="/"
      title="Find your club"
      description="Each club has its own address. Enter your email and we'll send you a link to every club where you're a booker or a comedian."
      footer={footer}
    >
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <Field label="Email" error={fieldError}>
          <Input
            type="email"
            autoComplete="email"
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@yourclub.com"
          />
        </Field>
        <FormError>{find.error ? errorMessage(find.error) : null}</FormError>
        <Button type="submit" className="w-full" loading={find.isPending}>
          Email me my clubs
        </Button>
      </form>
    </PlatformShell>
  );
}
