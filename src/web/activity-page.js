import { activityParts, listActivity } from "../services/activity.js";
import { addDays } from "../../public/js/lib/dates.js";

/** How far back the Activity page goes. */
export const ACTIVITY_DAYS = 14;

/** What each logged field is called on the edit form ("updated" rows record the columns that changed). */
const FIELD_WORDS = {
  title: "name", notes: "notes", due_date: "date", due_time: "time", recurrence: "repeat", context_id: "where / how",
  list: "list", waiting_on: "who it's waiting on", waiting_task_id: "what it waits for", project_id: "project",
  tags: "tags", priority: "priority", list_mode: "kind of list",
};
/** Fields whose change matters to everyone (when it's due, or which list it's on); edits touching only the rest are minor. */
const MAIN_FIELDS = new Set(["due_date", "due_time", "recurrence", "list", "waiting_on", "waiting_task_id"]);
/** Kinds that are minor whatever they touch: items added to a checklist, the next repeat being scheduled, and
 *  starting or stopping "working on now". */
const MINOR_VERBS = new Set(["checklist", "recurred", "started", "stopped"]);

/** "date, list and notes"; past four, "date, time, list and 2 more". Unknown fields are left out. */
export function fieldWords(fields) {
  const words = [...new Set(fields.map((f) => FIELD_WORDS[f]).filter(Boolean))];
  if (words.length > 4) return `${words.slice(0, 3).join(", ")} and ${words.length - 3} more`;
  return words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words.at(-1)}` : (words[0] ?? "");
}

/** "added", "added and completed", "added, edited and completed". */
const joinActions = (actions) => (actions.length > 1 ? `${actions.slice(0, -1).join(", ")} and ${actions.at(-1)}` : actions[0]);

/** A formatter in the viewer's time zone, falling back to UTC for an unknown one. */
function formatter(timeZone, options, locale = "en-US") {
  try {
    return new Intl.DateTimeFormat(locale, { timeZone, ...options });
  } catch {
    return new Intl.DateTimeFormat(locale, { timeZone: "UTC", ...options });
  }
}

/**
 * Activity rows (newest first) as one card per day for views/pages/activity.eta, tidied to what someone would
 * want to know rather than every save:
 * - One line per person, task and day, at the latest time, its actions in order ("Sam added and completed"),
 *   with what an edit changed ("Changed: date and list").
 * - Unless `all`, minor rows are left out: edits that only touch notes, name, tags, project, priority or the
 *   kind of list (an edit that also changes the date or list keeps just those), checklist items added, the next
 *   repeat being scheduled, starting or stopping work on a task, and a delete that was undone (with its restore).
 * - `who` picks whose rows: "others" (everyone but you, and things nobody did, like "Ready to go"), "everyone",
 *   or a member id.
 */
export function buildActivity(rows, { membersById, userId, timeZone, today, who = "everyone", all = false }) {
  const day = formatter(timeZone, {}, "en-CA"); // "2026-09-30"
  const time = formatter(timeZone, { hour: "numeric", minute: "2-digit" });
  const longDay = formatter(timeZone, { weekday: "long", month: "short", day: "numeric" }); // "Monday, Sep 28"
  const yesterday = addDays(today, -1);
  const ctx = { membersById, meId: userId };
  const keep = who === "everyone" ? () => true : who === "others" ? (a) => a.actor_id !== userId : (a) => a.actor_id === who;

  const days = new Map();
  const lines = new Map(); // actor|task|day -> its line
  const undone = new Set(); // tasks restored later on, whose delete (going back in time) is hidden too
  for (const a of rows) {
    if (!all && a.verb === "restored") (undone.add(a.task_id), (a.hidden = true));
    if (!all && a.verb === "deleted" && undone.delete(a.task_id)) continue;
    if (a.hidden || !keep(a)) continue;
    let fields = Array.isArray(a.detail?.fields) ? a.detail.fields : [];
    if (!all && MINOR_VERBS.has(a.verb)) continue;
    if (!all && a.verb === "updated") {
      fields = fields.filter((f) => MAIN_FIELDS.has(f));
      if (!fields.length) continue;
    }

    const at = new Date(a.created_at);
    const ymd = day.format(at);
    if (!days.has(ymd)) {
      const label = ymd === today ? "Today" : ymd === yesterday ? "Yesterday" : longDay.format(at);
      days.set(ymd, { label, lines: [] });
    }
    const parts = activityParts(a, ctx);
    // Things nobody did ("Ready to go:") stay one line each.
    const key = parts.sentence ? Symbol() : `${a.actor_id}|${a.task_id}|${ymd}`;
    let line = lines.get(key);
    if (!line) {
      line = { row: a, parts, actions: [], fields: [], time: time.format(at), excerpt: null };
      lines.set(key, line);
      days.get(ymd).lines.push(line);
    }
    // Going back in time, so each earlier action goes in front. One of a kind is enough, placed where it first happened.
    if (parts.action) line.actions = [parts.action, ...line.actions.filter((x) => x !== parts.action)];
    line.fields.unshift(...fields);
    // The newest comment's start, under "commented on" (rows go newest first, so the first one seen).
    if (a.verb === "commented" && !line.excerpt && a.detail?.excerpt) line.excerpt = a.detail.excerpt;
  }

  return [...days.values()].map((d) => ({
    label: d.label,
    entries: d.lines.map(({ row: a, parts, actions, fields, time: at, excerpt }) => {
      const changed = actions.includes("edited") ? fieldWords(fields) : "";
      const detail = [changed && `Changed: ${changed}`, excerpt && `“${excerpt.length === 80 ? `${excerpt}…` : excerpt}”`].filter(Boolean).join(" · ");
      return {
        text: parts.sentence ?? `${parts.actor} ${joinActions(actions)}`,
        detail: detail || null,
        title: a.task_title,
        // Deleted tasks (and rows whose task is gone) aren't linked.
        href: a.task_title && !a.task_deleted_at ? `/tasks/${a.task_id}` : null,
        time: at,
        actor: a.actor_id ? (membersById[a.actor_id] ?? null) : null,
      };
    }),
  }));
}

/**
 * The household's last ACTIVITY_DAYS days of activity (see buildActivity). `who` is from ?who=: "others",
 * "everyone", or a member id; otherwise it's what you did (or everything, in a household of one). `all`
 * (?all=1) shows every change, minor ones too. `filters` are the page's chips and its "every change" link.
 */
export async function activityView({ userId, membership, timeZone, today, who = null, all = false, now = Date.now() }) {
  const since = new Date(now - ACTIVITY_DAYS * 86_400_000).toISOString();
  const rows = await listActivity(membership.household.id, { since, limit: 1000 });
  const membersById = Object.fromEntries(membership.members.map((m) => [m.id, m]));
  const others = membership.members.filter((m) => m.id !== userId);
  const firstName = (m) => m.name.split(" ")[0];
  const choice = !others.length ? "everyone" : who === "everyone" || who === "others" || others.some((m) => m.id === who) ? who : "me";
  const href = (key, everything = all) => {
    const q = new URLSearchParams({ ...(key !== "me" && others.length ? { who: key } : {}), ...(everything ? { all: "1" } : {}) }).toString();
    return `/activity${q ? `?${q}` : ""}`;
  };
  // "You | Sam | Everyone" in a household of two; "You | Others | Everyone | Sam | Kim" in a bigger one.
  const people = others.length
    ? [{ key: "me", label: "You" }, { key: "others", label: others.length === 1 ? firstName(others[0]) : "Others" }, { key: "everyone", label: "Everyone" },
        ...(others.length > 1 ? others.map((m) => ({ key: m.id, label: firstName(m) })) : [])]
    : [];
  return {
    days: buildActivity(rows, { membersById, userId, timeZone, today, all, who: choice === "me" ? userId : choice }),
    people: people.map((p) => ({ ...p, on: p.key === choice, href: href(p.key) })),
    all,
    toggleHref: href(choice, !all),
    count: rows.length,
    capped: rows.length === 1000,
  };
}
