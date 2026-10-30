# Comedy Booking Platform

An open-source, self-hosted booking tool for comedy clubs. One deployment runs one club:
its locations, shows, comedian roster, lineups, monthly availability and weekly
confirmations.

- **Bookers** (club staff) sign in with email and password. They set up locations and
  shows, keep a roster with private notes and tags, ask comedians for their monthly
  availability, build lineups by drag and drop, and chase weekly confirmations.
- **Comedians** never need a password. They sign in with a 6-digit code sent to their
  email, or with a link from the club's emails. The portal is built for phones.

It runs as one Node process with one SQLite file. Email goes out over any SMTP provider.
Until email is set up, messages go to an **outbox** you can read inside the app, so you
can try everything first.

## How it works

The app is built around a club's monthly rhythm:

1. **Create next month's shows.** Pick a room, time and slot count, then tap weekday
   chips or drag across the calendar — or copy last month's pattern in one click.
2. **Ask for availability.** From the dashboard, send an availability request to everyone
   or to one tag (say, "Hosts"). Each email has a sign-in link straight to that month.
3. **Comedians mark their nights.** They paint the nights they're free on a month
   calendar ("All night" or a range like 9–11 PM) and press Save.
4. **Build lineups.** Open a night on the day board: every show across your rooms, with
   the comedian pool beside it showing who's free. Drag comedians into slots. Booking
   someone who isn't available asks first ("Book anyway?").
5. **Confirmations go out weekly.** On the day and time you choose (Monday 10 AM by
   default), every comedian with an unconfirmed spot that week gets one email listing their
   spots and a **Confirm my spots** button. Spots booked after that go out in a **daily
   catch-up** at the same time of day.
6. **Comedians confirm with one click.** Opening the link only shows the spots; the button
   confirms them (so email scanners can't confirm by accident). If you allow it, they can
   also say **Can't make it** for a single spot.
7. **Tonight at a glance.** The dashboard lists, in red, anyone still unconfirmed for
   tonight, with **Resend** and **Mark confirmed** buttons, and any declined spot under
   **Needs a replacement**. "Tonight" lasts until 6 AM, so a 1 AM show stays on it.

## Confirmations, late bookings and declines

- **Weekly send.** Settings → Confirmations sets the day and time. One email per comedian
  lists all their spots that week that haven't started yet. If the server was down at send
  time, the send goes out as soon as it's back, as long as that week isn't over. Changing the
  schedule (or turning it on) mid-week can make a send due right away; the Confirmations tab
  says so before you save.
- **Daily catch-up** (`Email late bookings daily`, on by default). Every day at the
  confirmation time, comedians with a spot this week that was booked after the weekly email
  (scheduled, unconfirmed, not declined, never emailed) get their week's email. Until then
  the dashboard and the day board show **"N booked this week haven't been emailed yet –
  Send"** to send them now. Nobody is emailed twice about the same spot.
- **Declines** (`Let comedians decline individual spots`, off by default). Off, confirming
  is all-or-nothing for the week, and a comedian who can't make a spot replies to the email
  (Reply-To falls back to the first admin's address when none is set). On, each spot in the
  email and the portal gets **Can't make it?** with an optional note. The emailed link only
  opens the form; declining is a separate click. A declined spot stays in its slot, struck
  through and marked **Declined — Replace**, and is listed on the dashboard under **Needs a
  replacement**. Pick a comedian from the pool (or drop one from another show) onto it to
  replace it; **Undo** brings the decline back. Declined spots are never emailed or counted
  as unconfirmed, and "confirm my spots" never confirms them. With declines off there is no
  decline UI anywhere; a spot declined while they were on still shows as Declined until you
  replace it.

## Screens

**Booker app** (`/app`, left nav: Dashboard · Calendar · Comedians · Tags · Settings)

- **Dashboard** — a **Getting started** checklist for a new club, unconfirmed tonight (red,
  with **Mark confirmed** and its Undo), **Needs a replacement** (declined spots), tonight's
  shows with their lineups, this week day by day with the catch-up nudge and **Send
  confirmations now**, and availability progress for this month, the month you're planning
  (next month from the 20th) and the one after, with **Request availability** (it shows
  when you last asked and defaults to a reminder for those who haven't answered).
- **Calendar** (`/app/calendar`) — the month's shows as colored pills per room
  (`7:30 · Cellar · 5/7`), filterable by location. Click a day for its day board, click a
  pill to edit, cancel or delete the show. The editor can apply a change to every show at
  the same room, weekday and time that month, and warns when a new time no longer suits a
  booked comedian.
- **Create shows** (`/app/shows/new`) — room, optional name, start time and slots; choose
  dates with weekday chips or by click-dragging the calendar, with a live summary.
  Duplicates are skipped. "Copy last month's pattern" previews before it creates. Both
  offer **Undo** in their success message.
- **Day board** (`/app/day/:date`) — every show that night, grouped by room, with numbered
  slots and status colors (confirmed / awaiting / not sent / unconfirmed today). The pool
  on the right has search, tag filters and "available only". Drag from the pool to book;
  drop on an occupied slot to replace that comedian (they go back to the pool). Drag a
  booked comedian to move them, or onto another to swap. Drag back to the pool or click ×
  to remove. Removing and replacing both offer **Undo**, which restores the booking
  exactly — confirmation included. Click-to-select then click a slot works too (keyboard
  and touch). Every change saves immediately. Select an empty slot (or "Who's free at
  9 PM" in a show's menu) and the pool shows how each comedian fits that time and who is
  already booked within 90 minutes. A note icon on chips and pool cards opens the
  comedian's notes. The menu has **Cancel all shows this day** (with Undo).
- **Comedians** (`/app/comedians`) — the roster with search, tag filter, archived toggle,
  bulk tag/archive/**Send sign-in link**, **Add comedian** and **Bulk add** (paste
  `Name, email` lines; both email new comedians a sign-in link unless you untick it).
  Each **profile** has tags, private notes, a read-only availability calendar, upcoming
  spots, **Send sign-in link**, edit and archive.
- **Tags** (`/app/tags`) — groups like "Hosts" or "Headliners": create, rename, recolor,
  delete. Click one to see its comedians.
- **Settings** (`/app/settings/<tab>`) — **Club** (name, timezone, app address, the
  "All night" range), **Locations**, **Email** (provider, test email, and the email log),
  **Confirmations** (on/off, day and time, the daily catch-up, declines) and **Account**
  (change your password). Admins also get **Bookers** (invite, roles, remove) and
  **Backup**. The **email log** is admin-only, because it contains comedians'
  sign-in codes and links; other bookers see "Only admins can view the email log".

**Comedian portal** (`/portal`, tabs: Availability · My spots · Profile)

- **Availability** — pick a brush (**All night**, a custom range, or **Not available**),
  then tap or drag across days, or tap a weekday to mark every one. Nothing is saved until
  **Save**. If there are unsaved changes, following a link, pressing Back or Forward, or
  switching months asks you to Save, keep editing or discard. Closing the tab gets the
  browser's "Leave site?" prompt. **Undo** and **Discard** sit next to Save.
- **My spots** — upcoming spots by week, with **Confirm these spots** (and **Can't make
  it?** per spot when the club allows declines). The tab shows how many are left to
  confirm. Spots after midnight say so: "1 AM (early Sat, Nov 7)".
- **Profile** — name, bio and headshot link. Email is read-only.
- **Sign-in links** (`/portal/magic/:token`, from availability requests and "Send sign-in
  link") sign in without a code and are valid for 30 days. **Confirm links**
  (`/portal/confirm/:token`, from the weekly email) work without signing in and expire two
  days after that week ends. Confirming from one signs the comedian in for 7 days (a code
  gives 90).

## Quick start with Docker

```sh
git clone <this repo> comedy-booking && cd comedy-booking
docker compose up -d
```

Open <http://localhost:3000>. The first visit runs a short setup wizard: club name,
timezone, your first location and your admin account. The address you run the wizard
from is saved as the base URL for links in emails. You can change it later in
Settings → Club.

Data lives in the `club-data` volume (`/data/club.db` in the container). Migrations run
automatically on start, so upgrading is:

```sh
git pull && docker compose up -d --build
```

Without Compose:

```sh
docker build -t comedy-booking .
docker run -d -p 127.0.0.1:3000:3000 -v comedy-data:/data --name comedy-booking comedy-booking
```

### Try it with demo data

The seed script **wipes the database** and fills it with a demo club, "The Laugh Track":
two rooms, 30 comedians, shows this month and next, and bookings for this week and next,
including some unconfirmed spots tonight. Everything is relative to today, so the dashboard
always has something to show.

```sh
docker compose exec app node dist/server/seed.js
```

| Who | Sign in at | Credentials |
|---|---|---|
| Admin | `/login` | `admin@example.com` / `comedy123` |
| Booker | `/login` | `booker@example.com` / `comedy123` |
| Comedians | `/portal/login` | first name @example.com: `john@example.com`, `jason@example.com`, `maria@example.com`, … |

Comedians sign in with a code. With no email set up, read it from the outbox (see below)
or the server log (`docker compose logs app`).

## Local development

You need Node 24 or newer, and npm.

```sh
npm install
npm run seed     # demo data in ./.data/club.db (optional; skip it to run the setup wizard)
npm run dev      # API on :3000 + Vite on :5173 → open http://localhost:5173
```

`npm run dev` runs the API (`tsx watch`) and Vite together; Vite proxies `/api` to the
API. Settings can come from the environment or a `.env` file (see `.env.example`). Real
environment variables win.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | API port (and the whole app in production) |
| `VITE_PORT` | `5173` | Vite dev server port (`npm run dev` only) |
| `DATA_DIR` | `./.data` | Folder holding `club.db` (`/data` in Docker) |
| `APP_URL` | (none) | Base URL for email links when Settings → Club has none |
| `TRUST_PROXY` | (none) | Number of reverse proxies in front of the app (usually `1`). See [Security](#security) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM_EMAIL`, `SMTP_FROM_NAME`, `SMTP_REPLY_TO` | (none) | Fallback SMTP settings, used only when Settings → Email has no host |

To run several copies side by side, give each its own data folder and ports. Pass the same
variables to `seed`, so the demo club's email links point at your port:

```sh
DATA_DIR=.data/other PORT=3100 VITE_PORT=5100 npm run seed
DATA_DIR=.data/other PORT=3100 VITE_PORT=5100 npm run dev
```

### Reading sign-in codes in development

With no email configured, every email (sign-in codes, sign-in links, availability
requests, confirmations, invites) goes to the outbox. You can read it three ways:

- the **server console**, where each outbox email is printed in a box;
- **Settings → Email → Email log**, signed in as an admin (`admin@example.com`);
- the database: `sqlite3 .data/club.db "select body_text from email_log order by id desc limit 1"`.

### Scripts

| Command | What it does |
|---|---|
| `npm run dev` | API + Vite with reload |
| `npm run seed` | Wipe `$DATA_DIR/club.db` and load demo data |
| `npm run typecheck` | TypeScript, server and client |
| `npm test` | Unit and API tests (Vitest; each test gets its own throwaway database) |
| `npm run e2e` | Playwright end-to-end tests against a freshly seeded copy (see [Tests](#tests)) |
| `npm run build` | Client to `dist/client`, server to `dist/server` |
| `npm start` | Run the production build (serves the client too) |
| `npm run db:generate` | Create a migration after editing `server/db/schema.ts` |

### Project layout

```
client/   React app (Vite, React Router, TanStack Query, Tailwind CSS)
server/   Hono API, Drizzle + SQLite, auth, email, scheduler
shared/   Code used by both: date/time helpers, availability rules, zod schemas, API types
e2e/      Playwright tests
docs/     Design spec
```

## Email

The app sends sign-in codes, sign-in links, availability requests and reminders, weekly
confirmations and booker invites. Configure it in **Settings → Email**, then press
**Send test email**. Any SMTP provider works; the app has presets for these:

- **Gmail / Google Workspace** — turn on 2-Step Verification, create an App Password at
  <https://myaccount.google.com/apppasswords>, and use host `smtp.gmail.com`, port `465`,
  secure on, your full address as the username and the 16-letter app password. Gmail sends
  roughly 500 emails a day (2,000 with Workspace), which is plenty for most clubs.
- **Resend** — verify your domain at <https://resend.com>, create an API key, and use host
  `smtp.resend.com`, port `465`, username `resend`, password = the API key. The From
  address must be on your verified domain.
- **Postmark** — use your Server API token as both username and password.
- **Custom** — any server name, port (usually 465 or 587), username and password.

If a send fails, the test shows the server's error with a plain-language hint. SMTP
connections time out after 10 seconds (20 seconds of silence once connected), so a wrong
host can't stall the weekly confirmation run.

Until email is set up, every message is stored in the outbox instead
([see above](#reading-sign-in-codes-in-development)), so an admin can still copy a sign-in
code or invite link by hand. Invite links are also shown on screen when you invite a
booker.

Weekly confirmation emails go out on the day and time set in **Settings → Confirmations**
(Monday 10 AM club time by default). Each covers the Monday-to-Sunday week starting on or
after that day and goes only to comedians with an unconfirmed spot who haven't been emailed
for that week yet; the automatic send runs once per week. **Send confirmations now** on the dashboard sends the current week straight
away (you can limit it to comedians who haven't been emailed yet).

## Deploying

The app is a single container. It needs:

- a persistent volume mounted at `/data` (the SQLite file lives there);
- port `3000` (or set `PORT`);
- HTTPS in front of it. Session cookies are `Secure` (and `__Host-` prefixed) when the app
  URL starts with `https://`. Your proxy must pass the original `Host` header (Caddy does by
  default; for nginx add `proxy_set_header Host $host;`);
- `TRUST_PROXY=1` when that proxy (or a platform router, as on Railway, Render and Fly) sits in
  front, so sign-in rate limits see each visitor's own IP. See [Security](#security).

Run the setup wizard from your real public URL, or set it later in Settings → Club (or with
`APP_URL`), so links in emails point to the right place. Run **one** instance only: SQLite
and the scheduler are single-node by design. The container has a health check on
`/api/health`.

- **Railway:** create a service from this repo (it builds the Dockerfile), add a volume
  mounted at `/data`, and generate a domain.
- **Render:** create a Web Service from the repo with the Docker runtime, add a persistent
  disk mounted at `/data` (this needs a paid instance), and set the health check path to
  `/api/health`.
- **Fly.io:** run `fly launch` (it detects the Dockerfile), then
  `fly volumes create data --size 1`, and add `[mounts] source = "data"`,
  `destination = "/data"` to `fly.toml`. Keep one machine.
- **Any VPS:** install Docker and run `docker compose up -d`. Compose publishes the port on
  `127.0.0.1` only, so put Caddy or nginx in front for TLS and set `TRUST_PROXY=1`. With Caddy:
  `booking.yourclub.com { reverse_proxy localhost:3000 }`.

## Security

What the app does for you, and what you need to set up:

- **Accounts.** Bookers sign in with a password (bcrypt; `BCRYPT_ROUNDS`, default 10) and
  can change it under **Settings → Account**, which signs them out everywhere else.
  Comedians never have a password: they get a 6-digit code (10 minutes, one live code at a
  time) or a link by email. Changing a comedian's email ends their sessions and kills links
  and codes sent to the old address.
- **Admins vs bookers.** Only admins can change email settings (SMTP server, password, From,
  Reply-To) and the app address, read the email log (it holds sign-in codes), manage
  bookers and download backups. A booker can send a test email only to themselves. The SMTP
  password is never sent back to the browser, and changing the server, port, security or
  username removes it unless it's typed again, so it's only ever sent to the server it was
  entered for.
- **Rate limits** (in memory, reset on restart), per 15 minutes unless noted. Booker
  sign-in: 10 wrong passwords per account from one IP, 100 per account from anywhere, and 30
  per IP. Locks are per IP, so someone guessing your password can't lock you out from your
  own connection. Comedian codes: 20 code requests per IP, and at most 1,000 code emails an
  hour for the whole club (protects your SMTP quota; past it the request still answers
  normally but nothing is sent). Each comedian gets at most 5 codes per 15 minutes, and only
  the newest one works. Wrong codes: 10 per email from one IP, 100 per email, 50 per IP.
  Changing a password: 5 wrong tries. Over a limit the API answers `429` with `retryAfter`
  (seconds). Limits treat unknown emails exactly like real ones, so nothing reveals who has
  an account. IPv6 visitors are counted per /64 network, and a flood of new addresses can't
  push out existing counters (new ones are refused instead). `npm run dev` allows 10× more.
- **`TRUST_PROXY`.** Behind a reverse proxy every request comes from the proxy, so set
  `TRUST_PROXY=1` (or the number of proxies) to take the visitor's IP from
  `X-Forwarded-For` and https from `X-Forwarded-Proto`. Leave it unset when the app is
  reachable directly: anyone could then send those headers and pick their own IP.
- **Browser protections.** Session cookies are `HttpOnly`, `SameSite=Lax`, and over https
  `Secure` with the `__Host-` prefix (no other subdomain can set them). Writes must be JSON
  from the same origin (cross-site and sibling-subdomain posts get `403`). Responses carry
  a Content-Security-Policy (scripts only from the app, never framed by another site),
  `X-Frame-Options: DENY`, `nosniff` and `Referrer-Policy: no-referrer` (emailed links carry
  tokens in their path). API request bodies are capped at 1 MB.
- **Your part:** serve it over HTTPS, keep the port private behind your proxy (Compose
  binds `127.0.0.1:3000`), set `TRUST_PROXY`, back up `/data`, and keep the admin list
  short.

## Backups

Everything is in one SQLite database. Admins can download a consistent snapshot any time
from **Settings → Backup**.

From the host, while the app is running:

```sh
docker compose exec app node -e "require('better-sqlite3')('/data/club.db').exec(\"VACUUM INTO '/data/backup.db'\")"
docker compose cp app:/data/backup.db ./club-$(date +%F).db
docker compose exec app rm /data/backup.db
```

To restore, stop the app, replace `club.db` in the volume with your backup (and delete any
`club.db-wal` / `club.db-shm` next to it), then start the app again.

## Tests

```sh
npm run typecheck
npm test                              # Vitest: unit + API tests
npx playwright install chromium       # once, before the first e2e run
npm run e2e                           # Playwright
```

`npm run e2e` seeds an isolated database in `.data/e2e` and starts the app on ports
3999 (API) and 5999 (Vite), so it never touches your dev data. `e2e/journey.spec.ts` walks
the whole monthly rhythm (shows → availability request → comedian paints → lineup →
confirmations); `e2e/declines.spec.ts` turns declines on, declines a spot from the emailed
link, replaces it on the day board and checks that no decline UI is left once they're off.
Portal tests also run in a mobile (touch) browser. To run the specs against a server you already started, point them
at it and at its data folder (they read sign-in codes from its email log, and they change
data, so use a freshly seeded copy):

```sh
E2E_BASE_URL=http://localhost:5100 E2E_DATA_DIR=.data/other npx playwright test
```

## Tech

TypeScript throughout: Hono, Drizzle ORM, better-sqlite3, zod, nodemailer and bcryptjs on
the server; React 19, React Router 7, TanStack Query 5, Tailwind CSS 4, Radix UI, dnd-kit
and Sonner on the client. Vitest and Playwright for tests.

## License

[MIT](LICENSE)
