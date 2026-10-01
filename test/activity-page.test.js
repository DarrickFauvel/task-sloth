import { test } from "node:test";
import assert from "node:assert/strict";
import { buildActivity, fieldWords } from "../src/web/activity-page.js";

const membersById = { u1: { id: "u1", name: "Alex Doe", color: "#555" }, u2: { id: "u2", name: "Sam Roe", color: "#777" } };
const ctx = { membersById, userId: "u1", timeZone: "UTC", today: "2026-10-01" };
// Newest first, like listActivity.
const row = (minute, verb, extra = {}) => ({
  verb, actor_id: "u1", task_id: "t1", task_title: "Paint", created_at: `2026-10-01T12:${String(minute).padStart(2, "0")}:00.000Z`, detail: {}, ...extra,
});
const lines = (days) => days.flatMap((d) => d.entries.map((e) => [e.text, e.detail]));

test("fieldWords names the fields the way the form does", () => {
  assert.equal(fieldWords(["due_date"]), "date");
  assert.equal(fieldWords(["due_date", "list", "notes"]), "date, list and notes");
  assert.equal(fieldWords(["tags", "tags", "waiting_since"]), "tags");
  assert.equal(fieldWords(["title", "notes", "due_date", "due_time", "list"]), "name, notes, date and 2 more");
  assert.equal(fieldWords([]), "");
});

test("a burst of edits is one line saying what changed", () => {
  const days = buildActivity([row(40, "updated", { detail: { fields: ["list"] } }), row(35, "updated", { detail: { fields: ["due_date"] } }),
    row(30, "updated", { detail: { fields: ["notes", "list"] } })], ctx);
  assert.deepEqual(lines(days), [["You edited", "Changed: list, date and notes"]]);
  assert.equal(days[0].entries[0].time, "12:40 PM");
});

test("edits right after adding fold into the added line", () => {
  const days = buildActivity([row(20, "updated", { detail: { fields: ["tags"] } }), row(10, "created")], ctx);
  assert.deepEqual(lines(days), [["You added", "Then changed: tags"]]);
});

test("edits far apart, by someone else, or around finishing stay separate", () => {
  const apart = buildActivity([row(59, "updated", { detail: { fields: ["notes"] } }), row(0, "updated", { detail: { fields: ["notes"] } })].map((r, i) =>
    i ? { ...r, created_at: "2026-10-01T11:00:00.000Z" } : r), ctx);
  assert.equal(lines(apart).length, 2);
  const others = buildActivity([row(5, "updated", { actor_id: "u2", detail: { fields: ["notes"] } }), row(4, "updated", { detail: { fields: ["notes"] } })], ctx);
  assert.deepEqual(lines(others).map(([t]) => t), ["Sam edited", "You edited"]);
  const done = buildActivity([row(9, "updated", { detail: { fields: ["notes"] } }), row(8, "completed"), row(7, "updated", { detail: { fields: ["notes"] } })], ctx);
  assert.deepEqual(lines(done).map(([t]) => t), ["You edited", "You completed", "You edited"]);
  const assigned = buildActivity([row(9, "updated", { detail: { fields: ["notes"] } }), row(8, "assigned", { detail: { to: "u2" } }),
    row(7, "updated", { detail: { fields: ["due_date"] } })], ctx);
  assert.deepEqual(lines(assigned), [["You edited", "Changed: notes and date"], ["You assigned to Sam", null]]);
});

test("who keeps one person's rows", () => {
  const days = buildActivity([row(5, "created", { actor_id: "u2", task_id: "t2" }), row(4, "created")], { ...ctx, who: "u2" });
  assert.deepEqual(lines(days), [["Sam added", null]]);
});
