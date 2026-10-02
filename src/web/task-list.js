import { inboxCount, isWorking, listTasks, tagList } from "../services/tasks.js";
import { tasksWithNewComments } from "../services/comments.js";
import { getContext, listContexts, listPlaces } from "../services/contexts.js";
import { nearYouPlaces } from "./places-page.js";
import { focusLines } from "./focus-page.js";
import { focusChoices } from "../services/focus.js";
import { getProject, listProjects } from "../services/projects.js";
import { isHiddenDone } from "./hidden-done.js";
import { cleanTagName, listTags } from "../services/tags.js";
import { addDays, dueState, elapsedLabel, relativeLabel, sinceLabel } from "../../public/js/lib/dates.js";
import { describeRecurrence, parseRule } from "../../public/js/lib/recurrence.js";
import { findPhones, splitPhones } from "../../public/js/lib/phone.js";

export const VIEWS = {
  inbox: "Inbox",
  mine: "Mine",
  all: "Everyone",
  grabs: "Up for grabs",
  waiting: "Waiting on",
  someday: "Maybe later",
  done: "Done",
};

/**
 * Phone navigation: the bottom bar holds the first three views plus "More", which opens a sheet
 * with the rest, each described in a few words. (Desktop shows every view as a tab.)
 */
export const NAV = {
  bar: ["inbox", "mine", "all"],
  more: [
    { view: "grabs", blurb: "Things nobody has taken yet" },
    { view: "waiting", blurb: "Needs someone else first" },
    { view: "someday", blurb: "Ideas for one day" },
    { view: "done", blurb: "Finished in the last 24 hours" },
  ],
};

/** One line under the tab explaining what it's for, written for someone who's never seen the app. */
export const VIEW_HINTS = {
  inbox: "Anything you add without details lands here, so you can jot it down fast and sort it later. Only you see your inbox.",
  waiting: "Things that can't move yet: waiting on someone (a reply, a repair) or on another task to be done first.",
  someday: "Ideas you might get to one day, kept out of the way of today's list.",
  done: "Everything finished in the last 24 hours. Older work is in Activity.",
};

/** A finished task stays on its list (ticked) this long, so a mis-tap is easy to undo. */
export const LINGER_MS = 10 * 60_000;
/** How far back the Done tab goes. */
export const DONE_WINDOW_MS = 24 * 3_600_000;

/**
 * Which list a quick-add goes on. Adding from the Waiting or Maybe-later tab puts it there;
 * otherwise a bare title goes to the inbox, and anything with a detail skips it.
 */
export function quickAddList(parsed, view) {
  if (view === "waiting" || view === "someday") return view;
  const details = ["dueDate", "assigneeId", "projectId", "projectName", "contextId", "contextName", "tags", "recurrence"];
  return details.some((k) => k in parsed) ? "todo" : "inbox";
}

export const cleanView = (view) => (view in VIEWS ? view : "mine");

const cleanId = (id) => (typeof id === "string" && id ? id.slice(0, 64) : null);

/** Which list the home page shows: a tab, optionally narrowed to one project, one context or one tag. */
export function cleanListQuery(src = {}) {
  const tag = typeof src.tag === "string" ? cleanTagName(src.tag) || null : null;
  return { view: cleanView(src.view), project: cleanId(src.project), context: cleanId(src.context), tag };
}

/** Query string for a list, e.g. "view=all&context=abc". */
export const listQueryString = ({ view, project, context, tag }) =>
  new URLSearchParams(Object.entries({ view, project, context, tag }).filter(([, v]) => v)).toString();

/**
 * Adds the display fields views/partials/task-row.eta and views/pages/task.eta use.
 * `time` ("HH:MM" in the viewer's time zone) makes a task due earlier today overdue; without it, only the date counts.
 */
export function decorateTask(t, membership, today, time = null) {
  const member = (id) => membership.members.find((m) => m.id === id) ?? null;
  const state = t.due_date ? dueState(t.due_date, today, t.due_time, time) : "";
  const dueLabel = t.due_date ? relativeLabel(t.due_date, today) : "";
  const lateToday = state === "overdue" && t.due_date === today;
  return {
    ...t,
    assignee: t.assignee_id ? member(t.assignee_id) : null,
    // Who's doing it right now ("working on now"), until they stop, finish it, or their day ends.
    worker: t.status === "open" && isWorking(t) ? member(t.working_by) : null,
    // How long they've been on it ("12 min"), for the Working on now card.
    workingFor: t.status === "open" && isWorking(t) ? elapsedLabel(Date.now() - Date.parse(t.working_since)) : "",
    dueLabel,
    // "Today 15:00 · overdue" once today's due time has passed.
    dueText: [dueLabel, t.due_date && t.due_time].filter(Boolean).join(" ") + (lateToday && t.status === "open" ? " · overdue" : ""),
    dueState: t.status === "open" ? state : "",
    pastDue: state === "overdue",
    // Phone numbers in the title or notes: a Call chip on the row, and tap-to-call links on the task page.
    phones: findPhones(t.title, t.notes),
    titleParts: splitPhones(t.title),
    notesParts: splitPhones(t.notes ?? ""),
    repeats: describeRecurrence(parseRule(t.recurrence)),
    tags: tagList(t),
    // Blocked by another (still open) task: "patch the walls". It shows on every list the task is on.
    blockedBy: t.waiting_task_id && t.waiting_task_status === "open" ? t.waiting_task_title : "",
    // Open tasks waiting on this one.
    blocking: t.blocking_titles ? JSON.parse(t.blocking_titles) : [],
    // The first few photos, shown as a small overlapping stack on the row.
    photoIds: t.photo_ids ? JSON.parse(t.photo_ids) : [],
    waitingLabel: t.list === "waiting" && t.status === "open" ? `${t.waiting_on || "someone"} · ${sinceLabel(t.waiting_since ?? today, today)}` : "",
  };
}

/**
 * Loads the tasks for one tab of the home page and shapes them for views/partials/task-list.eta.
 * `project` (a project id), `context` (a context id) and `tag` (a tag name) narrow the tab; an unknown
 * project or context is ignored.
 * `groupBy` "where" groups the to-do tabs by where/how instead of by date (see groupByWhere).
 * Tasks finished in the last LINGER_MS stay on their list, ticked, unless this user hid them (hidden-done.js);
 * the Done tab covers DONE_WINDOW_MS.
 * `time` ("HH:MM", the viewer's wall clock) makes tasks due earlier today overdue.
 * `refreshAt` (ms since the epoch, or null) is when the list next changes on its own, so a live page can re-render
 * then: a finished task dropping off, and with `time`, a due time passing or midnight.
 */
export async function taskListView({ userId, membership, view, project: projectId = null, context: contextId = null, tag = null, groupBy = "when", layout = "list", today, time = null, resetDue = false, now = Date.now() }) {
  const householdId = membership.household.id;
  const project = projectId ? await getProject(householdId, projectId).catch(() => null) : null;
  const context = contextId ? await getContext(householdId, contextId).catch(() => null) : null;
  const filter = {
    inbox: { status: "open", list: "inbox", creatorId: userId },
    mine: { status: "open", list: "todo", assigneeId: userId },
    all: { status: "open", list: "todo" },
    grabs: { status: "open", list: "todo", assigneeId: null },
    waiting: { status: "open", waiting: true },
    someday: { status: "open", list: "someday" },
    done: { status: "done" },
  }[view];
  const keepFor = view === "done" ? DONE_WINDOW_MS : LINGER_MS;
  filter.completedSince = new Date(now - keepFor).toISOString();
  const tasks = (await listTasks(householdId, { ...filter, projectId: project?.id, contextId: context?.id, tag: tag ?? undefined }))
    .filter((t) => view === "done" || t.status !== "done" || !isHiddenDone(userId, t, now))
    .map((t) => decorateTask(t, membership, today, time));
  // Comments someone else left that you haven't seen (see src/services/comments.js): the row's 💬 gets a dot.
  const unseen = await tasksWithNewComments(householdId, userId);
  for (const t of tasks) t.newComments = unseen.has(t.id);
  const query = { view, project: project?.id ?? null, context: context?.id ?? null, tag };
  const filterLabel = [project && `${project.emoji} ${project.name}`, context && `@${context.name}`, tag && `+${tag}`].filter(Boolean).join(" ");
  const doneTimes = tasks.filter((t) => t.status === "done").map((t) => Date.parse(t.completed_at));
  // "Working on now" lapses at the end of the day it was started.
  const workingUntil = tasks.filter((t) => t.worker).map((t) => Date.parse(t.working_until));
  const refreshTimes = [...doneTimes.map((at) => at + keepFor), ...workingUntil, ...(time ? clockTicks(tasks, today, time, now) : [])];
  const refreshAt = refreshTimes.length ? Math.min(...refreshTimes) : null;
  // Mine suggests the weekly reset when one is due (see src/services/reset.js); the caller works that out.
  const base = { ...query, filterLabel, refreshAt, hint: VIEW_HINTS[view] ?? "", inboxCount: await inboxCount(householdId, userId), resetDue: view === "mine" && resetDue,
    // The household's places with something to do there, for "Near you" (public/js/near-you.js) on this device.
    nearYou: nearYouPlaces(await listPlaces(householdId)),
    suggest: await suggestData(householdId, userId, membership, today),
    // Who's in a focus session (src/services/focus.js), and on a list narrowed to one project or place, whether
    // there's anything there to focus on.
    focusLines: await focusLines(householdId, membership, userId),
    focusHere: await focusHere(userId, householdId, view, project, context),
    // "View as": a list (the default) or a board (see boardColumns), on the to-do tabs.
    canBoard: BOARD_VIEWS.has(view), layout: "list" };

  const single = { inbox: "Not sorted yet", waiting: "Waiting", someday: "Maybe later", done: "Recently done" }[view];
  if (single) return { ...base, groups: tasks.length ? [{ label: single, tone: "accent", tasks }] : [] };

  if (base.canBoard && layout === "board") {
    const columns = await boardColumns({ householdId, userId, membership, view, project, context, tag, today, time, now });
    return { ...base, layout: "board", columns, groups: [] };
  }

  // What you're doing right now (one task at most) goes first, ahead of the dates or places. Others' stay in their
  // usual groups, with "Sam's on it".
  const working = tasks.filter((t) => t.worker?.id === userId).slice(0, 1);
  const rest = tasks.filter((t) => !working.includes(t));
  const nowGroup = working.length ? [{ label: "Working on now", hue: GROUP_HUES[2], working: true, tasks: working }] : [];

  // Grouping by where/how means nothing once the list is narrowed to one context, so it falls back to dates.
  const canGroup = !context;
  if (canGroup && groupBy === "where") return { ...base, canGroup, groupBy, groups: [...nowGroup, ...groupByWhere(rest).map(withWhereTone)] };

  const weekOut = addDays(today, 7);
  const groups = [
    { label: "Overdue", tone: "danger", test: (t) => t.pastDue },
    { label: "Today", tone: "accent", test: (t) => t.due_date === today && !t.pastDue },
    { label: "This week", hue: GROUP_HUES[1], test: (t) => t.due_date && t.due_date > today && t.due_date <= weekOut },
    { label: "Later", hue: GROUP_HUES[3], test: (t) => t.due_date && t.due_date > weekOut },
    { label: "No date", tone: "plain", test: (t) => !t.due_date },
  ]
    .map(({ test, ...g }) => ({ ...g, tasks: rest.filter(test) }))
    .filter((g) => g.tasks.length);
  return { ...base, canGroup, groupBy: "when", groups: [...nowGroup, ...groups] };
}

/** The tabs that can be shown as a board: the to-do ones. */
export const BOARD_VIEWS = new Set(["mine", "all", "grabs"]);

/** The board's columns, in order, with what each means (shown when it's empty) and what moving a card there does. */
export const BOARD_COLUMNS = [
  { key: "todo", label: "To do", empty: "Nothing waiting to be started." },
  { key: "doing", label: "Doing", empty: "Move a task here when you start it. Everyone sees you're on it." },
  { key: "waiting", label: "Waiting on", empty: "Things stuck on someone else, or on another task, go here." },
  { key: "done", label: "Done today", empty: "Move a task here when it's finished." },
];

/**
 * The board (View as: Board): this tab's tasks by where they are. To do (not started, not blocked); Doing (someone's
 * working on it now); Waiting on (the Waiting list, or blocked by another task); Done today (since midnight where
 * you are, from `time`). The tab's who (Mine / Everyone / Up for grabs) and any project, place or tag apply to all four.
 */
export async function boardColumns({ householdId, userId, membership, view, project, context, tag, today, time = null, now = Date.now() }) {
  const common = {
    assigneeId: { mine: userId, all: undefined, grabs: null }[view],
    projectId: project?.id, contextId: context?.id, tag: tag ?? undefined,
  };
  const decorate = (t) => decorateTask(t, membership, today, time);
  const startOfMinute = now - (now % 60_000);
  const midnight = time ? startOfMinute - minutesOf(time) * 60_000 : now - DONE_WINDOW_MS;
  const [open, waiting, done] = await Promise.all([
    listTasks(householdId, { ...common, status: "open", list: "todo" }),
    listTasks(householdId, { ...common, status: "open", waiting: true }),
    listTasks(householdId, { ...common, status: "done", completedSince: new Date(midnight).toISOString(), limit: 30 }),
  ]).then((lists) => lists.map((l) => l.map(decorate)));
  const tasks = {
    todo: open.filter((t) => !t.worker && !t.blockedBy),
    doing: open.filter((t) => t.worker),
    waiting: waiting.filter((t) => !t.worker),
    done,
  };
  return BOARD_COLUMNS.map((c) => ({ ...c, tasks: tasks[c.key] }));
}

/** A list narrowed to a project or a where/how offers a focus session on it, when there's something you could take on there. */
async function focusHere(userId, householdId, view, project, context) {
  if (!(project || context) || !["mine", "all", "grabs"].includes(view)) return null;
  const choices = await focusChoices({ id: userId, householdId });
  const found = project ? choices.projects.find((c) => c.id === project.id) : choices.contexts.find((c) => c.id === context.id);
  return found ?? null;
}

/**
 * What the add box suggests from (public/js/lib/suggest.js): the household's people, projects, where / hows and
 * tags, plus the viewer's today for what "fri" means.
 */
export async function suggestData(householdId, userId, membership, today) {
  const [projects, contexts, tags] = await Promise.all([listProjects(householdId), listContexts(householdId), listTags(householdId)]);
  return {
    today,
    me: userId,
    members: membership.members.map(({ id, name, color }) => ({ id, name, color })),
    projects: projects.map(({ name, emoji }) => ({ name, emoji })),
    contexts: contexts.map(({ name }) => ({ name })),
    tags: tags.map((t) => t.name),
  };
}

/**
 * Group card colors (see .task-group in app.css): a tone ("accent" follows the viewer's color, "danger" is
 * overdue, "plain" is grey), or an oklch hue. The hues skip the reds so nothing looks overdue.
 */
export const GROUP_HUES = [250, 195, 150, 80, 300, 325];

/** A where/how group's color: picked from its context id, so a place keeps its color whatever else is listed. */
export function withWhereTone(group) {
  if (!group.contextId) return { ...group, tone: "plain" };
  let h = 0;
  for (const ch of group.contextId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return { ...group, hue: GROUP_HUES[h % GROUP_HUES.length] };
}

const minutesOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/**
 * When the viewer's clock changes the list: a minute after each open task's due time today (it turns overdue),
 * and midnight (dates shift). Times are counted in minutes from `time`, the viewer's wall clock at `now`.
 */
function clockTicks(tasks, today, time, now) {
  const startOfMinute = now - (now % 60_000);
  const at = (minutes) => startOfMinute + (minutes - minutesOf(time)) * 60_000;
  const dueLater = tasks.filter((t) => t.status === "open" && t.due_date === today && t.due_time && t.due_time >= time);
  return [...dueLater.map((t) => at(minutesOf(t.due_time) + 1)), at(24 * 60)];
}

/**
 * One group per where/how (context), A–Z, then "Anywhere" for tasks without one. Tasks keep the
 * list's date order inside each group. Each group carries its context id so its heading can link to it.
 */
export function groupByWhere(tasks) {
  const groups = new Map();
  for (const t of tasks) {
    const key = t.context_id ?? "";
    if (!groups.has(key)) groups.set(key, { label: t.context_name ?? "Anywhere", contextId: t.context_id ?? null, tasks: [] });
    groups.get(key).tasks.push(t);
  }
  return [...groups.values()].sort((a, b) => !a.contextId - !b.contextId || a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
}
