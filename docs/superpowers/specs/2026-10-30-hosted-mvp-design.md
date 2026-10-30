# Hosted MVP: many clubs on one server, company/booker email, owner console — Design

Date: 2026-10-30. Status: approved by owner ("Sounds good. Ship it."). Builds on
`2026-10-28-comedy-booking-platform-design.md` and `2026-10-30-onboarding-and-csv-import-design.md`
(their conventions apply). Items marked *(builder's call)* were decided without the owner;
everything else came from the owner.

## 1. Why

The owner wants to run the platform live for **3–4 bookers they know personally**. A
booker should be able to sign up and start using the app on their own. Emails need to
work out of the box, and the owner needs a private console to watch the accounts and
suspend or archive them. The owner pays the hosting bills. Charging clubs comes later, so
nothing involving money is built now. "MVP mode": small, cheap, solid.

**Accounts (owner, hard rule):** everything uses the owner's **personal** GitHub
(`Desitrain22`) and personal email. Nothing uses the Avoca work accounts, work email or
work-connected services.

## 2. Goals, non-goals, anti-goals

**Goals**
- One public website. A booker signs up, picks their company's web address
  (`broadway.<domain>`), and lands in the existing setup guide.
- A company can have several bookers and several locations. In the owner's example, Rich
  Brooks and Eric Hanson book Broadway Comedy Club and Greenwich Village for one company.
  This already works inside one club account: one account, two locations, two bookers,
  one roster.
- Emails go out from day one with zero setup. The company can choose who emails come from.
- An owner console for watching clubs, their bookers and usage, and for suspending,
  archiving and restoring accounts.
- Live on the internet, with backups.

**Non-goals (now):** billing, plans, usage limits for pricing; custom domains per club;
deleting clubs permanently (archive only); reading replies inside the app; SMS; a
marketing site beyond one landing screen; "Sign in with Google/Microsoft" for mailboxes
(Google's security review for apps that send mail on a user's behalf takes weeks).

**Anti-goals:** one club seeing or affecting another club's data; one club's mistakes
(or abuse) getting the shared sending domain blocked; breaking the existing self-hosted,
single-club install (the repo stays open source and self-hostable).

## 3. Tenancy: one database file per club *(builder's call; owner liked subdomain routing)*

- **Two modes.** With no `PLATFORM_URL` set, the app behaves exactly as today: one club
  per install, `/setup` wizard, `$DATA_DIR/club.db`. Every existing test keeps passing
  unchanged. With `PLATFORM_URL=https://<domain>` set, it runs in **hosted mode**.
- **Hosted layout** under `$DATA_DIR`:
  - `platform.db`: the registry (clubs, owner-console sessions and codes, signup handoffs,
    the platform email log, the admin event log).
  - `clubs/<clubId>.db`: one database per club, using the existing schema and migrations
    unchanged.
  - `backups/<YYYY-MM-DD>/`: nightly copies.
- **Routing by host name.**
  - `<domain>` and `www.<domain>` serve the **platform site**: landing page, sign-up,
    "find my club", and the owner console at `/admin`.
  - `<slug>.<domain>` serves **that club's app**: every existing route and screen, the
    booker app and the comedian portal.
  - The middleware resolves the slug in the registry, opens (and caches) that club's
    database, and sets `c.var.db`. Every route already reads the database from `c.var.db`,
    so feature code doesn't change.
- **Isolation** comes free from the existing cookies. Over https they are
  `__Host-` prefixed and host-only, so `broadway.<domain>` cookies never reach
  `comedycellar.<domain>`. CSRF is already same-origin only. Rate limiters are already
  per database.
- **Unknown or archived slug:** a "There's no club at this address" page linking to the
  platform. The API returns 404 with code `club_not_found`.
- **Suspended club:** every club API call except `GET /api/host` returns 403 with code
  `club_suspended`. Bookers and comedians, including people arriving from emailed links,
  see an "This account is paused. Contact <support email>" page. The scheduler skips the
  club and no email goes out. Data stays as it is.
- **Club address (`slug`):** 3–30 characters from `a-z 0-9 -`, with no hyphen at either end.
  A reserved list blocks names like `www admin app api mail smtp support help status blog
  docs static assets cdn platform signup login dev staging test`. The slug can't be changed
  in the MVP *(builder's call)*. `settings.appUrl` for the club is set to
  `https://<slug>.<domain>` at sign-up and isn't editable in hosted mode, so email links
  always point at the right club.
- **People in two clubs:** a comedian or booker at two clubs has a separate login at each
  (owner agreed).
- **Local dev:** `PLATFORM_URL=http://localhost:3000` gives clubs at
  `http://<slug>.localhost:3000`, since Chrome and Firefox resolve `*.localhost` to this
  machine. Playwright's Chromium does the same.

## 4. Sign-up and getting in

- **Landing page** (`/` on the platform host): one screen. The platform name
  (`PLATFORM_NAME`, default "Comedy Booking"), one line on what it does, **Create your
  club**, **Sign in**, and a link to the open-source repo.
- **Sign-up** (`/signup`) asks for:
  - company name
  - web address (prefilled from the name, editable, checked live; shows `broadway.<domain>`)
  - timezone (defaulting to the browser's)
  - first location name and an optional address
  - your name, email and password
  - a hidden honeypot field
  
  `POST /api/platform/signup` does the following:
  1. Validates the input and rate-limits by IP (5 per hour).
  2. Creates the registry row and the club database, then runs the same setup logic as
     `/api/setup`, extracted into a shared service. That creates the admin booker, the
     first location and the settings, with `appUrl` set to the club URL.
  3. Emails the owner ("New club: Broadway Comedy — broadway.<domain> — Rich Brooks
     <rich@…>").
  4. Returns a **handoff URL**.
- **Handoff:** the browser goes to `https://<slug>.<domain>/welcome#<token>`.
  - The token is one-time, expires in 2 minutes, and is stored hashed in `platform.db`.
  - The page posts it to `POST /api/auth/handoff`. That checks the token belongs to this
    club and hasn't been used, then creates a normal booker session cookie on the club host.
  - It then lands where the setup wizard lands today: the guided "Shows" step.
- **Sign-ups switch** *(builder's call)*: `SIGNUPS=open` (default) or `closed`. When
  closed, the sign-up page says sign-ups are closed and gives the support email. Open
  sign-up is fine because the owner is told about every new club and can suspend one in a
  click.
- **"Find my club" (`/signin` on the platform host):**
  1. The visitor enters an email address and always sees "If that address has an account,
     we've emailed you a link."
  2. The server looks for active clubs where the address is a booker or a comedian.
  3. It emails one message listing each club with its sign-in link: `/login` for bookers,
     `/portal/login` for comedians.
- **Club hosts in hosted mode:** `/setup` is never needed, because sign-up has already
  finished setup, so the existing gate redirects it. Booker invites, comedian codes and
  magic links all work as today, on the club host.

## 5. Email: company or booker sender (owner)

- **Club setting `senderMode`:** `company` (default) or `booker`.
  - **Company:** every email comes from the company. "Company email" is the existing
    `replyTo` field, shown as **Company email** (e.g. booking@bwaygroup.com). Replies go
    there.
  - **Booker:**
    - Availability requests come from the booker who pressed Send.
    - Confirmation emails (the weekly send, the daily catch-up, "send now" and resends)
      come from the booker who booked **every** spot in that email (`bookings.bookedById`).
      If two bookers share a comedian's week, or the booker was removed, it comes from the
      company.
    - Sign-in codes, magic links and booker invites always come from the company.
- **How a message goes out.** `sendEmail` takes an optional `senderUserId`. The sender is
  resolved like this:

  | Sender | Connected mailbox | Goes out as | Reply-To |
  |---|---|---|---|
  | company | company mailbox (Settings → Email SMTP) | `"<fromName‖club name>" <company mailbox address>` | company email ‖ mailbox address |
  | company | none, platform sender configured (`SMTP_*` env) | `"<club name>" <SMTP_FROM_EMAIL>` | company email ‖ first admin's email |
  | booker U | U's own mailbox (new per-booker SMTP) | `"<U.name> · <club>" <U's mailbox address>` | U.email |
  | booker U | no own mailbox, company mailbox connected | `"<U.name> · <club>" <company mailbox address>` | U.email |
  | booker U | neither, platform sender | `"<U.name> · <club>" <SMTP_FROM_EMAIL>` | U.email |
  | any | nothing configured | outbox (as today) | — |

  In hosted mode the platform sender's `SMTP_FROM_NAME` never overrides club names. In
  single-club mode the current env fallback behaviour stays as it is.
- **The platform sender** is a transactional provider reached over SMTP, so no new
  dependency is needed. The recommendation is Resend: `smtp.resend.com:465`, user
  `resend`, password = API key, with a verified sending domain such as `mail.<domain>`.
- **Daily cap per club** *(builder's call; protects the shared sending domain)*. In hosted
  mode, platform-sender emails are capped per club per club-local day at
  `PLATFORM_DAILY_EMAIL_CAP` (default 2000). Over the cap, a message is logged as `failed`
  with "Daily email limit reached — contact support". Mailboxes a club connects itself
  don't count towards it.
- **Per-booker mailbox (booker mode):** under Settings → Account, a booker can connect
  their own mailbox using the same provider presets, Test and Disconnect as the company
  form. That form lives under Settings → Email.
- **Passwords at rest** *(builder's call)*. When `APP_SECRET` is set (required in hosted
  mode), mailbox passwords are encrypted with AES-256-GCM and stored as
  `enc:v1:<iv>:<tag>:<data>`. Older plaintext values still read correctly. The API never
  returns them, as today.
- **Email log** gains `via` (`company-mailbox` | `booker-mailbox` | `platform` | `outbox`)
  and `senderUserId`, for the console and the cap.
- **Settings → Email UI:**
  - A "Who emails come from" choice (Company / Each booker).
  - The company email field.
  - A one-line preview of what comedians see ("From: Broadway Comedy
    <bookings@mail.…> · Replies go to booking@bwaygroup.com").
  - The existing **Connect a mailbox** form, framed as optional: "to send from your own
    address and keep a copy in your Sent folder".

## 6. Owner console (`/admin` on the platform host)

- **Sign-in:**
  1. The owner enters an email listed in `PLATFORM_ADMIN_EMAILS` (the owner's personal
     address) and gets a 6-digit code by email (10 minutes, 5 tries). Other addresses get
     the same response but no email.
  2. The code gives a host-only cookie `__Host-cbp_platform` (over http, `cbp_platform`)
     that lasts 7 days.
  3. This is rate-limited by IP and by email. In dev, codes print to the console and land
     in the platform email log.
- **Overview (`/admin`):**
  - Totals: clubs (active, suspended, archived), bookers, comedians, upcoming shows, and
    emails sent in the last 7 and 30 days.
  - A table of clubs, searchable, with Active as the default filter (Suspended, Archived
    and All are the others). Columns:
    - club name, linking to its address
    - status
    - created
    - owner booker (name and email)
    - number of bookers
    - last active (the latest booker sign-in or booking)
    - locations
    - comedians
    - upcoming shows (next 30 days)
    - emails sent in the last 30 days, with failures highlighted
    - sender mode, and whether a mailbox is connected
- **Club detail (`/admin/clubs/:id`):**
  - Bookers: name, email, role, last sign-in, whether an invite is pending.
  - Locations.
  - Usage by week for the last 8 weeks: emails sent and failed, bookings made, and
    availability submissions.
  - The last 10 failed emails, with the subject, recipient, error and time (not bodies,
    which hold sign-in links).
  - Database size.
  - Status history from the admin event log.
- **Actions:**
  - **Suspend**, with an optional reason that the owner sees in the console.
  - **Reactivate**.
  - **Archive**, which asks the owner to type the club's address to confirm. Archiving
    closes the database and hides the club; its address stays reserved.
  - **Restore**, which brings the club back as active.
  - **Download backup**: a consistent `.db` snapshot.
  
  Every action is written to `admin_events`: who, what, when and the reason.
- **No impersonation in the MVP** *(builder's call)*.

## 7. Hosting and the database *(builder's call; owner: "figure something out")*

- **Fly.io:**
  - One always-on machine (shared-cpu-1x, 512 MB, region `iad`), never auto-stopped,
    because the in-process scheduler sends weekly confirmations.
  - A 1 GB volume at `/data` holding the SQLite files.
  - The machine is built from the existing Dockerfile by Fly's remote builder, so no local
    Docker is needed.
  - Health check: `/api/health`.
  - `TRUST_PROXY=1`.
- **Why SQLite on a volume and not managed Postgres:** the app is built on synchronous
  SQLite. One file per club is the simplest strong isolation, and at 3–4 clubs (and well
  beyond) one small machine is plenty. Moving to Postgres would mean rewriting every query
  for no MVP benefit.
- **Backups, in two layers:**
  1. Fly's daily volume snapshots, with retention raised to 14 days.
  2. A nightly in-app job (03:30 UTC, or the first tick after it) copies `platform.db` and
     every non-archived club database with SQLite's online backup into
     `$DATA_DIR/backups/<date>/`, keeping 14 days.
  
  The console's per-club **Download backup** gives an off-site copy on demand. A restore
  runbook goes in DEPLOY.md.
- **Domain and DNS:** the owner buys a domain using their personal accounts (e.g.
  Cloudflare Registrar). DNS points:
  - the root (apex) and `*` (wildcard) records at the Fly app
  - a `_acme-challenge` CNAME for Fly's wildcard certificate
  - Resend's records for the sending subdomain
- **Deploys:**
  - GitHub Actions `ci.yml` runs typecheck, unit/API tests and the build on every PR and
    every push to main.
  - `deploy.yml` runs `flyctl deploy --remote-only` on pushes to main once the
    `FLY_API_TOKEN` repo secret exists, and skips cleanly without it.
- **Secrets (Fly):** `PLATFORM_URL`, `PLATFORM_NAME`, `PLATFORM_ADMIN_EMAILS`,
  `SUPPORT_EMAIL`, `APP_SECRET`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`,
  `SMTP_PASS`, `SMTP_FROM_EMAIL`, `SIGNUPS`, `PLATFORM_DAILY_EMAIL_CAP`.
- **Rough monthly cost** (to be checked in DEPLOY.md):
  - Fly: about $4–6 (machine, volume, certificates).
  - Domain: about $10–15 a year.
  - Resend: free while testing (100 a day, 3,000 a month), then $20 a month before real
    availability blasts.
- **What only the owner can do** (personal accounts and payment): create the
  Fly.io, Cloudflare and Resend accounts, buy the domain, and run `fly auth login`.
  Everything else is scripted in `docs/DEPLOY.md`.

## 8. Build plan (PRs)

Each PR is green on `npm run typecheck`, `npm test` and `npm run build`, plus the e2e
projects it touches, before it merges.

1. **Hosted mode: one server, many clubs.** Covers:
   - the platform registry and its migrations
   - host routing and the tenancy middleware
   - the club database cache
   - `GET /api/host`
   - suspended and archived enforcement
   - sign-up, handoff and find-my-club
   - the platform mailer (owner notifications, find-my-club)
   - the multi-club scheduler
   - client host context, the platform site pages, and the paused and no-club pages
   - a hosted e2e project: sign up, then the guide, then a second club stays isolated
2. **Email: company or booker sender.** Covers `senderMode`, per-booker mailboxes, sender
   resolution, attribution on confirmations and availability requests, encryption, the
   cap, the email log `via`, the Settings → Email and Account UI, and tests. It works in
   single-club mode too.
3. **Owner console.** Covers admin auth, the overview, club detail, the actions, the event
   log and backup download, and an e2e test (sign in → suspend → the club shows paused →
   reactivate).
4. **Deploy.** Covers `fly.toml`, the CI and deploy workflows, the nightly backup job,
   `docs/DEPLOY.md` (runbook, DNS, secrets, costs, restore) and README "Hosted" notes.

Schema contracts (club migration `0003`, platform migration `0000`, env additions,
shared types) land first, so PRs 1 and 2 can be built in parallel.

## 9. Done means

- All four PRs are merged to `main` on `Desitrain22/Comedy-Booking-Platform` with green
  checks. The single-club install still works (all existing tests pass).
- A hosted-mode local run shows: sign-up → guide → a second club stays isolated → a
  suspended club is paused → the owner console works.
- `docs/DEPLOY.md` lets the owner go live in about 30 minutes, once the accounts exist.
