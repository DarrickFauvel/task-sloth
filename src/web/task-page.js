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
/** The Project choice that means "a new project, named in the field below". */
export const NEW_PROJECT = "new";

/** The edit form's list chips. Only the picked list's hint shows. */
const LIST_OPTIONS = [
  { value: "inbox", label: "Inbox", hint: "Just jotted down. Only you see it until you sort it." },
  { value: "todo", label: "To do", hint: "Ready to do. Everyone in the household can see it." },
  { value: "waiting", label: "Waiting on", hint: "Someone or something else has to happen first." },
  { value: "someday", label: "Maybe later", hint: "Not now, but you don't want to forget it." },
];

/**
 * Shapes views/partials/task-edit.eta: the task plus the choices for each group of chips.
 * `today` gives the quick-date chips; `userId` lets the Who chips say "Me"; `openTasks` are the
 * tasks it could be blocked by (this one and its own dependents are left out by the caller's list).
 * `focus` is the field a tap on the task page asked for (see task-head.eta); anything else is ignored.
 */
export function editFormView(task, { members, projects, contexts = [], today = null, userId = null, openTasks = [], focus = null }) {
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
  const priorities = [{ value: 1, label: "High" }, { value: 0, label: "Normal" }, { value: -1, label: "Low" }];
  const priority = Number(task.priority) || 0;
  const project = projects.find((p) => p.id === task.project_id);
  const focusField = Object.hasOwn(FIELD_LABELS, focus) ? focus : null;
  return {
    task, members, projects, contexts, repeats, currentRepeat, tags, lists: LIST_OPTIONS, userId, priorities,
    focus: focusField,
    // New on every render, for ids that make a re-render replace (not morph) the selects; see task-edit.eta.
    renderKey: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    blockers: openTasks.filter((o) => o.id !== task.id).map((o) => ({ id: o.id, title: o.title })),
    quickDates: today ? quickDates(today) : [],
    // The folded "More" card (project, tags, priority): one line saying what's set, and open when any of it
    // is set or a tap on the task page asked for one of its fields.
    more: {
      summary: [
        project ? `${project.emoji} ${project.name}` : "No project",
        tags ? tags.split(" ").map((tag) => `+${tag}`).join(" ") : "no tags",
        `${priorities.find((p) => p.value === priority)?.label.toLowerCase() ?? "normal"} priority`,
      ].join(" · "),
      open: Boolean(project || tags || priority) || ["projectId", "tags", "priority"].includes(focusField),
    },
  };
}

/**
 * Maps the edit form's fields to updateTask input. Blank selects and dates clear the field.
 * `contextName` is the context as typed (blank clears it); the caller turns it into a contextId.
 * "➕ New project…" sends `projectName` instead of a projectId (resolveNames creates it, or reuses one by that
 * name); with no name typed yet, the project is left as it is.
 */
export function editInput(body) {
  return {
    title: body.title,
    notes: body.notes ?? "",
    dueDate: body.dueDate || null,
    dueTime: body.dueTime || null,
    assigneeId: body.assigneeId || null,
    ...(body.projectId === NEW_PROJECT
      ? (String(body.newProject ?? "").trim() ? { projectName: String(body.newProject).trim() } : {})
      : { projectId: body.projectId || null }),
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

/** What each edit-form field is called in its "… saved" toast (the form's own labels, shortened). */
const FIELD_LABELS = {
  title: "Name", notes: "Notes", dueDate: "Date", dueTime: "Time", recurrence: "Repeat", assigneeId: "Who does it",
  context: "Where / how", projectId: "Project", tags: "Tags", list: "List", waitingOn: "Waiting on",
  waitingTaskId: "What it waits for", newBlocker: "What it waits for", priority: "Priority", newProject: "Project",
};

/** The toast after the edit form saves one field as you go: "Priority saved", or just "Saved". */
export const savedMessage = (field) => (Object.hasOwn(FIELD_LABELS, field) ? `${FIELD_LABELS[field]} saved` : "Saved");
