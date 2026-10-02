import express from "express";
import QRCode from "qrcode";
import { Eta } from "eta";
import { fileURLToPath } from "node:url";
import { config, googleConfigured, photosConfigured } from "./src/config.js";
import { initDb } from "./src/db/client.js";
import { migrate } from "./src/db/migrate.js";
import { HttpError, parseCookies, redirect, sendHtml, sse } from "./src/lib/http.js";
import { publish, subscribe } from "./src/lib/pubsub.js";
import { endSession, loadSession, startSession } from "./src/auth/session.js";
import { beginGoogleLogin, completeGoogleLogin, safeNext } from "./src/auth/google-oauth.js";
import { AVATAR_MAX_BYTES, createPasswordUser, getAvatarPhoto, getUser, MEMBER_COLOR_NAMES, MEMBER_COLORS, removeAvatarPhoto, setAvatarPhoto, updateColor, updateName, updateProfile, updateSignIn, upsertDevUser, upsertGoogleUser, verifyLogin } from "./src/services/users.js";
import { createRateLimit } from "./src/lib/rate-limit.js";
import { acceptInvite, createHousehold, createInvite, getHouseholdForUser, getInvite, renameHousehold } from "./src/services/household.js";
import { changed, lastChangedAt, onChange } from "./src/services/changes.js";
import { addComment, assignTask, createTask, deleteTask, getTask, listBlockedBy, listTasks, LISTS, nextToSort, restoreTask, setDone, updateTask } from "./src/services/tasks.js";
import { addItems, autoCategorize, clearChecked, deleteItem, moveItem, renameItem, setItemChecked, uncheckAll } from "./src/services/checklist.js";
import { createProject, listProjects } from "./src/services/projects.js";
import { addSpot, ensureContext, getContext, listContexts, listSpots, removeSpot } from "./src/services/contexts.js";
import { searchPlaces } from "./src/services/geocode.js";
import { placesPageView, searchNudge } from "./src/web/places-page.js";
import { cleanCoords } from "./public/js/lib/places.js";
import { ACTIVITY_DAYS, activityView } from "./src/web/activity-page.js";
import { cleanListQuery, cleanView, decorateTask, LINGER_MS, listQueryString, NAV, quickAddList, taskListView, VIEWS } from "./src/web/task-list.js";
import { hideDone } from "./src/web/hidden-done.js";
import { doneTodayView } from "./src/web/done-today.js";
import { nextPhraseIndex, phraseIndex, phraseText } from "./src/web/household-phrase.js";
import { lastResetAt, recordReset, resetDue, resetSummary, snoozeReset } from "./src/services/reset.js";
import { deleteComment, markCommentsSeen, restoreComment } from "./src/services/comments.js";
import { commentsView } from "./src/web/comments.js";
import { ANSWER_LABELS, RESET_STEPS, resetStepView } from "./src/web/reset-page.js";
import { cancelEmailChange, confirmEmail, describeLink, describeResetLink, emailConfirmed, isPasswordAccount, linkSent, requestPasswordReset, resendConfirmation, resetPassword, sendVerifyEmail } from "./src/services/email-confirm.js";
import { PHOTO_SIZES, taskPhotosView } from "./src/web/task-photos.js";
import { addItemPhoto, addPhoto, getPhoto, PHOTO_MAX_BYTES, PURGE_INTERVAL_MS, purgeDeletedTaskPhotos, removePhoto } from "./src/services/photos.js";
import { signedImageUrl } from "./src/lib/cloudinary.js";
import { NEEDS_DETAILS, quickDates, SORT_CHOICES, sortDecision } from "./src/web/sort-page.js";
import { shortcutsInTitle, withTypedShortcuts } from "./src/web/typed-shortcuts.js";
import { INSERT_TOKEN, SHORTCUT_EXAMPLE, shortcutGroups } from "./src/web/shortcuts.js";
import { checklistView } from "./src/web/checklist.js";
import { autosaveInput, editFormView, editInput, savedMessage } from "./src/web/task-page.js";
import { parseQuickAdd } from "./public/js/lib/quick-add.js";
import { addDays, nowIn, relativeLabel, todayIn } from "./public/js/lib/dates.js";
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
// Every page gets the saved theme (see the layout); pages can still pass their own data.
const render = (res, name, data = {}, status = 200) =>
  sendHtml(res, eta.render(name, { theme: res.locals.theme, icons: res.locals.icons, you: res.locals.user?.color, renderedAt: res.locals.renderedAt, dev: !config.isProduction, ...data }), status);

// --- Google sync + live updates -------------------------------------------------------

const sync = googleConfigured()
  ? createSyncEngine({
      api: createTasksApi({ getAccessToken }),
      appUrl: config.baseUrl,
      listTitle: config.google.listTitle,
    })
  : null;

onChange(({ householdId, taskId, fromGoogle, editedBy }) => {
  publish(householdId, { type: "changed", taskId, editedBy });
  if (sync && taskId && !fromGoogle) {
    sync.enqueue(taskId).then(() => sync.processQueue()).catch((err) => console.error("sync enqueue failed", err));
  }
});

const syncTimer = sync
  ? setInterval(() => sync.syncNow().catch((err) => console.error("sync failed", err)), config.google.syncIntervalMs)
  : null;

// Photos of tasks deleted past the restore window, cleared from Cloudinary at startup and then hourly.
const purgePhotos = () => purgeDeletedTaskPhotos().catch((err) => console.error("photo purge failed", err));
const purgeTimer = photosConfigured() ? setInterval(purgePhotos, PURGE_INTERVAL_MS) : null;

// --- App ------------------------------------------------------------------------------

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", config.isProduction);

app.use(express.static(dir("./public"), { maxAge: config.isProduction ? "1h" : 0 }));
app.use(express.urlencoded({ extended: false, limit: "256kb" }));
app.use(express.json({ limit: "256kb" }));

// Every handler gets req.cookies, req.user (or null) and req.membership (household + members).
app.use(async (req, res, next) => {
  // Before anything is read: a page's live stream compares it with the household's last change (see /events).
  res.locals.renderedAt = Date.now();
  req.cookies = parseCookies(req.headers.cookie);
  req.user = await loadSession(req.cookies);
  req.membership = req.user ? await getHouseholdForUser(req.user.id) : null;
  res.locals.user = req.user;
  res.locals.theme = ["light", "dark"].includes(req.cookies.theme) ? req.cookies.theme : null;
  res.locals.icons = req.cookies.icons === "off" ? "off" : null;
  res.locals.config = config;
  next();
});

const requireUser = (req, res, next) =>
  req.user ? next() : redirect(res, `/login?next=${encodeURIComponent(req.originalUrl)}`);

app.get("/healthz", (req, res) => res.type("text").send("ok"));

const today = (req) => todayIn(req.cookies.tz);
/** The viewer's date and wall-clock time, for due times (tasks due earlier today are overdue). */
const clock = (req) => nowIn(req.cookies.tz);
/** Whether Mine should suggest this person's weekly reset (see src/services/reset.js). */
const resetDueFor = (req, membership) => {
  const me = membership.members.find((m) => m.id === req.user.id);
  return me ? resetDue(membership.household.id, me) : false;
};
const decorate = (req, task, membership = req.membership) => {
  const { today, time } = clock(req);
  return decorateTask(task, membership, today, time);
};
const doneToday = (req, membership) => doneTodayView({ membership, timeZone: req.cookies.tz });
/**
 * How to-do lists are grouped on this device: by date ("when", the default) or by where/how. It's a cookie, but a
 * page's live stream (/events) keeps the cookies it opened with, so a switch made after that is also kept here,
 * per sign-in, and wins: otherwise the next live update would put the list back the old way.
 */
const groupSwitches = new Map();
const groupBy = (req) => groupSwitches.get(req.user?.session_id) ?? (req.cookies.group === "where" ? "where" : "when");
const isDatastar = (req) => req.get("datastar-request") === "true";

/** The home page's nudge to confirm your email (or a pending new one), for password accounts; null if there's nothing to confirm. */
async function emailNoticeView(req) {
  const u = req.user;
  if (!isPasswordAccount(u) || (emailConfirmed(u) && !u.pending_email)) return null;
  const email = u.pending_email ?? u.email;
  // Accounts from before confirmation existed were never sent a link, so don't claim one was.
  return { email, pending: Boolean(u.pending_email), sent: req.query.email === "sent", linkOut: await linkSent(u.id, email) };
}

/** The line under the brand: the one remembered on this device (typed out already, so it just shows), or a new one,
 *  typed out and remembered. */
function householdLine(req, res) {
  if (!req.membership) return null;
  const saved = phraseIndex(req.cookies.phrase);
  const index = saved ?? nextPhraseIndex();
  if (saved === null) res.append("Set-Cookie", phraseCookie(index));
  return { index, text: phraseText(req.membership.household.name, index), animate: saved === null };
}
const phraseCookie = (index) => `phrase=${index}; Path=/; Max-Age=31536000; SameSite=Lax`;

/** After deleting from the task page (?deleted=): the toast with Undo, while the delete is fresh and not undone. */
async function deletedNotice(req) {
  const id = typeof req.query.deleted === "string" ? req.query.deleted : null;
  if (!id || !req.membership) return null;
  const task = await getTask(req.membership.household.id, id, { includeDeleted: true }).catch((err) => (isNotFound(err) ? null : Promise.reject(err)));
  if (!task?.deleted_at || Date.now() - Date.parse(task.deleted_at) > 5 * 60_000) return null;
  return { message: `Deleted “${task.title}”`, undo: `/tasks/${task.id}/restore` };
}

app.get("/", async (req, res) => {
  // Not signed in: the landing page, instead of straight to the sign-in form.
  if (!req.user) return render(res, "pages/landing", { baseUrl: config.baseUrl });
  const list = req.membership
    ? await taskListView({ userId: req.user.id, membership: req.membership, ...cleanListQuery(req.query), groupBy: groupBy(req), ...clock(req), resetDue: await resetDueFor(req, req.membership) })
    : null;
  render(res, "pages/home", { user: req.user, membership: req.membership, list, doneToday: req.membership && (await doneToday(req, req.membership)), views: VIEWS, nav: NAV, listQueryString, qr: appQr, shortcuts: shortcutsView(req), photosEnabled: photosConfigured(),
    householdLine: householdLine(req, res),
    emailNotice: await emailNoticeView(req), flash: req.query.password === "changed" ? { message: "Password changed. You're signed in." } : await deletedNotice(req) });
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
// It's also sent on connect, so a reconnect catches up on whatever was missed, unless the page says it's
// current: `since` is when it was rendered and `next` its list's refreshAt. If nothing in the household has
// changed since then and that time hasn't come, the page already shows what a render would, so skip it.
app.get("/events", requireHousehold, async (req, res) => {
  const listQuery = cleanListQuery(req.query);
  const since = Number(req.query.since) || 0;
  const next = Number(req.query.next) || null;
  const taskId = typeof req.query.task === "string" ? req.query.task : null;
  const { householdId } = req.actor;
  // The task was deleted: 204 is the one response Datastar's retry: 'always' won't retry.
  if (taskId && !(await getTask(householdId, taskId).then(() => true, (err) => (isNotFound(err) ? false : Promise.reject(err))))) {
    return res.status(204).end();
  }
  let closed = false;
  // When a finished task is due to drop off the list; nothing else changes, so the stream re-renders itself then.
  let dropTimer = null;
  let refresh = () => {}; // set once the stream is open
  /** @type {string | null} who else last changed this task's details, until the next render tells the edit form */
  let editedBy = null;
  const scheduleDrop = (at) => {
    clearTimeout(dropTimer);
    if (at && !closed) dropTimer = setTimeout(refresh, Math.max(at - Date.now(), 0) + 1000);
  };

  /** @returns {Promise<string[]>} the page's live parts */
  const renderPage = async (membership) => {
    if (taskId) {
      const checklist = await checklistView(householdId, taskId);
      return [renderTaskHead(req, checklist.task, membership), ...renderChecklist(checklist), await renderPhotos(householdId, taskId), await renderComments(req, taskId, membership)];
    }
    const list = await taskListView({ userId: req.user.id, membership, ...listQuery, groupBy: groupBy(req), ...clock(req), resetDue: await resetDueFor(req, membership) });
    scheduleDrop(list.refreshAt);
    return renderList(list, req.user.id, await doneToday(req, membership));
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
        if (!closed) stream.patchElements(eta.render("partials/flash", { message: "This task was deleted", error: true, sticky: true }));
        return res.end();
      }
      if (!closed) for (const html of parts) stream.patchElements(html);
      // Someone else saved a change to this task: an open edit form (which isn't re-rendered) says so; see task-edit.eta.
      if (editedBy && !closed) {
        const by = membership.members.find((m) => m.id === editedBy)?.name ?? "Someone";
        stream.patchSignals(JSON.stringify({ editedBy: by }));
        editedBy = null;
      }
    };

    // One render at a time; changes that arrive mid-render are folded into one more render.
    let running = null;
    let again = false;
    refresh = () => {
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

    const unsubscribe = subscribe(householdId, (event) => {
      if (taskId && event?.taskId === taskId && event.editedBy && event.editedBy !== req.user.id) editedBy = event.editedBy;
      refresh();
    });
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000); // keeps proxies from idling us out
    const current = since > lastChangedAt(householdId) && (!next || next > Date.now());
    if (!current) refresh();
    else if (!taskId) scheduleDrop(next);
    await new Promise((resolve) => res.on("close", resolve));
    closed = true;
    unsubscribe();
    clearInterval(heartbeat);
    clearTimeout(dropTimer);
  });
});

/** The home page's live parts: the tabs (for the inbox count) and the task list. */
const renderList = (list, userId, doneToday) => [
  eta.render("partials/done-today", doneToday),
  eta.render("partials/tabs", { list, views: VIEWS, nav: NAV, listQueryString }),
  eta.render("partials/task-list", { ...list, userId, doneToday }),
];

/** Datastar: re-render the task list (plus an optional flash). Plain form posts: back to the list.
 *  `grouping` overrides the group cookie, for the request that has just changed it. */
async function sendTaskList(req, res, { flash, signals, grouping } = {}) {
  if (req.body.back === "task") return sendTaskHead(req, res, req.params.id, { flash });
  const listQuery = cleanListQuery(req.body);
  if (!isDatastar(req)) return redirect(res, `/?${listQueryString(listQuery)}`);
  const list = await taskListView({ userId: req.user.id, membership: req.membership, ...listQuery, groupBy: grouping ?? groupBy(req), ...clock(req), resetDue: await resetDueFor(req, req.membership) });
  const parts = renderList(list, req.user.id, await doneToday(req, req.membership));
  const flashHtml = eta.render("partials/flash", flash ?? {});
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

/** What quick add needs to read shortcuts: today, who "me" is, and the household's names. */
const quickAddContext = async (req) => ({
  today: today(req),
  meId: req.user.id,
  members: req.membership.members,
  projects: await listProjects(req.actor.householdId),
  contexts: await listContexts(req.actor.householdId),
});

app.post("/tasks", requireHousehold, async (req, res) => {
  const { household } = req.membership;
  const parsed = parseQuickAdd(String(req.body.quick ?? ""), await quickAddContext(req));
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
  // Finishing a task unblocks whatever was waiting on it; say so.
  const unblocked = await listBlockedBy(req.actor.householdId, req.params.id);
  const nextId = await setDone(req.actor, req.params.id, true, { today: today(req) });
  const next = nextId && (await getTask(req.actor.householdId, nextId));
  const messages = [
    next && `Next one due ${relativeLabel(next.due_date, today(req))}`,
    unblocked.length && `Ready to go: ${unblocked.map((u) => `“${u.title}”`).join(", ")}`,
  ].filter(Boolean);
  const flash = messages.length ? { message: messages.join(" · ") } : undefined;
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

// Rename from the task list. Datastar sends the typed name as the renameText signal; a plain form sends title.
// Shortcuts in the new name ("… sun @phone") are applied like quick add's, and the flash says what they did.
app.post("/tasks/:id/rename", requireHousehold, async (req, res) => {
  const task = await getTask(req.actor.householdId, req.params.id);
  const { input, summary } = shortcutsInTitle(req.body.title ?? req.body.renameText, task, await quickAddContext(req));
  await updateTask(req.actor, task.id, await resolveNames(req.actor.householdId, input));
  const moved = input.list === "todo" ? " and moved to To do" : "";
  const flash = summary ? { message: `Renamed${moved} · ${summary}` } : undefined;
  await sendTaskList(req, res, { flash, signals: { renaming: "", renameText: "" } });
});

// Hide a finished task from your lists now instead of when it drops off on its own. Just for you.
app.post("/tasks/:id/hide", requireHousehold, async (req, res) => {
  const task = await getTask(req.actor.householdId, req.params.id);
  if (task.status === "done") {
    hideDone(req.user.id, task.id, task.completed_at, Date.parse(task.completed_at) + LINGER_MS);
    publish(req.actor.householdId); // your other open pages
  }
  await sendTaskList(req, res);
});

app.post("/tasks/:id/claim", requireHousehold, async (req, res) => {
  await assignTask(req.actor, req.params.id, req.user.id);
  await sendTaskList(req, res);
});

app.post("/tasks/:id/delete", requireHousehold, async (req, res) => {
  const task = await getTask(req.actor.householdId, req.params.id);
  await deleteTask(req.actor, task.id);
  // From the task page: back to your lists, which say what was deleted and offer Undo.
  if (req.body.back === "task-page") return redirect(res, `/?deleted=${task.id}`);
  await sendTaskList(req, res, { flash: { message: `Deleted “${task.title}”`, undo: `/tasks/${task.id}/restore` }, signals: { renaming: "" } });
});

app.post("/tasks/:id/restore", requireHousehold, async (req, res) => {
  await restoreTask(req.actor, req.params.id);
  await sendTaskList(req, res);
});

// --- Weekly reset ---------------------------------------------------------------------
// Each person's step-by-step check-in (src/web/reset-page.js). Starting one sets reset_started (its start time, for
// a day), so Sort my inbox can offer the way back and the last screen can say what got done since.

/** When the reset in progress started (ms), or null. */
const resetStarted = (req) => {
  const at = Number(req.cookies.reset_started);
  return Number.isFinite(at) && at > 0 && Date.now() - at < 86_400_000 ? at : null;
};

app.get("/reset", requireHousehold, async (req, res) => {
  const last = await lastResetAt(req.actor.householdId, req.user.id);
  render(res, "pages/reset", { start: true, steps: RESET_STEPS, last: last && relativeLabel(todayIn(req.cookies.tz, new Date(last)), today(req)) });
});

app.post("/reset/start", requireHousehold, (req, res) => {
  res.append("Set-Cookie", `reset_started=${Date.now()}; Path=/; Max-Age=86400; SameSite=Lax`);
  redirect(res, `/reset/${RESET_STEPS[0].key}`);
});

// "Not now" on Mine's reset card: hidden for a day (on this server; see snoozeReset).
app.post("/reset/later", requireHousehold, async (req, res) => {
  snoozeReset(req.user.id);
  await sendTaskList(req, res);
});

app.post("/reset/finish", requireHousehold, async (req, res) => {
  const started = resetStarted(req) ?? Date.now();
  const summary = await resetSummary(req.actor.householdId, req.user.id, new Date(started).toISOString());
  await recordReset(req.actor, summary);
  res.append("Set-Cookie", "reset_started=; Path=/; Max-Age=0; SameSite=Lax");
  redirect(res, `/reset/done?${new URLSearchParams({ f: summary.finished, c: summary.changed, d: summary.deleted })}`);
});

app.get("/reset/done", requireHousehold, (req, res) => {
  const n = (k) => Math.max(0, Math.floor(Number(req.query[k]) || 0));
  render(res, "pages/reset", { finished: true, summary: { finished: n("f"), changed: n("c"), deleted: n("d") } });
});

const resetStep = (req, step) => resetStepView({ step, userId: req.user.id, membership: req.membership, ...clock(req) });

app.get("/reset/:step", requireHousehold, async (req, res) => {
  const view = await resetStep(req, req.params.step);
  if (!view) throw new HttpError(404, "Page not found");
  render(res, "pages/reset", { view, labels: ANSWER_LABELS });
});

/** Datastar: re-render the step's list (and a toast). Plain form posts: back to the step. */
async function sendResetStep(req, res, step, flash) {
  if (!isDatastar(req)) return redirect(res, `/reset/${step}`);
  const view = await resetStep(req, step);
  await sse(req, res, (stream) => {
    stream.patchElements(eta.render("partials/reset-step", { view, labels: ANSWER_LABELS }));
    stream.patchElements(eta.render("partials/flash", flash ?? {}));
  });
}

// One answer about one task: it saves through the usual task services, so the usual rules (and activity) apply.
app.post("/reset/:step/:id", requireHousehold, async (req, res) => {
  const { step, id } = req.params;
  const answer = String(req.query.do ?? req.body.do ?? "");
  const day = today(req);
  const task = await getTask(req.actor.householdId, id);
  // "Moved to tomorrow", "Moved to Fri", "Moved to Oct 8".
  const moved = (date) => `Moved to ${relativeLabel(date, day).replace(/^(Today|Tomorrow)$/, (w) => w.toLowerCase())}`;
  let flash;
  switch (answer) {
    case "done":
      await setDone(req.actor, id, true, { today: day });
      flash = { message: `Finished “${task.title}”` };
      break;
    case "tomorrow": case "nextweek": {
      const date = addDays(day, answer === "tomorrow" ? 1 : 7);
      await updateTask(req.actor, id, { dueDate: date });
      flash = { message: moved(date) };
      break;
    }
    case "date": {
      const date = String(req.body.date ?? "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, "Pick a date");
      await updateTask(req.actor, id, { dueDate: date });
      flash = { message: moved(date) };
      break;
    }
    case "later":
      await updateTask(req.actor, id, { list: "someday", dueDate: null, dueTime: null });
      flash = { message: "Moved to Maybe later" };
      break;
    case "ready": case "start":
      await updateTask(req.actor, id, { list: "todo", waitingTaskId: null });
      flash = { message: "Back on To do" };
      break;
    case "claim":
      await assignTask(req.actor, id, req.user.id);
      flash = { message: `“${task.title}” is yours` };
      break;
    case "delete":
      await deleteTask(req.actor, id);
      flash = { message: `Deleted “${task.title}”`, undo: `/reset/${step}/${id}/restore` };
      break;
    default:
      throw new HttpError(400, "Unknown answer");
  }
  await sendResetStep(req, res, step, flash);
});

app.post("/reset/:step/:id/restore", requireHousehold, async (req, res) => {
  await restoreTask(req.actor, req.params.id);
  await sendResetStep(req, res, req.params.step);
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
    task: task && decorate(req, task),
    left: next.left,
    skipped: Boolean(after) && !task && next.left > 0,
    resetting: Boolean(resetStarted(req)),
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
    // Shortcuts typed into the name fill in whatever the picked answer didn't set.
    const typed = shortcutsInTitle(req.body.title, task, await quickAddContext(req)).input;
    const input = withTypedShortcuts(typed, decision.input, req.user.id);
    await updateTask(req.actor, task.id, await resolveNames(req.actor.householdId, input));
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

app.get("/about", (req, res) => render(res, "pages/about", {}));

app.get("/activity", requireHousehold, async (req, res) => {
  const who = typeof req.query.who === "string" ? req.query.who : null;
  const activity = await activityView({ userId: req.user.id, membership: req.membership, timeZone: req.cookies.tz, today: today(req), who, all: req.query.all === "1" });
  render(res, "pages/activity", { activity, days: ACTIVITY_DAYS, household: req.membership.household.name });
});

app.get("/help", requireUser, (req, res) =>
  render(res, "pages/help", { shortcuts: shortcutsView(req), choices: SORT_CHOICES, nav: NAV, views: VIEWS }),
);

// --- Task page + checklist ------------------------------------------------------------

const renderTaskHead = (req, task, membership = req.membership) =>
  eta.render("partials/task-head", { task: decorate(req, task, membership), userId: req.user.id });

/** Open tasks this one could be blocked by: not someone else's private inbox, not a template. */
const blockerChoices = async (req) =>
  (await listTasks(req.actor.householdId, { status: "open" })).filter((t) => t.list !== "inbox" || t.creator_id === req.user.id);

/** The edit form's data; `focus` is the field a tap on the task page asked to start in (?focus=). */
const editView = async (req, task, focus = null) =>
  editFormView(task, {
    focus,
    openTasks: await blockerChoices(req),
    today: today(req),
    userId: req.user.id,
    members: req.membership.members,
    projects: await listProjects(req.actor.householdId),
    contexts: await listContexts(req.actor.householdId),
  });

async function renderTaskPage(req, res, { editing = false } = {}) {
  const checklist = await checklistView(req.actor.householdId, req.params.id);
  const task = decorate(req, checklist.task);
  const form = editing ? await editView(req, checklist.task, String(req.query.focus ?? "")) : null;
  const photos = await taskPhotosView(req.actor.householdId, task.id);
  const comments = await taskComments(req, req.membership, task.id);
  render(res, "pages/task", { task, checklist, form, photos, comments, userId: req.user.id });
}

/** The task's comments for its page, which also counts as seeing them (so its row's "new" dot goes). */
async function taskComments(req, membership, taskId) {
  await markCommentsSeen(req.user.id, taskId);
  return commentsView(taskId, { userId: req.user.id, membership, timeZone: req.cookies.tz, today: today(req) });
}
const renderComments = async (req, taskId, membership = req.membership) => eta.render("partials/comments", await taskComments(req, membership, taskId));

// Commenting on a task, and deleting (or, from the toast, restoring) your own comment. Datastar re-renders the list
// in place (and clears the box); without script, back to the task page.
app.post("/tasks/:id/comments", requireHousehold, async (req, res) => {
  await addComment(req.actor, req.params.id, req.body.comment ?? req.body.body);
  if (!isDatastar(req)) return redirect(res, `/tasks/${req.params.id}#comments`);
  const html = await renderComments(req, req.params.id);
  await sse(req, res, (stream) => {
    stream.patchElements(html);
    stream.patchSignals(JSON.stringify({ comment: "" }));
  });
});

// The edit form's note for whoever a task was just handed to: a comment, so they see it's new.
app.post("/tasks/:id/hand-over", requireHousehold, async (req, res) => {
  await addComment(req.actor, req.params.id, req.body.handNote);
  const to = String(req.body.handTo ?? "").trim();
  await sse(req, res, (stream) => {
    stream.patchSignals(JSON.stringify({ handNote: "", handTo: "" }));
    stream.patchElements(eta.render("partials/flash", { message: to ? `Note sent to ${to}` : "Note sent" }));
  });
});

app.post("/comments/:id/delete", requireHousehold, async (req, res) => {
  const c = await deleteComment(req.actor, req.params.id);
  if (!isDatastar(req)) return redirect(res, `/tasks/${c.task_id}#comments`);
  const html = await renderComments(req, c.task_id);
  const flash = eta.render("partials/flash", { message: "Comment deleted", undo: `/comments/${c.id}/restore` });
  await sse(req, res, (stream) => (stream.patchElements(html), stream.patchElements(flash)));
});

app.post("/comments/:id/restore", requireHousehold, async (req, res) => {
  const c = await restoreComment(req.actor, req.params.id);
  if (!isDatastar(req)) return redirect(res, `/tasks/${c.task_id}#comments`);
  const html = await renderComments(req, c.task_id);
  await sse(req, res, (stream) => (stream.patchElements(html), stream.patchElements(eta.render("partials/flash", {}))));
});

const renderPhotos = async (householdId, taskId) => eta.render("partials/task-photos", await taskPhotosView(householdId, taskId));

// A photo for a task. The task page shrinks it in the browser and posts the bytes as the whole body
// (image/jpeg), like /settings/photo; the server uploads it to Cloudinary. Errors come back as text.
app.post("/tasks/:id/photos", requireHousehold, express.raw({ type: "image/*", limit: PHOTO_MAX_BYTES }), async (req, res) => {
  try {
    await addPhoto(req.actor, req.params.id, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
  } catch (err) {
    if (err instanceof HttpError && err.status < 500) return res.status(err.status).type("text").send(err.message);
    throw err;
  }
  res.sendStatus(204);
});

// A task's photos, for the photo viewer a task row's 📷 count opens.
app.get("/tasks/:id/photos", requireHousehold, async (req, res) => {
  await getTask(req.actor.householdId, req.params.id);
  const { photos } = await taskPhotosView(req.actor.householdId, req.params.id);
  res.json({ photos: photos.map(({ full, tiny }) => ({ full, tiny })) });
});

// A task photo, for its household only. Photos are private on Cloudinary, so the app fetches one on a signed
// URL (passing Accept along so f_auto picks a format this browser takes) and relays it. A photo never
// changes, so the browser may keep it for good; "private" keeps shared caches from storing it.
app.get("/photos/:id/:size", requireHousehold, async (req, res) => {
  const transform = PHOTO_SIZES[req.params.size];
  if (!transform) return res.sendStatus(404);
  const photo = await getPhoto(req.actor.householdId, req.params.id).catch((err) => (isNotFound(err) ? null : Promise.reject(err)));
  if (!photo) return res.sendStatus(404);
  const upstream = await fetch(signedImageUrl(photo.public_id, transform), { headers: { Accept: req.get("accept") ?? "image/*" } });
  if (!upstream.ok) {
    console.error("couldn't fetch photo from Cloudinary", photo.public_id, upstream.status, upstream.headers.get("x-cld-error"));
    return res.sendStatus(502);
  }
  res.set({
    "Cache-Control": "private, max-age=31536000, immutable",
    "Content-Type": upstream.headers.get("content-type") ?? "image/jpeg",
    "X-Content-Type-Options": "nosniff",
    Vary: "Accept",
  });
  res.send(Buffer.from(await upstream.arrayBuffer()));
});

app.post("/photos/:id/delete", requireHousehold, async (req, res) => {
  const taskId = await removePhoto(req.actor, req.params.id);
  if (!isDatastar(req)) return redirect(res, `/tasks/${taskId}`);
  const html = await renderPhotos(req.actor.householdId, taskId);
  await sse(req, res, (stream) => stream.patchElements(html));
});

/** Datastar: re-render the task details (plus an optional flash, and closing the edit form). Plain posts: back to the task page. */
async function sendTaskHead(req, res, taskId, { flash, signals } = {}) {
  if (!isDatastar(req)) return redirect(res, `/tasks/${taskId}`);
  const html = renderTaskHead(req, await getTask(req.actor.householdId, taskId));
  const flashHtml = eta.render("partials/flash", flash ?? {});
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
  const task = await getTask(req.actor.householdId, req.params.id);
  const html = eta.render("partials/task-edit", { form: await editView(req, task, String(req.query.focus ?? "")) });
  await sse(req, res, (stream) => {
    stream.patchElements(html);
    stream.patchSignals(JSON.stringify({ editing: true, editedBy: "", handTo: "", handNote: "" }));
  });
});

/** The newest autosave applied per person and task, so one that arrives late can't undo a newer one. */
const lastAutosave = new Map();

// The edit form saves as you go: each change posts the whole form with ?saved=<field> and a seq (the
// browser's clock), answered with a toast and the form left open. "Done" is a plain submit: it saves and closes.
app.post("/tasks/:id/edit", requireHousehold, async (req, res) => {
  const { householdId } = req.actor;
  const autosave = typeof req.query.saved === "string" && isDatastar(req);
  if (autosave) {
    const key = `${req.user.id}:${req.params.id}`;
    const seq = Number(req.body.seq) || 0;
    if (seq && seq <= (lastAutosave.get(key) ?? 0)) return sse(req, res, () => {});
    lastAutosave.set(key, seq);
  }
  // An autosave writes only the field that changed, so it can't undo what someone else saved meanwhile.
  const fields = autosave ? autosaveInput(editInput(req.body), String(req.query.saved)) : editInput(req.body);
  const { newBlocker, ...input } = fields;
  const newProject = input.projectName;
  let flash = autosave ? { message: savedMessage(req.query.saved) } : undefined;

  // "Has to wait for: ➕ New task…" with no name yet: an autosave of another field leaves the blocker alone.
  if (autosave && newBlocker === "") delete input.waitingTaskId;
  // "Has to wait for: ➕ New task…": create the task that has to happen first (shortcuts work, it lands on
  // To do, in this task's project unless a #project was typed), then block this one on it.
  else if (newBlocker !== undefined) {
    if (!newBlocker) throw new HttpError(400, "Name the task that has to happen first");
    const task = await getTask(householdId, req.params.id);
    const parsed = parseQuickAdd(newBlocker, await quickAddContext(req));
    const blocker = await resolveNames(householdId, { projectId: task.project_id, ...parsed, list: "todo" });
    input.waitingTaskId = await createTask(req.actor, blocker);
    flash = { message: `Added “${blocker.title}”. This one waits on it.` };
  }
  await updateTask(req.actor, req.params.id, await resolveNames(householdId, input));
  if (!autosave) return sendTaskHead(req, res, req.params.id, { flash, signals: { editing: false } });
  const task = await getTask(householdId, req.params.id);
  // Its real name: one that already existed by that name is reused, whatever the case typed.
  if (newProject) flash = { message: `Now in “${task.project_name ?? newProject}”` };
  // A new blocker or project re-renders the form, so it's the one picked and the next save doesn't add it again.
  const form = newBlocker || newProject ? eta.render("partials/task-edit", { form: await editView(req, task) }) : null;
  await sse(req, res, (stream) => {
    stream.patchElements(renderTaskHead(req, task));
    if (form) stream.patchElements(form);
    stream.patchElements(eta.render("partials/flash", flash));
  });
});

/** The task page's live checklist parts: its header (title, count, list/shopping switch) and the items. */
const renderChecklist = (checklist) => [eta.render("partials/checklist-head", checklist), eta.render("partials/checklist", checklist)];

/** Datastar: re-render the checklist (and clear any error). Plain form posts: back to the task page. */
async function sendChecklist(req, res, taskId, { signals, flash } = {}) {
  if (!isDatastar(req)) return redirect(res, `/tasks/${taskId}`);
  const parts = renderChecklist(await checklistView(req.actor.householdId, taskId));
  await sse(req, res, (stream) => {
    for (const html of parts) stream.patchElements(html);
    stream.patchElements(eta.render("partials/flash", flash ?? {}));
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
  await sendChecklist(req, res, await deleteItem(req.actor, req.params.id), { signals: { itemRenaming: "" } });
});

// An item's photo: the bytes as the body, like /tasks/:id/photos. A new one replaces the old; the live update shows it.
app.post("/items/:id/photo", requireHousehold, express.raw({ type: "image/*", limit: PHOTO_MAX_BYTES }), async (req, res) => {
  try {
    await addItemPhoto(req.actor, req.params.id, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
  } catch (err) {
    if (err instanceof HttpError && err.status < 500) return res.status(err.status).type("text").send(err.message);
    throw err;
  }
  res.sendStatus(204);
});

// Drag (or arrow keys on the grip) to reorder within a section; see public/js/reorder-items.js.
// The page has already moved the row, so this just saves it; the live update tells everyone else.
app.post("/items/:id/move", requireHousehold, async (req, res) => {
  const taskId = await moveItem(req.actor, req.params.id, String(req.body.before ?? "") || null);
  await sendChecklist(req, res, taskId);
});

// Rename an item from its row. Datastar sends the typed name as the itemText signal; a plain form sends text.
app.post("/items/:id/rename", requireHousehold, async (req, res) => {
  const { taskId, movedTo } = await renameItem(req.actor, req.params.id, req.body.text ?? req.body.itemText);
  const flash = movedTo ? { message: `Moved to ${movedTo}` } : undefined;
  await sendChecklist(req, res, taskId, { flash, signals: { itemRenaming: "", itemText: "" } });
});

// --- Where / how places ---------------------------------------------------------------
// A where/how can be a real place with one or more spots on the map (every Target nearby), so the home page can
// say when you're near one (public/js/near-you.js). The page lists them all; a spot is added with "I'm here now"
// (the browser's position) or an address search (src/services/geocode.js). Datastar gets the list back with a
// toast; plain forms, a redirect.

const PLACE_SAVED = { added: "Spot added", updated: "Spot updated", removed: "Spot removed" };
const placesView = async (req, search = null) =>
  placesPageView(await listContexts(req.actor.householdId), await listSpots(req.actor.householdId), search, req.cookies.tz);
const renderPlaces = async (req, res, { search = null, saved, status = 200 } = {}) =>
  render(res, "pages/places", { user: req.user, ...(await placesView(req, search)), flash: saved ? { message: saved } : null }, status);

app.get("/places", requireHousehold, (req, res) => renderPlaces(req, res, { saved: PLACE_SAVED[req.query.saved] }));

async function sendPlaces(req, res, saved) {
  changed(req.actor.householdId); // open home pages get the new spot
  if (!isDatastar(req)) return redirect(res, `/places?saved=${saved}`);
  const view = await placesView(req);
  await sse(req, res, (stream) => {
    stream.patchElements(eta.render("partials/places-list", view));
    stream.patchElements(eta.render("partials/flash", { message: PLACE_SAVED[saved] }));
  });
}

const placeError = (req, res, err) => {
  if (!(err instanceof HttpError && err.status === 400)) throw err;
  if (!isDatastar(req)) return render(res, "pages/error", { status: 400, message: err.message }, 400);
  return sse(req, res, (stream) => stream.patchElements(eta.render("partials/flash", { message: err.message, error: true })));
};

// "I'm here now" (no label) and a picked search result (its address) both add a spot, or update one that's
// already there (see addSpot).
for (const how of ["here", "pick"]) {
  app.post(`/places/:id/${how}`, requireHousehold, async (req, res) => {
    let outcome;
    try {
      outcome = await addSpot(req.actor.householdId, req.params.id, { lat: req.body.lat, lng: req.body.lng, label: how === "pick" ? req.body.label : null });
    } catch (err) {
      return placeError(req, res, err);
    }
    await sendPlaces(req, res, outcome);
  });
}

app.post("/spots/:id/remove", requireHousehold, async (req, res) => {
  await removeSpot(req.actor.householdId, req.params.id);
  await sendPlaces(req, res, "removed");
});

// Address search: what's typed goes to OpenStreetMap (see geocode.js). Results lean towards the browser's
// position when it sent one (nearLat/nearLng), or else the household's first spot. 20 every 10 minutes per person.
const placeSearches = createRateLimit({ limit: 20, windowMs: 10 * 60_000 });
app.post("/places/:id/search", requireHousehold, async (req, res) => {
  const { householdId } = req.actor;
  const context = await getContext(householdId, req.params.id);
  const query = String(req.body.q ?? "").slice(0, 200);
  const search = { contextId: context.id, query, results: [], error: null };
  if (placeSearches.isLimited(req.user.id)) search.error = "That's a lot of searches. Try again in a few minutes.";
  else {
    placeSearches.hit(req.user.id);
    const near = cleanCoords(req.body.nearLat, req.body.nearLng) ?? searchNudge(await listSpots(householdId));
    try {
      search.results = await searchPlaces(query, near);
      if (!search.results.length) search.error = `Nothing found for “${query.trim()}”. Try adding the town, or a street.`;
    } catch (err) {
      if (!(err instanceof HttpError && [400, 502].includes(err.status))) throw err;
      search.error = err.message;
    }
  }
  if (!isDatastar(req)) return renderPlaces(req, res, { search });
  const row = placesPageView([context], [], search).rows[0];
  await sse(req, res, (stream) => {
    stream.patchElements(eta.render("partials/place-results", row));
  });
});

// --- Settings -------------------------------------------------------------------------

const renderSettings = async (req, res, { saved, error, signIn, status = 200 } = {}) => {
  const u = req.user;
  const rest = { emailLinkOut: isPasswordAccount(u) ? await linkSent(u.id, u.pending_email ?? u.email) : false };
  return render(res, "pages/settings", {
    user: req.user, // loaded fresh each request, so a just-saved name shows
    membership: req.membership,
    colors: MEMBER_COLORS,
    colorNames: MEMBER_COLOR_NAMES,
    saved,
    error,
    signIn, // what was typed into the sign-in form, kept after an error
    ...rest,
  }, status);
};

app.get("/settings", requireUser, (req, res) =>
  renderSettings(req, res, { saved: { profile: "Profile saved", photo: "Photo saved", "photo-removed": "Photo removed", "sign-in": "Sign-in details saved",
    "email-pending": "Check your new email for a link to confirm it", "email-cancelled": "Email change cancelled",
    "email-sent": "Link sent. Check your inbox", theme: "Appearance saved", icons: "Appearance saved", password: "Password changed. Other devices are signed out.", household: "Household renamed" }[req.query.saved] }),
);

app.post("/settings/profile", requireUser, async (req, res) => {
  try {
    await updateProfile(req.user.id, { name: req.body.name, color: req.body.color });
  } catch (err) {
    if (err instanceof HttpError && err.status === 400) return renderSettings(req, res, { error: err.message, status: 400 });
    throw err;
  }
  // Housemates' open pages show the new name and color.
  if (req.membership) changed(req.membership.household.id);
  redirect(res, "/settings?saved=profile");
});

// Username and email for password accounts, confirmed with the current password. Wrong passwords count
// against the same limits as signing in, so this can't be used to guess one.
app.post("/settings/sign-in", requireUser, async (req, res) => {
  const signIn = { username: String(req.body.username ?? "").slice(0, 60), email: String(req.body.email ?? "").slice(0, 254) };
  const key = `settings:${req.user.id}`;
  if (accountFailures.isLimited(key) || ipFailures.isLimited(req.ip)) {
    return renderSettings(req, res, { error: "Too many wrong passwords. Try again in 15 minutes.", signIn, status: 429 });
  }
  let result;
  try {
    result = await updateSignIn(req.user.id, {
      ...signIn, password: req.body.password, newPassword: req.body.newPassword, newPasswordAgain: req.body.newPasswordAgain, keepSession: req.user.session_id,
    });
  } catch (err) {
    // 400: something to fix in the form; 502: the confirmation email couldn't be sent.
    if (!(err instanceof HttpError && [400, 502].includes(err.status))) throw err;
    if (err.wrongPassword) (accountFailures.hit(key), ipFailures.hit(req.ip));
    return renderSettings(req, res, { error: err.message, signIn, status: err.status });
  }
  accountFailures.reset(key);
  const saved = result.pendingEmail ? "email-pending" : result.passwordChanged ? "password" : result.cancelledEmail ? "email-cancelled" : "sign-in";
  redirect(res, `/settings?saved=${saved}#account-title`);
});

// --- Confirming email ------------------------------------------------------------------------
// A link opens a page with a Confirm button; the POST does the work, so mail scanners that open
// links can't use them up. Neither needs you to be signed in: the token is the proof.
app.get("/email/confirm", async (req, res) => {
  const token = typeof req.query.token === "string" ? req.query.token : "";
  render(res, "pages/email-confirm", { token, link: await describeLink(token), user: req.user });
});

app.post("/email/confirm", async (req, res) => {
  try {
    const email = await confirmEmail(req.body.token);
    render(res, "pages/email-confirm", { done: email, user: req.user });
  } catch (err) {
    if (!(err instanceof HttpError && err.status === 400)) throw err;
    render(res, "pages/email-confirm", { error: err.message, user: req.user }, 400);
  }
});

// Another link, from the home page's nudge or Settings. A few an hour, so it can't be used to flood an inbox.
const emailResends = createRateLimit({ limit: 5, windowMs: 60 * 60_000 });
app.post("/email/resend", requireUser, async (req, res) => {
  const back = req.body.back === "home" ? "/" : "/settings";
  const fail = (message, status) =>
    back === "/" ? render(res, "pages/error", { status, message }, status) : renderSettings(req, res, { error: message, status });
  if (emailResends.isLimited(req.user.id)) return fail("That's a lot of emails. Try again in an hour.", 429);
  try {
    await resendConfirmation(req.user.id);
  } catch (err) {
    if (!(err instanceof HttpError && [400, 502].includes(err.status))) throw err;
    return fail(err.message, err.status);
  }
  emailResends.hit(req.user.id);
  redirect(res, back === "/" ? "/?email=sent" : "/settings?saved=email-sent#account-title");
});

app.post("/email/cancel", requireUser, async (req, res) => {
  await cancelEmailChange(req.user.id);
  redirect(res, "/settings?saved=email-cancelled#account-title");
});

// Leaving the name field saves it (like the color below), with a toast; errors show the same way.
app.post("/settings/name", requireUser, async (req, res) => {
  let name;
  try {
    name = await updateName(req.user.id, req.body.name);
  } catch (err) {
    if (!(err instanceof HttpError && err.status === 400)) throw err;
    if (!isDatastar(req)) return renderSettings(req, res, { error: err.message, status: 400 });
    // Put the saved name back in the field, so it doesn't look like the bad one was kept.
    return sse(req, res, (stream) => {
      stream.patchElements(eta.render("partials/flash", { message: err.message, error: true }));
      stream.patchSignals(JSON.stringify({ name: req.user.name }));
    });
  }
  if (req.membership) changed(req.membership.household.id);
  if (!isDatastar(req)) return redirect(res, "/settings?saved=profile");
  await sse(req, res, (stream) => {
    stream.patchElements(eta.render("partials/flash", { message: "Name saved" }));
    stream.patchSignals(JSON.stringify({ name }));
  });
});

// Picking a swatch saves the color at once (the page has already recolored your avatars).
app.post("/settings/color", requireUser, async (req, res) => {
  await updateColor(req.user.id, req.body.color);
  if (req.membership) changed(req.membership.household.id);
  if (!isDatastar(req)) return redirect(res, "/settings?saved=profile");
  await sse(req, res, (stream) => stream.patchElements(eta.render("partials/flash", { message: "Color saved" })));
});

// Your own photo. Settings shrinks the picked image to 256×256 in the browser and posts the bytes as the
// whole body (image/jpeg), so no multipart parser is needed. Errors come back as text for the form to show.
app.post("/settings/photo", requireUser, express.raw({ type: "image/*", limit: AVATAR_MAX_BYTES }), async (req, res) => {
  try {
    await setAvatarPhoto(req.user.id, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
  } catch (err) {
    if (err instanceof HttpError && err.status === 400) return res.status(400).type("text").send(err.message);
    throw err;
  }
  if (req.membership) changed(req.membership.household.id);
  res.sendStatus(204);
});

app.post("/settings/photo/remove", requireUser, async (req, res) => {
  await removeAvatarPhoto(req.user.id);
  if (req.membership) changed(req.membership.household.id);
  redirect(res, "/settings?saved=photo-removed");
});

// A member's photo, for them and their housemates only. The URL carries ?v=<when it was saved>, so a
// new photo gets a new URL and each one can be cached for good.
app.get("/avatars/:id", requireUser, async (req, res) => {
  const photo = await getAvatarPhoto(req.user.id, req.params.id);
  if (!photo) return res.sendStatus(404);
  res.set({ "Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" });
  res.type(photo.type).send(photo.image);
});

// Only the household's owner (whoever set it up) can rename it; renameHousehold checks.
app.post("/settings/household", requireUser, async (req, res) => {
  let householdId;
  try {
    householdId = await renameHousehold(req.user.id, req.body.name);
  } catch (err) {
    if (err instanceof HttpError && err.status < 500) return renderSettings(req, res, { error: err.message, status: err.status });
    throw err;
  }
  changed(householdId);
  redirect(res, "/settings?saved=household");
});

// Clicking the brand: a different line under it, typed out and remembered. The new id on <type-writer> makes the
// patch a new element, so it types again.
app.post("/household-line", requireHousehold, async (req, res) => {
  const index = nextPhraseIndex(phraseIndex(req.cookies.phrase));
  res.append("Set-Cookie", phraseCookie(index));
  const line = { index, text: phraseText(req.membership.household.name, index), animate: true };
  await sse(req, res, (stream) => stream.patchElements(eta.render("partials/household-line", { line })));
});

// Group Mine / Everyone / Up for grabs by date or by where/how, remembered on this device like the theme.
// The switch posts with Datastar (?by=, since the clicked button isn't sent) and gets just the list back, so
// the page doesn't reload; without script it's a plain form post and a redirect.
app.post("/list-grouping", requireHousehold, async (req, res) => {
  const by = (req.body.by ?? req.query.by) === "where" ? "where" : "when";
  res.append("Set-Cookie", by === "where" ? "group=where; Path=/; Max-Age=31536000; SameSite=Lax" : "group=; Path=/; Max-Age=0; SameSite=Lax");
  groupSwitches.set(req.user.session_id, by);
  await sendTaskList(req, res, { grouping: by });
});

// Light, dark, or match the device (no cookie). The ☀️/🌙 button sets the same cookie from the page.
// Settings switches the theme in place, then posts here with ?theme= so it gets a "saved" toast back.
app.post("/settings/theme", requireUser, (req, res) => {
  const theme = String(req.body.theme ?? req.query.theme ?? "");
  res.append("Set-Cookie", ["light", "dark"].includes(theme)
    ? `theme=${theme}; Path=/; Max-Age=31536000; SameSite=Lax`
    : "theme=; Path=/; Max-Age=0; SameSite=Lax");
  if (isDatastar(req)) return sse(req, res, (stream) => stream.patchElements(eta.render("partials/flash", { message: "Theme saved" })));
  redirect(res, "/settings?saved=theme");
});

// Icons on (no cookie) or off: hides the decorative emoji and menu icons (.emoji in app.css). Settings sets the
// same cookie from the page (setIcons in the layout), then posts here with ?icons= for the toast; without script it's the form.
app.post("/settings/icons", requireUser, (req, res) => {
  const off = (req.body.icons ?? req.query.icons) === "off";
  res.append("Set-Cookie", off
    ? "icons=off; Path=/; Max-Age=31536000; SameSite=Lax"
    : "icons=; Path=/; Max-Age=0; SameSite=Lax");
  if (isDatastar(req)) return sse(req, res, (stream) => stream.patchElements(eta.render("partials/flash", { message: off ? "Icons hidden" : "Icons shown" })));
  redirect(res, "/settings?saved=icons");
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

// Forgotten passwords: ask for a link by username or email, then choose a new password on the page it opens.
// The "sent" page says the same whether or not there's an account. Limited per address asked about and per IP.
const resetAsks = createRateLimit({ limit: 3, windowMs: 60 * 60_000 });
const resetAsksByIp = createRateLimit({ limit: 20, windowMs: 60 * 60_000 });

app.get("/password/forgot", (req, res) => render(res, "pages/password", { forgot: true }));

app.post("/password/forgot", async (req, res) => {
  const identifier = String(req.body.identifier ?? "").trim().slice(0, 254);
  if (!identifier) return render(res, "pages/password", { forgot: true, error: "Type your username or email" }, 400);
  const key = `reset:${identifier.toLowerCase()}`;
  if (resetAsksByIp.isLimited(req.ip)) {
    return render(res, "pages/password", { forgot: true, identifier, error: "Too many reset links asked for from here. Try again later." }, 429);
  }
  resetAsksByIp.hit(req.ip);
  // Over the per-address limit, quietly send nothing: saying so would tell whether the account exists.
  if (!resetAsks.isLimited(key)) {
    resetAsks.hit(key);
    await requestPasswordReset(identifier).catch((err) => console.error("couldn't send a password reset", err));
  }
  render(res, "pages/password", { sent: true, identifier });
});

app.get("/password/reset", async (req, res) => {
  const token = typeof req.query.token === "string" ? req.query.token : "";
  render(res, "pages/password", { token, reset: await describeResetLink(token) });
});

app.post("/password/reset", async (req, res) => {
  const token = String(req.body.token ?? "");
  let userId;
  try {
    userId = await resetPassword(token, req.body.password, req.body.again);
  } catch (err) {
    if (!(err instanceof HttpError && err.status === 400)) throw err;
    const reset = await describeResetLink(token);
    return render(res, "pages/password", reset ? { token, reset, error: err.message } : { error: err.message }, 400);
  }
  await startSession(res, userId);
  redirect(res, "/?password=changed");
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
  // The account works straight away; confirming the email can come later (the home page nudges).
  await sendVerifyEmail(await getUser(userId)).catch((err) => console.error("couldn't send the sign-up confirmation", err));
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
  if (!photosConfigured()) console.log("Task photos disabled (CLOUDINARY_URL not set)");
  else purgePhotos();
  sync?.syncNow().catch((err) => console.error("sync failed", err));
});

const shutdown = () => {
  clearInterval(syncTimer);
  clearInterval(purgeTimer);
  server.close(() => process.exit(0));
  server.closeAllConnections(); // SSE streams would otherwise hold the process open
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
