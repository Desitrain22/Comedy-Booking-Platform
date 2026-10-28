# Comedy Booking Platform

An open-source, self-hosted booking tool for comedy clubs. One deployment runs one club:
its locations, shows, comedian roster, lineups, monthly availability and weekly
confirmations.

- **Bookers** (club staff) sign in with email and password. They set up locations and
  shows, keep a roster with private notes and tags, ask comedians for their monthly
  availability, build lineups by drag and drop, and chase weekly confirmations. The
  dashboard shows tonight's unconfirmed comedians in red.
- **Comedians** never need a password. They sign in with a 6-digit code sent to their
  email, or with a link from the club's emails, then paint their availability on a month
  calendar, keep their profile up to date, and confirm their spots. The portal is built
  for phones.

It runs as one Node process with one SQLite file. Email goes out over any SMTP provider.
Without email configured, messages go to an outbox you can read inside the app, so you
can try everything before setting email up.

## Quick start with Docker

```sh
git clone <this repo> comedy-booking && cd comedy-booking
docker compose up -d
```

Open <http://localhost:3000>. The first visit runs a short setup wizard: club name,
timezone, your first location and your admin account. The URL you run the wizard from
is saved as the base URL for links in emails. You can change it later in
Settings → Club.

Data lives in the `club-data` volume, mounted at `/data/club.db` in the container.
Migrations run automatically when the server starts, so upgrading is:

```sh
git pull && docker compose up -d --build
```

Without Compose:

```sh
docker build -t comedy-booking .
docker run -d -p 3000:3000 -v comedy-data:/data --name comedy-booking comedy-booking
```

### Try it with demo data

The seed script **wipes the database** and fills it with a demo club ("The Laugh Track",
two rooms, about 30 comedians, shows this month and next, bookings for this week and next,
including some unconfirmed spots tonight):

```sh
docker compose exec app node dist/server/seed.js
```

| Who | Sign in at | Credentials |
|---|---|---|
| Admin | `/login` | `admin@example.com` / `comedy123` |
| Booker | `/login` | `booker@example.com` / `comedy123` |
| Comedians | `/portal/login` | `john@example.com`, `jason@example.com`, `maria@example.com`, … |

Comedians sign in with a code. With no email configured, find it under
Settings → Email log, or in the server log (`docker compose logs app`).

## Local development

You need Node 24 and npm.

```sh
npm install
npm run seed     # demo data in ./.data/club.db (optional; skip it to run the setup wizard)
npm run dev      # API on :3000 + Vite on :5173 → open http://localhost:5173
```

`npm run dev` runs the API (`tsx watch`) and Vite together. Vite proxies `/api` to the
API. Every setting can come from the environment or a `.env` file (see `.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | API port (and the whole app in production) |
| `VITE_PORT` | `5173` | Vite dev server port |
| `DATA_DIR` | `./.data` | Folder holding `club.db` |
| `APP_URL` | (none) | Fallback base URL for email links when Settings has none |
| `SMTP_*` | (none) | Fallback SMTP settings (see `.env.example`) |

To run several copies side by side, give each its own data folder and ports:

```sh
DATA_DIR=.data/other PORT=3100 VITE_PORT=5100 npm run seed
DATA_DIR=.data/other PORT=3100 VITE_PORT=5100 npm run dev
```

| Command | What it does |
|---|---|
| `npm run dev` | API + Vite with reload |
| `npm run seed` | Wipe `$DATA_DIR/club.db` and load demo data |
| `npm run typecheck` | TypeScript, server and client |
| `npm test` | Unit and API tests (Vitest; each test gets its own database) |
| `npm run e2e` | Playwright smoke tests against a freshly seeded copy on ports 3999/5999 |
| `npm run build` | Client to `dist/client`, server to `dist/server` |
| `npm start` | Run the production build (serves the client too) |
| `npm run db:generate` | Create a migration after editing `server/db/schema.ts` |

The first time you run `npm run e2e`, install the browser with `npx playwright install chromium`.

### Project layout

```
client/   React app (Vite, React Router, TanStack Query, Tailwind CSS)
server/   Hono API, Drizzle + SQLite, auth, email, scheduler
shared/   Code used by both: date/time helpers, availability rules, zod schemas, types
e2e/      Playwright tests
docs/     Design spec
```

## Email

The app sends sign-in codes, sign-in links, availability requests, weekly confirmations
and booker invites. Configure it in **Settings → Email**, then use **Send test email**.
Any SMTP provider works.

**Gmail or Google Workspace**

1. Turn on 2-Step Verification for the Google account.
2. Create an App Password at <https://myaccount.google.com/apppasswords>.
3. In Settings → Email choose *Gmail / Google Workspace*: host `smtp.gmail.com`, port
   `465`, secure on, username = the full email address, password = the 16-character app
   password.

Gmail limits how much you can send each day (roughly 500 messages for personal accounts,
more for Workspace). That's plenty for most clubs.

**Resend**

1. Add and verify your domain at <https://resend.com>.
2. Create an API key.
3. In Settings → Email choose *Resend*: host `smtp.resend.com`, port `465`, secure on,
   username `resend`, password = the API key. The From address must be on your verified
   domain.

Postmark and other providers work the same way with their SMTP details.

Until email is set up, every message is stored with status `outbox`. You can read it
under Settings → Email log, and it's also printed to the server console. That way you can
still copy a sign-in code or invite link by hand.

Weekly confirmation emails go out automatically on the day and time set in
Settings → Confirmations (Monday 10 AM club time by default). Each one covers the coming
Monday to Sunday.

## Backups

Everything is in one SQLite database. Admins can download a consistent snapshot any time
from **Settings → Backup**.

From the host, while the app is running:

```sh
docker compose exec app node -e "require('better-sqlite3')('/data/club.db').exec(\"VACUUM INTO '/data/backup.db'\")"
docker compose cp app:/data/backup.db ./club-$(date +%F).db
docker compose exec app rm /data/backup.db
```

To restore, stop the app, replace `club.db` in the volume with your backup (and delete
any `club.db-wal` / `club.db-shm` next to it), then start the app again.

## Deploying

The app is a single container that needs:

- a persistent volume mounted at `/data`,
- port `3000` (or set `PORT`),
- HTTPS in front of it. Cookies get the `Secure` flag when the saved app URL starts with
  `https://`.

Run the setup wizard from your real public URL, or set the URL later in Settings → Club,
so links in emails point to the right place. Run **one** instance only: SQLite and the
scheduler are single-node by design.

- **Railway:** create a service from this repo (it builds the Dockerfile), add a volume
  mounted at `/data`, and generate a domain.
- **Render:** create a Web Service from the repo with the Docker runtime, add a persistent
  disk mounted at `/data` (this needs a paid instance), and set the health check path to
  `/api/health`.
- **Fly.io:** run `fly launch` (it detects the Dockerfile), then
  `fly volumes create data --size 1`, and add `[mounts] source = "data"`,
  `destination = "/data"` to `fly.toml`. Keep one machine.
- **Any VPS:** install Docker and run `docker compose up -d`. Put Caddy or nginx in front
  for TLS. For example, with Caddy: `booking.yourclub.com { reverse_proxy localhost:3000 }`.

## Tech

TypeScript throughout: Hono, Drizzle ORM, better-sqlite3, zod, nodemailer and bcryptjs on
the server; React 19, React Router 7, TanStack Query 5, Tailwind CSS 4, Radix UI, dnd-kit
and Sonner on the client. Vitest and Playwright for tests.

## License

[MIT](LICENSE)
