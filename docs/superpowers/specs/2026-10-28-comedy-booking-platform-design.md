# Comedy Booking Platform — Design & Build Contract

Date: 2026-10-28. Status: approved by owner ("go build it"). This document is the single
source of truth for every agent building this app. Items marked *(builder's call)* were
decided without the owner; everything else came from the owner directly.

## 1. What this is

An open-source, self-hosted booking tool for a comedy club. **One deployment = one club.**
A club has several **locations** (rooms/venues), each with recurring **shows**. Each show
has N **slots** that a **booker** fills with **comedians** to form a lineup.

Two audiences:

- **Bookers** (club staff, email + password). Set up locations and shows, keep a roster of
  comedians with private notes and tags, request monthly availability, build lineups by
  drag-and-drop, and chase weekly confirmations.
- **Comedians** (no password; email + one-time code). Paint their availability on a month
  calendar, edit their profile (name, bio, headshot URL), see their booked spots, and
  confirm them.

### The rhythm
1. Booker creates next month's shows (usually copying last month's weekday pattern).
2. Booker sends an **availability request** (blast) for the month; comedians paint their
   availability in the portal and Save.
3. Booker opens a date, sees all shows across locations, drags available comedians into
   slots. Booking an unavailable comedian is allowed after a warning:
   "Jason isn't available during that slot. Book anyway?"
4. Weekly, a **confirmation email** goes to every comedian booked that week:
   "Hey John, you're booked for these spots this week. Please click to confirm."
5. Dashboard shows, in red, **today's unconfirmed comedians**:
   "John · 7 PM @ The Cellar · unconfirmed".

### Goals
- Feels fast and fluid: painting availability and dragging lineups respond instantly.
- Trivial to self-host: one Docker container, one SQLite file, SMTP for email.
- Works on a phone for comedians (most open links from email on mobile).

### Non-goals (for now)
- Multi-club SaaS / tenancy. Payments. Ticketing. SMS. Comedian passwords (later).
- Recurring-rule engines: shows are individual rows; "repeat" just creates many rows.
- Multiple availability ranges per night (one range per night).

### Anti-goals (would be failure even if it "works")
- Comedian accidentally confirming via an email-scanner prefetch (confirm must be a POST).
- Anyone who merely knows a comedian's email can edit their availability (needs a code).
- Booker loses work: every lineup change persists immediately; no "save" step for bookers.
- Comedian portal needing a manual/explanation. It must be obvious.

## 2. Stack *(builder's call)*

- **Language:** TypeScript everywhere. Node 24. npm (not pnpm/yarn).
- **Server:** Hono + `@hono/node-server`, validation with `zod` + `@hono/zod-validator`.
- **DB:** SQLite via `better-sqlite3` + `drizzle-orm`; migrations with `drizzle-kit`
  (generated SQL committed under `server/db/migrations`, applied automatically on boot).
  WAL mode, foreign keys ON.
- **Client:** React 19 + Vite + `react-router` (v7, library/declarative mode) +
  `@tanstack/react-query` v5 + Tailwind CSS v4 (`@tailwindcss/vite`) + `@dnd-kit/core`
  (lineup drag-and-drop) + Radix primitives (`@radix-ui/react-dialog`, `-hover-card`,
  `-popover`, `-tabs`, `-dropdown-menu`) + `lucide-react` icons + `sonner` toasts + `clsx`.
- **Email:** `nodemailer` over SMTP, configured in Settings (DB), env vars as fallback.
  With no SMTP configured, emails go to the **outbox** (stored in `email_log` with status
  `outbox` and printed to the server console) so the app is fully usable in dev.
- **Passwords:** `bcryptjs` (pure JS, no native build).
- **Tests:** `vitest` (unit + API tests via `app.request()`, no ports), `@playwright/test`
  (e2e, integration phase only).
- **Build/ship:** `vite build` → `dist/client`; server bundled with `tsup` → `dist/server`
  (`better-sqlite3` external). Multi-stage `Dockerfile`, `docker-compose.yml` with a volume
  at `/data`. MIT license.

## 3. Conventions (everyone must follow)

- **Dates** are `YYYY-MM-DD` strings in the **club's local timezone** (`settings.timezone`).
  Never store JS Date for a show date.
- **Times** are integer **minutes after local midnight** of the show's date.
  19:30 → 1170. Values ≥ 1440 mean after midnight but belong to that night
  (e.g. 1470 = 12:30 AM). Show `startMin` ∈ [720, 1559]. Availability ranges ∈ [960, 1560].
- **All-night** default = 7 PM–11 PM (`settings.allNightStartMin=1140`,
  `allNightEndMin=1380`), editable in Settings.
- **Availability rule:** comedian is available for a show iff they have an availability
  row for `show.date` and `row.startMin <= show.startMin <= row.endMin` (inclusive).
  Implemented once in `shared/availability.ts` → `isAvailableFor(row | null, startMin)`.
- **Weeks** run Monday→Sunday. `weekStart` = that Monday's date string.
- **Months** are `YYYY-MM` strings.
- **Time display** via `shared/time.ts`: `formatTime(1170) → "7:30 PM"`, `formatTime(1140)
  → "7 PM"`, `formatTime(1470) → "12:30 AM"`, `formatRange(1260,1380) → "9–11 PM"`,
  `formatRange(1320,1440) → "10 PM–12 AM"`, `formatDateLong("2026-11-08") → "Sunday, Nov 8"`
  etc. Pure functions, used on both client and server. Also date math helpers:
  `addDays`, `weekStartOf`, `monthOf`, `daysInMonth(month) → string[]`, `weekdayOf(date)`
  (0=Sun..6=Sat), `todayInTz(tz)`, `nowMinutesInTz(tz)`.
- **IDs:** integer autoincrement. Timestamps: integer ms since epoch (`createdAt` etc.).
- **API:** JSON under `/api`. Errors: `{ error: string, code?: string, ...extra }` with a
  proper status. Validate every body/query with zod. Booker routes use `requireBooker`
  (or `requireAdmin`); portal routes use `requireComedian`.
- **DB access:** routes read the DB from context: `c.var.db` (drizzle instance). Services
  take `db` as their first argument. Never import a global DB singleton in routes/services
  (tests create isolated DBs).
- **Client data:** TanStack Query. Query keys are arrays starting with the API path
  segment, e.g. `['days', date]`, `['shows', from, to]`, `['comedians']`. Mutations
  invalidate the relevant keys. Use the shared `api` fetch wrapper in `client/lib/api.ts`
  (`api.get/post/put/patch/del`, throws `ApiError {status, code, body}`).
- **Ownership:** each feature owns its listed files only. **Do not edit files you don't
  own.** If you need a change in a foundation file, make the smallest possible additive
  change, and list it in your final report. Never edit `server/db/schema.ts` (report
  instead). Never run `npm install` in the feature phase (all deps are installed by
  foundation; report if something is missing).

## 4. Data model (`server/db/schema.ts`, foundation-owned)

| table | columns |
|---|---|
| `settings` (singleton id=1) | clubName, timezone (default `America/New_York`), appUrl (base URL for links in emails), allNightStartMin 1140, allNightEndMin 1380, smtpHost, smtpPort, smtpSecure (bool), smtpUser, smtpPass, fromName, fromEmail, replyTo, confirmationsEnabled (bool, true), confirmationDay (0–6, default 1 = Monday), confirmationTimeMin (default 600 = 10 AM), setupComplete (bool), createdAt |
| `users` (bookers) | id, email (unique, lowercased), name, passwordHash (nullable until invite accepted), role (`admin`/`booker`), inviteTokenHash, inviteExpiresAt, createdAt, lastLoginAt |
| `sessions` | id (text pk = sha256 of token), kind (`booker`/`comedian`), subjectId, expiresAt, createdAt |
| `comedians` | id, email (unique, lowercased), name, bio (''), headshotUrl (''), archived (bool), createdAt, updatedAt, lastLoginAt |
| `login_codes` | id, comedianId, codeHash, expiresAt, attempts, consumedAt, createdAt |
| `tokens` | id, tokenHash (unique), comedianId, purpose (`login`/`confirm`), weekStart (nullable), redirectTo (nullable), expiresAt, createdAt, lastUsedAt |
| `locations` | id, name, address (''), color (hex), sortOrder, archived (bool), createdAt |
| `shows` | id, locationId → locations, date, startMin, name (''), slotCount (default 6), status (`scheduled`/`cancelled`), notes (''), createdAt. Index on date. |
| `bookings` | id, showId → shows (cascade delete), comedianId → comedians, position (0-based slot index), overrideUnavailable (bool), bookedById → users (nullable), confirmationSentAt (nullable), confirmedAt (nullable), confirmedBy (`comedian`/`booker`, nullable), createdAt. Unique (showId, position). Unique (showId, comedianId). |
| `availability` | id, comedianId, date, startMin, endMin, updatedAt. Unique (comedianId, date). |
| `availability_submissions` | comedianId, month, submittedAt. PK (comedianId, month). |
| `availability_requests` | id, month, kind (`request`/`reminder`), message, audience (`all` or `tag:<id>`), recipientCount, sentById, sentAt |
| `tags` | id, name (unique), color, createdAt |
| `comedian_tags` | comedianId, tagId. PK both. Cascade on delete of either. |
| `notes` | id, comedianId, authorId → users, body, createdAt, updatedAt |
| `email_log` | id, toEmail, subject, kind (`login_code`/`login_link`/`availability_request`/`availability_reminder`/`confirmation`/`booker_invite`/`test`), status (`sent`/`failed`/`outbox`), error, comedianId (nullable), bodyHtml, bodyText, createdAt |
| `job_runs` | key (text pk, e.g. `confirmations:2026-11-02`), ranAt |

Booking status (derived, `shared/bookingStatus.ts`):
`confirmed` (confirmedAt set) → green · `awaiting` (sent, not confirmed) → amber ·
`not_sent` → gray · and **`unconfirmed_today`** (show.date == today in club tz and not
confirmed) → red, which overrides awaiting/not_sent.

## 5. Auth

- **Bookers:** email + password. `POST /api/auth/login`, `POST /api/auth/logout`.
  First run: `/setup` wizard (only when `setupComplete=false`) creates settings
  (clubName, timezone, appUrl = browser origin), the first location, and the admin user.
  Admins invite bookers (Settings): creates a user with an invite token; invite email
  links to `/accept-invite/:token` where they set a password. The invite URL is also shown
  in the UI so it can be copied when email isn't set up.
- **Comedians:** `POST /api/auth/comedian/request-code {email}` → always `200 {ok:true}`
  (no account enumeration). If the email belongs to a non-archived comedian, a 6-digit
  code (10-min expiry, stored hashed, max 5 attempts, max 5 codes per email per 15 min)
  is emailed. `POST /api/auth/comedian/verify-code {email, code}` → sets comedian session.
- **Magic links** (in availability-request and "send sign-in link" emails):
  `/portal/magic/:token` page POSTs `/api/auth/magic {token}` → session + `{redirectTo}`.
  Login tokens are valid for 30 days and reusable within that window *(builder's call)*.
- **Confirm links** (in weekly confirmation email): `/portal/confirm/:token`. The page
  GETs `/api/portal/confirm/:token` (read-only: comedian name + that week's spots), and
  confirming is a **POST** `/api/portal/confirm/:token` which marks all that comedian's
  scheduled bookings in that week confirmed AND signs them in. Valid until 2 days after
  the week ends.
- **Sessions:** two separate httpOnly SameSite=Lax cookies: `cbp_booker` (30 days) and
  `cbp_comedian` (90 days), so a booker can test the portal in the same browser.
  `Secure` when appUrl is https. Session token = 32 random bytes base64url; DB stores
  sha256. `GET /api/auth/me` → `{booker: {...}|null, comedian: {...}|null}`.
- CSRF: `hono/csrf` origin check on mutating requests + SameSite=Lax.

## 6. Screens & features

Booker app lives under `/app/*` (BookerLayout: left nav — Dashboard, Calendar, Comedians,
Tags, Settings; club name; user menu). Comedian portal lives under `/portal/*`
(PortalLayout: club name header, tabs Availability / My spots / Profile, sign out;
mobile-first). `/` redirects to `/app` (booker session), `/portal` (comedian session),
else `/portal/login` with a small "Club staff? Sign in" link to `/login`.

### F1 — Shows & booker calendar
- `/app/calendar?month=YYYY-MM`: month grid (Sun-first). Each day lists its shows as pills
  `7:30 · Cellar · 5/7` in the location color, sorted by time; a pill shows a red dot if
  any booking on it is `unconfirmed_today`, cancelled shows are struck through. Location
  filter (multi-select chips). Clicking a day (not a pill) → `/app/day/:date`. Clicking a
  pill → show edit dialog (name, start time, slot count, notes, cancel/restore, delete when
  it has no bookings; time change resets confirmations of its bookings). Prev/next month,
  "Today". Buttons: **Create shows** → `/app/shows/new`.
- `/app/shows/new?month=` — matches the approved mockup: left panel (Location, optional
  Show name, Start time in 15-min steps 12 PM–1:45 AM, Slots), weekday chips
  (S M T W T F S toggle every such day in the month), calendar where click / click-drag
  paints dates (drag starting on an unselected day adds, on a selected day removes),
  existing shows shown as pills in location colors, new shows previewed in accent color,
  live summary "8 shows will be created: "Late Show", 9:30 PM at The Cellar, 7 slots each",
  **Create shows** button. Duplicates (same location+date+startMin, scheduled) are skipped
  and reported. Month navigation keeps selection per month.
- **Copy pattern**: button "Copy <prev month>'s pattern into <month>" → preview dialog
  listing the shows that will be created (grouped by weekday/location), optional location
  filter, Confirm. Pattern = distinct (locationId, weekday, startMin, name, slotCount) of
  scheduled shows in the source month; applied to every matching weekday in the target
  month; skips existing duplicates; copies no bookings.
- API (`server/routes/shows.ts`): `GET /api/shows?from&to[&locationIds]` → shows with
  `location`, `bookedCount`, `unconfirmedTodayCount`; `POST /api/shows/bulk
  {locationId,name,startMin,slotCount,dates[]}` → `{created, skipped}`;
  `POST /api/shows/copy-pattern {fromMonth,toMonth,locationIds?,dryRun}` → `{shows:[...]}`
  (preview when dryRun); `GET /api/shows/:id`; `PATCH /api/shows/:id
  {name?,startMin?,slotCount?,notes?,status?}` (slotCount may not drop below
  max occupied position+1 → 409 `slots_occupied`); `DELETE /api/shows/:id` (409 if it has
  bookings).

### F2 — Day view / lineup board
- `/app/day/:date`: header with date ("Saturday, Nov 8"), prev/next day, back to calendar.
  Main area: one column (card) per scheduled show, grouped by location then time
  (e.g. Cellar 7, 7:30, 9, 11 · Annex 6, 8, 10), each with N slot rows numbered 1..N.
  A filled slot shows the comedian chip with status color (confirmed/awaiting/not sent/
  red unconfirmed today) and a ⚠ marker if `overrideUnavailable`. Empty slots are drop
  targets. Show header: time, name, location color, fill count, `−`/`+` slot count
  buttons (calls F1's `PATCH /api/shows/:id`), and a menu with "Edit show" (link to
  calendar) and "Copy lineup to clipboard" (plain text).
- Right sidebar: comedian pool. Search box, tag chips (filter by one or more tags;
  "pull comedians from a group"), toggle "Available today only". Each comedian card shows
  name, tags, and availability for this date: green "9–11 PM", gray "not marked" (no
  submission for that month), muted "unavailable" (submitted, nothing that day). Sort:
  available first, then name. Cards already booked today show "booked 7:00 Cellar".
- Drag a comedian from the sidebar into an empty slot → book. Drag a booked chip to
  another slot (same or different show) → move; dropping onto an occupied slot swaps.
  Drag a chip back to the sidebar or click its × → unbook. Also support click-to-select
  then click a slot (keyboard/mobile fallback). Optimistic UI with rollback on error.
- When the comedian is not available for that show's time → modal: "**Jason** isn't
  available during this slot (marked 9–11 PM for Nov 8 | hasn't marked Nov 8 |
  hasn't submitted November). Book anyway?" [Cancel] [Book anyway] → retries with
  `force:true`, stored as `overrideUnavailable=true`.
- Hovering a comedian anywhere (sidebar or slot) shows `ComedianHoverCard` (F3): headshot,
  name, tags, bio excerpt, latest notes.
- API (`server/routes/lineup.ts`): `GET /api/days/:date` → `{date, today, shows:[{id,
  location, startMin, name, slotCount, status, bookings:[{id, position, comedianId,
  comedianName, status, overrideUnavailable, confirmedAt, confirmationSentAt}]}],
  comedians:[{id, name, tags:[{id,name,color}], availability:{startMin,endMin}|null,
  submittedMonth:boolean, bookings:[{showId, startMin, locationName}]}], tags:[...] }`
  (non-archived comedians only); `POST /api/bookings {showId, position, comedianId,
  force?}` → 201 booking, or 409 `{code:'unavailable', availability, submittedMonth}`,
  409 `already_in_show`, 409 `slot_taken`, 400 for position ≥ slotCount;
  `PATCH /api/bookings/:id {showId, position, force?}` (move; swap if occupied; moving to a
  different show resets confirmation and re-checks availability); `DELETE /api/bookings/:id`;
  `POST /api/bookings/:id/confirm` (booker marks confirmed manually, confirmedBy=booker).

### F3 — Comedians, tags, notes
- `/app/comedians`: table (name, email, tags, next-month availability: "Submitted ✓" /
  "Not yet", upcoming spots count). Search, tag filter, show archived toggle. Row select →
  bulk add/remove tag, archive. **Add comedian** dialog (name + email). **Bulk add**
  dialog: paste lines `Name, email` or `Name <email>`; preview with invalid/duplicate rows
  flagged; creates valid ones.
- `/app/comedians/:id`: header (headshot from URL or initials avatar, name, email, edit
  dialog — booker may change name/email/bio/headshot), tags editor (multi-select with
  create-new), **Notes** panel (add; edit/delete; author name + relative time; newest
  first), read-only availability month calendar (navigate months, green days with ranges,
  "Submitted Nov 3" / "Hasn't submitted"), upcoming spots list with status, actions:
  "Send sign-in link" (emails a magic link), Archive/Restore.
- `/app/tags`: manage tags (name, color from palette, member count), create, rename,
  recolor, delete (confirm). Click a tag → comedians list filtered by it.
- `client/components/ComedianHoverCard.tsx`: `({comedianId, children})` Radix HoverCard
  with lazy-fetched `GET /api/comedians/:id/card` → `{id,name,email,bio,headshotUrl,tags,
  notes:[latest 3]}`. Foundation ships a pass-through stub with this exact signature; F3
  replaces the implementation.
- API (`server/routes/comedians.ts`): `GET /api/comedians?search&tagIds&archived` (with
  tags, `nextMonthSubmitted`, `upcomingCount`); `POST /api/comedians {name,email}`
  (409 `email_taken`); `POST /api/comedians/bulk {rows:[{name,email}]}` →
  `{created, skipped:[{row, reason}]}`; `GET /api/comedians/:id`; `PATCH
  /api/comedians/:id`; `PUT /api/comedians/:id/tags {tagIds}`; `POST
  /api/comedians/bulk-tag {comedianIds, tagId, action:'add'|'remove'}`;
  `GET /api/comedians/:id/availability?month` → `{entries, submittedAt}`;
  `GET /api/comedians/:id/bookings?upcoming=1`; `GET /api/comedians/:id/card`;
  `POST /api/comedians/:id/send-login-link`; notes `GET/POST /api/comedians/:id/notes`,
  `PATCH/DELETE /api/notes/:id`; tags `GET/POST /api/tags`, `PATCH/DELETE /api/tags/:id`.

### F4 — Comedian portal (`/portal/*`)
- `/portal/login`: email → "We sent a 6-digit code to john@…" → code input (6 boxes,
  paste-friendly, autofocus, `autocomplete="one-time-code"`) → in. Resend link with
  cooldown. Generic messaging (no enumeration).
- `/portal/magic/:token`, `/portal/confirm/:token` pages (see Auth).
- `/portal` (Availability) — matches the approved mockup: month header with prev/next
  (defaults to `?month=` param, else next month if today ≥ the 20th, else current month
  *(builder's call)*); brush pills: **All night** (settings range), **custom range**
  (start/end selects, half-hour steps 4 PM–2 AM; end must be > start), **Not available**
  (eraser); weekday letters paint every such (non-past) day in the month; click / drag
  across days paints (pointer events; on touch the calendar captures the gesture so drag
  paints instead of scrolling); painted days are green with their range ("9–11 PM",
  "All night"); past days are disabled. Sticky footer: "● Unsaved changes · 6 nights
  marked" + **Save** (and a warning on navigation/unload with unsaved changes). Save sends
  the whole month (`PUT`), records a submission (even if zero nights), toast "Saved —
  the club can see it now". Below the calendar, a short line: "Blank nights count as not
  available."
- `/portal/spots`: upcoming spots grouped by week ("This week", "Week of Nov 9"), each
  row: date, time, location (+address), show name, status; per week a **Confirm these
  spots** button when any are unconfirmed. Past 2 weeks collapsed.
- `/portal/profile`: name, bio (textarea, 1000 chars), headshot URL (with live preview
  and graceful broken-image fallback), email shown read-only ("Contact the club to change
  it"). Save.
- API (`server/routes/portal.ts`, all `requireComedian` except confirm-token routes):
  `GET /api/portal/me`; `GET /api/portal/availability?month` → `{month, entries:[{date,
  startMin,endMin}], submittedAt, allNight:{startMin,endMin}, today}`;
  `PUT /api/portal/availability {month, entries}` (replaces the month's non-past entries;
  validates ranges; rejects dates outside the month); `GET /api/portal/spots`;
  `POST /api/portal/spots/confirm {weekStart}`; `GET/PUT /api/portal/profile`;
  `GET/POST /api/portal/confirm/:token`.

### F5 — Dashboard, availability requests, confirmations, scheduler
- `/app` Dashboard:
  1. **Unconfirmed tonight** (red panel, top): one row per unconfirmed booking today:
     "John · 7 PM @ The Cellar · unconfirmed" with [Resend] [Mark confirmed]. Empty
     state: "Everyone's confirmed for tonight 🎉".
  2. **Tonight's shows**: compact cards per show with lineup chips (status colors) and
     fill count; link to day view.
  3. **This week**: per day counts (shows, open slots, unconfirmed); "Confirmations last
     sent <time> · next automatic send <Mon 10 AM>"; button **Send confirmations now**
     (for the current week; only to comedians with unconfirmed bookings).
  4. **Availability**: for current and next month, "14 of 32 comedians have submitted
     December" progress bar; **Request availability** (dialog: month, audience = everyone
     or a tag, optional personal message, preview of email) and **Remind the 18 who
     haven't** (sends only to non-submitters in audience). Shows last request sent.
- Emails (`server/email/featureTemplates.ts` or within services, F5-owned):
  availability request ("Hey John — The Laugh Track is booking December. Tell us which
  nights you're free: [Mark my availability]" magic link → `/portal?month=2026-12`),
  reminder, weekly confirmation (list of spots with date/time/location/address and a big
  "Confirm my spots" button → confirm link; note "Can't make one? Reply to this email.").
  Plain-text alternative always included.
- `server/services/confirmations.ts`: `sendConfirmationsForWeek(db, weekStart, {onlyUnsent?})`,
  `sendConfirmationToComedian(db, comedianId, weekStart)`; one email per comedian listing
  all their scheduled spots that week; sets `confirmationSentAt` on those bookings.
- `server/services/scheduler.ts`: `startScheduler(db)` (foundation calls it on boot; ships
  as a no-op stub). Every 60s (`unref`'d interval): if confirmationsEnabled and club-local
  weekday == confirmationDay and local minutes ≥ confirmationTimeMin, target week = the
  Monday on/after today; if no `job_runs` row `confirmations:<weekStart>`, send and insert
  it. Daily cleanup of expired sessions/codes/tokens.
- API (`server/routes/dashboard.ts`): `GET /api/dashboard` (everything above in one
  payload); `POST /api/confirmations/send {weekStart}`; `POST /api/confirmations/resend
  {comedianId, weekStart}`; `POST /api/availability-requests {month, audience, message,
  kind}` → `{recipientCount}`; `GET /api/availability-requests?month`;
  `GET /api/availability-requests/preview?month&message` → `{subject, html}`.

### F6 — Settings (`/app/settings`, tabs)
- **Club**: name, timezone (select from `Intl.supportedValuesOf('timeZone')`), app URL,
  all-night default range.
- **Locations**: list with color swatch, add/edit (name, address, color from palette),
  reorder (up/down), archive/restore. (API is foundation-owned, F6 builds the UI.)
- **Email**: provider presets (Gmail / Google Workspace: smtp.gmail.com, 465, secure,
  "use an App Password" help text; Resend: smtp.resend.com 465 user `resend`, password =
  API key; Postmark; Custom), host/port/secure/user/password (write-only: shows "Saved"
  when set; blank keeps existing), from name, from email, reply-to. **Send test email**
  to the signed-in booker. Status badge: "Not configured — emails go to the outbox".
  **Email log**: recent 100 emails (time, to, subject, kind, status), click to view the
  rendered body (sandboxed iframe) — this is how dev users read sign-in codes.
- **Confirmations**: enabled toggle, day of week, time.
- **Bookers** (admin only): list, invite (name, email, role) → shows copyable invite
  link, resend invite, change role, remove (can't remove yourself / last admin).
- **Backup** (admin only): "Download database backup" (`VACUUM INTO` temp file → stream).
- API (`server/routes/settings.ts`): `GET/PUT /api/settings` (smtpPass never returned;
  `smtpPassSet: boolean`); `POST /api/settings/test-email`; `GET /api/email-log`;
  `GET /api/email-log/:id`; `GET/POST /api/users`, `PATCH/DELETE /api/users/:id`,
  `POST /api/users/:id/resend-invite`; `GET /api/backup`.

## 7. Foundation (built first; everything shared)

Files (foundation-owned): `package.json`, configs (`tsconfig*.json`, `vite.config.ts`,
`drizzle.config.ts`, `tsup.config.ts`, `vitest.config.ts`, `playwright.config.ts`),
`server/index.ts`, `server/app.ts` (`createApp({db})` mounts all route modules),
`server/env.ts`, `server/db/{schema,client,seed}.ts`, `server/db/migrations/*`,
`server/auth/*` (sessions, password, codes, tokens, middleware, and `server/routes/auth.ts`
+ `server/routes/setup.ts` + `server/routes/locations.ts`), `server/email/{mailer,
templates}.ts` (layout + login code + login link + booker invite + test templates),
`server/lib/settings.ts`, `server/test/helpers.ts` (`makeTestApp()` with a fresh temp DB,
`loginAsBooker(app)`, `loginAsComedian(app, comedianId)` → cookie headers, small factories
`createLocation/createShow/createComedian/...`), `shared/{time,availability,
bookingStatus,types}.ts` (+ unit tests), `client/{index.html,main.tsx,App.tsx,styles.css}`,
`client/lib/{api,queryClient,useMe}.ts`, `client/layouts/{BookerLayout,PortalLayout}.tsx`,
`client/components/ui/*` (Button, Input, Select, Textarea, Label, Dialog, ConfirmDialog,
Badge, Card, Tabs, Spinner, EmptyState, Avatar, ColorDot, PageHeader),
`client/components/MonthGrid.tsx` (shared paintable month calendar: props `month`,
`renderDay(date)`, `isDisabled(date)`, `onPaint(dates[], gesture)`, drag-paint via
pointer events incl. touch with `touch-action: none`, Sun-first, used by F1 create-shows,
F4 portal, F3 read-only view, F1 month calendar), `client/components/ComedianHoverCard.tsx`
(pass-through stub), `client/pages/{setup,login,acceptInvite,notFound}`, and placeholder
pages for every feature route (`client/pages/<feature>/*Page.tsx` exporting a component
that features replace). Route modules for features exist as empty Hono routers that
`app.ts` already mounts, and `startScheduler` exists as a no-op, so features only fill
in their own files.

Feature ownership (files under these paths belong to that feature):
- F1: `server/routes/shows.ts`, `shared/api/shows.ts`, `client/pages/calendar/**`,
  `client/pages/shows/**`
- F2: `server/routes/lineup.ts`, `shared/api/lineup.ts`, `client/pages/day/**`
- F3: `server/routes/comedians.ts`, `shared/api/comedians.ts`, `client/pages/comedians/**`,
  `client/pages/tags/**`, `client/components/ComedianHoverCard.tsx`
- F4: `server/routes/portal.ts`, `shared/api/portal.ts`, `client/pages/portal/**`
- F5: `server/routes/dashboard.ts`, `shared/api/dashboard.ts`, `server/services/**`,
  `server/email/featureTemplates.ts`, `client/pages/dashboard/**`
- F6: `server/routes/settings.ts`, `shared/api/settings.ts`, `client/pages/settings/**`
- Tests: each feature writes `server/routes/<file>.test.ts` (+ service tests) and may add
  pure-logic tests next to its client files.

### Dev & verification harness
- `npm run dev` runs API (tsx watch, `PORT` default 3000) and Vite (`VITE_PORT` default
  5173, proxying `/api` to `http://localhost:$PORT`) together. `DATA_DIR` (default
  `./.data`) holds `club.db`.
- `npm run seed` (`DATA_DIR`-aware) wipes and seeds demo data **relative to today in
  the club timezone**: club "The Laugh Track" (America/New_York), locations "The Cellar"
  and "The Annex", admin `admin@example.com` / `comedy123`, booker
  `booker@example.com` / `comedy123`, ~30 comedians (`firstname@example.com`), tags
  Hosts / All Stars / Bullet Spots / Headliners, Wed–Sun shows for the current and next
  month (Cellar: Fri/Sat 7, 7:30, 9, 11; Thu 8; Wed–Sun mix · Annex: Fri/Sat 6, 8, 10,
  Wed 8 open mic), availability for ~70% of comedians for both months, bookings for this
  week and next with a mix of confirmed / awaiting / not sent including **today's
  unconfirmed** ones, some overrides, and notes. Prints the logins.
- Feature agents verify in isolation without port clashes:
  `DATA_DIR=.data/fN PORT=31N0 npm run seed` then
  `DATA_DIR=.data/fN PORT=31N0 VITE_PORT=51N0 npm run dev` (F1 → 3110/5110, F2 →
  3120/5120 …), and may drive it with an ad-hoc Playwright script (chromium is installed)
  to screenshot their pages. Never run `npm run build` in the feature phase (shared
  `dist/`); use `npm run typecheck` and `npx vitest run <paths>`.
- `npm run typecheck`, `npm test` (vitest), `npm run e2e` (playwright, integration only),
  `npm run build`, `npm start`.

## 8. Visual design *(builder's call)*

Clean, calm, dense-enough booking tool. Tailwind zinc neutrals, one accent (indigo-600 /
indigo-400 in dark), rounded-lg cards with subtle borders, 14px base UI text, system font
stack. Light + dark (prefers-color-scheme). Location palette (assigned in order):
`#7c5cff #f08c2e #14b8a6 #e5484d #3b82f6 #d946ef #84cc16 #eab308`. Status colors:
confirmed emerald, awaiting amber, not sent zinc, unconfirmed-today red. Availability
green = emerald. Every interactive element has hover/focus states; keyboard focus rings.
Mobile: booker app usable on tablet+; portal is mobile-first (≥ 360px wide, 44px touch
targets).

## 9. Left to the builder
Exact component styling, copy polish, empty states, loading skeletons, how pagination
looks (lists are small; no pagination needed under ~500 rows), error toasts.

## 10. Owner decisions and contract changes (fix round, 2026-10-30)

Recorded after the security, correctness and UX reviews. These override the sections above
where they disagree.

### Owner decisions (binding)

1. **Late bookings: daily catch-up.** Every day at `confirmationTimeMin`, comedians with
   scheduled, unconfirmed, undeclined, never-emailed spots this week (Mon–Sun, from now on)
   get their week's confirmation email. Setting `catchUpEnabled`, **on** by default; it
   only runs when automatic confirmations are on. The dashboard and the day board show
   "N booked this week haven't been emailed yet – Send" (`POST /api/confirmations/send
   {weekStart, onlyUnsent: true}`); the nudge, the catch-up and Send count the same spots.
2. **Declines are a booker setting.** `allowDeclines`, **off** by default: confirming is
   all-or-nothing for the week, as originally specified, and comedians reply to the email
   (Reply-To falls back to the first admin's address). On: comedians can decline single
   spots ("Can't make it", optional note ≤ 300 chars) in the portal and from a per-spot
   link in the email (`…/portal/confirm/<token>?decline=<bookingId>`; the GET only opens
   the form). A declined booking keeps its slot, struck through, marked as needing a
   replacement; it is never emailed, stamped, confirmed by "confirm my spots", or counted
   as unconfirmed.
3. **With `allowDeclines` off there is no decline UI anywhere**, including the day board's
   status legend. (A booking declined while it was on still renders as Declined until
   replaced.)

### Contract changes

- **Schema** (migration `0001_declines_catch_up.sql`): `bookings.declinedAt` (ms, nullable),
  `bookings.declineNote` (text, `''`), `settings.catchUpEnabled` (bool, true),
  `settings.allowDeclines` (bool, false). `ClubInfo.allowDeclines` is public club info.
- **Booking status** gains `declined` (wins over every other status). `isUnconfirmed` (not
  confirmed and not declined) and `isUnsent` (also never emailed) are the shared definitions.
- **Club night.** "Tonight" and the red `unconfirmed_today` status use the club *night*
  (`clubNightDate`: yesterday's date until 6 AM club time); calendar logic (past-day
  locking, availability editing) keeps the calendar date. Confirmation emails list only
  spots that haven't started, from tonight through Sunday.
- **Missed sends.** A weekly send that was due but didn't run (server down, schedule just
  changed or switched on) goes out on the next tick while its week isn't over; Settings →
  Confirmations says so before saving (`SettingsDto.confirmationWeeksSent`).
- **Planning month.** Dashboard availability, create-shows, the calendar and copy-pattern
  default to `planningMonth(today)`: next month from the 20th, else this month.
- **After-midnight shows** read "Sun, Nov 8 · 1 AM (early Mon, Nov 9)" to comedians
  (`formatShowWhen` / `formatShowTime`).
- **Lineups.** Dropping a pool comedian, or a comedian from another show, onto a declined
  slot replaces it (`replaced` in the response, for an exact Undo); a cross-show move resets
  confirmation and decline; archived comedians can't be moved into another show (409).
  "Mark confirmed" returns `previous` and clears a decline; `POST /bookings/:id/unconfirm`
  is its Undo. Show time changes re-check `overrideUnavailable`. New bulk endpoints:
  `POST /api/shows/bulk-delete` (Undo of a bulk create; booked shows are kept) and
  `POST /api/shows/bulk-status` (cancel all shows of a day and its Undo; unchanged shows are
  reported as skipped).
- **Security.** Only admins change SMTP/From/Reply-To and `appUrl`; changing the SMTP
  connection clears the stored password. Request bodies ≤ 1 MB; JSON-only, same-origin
  writes. In-memory rate limits on sign-in, codes and password change (per account+IP locks,
  looser per-account backstops, IPv6 by /64, fail closed rather than evict); `TRUST_PROXY`
  decides whether forwarded headers are believed. Bookers can change their password
  (Settings → Account). Confirm-link sessions last 7 days (code sign-in: 90). Changing a
  comedian's email revokes their sessions, links and codes. CSP and other security headers;
  `__Host-` cookies over https.
