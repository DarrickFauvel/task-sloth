import { test } from "node:test";
import assert from "node:assert/strict";
import { buildActivity, fieldWords } from "../src/web/activity-page.js";

const membersById = { u1: { id: "u1", name: "Alex Doe", color: "#555" }, u2: { id: "u2", name: "Sam Roe", color: "#777" } };
const ctx = { membersById, userId: "u1", timeZone: "UTC", today: "2026-10-01" };
// Newest first, like listActivity.
const row = (minute, verb, extra = {}) => ({
  verb, actor_id: "u1", task_id: "t1", task_title: "Paint", created_at: `2026-10-01T12:${String(minute).padStart(2, "0")}:00.000Z`, detail: {}, ...extra,
});
const edit = (minute, fields, extra) => row(minute, "updated", { detail: { fields }, ...extra });
const lines = (days) => days.flatMap((d) => d.entries.map((e) => [e.text, e.detail]));

test("fieldWords names the fields the way the form does", () => {
  assert.equal(fieldWords(["due_date"]), "date");
  assert.equal(fieldWords(["due_date", "list", "notes"]), "date, list and notes");
  assert.equal(fieldWords(["tags", "tags", "waiting_since"]), "tags");
  assert.equal(fieldWords(["title", "notes", "due_date", "due_time", "list"]), "name, notes, date and 2 more");
  assert.equal(fieldWords([]), "");
});

test("one line per person, task and day, its actions in order", () => {
  const days = buildActivity([row(50, "completed"), edit(40, ["list"]), edit(20, ["due_date"]), row(10, "created")], ctx);
  assert.deepEqual(lines(days), [["You added, edited and completed", "Changed: date and list"]]);
  assert.equal(days[0].entries[0].time, "12:50 PM");
});

test("people and tasks get their own lines", () => {
  const days = buildActivity([row(5, "created", { actor_id: "u2" }), row(4, "created", { task_id: "t2", task_title: "Bulbs" }), row(3, "completed")], ctx);
  assert.deepEqual(lines(days).map(([t]) => t), ["Sam added", "You added", "You completed"]);
});

test("minor changes are left out unless all", () => {
  const rows = [edit(9, ["notes", "tags"]), row(8, "checklist", { detail: { count: 3 } }), row(7, "recurred", { actor_id: null }), edit(6, ["notes", "due_date"])];
  assert.deepEqual(lines(buildActivity(rows, ctx)), [["You edited", "Changed: date"]]);
  const all = lines(buildActivity(rows, { ...ctx, all: true }));
  assert.deepEqual(all, [["You edited and added 3 items to", "Changed: notes, date and tags"], ["Next occurrence scheduled for", null]]);
});

test("a delete that was undone is left out, with its restore", () => {
  const rows = [row(9, "restored"), row(8, "deleted"), row(1, "created")];
  assert.deepEqual(lines(buildActivity(rows, ctx)), [["You added", null]]);
  assert.deepEqual(lines(buildActivity([row(8, "deleted"), row(1, "created")], ctx)), [["You added and deleted", null]]);
});

test("who picks whose rows: others (and nobody's), everyone, or one person", () => {
  const rows = [row(9, "created", { actor_id: "u2", task_id: "t2" }), row(8, "unblocked", { actor_id: null, task_id: "t3" }), row(7, "created")];
  assert.deepEqual(lines(buildActivity(rows, { ...ctx, who: "others" })).map(([t]) => t), ["Sam added", "Ready to go:"]);
  assert.equal(lines(buildActivity(rows, { ...ctx, who: "everyone" })).length, 3);
  assert.deepEqual(lines(buildActivity(rows, { ...ctx, who: "u1" })).map(([t]) => t), ["You added"]);
});

test("a comment shows its start under the line", () => {
  const days = buildActivity([row(9, "commented", { actor_id: "u2", detail: { excerpt: "Got the blue one" } })], ctx);
  assert.deepEqual(lines(days), [["Sam commented on", "“Got the blue one”"]]);
});
