import { describeActivity, listActivity } from "../services/activity.js";
import { addDays } from "../../public/js/lib/dates.js";

/** How far back the Activity page goes. */
export const ACTIVITY_DAYS = 14;

/** A formatter in the viewer's time zone, falling back to UTC for an unknown one. */
function formatter(timeZone, options, locale = "en-US") {
  try {
    return new Intl.DateTimeFormat(locale, { timeZone, ...options });
  } catch {
    return new Intl.DateTimeFormat(locale, { timeZone: "UTC", ...options });
  }
}

/**
 * The household's last ACTIVITY_DAYS days of activity for views/pages/activity.eta, one group per
 * day (in the viewer's time zone), newest first.
 */
export async function activityView({ userId, membership, timeZone, today, now = Date.now() }) {
  const since = new Date(now - ACTIVITY_DAYS * 86_400_000).toISOString();
  const rows = await listActivity(membership.household.id, { since, limit: 1000 });
  const membersById = Object.fromEntries(membership.members.map((m) => [m.id, m]));
  const day = formatter(timeZone, {}, "en-CA"); // "2026-09-30"
  const time = formatter(timeZone, { hour: "numeric", minute: "2-digit" });
  const longDay = formatter(timeZone, { weekday: "long", month: "short", day: "numeric" }); // "Monday, Sep 28"
  const yesterday = addDays(today, -1);

  const days = new Map();
  for (const a of rows) {
    const at = new Date(a.created_at);
    const ymd = day.format(at);
    if (!days.has(ymd)) {
      const label = ymd === today ? "Today" : ymd === yesterday ? "Yesterday" : longDay.format(at);
      days.set(ymd, { label, entries: [] });
    }
    days.get(ymd).entries.push({
      text: describeActivity(a, { membersById, meId: userId }),
      title: a.task_title,
      // Deleted tasks (and rows whose task is gone) aren't linked.
      href: a.task_title && !a.task_deleted_at ? `/tasks/${a.task_id}` : null,
      time: time.format(at),
      actor: a.actor_id ? (membersById[a.actor_id] ?? null) : null,
    });
  }
  return { days: [...days.values()], count: rows.length, capped: rows.length === 1000 };
}
