// Natural-language quick add, parsed on the server when a task is added. It lives in
// public/ so a live preview in the browser could share it, but no such preview exists yet.
//
//   "buy flowers fri @me #Birthday !high"      -> due Friday, assigned to me, project Birthday
//   "take out trash every tue @sam"            -> recurring weekly on Tuesday
//   "dentist tomorrow at 3pm"                  -> due tomorrow 15:00
//   "printer ink @Target +errand"              -> context Target, tagged errand
import { addDays, isValidDate, MONTHS, nextWeekday, WEEKDAYS, weekdayOf } from "./dates.js";
import { firstOccurrence } from "./recurrence.js";

// Month names or their usual abbreviations ("sept", "dec."), but not words like "decorate".
const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const WEEKDAY_RE = "(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|nesday|sday|urday)?";
const weekdayIndex = (word) => WEEKDAYS.findIndex((d) => d.startsWith(word.toLowerCase().slice(0, 3)));
const normalize = (s) => s.toLowerCase().replace(/[\s_-]+/g, "");

/**
 * @param {string} input
 * @param {{ today: string, meId?: string, members?: {id: string, name: string}[], projects?: {id: string, name: string}[], contexts?: {id: string, name: string}[] }} ctx
 */
export function parseQuickAdd(input, ctx) {
  const { today, meId, members = [], projects = [], contexts = [] } = ctx;
  /** @type {{ title: string, dueDate?: string, dueTime?: string, assigneeId?: string | null, projectId?: string, projectName?: string, contextId?: string, contextName?: string, tags?: string[], priority?: number, recurrence?: {unit: string, every: number, weekday?: number} }} */
  const out = { title: "" };
  let text = ` ${input} `;
  const take = (re, fn) => {
    text = text.replace(re, (...m) => {
      fn(m);
      return " ";
    });
  };

  // @someone or @context: a member's name (or the start of it), otherwise a context.
  // A member's full name beats a saved context, which beats the start of a member's name.
  // Only the first person and the first context count. Spaces: @home-depot or @"Home Depot".
  take(/\s@(?:"([^"]+)"|([\p{L}\p{N}_.'-]+))(?=\s)/giu, ([, quoted, bare]) => {
    const word = quoted ?? bare;
    const w = word.toLowerCase();
    const setPerson = (id) => {
      if (!("assigneeId" in out)) out.assigneeId = id;
    };
    const setContext = (context) => {
      if (!out.contextId && !out.contextName) Object.assign(out, context);
    };
    if (w === "me") return setPerson(meId);
    if (["anyone", "none", "nobody", "grabs"].includes(w)) return setPerson(null);
    const name = word.replace(/[-_]/g, " ").replace(/\s+/g, " ").trim();
    const member = members.find((m) => normalize(m.name) === normalize(name));
    if (member) return setPerson(member.id);
    const context = contexts.find((c) => normalize(c.name) === normalize(name));
    if (context) return setContext({ contextId: context.id });
    const partial = !quoted && members.find((m) => m.name.toLowerCase().startsWith(w));
    if (partial) return setPerson(partial.id);
    setContext({ contextName: name });
  });

  // +tags, any number: "+errand +quick-win"
  take(/\s\+(\p{L}[\p{L}\p{N}_-]*)(?=\s)/gu, ([, tag]) => {
    const name = tag.toLowerCase().replace(/_/g, "-");
    out.tags = [...new Set([...(out.tags ?? []), name])];
  });

  // #project (use dashes or quotes for spaces: #weekly-shop or #"Weekly shop")
  take(/\s#(?:"([^"]+)"|([\p{L}\p{N}_-]+))(?=\s)/iu, ([, quoted, bare]) => {
    const name = (quoted ?? bare).replace(/[-_]/g, " ").trim();
    const match = projects.find((p) => normalize(p.name) === normalize(name));
    if (match) out.projectId = match.id;
    else out.projectName = name.replace(/^./, (c) => c.toUpperCase());
  });

  // !priority
  take(/\s(!!|!high|!h|!1|!urgent)(?=\s)/i, () => (out.priority = 1));
  take(/\s(!low|!l|!3)(?=\s)/i, () => (out.priority = -1));

  // recurrence
  take(new RegExp(`\\s(?:every|each)\\s+(?:(\\d+)\\s+weeks?\\s+on\\s+)?${WEEKDAY_RE}(?=\\s)`, "i"), ([, n, day]) => {
    out.recurrence = { unit: "week", every: Number(n ?? 1), weekday: weekdayIndex(day) };
  });
  take(/\s(?:every|each)\s+(\d+)\s+(day|week|month)s?(?=\s)/i, ([, n, unit]) => {
    out.recurrence = { unit: unit.toLowerCase(), every: Number(n) };
  });
  take(/\s(?:every|each)\s+(day|week|month)(?=\s)/i, ([, unit]) => {
    out.recurrence = { unit: unit.toLowerCase(), every: 1 };
  });
  take(/\s(daily|weekly|monthly)(?=\s)/i, ([, w]) => {
    out.recurrence = { unit: { daily: "day", weekly: "week", monthly: "month" }[w.toLowerCase()], every: 1 };
  });

  // time: "at 5pm", "5:30pm", "at 17:00"
  take(/\s(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?=\s)/i, ([, h, m, ap]) => {
    let hour = Number(h) % 12;
    if (ap.toLowerCase() === "pm") hour += 12;
    out.dueTime = `${String(hour).padStart(2, "0")}:${m ?? "00"}`;
  });
  take(/\sat\s+([01]?\d|2[0-3]):([0-5]\d)(?=\s)/i, ([, h, m]) => {
    out.dueTime = `${h.padStart(2, "0")}:${m}`;
  });

  // dates
  const setDate = (d) => {
    if (!out.dueDate && isValidDate(d)) out.dueDate = d;
  };
  take(/\s(\d{4}-\d{2}-\d{2})(?=\s)/, ([, d]) => setDate(d));
  take(/\s(?:on\s+)?(\d{1,2})\/(\d{1,2})(?=\s)/, ([, m, d]) => {
    const year = Number(today.slice(0, 4));
    const pad = (n) => String(n).padStart(2, "0");
    let date = `${year}-${pad(m)}-${pad(d)}`;
    if (date < today) date = `${year + 1}-${pad(m)}-${pad(d)}`;
    setDate(date);
  });
  take(new RegExp(`\\s(?:on\\s+)?${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?=\\s)`, "i"), ([, mon, d]) => {
    const year = Number(today.slice(0, 4));
    const m = String(MONTHS.indexOf(mon.toLowerCase().slice(0, 3)) + 1).padStart(2, "0");
    let date = `${year}-${m}-${d.padStart(2, "0")}`;
    if (date < today) date = `${year + 1}-${m}-${d.padStart(2, "0")}`;
    setDate(date);
  });
  take(/\s(today|tonight)(?=\s)/i, () => setDate(today));
  take(/\s(tomorrow|tmrw|tmr)(?=\s)/i, () => setDate(addDays(today, 1)));
  take(/\sin\s+(\d+)\s+(day|week)s?(?=\s)/i, ([, n, unit]) =>
    setDate(addDays(today, Number(n) * (unit.toLowerCase() === "week" ? 7 : 1))),
  );
  take(/\snext\s+week(?=\s)/i, () => setDate(nextWeekday(today, 1)));
  take(/\s(?:this\s+)?weekend(?=\s)/i, () => setDate(weekdayOf(today) === 6 ? today : nextWeekday(today, 6)));
  take(new RegExp(`\\s(?:on\\s+|next\\s+|this\\s+)?${WEEKDAY_RE}(?=\\s)`, "i"), ([, day]) =>
    setDate(nextWeekday(today, weekdayIndex(day))),
  );

  if (out.recurrence && !out.dueDate) out.dueDate = firstOccurrence(out.recurrence, today);
  out.title = text.replace(/\s+/g, " ").trim();
  return out;
}
