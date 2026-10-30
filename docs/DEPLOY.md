# Deploying the hosted platform

This runbook puts the platform on the internet at a domain you own. On that domain:

- `yourdomain.com` is the sign-up site and your owner console (`/admin`).
- Every club gets its own address: `broadway.yourdomain.com`, `comedycellar.yourdomain.com`, and so on.

It all runs on **one small Fly.io machine**, with every club's database on one disk. Email goes through **Resend**.

> **Use your personal accounts for everything below.** That means your personal email, card and GitHub (`Desitrain22`). Don't use work accounts.

Running a single club on your own server instead? The README's [Deploying](../README.md#deploying) section covers that. Hosted mode is only switched on when `PLATFORM_URL` is set.

## What it costs

Prices are as of October 2026 and shown in USD.

| What | Price |
|---|---|
| Fly.io machine (`shared-cpu-1x`, 512 MB, `iad`) | $3.69 / month |
| Fly.io volume (1 GB) | $0.15 / month |
| Fly.io wildcard certificate (`*.yourdomain.com`) | $1 / month. The root domain's certificate is free. |
| Fly.io volume snapshots | First 10 GB free |
| Domain (e.g. Cloudflare Registrar, at cost) | About $10–15 / year |
| Resend | Free while testing (100 emails/day, 3,000/month). **Pro, $20/month (50,000/month), before real clubs send availability requests.** One blast to 150 comedians is over the free daily cap. |

That's about **$5 a month to start**, and about $25 a month once real clubs are emailing.

## 0. Accounts (you, about 10 minutes)

1. **Fly.io**: [fly.io/app/sign-up](https://fly.io/app/sign-up). Add a card, because there's no free tier after the trial.
2. **Cloudflare**: [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up). Used for the domain and DNS.
3. **Resend**: [resend.com/signup](https://resend.com/signup).

## 1. Buy the domain

In Cloudflare go to **Domain Registration → Register Domains**. Buy the domain, and Cloudflare manages its DNS automatically.

The rest of this guide calls it `yourdomain.com`.

## 2. Create the Fly app and its disk

```sh
brew install flyctl          # or: curl -L https://fly.io/install.sh | sh
fly auth login               # opens the browser: sign in with your personal account

cd Comedy-Booking-Platform
fly apps create comedy-booking        # taken? pick another name and put it in fly.toml (`app = …`)
fly volumes create data --region iad --size 1 --snapshot-retention 14 --yes
```

## 3. Set up sending email (Resend)

1. Go to **Resend → Domains → Add domain** and enter `mail.yourdomain.com`.
   - Using a subdomain keeps the platform's sending reputation separate from anything else on your domain.
2. Resend lists a few DNS records (MX, TXT for SPF and DKIM, and an optional DMARC record). In **Cloudflare → DNS**, add each one exactly as shown, with **Proxy status: DNS only**. Then click **Verify** in Resend.
3. Go to **Resend → API Keys → Create** and give the key *Sending access* only. Copy it; it starts with `re_`.

## 4. Secrets

Run this once, with your values filled in. `--stage` saves the secrets without restarting anything.

```sh
fly secrets set --stage \
  PLATFORM_URL=https://yourdomain.com \
  PLATFORM_NAME="Comedy Booking" \
  PLATFORM_ADMIN_EMAILS=you@your-personal-email.com \
  SUPPORT_EMAIL=you@your-personal-email.com \
  APP_SECRET="$(openssl rand -hex 32)" \
  SMTP_HOST=smtp.resend.com \
  SMTP_PORT=465 \
  SMTP_SECURE=true \
  SMTP_USER=resend \
  SMTP_PASS=re_your_api_key \
  SMTP_FROM_EMAIL=bookings@mail.yourdomain.com
```

**What each setting does:**

- **`PLATFORM_URL`**: switches on hosted mode. Clubs live at `https://<address>.yourdomain.com`.
- **`PLATFORM_ADMIN_EMAILS`**: who can sign in to the owner console at `https://yourdomain.com/admin`. Separate several addresses with commas.
- **`SUPPORT_EMAIL`**: shown to clubs whose account is paused, and on the sign-up page when sign-ups are closed.
- **`APP_SECRET`**: encrypts the mailbox passwords clubs save.
  - **Never change it.** If it changes, saved mailbox passwords stop working and clubs have to re-enter them.
  - Copy the value into a password manager now: `fly secrets list` only shows a fingerprint.
- **`SMTP_*`**: the platform's sender. Comedians see the club's name and replies go to the club, while the address underneath is `bookings@mail.yourdomain.com`.
- **Optional settings:**
  - `SIGNUPS=closed` turns off new sign-ups.
  - `PLATFORM_DAILY_EMAIL_CAP` sets the emails each club can send through the platform per day. The default is 2000. A club that connects its own mailbox isn't capped.

## 5. Deploy

```sh
fly deploy
```

Fly builds the Docker image on its own servers, so you don't need Docker locally. The first deploy takes a few minutes. Then check that it's running:

```sh
fly status
curl https://comedy-booking.fly.dev/api/health    # → {"ok":true}
```

## 6. Point the domain at it (with HTTPS)

```sh
fly ips list                              # note the shared IPv4 and the IPv6 address
fly certs add yourdomain.com
fly certs add "*.yourdomain.com"
fly certs show "*.yourdomain.com"         # shows a _acme-challenge CNAME target
```

In **Cloudflare → DNS**, add these records. Set every one to **DNS only** (grey cloud), so Fly can issue the certificates.

| Type | Name | Content |
|---|---|---|
| A | `@` | the IPv4 address from `fly ips list` |
| AAAA | `@` | the IPv6 address from `fly ips list` |
| CNAME | `*` | `comedy-booking.fly.dev` (your app name) |
| CNAME | `www` | `comedy-booking.fly.dev` |
| CNAME | `_acme-challenge` | the target `fly certs show "*.yourdomain.com"` printed |

Give it a few minutes, then run `fly certs check yourdomain.com` and `fly certs check "*.yourdomain.com"`. Both should say the certificate was issued.

## 7. Try it

1. Open `https://yourdomain.com/admin`, enter your email, and type the 6-digit code you get. That's your owner console.
2. Open `https://yourdomain.com/signup` and create a test club, e.g. `test-club`.
   - You land at `https://test-club.yourdomain.com` with the setup guide running.
   - Add yourself as a comedian and request availability. The email should arrive from "Test Club", and replying should go to your address.
3. Back in the console, the club shows up. Try **Suspend**: the club's site now shows "paused". Then click **Reactivate**.
4. **Archive** the test club when you're done.

Invite your bookers by sending them `https://yourdomain.com/signup`. Each new club emails you a notice.

## 8. Deploy on every push to `main`

```sh
fly tokens create deploy --expiry 8760h          # copy the token it prints
gituse personal gh secret set FLY_API_TOKEN -R Desitrain22/Comedy-Booking-Platform
```

From then on, `.github/workflows/deploy.yml` typechecks, tests and deploys on every push to `main`. Until the secret exists, the workflow just skips with a notice.

## Backups

There are three layers:

1. **Fly volume snapshots**: daily, kept 14 days (`--snapshot-retention 14`). These cover losing the whole disk.
2. **Nightly copies inside the app**: every night after 03:30 UTC, the app copies `platform.db` and every non-archived club's database into `/data/backups/<YYYY-MM-DD>/`, keeping 14 days. These cover a bad change in one club.
3. **Download backup** in the owner console: a copy of any club's database to keep somewhere else, such as your laptop or a drive.

### Restore one club from a nightly copy

```sh
fly ssh console
ls /data/backups/                       # pick a date
ls /data/backups/2026-11-02/clubs/      # files are <club id>.db (the id is in the console URL)
```

1. In the owner console, **Archive** the club. This closes its database file.
2. In the SSH session, replace the database. Run it as the `node` user so the file keeps the right owner:
   ```sh
   cd /data/clubs
   su node -s /bin/sh -c 'rm -f 7.db-wal 7.db-shm && cp /data/backups/2026-11-02/clubs/7.db 7.db'
   ```
3. In the console, **Restore** the club. It reopens the restored file.

### Restore the whole disk from a snapshot

```sh
fly volumes list                                  # the volume id, vol_…
fly volumes snapshots list vol_…                  # pick a snapshot id
fly volumes create data --snapshot-id vs_… --region iad --size 1 --yes
fly machine list                                  # note the current machine id
fly machine destroy <machine id> --force
fly deploy                                        # starts a new machine on the restored volume
```

Remove the old volume (`fly volumes destroy vol_…`) only after you've checked the restored data.

## Day to day

- **Logs:** `fly logs`. Scheduler sends and email failures are logged there.
- **Roll back a bad deploy:** `fly releases --image` lists past images; then `fly deploy --image <image>`.
- **Restart:** `fly machine restart`.
- **Move to Resend Pro:** do this in Resend's dashboard. Nothing changes on Fly.
- **Turn off sign-ups:** `fly secrets set SIGNUPS=closed`, which restarts the app.

## Troubleshooting

- **The site won't load on a club address but the root domain works:** the wildcard certificate or the `*` DNS record is missing. Check `fly certs check "*.yourdomain.com"`, and that the `*` record is *DNS only*.
- **"Refusing to start: APP_SECRET is required":** set it (step 4). It's required in hosted mode.
- **Emails show as failed with an authentication error:** check that the `SMTP_PASS` API key is valid, and that the Resend domain says *Verified*.
- **Emails show as failed with "Daily email limit reached":** that club has sent `PLATFORM_DAILY_EMAIL_CAP` emails through the platform today. Raise the cap, or have the club connect its own mailbox (Settings → Email).
- **Owner console code never arrives:** your address must be in `PLATFORM_ADMIN_EMAILS` exactly. Run `fly secrets list`, and check `fly logs` for email errors.
