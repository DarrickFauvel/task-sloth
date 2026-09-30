# Task Sloth

A shared to-do list for a household. Jot things down fast, sort them later, and see only what you can actually do.

It's built on the ideas in *Getting Things Done*, but the app never uses GTD jargon: everything you type lands in a personal **Inbox**, a guided **Sort my inbox** asks "What is this?" one item at a time, and sorted tasks live on shared lists (**To do**, **Waiting on**, **Maybe later**).

## Features

- **Quick add with typed shortcuts.** `call grandma sun @phone +errand` sets the day, the where/how and a tag in one line. A task with a detail skips the Inbox.
- **Due dates and times.** A task due at a time turns red and moves to Overdue once that time passes, live, in each person's own time zone.
- **Shared household lists.** Views for Mine, Everyone and Up for grabs (claim a task with one tap), grouped by *when* or *where / how*, and filterable by project, tag or where/how.
- **Checklists** on any task, with sections, drag or arrow-key reordering, and auto-categorized grocery lists.
- **Blocked-by tasks.** A task can wait on another task and becomes ready when that one is ticked off.
- **Private task photos** stored on Cloudinary as authenticated images, relayed by the app to household members only.
- **Live updates** across everyone's open windows (server-sent events via Datastar).
- **Done today.** A badge in the header counts what the household has finished today and cheers when a task is ticked off; the Done tab shows a dot per task in the color of whoever finished it.
- **Recently done and Activity.** Finished tasks linger for 10 minutes, the Done tab shows the last 8 hours, and the Activity page shows the last 14 days.
- **Accounts.** Username and password sign-up with email confirmation, optional Google sign-in, invite links and a QR code for joining a household, avatar photos, member colors, and light/dark themes.
- **Google Tasks sync (optional).** Two-way sync between each member's tasks and a "Task Sloth" list in their Google Tasks.
- **Mobile first**, with a bottom nav on phones.

## Stack

No frontend framework and no build step.

- **Server:** Node.js 22+ with Express 5, server-rendered [Eta](https://eta.js.org) templates
- **Interactivity:** [Datastar](https://data-star.dev) 1.0 (from a CDN), plain JS modules and web components in `public/js`
- **Database:** [Turso](https://turso.tech) (libSQL) in production, a local SQLite file in development
- **Email:** nodemailer over any SMTP server
- **Photos:** Cloudinary
- **Hosting:** Railway (a single instance, see [Deployment](#deployment))

## Getting started

Requires Node.js 22 or newer and [pnpm](https://pnpm.io) (the version is pinned in `package.json`; `corepack enable` will pick it up).

```sh
pnpm install
cp .env.example .env   # optional: everything has a development default
pnpm dev
```

Open http://localhost:3000 and use the **Dev login** form (any name signs you in as that user), or create an account. With no configuration the app:

- stores data in `data/local.db` (created on first run; migrations run at startup),
- prints confirmation emails to the console instead of sending them, so you can follow the links,
- hides the photo buttons and Google sign-in.

`pnpm dev` uses `node --watch`, so it restarts when code changes. After editing `.env`, stop and start it again yourself to be sure the new values are loaded.

## Configuration

All settings are environment variables, read in [`src/config.js`](src/config.js) and loaded from `.env` by the npm scripts. [`.env.example`](.env.example) documents each one.

| Variable | Needed for | Default |
| --- | --- | --- |
| `PORT` | | `3000` |
| `BASE_URL` | Links in emails and invites, QR code, Google redirect | `http://localhost:$PORT` |
| `NODE_ENV` | Set to `production` when deployed | |
| `SESSION_SECRET` | Cookie signing and token encryption. **Required in production** | insecure dev value |
| `DEV_LOGIN` | Dev login form (`1`/`0`) | on under `pnpm dev`, never in production |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | Turso database | `file:data/local.db` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google sign-in and Google Tasks sync | off |
| `GOOGLE_SYNC_INTERVAL_SECONDS` | How often to poll Google Tasks | `120` |
| `GOOGLE_TASK_LIST_TITLE` | Name of the synced Google Tasks list | `Task Sloth` |
| `CLOUDINARY_URL` | Task photos | off |
| `SMTP_URL`, `MAIL_FROM` | Sending email. **Required in production** | printed to the console |

### Google (optional)

Create an OAuth client of type *Web application* in Google Cloud Console, enable the Google Tasks API, and add `$BASE_URL/auth/google/callback` as an authorized redirect URI. Then set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

### Cloudinary (optional)

Copy the *API environment variable* from Cloudinary's dashboard (Settings → API Keys) into `CLOUDINARY_URL`. Photos are uploaded as `authenticated` assets, so they have no public URL.

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` | Start the server with auto-restart and dev login |
| `pnpm start` | Start the server |
| `pnpm migrate` | Apply pending migrations without starting the server |
| `pnpm test` | Run the test suite (`node --test`) |

## Project layout

```
server.js            Express app: middleware, every route, startup and shutdown
src/
  config.js          Environment configuration
  auth/              Sessions and Google OAuth
  db/                libSQL client and the migration runner
  services/          Business logic and SQL (tasks, checklist, household, users, photos, …)
  web/               View models: turn service data into what templates render
  sync/              Google Tasks two-way sync engine and field mapping
  google/            Google Tasks API client and token refresh
  lib/               HTTP helpers, crypto, mail, Cloudinary, pub/sub, rate limiting
views/
  layout.eta         Page shell (loads Datastar)
  pages/             One template per page
  partials/          Reusable pieces, also sent alone as Datastar patches
public/
  css/app.css        All styles (mobile first)
  js/                Browser modules and web components
  js/lib/            Pure logic shared by server and browser (quick-add parser, dates, recurrence)
migrations/          Numbered SQL files, applied in order at startup
test/                node:test suites
```

## Database migrations

Migrations are plain SQL files in `migrations/`, named `NNN_description.sql`. The server applies any that haven't run yet at startup and records them in `schema_migrations`. They only move forward: there are no down migrations, so to change something, add a new file. Never edit a migration that has already run anywhere.

When `TURSO_DATABASE_URL` points at a hosted database, starting the dev server applies new migrations to it.

## Tests

```sh
pnpm test
```

Tests use `node:test`. Suites that touch the database create a temporary SQLite file, and `fetch` and email are stubbed out, so no configuration or network access is needed. GitHub Actions runs them on Node 22 and 24 for every push to `main` and every pull request.

## Deployment

The app runs on Railway as a single instance. Live updates use in-process pub/sub (`src/lib/pubsub.js`), so running more than one instance would need a shared broker such as Redis.

In production, set at least `NODE_ENV=production`, `BASE_URL`, `SESSION_SECRET`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `SMTP_URL` and `MAIL_FROM`, plus `CLOUDINARY_URL` for photos. The start command is `pnpm start`, and migrations run on boot. `/healthz` returns `ok` for health checks.

## Credits

Made by [Darrick Develops](https://darrickdevelops.com).
