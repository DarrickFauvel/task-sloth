import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addDays, addMonths, daysBetween, dueState, isValidDate, nextWeekday, nowIn, relativeLabel, todayIn, weekdayOf,
} from "../public/js/lib/dates.js";

const TODAY = "2026-09-29"; // a Tuesday

test("addDays crosses month and year boundaries", () => {
  assert.equal(addDays("2026-09-30", 1), "2026-10-01");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(addDays("2024-03-01", -1), "2024-02-29");
});

test("addMonths clamps to the end of shorter months", () => {
  assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
  assert.equal(addMonths("2024-01-31", 1), "2024-02-29");
  assert.equal(addMonths("2026-03-31", 1), "2026-04-30");
  assert.equal(addMonths("2026-11-15", 2), "2027-01-15");
  assert.equal(addMonths("2026-03-31", -1), "2026-02-28");
});

test("weekdayOf and nextWeekday", () => {
  assert.equal(weekdayOf(TODAY), 2);
  assert.equal(nextWeekday(TODAY, 5), "2026-10-02"); // Friday
  assert.equal(nextWeekday(TODAY, 2), "2026-10-06", "same weekday means next week, not today");
  assert.equal(nextWeekday(TODAY, 1), "2026-10-05");
});

test("daysBetween is signed", () => {
  assert.equal(daysBetween(TODAY, "2026-10-02"), 3);
  assert.equal(daysBetween(TODAY, "2026-09-26"), -3);
  assert.equal(daysBetween("2026-03-07", "2026-03-09"), 2); // across a US DST change
});

test("isValidDate rejects malformed and impossible dates", () => {
  assert.equal(isValidDate("2026-02-28"), true);
  assert.equal(isValidDate("2024-02-29"), true);
  assert.equal(isValidDate("2026-02-29"), false);
  assert.equal(isValidDate("2026-13-01"), false);
  assert.equal(isValidDate("2026-9-1"), false);
  assert.equal(isValidDate(""), false);
  assert.equal(isValidDate(null), false);
});

test("relativeLabel", () => {
  assert.equal(relativeLabel(TODAY, TODAY), "Today");
  assert.equal(relativeLabel("2026-09-30", TODAY), "Tomorrow");
  assert.equal(relativeLabel("2026-09-28", TODAY), "Yesterday");
  assert.equal(relativeLabel("2026-09-25", TODAY), "4 days overdue");
  assert.equal(relativeLabel("2026-10-02", TODAY), "Fri");
  assert.equal(relativeLabel("2026-10-12", TODAY), "Oct 12");
  assert.equal(relativeLabel("2027-01-05", TODAY), "Jan 5, 2027");
});

test("dueState", () => {
  assert.equal(dueState("2026-09-28", TODAY), "overdue");
  assert.equal(dueState(TODAY, TODAY), "today");
  assert.equal(dueState("2026-10-02", TODAY), "soon");
  assert.equal(dueState("2026-10-03", TODAY), "later");
});

test("dueState: a task due today is overdue once its time has passed", () => {
  assert.equal(dueState(TODAY, TODAY, "15:00", "14:59"), "today");
  assert.equal(dueState(TODAY, TODAY, "15:00", "15:00"), "today");
  assert.equal(dueState(TODAY, TODAY, "15:00", "15:01"), "overdue");
  assert.equal(dueState(TODAY, TODAY, null, "23:59"), "today");
  assert.equal(dueState("2026-09-30", TODAY, "08:00", "23:00"), "soon");
});

test("nowIn gives the date and 24-hour time in a time zone", () => {
  const at = new Date("2026-09-30T03:05:00Z");
  assert.deepEqual(nowIn("America/New_York", at), { today: "2026-09-29", time: "23:05" });
  assert.deepEqual(nowIn("Asia/Tokyo", at), { today: "2026-09-30", time: "12:05" });
  assert.deepEqual(nowIn("Not/AZone", at), { today: "2026-09-30", time: "03:05" });
  assert.equal(nowIn("UTC", new Date("2026-09-30T00:30:00Z")).time, "00:30");
});

test("todayIn returns a YYYY-MM-DD date and falls back for unknown zones", () => {
  assert.ok(isValidDate(todayIn("America/New_York")));
  assert.equal(todayIn("Not/A_Zone"), new Date().toISOString().slice(0, 10));
});
