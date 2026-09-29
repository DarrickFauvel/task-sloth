import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQuickAdd } from "../public/js/lib/quick-add.js";

const TODAY = "2026-09-29"; // a Tuesday
const ctx = {
  today: TODAY,
  meId: "u-me",
  members: [{ id: "u-me", name: "Darrick" }, { id: "u-sam", name: "Samantha" }],
  projects: [{ id: "p-shop", name: "Weekly shop" }, { id: "p-bday", name: "Birthday" }],
};
const parse = (input) => parseQuickAdd(input, ctx);

test("plain text is just a title", () => {
  assert.deepEqual(parse("  water   the plants "), { title: "water the plants" });
});

test("the examples from the module header", () => {
  assert.deepEqual(parse("buy flowers fri @me #Birthday !high"), {
    title: "buy flowers", dueDate: "2026-10-02", assigneeId: "u-me", projectId: "p-bday", priority: 1,
  });
  assert.deepEqual(parse("take out trash every tue @sam"), {
    title: "take out trash", assigneeId: "u-sam", recurrence: { unit: "week", every: 1, weekday: 2 }, dueDate: TODAY,
  });
  assert.deepEqual(parse("dentist tomorrow at 3pm"), { title: "dentist", dueDate: "2026-09-30", dueTime: "15:00" });
});

test("@assignee", () => {
  assert.equal(parse("x @SAM").assigneeId, "u-sam", "case-insensitive prefix match");
  assert.equal(parse("x @anyone").assigneeId, null, "up for grabs");
  const unknown = parse("x @bob");
  assert.equal("assigneeId" in unknown, false);
  assert.equal(unknown.title, "x");
  assert.equal(parse("email bob@example.com").title, "email bob@example.com", "@ inside a word is not a mention");
});

test("#project matches existing projects loosely, otherwise names a new one", () => {
  assert.equal(parse("milk #weekly-shop").projectId, "p-shop");
  assert.equal(parse('milk #"weekly shop"').projectId, "p-shop");
  const fresh = parse("paint fence #garden_work");
  assert.equal(fresh.projectName, "Garden work");
  assert.equal(fresh.projectId, undefined);
});

test("!priority", () => {
  assert.equal(parse("x !!").priority, 1);
  assert.equal(parse("x !urgent").priority, 1);
  assert.equal(parse("x !low").priority, -1);
  assert.equal(parse("wow!").priority, undefined);
});

test("recurrence phrases", () => {
  assert.deepEqual(parse("x every 2 weeks on fri").recurrence, { unit: "week", every: 2, weekday: 5 });
  assert.deepEqual(parse("x every 3 days").recurrence, { unit: "day", every: 3 });
  assert.deepEqual(parse("x every month").recurrence, { unit: "month", every: 1 });
  assert.deepEqual(parse("x each week").recurrence, { unit: "week", every: 1 });
  assert.deepEqual(parse("x daily").recurrence, { unit: "day", every: 1 });
  assert.deepEqual(parse("x every sunday").recurrence, { unit: "week", every: 1, weekday: 0 });
});

test("recurring tasks get a first due date unless one is given", () => {
  assert.equal(parse("x weekly").dueDate, TODAY);
  assert.equal(parse("x every fri").dueDate, "2026-10-02");
  assert.equal(parse("x every month 10/15").dueDate, "2026-10-15");
});

test("times", () => {
  assert.equal(parse("x at 5pm").dueTime, "17:00");
  assert.equal(parse("x 5:30pm").dueTime, "17:30");
  assert.equal(parse("x 12am").dueTime, "00:00");
  assert.equal(parse("x 12pm").dueTime, "12:00");
  assert.equal(parse("x at 17:05").dueTime, "17:05");
  assert.equal(parse("call at 9am").title, "call");
});

test("relative dates", () => {
  assert.equal(parse("x today").dueDate, TODAY);
  assert.equal(parse("x tonight").dueDate, TODAY);
  assert.equal(parse("x tmrw").dueDate, "2026-09-30");
  assert.equal(parse("x in 3 days").dueDate, "2026-10-02");
  assert.equal(parse("x in 2 weeks").dueDate, "2026-10-13");
  assert.equal(parse("x next week").dueDate, "2026-10-05", "next Monday");
  assert.equal(parse("x this weekend").dueDate, "2026-10-03");
  assert.equal(parseQuickAdd("x weekend", { ...ctx, today: "2026-10-03" }).dueDate, "2026-10-03", "on Saturday it's today");
});

test("weekday names, full and abbreviated", () => {
  assert.equal(parse("x fri").dueDate, "2026-10-02");
  assert.equal(parse("x on Thursday").dueDate, "2026-10-01");
  assert.equal(parse("x wednesday").dueDate, "2026-09-30");
  assert.equal(parse("x next saturday").dueDate, "2026-10-03");
  assert.equal(parse("x tue").dueDate, "2026-10-06", "today's weekday means next week");
});

test("absolute dates roll into next year once passed", () => {
  assert.equal(parse("x 2026-12-25").dueDate, "2026-12-25");
  assert.equal(parse("x 10/15").dueDate, "2026-10-15");
  assert.equal(parse("x on 1/5").dueDate, "2027-01-05");
  assert.equal(parse("x oct 12th").dueDate, "2026-10-12");
  assert.equal(parse("x September 1").dueDate, "2027-09-01");
  assert.equal(parse("x Dec. 3").dueDate, "2026-12-03");
});

test("the first date wins and invalid dates are ignored", () => {
  assert.equal(parse("x tomorrow fri").dueDate, "2026-09-30");
  assert.equal(parse("x 2026-02-30").dueDate, undefined);
});

test("words that merely start with a month name are not dates", () => {
  const r = parse("decorate 5 rooms");
  assert.equal(r.dueDate, undefined);
  assert.equal(r.title, "decorate 5 rooms");
  assert.equal(parse("junk 3 bags").dueDate, undefined);
});
