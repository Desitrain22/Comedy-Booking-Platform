import { MicVocal } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn';
import { usePageTitle } from '../lib/usePageTitle';
import { useClub } from '../lib/useMe';

export interface AuthShellProps {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  /** Small print under the card (links like "Club staff? Sign in"). */
  footer?: ReactNode;
  /** Browser tab title (defaults to `title` when it is a string). */
  documentTitle?: string;
  /** Card width; default `max-w-sm`. */
  className?: string;
}

/**
 * Centered card for sign-in style pages (setup, booker login, accept invite, portal login,
 * magic link). Shows the club name above the card. Mobile-first.
 */
export function AuthShell({ title, description, children, footer, documentTitle, className }: AuthShellProps) {
  const clubName = useClub()?.name;
  usePageTitle(documentTitle ?? (typeof title === 'string' ? title : undefined));
  return (
    <div className="flex min-h-dvh flex-col items-center px-4 py-10 sm:justify-center sm:py-16">
      <div className={cn('w-full max-w-sm', className)}>
        <div className="mb-6 flex items-center justify-center gap-2 text-fg">
          <span className="flex size-8 items-center justify-center rounded-lg bg-accent-solid text-accent-solid-fg">
            <MicVocal className="size-4" aria-hidden />
          </span>
          <span className="text-base font-semibold">{clubName || 'Comedy Booking'}</span>
        </div>
        <div className="rounded-xl border border-border bg-surface p-6 shadow-sm">
          <h1 className="text-lg font-semibold tracking-tight text-fg">{title}</h1>
          {description && <p className="mt-1 text-sm text-fg-muted">{description}</p>}
          <div className="mt-5">{children}</div>
        </div>
        {footer && <div className="mt-6 text-center text-sm text-fg-muted">{footer}</div>}
      </div>
    </div>
  );
}

/** Inline error box for forms. */
export function FormError({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger">
      {children}
    </p>
  );
}
