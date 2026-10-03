import { test } from "node:test";
import assert from "node:assert/strict";
import { finishedLine, greeting, milestoneLine, pick, progressLine, taskNudge } from "../src/web/encouragement.js";

const TODAY = "2026-10-03";

test("pick is stable for a seed and stays in range", () => {
  const lines = ["a", "b", "c"];
  assert.equal(pick(lines, "task-1"), pick(lines, "task-1"));
  const seen = new Set(Array.from({ length: 50 }, (_, i) => pick(lines, `t${i}`)));
  assert.deepEqual([...seen].sort(), lines, "every line gets used");
});

test("finishedLine: the first of the day, every fifth, and otherwise a cheer", () => {
  assert.match(finishedLine({ taskId: "x", doneToday: 1 }), /first/i);
  assert.match(finishedLine({ taskId: "x", doneToday: 10 }), /10/);
  const line = finishedLine({ taskId: "x", doneToday: 3 });
  assert.ok(line && !/\d/.test(line));
  assert.equal(finishedLine({ taskId: "x", doneToday: 3 }), line, "same task, same words");
});

test("milestoneLine: first step, halfway, one left, all done; nothing in between or for tiny projects", () => {
  const p = (done, total) => milestoneLine({ name: "🧹 Office", done, total });
  assert.match(p(1, 6), /First step on 🧹 Office/);
  assert.equal(p(2, 6), null);
  assert.match(p(3, 6), /Halfway/);
  assert.equal(p(4, 6), null);
  assert.match(p(5, 6), /one left/);
  assert.match(p(6, 6), /all done/);
  assert.match(p(3, 5), /Halfway/, "odd totals: the first tick at or past half");
  assert.equal(p(4, 5) && /Halfway/.test(p(4, 5)), false);
  assert.equal(p(1, 2), null, "two tasks: only all done counts");
  assert.match(p(2, 2), /all done/);
  assert.equal(p(1, 1), null, "a one-task project isn't a milestone");
  assert.equal(p(0, 0), null);
});

test("progressLine follows the bar", () => {
  assert.equal(progressLine({ done: 0, total: 0 }), "");
  assert.match(progressLine({ done: 0, total: 4 }), /one small step/);
  assert.match(progressLine({ done: 1, total: 4 }), /good start/);
  assert.match(progressLine({ done: 2, total: 4 }), /halfway/);
  assert.match(progressLine({ done: 3, total: 4 }), /one to go/);
  assert.match(progressLine({ done: 4, total: 4 }), /All done/);
});

test("taskNudge: overdue, waiting a week, sitting three weeks; never for done or fresh tasks", () => {
  const open = { status: "open", list: "todo", created_at: "2026-10-01T10:00:00Z" };
  assert.match(taskNudge({ ...open, due_date: "2026-10-02" }, TODAY), /slipped past yesterday/);
  assert.match(taskNudge({ ...open, due_date: "2026-09-28" }, TODAY), /5 days past/);
  assert.equal(taskNudge({ ...open, due_date: TODAY }, TODAY), null, "due today isn't overdue by a day");
  assert.equal(taskNudge({ ...open, due_date: "2026-09-28", status: "done" }, TODAY), null);
  assert.match(taskNudge({ ...open, list: "waiting", waiting_on: "Sam", waiting_since: "2026-09-25" }, TODAY), /Waiting on Sam for 8 days/);
  assert.equal(taskNudge({ ...open, list: "waiting", waiting_on: "Sam", waiting_since: "2026-09-30" }, TODAY), null);
  assert.match(taskNudge({ ...open, created_at: "2026-09-10T10:00:00Z" }, TODAY), /on the list a while/);
  assert.equal(taskNudge(open, TODAY), null);
});

test("greeting: time of day, what's ahead, yesterday; no guilt", () => {
  const base = { name: "Darrick Fauvel", userId: "u1", today: TODAY };
  assert.match(greeting({ ...base, time: "08:15" }), /^(Morning|Good morning), Darrick\./);
  assert.match(greeting({ ...base, time: "14:00" }), /^(Afternoon|Hi again|Good afternoon)/);
  assert.match(greeting({ ...base, time: "19:30" }), /^(Evening|Good evening|Winding down)/);
  assert.match(greeting({ ...base, time: "23:30" }), /late|Still up/);
  assert.match(greeting({ ...base, time: "09:00", dueToday: 3 }), /3 things due today\. One at a time\./);
  assert.match(greeting({ ...base, time: "09:00", overdue: 2, dueToday: 3 }), /2 things slipped a little/);
  assert.match(greeting({ ...base, time: "09:00", doneYesterday: 4 }), /Yesterday you finished 4\. Nice going\./);
  assert.match(greeting({ ...base, time: "09:00", doneYesterday: 1 }), /finished one\./);
  assert.equal(greeting({ ...base, time: "09:00" }), greeting({ ...base, time: "10:30" }), "the same words all morning");
});
