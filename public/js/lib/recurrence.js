// Recurrence rules: { unit: "day" | "week" | "month", every: number, weekday?: 0-6 }
import { addDays, addMonths, nextWeekday, WEEKDAYS } from "./dates.js";

/** Computes the due date of the next occurrence after completing a task. */
export function nextOccurrence(rule, dueDate, today) {
  // Completed early: advance from the due date. Completed late: advance from today.
  const base = dueDate && dueDate > today ? dueDate : today;
  const every = Math.max(1, Number(rule.every) || 1);
  if (rule.weekday !== undefined && rule.weekday !== null) {
    return addDays(nextWeekday(base, rule.weekday), 7 * (every - 1));
  }
  if (rule.unit === "month") return addMonths(base, every);
  if (rule.unit === "week") return addDays(base, 7 * every);
  return addDays(base, every);
}

/** First due date for a brand-new recurring task that has no explicit date. */
export function firstOccurrence(rule, today) {
  if (rule.weekday !== undefined && rule.weekday !== null) {
    return rule.weekday === new Date(`${today}T00:00:00Z`).getUTCDay() ? today : nextWeekday(today, rule.weekday);
  }
  return today;
}

export function describeRecurrence(rule) {
  if (!rule) return "";
  const every = Math.max(1, Number(rule.every) || 1);
  if (rule.weekday !== undefined && rule.weekday !== null) {
    const day = WEEKDAYS[rule.weekday].slice(0, 3).replace(/^./, (c) => c.toUpperCase());
    return every === 1 ? `Every ${day}` : `Every ${every} weeks on ${day}`;
  }
  if (every === 1) return { day: "Daily", week: "Weekly", month: "Monthly" }[rule.unit] ?? "Repeats";
  return `Every ${every} ${rule.unit}s`;
}

export function parseRule(json) {
  if (!json) return null;
  try {
    const rule = typeof json === "string" ? JSON.parse(json) : json;
    return ["day", "week", "month"].includes(rule?.unit) ? rule : null;
  } catch {
    return null;
  }
}
