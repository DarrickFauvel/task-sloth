import { inboxCount, listTasks } from "../services/tasks.js";
import { decorateTask } from "./task-list.js";
import { addDays, relativeLabel } from "../../public/js/lib/dates.js";

// The weekly reset: one person's step-by-step check-in, like "Sort my inbox" but for everything of theirs.
// Each step lists some of their open tasks with one-tap answers (POST /reset/:step/:id, which re-renders the step).

/** The steps, in order. `answers` are what each task in the step can be told (see the route for what they do). */
export const RESET_STEPS = [
  { key: "inbox", icon: "📥", title: "Empty your inbox", hint: "Give everything you jotted down a home, so nothing's left loose." },
  { key: "overdue", icon: "⏰", title: "Catch up on what's overdue", hint: "These slipped past their date. Finish them, or give them a date you'll keep.",
    empty: "Nothing overdue. Nice.", answers: ["done", "tomorrow", "nextweek", "date", "later"] },
  { key: "waiting", icon: "⏳", title: "Check what you're waiting on", hint: "Has anything come through? Anything still stuck can stay.",
    empty: "You're not waiting on anyone.", answers: ["done", "ready", "keep"] },
  { key: "week", icon: "📅", title: "Look at the week ahead", hint: "What's due in the next seven days. Move anything that won't happen, and take a shared one if you can.",
    empty: "Nothing due this week.", answers: ["done", "claim", "date"] },
  { key: "later", icon: "💭", title: "Glance at Maybe later", hint: "Anything you want to start now? The rest can keep.",
    empty: "Nothing in Maybe later.", answers: ["start", "keep", "delete"] },
];

/** The buttons for each answer. */
export const ANSWER_LABELS = {
  done: "Done", tomorrow: "Tomorrow", nextweek: "Next week", date: "Pick a date", later: "Maybe later",
  ready: "It came through", keep: "Keep", claim: "I'll take it", start: "Start it", delete: "Delete",
};

/** How many Maybe later tasks the last step shows (the oldest first). */
export const LATER_LIMIT = 10;

/**
 * One step of the reset for views/pages/reset.eta: where it sits, and the tasks it asks about. "Yours" means
 * given to you, or added by you and given to nobody. The week ahead also has shared tasks nobody has taken.
 */
export async function resetStepView({ step: key, userId, membership, today, time }) {
  const index = RESET_STEPS.findIndex((s) => s.key === key);
  if (index < 0) return null;
  const step = RESET_STEPS[index];
  const view = { step, index, number: index + 1, total: RESET_STEPS.length, next: RESET_STEPS[index + 1]?.key ?? null, prev: RESET_STEPS[index - 1]?.key ?? null };
  const householdId = membership.household.id;
  if (key === "inbox") return { ...view, inboxCount: await inboxCount(householdId, userId) };

  const open = (await listTasks(householdId, { status: "open" })).map((t) => decorateTask(t, membership, today, time));
  const mine = (t) => t.assignee_id === userId || (!t.assignee_id && t.creator_id === userId);
  const weekEnd = addDays(today, 7);
  const pick = {
    overdue: () => open.filter((t) => mine(t) && t.list !== "inbox" && t.list !== "someday" && t.pastDue)
      .sort((a, b) => a.due_date.localeCompare(b.due_date)),
    waiting: () => open.filter((t) => mine(t) && (t.list === "waiting" || t.blockedBy))
      .sort((a, b) => (a.waiting_since ?? a.created_at).localeCompare(b.waiting_since ?? b.created_at)),
    week: () => open.filter((t) => (mine(t) || !t.assignee_id) && ["todo", "waiting"].includes(t.list) && t.due_date && !t.pastDue && t.due_date <= weekEnd)
      .sort((a, b) => a.due_date.localeCompare(b.due_date) || (a.due_time ?? "").localeCompare(b.due_time ?? "")),
    later: () => open.filter((t) => mine(t) && t.list === "someday").sort((a, b) => a.created_at.localeCompare(b.created_at)),
  }[key];
  const all = pick();
  const tasks = (key === "later" ? all.slice(0, LATER_LIMIT) : all).map((t) => ({
    id: t.id,
    title: t.title,
    // One line on why it's here.
    note: key === "waiting"
      ? (t.blockedBy ? `Waits for “${t.blockedBy}”` : `Waiting on ${t.waitingLabel}`)
      : key === "later" ? "" : `Due ${t.dueText}`,
    // The week ahead's shared tasks can be taken; your own don't need to be.
    answers: step.answers.filter((a) => a !== "claim" || !t.assignee_id),
    shared: key === "week" && !t.assignee_id,
    day: key === "week" ? relativeLabel(t.due_date, today) : null,
  }));
  return { ...view, tasks, more: all.length - tasks.length };
}
