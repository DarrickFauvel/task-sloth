// Suggestions while typing a task into quick add (public/js/quick-suggest.js shows them). Shared with the
// server's tests, so it stays pure. Each suggestion is a shortcut quick-add.js understands:
//
//   "@"    who (me, anyone, a member) and where / how (the household's saved ones)
//   "#"    a project            "+"  a tag
//   words  when ("tom" -> tomorrow, "fri", "next week") and repeats ("every tue", "weekly")
import { parseQuickAdd } from "./quick-add.js";
import { describeRecurrence } from "./recurrence.js";

/** How many suggestions show at once. */
export const MAX_SUGGESTIONS = 6;

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const WHEN = ["today", "tonight", "tomorrow", ...DAYS, "next week", "this weekend"];
const REPEATS = ["daily", "weekly", "monthly", "every day", "every week", "every 2 weeks", "every month", ...DAYS.map((d) => `every ${d.slice(0, 3)}`)];
/** Words that start a two-word phrase, so "every fr" completes as a whole ("every fri"). */
const LEADS = new Set(["every", "each", "next", "this"]);
/** A plain word suggests only once this much is typed, so short everyday words ("to", "we") stay quiet. */
const MIN_WORD = 3;

const normalize = (s) => String(s).toLowerCase().replace(/[\s_-]+/g, "");

/**
 * How to type a name after @ or #: dashes for spaces ("@Home-Depot"), or quotes when it has characters a bare
 * name can't (`@"Joe's & Co"`). `chars` is what quick-add.js accepts in a bare name.
 */
export function shortcutName(prefix, name, chars) {
  const dashed = String(name).trim().replace(/\s+/g, "-");
  return chars.test(dashed) ? `${prefix}${dashed}` : `${prefix}"${String(name).trim()}"`;
}
const AT_CHARS = /^[\p{L}\p{N}_.'-]+$/u;
const HASH_CHARS = /^[\p{L}\p{N}_-]+$/u;

/** "Fri, Oct 9" for a YYYY-MM-DD date. */
const dayLabel = (ymd) =>
  new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(new Date(`${ymd}T00:00:00Z`));

/**
 * @typedef {{ me?: string, members?: {id: string, name: string, color?: string}[], projects?: {name: string, emoji?: string}[], contexts?: {name: string}[], tags?: string[] }} SuggestData
 * @typedef {{ insert: string, label: string, kind: string, detail?: string, color?: string }} Suggestion
 */

/**
 * Suggestions for the word being typed at `caret` in `value`, or null when there are none.
 * `start`/`end` is the stretch of text a pick replaces. `strong` means a shortcut was asked for (@, #, +), so
 * Enter may pick the first one; for plain words ("sun…") it's only offered, and Enter still adds the task.
 * @param {string} value
 * @param {number} caret
 * @param {SuggestData} data
 * @param {string} today  YYYY-MM-DD, for what "fri" means
 * @returns {{ start: number, end: number, strong: boolean, items: Suggestion[] } | null}
 */
export function suggestAt(value, caret, data, today) {
  const before = value.slice(0, caret);
  const word = before.match(/(\S*)$/)[1];
  const start = caret - word.length;
  const end = caret + value.slice(caret).match(/^\S*/)[0].length;
  const typed = value.slice(start, end);
  const result = (items, from = start, strong = true) => {
    const shown = items.filter((s) => s.insert.trim().toLowerCase() !== value.slice(from, end).toLowerCase()).slice(0, MAX_SUGGESTIONS);
    return shown.length && items.length ? { start: from, end, strong, items: shown } : null;
  };

  const sigil = typed[0];
  const query = typed.slice(1).replace(/^"/, "");
  if (sigil === "@") return result(atSuggestions(query, data));
  if (sigil === "#") {
    const items = (data.projects ?? []).map((p) => ({ insert: shortcutName("#", p.name, HASH_CHARS), label: `${p.emoji ?? ""} ${p.name}`.trim(), kind: "Project" }));
    return result(matching(items, query, (s) => s.label));
  }
  if (sigil === "+") {
    const items = (data.tags ?? []).map((t) => ({ insert: `+${t}`, label: `+${t}`, kind: "Tag" }));
    return result(matching(items, query, (s) => s.insert.slice(1)));
  }

  if (!/^\p{L}+$/u.test(typed)) return null;
  // "every fr" or "next w": complete the pair, replacing both words.
  const lead = before.slice(0, start).match(/(\S+)\s+$/);
  if (lead && LEADS.has(lead[1].toLowerCase())) {
    const pair = `${lead[1].toLowerCase()} ${typed.toLowerCase()}`;
    const from = start - lead[0].length;
    const items = timeSuggestions(today, value.slice(0, from) + value.slice(end)).filter((s) => s.insert.startsWith(pair));
    if (items.length) return result(items, from, false);
  }
  if (typed.length < MIN_WORD) return null;
  const w = typed.toLowerCase();
  return result(timeSuggestions(today, value.slice(0, start) + value.slice(end)).filter((s) => s.insert.startsWith(w)), start, false);
}

/** Who first (you, anyone, the others), then the household's where / hows. */
function atSuggestions(query, { me, members = [], contexts = [] }) {
  const people = [
    { insert: "@me", label: "Me", kind: "Who", color: members.find((m) => m.id === me)?.color },
    ...members
      .filter((m) => m.id !== me)
      .map((m) => ({ insert: memberHandle(m, members, contexts), label: m.name, kind: "Who", color: m.color })),
    { insert: "@anyone", label: "Anyone (up for grabs)", kind: "Who" },
  ];
  const places = contexts.map((c) => ({ insert: shortcutName("@", c.name, AT_CHARS), label: `@${c.name}`, kind: "Where / how" }));
  return [
    ...matching(people, query, (s) => `${s.label} ${s.insert.slice(1)}`),
    ...matching(places, query, (s) => s.label.slice(1)),
  ];
}

/**
 * The short @name for a member: their first name when only they start with it and no where/how is called
 * that ("@sam"), otherwise their whole name ("@Sam-Lee").
 */
function memberHandle(member, members, contexts) {
  const first = member.name.trim().toLowerCase().match(/^[\p{L}\p{N}_.'-]+/u)?.[0];
  const unique = first && members.filter((m) => m.name.toLowerCase().startsWith(first)).length === 1;
  const clash = contexts.some((c) => normalize(c.name) === normalize(first ?? ""));
  return unique && !clash ? `@${first}` : shortcutName("@", member.name, AT_CHARS);
}

/** Items whose text (or any word in it) starts with what's typed; whole-text matches first. Everything when nothing's typed. */
function matching(items, query, textOf) {
  const q = normalize(query);
  if (!q) return items;
  const starts = items.filter((s) => normalize(textOf(s)).startsWith(q));
  const words = items.filter((s) => !starts.includes(s) && textOf(s).toLowerCase().split(/[\s_-]+/).some((w) => normalize(w).startsWith(q)));
  return [...starts, ...words];
}

/**
 * Every when and repeat phrase, with what it means from `today` ("Fri, Oct 9", "Every Tue"). A repeat starts on
 * the date typed elsewhere in `rest` (the rest of the box), if there is one.
 */
function timeSuggestions(today, rest = "") {
  const when = WHEN.map((phrase) => {
    const { dueDate } = parseQuickAdd(phrase, { today });
    return { insert: phrase, label: phrase, kind: "When", detail: dueDate ? dayLabel(dueDate) : undefined };
  });
  const repeats = REPEATS.map((phrase) => {
    const { recurrence, dueDate } = parseQuickAdd(`${rest} ${phrase}`, { today });
    const from = dueDate === today ? ", starting today" : dueDate ? `, starting ${dayLabel(dueDate)}` : "";
    return { insert: phrase, label: phrase, kind: "Repeats", detail: `${describeRecurrence(recurrence)}${from}` };
  });
  return [...when, ...repeats];
}
