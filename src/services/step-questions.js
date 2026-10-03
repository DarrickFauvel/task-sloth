import { db, newId, now } from "../db/client.js";
import { HttpError } from "../lib/http.js";
import { askForJson } from "../lib/claude.js";
import { changed } from "./changes.js";
import { getGoalProject, isStale, parseReply, SYSTEM } from "./coach.js";
import { getTask, itemInsert, listTasks, updateTask } from "./tasks.js";

// Asking Claude about one step of a project (src/services/coach.js): "how do I do this?", or details it didn't
// know ("we don't have a car"). The step is a suggestion still waiting to be added, or a task in the project.
// Claude answers, and may reword the step or break it into sub-steps:
//   suggestion - takes the change straight away (it's only a proposal); sub-steps become its task's checklist
//   task       - offers the change (proposal: open), to use or decline
// Like a check-in, a question is thinking while Claude answers in the background, then ready or failed. What
// people said here goes along with later check-ins (stepNotes), so Claude doesn't suggest what doesn't fit.

const MAX_SUBSTEPS = 8;
/** How many earlier answers a check-in is told about. */
const NOTES_SENT = 10;

const SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string", description: "Your answer, in 1-3 short sentences" },
    change: {
      type: "string",
      enum: ["keep", "reword", "break_down"],
      description: "keep: the step is fine as it is; reword: a new title or notes fit better; break_down: it needs sub-steps",
    },
    title: { type: "string", description: "The step's title, reworded if that helps; otherwise as it was" },
    notes: { type: "string", description: "The step's notes, rewritten if that helps; otherwise as they were" },
    substeps: { type: "array", items: { type: "string" }, description: `For break_down: 2 to ${MAX_SUBSTEPS} short sub-steps, in order; otherwise none` },
  },
  required: ["answer", "change", "title", "notes", "substeps"],
  additionalProperties: false,
};

const ASK = "They're asking about this one step, or telling you something about it. Answer briefly and practically. Only change the step if what they said calls for it: reword it if it doesn't fit their situation, or break it down if it's too big or they asked how to do it.";

const clip = (s, n) => String(s ?? "").trim().slice(0, n);
const cleanQuestion = (q) => {
  const question = clip(q, 1000);
  if (!question) throw new HttpError(400, "Ask a question, or say what Claude should know");
  return question;
};

/** A suggestion's sub-steps (JSON in project_suggestions.checklist). */
export function parseSubsteps(json) {
  const list = parseReply(json);
  return Array.isArray(list) ? list.filter((s) => typeof s === "string" && s.trim()) : [];
}

// --- Asking ----------------------------------------------------------------------------

export async function getSuggestion(householdId, id) {
  const s = await db.get("SELECT * FROM project_suggestions WHERE id = ? AND household_id = ?", [id, householdId]);
  if (!s) throw new HttpError(404, "Suggestion not found");
  return s;
}

/** A task in a project with a goal (a 404 otherwise: there's no one to ask about it). */
async function getProjectTask(householdId, id) {
  const task = await getTask(householdId, id);
  if (!task.project_id || !task.project_has_goal) throw new HttpError(404, "Task not found");
  return task;
}

export async function getStepQuestion(householdId, id) {
  const q = await db.get("SELECT * FROM step_questions WHERE id = ? AND household_id = ?", [id, householdId]);
  if (!q) throw new HttpError(404, "Question not found");
  return q;
}

/** Asks about a suggestion that hasn't been added yet. Returns the background work, for tests; it never rejects. */
export async function askAboutSuggestion(actor, suggestionId, { question }) {
  const s = await getSuggestion(actor.householdId, suggestionId);
  if (s.status !== "new") throw new HttpError(400, "That step has already been added or dismissed");
  return ask(actor, { projectId: s.project_id, suggestionId: s.id, taskId: null, question: cleanQuestion(question) });
}

/** Asks about a task in a goal project. */
export async function askAboutTask(actor, taskId, { question }) {
  const task = await getProjectTask(actor.householdId, taskId);
  return ask(actor, { projectId: task.project_id, suggestionId: null, taskId: task.id, question: cleanQuestion(question) });
}

async function ask(actor, { projectId, suggestionId, taskId, question }) {
  const id = newId();
  const ts = now();
  await db.run(
    `INSERT INTO step_questions (id, household_id, project_id, suggestion_id, task_id, question, status, asked_by, asked_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'thinking', ?, ?, ?)`,
    [id, actor.householdId, projectId, suggestionId, taskId, question, actor.id, ts, ts],
  );
  changed(actor.householdId, taskId ?? undefined);
  return { id, done: answer(actor, id) };
}

/** Asks again after a failure (or an answer that never came). */
export async function retryQuestion(actor, id) {
  const q = await getStepQuestion(actor.householdId, id);
  if (!(q.status === "failed" || isStale(q))) throw new HttpError(400, "Claude already has this question");
  const result = await db.run(
    "UPDATE step_questions SET status = 'thinking', error = NULL, asked_at = ? WHERE id = ? AND status = ?",
    [now(), id, q.status],
  );
  if (!result.rowsAffected) throw new HttpError(409, "Claude already has this question");
  changed(actor.householdId, q.task_id ?? undefined);
  return { done: answer(actor, id) };
}

async function answer(actor, id) {
  let taskId;
  try {
    const q = await getStepQuestion(actor.householdId, id);
    taskId = q.task_id ?? undefined;
    const step = q.suggestion_id && !q.task_id ? await getSuggestion(actor.householdId, q.suggestion_id) : await getTask(actor.householdId, q.task_id);
    const project = await getGoalProject(actor.householdId, q.project_id);
    const reply = await askForJson(await buildStepRequest(actor.householdId, project, step, q));
    await saveReply(actor, q, step, reply);
  } catch (err) {
    if (!(err instanceof HttpError)) console.error("step question failed", err);
    const message = err instanceof HttpError ? err.message : "Something went wrong. Try again.";
    await db.run("UPDATE step_questions SET status = 'failed', error = ? WHERE id = ? AND household_id = ?", [message, id, actor.householdId])
      .catch((e) => console.error("couldn't save a step question's failure", e));
  }
  changed(actor.householdId, taskId);
}

/** What Claude is sent: the goal, the rest of the project, this step and what's been said about it, and the question. */
export async function buildStepRequest(householdId, project, step, question) {
  const isTask = Boolean(question.task_id);
  const substeps = isTask
    ? (await db.all("SELECT text FROM checklist_items WHERE task_id = ? ORDER BY sort_order", [step.id])).map((i) => i.text)
    : parseSubsteps(step.checklist);
  const others = [
    ...(await listTasks(householdId, { projectId: project.id })).filter((t) => t.id !== step.id)
      .map((t) => `- [${t.status === "done" ? "done" : "to do"}] ${t.title}`),
    ...(await db.all("SELECT title FROM project_suggestions WHERE project_id = ? AND household_id = ? AND status = 'new' AND id != ?", [project.id, householdId, step.id]))
      .map((s) => `- [suggested] ${s.title}`),
  ];
  const earlier = (await listStepQuestions(householdId, isTask ? { taskId: step.id } : { suggestionId: step.id }))
    .filter((e) => e.status === "ready" && e.id !== question.id);

  const lines = [`Goal: ${project.goal}`];
  if (project.goal_notes) lines.push(`What they told you about it: ${project.goal_notes}`);
  if (others.length) lines.push("", "The rest of the project:", ...others);
  lines.push("", `The step: ${step.title}`);
  if (step.notes) lines.push(`Its notes: ${step.notes}`);
  if (substeps.length) lines.push("Its sub-steps:", ...substeps.map((s) => `- ${s}`));
  if (earlier.length) {
    lines.push("", "Earlier about this step:", ...earlier.map((e) => `- They said “${e.question}”; you answered: ${parseReply(e.reply)?.answer ?? ""}`));
  }
  lines.push("", `What they say now: ${question.question}`);
  return { system: SYSTEM, content: [{ type: "text", text: lines.join("\n") }, { type: "text", text: ASK }], schema: SCHEMA };
}

/** Claude's change, cleaned up: null when it keeps the step as it is. */
function changeOf(step, reply) {
  if (!["reword", "break_down"].includes(reply.change)) return null;
  const title = clip(reply.title, 300) || step.title;
  const notes = clip(reply.notes, 1000);
  const substeps = reply.change === "break_down" ? (reply.substeps ?? []).map((s) => clip(s, 300)).filter(Boolean).slice(0, MAX_SUBSTEPS) : [];
  if (title === step.title && notes === (step.notes ?? "") && !substeps.length) return null;
  return { title, notes, substeps };
}

async function saveReply(actor, q, step, reply) {
  const change = changeOf(step, reply);
  const saved = { ...reply, change: change ? reply.change : "keep", title: change?.title ?? step.title, notes: change?.notes ?? step.notes ?? "", substeps: change?.substeps ?? [] };
  const statements = [
    {
      sql: "UPDATE step_questions SET status = 'ready', reply = ?, error = NULL, proposal = ? WHERE id = ?",
      args: [JSON.stringify(saved), change && q.task_id ? "open" : null, q.id],
    },
  ];
  // A suggestion is still only a proposal, so it just changes. (If it was added meanwhile, the task gets the offer.)
  if (change && !q.task_id) {
    const keep = parseSubsteps(step.checklist);
    statements.push({
      sql: "UPDATE project_suggestions SET title = ?, notes = ?, checklist = ? WHERE id = ? AND status = 'new'",
      args: [change.title, change.notes, JSON.stringify(change.substeps.length ? change.substeps : keep), step.id],
    });
  }
  await db.batch(statements);
}

// --- Using Claude's change on a task ---------------------------------------------------

async function openProposal(householdId, id) {
  const q = await getStepQuestion(householdId, id);
  if (q.proposal !== "open" || !q.task_id) throw new HttpError(400, "That change has already been used or turned down");
  return q;
}

/** Applies the offered change to the task: its title and notes, and any sub-steps as checklist items. */
export async function useProposal(actor, id) {
  const q = await openProposal(actor.householdId, id);
  const reply = parseReply(q.reply) ?? {};
  await updateTask(actor, q.task_id, { title: reply.title, notes: reply.notes });
  const ts = now();
  await db.batch([
    ...(reply.substeps ?? []).map((text, i) => itemInsert(q.task_id, { text }, i, ts)),
    { sql: "UPDATE step_questions SET proposal = 'used' WHERE id = ?", args: [q.id] },
  ]);
  changed(actor.householdId, q.task_id);
  return q;
}

export async function declineProposal(actor, id) {
  const q = await openProposal(actor.householdId, id);
  await db.run("UPDATE step_questions SET proposal = 'declined' WHERE id = ?", [q.id]);
  changed(actor.householdId, q.task_id);
  return q;
}

// --- Reading ---------------------------------------------------------------------------

/** Questions about a project's steps, one suggestion's, or one task's, oldest first. */
export async function listStepQuestions(householdId, { projectId, suggestionId, taskId }) {
  const [col, value] = taskId ? ["task_id", taskId] : suggestionId ? ["suggestion_id", suggestionId] : ["project_id", projectId];
  return db.all(`SELECT * FROM step_questions WHERE household_id = ? AND ${col} = ? ORDER BY created_at, id`, [householdId, value]);
}

/** What people have told Claude about the project's steps, for the next check-in: the newest few, oldest first. */
export async function stepNotes(householdId, projectId) {
  const rows = await db.all(
    `SELECT q.question, q.reply, COALESCE(t.title, s.title) AS title FROM step_questions q
       LEFT JOIN tasks t ON t.id = q.task_id LEFT JOIN project_suggestions s ON s.id = q.suggestion_id
      WHERE q.household_id = ? AND q.project_id = ? AND q.status = 'ready'
      ORDER BY q.created_at DESC, q.id DESC LIMIT ?`,
    [householdId, projectId, NOTES_SENT],
  );
  return rows.reverse().map((r) => `- “${r.title}”: they said “${r.question}”; you answered: ${parseReply(r.reply)?.answer ?? ""}`);
}

/** When a suggestion becomes a task, what was said about it moves along. */
export const moveQuestionsStatement = (suggestionId, taskId) => ({
  sql: "UPDATE step_questions SET task_id = ? WHERE suggestion_id = ?",
  args: [taskId, suggestionId],
});
