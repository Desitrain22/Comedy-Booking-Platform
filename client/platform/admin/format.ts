/** Display helpers for the owner console. */
import type {
  AdminClubStats,
  AdminClubStatus,
  AdminEmailVia,
  AdminEventAction,
} from '../../../shared/api/platformAdmin';
import { formatRelative } from '../../../shared/time';
import type { BadgeVariant } from '../../components/ui';

export const STATUS_LABEL: Record<AdminClubStatus, string> = {
  active: 'Active',
  suspended: 'Suspended',
  archived: 'Archived',
};

export const STATUS_BADGE: Record<AdminClubStatus, BadgeVariant> = {
  active: 'success',
  suspended: 'warning',
  archived: 'neutral',
};

export const EVENT_LABEL: Record<AdminEventAction, string> = {
  suspend: 'Suspended',
  reactivate: 'Reactivated',
  archive: 'Archived',
  restore: 'Restored',
  backup_download: 'Backup downloaded',
};

export const VIA_LABEL: Record<AdminEmailVia, string> = {
  '': 'Unknown',
  'company-mailbox': 'Company mailbox',
  'booker-mailbox': 'Booker mailbox',
  platform: 'Platform sender',
  outbox: 'Outbox',
};

/** "Nov 4, 2026" */
export function formatDay(ms: number): string {
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' }).format(ms);
}

/** "Nov 4, 2026, 12:00 PM" */
export function formatDateTime(ms: number): string {
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(ms);
}

/** "3d ago", or "Never". */
export function formatAgo(ms: number | null | undefined): string {
  return ms ? formatRelative(ms) : 'Never';
}

/** "Week of Nov 2" from a `YYYY-MM-DD` Monday. */
export function formatWeek(weekStart: string): string {
  const [y, m, d] = weekStart.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(
    Date.UTC(y!, m! - 1, d!),
  );
}

/** 1536 → "1.5 KB" */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** "Company · own mailbox", "Each booker · 2 booker mailboxes", "Company · platform sender" */
export function senderLabel(stats: AdminClubStats): string {
  const mode = stats.senderMode === 'booker' ? 'Each booker' : 'Company';
  const mailboxes: string[] = [];
  if (stats.companyMailbox) mailboxes.push('own mailbox');
  if (stats.bookerMailboxes) mailboxes.push(`${stats.bookerMailboxes} booker mailbox${stats.bookerMailboxes === 1 ? '' : 'es'}`);
  return `${mode} · ${mailboxes.length ? mailboxes.join(', ') : 'platform sender'}`;
}
