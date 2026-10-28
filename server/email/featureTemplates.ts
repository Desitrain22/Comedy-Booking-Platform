/**
 * Feature emails (F5): availability requests / reminders and the weekly confirmation.
 * Built on the foundation's layout helpers; every template returns
 * `{ subject, html, text }` with a plain-text alternative.
 */
import { formatDateMedium, formatDateShort, formatMonthName, formatTime } from '../../shared/time';
import type { AvailabilityRequestKind } from '../../shared/types';
import {
  emailButton,
  emailFinePrint,
  emailParagraph,
  escapeHtml,
  firstName,
  renderEmailLayout,
  type EmailContent,
} from './templates';

const TEXT = '#18181b';
const MUTED = '#71717a';
const BORDER = '#e4e4e7';
const SOFT = '#f4f4f5';
const CONFIRMED = '#047857';
const ACCENT = '#4f46e5';

/** Escaped, with line breaks kept. */
function multiline(value: string): string {
  return escapeHtml(value).replace(/\r?\n/g, '<br>');
}

/** The booker's personal note, set off as a quote. */
function noteBlock(message: string): string {
  return `<div style="margin:4px 0 18px;padding:12px 14px;border-left:3px solid ${BORDER};background:${SOFT};border-radius:0 8px 8px 0;font-size:15px;line-height:1.55;color:${TEXT}">${multiline(message)}</div>`;
}

/** A large, full-width (on phones) call to action for the weekly confirmation. */
function bigButton(href: string, label: string): string {
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:24px 0 20px">
  <tr><td align="center" style="border-radius:10px;background:${ACCENT}">
    <a href="${escapeHtml(href)}" target="_blank" style="display:block;padding:16px 24px;font-size:17px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:10px;text-align:center">${escapeHtml(label)}</a>
  </td></tr>
</table>`;
}

// ---------------------------------------------------------------------------
// Availability request / reminder
// ---------------------------------------------------------------------------

export interface AvailabilityRequestEmailParams {
  clubName: string;
  /** The comedian's name ("John Mercer"). */
  name: string;
  /** `YYYY-MM` being booked. */
  month: string;
  /** Magic link that signs them in and opens `/portal?month=YYYY-MM`. */
  url: string;
  /** Optional personal note from the booker. */
  message?: string;
  kind?: AvailabilityRequestKind;
}

export function availabilityRequestEmail(params: AvailabilityRequestEmailParams): EmailContent {
  const { clubName, name, month, url, kind = 'request' } = params;
  const message = params.message?.trim() ?? '';
  const monthName = formatMonthName(month);
  const first = firstName(name);
  const reminder = kind === 'reminder';

  const subject = reminder
    ? `Reminder: when are you free in ${monthName}?`
    : `${clubName} is booking ${monthName} — when are you free?`;
  const lead = reminder
    ? `Hey ${first} — quick reminder: ${clubName} is booking ${monthName} and we don't have your availability yet. Tell us which nights you're free:`
    : `Hey ${first} — ${clubName} is booking ${monthName}. Tell us which nights you're free:`;
  const preheader = reminder
    ? `We still need your ${monthName} availability. It takes a minute.`
    : `Tap the nights you're free in ${monthName}, then Save.`;

  const html = renderEmailLayout({
    clubName,
    preheader,
    bodyHtml: [
      emailParagraph(escapeHtml(lead)),
      message ? noteBlock(message) : '',
      emailButton(url, 'Mark my availability'),
      emailParagraph(
        `<span style="color:${MUTED}">Tap the nights you're free, then Save. Nights you leave blank count as not available.</span>`,
      ),
      emailFinePrint(
        `The button signs you in automatically and works for 30 days. Or paste this link into your browser:<br>${escapeHtml(url)}`,
      ),
    ]
      .filter(Boolean)
      .join('\n'),
  });

  const text = [
    lead,
    message ? `\n${message}` : '',
    `\nMark my availability: ${url}`,
    `\nTap the nights you're free, then Save. Nights you leave blank count as not available.`,
    `The link signs you in automatically and works for 30 days.`,
  ]
    .filter(Boolean)
    .join('\n');

  return { subject, html, text };
}

// ---------------------------------------------------------------------------
// Weekly confirmation
// ---------------------------------------------------------------------------

export interface ConfirmationSpot {
  date: string;
  startMin: number;
  locationName: string;
  locationAddress: string;
  showName: string;
  /** Already confirmed (shown with a check, still listed). */
  confirmed: boolean;
}

export interface ConfirmationEmailParams {
  clubName: string;
  name: string;
  /** Every scheduled spot that week, in date/time order. */
  spots: ConfirmationSpot[];
  /** Absolute confirm link (`/portal/confirm/<token>`). */
  url: string;
  /** "this week" | "next week" | "the week of Mon, Nov 9". */
  weekPhrase: string;
}

/** "9 PM · Late Show" (or just "9 PM"). */
function spotTitle(spot: ConfirmationSpot): string {
  const time = formatTime(spot.startMin);
  return spot.showName ? `${time} · ${spot.showName}` : time;
}

function spotWhere(spot: ConfirmationSpot): string {
  return spot.locationAddress ? `${spot.locationName}, ${spot.locationAddress}` : spot.locationName;
}

function spotRowHtml(spot: ConfirmationSpot, last: boolean): string {
  const border = last ? '' : `border-bottom:1px solid ${BORDER};`;
  const [weekday, ...rest] = formatDateMedium(spot.date).split(', ');
  const status = spot.confirmed
    ? `<div style="margin-top:4px;font-size:12px;font-weight:600;color:${CONFIRMED}">&#10003; Confirmed</div>`
    : '';
  return `<tr>
  <td valign="top" style="${border}padding:12px 14px 12px 0;width:64px;white-space:nowrap">
    <div style="font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:${MUTED}">${escapeHtml(weekday ?? '')}</div>
    <div style="font-size:15px;font-weight:700;color:${TEXT}">${escapeHtml(rest.join(', '))}</div>
  </td>
  <td valign="top" style="${border}padding:12px 0">
    <div style="font-size:15px;font-weight:600;color:${TEXT}">${escapeHtml(spotTitle(spot))}</div>
    <div style="margin-top:2px;font-size:14px;line-height:1.45;color:${MUTED}">${escapeHtml(spotWhere(spot))}</div>
    ${status}
  </td>
</tr>`;
}

export function confirmationEmail(params: ConfirmationEmailParams): EmailContent {
  const { clubName, name, spots, url, weekPhrase } = params;
  const first = firstName(name);
  const count = spots.length;
  const spotsWord = count === 1 ? 'spot' : 'spots';
  const subject = `Please confirm your ${spotsWord} ${weekPhrase} at ${clubName}`;
  const lead = `you're booked for ${count === 1 ? 'this spot' : 'these spots'} ${weekPhrase}. Please click to confirm.`;

  const firstSpot = spots[0];
  const preheader = firstSpot
    ? `${formatDateShort(firstSpot.date)}, ${formatTime(firstSpot.startMin)} at ${firstSpot.locationName}${
        count > 1 ? ` and ${count - 1} more` : ''
      }. Tap to confirm.`
    : 'Tap to confirm your spots.';

  const table = `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:8px 0 4px;border-top:1px solid ${BORDER};border-bottom:1px solid ${BORDER}">
${spots.map((spot, i) => spotRowHtml(spot, i === spots.length - 1)).join('\n')}
</table>`;

  const html = renderEmailLayout({
    clubName,
    preheader,
    bodyHtml: [
      emailParagraph(`Hey ${escapeHtml(first)}, ${escapeHtml(lead)}`),
      table,
      bigButton(url, 'Confirm my spots'),
      emailParagraph(`<strong>Can't make one?</strong> Reply to this email.`),
      emailFinePrint(`Or paste this link into your browser:<br>${escapeHtml(url)}`),
    ].join('\n'),
  });

  const lines = spots.map((spot) => {
    const check = spot.confirmed ? ' (confirmed)' : '';
    return `• ${formatDateMedium(spot.date)} — ${spotTitle(spot)}${check}\n  ${spotWhere(spot)}`;
  });
  const text = `Hey ${first}, ${lead}

${lines.join('\n\n')}

Confirm my spots: ${url}

Can't make one? Reply to this email.`;

  return { subject, html, text };
}
