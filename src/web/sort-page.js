import { HttpError } from "../lib/http.js";
import { addDays, isValidDate, nextWeekday, relativeLabel } from "../../public/js/lib/dates.js";

/**
 * The answers to "What is this?" on the sort page, in the order they're shown.
 * `hint` is for the sort page itself; `short` is the one-liner the How it works page shows.
 */
export const SORT_CHOICES = [
  { value: "now", icon: "✅", label: "Do it now", hint: "Takes two minutes or less? Do it, then tap this to tick it off.", short: "Two minutes or less? Just do it." },
  { value: "todo", icon: "📋", label: "Ready to do", hint: "Something to do soon. It shows up under Mine or Everyone. Say where or how, and who, if you like.", short: "Something to do soon." },
  { value: "date", icon: "📅", label: "On a date", hint: "Has to happen on a certain day.", short: "Has to happen on a certain day." },
  { value: "waiting", icon: "⏳", label: "Waiting on", hint: "Someone else has to do something first.", short: "Someone else goes first." },
  { value: "someday", icon: "💭", label: "Maybe later", hint: "Not now, but you don't want to forget it.", short: "Not now, but don't forget it." },
  { value: "delete", icon: "🗑", label: "Delete", hint: "Not needed after all.", short: "Not needed after all." },
];

/**
 * Where to go after answering for task `id`: the oldest task left, or, once something has been skipped
 * (`skipping`), the next one after this. Answering never skips, so opened on one task from a toast, the older
 * ones still come next. After a delete, `undo` brings up the toast with Undo.
 */
export function nextSortUrl(id, { skipping = false, deleted = false } = {}) {
  const next = new URLSearchParams();
  if (skipping) next.set("after", id);
  if (deleted) next.set("undo", id);
  return `/sort${next.size ? `?${next}` : ""}`;
}

/** Which answers need a follow-up step (a detail to fill in) before they're saved. */
export const NEEDS_DETAILS = ["todo", "date", "waiting"];

/** One-tap dates for "On a date": today, tomorrow, the coming Saturday and Monday, a week out. */
export function quickDates(today) {
  const dates = [
    [today, "Today"],
    [addDays(today, 1), "Tomorrow"],
    [nextWeekday(today, 6), null],
    [nextWeekday(today, 1), null],
    [addDays(today, 7), "In a week"],
  ];
  const seen = new Set();
  return dates
    .filter(([date]) => !seen.has(date) && seen.add(date))
    .map(([date, label]) => ({ date, label: label ?? relativeLabel(date, today) }));
}

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
      if (!isValidDate(body.dueDate)) throw new HttpError(400, "Pick a date first.");
      return { action: "update", input: { ...base, list: "todo", dueDate: body.dueDate } };
    case "waiting":
      return { action: "update", input: { ...base, list: "waiting", waitingOn: body.waitingOn ?? "" } };
    case "someday":
      return { action: "update", input: { ...base, list: "someday" } };
    default:
      throw new HttpError(400, "Pick one of the options");
  }
}
