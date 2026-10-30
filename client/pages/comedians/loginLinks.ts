/**
 * Copy for "Email them a sign-in link" results (Add comedian, Bulk add, the roster's bulk
 * "Send sign-in link"). Pure; unit-tested in loginLinks.test.ts.
 */
import type { BulkLoginLinkResult, LoginLinkResult } from '../../../shared/api/comedians';

export interface LinkToast {
  tone: 'success' | 'info' | 'warning';
  title: string;
  description?: string;
}

function n(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Where outbox emails can be found (`count` of them); the email log is admin-only. */
export function outboxHint(isAdmin: boolean, count = 1): string {
  const [it, them] = count === 1 ? ["it's", 'it'] : ["they're", 'them'];
  return isAdmin
    ? `Email isn't set up yet, so ${it} in the outbox (Settings → Email log).`
    : `Email isn't set up yet, so ${it} in the outbox. An admin can find ${them} under Settings → Email log.`;
}

/** After adding one comedian (with or without the invite). */
export function addedToast(name: string, email: string, link: LoginLinkResult | null, isAdmin: boolean): LinkToast {
  if (!link) return { tone: 'success', title: `Added ${name}` };
  if (link.status === 'sent') return { tone: 'success', title: `Added ${name}`, description: `Sign-in link sent to ${email}.` };
  if (link.status === 'outbox') return { tone: 'success', title: `Added ${name}`, description: outboxHint(isAdmin) };
  return {
    tone: 'warning',
    title: `Added ${name}, but the sign-in email failed`,
    description: link.error ?? 'Try "Send sign-in link" on their profile.',
  };
}

/** After emailing sign-in links to several comedians. `lead` is the main fact ("Added 12 comedians"). */
export function bulkLinksToast(lead: string | null, result: BulkLoginLinkResult, isAdmin: boolean): LinkToast {
  const emailed = result.sent + result.outbox;
  const parts: string[] = [];
  if (result.skipped) parts.push(`Skipped ${n(result.skipped, 'archived comedian')}.`);
  if (result.outbox) parts.push(outboxHint(isAdmin, result.outbox));
  if (result.failed) {
    return {
      tone: 'warning',
      title: lead ?? `Sent ${n(emailed, 'sign-in link')}; ${result.failed} failed`,
      description: [lead ? `Sent ${n(emailed, 'sign-in link')}; ${result.failed} failed.` : null, ...parts, 'Check Settings → Email.']
        .filter(Boolean)
        .join(' '),
    };
  }
  if (emailed === 0) {
    return { tone: 'info', title: lead ?? 'No sign-in links sent', description: parts.join(' ') || undefined };
  }
  const sentLine = `Sent ${n(emailed, 'sign-in link')}`;
  return {
    tone: 'success',
    title: lead ?? sentLine,
    description: [lead ? `${sentLine}.` : null, ...parts].filter(Boolean).join(' ') || undefined,
  };
}
