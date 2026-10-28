/**
 * Email templates. Every template returns `{ subject, html, text }`; always include a
 * plain-text alternative. Feature emails (availability requests, confirmations) live in
 * `featureTemplates.ts` (F5) and reuse `renderEmailLayout`, `emailButton`, `escapeHtml`.
 */

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]!);
}

/** First name for greetings: "John Mulaney" → "John". */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

const COLORS = {
  accent: '#4f46e5',
  text: '#18181b',
  muted: '#71717a',
  border: '#e4e4e7',
  bg: '#f4f4f5',
  card: '#ffffff',
};

/** A bulletproof (table-based) call-to-action button. `href` must be absolute. */
export function emailButton(href: string, label: string): string {
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:24px 0">
  <tr><td style="border-radius:8px;background:${COLORS.accent}">
    <a href="${escapeHtml(href)}" target="_blank" style="display:inline-block;padding:12px 22px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px">${escapeHtml(label)}</a>
  </td></tr>
</table>`;
}

/** A paragraph of (already escaped) inline HTML. */
export function emailParagraph(innerHtml: string): string {
  return `<p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:${COLORS.text}">${innerHtml}</p>`;
}

/** Small muted text, e.g. "If you didn't ask for this, ignore this email." */
export function emailFinePrint(innerHtml: string): string {
  return `<p style="margin:16px 0 0;font-size:13px;line-height:1.5;color:${COLORS.muted}">${innerHtml}</p>`;
}

export interface EmailLayoutOptions {
  clubName: string;
  /** Inbox preview text (hidden in the body). */
  preheader?: string;
  /** Optional large heading at the top of the card. */
  heading?: string;
  /** Body HTML (escape any user content with `escapeHtml`). */
  bodyHtml: string;
  /** Small text under the card. Defaults to "Sent by <club> via Comedy Booking". */
  footerHtml?: string;
}

/** The shared HTML shell for every email: club name, white card, footer. */
export function renderEmailLayout(options: EmailLayoutOptions): string {
  const club = escapeHtml(options.clubName || 'Comedy Booking');
  const footer = options.footerHtml ?? `Sent by ${club}`;
  const preheader = options.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(options.preheader)}</div>`
    : '';
  const heading = options.heading
    ? `<h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;color:${COLORS.text}">${escapeHtml(options.heading)}</h1>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>${club}</title>
</head>
<body style="margin:0;padding:0;background:${COLORS.bg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
${preheader}
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${COLORS.bg}">
  <tr><td align="center" style="padding:32px 16px">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px">
      <tr><td style="padding:0 4px 14px;font-size:14px;font-weight:700;letter-spacing:.02em;color:${COLORS.text}">${club}</td></tr>
      <tr><td style="background:${COLORS.card};border:1px solid ${COLORS.border};border-radius:12px;padding:28px 28px 24px">
        ${heading}${options.bodyHtml}
      </td></tr>
      <tr><td style="padding:14px 4px 0;font-size:12px;line-height:1.5;color:${COLORS.muted}">${footer}</td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Foundation templates
// ---------------------------------------------------------------------------

export function loginCodeEmail(params: { clubName: string; name: string; code: string }): EmailContent {
  const { clubName, name, code } = params;
  const subject = `${code} is your ${clubName} sign-in code`;
  const html = renderEmailLayout({
    clubName,
    preheader: `Your sign-in code is ${code}. It expires in 10 minutes.`,
    bodyHtml: [
      emailParagraph(`Hey ${escapeHtml(firstName(name))},`),
      emailParagraph('Here is your code to sign in to the comedian portal:'),
      `<div style="margin:20px 0;font-size:32px;font-weight:700;letter-spacing:8px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:${COLORS.text}">${escapeHtml(code)}</div>`,
      emailParagraph('It expires in 10 minutes.'),
      emailFinePrint("If you didn't try to sign in, you can ignore this email."),
    ].join('\n'),
  });
  const text = `Hey ${firstName(name)},

Your ${clubName} sign-in code is: ${code}

It expires in 10 minutes. If you didn't try to sign in, you can ignore this email.`;
  return { subject, html, text };
}

export function loginLinkEmail(params: { clubName: string; name: string; url: string }): EmailContent {
  const { clubName, name, url } = params;
  const subject = `Your sign-in link for ${clubName}`;
  const html = renderEmailLayout({
    clubName,
    preheader: 'Sign in to mark your availability and see your spots.',
    bodyHtml: [
      emailParagraph(`Hey ${escapeHtml(firstName(name))},`),
      emailParagraph(
        `Use this link to sign in to the ${escapeHtml(clubName)} comedian portal, where you can mark your availability and see your booked spots.`,
      ),
      emailButton(url, 'Open the portal'),
      emailFinePrint(`The link works for 30 days. Or paste it into your browser:<br>${escapeHtml(url)}`),
    ].join('\n'),
  });
  const text = `Hey ${firstName(name)},

Use this link to sign in to the ${clubName} comedian portal, where you can mark your availability and see your booked spots:

${url}

The link works for 30 days.`;
  return { subject, html, text };
}

export function bookerInviteEmail(params: {
  clubName: string;
  name: string;
  inviterName: string;
  url: string;
}): EmailContent {
  const { clubName, name, inviterName, url } = params;
  const subject = `${inviterName} invited you to book shows at ${clubName}`;
  const html = renderEmailLayout({
    clubName,
    preheader: `Set a password to start booking at ${clubName}.`,
    bodyHtml: [
      emailParagraph(`Hi ${escapeHtml(firstName(name))},`),
      emailParagraph(
        `${escapeHtml(inviterName)} invited you to help book shows at <strong>${escapeHtml(clubName)}</strong>. Set a password to get started.`,
      ),
      emailButton(url, 'Accept invite'),
      emailFinePrint(`This invite expires in 7 days. Or paste this link into your browser:<br>${escapeHtml(url)}`),
    ].join('\n'),
  });
  const text = `Hi ${firstName(name)},

${inviterName} invited you to help book shows at ${clubName}. Set a password to get started:

${url}

This invite expires in 7 days.`;
  return { subject, html, text };
}

export function testEmail(params: { clubName: string; name?: string }): EmailContent {
  const { clubName, name } = params;
  const subject = `Test email from ${clubName}`;
  const greeting = name ? `Hi ${firstName(name)},` : 'Hi,';
  const html = renderEmailLayout({
    clubName,
    heading: 'Email is working 🎉',
    bodyHtml: [
      emailParagraph(escapeHtml(greeting)),
      emailParagraph(
        `This is a test email from ${escapeHtml(clubName)}. If you're reading it, sign-in codes, availability requests and confirmations will reach your comedians.`,
      ),
    ].join('\n'),
  });
  const text = `${greeting}

This is a test email from ${clubName}. If you're reading it, sign-in codes, availability requests and confirmations will reach your comedians.`;
  return { subject, html, text };
}
