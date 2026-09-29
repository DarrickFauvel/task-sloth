import { test } from "node:test";
import assert from "node:assert/strict";
import { describeRecurrence, firstOccurrence, nextOccurrence, parseRule } from "../public/js/lib/recurrence.js";

const TODAY = "2026-09-29"; // a Tuesday

test("nextOccurrence advances from today when completed late", () => {
  assert.equal(nextOccurrence({ unit: "day", every: 1 }, "2026-09-20", TODAY), "2026-09-30");
  assert.equal(nextOccurrence({ unit: "week", every: 1 }, "2026-09-20", TODAY), "2026-10-06");
  assert.equal(nextOccurrence({ unit: "day", every: 3 }, null, TODAY), "2026-10-02");
});

test("nextOccurrence advances from the due date when completed early", () => {
  assert.equal(nextOccurrence({ unit: "week", every: 1 }, "2026-10-01", TODAY), "2026-10-08");
  assert.equal(nextOccurrence({ unit: "month", every: 1 }, "2026-10-31", TODAY), "2026-11-30");
});

test("nextOccurrence for monthly rules clamps month ends", () => {
  assert.equal(nextOccurrence({ unit: "month", every: 1 }, "2027-01-31", "2027-01-31"), "2027-02-28");
  assert.equal(nextOccurrence({ unit: "month", every: 3 }, TODAY, TODAY), "2026-12-29");
});

test("nextOccurrence for weekday rules lands on that weekday", () => {
  const fri = { unit: "week", every: 1, weekday: 5 };
  assert.equal(nextOccurrence(fri, TODAY, TODAY), "2026-10-02");
  assert.equal(nextOccurrence(fri, "2026-10-02", TODAY), "2026-10-09", "completing Friday's early gives next Friday");
  assert.equal(nextOccurrence({ unit: "week", every: 2, weekday: 5 }, TODAY, TODAY), "2026-10-09");
  assert.equal(nextOccurrence({ unit: "week", every: 1, weekday: 0 }, TODAY, TODAY), "2026-10-04", "Sunday (0) is a real weekday");
});

test("nextOccurrence treats a missing or bad `every` as 1", () => {
  assert.equal(nextOccurrence({ unit: "day" }, TODAY, TODAY), "2026-09-30");
  assert.equal(nextOccurrence({ unit: "day", every: 0 }, TODAY, TODAY), "2026-09-30");
  assert.equal(nextOccurrence({ unit: "day", every: "x" }, TODAY, TODAY), "2026-09-30");
});

test("firstOccurrence", () => {
  assert.equal(firstOccurrence({ unit: "day", every: 1 }, TODAY), TODAY);
  assert.equal(firstOccurrence({ unit: "week", every: 1, weekday: 2 }, TODAY), TODAY, "today when it's the right weekday");
  assert.equal(firstOccurrence({ unit: "week", every: 1, weekday: 5 }, TODAY), "2026-10-02");
  assert.equal(firstOccurrence({ unit: "week", every: 1, weekday: 0 }, TODAY), "2026-10-04");
});

test("describeRecurrence", () => {
  assert.equal(describeRecurrence(null), "");
  assert.equal(describeRecurrence({ unit: "day", every: 1 }), "Daily");
  assert.equal(describeRecurrence({ unit: "week", every: 1 }), "Weekly");
  assert.equal(describeRecurrence({ unit: "month", every: 1 }), "Monthly");
  assert.equal(describeRecurrence({ unit: "day", every: 3 }), "Every 3 days");
  assert.equal(describeRecurrence({ unit: "week", every: 1, weekday: 2 }), "Every Tue");
  assert.equal(describeRecurrence({ unit: "week", every: 2, weekday: 0 }), "Every 2 weeks on Sun");
});

test("parseRule accepts JSON strings or objects and rejects junk", () => {
  assert.deepEqual(parseRule('{"unit":"week","every":2}'), { unit: "week", every: 2 });
  assert.deepEqual(parseRule({ unit: "day", every: 1 }), { unit: "day", every: 1 });
  assert.equal(parseRule(null), null);
  assert.equal(parseRule(""), null);
  assert.equal(parseRule("not json"), null);
  assert.equal(parseRule('{"unit":"year","every":1}'), null);
  assert.equal(parseRule("null"), null);
});
