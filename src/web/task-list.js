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

/** One line under the tab explaining what it's for, written for someone who's never seen the app. */
export const VIEW_HINTS = {
  inbox: "Anything you add without details lands here, so you can jot it down fast and sort it later. Only you see your inbox.",
  waiting: "Things that need someone else first: a reply, a delivery, a repair. Check in on them now and then.",
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
    waitingLabel: t.list === "waiting" && t.status === "open" ? `${t.waiting_on || "someone"} · ${sinceLabel(t.waiting_since ?? today, today)}` : "",
  };
}

/**
 * Loads the tasks for one tab of the home page and shapes them for views/partials/task-list.eta.
 * `context` (a context id) and `tag` (a tag name) narrow the tab; an unknown context is ignored.
 */
export async function taskListView({ userId, membership, view, context: contextId = null, tag = null, today }) {
  const householdId = membership.household.id;
  const context = contextId ? await getContext(householdId, contextId).catch(() => null) : null;
  const filter = {
    inbox: { status: "open", list: "inbox", creatorId: userId },
    mine: { status: "open", list: "todo", assigneeId: userId },
    all: { status: "open", list: "todo" },
    grabs: { status: "open", list: "todo", assigneeId: null },
    waiting: { status: "open", list: "waiting" },
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
  return { ...base, groups };
}
