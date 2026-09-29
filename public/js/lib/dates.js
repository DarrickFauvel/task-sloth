// Date helpers shared by the server and the browser. Dates are plain "YYYY-MM-DD" strings.

export const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
export const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Today's date in the given IANA time zone (falls back to UTC for unknown zones). */
export function todayIn(timeZone = "UTC") {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

const toDate = (ymd) => new Date(`${ymd}T00:00:00Z`);
const fromDate = (d) => d.toISOString().slice(0, 10);

export function addDays(ymd, n) {
  const d = toDate(ymd);
  d.setUTCDate(d.getUTCDate() + n);
  return fromDate(d);
}

/** Adds months, clamping to the end of shorter months (Jan 31 + 1 month = Feb 28/29). */
export function addMonths(ymd, n) {
  const d = toDate(ymd);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return fromDate(d);
}

export const weekdayOf = (ymd) => toDate(ymd).getUTCDay();

/** The next date strictly after `ymd` that falls on `weekday` (0 = Sunday). */
export function nextWeekday(ymd, weekday) {
  const diff = (weekday - weekdayOf(ymd) + 7) % 7 || 7;
  return addDays(ymd, diff);
}

/** Whole days from `a` to `b` (positive when b is later). */
export const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / 86_400_000);

export const isValidDate = (ymd) =>
  typeof ymd === "string" && /^\d{4}-\d{2}-\d{2}$/.test(ymd) && !isNaN(toDate(ymd)) && fromDate(toDate(ymd)) === ymd;

/** Human label relative to today: "Today", "Tomorrow", "Fri", "3 days overdue", "Oct 12". */
export function relativeLabel(ymd, today) {
  const diff = daysBetween(today, ymd);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  if (diff < 0) return `${-diff} days overdue`;
  if (diff < 7) return WEEKDAYS[weekdayOf(ymd)].slice(0, 3).replace(/^./, (c) => c.toUpperCase());
  const d = toDate(ymd);
  const label = `${MONTHS[d.getUTCMonth()].replace(/^./, (c) => c.toUpperCase())} ${d.getUTCDate()}`;
  return ymd.slice(0, 4) === today.slice(0, 4) ? label : `${label}, ${ymd.slice(0, 4)}`;
}

/** "overdue" | "today" | "soon" (within 3 days) | "later" — used for styling. */
export function dueState(ymd, today) {
  const diff = daysBetween(today, ymd);
  if (diff < 0) return "overdue";
  if (diff === 0) return "today";
  if (diff <= 3) return "soon";
  return "later";
}
