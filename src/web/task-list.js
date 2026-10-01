import { inboxCount, listTasks, tagList } from "../services/tasks.js";
import { getContext } from "../services/contexts.js";
import { getProject } from "../services/projects.js";
import { isHiddenDone } from "./hidden-done.js";
import { cleanTagName } from "../services/tags.js";
import { addDays, dueState, relativeLabel, sinceLabel } from "../../public/js/lib/dates.js";
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
    { view: "done", blurb: "Finished in the last 8 hours" },
  ],
};

/** One line under the tab explaining what it's for, written for someone who's never seen the app. */
export const VIEW_HINTS = {
  inbox: "Anything you add without details lands here, so you can jot it down fast and sort it later. Only you see your inbox.",
  waiting: "Things that can't move yet: waiting on someone (a reply, a repair) or on another task to be done first.",
  someday: "Ideas you might get to one day, kept out of the way of today's list.",
  done: "Everything finished in the last 8 hours. Older work is in Activity.",
};

/** A finished task stays on its list (ticked) this long, so a mis-tap is easy to undo. */
export const LINGER_MS = 10 * 60_000;
/** How far back the Done tab goes. */
export const DONE_WINDOW_MS = 8 * 3_600_000;

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
  const state = t.due_date ? dueState(t.due_date, today, t.due_time, time) : "";
  const dueLabel = t.due_date ? relativeLabel(t.due_date, today) : "";
  const lateToday = state === "overdue" && t.due_date === today;
  return {
    ...t,
    assignee: t.assignee_id ? membership.members.find((m) => m.id === t.assignee_id) ?? null : null,
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
export async function taskListView({ userId, membership, view, project: projectId = null, context: contextId = null, tag = null, groupBy = "when", today, time = null, now = Date.now() }) {
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
  const query = { view, project: project?.id ?? null, context: context?.id ?? null, tag };
  const filterLabel = [project && `${project.emoji} ${project.name}`, context && `@${context.name}`, tag && `+${tag}`].filter(Boolean).join(" ");
  const doneTimes = tasks.filter((t) => t.status === "done").map((t) => Date.parse(t.completed_at));
  const refreshTimes = [...doneTimes.map((at) => at + keepFor), ...(time ? clockTicks(tasks, today, time, now) : [])];
  const refreshAt = refreshTimes.length ? Math.min(...refreshTimes) : null;
  const base = { ...query, filterLabel, refreshAt, hint: VIEW_HINTS[view] ?? "", inboxCount: await inboxCount(householdId, userId) };

  const single = { inbox: "Not sorted yet", waiting: "Waiting", someday: "Maybe later", done: "Recently done" }[view];
  if (single) return { ...base, groups: tasks.length ? [{ label: single, tone: "accent", tasks }] : [] };

  // Grouping by where/how means nothing once the list is narrowed to one context, so it falls back to dates.
  const canGroup = !context;
  if (canGroup && groupBy === "where") return { ...base, canGroup, groupBy, groups: groupByWhere(tasks).map(withWhereTone) };

  const weekOut = addDays(today, 7);
  const groups = [
    { label: "Overdue", tone: "danger", test: (t) => t.pastDue },
    { label: "Today", tone: "accent", test: (t) => t.due_date === today && !t.pastDue },
    { label: "This week", hue: GROUP_HUES[1], test: (t) => t.due_date && t.due_date > today && t.due_date <= weekOut },
    { label: "Later", hue: GROUP_HUES[3], test: (t) => t.due_date && t.due_date > weekOut },
    { label: "No date", tone: "plain", test: (t) => !t.due_date },
  ]
    .map(({ test, ...g }) => ({ ...g, tasks: tasks.filter(test) }))
    .filter((g) => g.tasks.length);
  return { ...base, canGroup, groupBy: "when", groups };
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
