import { useState } from 'react';
import { LOCATION_PALETTE } from '../../../shared/types';
import { cn } from '../../lib/cn';

const SIZES = {
  xs: 'size-5 text-[9px]',
  sm: 'size-7 text-[11px]',
  md: 'size-9 text-xs',
  lg: 'size-14 text-base',
  xl: 'size-24 text-2xl',
} as const;

/** "John Mercer" → "JM", "Cher" → "C". */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]![0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]![0] ?? '') : '';
  return (first + last).toUpperCase();
}

function colorFor(name: string): string {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return LOCATION_PALETTE[Math.abs(hash) % LOCATION_PALETTE.length]!;
}

export interface AvatarProps {
  name: string;
  /** Headshot URL; falls back to initials when empty or broken. */
  src?: string | null;
  size?: keyof typeof SIZES;
  className?: string;
}

export function Avatar({ name, src, size = 'md', className }: AvatarProps) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const showImage = Boolean(src) && failedSrc !== src;
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold text-white select-none',
        SIZES[size],
        className,
      )}
      style={showImage ? undefined : { backgroundColor: colorFor(name) }}
      aria-hidden={showImage ? undefined : true}
    >
      {showImage ? (
        <img
          src={src!}
          alt={name}
          className="size-full object-cover"
          referrerPolicy="no-referrer"
          onError={() => setFailedSrc(src ?? null)}
        />
      ) : (
        initials(name)
      )}
    </span>
  );
}
