---
name: dev
description: Start the Task Sloth dev server (pnpm dev) in the background, wait until it answers /healthz, and report the URL and sign-in options. Pass "stop" to stop it, or "restart" to restart it.
argument-hint: "[stop|restart]"
disable-model-invocation: true
allowed-tools: Bash(pnpm dev*), Bash(curl *), Bash(grep *), Bash(ss *), Bash(lsof *), Bash(pkill *), Bash(kill *)
---

Run the local dev server. Arguments: `$ARGUMENTS`

## 1. Check what's already running

- The port is `$PORT` from `.env`, or 3000 if that isn't set. Check it with `curl -sf http://localhost:<port>/healthz`.
- If the server already answers and the argument is neither `stop` nor `restart`, report the URL and stop here. Don't start a second copy.
- If the argument is `stop` or `restart`, find the process listening on the port (`ss -ltnp` or `lsof -i :<port>`) and kill it. Only kill it if it's a `node ... server.js` process. For `stop`, confirm it's down and stop here.
- If something other than this app holds the port, name the process and stop. Don't kill it.

## 2. Preflight

- If `node_modules/` is missing, run `pnpm install`.
- Read `.env` for variable **names** only (`grep -oE '^[A-Z_]+=' .env`) and never print its values.
- If `TURSO_DATABASE_URL` starts with `libsql://` (`grep -q '^TURSO_DATABASE_URL=libsql://' .env`), warn that the dev server will read and write the remote Turso database, not `data/local.db`. Migrations also run against it at startup. Carry on, but put this warning at the top of the report.

## 3. Start

- Run `pnpm dev` with `run_in_background: true`. It uses `node --watch`, so code changes restart it automatically, and it runs pending migrations at startup.
- Poll `/healthz` for up to 30 seconds (`for i in $(seq 30); do curl -sf http://localhost:<port>/healthz && break; sleep 1; done`).
- If the server never becomes healthy, show the last lines of the background output and stop.

## 4. Report

Keep the report short:
- the URL (`BASE_URL`, or `http://localhost:<port>`)
- how to sign in: dev login (on by default under `pnpm dev` unless `DEV_LOGIN=0`) and/or Google, based on whether `GOOGLE_CLIENT_ID` is set
- any migrations it applied (`migrated …` lines in the output)
- the remote-database warning from step 2, if it applies
