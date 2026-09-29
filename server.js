import express from "express";
import { Eta } from "eta";
import { fileURLToPath } from "node:url";
import { config, googleConfigured } from "./src/config.js";
import { initDb } from "./src/db/client.js";
import { migrate } from "./src/db/migrate.js";
import { HttpError, parseCookies, redirect, sendHtml, sse } from "./src/lib/http.js";
import { publish } from "./src/lib/pubsub.js";
import { endSession, loadSession, startSession } from "./src/auth/session.js";
import { beginGoogleLogin, completeGoogleLogin, safeNext } from "./src/auth/google-oauth.js";
import { upsertDevUser, upsertGoogleUser } from "./src/services/users.js";
import { acceptInvite, createHousehold, createInvite, getHouseholdForUser, getInvite } from "./src/services/household.js";
import { changed, onChange } from "./src/services/changes.js";
import { assignTask, createTask, deleteTask, getTask, restoreTask, setDone } from "./src/services/tasks.js";
import { createProject, listProjects } from "./src/services/projects.js";
import { cleanView, taskListView, VIEWS } from "./src/web/task-list.js";
import { parseQuickAdd } from "./public/js/lib/quick-add.js";
import { relativeLabel, todayIn } from "./public/js/lib/dates.js";
import { getAccessToken } from "./src/google/tokens.js";
import { createTasksApi } from "./src/google/tasks-api.js";
import { createSyncEngine } from "./src/sync/engine.js";

const dir = (p) => fileURLToPath(new URL(p, import.meta.url));

initDb(config.db);
await migrate();

const eta = new Eta({ views: dir("./views"), cache: config.isProduction });
const render = (res, name, data = {}, status = 200) => sendHtml(res, eta.render(name, data), status);

// --- Google sync + live updates -------------------------------------------------------

const sync = googleConfigured()
  ? createSyncEngine({
      api: createTasksApi({ getAccessToken }),
      appUrl: config.baseUrl,
      listTitle: config.google.listTitle,
    })
  : null;

onChange(({ householdId, taskId, fromGoogle }) => {
  publish(householdId, { type: "changed", taskId });
  if (sync && taskId && !fromGoogle) {
    sync.enqueue(taskId).then(() => sync.processQueue()).catch((err) => console.error("sync enqueue failed", err));
  }
});

const syncTimer = sync
  ? setInterval(() => sync.syncNow().catch((err) => console.error("sync failed", err)), config.google.syncIntervalMs)
  : null;

// --- App ------------------------------------------------------------------------------

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", config.isProduction);

app.use(express.static(dir("./public"), { maxAge: config.isProduction ? "1h" : 0 }));
app.use(express.urlencoded({ extended: false, limit: "256kb" }));
app.use(express.json({ limit: "256kb" }));

// Every handler gets req.cookies, req.user (or null) and req.membership (household + members).
app.use(async (req, res, next) => {
  req.cookies = parseCookies(req.headers.cookie);
  req.user = await loadSession(req.cookies);
  req.membership = req.user ? await getHouseholdForUser(req.user.id) : null;
  res.locals.user = req.user;
  res.locals.config = config;
  next();
});

const requireUser = (req, res, next) =>
  req.user ? next() : redirect(res, `/login?next=${encodeURIComponent(req.originalUrl)}`);

app.get("/healthz", (req, res) => res.type("text").send("ok"));

const today = (req) => todayIn(req.cookies.tz);
const isDatastar = (req) => req.get("datastar-request") === "true";

app.get("/", requireUser, async (req, res) => {
  const list = req.membership
    ? await taskListView({ userId: req.user.id, membership: req.membership, view: cleanView(req.query.view), today: today(req) })
    : null;
  render(res, "pages/home", { user: req.user, membership: req.membership, list, views: VIEWS });
});

// --- Tasks ----------------------------------------------------------------------------

// Task routes need a household; req.actor is what the task services take.
const requireHousehold = (req, res, next) => {
  if (!req.user) return requireUser(req, res, next);
  if (!req.membership) return redirect(res, "/");
  req.actor = { id: req.user.id, householdId: req.membership.household.id };
  next();
};

/** Datastar: re-render the task list (plus an optional flash). Plain form posts: back to the list. */
async function sendTaskList(req, res, { flash, signals } = {}) {
  const view = cleanView(req.body.view);
  if (!isDatastar(req)) return redirect(res, `/?view=${view}`);
  const list = await taskListView({ userId: req.user.id, membership: req.membership, view, today: today(req) });
  const html = eta.render("partials/task-list", { ...list, userId: req.user.id });
  const flashHtml = flash ? eta.render("partials/flash", flash) : '<div id="flash" role="status"></div>';
  await sse(req, res, (stream) => {
    stream.patchElements(html);
    stream.patchElements(flashHtml);
    if (signals) stream.patchSignals(JSON.stringify(signals));
  });
}

app.post("/tasks", requireHousehold, async (req, res) => {
  const { household, members } = req.membership;
  const parsed = parseQuickAdd(String(req.body.quick ?? ""), {
    today: today(req),
    meId: req.user.id,
    members,
    projects: await listProjects(household.id),
  });
  const { projectName, ...input } = parsed;
  if (projectName) input.projectId = await createProject(household.id, { name: projectName });
  await createTask(req.actor, input);
  await sendTaskList(req, res, { signals: { quick: "" } });
});

app.post("/tasks/:id/done", requireHousehold, async (req, res) => {
  const nextId = await setDone(req.actor, req.params.id, true, { today: today(req) });
  const next = nextId && (await getTask(req.actor.householdId, nextId));
  const flash = next && { message: `Next one due ${relativeLabel(next.due_date, today(req))}` };
  await sendTaskList(req, res, { flash });
});

app.post("/tasks/:id/reopen", requireHousehold, async (req, res) => {
  await setDone(req.actor, req.params.id, false);
  await sendTaskList(req, res);
});

app.post("/tasks/:id/claim", requireHousehold, async (req, res) => {
  await assignTask(req.actor, req.params.id, req.user.id);
  await sendTaskList(req, res);
});

app.post("/tasks/:id/delete", requireHousehold, async (req, res) => {
  const task = await getTask(req.actor.householdId, req.params.id);
  await deleteTask(req.actor, task.id);
  await sendTaskList(req, res, { flash: { message: `Deleted “${task.title}”`, undo: `/tasks/${task.id}/restore` } });
});

app.post("/tasks/:id/restore", requireHousehold, async (req, res) => {
  await restoreTask(req.actor, req.params.id);
  await sendTaskList(req, res);
});

// --- Household ------------------------------------------------------------------------

app.post("/household", requireUser, async (req, res) => {
  await createHousehold(req.user.id, String(req.body.name ?? "").slice(0, 80));
  redirect(res, "/");
});

app.post("/household/invite", requireUser, async (req, res) => {
  if (!req.membership) throw new HttpError(400, "Create a household first");
  const token = await createInvite(req.membership.household.id, req.user.id);
  const html = eta.render("partials/invite-link", { url: `${config.baseUrl}/invite/${token}` });
  await sse(req, res, (stream) => stream.patchElements(html));
});

app.get("/invite/:token", requireUser, async (req, res) => {
  const invite = await getInvite(req.params.token);
  if (!invite) throw new HttpError(404, "This invite link has expired or was already used");
  if (req.membership?.household.id === invite.household_id) return redirect(res, "/");
  if (req.membership) throw new HttpError(400, "You're already in another household");
  render(res, "pages/invite", { invite });
});

app.post("/invite/:token", requireUser, async (req, res) => {
  const householdId = await acceptInvite(req.params.token, req.user.id);
  changed(householdId);
  redirect(res, "/");
});

// --- Auth -----------------------------------------------------------------------------

app.get("/login", (req, res) => {
  if (req.user) return redirect(res, safeNext(req.query.next));
  render(res, "pages/login", {
    next: safeNext(req.query.next),
    google: googleConfigured(),
    devLogin: config.devLogin,
  });
});

app.get("/auth/google", (req, res) => {
  if (!googleConfigured()) throw new HttpError(503, "Google sign-in isn't configured");
  redirect(res, beginGoogleLogin(res, req.query.next), 302);
});

app.get("/auth/google/callback", async (req, res) => {
  const query = new URLSearchParams(req.url.split("?")[1] ?? "");
  const { profile, tokens, next, grantedTasks } = await completeGoogleLogin(res, req.cookies, query);
  const userId = await upsertGoogleUser(profile, tokens);
  await startSession(res, userId);
  if (sync && grantedTasks) sync.enqueueAllForUser(userId).catch((err) => console.error("initial sync failed", err));
  redirect(res, next);
});

app.post("/auth/dev", async (req, res) => {
  if (!config.devLogin) throw new HttpError(404, "Not found");
  const handle = String(req.body.handle ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!handle) throw new HttpError(400, "Pick a name");
  await startSession(res, await upsertDevUser(handle));
  redirect(res, safeNext(req.body.next));
});

app.post("/logout", async (req, res) => {
  await endSession(res, req.cookies);
  redirect(res, "/login");
});

// --- Errors ---------------------------------------------------------------------------

app.use((req, res) => render(res, "pages/error", { status: 404, message: "Page not found" }, 404));

app.use((err, req, res, next) => {
  const status = err instanceof HttpError ? err.status : (err.status ?? 500);
  if (status >= 500) console.error(err);
  if (res.headersSent) return next(err);
  const message = status >= 500 ? "Something went wrong" : err.message;
  // Datastar ignores non-SSE responses, so show the error in the page's flash area instead.
  if (isDatastar(req)) return sse(req, res, (stream) => stream.patchElements(eta.render("partials/flash", { message, error: true })));
  render(res, "pages/error", { status, message }, status);
});

// --- Start ----------------------------------------------------------------------------

const server = app.listen(config.port, () => {
  console.log(`task-sloth listening on ${config.baseUrl}`);
  if (!googleConfigured()) console.log("Google sign-in/sync disabled (GOOGLE_CLIENT_ID/SECRET not set)");
  sync?.syncNow().catch((err) => console.error("sync failed", err));
});

const shutdown = () => {
  clearInterval(syncTimer);
  server.close(() => process.exit(0));
  server.closeAllConnections(); // SSE streams would otherwise hold the process open
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
