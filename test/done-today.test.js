import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, initDb } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { createTask, setDone } from "../src/services/tasks.js";
import { CHEER_MS, doneTodayMessage, doneTodayView, MAX_DOTS } from "../src/web/done-today.js";

const dir = mkdtempSync(join(tmpdir(), "task-sloth-test-"));
const actor = { id: "u1", householdId: "h1" };
const membership = { household: { id: "h1" }, members: [{ id: "u1", name: "Alice", color: "#6d5dfc" }] };
// 9am on Sep 30 in New York (UTC-4).
const NOW = Date.parse("2026-09-30T13:00:00Z");
const view = (timeZone = "America/New_York") => doneTodayView({ membership, timeZone, now: NOW });

before(async () => {
  initDb({ url: `file:${join(dir, "test.db")}` });
  await migrate({ log: () => {} });
  const ts = new Date().toISOString();
  await db.batch([
    { sql: "INSERT INTO users (id, email, name, created_at) VALUES ('u1', 'a@example.com', 'Alice', ?)", args: [ts] },
    { sql: "INSERT INTO households (id, name, created_at) VALUES ('h1', 'Home', ?)", args: [ts] },
    { sql: "INSERT INTO memberships (household_id, user_id, joined_at) VALUES ('h1', 'u1', ?)", args: [ts] },
  ]);
});

beforeEach(() => db.batch([{ sql: "DELETE FROM activity" }, { sql: "DELETE FROM tasks" }]));
after(() => rmSync(dir, { recursive: true, force: true }));

/** A task finished at `completedAt` (an ISO time), by `by`. */
async function finished(title, completedAt, by = "u1") {
  const id = await createTask(actor, { title, list: "todo" });
  await db.run("UPDATE tasks SET status = 'done', completed_at = ?, completed_by = ? WHERE id = ?", [completedAt, by, id]);
  return id;
}

test("counts what was finished since midnight in the viewer's time zone", async () => {
  await finished("breakfast dishes", "2026-09-30T12:30:00Z"); // 8:30am New York
  await finished("late-night laundry", "2026-09-30T03:30:00Z"); // 11:30pm Sep 29 in New York, Sep 30 in UTC
  await finished("last week", "2026-09-23T13:00:00Z");
  await createTask(actor, { title: "still open", list: "todo" });

  const ny = await view();
  assert.equal(ny.count, 1);
  assert.deepEqual(ny.dots.map((d) => d.label), ["Alice: breakfast dishes"]);
  assert.equal(ny.dots[0].color, "#6d5dfc");
  assert.equal((await view("UTC")).count, 2);
});

test("a reopened or deleted task stops counting", async () => {
  const id = await finished("reopened", "2026-09-30T12:00:00Z");
  const gone = await finished("deleted", "2026-09-30T12:10:00Z");
  await db.run("UPDATE tasks SET deleted_at = ? WHERE id = ?", ["2026-09-30T12:20:00Z", gone]);
  await setDone(actor, id, false);
  assert.equal((await view()).count, 0);
});

test("shows the newest dots, oldest first, and counts the rest", async () => {
  for (let i = 0; i < MAX_DOTS + 3; i++) await finished(`task ${i}`, new Date(Date.parse("2026-09-30T12:00:00Z") + i * 60_000).toISOString());
  const v = await view();
  assert.equal(v.count, MAX_DOTS + 3);
  assert.equal(v.dots.length, MAX_DOTS);
  assert.equal(v.more, 3);
  assert.equal(v.dots.at(-1).label, `Alice: task ${MAX_DOTS + 2}`);
  assert.equal(v.dots[0].label, "Alice: task 3");
});

test("a task finished from Google (no member) gets a plain dot", async () => {
  await finished("synced", "2026-09-30T12:00:00Z", null);
  const [dot] = (await view()).dots;
  assert.equal(dot.color, null);
  assert.equal(dot.label, "Someone: synced");
});

test("the message livens up as the count grows", () => {
  assert.deepEqual(doneTodayMessage(0), { emoji: "🦥", text: "Nothing done yet today. No rush." });
  assert.equal(doneTodayMessage(1).text, "1 done today");
  assert.equal(doneTodayMessage(3).emoji, "✨");
  assert.equal(doneTodayMessage(6).text, "6 done today. On a roll!");
  assert.equal(doneTodayMessage(12).emoji, "🏆");
});

test("the badge cheers only for a task finished moments ago", async () => {
  const id = await finished("just now", new Date(NOW - 2_000).toISOString());
  assert.deepEqual((await view()).cheer, { id, text: "First one today!" });
  await finished("a bit ago", new Date(NOW - 60_000).toISOString());
  assert.equal((await view()).cheer.text, "2 done today!", "the newest is still the one from 2 seconds ago");
  await db.run("UPDATE tasks SET completed_at = ? WHERE id = ?", [new Date(NOW - CHEER_MS - 1).toISOString(), id]);
  assert.equal((await view()).cheer, null);
});
