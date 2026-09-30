import { HttpError } from "../lib/http.js";
import { isValidDate } from "../../public/js/lib/dates.js";

/** The answers to "What is this?" on the sort page, in the order they're shown. */
export const SORT_CHOICES = [
  { value: "now", icon: "✅", label: "Do it now", hint: "Takes two minutes or less? Do it, then tap this to tick it off." },
  { value: "todo", icon: "📋", label: "To do", hint: "Something to do soon. Say where or how, and who, if you like." },
  { value: "date", icon: "📅", label: "On a date", hint: "Has to happen on a certain day." },
  { value: "waiting", icon: "⏳", label: "Waiting on someone", hint: "Someone else has to do something first." },
  { value: "someday", icon: "💭", label: "Maybe later", hint: "Not now, but you don't want to forget it." },
  { value: "delete", icon: "🗑", label: "Delete", hint: "Not needed after all." },
];

/**
 * Turns the sort form into what should happen to the task.
 * @returns {{ action: "update" | "done" | "delete", input: object }}  `input` is for updateTask (with contextName still to resolve)
 */
export function sortDecision(body) {
  const choice = String(body.choice ?? "");
  if (choice === "delete") return { action: "delete", input: {} };
  const title = String(body.title ?? "").trim();
  const base = title ? { title } : {};
  switch (choice) {
    case "now":
      return { action: "done", input: { ...base, list: "todo" } };
    case "todo":
      return {
        action: "update",
        input: { ...base, list: "todo", assigneeId: body.assigneeId || null, contextName: String(body.context ?? "").replace(/\s+/g, " ").trim() },
      };
    case "date":
      if (!isValidDate(body.dueDate)) throw new HttpError(400, "Pick a date first, then tap “On a date”.");
      return { action: "update", input: { ...base, list: "todo", dueDate: body.dueDate } };
    case "waiting":
      return { action: "update", input: { ...base, list: "waiting", waitingOn: body.waitingOn ?? "" } };
    case "someday":
      return { action: "update", input: { ...base, list: "someday" } };
    default:
      throw new HttpError(400, "Pick one of the options");
  }
}
