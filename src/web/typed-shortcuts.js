import { parseQuickAdd } from "../../public/js/lib/quick-add.js";
import { relativeLabel } from "../../public/js/lib/dates.js";
import { describeRecurrence } from "../../public/js/lib/recurrence.js";
import { tagList } from "../services/tasks.js";
import { quickAddList } from "./task-list.js";

/**
 * Reads quick-add shortcuts typed into an existing task's new name ("call grandma sun @phone").
 * Returns the clean title plus only the details that were typed, so everything else about the task
 * stays as it was. Typed tags are added to the task's tags rather than replacing them, and an inbox
 * task that gains a real detail moves to To do, as a quick add with that detail would have.
 *
 * @param {string} text  the name as typed
 * @param {object} task  the task row being renamed
 * @param {{ today: string, meId: string, members: object[], projects: object[], contexts: object[] }} ctx
 * @returns {{ input: object, summary: string }}  input is for updateTask (after resolveNames); summary is for a flash
 */
export function shortcutsInTitle(text, task, ctx) {
  const parsed = parseQuickAdd(String(text ?? ""), ctx);
  const { title, tags, ...details } = parsed;
  // A name that was nothing but shortcuts ("@phone") keeps the old title.
  const input = { ...details, title: title || task.title };
  if (tags) input.tags = [...new Set([...tagList(task), ...tags])];
  if (task.list === "inbox" && quickAddList(parsed, "inbox") === "todo") input.list = "todo";
  return { input, summary: describeDetails(parsed, ctx) };
}

/** A short description of the details quick add found, e.g. "Sun · @Phone · +errand". Empty when there were none. */
export function describeDetails(parsed, { today, meId, members = [], projects = [], contexts = [] }) {
  const name = (list, id) => list.find((x) => x.id === id)?.name;
  const parts = [];
  if (parsed.dueDate) parts.push(relativeLabel(parsed.dueDate, today) + (parsed.dueTime ? ` ${parsed.dueTime}` : ""));
  else if (parsed.dueTime) parts.push(parsed.dueTime);
  if (parsed.recurrence) parts.push(`↻ ${describeRecurrence(parsed.recurrence)}`);
  if ("assigneeId" in parsed) {
    parts.push(parsed.assigneeId === null ? "for anyone" : parsed.assigneeId === meId ? "for me" : `for ${name(members, parsed.assigneeId) ?? "them"}`);
  }
  if (parsed.contextId || parsed.contextName) parts.push(`@${name(contexts, parsed.contextId) ?? parsed.contextName}`);
  for (const tag of parsed.tags ?? []) parts.push(`+${tag}`);
  // A name that isn't a project yet makes one, so say so: # isn't a tag (that's +).
  if (parsed.projectId) parts.push(`#${name(projects, parsed.projectId) ?? parsed.projectName}`);
  else if (parsed.projectName) parts.push(`new project “${parsed.projectName}”`);
  if (parsed.priority === 1) parts.push("high priority");
  if (parsed.priority === -1) parts.push("low priority");
  return parts.join(" · ");
}

/**
 * On the sort page, combines shortcuts typed into the task's name with the answer that was picked.
 * The answer decides the list, and anything it sets explicitly wins; typed details fill in the rest.
 * Two of the answer's fields are only defaults, so they don't override what was typed: a blank
 * "Where / how", and "Who" left on its preselected "Me".
 */
export function withTypedShortcuts(typed, chosen, meId) {
  const picked = { ...chosen };
  if (picked.contextName === "") delete picked.contextName;
  if ("assigneeId" in typed && picked.assigneeId === meId) delete picked.assigneeId;
  const { list, ...details } = typed;
  return { ...details, ...picked, title: typed.title };
}
