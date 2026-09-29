import { describeRecurrence, parseRule } from "../../public/js/lib/recurrence.js";

const REPEAT_PRESETS = [
  null,
  { unit: "day", every: 1 },
  { unit: "week", every: 1 },
  { unit: "week", every: 2 },
  { unit: "month", every: 1 },
];

/** Shapes views/partials/task-edit.eta: the task plus the choices for each select. */
export function editFormView(task, { members, projects }) {
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
  return { task, members, projects, repeats, currentRepeat };
}

/** Maps the edit form's fields to updateTask input. Blank selects and dates clear the field. */
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
  };
}
