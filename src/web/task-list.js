import { inboxCount, listTasks, tagList } from "../services/tasks.js";
import { getContext } from "../services/contexts.js";
import { cleanTagName } from "../services/tags.js";
import { addDays, dueState, relativeLabel, sinceLabel } from "../../public/js/lib/dates.js";
import { describeRecurrence, parseRule } from "../../public/js/lib/recurrence.js";

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
    { view: "done", blurb: "Recently finished" },
  ],
};

/** One line under the tab explaining what it's for, written for someone who's never seen the app. */
export const VIEW_HINTS = {
  inbox: "Anything you add without details lands here, so you can jot it down fast and sort it later. Only you see your inbox.",
  waiting: "Things that can't move yet: waiting on someone (a reply, a repair) or on another task to be done first.",
  someday: "Ideas you might get to one day, kept out of the way of today's list.",
};

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

/** Which list the home page shows: a tab, optionally narrowed to one context or one tag. */
export function cleanListQuery(src = {}) {
  const context = typeof src.context === "string" && src.context ? src.context.slice(0, 64) : null;
  const tag = typeof src.tag === "string" ? cleanTagName(src.tag) || null : null;
  return { view: cleanView(src.view), context, tag };
}

/** Query string for a list, e.g. "view=all&context=abc". */
export const listQueryString = ({ view, context, tag }) =>
  new URLSearchParams(Object.entries({ view, context, tag }).filter(([, v]) => v)).toString();

/** Adds the display fields views/partials/task-row.eta and views/pages/task.eta use. */
export function decorateTask(t, membership, today) {
  return {
    ...t,
    assignee: t.assignee_id ? membership.members.find((m) => m.id === t.assignee_id) ?? null : null,
    dueLabel: t.due_date ? relativeLabel(t.due_date, today) : "",
    dueState: t.due_date && t.status === "open" ? dueState(t.due_date, today) : "",
    repeats: describeRecurrence(parseRule(t.recurrence)),
    tags: tagList(t),
    // Blocked by another (still open) task: "patch the walls". It shows on every list the task is on.
    blockedBy: t.waiting_task_id && t.waiting_task_status === "open" ? t.waiting_task_title : "",
    // Open tasks waiting on this one.
    blocking: t.blocking_titles ? JSON.parse(t.blocking_titles) : [],
    waitingLabel: t.list === "waiting" && t.status === "open" ? `${t.waiting_on || "someone"} · ${sinceLabel(t.waiting_since ?? today, today)}` : "",
  };
}

/**
 * Loads the tasks for one tab of the home page and shapes them for views/partials/task-list.eta.
 * `context` (a context id) and `tag` (a tag name) narrow the tab; an unknown context is ignored.
 * `groupBy` "where" groups the to-do tabs by where/how instead of by date (see groupByWhere).
 */
export async function taskListView({ userId, membership, view, context: contextId = null, tag = null, groupBy = "when", today }) {
  const householdId = membership.household.id;
  const context = contextId ? await getContext(householdId, contextId).catch(() => null) : null;
  const filter = {
    inbox: { status: "open", list: "inbox", creatorId: userId },
    mine: { status: "open", list: "todo", assigneeId: userId },
    all: { status: "open", list: "todo" },
    grabs: { status: "open", list: "todo", assigneeId: null },
    waiting: { status: "open", waiting: true },
    someday: { status: "open", list: "someday" },
    done: { status: "done", limit: 50 },
  }[view];
  const tasks = (await listTasks(householdId, { ...filter, contextId: context?.id, tag: tag ?? undefined })).map((t) =>
    decorateTask(t, membership, today),
  );
  const query = { view, context: context?.id ?? null, tag };
  const filterLabel = [context && `@${context.name}`, tag && `+${tag}`].filter(Boolean).join(" ");
  const base = { ...query, filterLabel, hint: VIEW_HINTS[view] ?? "", inboxCount: await inboxCount(householdId, userId) };

  const single = { inbox: "Not sorted yet", waiting: "Waiting", someday: "Maybe later", done: "Recently done" }[view];
  if (single) return { ...base, groups: tasks.length ? [{ label: single, tasks }] : [] };

  // Grouping by where/how means nothing once the list is narrowed to one context, so it falls back to dates.
  const canGroup = !context;
  if (canGroup && groupBy === "where") return { ...base, canGroup, groupBy, groups: groupByWhere(tasks) };

  const weekOut = addDays(today, 7);
  const groups = [
    { label: "Overdue", test: (t) => t.due_date && t.due_date < today },
    { label: "Today", test: (t) => t.due_date === today },
    { label: "This week", test: (t) => t.due_date && t.due_date > today && t.due_date <= weekOut },
    { label: "Later", test: (t) => t.due_date && t.due_date > weekOut },
    { label: "No date", test: (t) => !t.due_date },
  ]
    .map(({ label, test }) => ({ label, tasks: tasks.filter(test) }))
    .filter((g) => g.tasks.length);
  return { ...base, canGroup, groupBy: "when", groups };
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
