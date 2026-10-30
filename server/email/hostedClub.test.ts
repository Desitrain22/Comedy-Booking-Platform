/**
 * Email for a hosted club, end to end through a real hosted test app (host routing, the
 * registry and its tagged club databases): the platform sender as the club, the per-club
 * daily cap, and the SMTP host guard. `env.hosted` stays null, as it does in every hosted
 * test app: all of this follows the club database's hosting info.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CreateAvailabilityRequestResponse } from '../../shared/api/dashboard';
import type { SettingsDto } from '../../shared/api/settings';
import { env } from '../env';
import { PLATFORM_SMTP, TEST_APP_SECRET, captureMail, resolveSmtpHosts, restoreEnv, setEnv } from '../test/emailEnv';
import { makeHostedTestApp, type HostedTestApp } from '../test/hosted';
import { createComedian, emailsTo, readJson } from '../test/helpers';

let h: HostedTestApp;

beforeEach(() => {
  // The platform sender is the server's SMTP_* config, as in production.
  setEnv({ hosted: null, smtp: PLATFORM_SMTP, appSecret: TEST_APP_SECRET });
  h = makeHostedTestApp({ hosted: { dailyEmailCap: 2 } });
});

afterEach(() => {
  restoreEnv();
  h.close();
});

function requestAvailability(slug: string, headers: { cookie: string }) {
  return h.request(h.clubUrl(slug, '/api/availability-requests'), {
    method: 'POST',
    headers,
    json: { month: '2026-12', audience: 'all' },
  });
}

describe('a hosted club', () => {
  it('sends through the platform sender as the club, up to its own daily cap', async () => {
    expect(env.hosted).toBeNull();
    const sent = captureMail();
    const { db } = h.createClub({
      slug: 'broadway',
      name: 'Broadway Comedy',
      admin: { name: 'Rich Brooks', email: 'rich@bwaygroup.test' },
    });
    const { headers } = h.loginAsBooker('broadway');
    for (let i = 0; i < 3; i++) createComedian(db, { name: `Comic ${i}`, email: `comic${i}@example.test` });

    const res = await requestAvailability('broadway', headers);
    expect(res.status).toBe(201);
    expect(await readJson<CreateAvailabilityRequestResponse>(res)).toMatchObject({ recipientCount: 3, sent: 2, failed: 1 });

    // The club's name at the platform's address; replies reach the club's first admin, and
    // the platform's own From name and Reply-To never show.
    expect(sent).toHaveLength(2);
    for (const mail of sent) {
      expect(mail).toMatchObject({
        from: '"Broadway Comedy" <bookings@mail.platform.test>',
        replyTo: 'rich@bwaygroup.test',
        server: { host: PLATFORM_SMTP.host },
      });
      expect(String(mail.text)).toContain('http://broadway.localhost:3000/portal/magic/');
    }
    // (The capped one is logged first: it's refused while the other two are still in flight.)
    const rows = emailsTo(db);
    expect(rows.map((r) => `${r.status} via ${r.via}`).sort()).toEqual([
      'failed via platform',
      'sent via platform',
      'sent via platform',
    ]);
    expect(rows.find((r) => r.status === 'failed')?.error).toBe('Daily email limit reached (2 per day) — contact support');

    const settings = await readJson<SettingsDto>(await h.request(h.clubUrl('broadway', '/api/settings'), { headers }));
    expect(settings).toMatchObject({
      emailConfigured: true,
      emailSource: 'platform',
      platformSender: { name: 'Comedy Booking', fromEmail: PLATFORM_SMTP.fromEmail },
      senderPreview: { fromName: 'Broadway Comedy', replyTo: 'rich@bwaygroup.test' },
      appUrlLocked: true,
    });

    // The cap is per club: another club on the same server still sends.
    const cellar = h.createClub({ slug: 'cellar', name: 'The Cellar' });
    const cellarBooker = h.loginAsBooker('cellar');
    createComedian(cellar.db, { email: 'cellar-comic@example.test' });
    const other = await requestAvailability('cellar', cellarBooker.headers);
    expect(await readJson(other)).toMatchObject({ recipientCount: 1, sent: 1, failed: 0 });
    expect(sent.at(-1)?.from).toBe('"The Cellar" <bookings@mail.platform.test>');
  });

  it('refuses mailbox hosts inside our network, on save and when sending', async () => {
    const sent = captureMail();
    h.createClub({ slug: 'broadway', name: 'Broadway Comedy' });
    const { headers } = h.loginAsBooker('broadway');
    const mailbox = (smtpHost: string) => ({ smtpHost, smtpPort: 587, smtpSecure: false, smtpUser: 'me@bwaygroup.test', smtpPass: 'x' });

    for (const url of ['/api/settings', '/api/me/mailbox']) {
      const res = await h.request(h.clubUrl('broadway', url), { method: 'PUT', headers, json: mailbox('127.0.0.1') });
      expect(res.status, url).toBe(400);
      expect(await readJson(res), url).toMatchObject({ code: 'smtp_host_not_allowed' });
    }

    // A name that resolves inside the network saves, but never gets a connection.
    resolveSmtpHosts({ 'smtp.sneaky.test': ['10.0.0.8'] });
    const saved = await h.request(h.clubUrl('broadway', '/api/settings'), { method: 'PUT', headers, json: mailbox('smtp.sneaky.test') });
    expect(saved.status).toBe(200);
    const test = await h.request(h.clubUrl('broadway', '/api/settings/test-email'), { method: 'POST', headers, json: {} });
    expect(test.status).toBe(502);
    expect(await readJson(test)).toMatchObject({ smtpError: expect.stringContaining('private network address (10.0.0.8)') });
    expect(sent).toHaveLength(0);
  });
});
