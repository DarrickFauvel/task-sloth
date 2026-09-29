import { listTasks } from "../services/tasks.js";
import { addDays, dueState, relativeLabel } from "../../public/js/lib/dates.js";
import { describeRecurrence, parseRule } from "../../public/js/lib/recurrence.js";

export const VIEWS = {
  mine: "Mine",
  all: "Everyone",
  grabs: "Up for grabs",
  done: "Done",
};

export const cleanView = (view) => (view in VIEWS ? view : "mine");

/** Adds the display fields views/partials/task-row.eta and views/pages/task.eta use. */
export function decorateTask(t, membership, today) {
  return {
    ...t,
    assignee: t.assignee_id ? membership.members.find((m) => m.id === t.assignee_id) ?? null : null,
    dueLabel: t.due_date ? relativeLabel(t.due_date, today) : "",
    dueState: t.due_date && t.status === "open" ? dueState(t.due_date, today) : "",
    repeats: describeRecurrence(parseRule(t.recurrence)),
  };
}

/** Loads the tasks for one tab of the home page and shapes them for views/partials/task-list.eta. */
export async function taskListView({ userId, membership, view, today }) {
  const householdId = membership.household.id;
  const filter = {
    mine: { status: "open", assigneeId: userId },
    all: { status: "open" },
    grabs: { status: "open", assigneeId: null },
    done: { status: "done", limit: 50 },
  }[view];
  const tasks = (await listTasks(householdId, filter)).map((t) => decorateTask(t, membership, today));

  if (view === "done") return { view, groups: tasks.length ? [{ label: "Recently done", tasks }] : [] };

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
  return { view, groups };
}
