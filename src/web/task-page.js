import { parseTagList } from "../services/tags.js";
import { quickDates } from "./sort-page.js";
import { describeRecurrence, parseRule } from "../../public/js/lib/recurrence.js";

const REPEAT_PRESETS = [
  null,
  { unit: "day", every: 1 },
  { unit: "week", every: 1 },
  { unit: "week", every: 2 },
  { unit: "month", every: 1 },
];

/** The "Blocked by" choice that means "a new task, named in the field below" (task ids are 16 characters, so it can't clash). */
export const NEW_BLOCKER = "new";

const LIST_OPTIONS = [
  { value: "inbox", label: "Inbox" },
  { value: "todo", label: "To do" },
  { value: "waiting", label: "Waiting on" },
  { value: "someday", label: "Maybe later" },
];

/**
 * Shapes views/partials/task-edit.eta: the task plus the choices for each group of chips.
 * `today` gives the quick-date chips; `userId` lets the Who chips say "Me"; `openTasks` are the
 * tasks it could be blocked by (this one and its own dependents are left out by the caller's list).
 */
export function editFormView(task, { members, projects, contexts = [], today = null, userId = null, openTasks = [] }) {
  const current = parseRule(task.recurrence);
  const currentRepeat = current ? JSON.stringify(current) : "";
  const repeats = REPEAT_PRESETS.map((rule) => ({
    value: rule ? JSON.stringify(rule) : "",
    label: rule ? describeRecurrence(rule) : "Doesn't repeat",
  }));
  // A rule set some other way ("every tue" from quick add) stays selectable.
  if (currentRepeat && !repeats.some((r) => r.value === currentRepeat)) {
    repeats.push({ value: currentRepeat, label: describeRecurrence(current) });
  }
  const tags = task.tag_names ? task.tag_names.split(" ").sort().join(" ") : "";
  return {
    task, members, projects, contexts, repeats, currentRepeat, tags, lists: LIST_OPTIONS, userId,
    blockers: openTasks.filter((o) => o.id !== task.id).map((o) => ({ id: o.id, title: o.title })),
    quickDates: today ? quickDates(today) : [],
    priorities: [{ value: 1, label: "High" }, { value: 0, label: "Normal" }, { value: -1, label: "Low" }],
  };
}

/**
 * Maps the edit form's fields to updateTask input. Blank selects and dates clear the field.
 * `contextName` is the context as typed (blank clears it); the caller turns it into a contextId.
 */
export function editInput(body) {
  return {
    title: body.title,
    notes: body.notes ?? "",
    dueDate: body.dueDate || null,
    dueTime: body.dueTime || null,
    assigneeId: body.assigneeId || null,
    projectId: body.projectId || null,
    priority: body.priority,
    recurrence: body.recurrence || null,
    contextName: String(body.context ?? "").replace(/\s+/g, " ").trim(),
    tags: parseTagList(body.tags),
    ...(body.list ? { list: body.list, waitingOn: body.waitingOn ?? "" } : {}),
    // "➕ New task…" sends newBlocker (the name as typed) instead; the route creates it and blocks on it.
    ...("waitingTaskId" in body
      ? body.waitingTaskId === NEW_BLOCKER
        ? { newBlocker: String(body.newBlocker ?? "").trim() }
        : { waitingTaskId: body.waitingTaskId || null }
      : {}),
  };
}
