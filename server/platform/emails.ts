/**
 * Platform email templates (hosted mode). Same HTML shell as the club emails
 * (server/email/templates.ts), signed by the platform instead of a club.
 */
import {
  emailFinePrint,
  emailParagraph,
  escapeHtml,
  renderEmailLayout,
  type EmailContent,
} from '../email/templates';

export interface SignupNoticeParams {
  platformName: string;
  platformUrl: string;
  clubName: string;
  /** `broadway.comedybook.app` */
  clubHost: string;
  clubUrl: string;
  ownerName: string;
  ownerEmail: string;
  timezone: string;
  locationName: string;
}

/** To each PLATFORM_ADMIN_EMAILS address when a club signs up. */
export function signupNoticeEmail(p: SignupNoticeParams): EmailContent {
  const subject = `New club: ${p.clubName} — ${p.clubHost} — ${p.ownerName} <${p.ownerEmail}>`;
  const consoleUrl = `${p.platformUrl}/admin`;
  const text = [
    `A new club just signed up on ${p.platformName}.`,
    '',
    `Club:      ${p.clubName}`,
    `Address:   ${p.clubUrl}`,
    `Booker:    ${p.ownerName} <${p.ownerEmail}>`,
    `Timezone:  ${p.timezone}`,
    `Location:  ${p.locationName}`,
    '',
    `Suspend or archive it from the owner console: ${consoleUrl}`,
  ].join('\n');
  const rows: [string, string][] = [
    ['Club', escapeHtml(p.clubName)],
    ['Address', `<a href="${escapeHtml(p.clubUrl)}">${escapeHtml(p.clubHost)}</a>`],
    ['Booker', `${escapeHtml(p.ownerName)} &lt;${escapeHtml(p.ownerEmail)}&gt;`],
    ['Timezone', escapeHtml(p.timezone)],
    ['Location', escapeHtml(p.locationName)],
  ];
  const table = `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 14px;font-size:15px;line-height:1.55">${rows
    .map(
      ([label, value]) =>
        `<tr><td style="padding:2px 16px 2px 0;color:#71717a;vertical-align:top">${label}</td><td style="padding:2px 0">${value}</td></tr>`,
    )
    .join('')}</table>`;
  const html = renderEmailLayout({
    clubName: p.platformName,
    preheader: `${p.clubName} (${p.clubHost}) just signed up.`,
    heading: 'A new club signed up',
    bodyHtml: [
      table,
      emailFinePrint(
        `Suspend or archive it from the <a href="${escapeHtml(consoleUrl)}">owner console</a>.`,
      ),
    ].join('\n'),
    footerHtml: `Sent by ${escapeHtml(p.platformName)}`,
  });
  return { subject, html, text };
}

export interface FoundClub {
  clubName: string;
  clubUrl: string;
  /** Has a booker account (with a password) there. */
  booker: boolean;
  /** Is an active comedian there. */
  comedian: boolean;
}

/** "Find my club": every active club where this address is a booker or a comedian. */
export function findClubEmail(p: { platformName: string; email: string; clubs: FoundClub[] }): EmailContent {
  const subject = `Your clubs on ${p.platformName}`;
  const links = (club: FoundClub) => {
    const out: { label: string; url: string }[] = [];
    if (club.booker) out.push({ label: 'Booker sign-in', url: `${club.clubUrl}/login` });
    if (club.comedian) out.push({ label: 'Comedian sign-in', url: `${club.clubUrl}/portal/login` });
    return out;
  };
  const text = [
    `Here ${p.clubs.length === 1 ? 'is the club' : 'are the clubs'} where ${p.email} has an account:`,
    '',
    ...p.clubs.flatMap((club) => [club.clubName, ...links(club).map((l) => `  ${l.label}: ${l.url}`), '']),
    "If you didn't ask for this, you can ignore this email.",
  ].join('\n');
  const list = p.clubs
    .map(
      (club) =>
        `<li style="margin:0 0 12px"><strong>${escapeHtml(club.clubName)}</strong><br>${links(club)
          .map((l) => `<a href="${escapeHtml(l.url)}">${escapeHtml(l.label)}</a>`)
          .join(' · ')}</li>`,
    )
    .join('');
  const html = renderEmailLayout({
    clubName: p.platformName,
    preheader: `Sign-in links for ${p.email}`,
    heading: p.clubs.length === 1 ? 'Your club' : 'Your clubs',
    bodyHtml: [
      emailParagraph(`Here ${p.clubs.length === 1 ? 'is the club' : 'are the clubs'} where ${escapeHtml(p.email)} has an account:`),
      `<ul style="margin:0 0 14px;padding-left:20px;font-size:15px;line-height:1.55">${list}</ul>`,
      emailFinePrint("If you didn't ask for this, you can ignore this email."),
    ].join('\n'),
    footerHtml: `Sent by ${escapeHtml(p.platformName)}`,
  });
  return { subject, html, text };
}
