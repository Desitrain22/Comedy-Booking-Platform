/**
 * Comedian sign-in (/portal/login): email → emailed 6-digit code → in.
 * Foundation version; F4 polishes it (6 boxes etc.). Messaging never reveals whether an
 * email is on the roster.
 */
import { useMutation } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, Navigate } from 'react-router';
import type { RequestCodeInput, VerifyCodeInput } from '../../../shared/schemas';
import { AuthShell, FormError } from '../../components/AuthShell';
import { useNextPath } from '../../components/guards';
import { Button, Field, Input } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { useMe, useRefreshMe } from '../../lib/useMe';

const RESEND_COOLDOWN_S = 30;

export function LoginPage() {
  const { data: me } = useMe();
  const next = useNextPath('/portal');
  const refreshMe = useRefreshMe();
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const requestCode = useMutation({
    mutationFn: (input: RequestCodeInput) => api.post('/auth/comedian/request-code', input),
    meta: { silent: true }, // errors are shown inline
    onSuccess: () => {
      setStep('code');
      setCode('');
      setCooldown(RESEND_COOLDOWN_S);
    },
  });

  const verifyCode = useMutation({
    mutationFn: (input: VerifyCodeInput) => api.post('/auth/comedian/verify-code', input),
    onSuccess: () => refreshMe(),
    onError: () => setCode(''),
  });

  if (me?.comedian) return <Navigate to={next.startsWith('/portal') ? next : '/portal'} replace />;

  function submitEmail(e: FormEvent) {
    e.preventDefault();
    requestCode.mutate({ email });
  }

  function submitCode(value: string) {
    if (value.length === 6 && !verifyCode.isPending) verifyCode.mutate({ email, code: value });
  }

  const footer = (
    <>
      Club staff?{' '}
      <Link to="/login" className="font-medium text-accent hover:underline">
        Sign in
      </Link>
    </>
  );

  if (step === 'email') {
    return (
      <AuthShell
        title="Comedian sign in"
        description="Enter the email the club has for you and we'll send you a sign-in code."
        documentTitle="Sign in"
        footer={footer}
      >
        <form onSubmit={submitEmail} className="space-y-4">
          <Field label="Email">
            <Input
              type="email"
              inputMode="email"
              autoComplete="email"
              autoFocus
              required
              className="h-11"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <FormError>{requestCode.error ? errorMessage(requestCode.error) : null}</FormError>
          <Button type="submit" size="lg" className="w-full" loading={requestCode.isPending}>
            Send me a code
          </Button>
        </form>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Check your email"
      description={
        <>
          If <strong className="font-medium text-fg">{email}</strong> is on the club's list, we just sent it a
          6-digit code. It expires in 10 minutes.
        </>
      }
      documentTitle="Enter your code"
      footer={footer}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submitCode(code);
        }}
        className="space-y-4"
      >
        <Field label="6-digit code">
          <Input
            autoFocus
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={12}
            className="h-12 text-center font-mono text-2xl tracking-[0.4em]"
            value={code}
            onChange={(e) => {
              const digits = e.target.value.replace(/\D/g, '').slice(0, 6);
              setCode(digits);
              submitCode(digits);
            }}
          />
        </Field>
        <FormError>{verifyCode.error ? errorMessage(verifyCode.error) : null}</FormError>
        <Button type="submit" size="lg" className="w-full" loading={verifyCode.isPending} disabled={code.length !== 6}>
          Sign in
        </Button>
        <div className="flex items-center justify-between text-sm">
          <Button variant="link" onClick={() => setStep('email')}>
            <ArrowLeft /> Different email
          </Button>
          <Button
            variant="link"
            disabled={cooldown > 0 || requestCode.isPending}
            onClick={() => requestCode.mutate({ email })}
          >
            {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend code'}
          </Button>
        </div>
      </form>
    </AuthShell>
  );
}
