import { describeActivity, listActivity } from "../services/activity.js";
import { addDays } from "../../public/js/lib/dates.js";

/** How far back the Activity page goes. */
export const ACTIVITY_DAYS = 14;

/** Edits by one person to one task this close together are one line (the edit form saves every change). */
export const MERGE_WINDOW_MS = 30 * 60_000;

/** What each logged field is called on the edit form ("updated" rows record the columns that changed). */
const FIELD_WORDS = {
  title: "name", notes: "notes", due_date: "date", due_time: "time", recurrence: "repeat", context_id: "where / how",
  list: "list", waiting_on: "who it's waiting on", waiting_task_id: "what it waits for", project_id: "project",
  tags: "tags", priority: "priority", list_mode: "kind of list",
};
/** Verbs that end a run of edits: edits on either side of one aren't the same sitting. */
const BREAKS_EDITS = new Set(["completed", "reopened", "deleted", "restored"]);

/** "date, list and notes"; past four, "date, time, list and 2 more". Unknown fields are left out. */
export function fieldWords(fields) {
  const words = [...new Set(fields.map((f) => FIELD_WORDS[f]).filter(Boolean))];
  if (words.length > 4) return `${words.slice(0, 3).join(", ")} and ${words.length - 3} more`;
  return words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words.at(-1)}` : (words[0] ?? "");
}

/** A formatter in the viewer's time zone, falling back to UTC for an unknown one. */
function formatter(timeZone, options, locale = "en-US") {
  try {
    return new Intl.DateTimeFormat(locale, { timeZone, ...options });
  } catch {
    return new Intl.DateTimeFormat(locale, { timeZone: "UTC", ...options });
  }
}

/**
 * Activity rows (newest first) as one card per day for views/pages/activity.eta, tidied so it reads as what
 * happened rather than every save: a person's edits to a task within MERGE_WINDOW_MS are one line saying what
 * changed ("Changed: date and list"), and edits right after adding a task fold into its "added" line ("Then
 * changed: …"). An assignment in the middle stays its own line without splitting the edits; finishing,
 * reopening, deleting or restoring does split them. Nothing is merged across days. `who` keeps one person's
 * rows (an id); the rest are left out.
 */
export function buildActivity(rows, { membersById, userId, timeZone, today, who = null }) {
  const day = formatter(timeZone, {}, "en-CA"); // "2026-09-30"
  const time = formatter(timeZone, { hour: "numeric", minute: "2-digit" });
  const longDay = formatter(timeZone, { weekday: "long", month: "short", day: "numeric" }); // "Monday, Sep 28"
  const yesterday = addDays(today, -1);

  const days = new Map();
  const open = new Map(); // actor|task -> the line its next-older edits can join
  for (const a of rows) {
    if (who && a.actor_id !== who) continue;
    const at = Date.parse(a.created_at);
    const ymd = day.format(new Date(at));
    const key = `${a.actor_id}|${a.task_id}`;
    const group = open.get(key);
    const near = group && group.ymd === ymd && group.oldest - at <= MERGE_WINDOW_MS;
    const fields = Array.isArray(a.detail?.fields) ? a.detail.fields : [];

    if (a.verb === "updated" && near && group.verb === "updated") {
      group.fields.push(...fields);
      group.oldest = at;
      continue;
    }
    if (a.verb === "created" && near && group.verb === "updated") {
      Object.assign(group, { verb: "created", then: true, oldest: at, row: a });
      continue;
    }
    if (BREAKS_EDITS.has(a.verb)) open.delete(key);

    if (!days.has(ymd)) {
      const label = ymd === today ? "Today" : ymd === yesterday ? "Yesterday" : longDay.format(new Date(at));
      days.set(ymd, { label, entries: [] });
    }
    const entry = { row: a, verb: a.verb, fields: [...fields], ymd, oldest: at, time: time.format(new Date(at)), then: false };
    days.get(ymd).entries.push(entry);
    if (a.verb === "updated") open.set(key, entry);
  }

  return [...days.values()].map((d) => ({
    label: d.label,
    entries: d.entries.map((e) => {
      const a = e.row;
      const changed = fieldWords(e.fields);
      return {
        text: describeActivity({ ...a, verb: e.verb }, { membersById, meId: userId }),
        // "Changed: date and list" under an edit; "Then changed: …" under an add that was filled in straight after.
        detail: changed ? `${e.then ? "Then changed" : "Changed"}: ${changed}` : null,
        title: a.task_title,
        // Deleted tasks (and rows whose task is gone) aren't linked.
        href: a.task_title && !a.task_deleted_at ? `/tasks/${a.task_id}` : null,
        time: e.time,
        actor: a.actor_id ? (membersById[a.actor_id] ?? null) : null,
      };
    }),
  }));
}

/**
 * The household's last ACTIVITY_DAYS days of activity (see buildActivity), with the "Everyone | You | Sam"
 * filter. `who` is a member id from ?who=; anything else shows everyone.
 */
export async function activityView({ userId, membership, timeZone, today, who = null, now = Date.now() }) {
  const since = new Date(now - ACTIVITY_DAYS * 86_400_000).toISOString();
  const rows = await listActivity(membership.household.id, { since, limit: 1000 });
  const membersById = Object.fromEntries(membership.members.map((m) => [m.id, m]));
  const person = Object.hasOwn(membersById, who ?? "") ? who : null;
  const people = membership.members.length > 1
    ? [{ id: null, label: "Everyone" }, ...membership.members
        .map((m) => ({ id: m.id, label: m.id === userId ? "You" : m.name.split(" ")[0] }))
        .sort((x, y) => (y.id === userId) - (x.id === userId))]
    : [];
  return {
    days: buildActivity(rows, { membersById, userId, timeZone, today, who: person }),
    people: people.map((p) => ({ ...p, on: p.id === person })),
    count: rows.length,
    capped: rows.length === 1000,
  };
}
