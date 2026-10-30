/**
 * /admin/login: the owner's email, then the 6-digit code it was sent. Any address gets the
 * same "check your email" (only listed owners actually get a code).
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Navigate, useSearchParams } from 'react-router';
import type { AdminMeResponse, AdminVerifyCodeRequest } from '../../../shared/api/platformAdmin';
import { emailSchema } from '../../../shared/schemas';
import { FormError } from '../../components/AuthShell';
import { Button, Field, Input, PageSpinner } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { usePlatformHost } from '../PlatformApp';
import { PlatformShell } from '../PlatformShell';
import { ADMIN_ME_KEY, useAdminMe } from './adminApi';

/** Only same-console paths: never an open redirect. */
function safeNext(raw: string | null): string {
  return raw && raw.startsWith('/admin') && !raw.startsWith('//') ? raw : '/admin';
}

export function AdminLoginPage() {
  const host = usePlatformHost();
  const me = useAdminMe();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));

  const [email, setEmail] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [fieldError, setFieldError] = useState<string>();

  const requestCode = useMutation({
    mutationFn: (address: string) => api.post('/platform/admin/request-code', { email: address }),
    onSuccess: (_data, address) => {
      setSentTo(address);
      setCode('');
    },
    meta: { silent: true },
  });
  const verify = useMutation({
    mutationFn: (input: AdminVerifyCodeRequest) => api.post<AdminMeResponse>('/platform/admin/verify-code', input),
    onSuccess: (data) => queryClient.setQueryData(ADMIN_ME_KEY, data),
    meta: { silent: true },
  });

  if (me.isPending) return <PageSpinner className="min-h-dvh" />;
  if (me.data?.admin) return <Navigate to={next} replace />;

  function submitEmail(e: FormEvent) {
    e.preventDefault();
    const parsed = emailSchema.safeParse(email);
    if (!parsed.success) return setFieldError(parsed.error.issues[0]?.message ?? 'Enter your email');
    setFieldError(undefined);
    requestCode.mutate(parsed.data);
  }

  function submitCode(e: FormEvent) {
    e.preventDefault();
    const digits = code.replace(/\D/g, '');
    if (digits.length !== 6) return setFieldError('Enter the 6-digit code');
    setFieldError(undefined);
    verify.mutate({ email: sentTo!, code: digits });
  }

  if (sentTo) {
    return (
      <PlatformShell
        brand={host.platformName}
        brandHref="/"
        icon={<ShieldCheck aria-hidden />}
        title="Enter your code"
        documentTitle="Owner sign-in"
        description={
          <>
            If <span className="font-medium text-fg">{sentTo}</span> runs this site, we've emailed it a 6-digit code. It
            works for 10 minutes.
          </>
        }
      >
        <form onSubmit={submitCode} noValidate className="space-y-4">
          <Field label="Code" error={fieldError}>
            <Input
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              maxLength={9}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123456"
              className="font-mono tracking-widest"
            />
          </Field>
          <FormError>{verify.error ? errorMessage(verify.error) : null}</FormError>
          <Button type="submit" className="w-full" loading={verify.isPending}>
            Sign in
          </Button>
          <div className="flex items-center justify-between gap-2 text-sm">
            <button
              type="button"
              className="text-fg-muted hover:text-fg"
              onClick={() => {
                setSentTo(null);
                setFieldError(undefined);
                verify.reset();
              }}
            >
              Use another email
            </button>
            <button
              type="button"
              className="font-medium text-accent hover:underline disabled:opacity-50"
              disabled={requestCode.isPending}
              onClick={() => {
                verify.reset();
                requestCode.mutate(sentTo);
              }}
            >
              Send a new code
            </button>
          </div>
        </form>
      </PlatformShell>
    );
  }

  return (
    <PlatformShell
      brand={host.platformName}
      brandHref="/"
      icon={<ShieldCheck aria-hidden />}
      title="Owner console"
      documentTitle="Owner sign-in"
      description="For the people who run this site. We'll email you a sign-in code."
    >
      <form onSubmit={submitEmail} noValidate className="space-y-4">
        <Field label="Email" error={fieldError}>
          <Input
            type="email"
            autoComplete="email"
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
          />
        </Field>
        <FormError>{requestCode.error ? errorMessage(requestCode.error) : null}</FormError>
        <Button type="submit" className="w-full" loading={requestCode.isPending}>
          Email me a code
        </Button>
      </form>
    </PlatformShell>
  );
}
