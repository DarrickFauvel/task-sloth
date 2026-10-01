import { listComments } from "../services/tasks.js";
import { splitPhones } from "../../public/js/lib/phone.js";
import { addDays } from "../../public/js/lib/dates.js";

/** A formatter in the viewer's time zone, falling back to UTC for an unknown one. */
function formatter(timeZone, options, locale = "en-US") {
  try {
    return new Intl.DateTimeFormat(locale, { timeZone, ...options });
  } catch {
    return new Intl.DateTimeFormat(locale, { timeZone: "UTC", ...options });
  }
}

/**
 * When a comment was left, the way people say it: "Today 3:15 PM", "Yesterday 9:02 AM", "Mon 9:40 AM" this week,
 * then "Sep 28". In the viewer's time zone.
 */
export function commentTime(iso, { timeZone, today }) {
  const at = new Date(iso);
  const ymd = formatter(timeZone, {}, "en-CA").format(at);
  const clock = formatter(timeZone, { hour: "numeric", minute: "2-digit" }).format(at);
  if (ymd === today) return `Today ${clock}`;
  if (ymd === addDays(today, -1)) return `Yesterday ${clock}`;
  if (ymd > addDays(today, -7)) return `${formatter(timeZone, { weekday: "short" }).format(at)} ${clock}`;
  return formatter(timeZone, { month: "short", day: "numeric" }).format(at);
}

/** A task's comments for views/partials/comments.eta, oldest first: who, when, the text (phones tappable), and yours. */
export async function commentsView(taskId, { userId, membership, timeZone, today }) {
  const membersById = Object.fromEntries(membership.members.map((m) => [m.id, m]));
  const comments = (await listComments(taskId)).map((c) => {
    const author = membersById[c.author_id] ?? null;
    const mine = c.author_id === userId;
    return {
      id: c.id,
      author,
      name: mine ? "You" : (author?.name.split(" ")[0] ?? "Someone"),
      time: commentTime(c.created_at, { timeZone, today }),
      iso: c.created_at,
      parts: splitPhones(c.body),
      mine,
    };
  });
  return { taskId, comments };
}
