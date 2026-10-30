/**
 * Setup guide (onboarding) + welcome tour. BookerLayout mounts the provider, rail and overlay;
 * pages mark their elements with `data-guide="<id>"` and use the hooks:
 *
 *   const guide = useGuide();                                 // state + start() (may be null)
 *   useGuideSignal('showsSelected', toCreate);                // what the page has picked
 *   useGuideAction('request-availability', openDialog);       // what the coach card can trigger
 *   const { data } = useOnboarding();                         // GET /api/onboarding
 */
export { GuideOverlay } from './GuideOverlay';
export { autoStarts, GuideProvider, useGuide, useGuideAction, useGuideSignal, type GuideContextValue } from './GuideProvider';
export { GUIDE_RAIL_HEIGHT, GuideRail, useGuideRailVisible } from './GuideRail';
export { ONBOARDING_KEY, useOnboarding } from './onboardingQuery';
export { createShowsPath } from './script';
