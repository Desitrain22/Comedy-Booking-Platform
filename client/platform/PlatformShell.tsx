/**
 * The centered-card page of the platform site and of the full-page club states (paused, no
 * club). Like AuthShell, but it never asks the club API who is signed in: on these hosts
 * there is no club to ask.
 */
import { MicVocal } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { cn } from '../lib/cn';

export interface PlatformShellProps {
  /** Shown above the card: the platform name, or the club's name on its own host. */
  brand: string;
  /** Where the brand links to (e.g. the landing page); plain text when omitted. */
  brandHref?: string;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** Small print under the card. */
  footer?: ReactNode;
  /** Browser tab title (defaults to `title` when it is a string), followed by the brand. */
  documentTitle?: string;
  /** Card width; default `max-w-sm`. */
  className?: string;
  /** An icon in a tinted circle above the title. */
  icon?: ReactNode;
}

export function usePlatformTitle(title: string | undefined, brand: string): void {
  useEffect(() => {
    document.title = [title, brand].filter(Boolean).join(' · ');
  }, [title, brand]);
}

export function Brand({ name, href }: { name: string; href?: string }) {
  const content = (
    <>
      <span className="flex size-8 items-center justify-center rounded-lg bg-accent-solid text-accent-solid-fg">
        <MicVocal className="size-4" aria-hidden />
      </span>
      <span className="text-base font-semibold">{name}</span>
    </>
  );
  return href ? (
    <a href={href} className="flex items-center justify-center gap-2 text-fg">
      {content}
    </a>
  ) : (
    <div className="flex items-center justify-center gap-2 text-fg">{content}</div>
  );
}

export function PlatformShell({
  brand,
  brandHref,
  title,
  description,
  children,
  footer,
  documentTitle,
  className,
  icon,
}: PlatformShellProps) {
  usePlatformTitle(documentTitle ?? (typeof title === 'string' ? title : undefined), brand);
  return (
    <div className="flex min-h-dvh flex-col items-center px-4 py-10 sm:justify-center sm:py-16">
      <div className={cn('w-full max-w-sm', className)}>
        <div className="mb-6">
          <Brand name={brand} href={brandHref} />
        </div>
        <div className="rounded-xl border border-border bg-surface p-6 shadow-sm">
          {icon && (
            <div className="mb-4 flex size-10 items-center justify-center rounded-full bg-accent-soft text-accent [&_svg]:size-5">
              {icon}
            </div>
          )}
          <h1 className="text-lg font-semibold tracking-tight text-fg">{title}</h1>
          {description && <p className="mt-1 text-sm text-fg-muted">{description}</p>}
          {children && <div className="mt-5">{children}</div>}
        </div>
        {footer && <div className="mt-6 text-center text-sm text-fg-muted">{footer}</div>}
      </div>
    </div>
  );
}
