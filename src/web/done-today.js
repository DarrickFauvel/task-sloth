// "Done today": how many tasks the household has finished today (in the viewer's time zone). It's a badge in
// the header (partials/done-today) that cheers when a task has just been finished, and a row of dots on the
// Done tab (partials/done-today-dots), one per task in the color of whoever finished it. A little cheer, not a score.

import { todayIn } from "../../public/js/lib/dates.js";
import { listCompletedSince } from "../services/tasks.js";

export const MAX_DOTS = 12;
/** How recent the last finish must be for the badge to cheer (it's re-rendered on every change and page load). */
export const CHEER_MS = 5_000;

/** The emoji and line for a count; the emoji gets livelier as the day goes on. */
export function doneTodayMessage(count) {
  if (count === 0) return { emoji: "🦥", text: "Nothing done yet today. No rush." };
  if (count === 1) return { emoji: "🌱", text: "1 done today" };
  if (count < 5) return { emoji: "✨", text: `${count} done today` };
  if (count < 10) return { emoji: "🔥", text: `${count} done today. On a roll!` };
  return { emoji: "🏆", text: `${count} done today. Legendary!` };
}

/** How many tasks `userId` finished yesterday (their local day), for the greeting on Mine. */
export async function doneYesterdayBy({ householdId, userId, timeZone, now = Date.now() }) {
  const yesterday = todayIn(timeZone, new Date(now - 24 * 3_600_000));
  const today = todayIn(timeZone, new Date(now));
  // Yesterday and today are at most 50 hours long together.
  const rows = await listCompletedSince(householdId, new Date(now - 50 * 3_600_000).toISOString());
  return rows.filter((t) => t.completed_by === userId && todayIn(timeZone, new Date(t.completed_at)) === yesterday && yesterday !== today).length;
}

/** For views/partials/done-today.eta and done-today-dots.eta. */
export async function doneTodayView({ membership, timeZone, now = Date.now() }) {
  const at = new Date(now);
  const today = todayIn(timeZone, at);
  // A local day is at most 25 hours long, so everything finished today is in the last 26 hours.
  const rows = await listCompletedSince(membership.household.id, new Date(now - 26 * 3_600_000).toISOString());
  const done = rows.filter((t) => todayIn(timeZone, new Date(t.completed_at)) === today);
  const membersById = Object.fromEntries(membership.members.map((m) => [m.id, m]));
  // The newest dots, so a new one always appears at the end.
  const dots = done.slice(-MAX_DOTS).map((t) => {
    const who = membersById[t.completed_by];
    return { id: t.id, color: who?.color ?? null, label: `${who?.name ?? "Someone"}: ${t.title}` };
  });
  const last = done.at(-1);
  // Just finished: the badge opens up to say so ("5 done today!"); its id is the task's, so it plays once.
  const cheer = last && now - Date.parse(last.completed_at) < CHEER_MS
    ? { id: last.id, text: done.length === 1 ? "First one today!" : `${done.length} done today!` }
    : null;
  return { count: done.length, ...doneTodayMessage(done.length), cheer, dots, more: done.length - dots.length };
}
