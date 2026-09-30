import express from "express";
import QRCode from "qrcode";
import { Eta } from "eta";
import { fileURLToPath } from "node:url";
import { config, googleConfigured } from "./src/config.js";
import { initDb } from "./src/db/client.js";
import { migrate } from "./src/db/migrate.js";
import { HttpError, parseCookies, redirect, sendHtml, sse } from "./src/lib/http.js";
import { publish, subscribe } from "./src/lib/pubsub.js";
import { endSession, loadSession, startSession } from "./src/auth/session.js";
import { beginGoogleLogin, completeGoogleLogin, safeNext } from "./src/auth/google-oauth.js";
import { createPasswordUser, upsertDevUser, upsertGoogleUser, verifyLogin } from "./src/services/users.js";
import { createRateLimit } from "./src/lib/rate-limit.js";
import { acceptInvite, createHousehold, createInvite, getHouseholdForUser, getInvite } from "./src/services/household.js";
import { changed, onChange } from "./src/services/changes.js";
import { assignTask, createTask, deleteTask, getTask, LISTS, nextToSort, restoreTask, setDone, updateTask } from "./src/services/tasks.js";
import { addItems, autoCategorize, clearChecked, deleteItem, setItemChecked, uncheckAll } from "./src/services/checklist.js";
import { createProject, listProjects } from "./src/services/projects.js";
import { ensureContext, listContexts } from "./src/services/contexts.js";
import { cleanListQuery, cleanView, decorateTask, listQueryString, NAV, quickAddList, taskListView, VIEWS } from "./src/web/task-list.js";
import { NEEDS_DETAILS, quickDates, SORT_CHOICES, sortDecision } from "./src/web/sort-page.js";
import { INSERT_TOKEN, SHORTCUT_EXAMPLE, shortcutGroups } from "./src/web/shortcuts.js";
import { checklistView } from "./src/web/checklist.js";
import { editFormView, editInput } from "./src/web/task-page.js";
import { parseQuickAdd } from "./public/js/lib/quick-add.js";
import { relativeLabel, todayIn } from "./public/js/lib/dates.js";
import { getAccessToken } from "./src/google/tokens.js";
import { createTasksApi } from "./src/google/tasks-api.js";
import { createSyncEngine } from "./src/sync/engine.js";

const dir = (p) => fileURLToPath(new URL(p, import.meta.url));

initDb(config.db);
await migrate();

// The home page's QR code: the app's root URL, drawn once at startup as an inline SVG.
// Dark on white whatever the theme, since phone cameras read that most reliably.
const appUrl = config.baseUrl.replace(/\/+$/, "");
const appQr = {
  url: appUrl,
  svg: await QRCode.toString(appUrl, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#1d1b19", light: "#ffffff" } }),
};

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
    ? await taskListView({ userId: req.user.id, membership: req.membership, ...cleanListQuery(req.query), today: today(req) })
    : null;
  render(res, "pages/home", { user: req.user, membership: req.membership, list, views: VIEWS, nav: NAV, listQueryString, qr: appQr, shortcuts: shortcutsView(req) });
});

// --- Tasks ----------------------------------------------------------------------------

// Task routes need a household; req.actor is what the task services take.
const requireHousehold = (req, res, next) => {
  if (!req.user) return requireUser(req, res, next);
  if (!req.membership) return redirect(res, "/");
  req.actor = { id: req.user.id, householdId: req.membership.household.id };
  next();
};

const isNotFound = (err) => err instanceof HttpError && err.status === 404;

// Live updates: the home page and task pages hold this stream open, and any change in the
// household (from a member or from Google) re-renders the page's task list or checklist.
// It's also sent on connect, so a reconnect catches up on whatever was missed.
app.get("/events", requireHousehold, async (req, res) => {
  const listQuery = cleanListQuery(req.query);
  const taskId = typeof req.query.task === "string" ? req.query.task : null;
  const { householdId } = req.actor;
  // The task was deleted: 204 is the one response Datastar's retry: 'always' won't retry.
  if (taskId && !(await getTask(householdId, taskId).then(() => true, (err) => (isNotFound(err) ? false : Promise.reject(err))))) {
    return res.status(204).end();
  }
  let closed = false;

  /** @returns {Promise<string[]>} the page's live parts */
  const renderPage = async (membership) => {
    if (taskId) {
      const checklist = await checklistView(householdId, taskId);
      return [renderTaskHead(req, checklist.task, membership), eta.render("partials/checklist", checklist)];
    }
    const list = await taskListView({ userId: req.user.id, membership, ...listQuery, today: today(req) });
    return renderList(list, req.user.id);
  };

  await sse(req, res, async (stream) => {
    const push = async () => {
      // Reload the membership each time: members can join, or this user can leave.
      const membership = await getHouseholdForUser(req.user.id);
      if (closed) return;
      if (membership?.household.id !== householdId) return res.end();
      let parts;
      try {
        parts = await renderPage(membership);
      } catch (err) {
        if (!isNotFound(err)) throw err;
        if (!closed) stream.patchElements(eta.render("partials/flash", { message: "This task was deleted", error: true }));
        return res.end();
      }
      if (!closed) for (const html of parts) stream.patchElements(html);
    };

    // One render at a time; changes that arrive mid-render are folded into one more render.
    let running = null;
    let again = false;
    const refresh = () => {
      if (running) return void (again = true);
      running = (async () => {
        do {
          again = false;
          await push();
        } while (again && !closed);
      })()
        .catch((err) => console.error("live update failed", err))
        .finally(() => (running = null));
    };

    const unsubscribe = subscribe(householdId, refresh);
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000); // keeps proxies from idling us out
    refresh();
    await new Promise((resolve) => res.on("close", resolve));
    closed = true;
    unsubscribe();
    clearInterval(heartbeat);
  });
});

/** The home page's live parts: the tabs (for the inbox count) and the task list. */
const renderList = (list, userId) => [
  eta.render("partials/tabs", { list, views: VIEWS, nav: NAV, listQueryString }),
  eta.render("partials/task-list", { ...list, userId }),
];

/** Datastar: re-render the task list (plus an optional flash). Plain form posts: back to the list. */
async function sendTaskList(req, res, { flash, signals } = {}) {
  if (req.body.back === "task") return sendTaskHead(req, res, req.params.id, { flash });
  const listQuery = cleanListQuery(req.body);
  if (!isDatastar(req)) return redirect(res, `/?${listQueryString(listQuery)}`);
  const list = await taskListView({ userId: req.user.id, membership: req.membership, ...listQuery, today: today(req) });
  const parts = renderList(list, req.user.id);
  const flashHtml = flash ? eta.render("partials/flash", flash) : '<div id="flash" role="status"></div>';
  await sse(req, res, (stream) => {
    for (const html of parts) stream.patchElements(html);
    stream.patchElements(flashHtml);
    if (signals) stream.patchSignals(JSON.stringify(signals));
  });
}

/** Turns names typed for a new project or context into ids, creating them if needed. */
async function resolveNames(householdId, { projectName, contextName, ...input }) {
  if (projectName) input.projectId = await createProject(householdId, { name: projectName });
  if (contextName !== undefined) input.contextId = contextName ? await ensureContext(householdId, contextName) : null;
  return input;
}

app.post("/tasks", requireHousehold, async (req, res) => {
  const { household, members } = req.membership;
  const parsed = parseQuickAdd(String(req.body.quick ?? ""), {
    today: today(req),
    meId: req.user.id,
    members,
    projects: await listProjects(household.id),
    contexts: await listContexts(household.id),
  });
  const view = cleanView(req.body.view);
  const list = quickAddList(parsed, view);
  const id = await createTask(req.actor, { ...(await resolveNames(household.id, parsed)), list });
  const flash =
    list === "inbox" && view !== "inbox"
      ? { message: "Added to your Inbox.", link: { href: `/sort?task=${id}`, label: "Sort it now" } }
      : undefined;
  await sendTaskList(req, res, { flash, signals: { quick: "" } });
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

// Move a task to another list ("To do →" on the Waiting and Maybe-later tabs).
app.post("/tasks/:id/list/:list", requireHousehold, async (req, res) => {
  if (!LISTS.includes(req.params.list)) throw new HttpError(404, "Unknown list");
  await updateTask(req.actor, req.params.id, { list: req.params.list });
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

// --- Sorting the inbox ----------------------------------------------------------------
// A plain HTML form, one task at a time: each answer saves and loads the next task.

async function renderSortPage(req, res, { taskId, after, error, pick = "", status = 200 } = {}) {
  const { householdId } = req.actor;
  let task = null;
  if (taskId) {
    task = await getTask(householdId, taskId).catch((err) => (isNotFound(err) ? null : Promise.reject(err)));
    if (task && (task.list !== "inbox" || task.creator_id !== req.user.id || task.status !== "open")) task = null;
  }
  const next = await nextToSort(householdId, req.user.id, task ? null : after);
  task ??= next.task;
  render(res, "pages/sort", {
    task: task && decorateTask(task, req.membership, today(req)),
    left: next.left,
    skipped: Boolean(after) && !task && next.left > 0,
    choices: SORT_CHOICES,
    needsDetails: NEEDS_DETAILS,
    pick: NEEDS_DETAILS.includes(pick) ? pick : "",
    quickDates: quickDates(today(req)),
    members: req.membership.members,
    contexts: await listContexts(householdId),
    userId: req.user.id,
    error,
  }, status);
}

const queryString = (v) => (typeof v === "string" && v ? v : null);

app.get("/sort", requireHousehold, (req, res) =>
  renderSortPage(req, res, { taskId: queryString(req.query.task), after: queryString(req.query.after) }),
);

app.post("/sort/:id", requireHousehold, async (req, res) => {
  const task = await getTask(req.actor.householdId, req.params.id);
  if (task.creator_id !== req.user.id) throw new HttpError(403, "That's someone else's inbox");
  let decision;
  try {
    decision = sortDecision(req.body);
  } catch (err) {
    if (err instanceof HttpError && err.status === 400) return renderSortPage(req, res, { taskId: task.id, error: err.message, pick: req.body.choice, status: 400 });
    throw err;
  }
  if (decision.action === "delete") await deleteTask(req.actor, task.id);
  else {
    await updateTask(req.actor, task.id, await resolveNames(req.actor.householdId, decision.input));
    if (decision.action === "done") await setDone(req.actor, task.id, true, { today: today(req) });
  }
  redirect(res, `/sort?after=${encodeURIComponent(task.id)}`);
});

// --- Help ------------------------------------------------------------------------------

/** The shortcuts cheat sheet, with the signed-in user's housemates as the @person examples. */
const shortcutsView = (req) => ({
  groups: shortcutGroups((req.membership?.members ?? []).filter((m) => m.id !== req.user.id).map((m) => m.name)),
  example: SHORTCUT_EXAMPLE,
  insertJs: INSERT_TOKEN,
});

app.get("/help", requireUser, (req, res) =>
  render(res, "pages/help", { shortcuts: shortcutsView(req), choices: SORT_CHOICES, nav: NAV, views: VIEWS }),
);

// --- Task page + checklist ------------------------------------------------------------

const renderTaskHead = (req, task, membership = req.membership) =>
  eta.render("partials/task-head", { task: decorateTask(task, membership, today(req)), userId: req.user.id });

const editView = async (req, task) =>
  editFormView(task, {
    members: req.membership.members,
    projects: await listProjects(req.actor.householdId),
    contexts: await listContexts(req.actor.householdId),
  });

async function renderTaskPage(req, res, { editing = false } = {}) {
  const checklist = await checklistView(req.actor.householdId, req.params.id);
  const task = decorateTask(checklist.task, req.membership, today(req));
  const form = editing ? await editView(req, checklist.task) : null;
  render(res, "pages/task", { task, checklist, form, userId: req.user.id });
}

/** Datastar: re-render the task details (plus an optional flash, and closing the edit form). Plain posts: back to the task page. */
async function sendTaskHead(req, res, taskId, { flash, signals } = {}) {
  if (!isDatastar(req)) return redirect(res, `/tasks/${taskId}`);
  const html = renderTaskHead(req, await getTask(req.actor.householdId, taskId));
  const flashHtml = flash ? eta.render("partials/flash", flash) : '<div id="flash" role="status"></div>';
  await sse(req, res, (stream) => {
    stream.patchElements(html);
    stream.patchElements(flashHtml);
    if (signals) stream.patchSignals(JSON.stringify(signals));
  });
}

app.get("/tasks/:id", requireHousehold, (req, res) => renderTaskPage(req, res));

// Edit form: always rendered fresh, so it opens with whatever the task looks like now.
app.get("/tasks/:id/edit", requireHousehold, async (req, res) => {
  if (!isDatastar(req)) return renderTaskPage(req, res, { editing: true });
  const html = eta.render("partials/task-edit", { form: await editView(req, await getTask(req.actor.householdId, req.params.id)) });
  await sse(req, res, (stream) => {
    stream.patchElements(html);
    stream.patchSignals(JSON.stringify({ editing: true }));
  });
});

app.post("/tasks/:id/edit", requireHousehold, async (req, res) => {
  await updateTask(req.actor, req.params.id, await resolveNames(req.actor.householdId, editInput(req.body)));
  await sendTaskHead(req, res, req.params.id, { signals: { editing: false } });
});

/** Datastar: re-render the checklist (and clear any error). Plain form posts: back to the task page. */
async function sendChecklist(req, res, taskId, { signals } = {}) {
  if (!isDatastar(req)) return redirect(res, `/tasks/${taskId}`);
  const html = eta.render("partials/checklist", await checklistView(req.actor.householdId, taskId));
  await sse(req, res, (stream) => {
    stream.patchElements(html);
    stream.patchElements('<div id="flash" role="status"></div>');
    if (signals) stream.patchSignals(JSON.stringify(signals));
  });
}

app.post("/tasks/:id/items", requireHousehold, async (req, res) => {
  await addItems(req.actor, req.params.id, String(req.body.items ?? ""));
  await sendChecklist(req, res, req.params.id, { signals: { items: "" } });
});

app.post("/tasks/:id/mode/:mode", requireHousehold, async (req, res) => {
  const listMode = req.params.mode === "shopping" ? "shopping" : "checklist";
  // Fill in store sections first, so the re-render that updateTask triggers shows them.
  if (listMode === "shopping") await autoCategorize(req.actor, req.params.id);
  await updateTask(req.actor, req.params.id, { listMode });
  await sendChecklist(req, res, req.params.id);
});

app.post("/tasks/:id/uncheck-all", requireHousehold, async (req, res) => {
  await uncheckAll(req.actor, req.params.id);
  await sendChecklist(req, res, req.params.id);
});

app.post("/tasks/:id/clear-checked", requireHousehold, async (req, res) => {
  await clearChecked(req.actor, req.params.id);
  await sendChecklist(req, res, req.params.id);
});

app.post("/items/:id/check", requireHousehold, async (req, res) => {
  await sendChecklist(req, res, await setItemChecked(req.actor, req.params.id, true));
});

app.post("/items/:id/uncheck", requireHousehold, async (req, res) => {
  await sendChecklist(req, res, await setItemChecked(req.actor, req.params.id, false));
});

app.post("/items/:id/delete", requireHousehold, async (req, res) => {
  await sendChecklist(req, res, await deleteItem(req.actor, req.params.id));
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

const renderLogin = (res, data, status) =>
  render(res, "pages/login", { google: googleConfigured(), devLogin: config.devLogin, ...data }, status);

app.get("/login", (req, res) => {
  if (req.user) return redirect(res, safeNext(req.query.next));
  renderLogin(res, { next: safeNext(req.query.next) });
});

// Slows password guessing: failed sign-ins per account, and per IP across accounts
// (higher, since a household or office can share one IP). Sign-ups: new accounts per IP.
const accountFailures = createRateLimit({ limit: 10, windowMs: 15 * 60_000 });
const ipFailures = createRateLimit({ limit: 50, windowMs: 15 * 60_000 });
const signups = createRateLimit({ limit: 10, windowMs: 60 * 60_000 });

app.post("/login", async (req, res) => {
  const next = safeNext(req.body.next);
  const identifier = String(req.body.identifier ?? "").trim().slice(0, 254);
  const accountKey = `account:${identifier.toLowerCase()}`;
  if (accountFailures.isLimited(accountKey) || ipFailures.isLimited(req.ip)) {
    return renderLogin(res, { next, identifier, error: "Too many failed sign-ins. Try again in 15 minutes." }, 429);
  }
  const userId = await verifyLogin(identifier, req.body.password);
  if (!userId) {
    accountFailures.hit(accountKey);
    ipFailures.hit(req.ip);
    return renderLogin(res, { next, identifier, error: "That username or email and password don't match." }, 401);
  }
  accountFailures.reset(accountKey);
  await startSession(res, userId);
  redirect(res, next);
});

app.get("/signup", (req, res) => {
  if (req.user) return redirect(res, safeNext(req.query.next));
  render(res, "pages/signup", { next: safeNext(req.query.next) });
});

app.post("/signup", async (req, res) => {
  const next = safeNext(req.body.next);
  const form = { next, username: String(req.body.username ?? "").slice(0, 30), email: String(req.body.email ?? "").slice(0, 254) };
  if (signups.isLimited(req.ip)) {
    return render(res, "pages/signup", { ...form, error: "Too many new accounts from here. Try again later." }, 429);
  }
  let userId;
  try {
    userId = await createPasswordUser(req.body);
  } catch (err) {
    if (err instanceof HttpError && err.status === 400) return render(res, "pages/signup", { ...form, error: err.message }, 400);
    throw err;
  }
  signups.hit(req.ip);
  await startSession(res, userId);
  redirect(res, next);
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
