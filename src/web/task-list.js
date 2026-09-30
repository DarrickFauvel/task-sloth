import { listTasks, tagList } from "../services/tasks.js";
import { getContext } from "../services/contexts.js";
import { cleanTagName } from "../services/tags.js";
import { addDays, dueState, relativeLabel } from "../../public/js/lib/dates.js";
import { describeRecurrence, parseRule } from "../../public/js/lib/recurrence.js";

export const VIEWS = {
  mine: "Mine",
  all: "Everyone",
  grabs: "Up for grabs",
  done: "Done",
};

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
    mine: { status: "open", assigneeId: userId },
    all: { status: "open" },
    grabs: { status: "open", assigneeId: null },
    done: { status: "done", limit: 50 },
  }[view];
  const tasks = (await listTasks(householdId, { ...filter, contextId: context?.id, tag: tag ?? undefined })).map((t) =>
    decorateTask(t, membership, today),
  );
  const query = { view, context: context?.id ?? null, tag };
  const filterLabel = [context && `@${context.name}`, tag && `+${tag}`].filter(Boolean).join(" ");

  if (view === "done") return { ...query, filterLabel, groups: tasks.length ? [{ label: "Recently done", tasks }] : [] };

  const weekOut = addDays(today, 7);
  const groups = [
    { label: "Overdue", test: (t) => t.due_date && t.due_date < today },
    { label: "Today", test: (t) => t.due_date === today },
    { label: "This week", test: (t) => t.due_date && t.due_date > today && t.due_date <= weekOut },
    { label: "Later", test: (t) => t.due_date && t.due_date > weekOut },
    { label: "Someday", test: (t) => !t.due_date },
  ]
    .map(({ label, test }) => ({ label, tasks: tasks.filter(test) }))
    .filter((g) => g.tasks.length);
  return { ...query, filterLabel, groups };
}
