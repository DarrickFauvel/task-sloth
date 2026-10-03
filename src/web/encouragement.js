// Cozy encouragement, in the app's sloth voice: warm, plain, never pushy, never guilt. Hand-written lines, picked
// by a seed (a task id, or today's date and who's looking) so the same moment always gets the same words and a
// live re-render doesn't swap them under you.
//
//   finishedLine     the toast after ticking a task off
//   milestoneLine    a project's first step, halfway, last one left, all done
//   progressLine     the line under a project's progress bar
//   taskNudge        a kind word on the task page for something overdue, waiting long, or sitting a while
//   greeting         the line at the top of Mine: hello, what's ahead, and what you did yesterday

import { addDays } from "../../public/js/lib/dates.js";

/** A stable pick from `lines` for `seed` (FNV-1a over the seed's characters). */
export function pick(lines, seed) {
  let h = 0x811c9dc5;
  for (const ch of String(seed)) h = Math.imul(h ^ ch.codePointAt(0), 0x01000193) >>> 0;
  return lines[h % lines.length];
}

const fill = (line, values) => line.replace(/\{(\w+)\}/g, (_, k) => values[k] ?? "");

// --- Finishing a task ------------------------------------------------------------------

const FINISHED = [
  "One less thing. Have a stretch.",
  "Done and dusted.",
  "Look at that. Ticked off.",
  "Nicely done. Slow and steady.",
  "That's one off the branch.",
  "Done. Maybe a sip of something warm?",
  "Off the list. Well played.",
  "Done. The sloth approves.",
  "Lovely. That's handled.",
  "Ticked. No rush on the next one.",
];
const FIRST_TODAY = [
  "First one today. That's the hardest bit.",
  "And you're off. First one today.",
  "First one done. The day's warming up.",
];
const PLENTY_TODAY = [
  "That's {n} today. Time for a little rest?",
  "{n} done today. Feet up for a bit?",
  "{n} today. You've earned a slow moment.",
];

/** The toast after finishing a task; `doneToday` counts the household's, this one included. */
export function finishedLine({ taskId, doneToday = 0 }) {
  if (doneToday === 1) return pick(FIRST_TODAY, taskId);
  if (doneToday >= 5 && doneToday % 5 === 0) return fill(pick(PLENTY_TODAY, taskId), { n: doneToday });
  return pick(FINISHED, taskId);
}

// --- Projects --------------------------------------------------------------------------

/**
 * What finishing a task just meant for its project, or null when it's no milestone. `done` and `total` count the
 * project's tasks after this one was finished. Milestones need a few tasks, or every tick would be one.
 */
export function milestoneLine({ name, done, total }) {
  if (!total || done < 1 || done > total) return null;
  if (done === total) return total >= 2 ? `${name} is all done 🎉 Take a moment to enjoy it.` : null;
  if (total < 3) return null;
  if (total - done === 1) return `Just one left on ${name}. Nearly there.`;
  if (done * 2 >= total && (done - 1) * 2 < total) return `Halfway through ${name}. Look how far you've come.`;
  if (done === 1) return `First step on ${name} done. The rest gets easier.`;
  return null;
}

/** The line under a project's progress bar. */
export function progressLine({ done, total }) {
  if (!total) return "";
  if (done === total) return "All done. Lovely work.";
  if (done === 0) return "Every project starts with one small step.";
  if (total - done === 1) return "Just one to go.";
  if (done * 2 >= total) return "Over halfway. Keep it gentle.";
  return "Off to a good start.";
}

// --- Gentle nudges ---------------------------------------------------------------------

const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * A kind word for the task page, or null: overdue by a day or more, waiting on someone a week or more, or sitting on
 * To do for three weeks with no date. Takes a decorated task (src/web/task-list.js) and today's date.
 */
export function taskNudge(t, today) {
  if (t.status !== "open") return null;
  if (t.due_date && t.due_date < today) {
    const late = daysBetween(t.due_date, today);
    return late === 1
      ? "This one slipped past yesterday. That happens. Do it today, give it a new date, or let it rest on Maybe later."
      : `This one's been waiting ${late} days past its date. No guilt: pick a new date, or let it rest on Maybe later.`;
  }
  if (t.list === "waiting" && t.waiting_since) {
    const days = daysBetween(t.waiting_since, today);
    if (days >= 7) return `Waiting on ${t.waiting_on || "someone"} for ${days} days. A friendly check-in might help it along.`;
  }
  if (t.list === "todo" && !t.due_date && t.created_at && daysBetween(t.created_at.slice(0, 10), today) >= 21) {
    return "This has been on the list a while. What's the smallest bit you could do today?";
  }
  return null;
}

// --- Start of the day ------------------------------------------------------------------

const HELLO = {
  morning: ["Morning, {name}.", "Good morning, {name}.", "Morning, {name}. Kettle on?"],
  afternoon: ["Afternoon, {name}.", "Hi again, {name}.", "Good afternoon, {name}."],
  evening: ["Evening, {name}.", "Good evening, {name}.", "Winding down, {name}?"],
  night: ["Still up, {name}?", "Hi, {name}. It's late; go easy."],
};

const partOfDay = (time) => {
  const hour = Number(String(time ?? "12").slice(0, 2));
  return hour >= 5 && hour < 12 ? "morning" : hour < 17 ? "afternoon" : hour < 22 ? "evening" : "night";
};

/**
 * The line at the top of Mine. `dueToday` and `overdue` count your open To do tasks; `doneYesterday` what you
 * finished yesterday. The same words all day long (the seed is the date), apart from the time of day.
 */
export function greeting({ name, userId, today, time, dueToday = 0, overdue = 0, doneYesterday = 0 }) {
  const seed = `${today}:${userId}`;
  const first = String(name ?? "").split(" ")[0] || "there";
  const hello = fill(pick(HELLO[partOfDay(time)], seed), { name: first });
  const ahead =
    overdue ? (overdue === 1 ? "One thing slipped a little; no stress, it'll keep." : `${overdue} things slipped a little. Pick one; the rest will keep.`)
    : dueToday ? (dueToday === 1 ? "One thing due today. Plenty of time." : `${dueToday} things due today. One at a time.`)
    : pick(["Nothing due today. A gentle day.", "Nothing due today. Go at your own pace.", "A clear day. Nice."], seed);
  const yesterday = doneYesterday ? ` Yesterday you finished ${doneYesterday === 1 ? "one" : doneYesterday}. Nice going.` : "";
  return `${hello} ${ahead}${yesterday}`;
}

/** Yesterday's date, for counting what someone finished then. */
export const yesterdayOf = (today) => addDays(today, -1);
