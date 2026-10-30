import { describe, expect, it } from 'vitest';
import { addedToast, bulkLinksToast, outboxHint } from './loginLinks';

describe('sign-in link toasts (ux#A6)', () => {
  it('describes one invite', () => {
    expect(addedToast('Jason Lee', 'jason@example.com', null, true)).toEqual({ tone: 'success', title: 'Added Jason Lee' });
    expect(addedToast('Jason Lee', 'jason@example.com', { status: 'sent' }, true)).toEqual({
      tone: 'success',
      title: 'Added Jason Lee',
      description: 'Sign-in link sent to jason@example.com.',
    });
    expect(addedToast('Jason Lee', 'jason@example.com', { status: 'outbox' }, false).description).toBe(outboxHint(false));
    expect(addedToast('Jason Lee', 'jason@example.com', { status: 'failed', error: 'SMTP down' }, true)).toEqual({
      tone: 'warning',
      title: 'Added Jason Lee, but the sign-in email failed',
      description: 'SMTP down',
    });
  });

  it('summarizes a batch', () => {
    expect(bulkLinksToast(null, { sent: 3, outbox: 0, failed: 0, skipped: 0 }, true)).toEqual({
      tone: 'success',
      title: 'Sent 3 sign-in links',
      description: undefined,
    });
    expect(bulkLinksToast(null, { sent: 0, outbox: 1, failed: 0, skipped: 2 }, true)).toEqual({
      tone: 'success',
      title: 'Sent 1 sign-in link',
      description: `Skipped 2 archived comedians. ${outboxHint(true)}`,
    });
    expect(bulkLinksToast('Added 4 comedians', { sent: 3, outbox: 0, failed: 1, skipped: 0 }, true)).toEqual({
      tone: 'warning',
      title: 'Added 4 comedians',
      description: 'Sent 3 sign-in links; 1 failed. Check Settings → Email.',
    });
    expect(bulkLinksToast(null, { sent: 0, outbox: 0, failed: 0, skipped: 1 }, true)).toEqual({
      tone: 'info',
      title: 'No sign-in links sent',
      description: 'Skipped 1 archived comedian.',
    });
  });
});
