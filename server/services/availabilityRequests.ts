/**
 * Availability requests (spec §6 F5): blast "tell us which nights you're free" emails
 * for a month to everyone or a tag, and reminders to the ones who haven't submitted.
 * Each email carries a magic link that signs the comedian in and opens
 * `/portal?month=YYYY-MM`. Every send is recorded in email_log; each blast in
 * availability_requests. The booker who sent it is the email's sender (hosted MVP spec §5):
 * with senderMode `booker` it comes from them and replies go to them.
 */
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import {
  parseAudience,
  type AudienceProgress,
  type AvailabilityRequestPreview,
  type AvailabilityRequestSummary,
  type CreateAvailabilityRequestResponse,
  type MonthAvailabilityProgress,
} from '../../shared/api/dashboard';
import type { AvailabilityAudience, AvailabilityRequestKind } from '../../shared/types';
import { createLoginLink } from '../auth/tokens';
import type { Db, DbOrTx } from '../db/client';
import {
  availabilityRequests,
  availabilitySubmissions,
  comedianTags,
  comedians,
  tags,
  users,
  type AvailabilityRequest,
} from '../db/schema';
import { availabilityRequestEmail } from '../email/featureTemplates';
import { sendEmail } from '../email/mailer';
import { httpError } from '../lib/http';
import { absoluteUrl, getSettings } from '../lib/settings';
import { EMAIL_CONCURRENCY, mapWithConcurrency } from './batch';

export const EVERYONE_LABEL = 'Everyone';

export interface AudienceMember {
  id: number;
  name: string;
  email: string;
}

/** Where the magic link lands: the portal's availability page for that month. */
export function availabilityPortalPath(month: string): string {
  return `/portal?month=${month}`;
}

// ---------------------------------------------------------------------------
// Audiences
// ---------------------------------------------------------------------------

/** Non-archived comedians in the audience (by name). 400 `unknown_tag` for a missing tag. */
export function resolveAudience(
  db: DbOrTx,
  audience: AvailabilityAudience,
): { label: string; members: AudienceMember[] } {
  const parsed = parseAudience(audience);
  const columns = { id: comedians.id, name: comedians.name, email: comedians.email };
  if (parsed.kind === 'all') {
    const members = db
      .select(columns)
      .from(comedians)
      .where(eq(comedians.archived, false))
      .orderBy(asc(comedians.name), asc(comedians.id))
      .all();
    return { label: EVERYONE_LABEL, members };
  }
  const tag = db.select({ name: tags.name }).from(tags).where(eq(tags.id, parsed.tagId)).get();
  if (!tag) throw httpError(400, 'That tag no longer exists', 'unknown_tag');
  const members = db
    .select(columns)
    .from(comedians)
    .innerJoin(comedianTags, eq(comedianTags.comedianId, comedians.id))
    .where(and(eq(comedianTags.tagId, parsed.tagId), eq(comedians.archived, false)))
    .orderBy(asc(comedians.name), asc(comedians.id))
    .all();
  return { label: tag.name, members };
}

function submittedIds(db: DbOrTx, month: string): Set<number> {
  return new Set(
    db
      .select({ comedianId: availabilitySubmissions.comedianId })
      .from(availabilitySubmissions)
      .where(eq(availabilitySubmissions.month, month))
      .all()
      .map((r) => r.comedianId),
  );
}

/** Who a request would go to: the audience, minus submitters for a reminder. */
export function availabilityRecipients(
  db: DbOrTx,
  params: { month: string; audience: AvailabilityAudience; kind: AvailabilityRequestKind },
): { label: string; members: AudienceMember[]; recipients: AudienceMember[] } {
  const { label, members } = resolveAudience(db, params.audience);
  if (params.kind !== 'reminder') return { label, members, recipients: members };
  const submitted = submittedIds(db, params.month);
  return { label, members, recipients: members.filter((m) => !submitted.has(m.id)) };
}

// ---------------------------------------------------------------------------
// Request history
// ---------------------------------------------------------------------------

function toSummaries(db: DbOrTx, rows: (AvailabilityRequest & { sentByName: string | null })[]): AvailabilityRequestSummary[] {
  const tagNames = new Map(db.select({ id: tags.id, name: tags.name }).from(tags).all().map((t) => [t.id, t.name]));
  return rows.map((row) => {
    const audience = row.audience as AvailabilityAudience;
    const parsed = parseAudience(audience);
    return {
      id: row.id,
      month: row.month,
      kind: row.kind,
      audience,
      audienceLabel: parsed.kind === 'all' ? EVERYONE_LABEL : (tagNames.get(parsed.tagId) ?? 'Deleted tag'),
      message: row.message,
      recipientCount: row.recipientCount,
      sentAt: row.sentAt,
      sentByName: row.sentByName,
    };
  });
}

function selectRequests(db: DbOrTx, months?: string[]) {
  return db
    .select({
      id: availabilityRequests.id,
      month: availabilityRequests.month,
      kind: availabilityRequests.kind,
      message: availabilityRequests.message,
      audience: availabilityRequests.audience,
      recipientCount: availabilityRequests.recipientCount,
      sentById: availabilityRequests.sentById,
      sentAt: availabilityRequests.sentAt,
      sentByName: users.name,
    })
    .from(availabilityRequests)
    .leftJoin(users, eq(users.id, availabilityRequests.sentById))
    .where(months ? inArray(availabilityRequests.month, months) : undefined)
    .orderBy(desc(availabilityRequests.sentAt), desc(availabilityRequests.id))
    .all();
}

/** Requests and reminders, newest first (optionally for one month). */
export function listAvailabilityRequests(db: DbOrTx, month?: string): AvailabilityRequestSummary[] {
  return toSummaries(db, selectRequests(db, month ? [month] : undefined));
}

// ---------------------------------------------------------------------------
// Progress ("14 of 32 comedians have submitted December")
// ---------------------------------------------------------------------------

export function availabilityProgress(db: DbOrTx, months: string[]): MonthAvailabilityProgress[] {
  const active = db.select({ id: comedians.id }).from(comedians).where(eq(comedians.archived, false)).all();
  const activeIds = new Set(active.map((c) => c.id));
  const allTags = db.select().from(tags).orderBy(asc(tags.name)).all();
  const members = new Map<number, number[]>(allTags.map((t) => [t.id, []]));
  for (const row of db.select().from(comedianTags).all()) {
    if (activeIds.has(row.comedianId)) members.get(row.tagId)?.push(row.comedianId);
  }
  const submissions = months.length
    ? db
        .select({ comedianId: availabilitySubmissions.comedianId, month: availabilitySubmissions.month })
        .from(availabilitySubmissions)
        .where(inArray(availabilitySubmissions.month, months))
        .all()
    : [];
  const requests = months.length ? toSummaries(db, selectRequests(db, months)) : [];

  return months.map((month) => {
    const submitted = new Set(
      submissions.filter((s) => s.month === month && activeIds.has(s.comedianId)).map((s) => s.comedianId),
    );
    const audiences: AudienceProgress[] = [
      { audience: 'all', label: EVERYONE_LABEL, color: null, total: activeIds.size, submitted: submitted.size },
      ...allTags.map((tag) => {
        const ids = members.get(tag.id) ?? [];
        return {
          audience: `tag:${tag.id}` as const,
          label: tag.name,
          color: tag.color,
          total: ids.length,
          submitted: ids.filter((id) => submitted.has(id)).length,
        };
      }),
    ];
    const forMonth = requests.filter((r) => r.month === month);
    return {
      month,
      total: activeIds.size,
      submitted: submitted.size,
      notSubmitted: activeIds.size - submitted.size,
      audiences,
      lastRequest: forMonth.find((r) => r.kind === 'request') ?? null,
      lastReminder: forMonth.find((r) => r.kind === 'reminder') ?? null,
    };
  });
}

// ---------------------------------------------------------------------------
// Sending & preview
// ---------------------------------------------------------------------------

export interface SendAvailabilityRequestInput {
  month: string;
  audience: AvailabilityAudience;
  message: string;
  kind: AvailabilityRequestKind;
  sentById: number | null;
}

/**
 * Email the audience (or, for a reminder, its non-submitters) a magic link to mark the
 * month, and record the blast. 409 `no_recipients` when nobody would get it.
 */
export async function sendAvailabilityRequest(
  db: Db,
  input: SendAvailabilityRequestInput,
): Promise<CreateAvailabilityRequestResponse> {
  const { label, recipients } = availabilityRecipients(db, input);
  if (recipients.length === 0) {
    throw httpError(
      409,
      input.kind === 'reminder' ? `Everyone in ${label} has already submitted` : `Nobody is in ${label}`,
      'no_recipients',
    );
  }
  const { clubName } = getSettings(db);
  const results = await mapWithConcurrency(recipients, EMAIL_CONCURRENCY, async (comedian) => {
    const url = createLoginLink(db, comedian.id, { redirectTo: availabilityPortalPath(input.month) });
    const content = availabilityRequestEmail({
      clubName,
      name: comedian.name,
      month: input.month,
      url,
      message: input.message,
      kind: input.kind,
    });
    return sendEmail(db, {
      to: comedian.email,
      ...content,
      kind: input.kind === 'reminder' ? 'availability_reminder' : 'availability_request',
      comedianId: comedian.id,
      senderUserId: input.sentById,
    });
  });
  const failed = results.filter((r) => r.status === 'failed').length;

  const row = db
    .insert(availabilityRequests)
    .values({
      month: input.month,
      kind: input.kind,
      message: input.message,
      audience: input.audience,
      recipientCount: recipients.length,
      sentById: input.sentById,
      sentAt: Date.now(),
    })
    .returning()
    .get();
  const sentByName = input.sentById
    ? (db.select({ name: users.name }).from(users).where(eq(users.id, input.sentById)).get()?.name ?? null)
    : null;
  const [request] = toSummaries(db, [{ ...row, sentByName }]);

  return { recipientCount: recipients.length, sent: recipients.length - failed, failed, request: request! };
}

/** The email as the first recipient (or, failing that, anyone) would get it. Creates no tokens. */
export function renderAvailabilityPreview(
  db: DbOrTx,
  params: { month: string; message: string; kind: AvailabilityRequestKind; audience: AvailabilityAudience },
): AvailabilityRequestPreview {
  const { members, recipients } = availabilityRecipients(db, params);
  const sample =
    recipients[0] ??
    members[0] ??
    db.select({ name: comedians.name }).from(comedians).where(eq(comedians.archived, false)).orderBy(asc(comedians.name)).get();
  const sampleName = sample?.name ?? 'Alex Example';
  const content = availabilityRequestEmail({
    clubName: getSettings(db).clubName,
    name: sampleName,
    month: params.month,
    url: absoluteUrl(db, availabilityPortalPath(params.month)),
    message: params.message,
    kind: params.kind,
  });
  return { ...content, sampleName, recipientCount: recipients.length };
}
