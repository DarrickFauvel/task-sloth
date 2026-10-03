import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config.js";
import { db, initDb } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import {
  addCheckinPhoto, addSuggestions, askCheckin, discardCheckin, dismissSuggestion, getCheckin, getGoalProject, isStale,
  listGoalProjects, listSuggestions, openCheckin, removeCheckinPhoto, startProject, upkeepRule,
} from "../src/services/coach.js";
import { createTask, getTask, listTasks, setDone } from "../src/services/tasks.js";
import { projectPageView } from "../src/web/project-page.js";
import { createProject } from "../src/services/projects.js";
import { projectLink } from "../src/web/task-list.js";

const dir = mkdtempSync(join(tmpdir(), "task-sloth-test-"));
const actor = { id: "u1", householdId: "h1" };
const stranger = { id: "u2", householdId: "h2" };
const TODAY = "2026-10-03"; // a Saturday
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const realFetch = globalThis.fetch;

/** What the stubbed Claude answers next: an object (sent as JSON text), or a function making the whole response. */
let reply;
/** Bodies of the requests Claude got. */
let asked;
let uploads;

const PLAN = {
  name: "Tidy office",
  emoji: "🧹",
  noticed: "Papers cover the desk.",
  how_to_start: "Start with the desk.",
  steps: [
    { title: "Clear the desk", notes: "", later: false },
    { title: "Sort the papers", notes: "Keep, shred, recycle.", later: false },
    { title: "Hang a pinboard", notes: "", later: true },
  ],
};

before(async () => {
  initDb({ url: `file:${join(dir, "test.db")}` });
  await migrate({ log: () => {} });
  const ts = new Date().toISOString();
  await db.batch([
    { sql: "INSERT INTO users (id, email, name, created_at) VALUES ('u1', 'a@example.com', 'Alice', ?)", args: [ts] },
    { sql: "INSERT INTO users (id, email, name, created_at) VALUES ('u2', 'b@example.com', 'Bob', ?)", args: [ts] },
    { sql: "INSERT INTO households (id, name, created_at) VALUES ('h1', 'Home', ?)", args: [ts] },
    { sql: "INSERT INTO households (id, name, created_at) VALUES ('h2', 'Other', ?)", args: [ts] },
    { sql: "INSERT INTO memberships (household_id, user_id, joined_at) VALUES ('h1', 'u1', ?)", args: [ts] },
    { sql: "INSERT INTO memberships (household_id, user_id, joined_at) VALUES ('h2', 'u2', ?)", args: [ts] },
  ]);
  config.cloudinary = { cloudName: "demo", apiKey: "key", apiSecret: "secret" };
  config.anthropic.apiKey = "test-key";
});

beforeEach(() => {
  reply = PLAN;
  asked = [];
  uploads = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
    if (url.startsWith("https://api.anthropic.com/")) {
      const body = JSON.parse(input instanceof Request ? await input.text() : init.body);
      asked.push(body);
      if (typeof reply === "function") return reply();
      if (reply?.stop_reason) return json({ id: "msg", type: "message", role: "assistant", model: body.model, content: [], usage: {}, ...reply });
      return json({ id: "msg", type: "message", role: "assistant", model: body.model, stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: "text", text: JSON.stringify(reply) }] });
    }
    if (url.endsWith("/upload")) return json({ public_id: `task-sloth/h1/c${++uploads}`, width: 800, height: 600 });
    return json({ result: "ok" });
  };
});

after(() => {
  globalThis.fetch = realFetch;
  config.cloudinary = null;
  config.anthropic.apiKey = "";
  rmSync(dir, { recursive: true, force: true });
});

const startCheckin = async (projectId) => (await db.get("SELECT id FROM project_checkins WHERE project_id = ? AND kind = 'start'", [projectId])).id;

async function plannedProject(goal = "Clean the office") {
  const projectId = await startProject(actor, { goal, notes: "One afternoon" });
  const checkinId = await startCheckin(projectId);
  await (await askCheckin(actor, checkinId, { today: TODAY })).done;
  return { projectId, checkinId };
}

test("a goal becomes a project whose plan names it and suggests steps", async () => {
  const projectId = await startProject(actor, { goal: "Clean the office", notes: "One afternoon" });
  const checkinId = await startCheckin(projectId);
  await addCheckinPhoto(actor, checkinId, JPEG);
  const { done } = await askCheckin(actor, checkinId, { today: TODAY });
  assert.equal((await getCheckin("h1", checkinId)).status, "thinking");
  await done;

  const project = await getGoalProject("h1", projectId);
  assert.equal(project.name, "Tidy office");
  assert.equal(project.emoji, "🧹");
  assert.equal((await getCheckin("h1", checkinId)).status, "ready");

  const [request] = asked;
  assert.equal(request.model, "claude-opus-5-5");
  assert.equal(request.fallbacks, "default");
  assert.equal(request.output_config.format.type, "json_schema");
  const text = request.messages[0].content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  assert.match(text, /Goal: Clean the office/);
  assert.match(text, /One afternoon/);
  const images = request.messages[0].content.filter((b) => b.type === "image");
  assert.equal(images.length, 1);
  assert.match(images[0].source.url, /^https:\/\/res\.cloudinary\.com\/demo\/image\/authenticated\/s--.{8}--\/c_limit,w_1568,h_1568,f_jpg,q_auto\/task-sloth\/h1\/c1$/);

  const suggestions = await listSuggestions("h1", projectId);
  assert.deepEqual(suggestions.map((s) => [s.title, s.list]), [["Clear the desk", "todo"], ["Sort the papers", "todo"], ["Hang a pinboard", "someday"]]);
});

test("picked suggestions become tasks in the project; dismissed ones go away", async () => {
  const { projectId } = await plannedProject("Clear the garage");
  const [first, second, third] = await listSuggestions("h1", projectId);
  await dismissSuggestion(actor, third.id);
  assert.equal(await addSuggestions(actor, projectId, [first.id, second.id, "nope"], { today: TODAY }), 2);

  const tasks = await listTasks("h1", { projectId });
  assert.deepEqual(tasks.map((t) => t.title).sort(), ["Clear the desk", "Sort the papers"]);
  assert.equal(tasks.find((t) => t.title === "Sort the papers").notes, "Keep, shred, recycle.");
  assert.equal((await listSuggestions("h1", projectId)).length, 0);
});

test("a check-in sends the start photos, today's photos and the task list, and its new steps wait to be added", async () => {
  const projectId = await startProject(actor, { goal: "Tidy the shed", notes: "" });
  const start = await startCheckin(projectId);
  await addCheckinPhoto(actor, start, JPEG);
  await (await askCheckin(actor, start, { today: TODAY })).done;
  await addSuggestions(actor, projectId, (await listSuggestions("h1", projectId)).map((s) => s.id), { today: TODAY });
  const [task] = await listTasks("h1", { projectId, list: "todo" });
  await setDone(actor, task.id, true);

  reply = { what_changed: "The desk is clear.", encouragement: "Good going.", goal_reached: false, steps: [{ title: "Dust the shelves", notes: "", later: false }] };
  const checkinId = await openCheckin(actor, projectId);
  assert.equal(await openCheckin(actor, projectId), checkinId, "one draft at a time");
  await addCheckinPhoto(actor, checkinId, JPEG);
  await (await askCheckin(actor, checkinId, { note: "Did the desk", today: TODAY })).done;

  const content = asked.at(-1).messages[0].content;
  const text = content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  assert.match(text, /\[done\] Clear the desk/);
  assert.match(text, /\[to do\] Sort the papers/);
  assert.match(text, /Did the desk/);
  assert.match(text, /Earlier check-ins:\n- \d{4}-\d\d-\d\d: plan made/);
  assert.deepEqual(content.filter((b) => b.type === "image").map((b) => b.source.url.split("/").at(-1)), ["c1", "c2"], "the start photo, then today's");
  assert.deepEqual((await listSuggestions("h1", projectId)).map((s) => s.title), ["Dust the shelves"]);
});

test("upkeep suggestions become repeating tasks", async () => {
  const { projectId } = await plannedProject("Keep the hall tidy");
  reply = {
    intro: "A little each week.",
    tasks: [
      { title: "Put shoes away", notes: "", every: 1, unit: "week", weekday: "friday" },
      { title: "Wipe the mirror", notes: "", every: 2, unit: "week", weekday: "any" },
      { title: "Check the coats", notes: "", every: 1, unit: "fortnight", weekday: "any" },
    ],
  };
  const checkinId = await openCheckin(actor, projectId, "upkeep");
  await (await askCheckin(actor, checkinId, { today: TODAY })).done;
  const upkeep = (await listSuggestions("h1", projectId)).filter((s) => s.kind === "upkeep");
  assert.deepEqual(upkeep.map((s) => s.title), ["Put shoes away", "Wipe the mirror"], "a rule that doesn't parse is dropped");

  await addSuggestions(actor, projectId, upkeep.map((s) => s.id), { today: TODAY });
  const shoes = (await listTasks("h1", { projectId })).find((t) => t.title === "Put shoes away");
  assert.deepEqual(JSON.parse(shoes.recurrence), { unit: "week", every: 1, weekday: 5 });
  assert.equal(shoes.due_date, "2026-10-09", "the next Friday");
});

test("upkeepRule clamps and validates", () => {
  assert.deepEqual(upkeepRule({ every: 0, unit: "day", weekday: "any" }), { unit: "day", every: 1 });
  assert.deepEqual(upkeepRule({ every: 99, unit: "month", weekday: "monday" }), { unit: "month", every: 12 });
  assert.equal(upkeepRule({ every: 1, unit: "year", weekday: "any" }), null);
});

test("a refusal or an unusable answer marks the check-in failed, and it can be asked again", async () => {
  const projectId = await startProject(actor, { goal: "Paint the fence", notes: "" });
  const checkinId = await startCheckin(projectId);

  reply = { stop_reason: "refusal", stop_details: { type: "refusal", category: null, explanation: "" } };
  await (await askCheckin(actor, checkinId, { today: TODAY })).done;
  let checkin = await getCheckin("h1", checkinId);
  assert.equal(checkin.status, "failed");
  assert.match(checkin.error, /couldn't help/);

  reply = () => new Response("not json", { status: 200, headers: { "Content-Type": "application/json" } });
  await (await askCheckin(actor, checkinId, { today: TODAY })).done;
  checkin = await getCheckin("h1", checkinId);
  assert.equal(checkin.status, "failed");

  reply = () => new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "busy" } }), { status: 529, headers: { "Content-Type": "application/json", "retry-after-ms": "1" } });
  await (await askCheckin(actor, checkinId, { today: TODAY })).done;
  checkin = await getCheckin("h1", checkinId);
  assert.match(checkin.error, /couldn't answer just now/);

  reply = PLAN;
  await (await askCheckin(actor, checkinId, { today: TODAY })).done;
  assert.equal((await getCheckin("h1", checkinId)).status, "ready");
  await assert.rejects(askCheckin(actor, checkinId, { today: TODAY }), /already has/);
});

test("a check-in left thinking too long counts as stale", () => {
  const asked_at = new Date(Date.now() - 6 * 60_000).toISOString();
  assert.equal(isStale({ status: "thinking", asked_at }), true);
  assert.equal(isStale({ status: "thinking", asked_at: new Date().toISOString() }), false);
  assert.equal(isStale({ status: "ready", asked_at }), false);
});

test("photos: up to four, removable until Claude has them, and a dropped draft takes its photos along", async () => {
  const { projectId } = await plannedProject("Sort the toys");
  const checkinId = await openCheckin(actor, projectId);
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push(await addCheckinPhoto(actor, checkinId, JPEG));
  await assert.rejects(addCheckinPhoto(actor, checkinId, JPEG), /up to 4/);
  await removeCheckinPhoto(actor, ids[0]);
  await discardCheckin(actor, checkinId);
  await assert.rejects(getCheckin("h1", checkinId), /not found/);
  const { n } = await db.get("SELECT COUNT(*) AS n FROM checkin_photos WHERE checkin_id = ?", [checkinId]);
  assert.equal(Number(n), 0);
});

test("another household can't see or touch a project, check-in, photo or suggestion", async () => {
  const { projectId, checkinId } = await plannedProject("Wash the car");
  const [s] = await listSuggestions("h1", projectId);
  await assert.rejects(getGoalProject("h2", projectId), /not found/);
  await assert.rejects(openCheckin(stranger, projectId), /not found/);
  await assert.rejects(askCheckin(stranger, checkinId, { today: TODAY }), /not found/);
  await assert.rejects(addCheckinPhoto(stranger, checkinId, JPEG), /not found/);
  await assert.rejects(dismissSuggestion(stranger, s.id), /not found/);
  await assert.rejects(addSuggestions(stranger, projectId, [s.id], { today: TODAY }), /not found/);
  assert.equal((await listGoalProjects("h2")).length, 0);
});

test("the project page shows the plan, the suggestions, progress and the draft", async () => {
  const { projectId } = await plannedProject("Clean the attic");
  const membership = { household: { id: "h1" }, members: [{ id: "u1", name: "Alice", color: "#6d5dfc" }] };
  let view = await projectPageView({ householdId: "h1", projectId, membership, today: TODAY });
  assert.equal(view.plan.how_to_start, "Start with the desk.");
  assert.equal(view.suggestions.steps.length, 3);
  assert.equal(view.draft, null);
  assert.deepEqual(view.progress, { done: 0, total: 0, line: "" });

  await addSuggestions(actor, projectId, view.suggestions.steps.map((s) => s.id), { today: TODAY });
  await openCheckin(actor, projectId);
  view = await projectPageView({ householdId: "h1", projectId, membership, today: TODAY });
  assert.deepEqual(view.progress, { done: 0, total: 3, line: "Every project starts with one small step." });
  assert.equal(view.suggestions.steps.length, 0);
  assert.equal(view.draft.kind, "checkin");
});

test("a project chip opens the project page for a goal project, and the narrowed list otherwise", async () => {
  const { projectId } = await plannedProject("Fix the gate");
  const plain = await createProject("h1", { name: "Birthday" });
  const goalTask = await getTask("h1", await createTask(actor, { title: "Buy a hinge", projectId }));
  const plainTask = await getTask("h1", await createTask(actor, { title: "Order cake", projectId: plain }));

  assert.equal(projectLink(goalTask).href, `/projects/${projectId}`);
  assert.equal(projectLink(plainTask).href, `/?view=all&project=${plain}`);
  assert.equal(projectLink({ project_id: null }), null);

  config.anthropic.apiKey = "";
  assert.equal(projectLink(goalTask).href, `/?view=all&project=${projectId}`, "no project pages without Claude");
  config.anthropic.apiKey = "test-key";
});
