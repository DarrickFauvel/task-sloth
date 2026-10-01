import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, initDb } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { addComment, createTask, getTask, listComments } from "../src/services/tasks.js";
import { deleteComment, markCommentsSeen, restoreComment, tasksWithNewComments } from "../src/services/comments.js";
import { commentTime } from "../src/web/comments.js";

const dir = mkdtempSync(join(tmpdir(), "task-sloth-test-"));
const me = { id: "u1", householdId: "h1" };
const sam = { id: "u2", householdId: "h1" };

before(async () => {
  initDb({ url: `file:${join(dir, "test.db")}` });
  await migrate({ log: () => {} });
  const ts = new Date().toISOString();
  await db.batch([
    { sql: "INSERT INTO users (id, email, name, created_at) VALUES ('u1', 'a@example.com', 'Alice', ?), ('u2', 's@example.com', 'Sam', ?)", args: [ts, ts] },
    { sql: "INSERT INTO households (id, name, created_at) VALUES ('h1', 'Home', ?)", args: [ts] },
    { sql: "INSERT INTO memberships (household_id, user_id, joined_at) VALUES ('h1', 'u1', ?), ('h1', 'u2', ?)", args: [ts, ts] },
  ]);
});
beforeEach(() => db.batch([{ sql: "DELETE FROM comment_reads" }, { sql: "DELETE FROM comments" }, { sql: "DELETE FROM activity" }, { sql: "DELETE FROM tasks" }]));
after(() => rmSync(dir, { recursive: true, force: true }));

test("comments list oldest first and count on the task; a delete hides one until it's restored", async () => {
  const task = await createTask(me, { title: "paint" });
  const first = await addComment(sam, task, "Got the blue one");
  await addComment(me, task, "Thanks!");
  assert.deepEqual((await listComments(task)).map((c) => c.body), ["Got the blue one", "Thanks!"]);
  assert.equal(Number((await getTask("h1", task)).comment_count), 2);
  await assert.rejects(addComment(me, task, "   "), /empty/);

  await assert.rejects(deleteComment(me, first), /only delete your own/);
  await deleteComment(sam, first);
  assert.deepEqual((await listComments(task)).map((c) => c.body), ["Thanks!"]);
  assert.equal(Number((await getTask("h1", task)).comment_count), 1);
  await restoreComment(sam, first);
  assert.equal((await listComments(task)).length, 2);
});

test("a comment from someone else is new until you've seen the task", async () => {
  const task = await createTask(me, { title: "paint" });
  await addComment(me, task, "note to self");
  assert.equal((await tasksWithNewComments("h1", "u1")).has(task), false, "your own comments aren't new to you");
  await addComment(sam, task, "Got the blue one");
  assert.equal((await tasksWithNewComments("h1", "u1")).has(task), true);
  assert.equal((await tasksWithNewComments("h1", "u2")).has(task), true, "Sam hasn't seen yours");
  await markCommentsSeen("u1", task);
  assert.equal((await tasksWithNewComments("h1", "u1")).has(task), false);
  await new Promise((r) => setTimeout(r, 5));
  await addComment(sam, task, "Receipt's in photos");
  assert.equal((await tasksWithNewComments("h1", "u1")).has(task), true, "a newer one is new again");
});

test("commentTime says when, the way people do", () => {
  const ctx = { timeZone: "UTC", today: "2026-10-01" };
  assert.equal(commentTime("2026-10-01T15:15:00Z", ctx), "Today 3:15 PM");
  assert.equal(commentTime("2026-09-30T09:02:00Z", ctx), "Yesterday 9:02 AM");
  assert.equal(commentTime("2026-09-28T09:40:00Z", ctx), "Mon 9:40 AM");
  assert.equal(commentTime("2026-09-10T09:40:00Z", ctx), "Sep 10");
});
