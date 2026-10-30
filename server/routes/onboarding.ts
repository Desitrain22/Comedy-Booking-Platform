/**
 * Setup guide + welcome tour API (onboarding design §2). Booker-only, per booker.
 *
 *   GET  /api/onboarding            OnboardingResponse
 *   POST /api/onboarding/dismiss    → OnboardingResponse   (Skip guide)
 *   POST /api/onboarding/resume     → OnboardingResponse   (reopen after a skip)
 *   POST /api/onboarding/complete   → OnboardingResponse   (finished, or the tour was skipped)
 *
 * Contract types live in shared/api/onboarding.ts.
 */
import { Hono } from 'hono';
import type { OnboardingResponse } from '../../shared/api/onboarding';
import { requireBooker } from '../auth/middleware';
import type { AppEnv } from '../context';
import { buildOnboarding, updateGuide, type GuideAction } from '../services/onboarding';

export const onboardingRoutes = new Hono<AppEnv>();

onboardingRoutes.get('/onboarding', requireBooker, (c) =>
  c.json(buildOnboarding(c.var.db, c.var.booker) satisfies OnboardingResponse),
);

const ACTIONS: GuideAction[] = ['dismiss', 'resume', 'complete'];
for (const action of ACTIONS) {
  onboardingRoutes.post(`/onboarding/${action}`, requireBooker, (c) => {
    const db = c.var.db;
    updateGuide(db, c.var.booker.id, action);
    return c.json(buildOnboarding(db, c.var.booker) satisfies OnboardingResponse);
  });
}
