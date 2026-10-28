import { LoaderCircle } from 'lucide-react';
import { cn } from '../../lib/cn';

export function Spinner({ className, label = 'Loading' }: { className?: string; label?: string }) {
  return <LoaderCircle role="status" aria-label={label} className={cn('size-5 animate-spin text-fg-muted', className)} />;
}

/** Centered spinner for a whole page or panel while data loads. */
export function PageSpinner({ className }: { className?: string }) {
  return (
    <div className={cn('flex min-h-48 flex-1 items-center justify-center p-8', className)}>
      <Spinner className="size-6" />
    </div>
  );
}
