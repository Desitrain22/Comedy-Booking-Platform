/**
 * F5 Dashboard, availability requests & confirmations API (spec §6 F5). All booker-only.
 *
 *   GET  /api/dashboard                                 DashboardResponse
 *   POST /api/confirmations/send      {weekStart, onlyUnsent?}   → SendConfirmationsResponse
 *   POST /api/confirmations/resend    {comedianId, weekStart}    → ResendConfirmationResponse
 *                                     (archived comedian → `{status: 'archived'}`, nothing sent)
 *   POST /api/availability-requests   {month, audience, message, kind} → 201 CreateAvailabilityRequestResponse
 *   GET  /api/availability-requests[?month]             AvailabilityRequestSummary[]
 *   GET  /api/availability-requests/preview?month&message[&kind][&audience] → AvailabilityRequestPreview
 *
 * Contract types and schemas live in shared/api/dashboard.ts.
 */
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  availabilityPreviewQuerySchema,
  createAvailabilityRequestSchema,
  listAvailabilityRequestsQuerySchema,
  resendConfirmationSchema,
  sendConfirmationsSchema,
  type AvailabilityRequestPreview,
  type AvailabilityRequestSummary,
  type CreateAvailabilityRequestResponse,
  type DashboardResponse,
  type ResendConfirmationResponse,
  type SendConfirmationsResponse,
} from '../../shared/api/dashboard';
import { requireBooker } from '../auth/middleware';
import type { AppEnv } from '../context';
import { comedians } from '../db/schema';
import { orNotFound } from '../lib/http';
import { validate } from '../lib/validate';
import {
  listAvailabilityRequests,
  renderAvailabilityPreview,
  sendAvailabilityRequest,
} from '../services/availabilityRequests';
import { sendConfirmationToComedian, sendConfirmationsForWeek } from '../services/confirmations';
import { buildDashboard } from '../services/dashboard';

export const dashboardRoutes = new Hono<AppEnv>();

dashboardRoutes.get('/dashboard', requireBooker, (c) => c.json(buildDashboard(c.var.db) satisfies DashboardResponse));

// ---------------------------------------------------------------------------
// Confirmations
// ---------------------------------------------------------------------------

dashboardRoutes.post('/confirmations/send', requireBooker, validate('json', sendConfirmationsSchema), async (c) => {
  const { weekStart, onlyUnsent } = c.req.valid('json');
  const result = await sendConfirmationsForWeek(c.var.db, weekStart, { onlyUnsent });
  return c.json({ weekStart, ...result } satisfies SendConfirmationsResponse);
});

dashboardRoutes.post('/confirmations/resend', requireBooker, validate('json', resendConfirmationSchema), async (c) => {
  const db = c.var.db;
  const { comedianId, weekStart } = c.req.valid('json');
  const comedian = orNotFound(
    db.select({ id: comedians.id, archived: comedians.archived }).from(comedians).where(eq(comedians.id, comedianId)).get(),
    'Comedian',
  );
  // Archived comedians are never emailed; say so instead of a misleading "nothing to confirm".
  if (comedian.archived) return c.json({ status: 'archived', bookingCount: 0 } satisfies ResendConfirmationResponse);
  const result = await sendConfirmationToComedian(db, comedianId, weekStart);
  return c.json(result satisfies ResendConfirmationResponse);
});

// ---------------------------------------------------------------------------
// Availability requests
// ---------------------------------------------------------------------------

dashboardRoutes.post(
  '/availability-requests',
  requireBooker,
  validate('json', createAvailabilityRequestSchema),
  async (c) => {
    const input = c.req.valid('json');
    const result = await sendAvailabilityRequest(c.var.db, { ...input, sentById: c.var.booker.id });
    return c.json(result satisfies CreateAvailabilityRequestResponse, 201);
  },
);

dashboardRoutes.get(
  '/availability-requests',
  requireBooker,
  validate('query', listAvailabilityRequestsQuerySchema),
  (c) => c.json(listAvailabilityRequests(c.var.db, c.req.valid('query').month) satisfies AvailabilityRequestSummary[]),
);

dashboardRoutes.get(
  '/availability-requests/preview',
  requireBooker,
  validate('query', availabilityPreviewQuerySchema),
  (c) => c.json(renderAvailabilityPreview(c.var.db, c.req.valid('query')) satisfies AvailabilityRequestPreview),
);
