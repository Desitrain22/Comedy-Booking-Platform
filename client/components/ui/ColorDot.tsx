import { cn } from '../../lib/cn';

export interface ColorDotProps {
  /** Hex color (location or tag color). */
  color: string;
  size?: 'xs' | 'sm' | 'md';
  className?: string;
  /** Accessible name, when the color carries meaning on its own. */
  label?: string;
}

const SIZES = { xs: 'size-1.5', sm: 'size-2', md: 'size-3' } as const;

export function ColorDot({ color, size = 'sm', className, label }: ColorDotProps) {
  return (
    <span
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn('inline-block shrink-0 rounded-full', SIZES[size], className)}
      style={{ backgroundColor: color }}
    />
  );
}
