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
   spots and a **Confirm my spots** button.
6. **Comedians confirm with one click.** Opening the link only shows the spots; the button
   confirms them (so email scanners can't confirm by accident).
7. **Tonight at a glance.** The dashboard lists, in red, anyone still unconfirmed for
   tonight, with **Resend** and **Mark confirmed** buttons.

## Screens

**Booker app** (`/app`, left nav: Dashboard · Calendar · Comedians · Tags · Settings)

- **Dashboard** — unconfirmed tonight (red), tonight's shows with their lineups, this week
  day by day with **Send confirmations now**, and availability progress for this month and
  next with **Request availability** and **Remind the ones who haven't**.
- **Calendar** (`/app/calendar`) — the month's shows as colored pills per room
  (`7:30 · Cellar · 5/7`), filterable by location. Click a day for its day board, click a
  pill to edit, cancel or delete the show.
- **Create shows** (`/app/shows/new`) — room, optional name, start time and slots; choose
  dates with weekday chips or by click-dragging the calendar, with a live summary.
  Duplicates are skipped. "Copy last month's pattern" previews before it creates.
- **Day board** (`/app/day/:date`) — every show that night, grouped by room, with numbered
  slots and status colors (confirmed / awaiting / not sent / unconfirmed today). The pool
  on the right has search, tag filters and "available only". Drag from the pool to book;
  drop on an occupied slot to replace that comedian (they go back to the pool). Drag a
  booked comedian to move them, or onto another to swap. Drag back to the pool or click ×
  to remove. Removing and replacing both offer **Undo**, which restores the booking
  exactly — confirmation included. Click-to-select then click a slot works too (keyboard
  and touch). Every change saves immediately.
- **Comedians** (`/app/comedians`) — the roster with search, tag filter, archived toggle,
  bulk tag/archive, **Add comedian** and **Bulk add** (paste `Name, email` lines).
  Each **profile** has tags, private notes, a read-only availability calendar, upcoming
  spots, **Send sign-in link**, edit and archive.
- **Tags** (`/app/tags`) — groups like "Hosts" or "Headliners": create, rename, recolor,
  delete. Click one to see its comedians.
- **Settings** (`/app/settings/<tab>`) — **Club** (name, timezone, app address, the
  "All night" range), **Locations**, **Email** (provider, test email, and the email log),
  **Confirmations** (on/off, day and time). Admins also get **Bookers** (invite, roles,
  remove) and **Backup**. The **email log** is admin-only, because it contains comedians'
  sign-in codes and links; other bookers see "Only admins can view the email log".

**Comedian portal** (`/portal`, tabs: Availability · My spots · Profile)

- **Availability** — pick a brush (**All night**, a custom range, or **Not available**),
  then tap or drag across days, or tap a weekday to mark every one. Nothing is saved until
  **Save**. If there are unsaved changes, following a link, pressing Back or Forward, or
  switching months asks you to Save, keep editing or discard. Closing the tab gets the
  browser's "Leave site?" prompt.
- **My spots** — upcoming spots by week, with **Confirm these spots**.
- **Profile** — name, bio and headshot link. Email is read-only.
- **Sign-in links** (`/portal/magic/:token`, from availability requests and "Send sign-in
  link") sign in without a code and are valid for 30 days. **Confirm links**
  (`/portal/confirm/:token`, from the weekly email) work without signing in and expire two
  days after that week ends.

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
docker run -d -p 3000:3000 -v comedy-data:/data --name comedy-booking comedy-booking
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
- HTTPS in front of it. Session cookies get the `Secure` flag when the app URL starts with
  `https://`. Your proxy must pass the original `Host` header (Caddy does by default; for
  nginx add `proxy_set_header Host $host;`).

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
- **Any VPS:** install Docker and run `docker compose up -d`. Put Caddy or nginx in front
  for TLS. With Caddy: `booking.yourclub.com { reverse_proxy localhost:3000 }`.

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
confirmations); portal tests also run in a mobile (touch) browser. To run the specs against a server you already started, point them
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
