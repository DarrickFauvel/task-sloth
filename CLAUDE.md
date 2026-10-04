# Task Sloth

A shared household to-do list: Express 5 + Eta server rendering, Datastar for interactivity, Turso/libSQL for storage. The README covers setup, configuration and layout. This file covers how to work in the repo.

## Commands

- `pnpm test` runs all tests (`node --test`). Run a single file with `node --test test/<name>.test.js`.
- `node --check <file>` for a quick syntax check.
- `pnpm dev` starts the server. Use the `/dev` skill to start, stop or restart it, and `/ship` to branch, commit, open a PR and merge.

## Stack rules

- No frontend frameworks, no bundler, no build step, no TypeScript. Plain ES modules everywhere (`"type": "module"`), with JSDoc types where they help.
- Keep dependencies minimal. Prefer Node built-ins (`node:crypto`, `node:test`, global `fetch`) over new packages, and ask before adding one.
- Interactivity is Datastar 1.0 (loaded from a CDN in `views/layout.eta`): routes answer Datastar requests with SSE patches (`sse()` in `src/lib/http.js`) that re-render partials from `views/partials/`. Small, self-contained browser behavior goes in `public/js` as a module or web component.
- Code in `public/js/lib/` is shared by the server and the browser, so it must stay pure: no DOM, no Node APIs.

## Where things go

- **Routes** all live in `server.js`. Keep them thin: parse input, call a service, render.
- **Services** (`src/services/`) own the SQL and business rules. Every query is scoped to the actor's household.
- **View models** (`src/web/`) turn service data into what templates need. Test logic here, not in templates.
- **Config** goes through `src/config.js`. Don't read `process.env` anywhere else. New variables also go in `.env.example` and the README's configuration table.
- **Tests** go in `test/<feature>.test.js`. Suites that need a database create a temporary SQLite file with `initDb` and `migrate`. Stub `fetch` for Cloudinary and Google, and use `captureMail()` for email.

## Database and migrations

- Add a migration as the next numbered file in `migrations/` (`010_description.sql`). Never edit or renumber one that has already been committed. There are no down migrations.
- The server applies pending migrations at startup. A developer's `.env` may point `TURSO_DATABASE_URL` at the hosted Turso database, and then starting the dev server migrates it. So stop the dev server before adding a migration file, and ask before running anything that would apply it to a `libsql://` database.
- `.env` holds real secrets. Read it for variable names only (`grep -oE '^[A-Z_]+=' .env`), never print values, and never commit it, `data/` or `*.db` files.

## Dev server gotchas

- `node --watch` can restart halfway through a multi-file edit, a rebase or a branch switch, and then serve a mix of old and new code. Templates reload, but JS may not. If a 500's stack trace doesn't match the current file, restart the server.
- After editing `.env`, fully restart the server; a watch restart can keep the old values.

## UI conventions

- **Forest sloth look.** Load the `cozy-design` skill before UI work: it covers the palette tokens, shapes, font, motion and voice.
- **Plain language.** Not everyone using the app knows GTD, so no GTD jargon in the UI. Use the app's own labels (Inbox, To do, Waiting on, Maybe later, Where / how) and make every screen explain itself with hints and empty states that teach.
- **Mobile first.** Base styles target phones, with `min-width` media queries for larger screens. Use the fluid `clamp()` type and spacing tokens in `public/css/app.css` rather than fixed sizes, and keep tap targets large.
- **Consistency:**
  - One filled `.button.primary` per screen for the main action; secondary actions are outlined.
  - Cards are `.panel`, using the `--radius-lg` and `--tint` tokens.
  - Centered messages use `.empty-state`; back links use `.back`.
  - Only links in running text are underlined.
  - Every bottom sheet ends with a plain "Close".
  - Status updates are toasts (the `#flash` region, `partials/flash`); form errors stay inline.
  - Chips are `.pill` for choices and `.token` for shortcut examples.
- Support light and dark themes: use the color tokens, not literal colors.

## Git

- Branch from `main` as `feature/<slug>`, squash-merge through a PR. CI (`.github/workflows/test.yml`) runs `pnpm test` on Node 22 and 24.
- Don't stack PRs: `gh pr merge --delete-branch` on the base closes the child PR instead of retargeting it.
