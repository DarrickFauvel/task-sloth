import { db, newId, now } from "../db/client.js";
import { HttpError } from "../lib/http.js";
import { askForJson } from "../lib/claude.js";
import { signedImageUrl, uploadImage } from "../lib/cloudinary.js";
import { changed } from "./changes.js";
import { getGoalProject, isStale, parseReply, PHOTO_FOR_CLAUDE, SYSTEM } from "./coach.js";
import { checkImage, destroyImages } from "./photos.js";
import { removeItems } from "./checklist.js";
import { getTask, itemInsert, listTasks, updateTask } from "./tasks.js";

// Asking Claude about one step of a project (src/services/coach.js): "how do I do this?", or details it didn't
// know ("we don't have a car"). The step is a suggestion still waiting to be added, or a task in the project.
// Claude answers, and may reword the step, break it into sub-steps, or drop sub-steps that no longer fit:
//   suggestion - takes the change straight away (it's only a proposal); sub-steps become its task's checklist
//   task       - offers the change (proposal: open), to use or decline
// Like a check-in, a question is thinking while Claude answers in the background, then ready or failed. What
// people said here goes along with later check-ins (stepNotes), so Claude doesn't suggest what doesn't fit.
// Photos can go with a question: the first one makes the asker a draft question for that step (only they see
// it), and the Ask sends it, photos and all.

const MAX_SUBSTEPS = 8;
/** Like a check-in's. */
export const MAX_QUESTION_PHOTOS = 4;
/** How many earlier answers a check-in is told about. */
const NOTES_SENT = 10;

const SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string", description: "Your answer, in 1-3 short sentences" },
    change: {
      type: "string",
      enum: ["keep", "reword", "break_down"],
      description: "keep: the step is fine as it is; reword: a new title or notes fit better, or some sub-steps no longer fit; break_down: it needs sub-steps",
    },
    title: { type: "string", description: "The step's title, reworded if that helps; otherwise as it was" },
    notes: { type: "string", description: "The step's notes, rewritten if that helps; otherwise as they were" },
    substeps: { type: "array", items: { type: "string" }, description: `For break_down: 2 to ${MAX_SUBSTEPS} short new sub-steps, in order; otherwise none` },
    remove: { type: "array", items: { type: "integer" }, description: "Numbers of the step's current sub-steps that what they said makes unnecessary or wrong; otherwise none" },
  },
  required: ["answer", "change", "title", "notes", "substeps", "remove"],
  additionalProperties: false,
};

const ASK = "They're asking about this one step, or telling you something about it. If they sent photos, use what you can see in them. Answer briefly and practically. Only change the step if what they said calls for it: reword it if it doesn't fit their situation, or break it down if it's too big or they asked how to do it. If what they said makes some of its sub-steps unnecessary or wrong, list their numbers in remove; leave done ones alone, and don't repeat sub-steps that are staying.";

const clip = (s, n) => String(s ?? "").trim().slice(0, n);
/** The question as typed; it can be empty when photos go with it. */
const cleanQuestion = (q, hasPhotos) => {
  const question = clip(q, 1000);
  if (!question && !hasPhotos) throw new HttpError(400, "Ask a question, or say what Claude should know");
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

/** A suggestion that hasn't been added yet, as a step to ask about. */
async function suggestionStep(householdId, suggestionId) {
  const s = await getSuggestion(householdId, suggestionId);
  if (s.status !== "new") throw new HttpError(400, "That step has already been added or dismissed");
  return { projectId: s.project_id, suggestionId: s.id, taskId: null };
}

/** A task in a goal project, as a step to ask about. */
async function taskStep(householdId, taskId) {
  const task = await getProjectTask(householdId, taskId);
  return { projectId: task.project_id, suggestionId: null, taskId: task.id };
}

/** The step a draft or question is about: a suggestion ({ suggestionId }) or a task ({ taskId }). */
const stepOf = (householdId, { suggestionId, taskId }) => (taskId ? taskStep(householdId, taskId) : suggestionStep(householdId, suggestionId));

/** Asks about a suggestion that hasn't been added yet. Returns the background work, for tests; it never rejects. */
export async function askAboutSuggestion(actor, suggestionId, { question }) {
  return ask(actor, await suggestionStep(actor.householdId, suggestionId), question);
}

/** Asks about a task in a goal project. */
export async function askAboutTask(actor, taskId, { question }) {
  return ask(actor, await taskStep(actor.householdId, taskId), question);
}

/** Sends the asker's draft for this step (with its photos), or a new question when there's no draft. */
async function ask(actor, { projectId, suggestionId, taskId }, typed) {
  const draft = await findDraft(actor, { suggestionId, taskId });
  const photos = draft ? await listQuestionPhotos(actor.householdId, [draft.id]) : [];
  const question = cleanQuestion(typed, photos.length > 0);
  const ts = now();
  let id = draft?.id;
  if (id) {
    await db.run(
      "UPDATE step_questions SET question = ?, status = 'thinking', asked_at = ?, created_at = ? WHERE id = ? AND status = 'draft'",
      [question, ts, ts, id],
    );
  } else {
    id = newId();
    await db.run(
      `INSERT INTO step_questions (id, household_id, project_id, suggestion_id, task_id, question, status, asked_by, asked_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'thinking', ?, ?, ?)`,
      [id, actor.householdId, projectId, suggestionId, taskId, question, actor.id, ts, ts],
    );
  }
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
    const current = await currentSubsteps(q, step);
    const reply = await askForJson(await buildStepRequest(actor.householdId, project, step, q, current));
    await saveReply(actor, q, step, reply, current);
  } catch (err) {
    if (!(err instanceof HttpError)) console.error("step question failed", err);
    const message = err instanceof HttpError ? err.message : "Something went wrong. Try again.";
    await db.run("UPDATE step_questions SET status = 'failed', error = ? WHERE id = ? AND household_id = ?", [message, id, actor.householdId])
      .catch((e) => console.error("couldn't save a step question's failure", e));
  }
  changed(actor.householdId, taskId);
}

// --- Photos ----------------------------------------------------------------------------

/** The asker's draft question about a step, if they've started one. (A suggestion's draft follows it to its task.) */
async function findDraft(actor, { suggestionId, taskId }) {
  const [col, value] = taskId ? ["task_id", taskId] : ["suggestion_id", suggestionId];
  return db.get(
    `SELECT * FROM step_questions WHERE household_id = ? AND asked_by = ? AND status = 'draft' AND ${col} = ?${taskId ? "" : " AND task_id IS NULL"}`,
    [actor.householdId, actor.id, value],
  );
}

/** Photos of the given questions, oldest first. */
export async function listQuestionPhotos(householdId, questionIds) {
  if (!questionIds.length) return [];
  return db.all(
    `SELECT * FROM step_question_photos WHERE household_id = ? AND question_id IN (${questionIds.map(() => "?").join(", ")}) ORDER BY created_at, id`,
    [householdId, ...questionIds],
  );
}

export async function getQuestionPhoto(householdId, id) {
  const photo = await db.get("SELECT * FROM step_question_photos WHERE id = ? AND household_id = ?", [id, householdId]);
  if (!photo) throw new HttpError(404, "Photo not found");
  return photo;
}

/**
 * Adds a photo to the asker's draft question about a step ({ suggestionId } or { taskId }), starting the draft if
 * needed. In the household's Cloudinary folder, like task photos.
 */
export async function addQuestionPhoto(actor, which, bytes) {
  const step = await stepOf(actor.householdId, which);
  const type = checkImage(bytes);
  let draft = await findDraft(actor, step);
  if (draft) {
    const { n } = await db.get("SELECT COUNT(*) AS n FROM step_question_photos WHERE question_id = ?", [draft.id]);
    if (Number(n) >= MAX_QUESTION_PHOTOS) throw new HttpError(400, `A question can have up to ${MAX_QUESTION_PHOTOS} photos`);
  }
  const { publicId, width, height } = await uploadImage(bytes, type, { folder: `task-sloth/${actor.householdId}` });
  const ts = now();
  const statements = [];
  if (!draft) {
    draft = { id: newId() };
    statements.push({
      sql: `INSERT INTO step_questions (id, household_id, project_id, suggestion_id, task_id, question, status, asked_by, asked_at, created_at)
            VALUES (?, ?, ?, ?, ?, '', 'draft', ?, ?, ?)`,
      args: [draft.id, actor.householdId, step.projectId, step.suggestionId, step.taskId, actor.id, ts, ts],
    });
  }
  const id = newId();
  statements.push({
    sql: "INSERT INTO step_question_photos (id, household_id, question_id, public_id, width, height, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    args: [id, actor.householdId, draft.id, publicId, width ?? null, height ?? null, actor.id, ts],
  });
  await db.batch(statements);
  changed(actor.householdId, step.taskId ?? undefined);
  return id;
}

/** Takes a photo back off your draft (Claude doesn't have it yet). A draft left with no photos goes. Returns the draft. */
export async function removeQuestionPhoto(actor, photoId) {
  const photo = await getQuestionPhoto(actor.householdId, photoId);
  const q = await getStepQuestion(actor.householdId, photo.question_id);
  if (q.asked_by !== actor.id) throw new HttpError(404, "Photo not found");
  if (q.status !== "draft") throw new HttpError(400, "Claude already has this photo");
  await db.run("DELETE FROM step_question_photos WHERE id = ?", [photo.id]);
  await db.run("DELETE FROM step_questions WHERE id = ? AND status = 'draft' AND NOT EXISTS (SELECT 1 FROM step_question_photos WHERE question_id = ?)", [q.id, q.id]);
  changed(actor.householdId, q.task_id ?? undefined);
  await destroyImages([photo]);
  return q;
}

/** The step's sub-steps as Claude is shown them, numbered from 1: a task's checklist items, or a suggestion's list. */
async function currentSubsteps(question, step) {
  if (!question.task_id) return parseSubsteps(step.checklist).map((text) => ({ id: null, text, checked: false }));
  const items = await db.all("SELECT id, text, checked FROM checklist_items WHERE task_id = ? ORDER BY checked, sort_order", [step.id]);
  return items.map((i) => ({ id: i.id, text: i.text, checked: Boolean(i.checked) }));
}

/** What Claude is sent: the goal, the rest of the project, this step and what's been said about it, and the question. */
export async function buildStepRequest(householdId, project, step, question, substeps) {
  const isTask = Boolean(question.task_id);
  substeps ??= await currentSubsteps(question, step);
  const others = [
    ...(await listTasks(householdId, { projectId: project.id })).filter((t) => t.id !== step.id)
      .map((t) => `- [${t.status === "done" ? "done" : "to do"}] ${t.title}`),
    ...(await db.all("SELECT title FROM project_suggestions WHERE project_id = ? AND household_id = ? AND status = 'new' AND id != ?", [project.id, householdId, step.id]))
      .map((s) => `- [suggested] ${s.title}`),
  ];
  const earlier = (await listStepQuestions(householdId, isTask ? { taskId: step.id } : { suggestionId: step.id }))
    .filter((e) => e.status === "ready" && e.id !== question.id);
  const photos = await listQuestionPhotos(householdId, [question.id, ...earlier.map((e) => e.id)]);
  const photosOf = (q) => photos.filter((p) => p.question_id === q.id);
  const said = (q) => {
    const n = photosOf(q).length;
    const sent = n === 1 ? "a photo" : n ? `${n} photos` : "";
    return q.question ? `“${q.question}”${sent ? ` (with ${sent})` : ""}` : sent ? `nothing, but sent ${sent}` : "nothing";
  };

  const lines = [`Goal: ${project.goal}`];
  if (project.goal_notes) lines.push(`What they told you about it: ${project.goal_notes}`);
  if (others.length) lines.push("", "The rest of the project:", ...others);
  lines.push("", `The step: ${step.title}`);
  if (step.notes) lines.push(`Its notes: ${step.notes}`);
  if (substeps.length) lines.push("Its sub-steps:", ...substeps.map((s, i) => `${i + 1}. ${s.checked ? "[done] " : ""}${s.text}`));
  if (earlier.length) {
    lines.push("", "Earlier about this step:", ...earlier.map((e) => `- They said ${said(e)}; you answered: ${parseReply(e.reply)?.answer ?? ""}`));
  }
  const attached = photosOf(question);
  lines.push("", question.question ? `What they say now: ${question.question}` : "They sent photos of it, with no words.");
  const image = (p) => ({ type: "image", source: { type: "url", url: signedImageUrl(p.public_id, ...PHOTO_FOR_CLAUDE) } });
  const content = [{ type: "text", text: lines.join("\n") }];
  if (attached.length) content.push({ type: "text", text: attached.length === 1 ? "Their photo:" : "Their photos:" }, ...attached.map(image));
  content.push({ type: "text", text: ASK });
  return { system: SYSTEM, content, schema: SCHEMA };
}

/**
 * Claude's change, cleaned up: null when it keeps the step as it is. `remove` is the current sub-steps it drops
 * (by their numbers; never done ones), as { id, text } so a task's items can be found again when the change is used.
 */
function changeOf(step, reply, current) {
  if (!["reword", "break_down"].includes(reply.change)) return null;
  const title = clip(reply.title, 300) || step.title;
  const notes = clip(reply.notes, 1000);
  const substeps = reply.change === "break_down" ? (reply.substeps ?? []).map((s) => clip(s, 300)).filter(Boolean).slice(0, MAX_SUBSTEPS) : [];
  const numbers = new Set((Array.isArray(reply.remove) ? reply.remove : []).filter(Number.isInteger));
  const remove = current.filter((s, i) => numbers.has(i + 1) && !s.checked).map(({ id, text }) => ({ id, text }));
  if (title === step.title && notes === (step.notes ?? "") && !substeps.length && !remove.length) return null;
  return { title, notes, substeps, remove };
}

async function saveReply(actor, q, step, reply, current) {
  const change = changeOf(step, reply, current);
  const saved = {
    ...reply,
    change: change ? reply.change : "keep",
    title: change?.title ?? step.title,
    notes: change?.notes ?? step.notes ?? "",
    substeps: change?.substeps ?? [],
    remove: change?.remove ?? [],
  };
  const statements = [
    {
      sql: "UPDATE step_questions SET status = 'ready', reply = ?, error = NULL, proposal = ? WHERE id = ?",
      args: [JSON.stringify(saved), change && q.task_id ? "open" : null, q.id],
    },
  ];
  // A suggestion is still only a proposal, so it just changes. (If it was added meanwhile, the task gets the offer.)
  if (change && !q.task_id) {
    const keep = current.filter((s) => !change.remove.some((r) => r.text === s.text)).map((s) => s.text);
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

/**
 * Applies the offered change to the task: its title and notes, the checklist items it drops (unless they've been
 * checked off since), and any sub-steps as new checklist items.
 */
export async function useProposal(actor, id) {
  const q = await openProposal(actor.householdId, id);
  const reply = parseReply(q.reply) ?? {};
  await updateTask(actor, q.task_id, { title: reply.title, notes: reply.notes });
  await removeItems(q.task_id, (reply.remove ?? []).map((r) => r.id).filter(Boolean));
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

/** Questions about a project's steps, one suggestion's, or one task's, oldest first (not drafts). */
export async function listStepQuestions(householdId, { projectId, suggestionId, taskId }) {
  const [col, value] = taskId ? ["task_id", taskId] : suggestionId ? ["suggestion_id", suggestionId] : ["project_id", projectId];
  return db.all(`SELECT * FROM step_questions WHERE household_id = ? AND ${col} = ? AND status != 'draft' ORDER BY created_at, id`, [householdId, value]);
}

/** One person's draft questions (with photos waiting to be sent) about a project's steps, or one task. */
export async function listDrafts(householdId, userId, { projectId, taskId }) {
  const [col, value] = taskId ? ["task_id", taskId] : ["project_id", projectId];
  return db.all(`SELECT * FROM step_questions WHERE household_id = ? AND asked_by = ? AND status = 'draft' AND ${col} = ?`, [householdId, userId, value]);
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
  return rows.reverse().map((r) => `- “${r.title}”: ${r.question ? `they said “${r.question}”` : "they sent a photo"}; you answered: ${parseReply(r.reply)?.answer ?? ""}`);
}

/** When a suggestion becomes a task, what was said about it moves along. */
export const moveQuestionsStatement = (suggestionId, taskId) => ({
  sql: "UPDATE step_questions SET task_id = ? WHERE suggestion_id = ?",
  args: [taskId, suggestionId],
});
