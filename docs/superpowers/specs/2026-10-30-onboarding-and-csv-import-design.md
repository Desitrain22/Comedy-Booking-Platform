# Setup guide (onboarding) + CSV import of comedians — Design

Date: 2026-10-30. Status: approved by owner ("looks good, just cook"). Builds on the main
spec `2026-10-28-comedy-booking-platform-design.md` (its conventions apply). Items marked
*(builder's call)* were decided without the owner; everything else came from the owner.

## 1. Why

A new club manager (the owner's example: Rich Brooks, who runs a club) opens the app for
the first time and should be **walked through** setting up — not left to explore. The guide
gets him from nothing to a working month: a club, a few shows on the calendar, comedians
on the roster, and an availability request sent to them. Separately, clubs already have
their comedian roster in a spreadsheet, so comedians can be **imported from a CSV**.

## 2. Setup guide

### The three steps (owner)
1. **Club** — create the club if there isn't one (the existing `/setup` wizard: club name,
   timezone, admin login, first location). Framed as "Step 1 of 3".
2. **Shows** — create at least a few shows on the calendar. Done when **≥ 3 scheduled
   shows** exist *(builder's call for the number)*.
3. **Comedians** — add/import comedians, then **send the availability request** for the
   month the shows are in. Done when ≥ 1 non-archived comedian exists **and** an
   availability request has been sent for a month that has shows. The guide ends there
   (owner: "Ask for availabilities"; no lineup-drag step).

### How it behaves (owner: "walked through is the point")
- It runs on the **real screens**, one thing at a time: the rest of the page is dimmed, the
  element to use next is lit (spotlight ring), and a **coach card** next to it says what to
  do in one or two sentences, with **Back**, **Next** (only when the step is informational)
  and **Skip guide**.
- The guide **waits for the real action** (e.g. it advances after shows are actually
  created), detecting completion from data, not clicks.
- A **progress rail** at the top of the booker app while the guide is active:
  `Club ✓ — Shows · 2 of 3 — Comedians`.
- Approved sketch: `.superpowers/brainstorm/3583-1793339262/content/onboarding-guided.html`.

### Step-by-step script *(builder's call; copy may be polished)*
- After `/setup` completes → land on `/app/shows/new?month=<planningMonth>` with the
  guide on step 2:
  1. Light the form (location, start time, slots): "Your first show: pick the room and
     start time. Most clubs start with their regular weekend shows."
  2. Light the weekday chips + calendar: "Tap F to put this show on every Friday this
     month — or drag across days on the calendar."
  3. Light **Create shows**: "Create them." → after success, if fewer than 3 shows exist:
     "Add a couple more — maybe a Saturday 7 and 9?" (stays on the screen); when ≥ 3:
     "N shows on the calendar." → Next → step 3.
- Step 3 → `/app/comedians`:
  1. Light **Import CSV** and **Add comedian**: "Add your comedians — import your
     spreadsheet or add them one at a time." Advances when ≥ 1 comedian exists.
  2. → `/app` (dashboard): light **Request availability**: "Ask them which nights
     they're free in <Month>." The dialog opens pre-filled with the month that has the
     shows and audience = everyone.
     - If email isn't configured, the card says so plainly and offers **Connect email**
       (admin → `/app/settings/email`, returning to the guide afterwards) or **Send anyway**
       ("they'll wait in the outbox until email is connected") *(builder's call)*.
  3. After sending → "You're set up." card with what happens next (comedians mark
     availability; you'll see them on the dashboard; then drag them into lineups on any
     day) and **Done**.

### State, resuming, replay *(builder's call)*
- Step completion is derived from club data (`GET /api/onboarding` →
  `{ steps:[{key:'club'|'shows'|'comedians', status:'done'|'current'|'todo', progress?:
  {count, target}}], currentStep, completedAt, dismissedAt, emailConfigured,
  suggestedMonth }`).
- Per-booker flags: `users.guideDismissedAt`, `users.guideCompletedAt` (schema change).
  `POST /api/onboarding/dismiss`, `POST /api/onboarding/resume`, `POST
  /api/onboarding/complete`.
- Closing the tab and coming back resumes at the current step. **Skip guide** dismisses it
  for that booker; it can be reopened from the user menu (**Setup guide**) and from the
  dashboard's Getting started card. Esc minimizes the coach card to a small "Setup guide ·
  Step 2 of 3 — Resume" pill.
- Once complete it never auto-starts again.
- The dashboard **Getting started** checklist (added in the fix round) becomes the guide's
  home: it lists the three guide steps (with progress) plus optional extras (connect email,
  invite another booker) and a **Resume setup guide** button. One source of truth:
  `GET /api/onboarding`.
- **Bookers invited later** (club already set up) get a short, task-free **welcome tour**
  instead: 4 coach marks over the nav — Dashboard, Calendar (click a day to build
  lineups), Comedians (notes & tags), Settings — with Skip. Same per-user flags.

### UI constraints
- Dimming is visual only (`pointer-events: none`) so nothing can get stuck; Radix dialogs
  render above it; the lit element gets a ring + raised stacking.
- Targets are marked with `data-guide="<id>"` attributes. Required ids:
  `shows-form`, `shows-weekdays`, `shows-calendar`, `shows-create`,
  `comedians-import`, `comedians-add`, `dashboard-request-availability`,
  `nav-dashboard`, `nav-calendar`, `nav-comedians`, `nav-settings`, `user-menu`.
- Coach card positions itself next to the target, flips to stay on screen, follows
  scroll/resize, and gracefully falls back to a centered card if the target isn't found.
- Under 768 px wide: no spotlight; the coach card docks as a bottom sheet.
- Accessible: coach card is a labelled non-modal dialog, keyboard reachable, Esc
  minimizes, focus is not trapped.

## 3. CSV import of comedians (owner)

- Fields: **Name (required), Email (required), Phone (optional), Notes (optional).**
- Available any time on **Comedians → Import CSV**, and used by step 3 of the guide.
- Flow (approved sketch `.superpowers/brainstorm/3583-1793339262/content/csv-import.html`):
  choose/drag a `.csv` file → columns found (Name ✓ Email ✓ Phone ✓ Notes ✓, unknown
  columns listed as ignored) → preview table with a status per row: **New**, **Already on
  roster** (skipped), **Needs an email** / **Invalid email** / **Needs a name** (skipped),
  **Duplicate in file** (skipped) → "Email each new comedian a sign-in link" (default on)
  → **Import N comedians** → summary toast.
- *(builder's calls)*:
  - Headers matched loosely, case/spacing-insensitive: name / full name / comedian / comic
    / performer; or **first name + last name** columns combined; email / e-mail / email
    address; phone / phone number / cell / mobile / tel; notes / note / comments.
  - No recognizable header row → columns read positionally as Name, Email, Phone, Notes.
  - RFC 4180 parsing (quotes, escaped quotes, commas/newlines inside quotes, CRLF, UTF-8
    BOM); delimiter sniffed among comma / semicolon / tab. Shared parser in
    `shared/csv.ts` with thorough unit tests; parsing happens in the browser, the server
    re-validates every row.
  - Existing emails are **skipped, never overwritten**.
  - **Notes** become a private booker note on the new comedian, authored by the importing
    booker (same as notes added by hand).
  - **Phone** is stored as typed (trimmed, ≤ 40 chars, digits and `+ ( ) - . space ext x`).
  - Limits: 2 MB file, 1,000 rows (clear error beyond that). The bulk endpoint accepts a
    larger body than the global API limit if needed.
  - **Download template** (`comedians-template.csv` with the four headers + one example).
  - The existing "paste a list" bulk add stays and accepts the same four columns using the
    same parser.
- API: extend `POST /api/comedians/bulk` with rows `{name, email, phone?, note?}`,
  `dryRun`, `sendLoginLinks`; response lists created + skipped with reasons (backwards
  compatible).

## 4. Phone number (owner: optional field)
- Schema: `comedians.phone` (text, default '').
- Bookers: shown on the comedian profile, hover card and as a roster column; editable in
  the booker's edit dialog and Add comedian dialog.
- Comedians: optional "Phone" field on their portal Profile.
- Never used for sending texts (SMS stays a non-goal).

## 5. Done means
Unit tests (parser, onboarding state), API tests (onboarding endpoints, bulk import incl.
notes/phone/duplicates/limits, phone validation), and Playwright e2e: a **fresh club**
(no seed) goes `/setup` → guided shows step (create ≥ 3 via weekday chip) → import a CSV
of 5 comedians (one duplicate, one bad email) → request availability (outbox) → "You're
set up"; skip + resume from the user menu; an invited booker sees the welcome tour once.
`npm run typecheck`, `npm test`, `npm run build`, `npm run e2e` all pass. README updated.
