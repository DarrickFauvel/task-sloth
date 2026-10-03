import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config.js";
import { db, initDb } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { addSuggestions, askCheckin, buildRequest, getGoalProject, listSuggestions, openCheckin, startProject, THINKING_TIMEOUT_MS } from "../src/services/coach.js";
import {
  askAboutSuggestion, askAboutTask, declineProposal, getStepQuestion, listStepQuestions, retryQuestion, stepNotes, useProposal,
} from "../src/services/step-questions.js";
import { createTask, getTask, listTasks } from "../src/services/tasks.js";
import { createProject } from "../src/services/projects.js";
import { projectPageView } from "../src/web/project-page.js";
import { taskAskView } from "../src/web/step-questions.js";

const dir = mkdtempSync(join(tmpdir(), "task-sloth-test-"));
const actor = { id: "u1", householdId: "h1" };
const stranger = { id: "u2", householdId: "h2" };
const TODAY = "2026-10-03";
const realFetch = globalThis.fetch;

/** What the stubbed Claude answers next: an object (sent as JSON text), or a function making the whole response. */
let reply;
let asked;

const PLAN = {
  name: "Tidy office",
  emoji: "🧹",
  noticed: "",
  how_to_start: "Start with the desk.",
  steps: [
    { title: "Clear the desk", notes: "", later: false },
    { title: "Take old papers to the tip", notes: "Load the car.", later: false },
  ],
};
const KEEP = { answer: "Start from the left.", change: "keep", title: "", notes: "", substeps: [] };

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
  config.anthropic.apiKey = "test-key";
});

beforeEach(() => {
  reply = PLAN;
  asked = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
    if (url.startsWith("https://api.anthropic.com/")) {
      const body = JSON.parse(input instanceof Request ? await input.text() : init.body);
      asked.push(body);
      if (typeof reply === "function") return reply();
      return json({ id: "msg", type: "message", role: "assistant", model: body.model, stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: "text", text: JSON.stringify(reply) }] });
    }
    return json({ result: "ok" });
  };
});

after(() => {
  globalThis.fetch = realFetch;
  config.anthropic.apiKey = "";
  rmSync(dir, { recursive: true, force: true });
});

const textOf = (request) => request.messages[0].content.filter((b) => b.type === "text").map((b) => b.text).join("\n");

/** A goal project with its plan made: two suggestions waiting. */
async function plannedProject(goal = "Clean the office") {
  const projectId = await startProject(actor, { goal, notes: "" });
  const { id } = await db.get("SELECT id FROM project_checkins WHERE project_id = ? AND kind = 'start'", [projectId]);
  await (await askCheckin(actor, id, { today: TODAY })).done;
  asked = [];
  const [desk, tip] = await listSuggestions("h1", projectId);
  return { projectId, desk, tip };
}

test("asking about a suggestion that doesn't fit rewords it; the question and answer stay with it", async () => {
  const { projectId, tip } = await plannedProject();
  reply = { answer: "Then book a bulky-waste pickup instead.", change: "reword", title: "Book a bulky-waste pickup", notes: "The council collects for free.", substeps: ["ignored"] };
  const { done } = await askAboutSuggestion(actor, tip.id, { question: "  We don't have a car  " });
  assert.equal((await listStepQuestions("h1", { suggestionId: tip.id }))[0].status, "thinking");
  await done;

  const text = textOf(asked[0]);
  assert.match(text, /Goal: Clean the office/);
  assert.match(text, /The step: Take old papers to the tip/);
  assert.match(text, /Its notes: Load the car\./);
  assert.match(text, /- \[suggested\] Clear the desk/);
  assert.match(text, /What they say now: We don't have a car/);
  assert.equal(asked[0].output_config.format.type, "json_schema");

  const s = (await listSuggestions("h1", projectId)).find((x) => x.id === tip.id);
  assert.equal(s.title, "Book a bulky-waste pickup");
  assert.equal(s.notes, "The council collects for free.");
  assert.deepEqual(JSON.parse(s.checklist), [], "only break_down adds sub-steps");
  const [q] = await listStepQuestions("h1", { suggestionId: tip.id });
  assert.equal(q.status, "ready");
  assert.equal(q.proposal, null, "a suggestion just changes; nothing to offer");

  const view = await projectPageView({ householdId: "h1", projectId, membership: { members: [] }, today: TODAY });
  const row = view.suggestions.steps.find((x) => x.id === tip.id);
  assert.equal(row.updated, true);
  assert.deepEqual(row.questions.map((x) => [x.question, x.answer]), [["We don't have a car", "Then book a bulky-waste pickup instead."]]);
});

test("a plain question leaves the step alone; asking again sends the earlier answer along", async () => {
  const { projectId, desk } = await plannedProject();
  reply = KEEP;
  await (await askAboutSuggestion(actor, desk.id, { question: "Where do I start?" })).done;
  assert.equal((await listSuggestions("h1", projectId)).find((x) => x.id === desk.id).title, "Clear the desk");

  await (await askAboutSuggestion(actor, desk.id, { question: "And then?" })).done;
  assert.match(textOf(asked[1]), /Earlier about this step:\n- They said “Where do I start\?”; you answered: Start from the left\./);
});

test("a suggestion broken into sub-steps becomes a task with that checklist, and its questions follow it", async () => {
  const { projectId, desk } = await plannedProject();
  reply = { answer: "Do it in three goes.", change: "break_down", title: "Clear the desk", notes: "", substeps: ["Bin the rubbish", "  ", "File the papers", "Wipe it down"] };
  await (await askAboutSuggestion(actor, desk.id, { question: "How do I do this?" })).done;
  assert.deepEqual(JSON.parse((await listSuggestions("h1", projectId)).find((x) => x.id === desk.id).checklist), ["Bin the rubbish", "File the papers", "Wipe it down"]);

  await addSuggestions(actor, projectId, [desk.id], { today: TODAY });
  const task = (await listTasks("h1", { projectId })).find((t) => t.title === "Clear the desk");
  const items = await db.all("SELECT text FROM checklist_items WHERE task_id = ? ORDER BY sort_order", [task.id]);
  assert.deepEqual(items.map((i) => i.text), ["Bin the rubbish", "File the papers", "Wipe it down"]);

  const ask = await taskAskView("h1", await getTask("h1", task.id), { enabled: true });
  assert.deepEqual(ask.questions.map((q) => q.question), ["How do I do this?"]);
  assert.equal(ask.offer, null);
});

test("asking about a project task offers Claude's change, to use or turn down", async () => {
  const { projectId, desk, tip } = await plannedProject();
  await addSuggestions(actor, projectId, [desk.id, tip.id], { today: TODAY });
  const task = (await listTasks("h1", { projectId })).find((t) => t.title === "Take old papers to the tip");

  reply = { answer: "Split it up.", change: "break_down", title: "Get old papers recycled", notes: "No car needed.", substeps: ["Bag the papers", "Book a pickup"] };
  await (await askAboutTask(actor, task.id, { question: "We don't have a car" })).done;
  assert.match(textOf(asked[0]), /- \[to do\] Clear the desk/);
  assert.equal((await getTask("h1", task.id)).title, "Take old papers to the tip", "a task only changes when someone says so");

  const view = await taskAskView("h1", await getTask("h1", task.id), { enabled: true });
  assert.equal(view.offer.title, "Get old papers recycled");
  assert.deepEqual(view.offer.substeps, ["Bag the papers", "Book a pickup"]);

  await useProposal(actor, view.offer.id);
  const updated = await getTask("h1", task.id);
  assert.equal(updated.title, "Get old papers recycled");
  assert.equal(updated.notes, "No car needed.");
  assert.equal(Number(updated.item_count), 2);
  assert.equal((await getStepQuestion("h1", view.offer.id)).proposal, "used");
  await assert.rejects(useProposal(actor, view.offer.id), { status: 400 });

  reply = { answer: "Maybe call it this.", change: "reword", title: "Recycle the papers", notes: "", substeps: [] };
  const { id } = await askAboutTask(actor, task.id, { question: "Shorter name?" }).then(async (r) => (await r.done, r));
  await declineProposal(actor, id);
  assert.equal((await getTask("h1", task.id)).title, "Get old papers recycled");
  assert.equal((await taskAskView("h1", await getTask("h1", task.id), { enabled: true })).offer, null);
});

test("only tasks in a goal project can be asked about, and only by their household", async () => {
  const { projectId, desk } = await plannedProject();
  const plainProject = await createProject("h1", { name: "Errands" });
  const errand = await createTask(actor, { title: "Post a parcel", projectId: plainProject });
  const loose = await createTask(actor, { title: "Water plants" });
  await assert.rejects(askAboutTask(actor, errand, { question: "How?" }), { status: 404 });
  await assert.rejects(askAboutTask(actor, loose, { question: "How?" }), { status: 404 });
  assert.equal(await taskAskView("h1", await getTask("h1", loose), { enabled: true }), null);
  await assert.rejects(askAboutSuggestion(stranger, desk.id, { question: "How?" }), { status: 404 });
  await assert.rejects(askAboutSuggestion(actor, desk.id, { question: "   " }), { status: 400 });

  await addSuggestions(actor, projectId, [desk.id], { today: TODAY });
  await assert.rejects(askAboutSuggestion(actor, desk.id, { question: "How?" }), { status: 400 });
  const task = (await listTasks("h1", { projectId }))[0];
  await assert.rejects(askAboutTask(stranger, task.id, { question: "How?" }), { status: 404 });
  assert.equal(asked.length, 0);
});

test("a failed answer can be asked again; one that never came counts as failed after a while", async () => {
  const { desk } = await plannedProject();
  reply = () => new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "busy" } }), { status: 529 });
  const { id, done } = await askAboutSuggestion(actor, desk.id, { question: "How?" });
  await done;
  const failed = await getStepQuestion("h1", id);
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /couldn't answer/);

  reply = KEEP;
  await (await retryQuestion(actor, id)).done;
  assert.equal((await getStepQuestion("h1", id)).status, "ready");
  await assert.rejects(retryQuestion(actor, id), { status: 400 });

  const old = new Date(Date.now() - THINKING_TIMEOUT_MS - 1000).toISOString();
  await db.run("UPDATE step_questions SET status = 'thinking', asked_at = ? WHERE id = ?", [old, id]);
  const project = await getGoalProject("h1", desk.project_id);
  const view = await projectPageView({ householdId: "h1", projectId: project.id, membership: { members: [] }, today: TODAY });
  assert.equal(view.suggestions.steps.find((s) => s.id === desk.id).questions[0].status, "failed");
  await (await retryQuestion(actor, id)).done;
  assert.equal((await getStepQuestion("h1", id)).status, "ready");
});

test("what people told Claude about steps goes along with the next check-in", async () => {
  const { projectId, tip } = await plannedProject();
  reply = { answer: "Then book a pickup.", change: "reword", title: "Book a pickup", notes: "", substeps: [] };
  await (await askAboutSuggestion(actor, tip.id, { question: "We don't have a car" })).done;
  assert.deepEqual(await stepNotes("h1", projectId), ["- “Book a pickup”: they said “We don't have a car”; you answered: Then book a pickup."]);

  const checkinId = await openCheckin(actor, projectId);
  const project = await getGoalProject("h1", projectId);
  const checkin = await db.get("SELECT * FROM project_checkins WHERE id = ?", [checkinId]);
  const request = await buildRequest("h1", project, checkin, TODAY);
  assert.match(request.content[0].text, /What they've told you about single steps \(keep it in mind\):\n- “Book a pickup”: they said “We don't have a car”/);
});
