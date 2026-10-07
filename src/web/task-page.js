import { parseTagList } from "../services/tags.js";
import { quickDates } from "./sort-page.js";
import { describeRecurrence, parseRule } from "../../public/js/lib/recurrence.js";
import { relativeLabel } from "../../public/js/lib/dates.js";

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
  { value: "todo", label: "Ready to do", hint: "Shows up under Mine or Everyone, where the whole household can see it." },
  { value: "waiting", label: "Waiting on", hint: "Someone or something else has to happen first." },
  { value: "someday", label: "Maybe later", hint: "Not now, but you don't want to forget it." },
];

const byTitle = (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base", numeric: true });

/**
 * The tasks this one could wait for, grouped by project so the right one is easy to find (the grouped dropdown in
 * task-edit.eta, and the search sheet in public/js/task-picker.js): this task's own project first, then the others
 * A to Z, then the ones in no project; A to Z within each. Each says when it's due, who has it and where, if set.
 */
export function blockerGroups(task, openTasks, { members = [], today = null } = {}) {
  const groups = new Map();
  for (const o of openTasks) {
    if (o.id === task.id) continue;
    const key = o.project_id ?? "";
    if (!groups.has(key)) {
      const same = key && key === task.project_id;
      const name = key ? `${o.project_emoji ?? ""} ${o.project_name}`.trim() : "No project";
      groups.set(key, { label: same ? `Same project · ${name}` : name, name: o.project_name ?? "", same, tasks: [] });
    }
    const who = members.find((m) => m.id === o.assignee_id)?.name.split(" ")[0];
    const meta = [o.due_date && today ? relativeLabel(o.due_date, today) : null, who, o.context_name && `@${o.context_name}`];
    groups.get(key).tasks.push({ id: o.id, title: o.title, meta: meta.filter(Boolean).join(" · ") });
  }
  const order = (g) => (g.same ? 0 : g.name ? 1 : 2);
  return [...groups.values()]
    .sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
    .map(({ label, tasks }) => ({ label, tasks: tasks.sort(byTitle) }));
}

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
    blockerGroups: blockerGroups(task, openTasks, { members, today }),
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

/** Which parts of editInput's result each form field's autosave writes. */
const SAVES = {
  title: ["title"], notes: ["notes"], dueTime: ["dueTime"], recurrence: ["recurrence"], assigneeId: ["assigneeId"],
  context: ["contextName"], tags: ["tags"], priority: ["priority"], waitingOn: ["waitingOn"],
  list: ["list", "waitingOn"],
  projectId: ["projectId", "projectName"], newProject: ["projectId", "projectName"],
  waitingTaskId: ["waitingTaskId", "newBlocker"], newBlocker: ["waitingTaskId", "newBlocker"],
};

/**
 * An autosave posts the whole form, but writes only the field that changed, so it can't put back an older
 * value of a field someone else changed meanwhile. Clearing the date clears the time too ("No date").
 * An unknown field writes everything, as the plain (no-script) submit does.
 */
export function autosaveInput(input, field) {
  if (field === "dueDate") return input.dueDate ? { dueDate: input.dueDate } : { dueDate: null, dueTime: null };
  const keys = Object.hasOwn(SAVES, field) ? SAVES[field] : null;
  if (!keys) return input;
  return Object.fromEntries(keys.filter((k) => k in input).map((k) => [k, input[k]]));
}
