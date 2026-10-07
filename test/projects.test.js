import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config.js";
import { db, initDb } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { listCheckins, setGoal, startProject } from "../src/services/coach.js";
import { createProject, getProject, listProjects, removeEmptyProjects, removeProject, updateProject } from "../src/services/projects.js";
import { createTask, getTask } from "../src/services/tasks.js";
import { projectPageView } from "../src/web/project-page.js";

const dir = mkdtempSync(join(tmpdir(), "task-sloth-test-"));
const actor = { id: "u1", householdId: "h1" };
const membership = { household: { id: "h1" }, members: [] };

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

after(() => {
  config.anthropic.apiKey = "";
  rmSync(dir, { recursive: true, force: true });
});

const names = async () => (await listProjects("h1")).map((p) => p.name);

test("a project can be renamed, but not to another open project's name", async () => {
  const id = await createProject("h1", { name: "Yard" });
  await createProject("h1", { name: "Attic" });
  await updateProject("h1", id, { name: "Garden", emoji: "🌻", color: "#3c7fa6" });
  const p = await getProject("h1", id);
  assert.deepEqual([p.name, p.emoji, p.color], ["Garden", "🌻", "#3c7fa6"]);
  await assert.rejects(updateProject("h1", id, { name: "attic" }), { status: 400 });
  // A color that isn't one of the forest colors keeps the old one.
  await updateProject("h1", id, { color: "red" });
  assert.equal((await getProject("h1", id)).color, "#3c7fa6");
});

test("removing a project keeps its open tasks on the lists, without it", async () => {
  const id = await createProject("h1", { name: "Kitchen" });
  const open = await createTask(actor, { title: "new tap", projectId: id, list: "todo" });
  const done = await createTask(actor, { title: "paint", projectId: id, list: "todo" });
  await db.run("UPDATE tasks SET status = 'done' WHERE id = ?", [done]);

  assert.equal((await removeProject("h1", id)).name, "Kitchen");
  assert.ok(!(await names()).includes("Kitchen"));
  assert.equal((await getTask("h1", open)).project_id, null);
  assert.equal((await getTask("h1", done)).project_id, id);
  // Typing #Kitchen again starts a new one.
  assert.notEqual(await createProject("h1", { name: "Kitchen" }), id);
});

test("removing empty projects leaves ones with tasks or a goal", async () => {
  const empty = await createProject("h1", { name: "Nothing here" });
  const busy = await createProject("h1", { name: "Busy" });
  await createTask(actor, { title: "something", projectId: busy, list: "todo" });
  config.anthropic.apiKey = "test-key";
  const planned = await startProject(actor, { goal: "Sort the shed" });

  const before = await names();
  const removed = await removeEmptyProjects("h1");
  const now = await names();
  assert.ok(removed >= 1);
  assert.ok(!now.includes("Nothing here"));
  assert.ok(now.includes("Busy"));
  assert.ok(now.includes((await getProject("h1", planned)).name));
  assert.equal(before.length - now.length, removed);
  assert.equal((await getProject("h1", empty)).archived, 1);
});

test("a #project can ask Claude for a plan, once", async () => {
  config.anthropic.apiKey = "test-key";
  const id = await createProject("h1", { name: "Garage" });
  await assert.rejects(setGoal(actor, id, { goal: "  " }), { status: 400 });
  await setGoal(actor, id, { goal: "Park the car in it again", notes: "Lots of boxes" });
  const p = await getProject("h1", id);
  assert.deepEqual([p.goal, p.goal_notes], ["Park the car in it again", "Lots of boxes"]);
  assert.deepEqual((await listCheckins("h1", id)).map((c) => [c.kind, c.status]), [["start", "draft"]]);
  await assert.rejects(setGoal(actor, id, { goal: "Again" }), { status: 400 });
});

test("every project has a page; Claude's part only with a goal and Claude on", async () => {
  const id = await createProject("h1", { name: "Weekly shop" });
  await createTask(actor, { title: "milk", projectId: id, list: "todo" });
  const view = (on) => {
    config.anthropic.apiKey = on ? "test-key" : "";
    return projectPageView({ householdId: "h1", projectId: id, membership, userId: "u1", today: "2026-10-06" });
  };

  const off = await view(false);
  assert.equal(off.planned, false);
  assert.equal(off.primary, null);
  assert.equal(off.hashName, "#Weekly-shop");
  assert.deepEqual(off.open.map((t) => t.title), ["milk"]);

  const on = await view(true);
  assert.equal(on.planned, false);
  assert.equal(on.primary, "plan"); // the "Ask Claude for a plan" card

  await setGoal(actor, id, { goal: "Never run out of milk" });
  const planned = await view(true);
  assert.equal(planned.planned, true);
  assert.equal(planned.start.kind, "start");
  assert.equal((await view(false)).planned, false);

  await removeProject("h1", id);
  await assert.rejects(view(true), { status: 404 });
});

test("a project can show a logo in place of its emoji", async () => {
  const id = await createProject("h1", { name: "eBay sales", emoji: "💸" });
  await updateProject("h1", id, { icon: "ebay" });
  assert.equal((await getProject("h1", id)).icon, "ebay");
  // Saving without a logo choice, or with one that isn't bundled, keeps it; "" (Emoji) clears it.
  await updateProject("h1", id, { name: "eBay" });
  await updateProject("h1", id, { icon: "made-up" });
  assert.equal((await getProject("h1", id)).icon, "ebay");

  const task = await getTask("h1", await createTask(actor, { title: "list the lamp", projectId: id, list: "todo" }));
  assert.equal(task.project_icon, "ebay");
  config.anthropic.apiKey = "";
  const view = await projectPageView({ householdId: "h1", projectId: id, membership, userId: "u1", today: "2026-10-06" });
  assert.equal(view.iconSrc, "/img/project-icons/ebay.svg");
  assert.equal(view.project.emoji, "💸");

  await updateProject("h1", id, { icon: "" });
  assert.equal((await getProject("h1", id)).icon, null);
});
