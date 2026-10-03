import { db, newId, now } from "../db/client.js";
import { HttpError } from "../lib/http.js";
import { askForJson } from "../lib/claude.js";
import { signedImageUrl, uploadImage } from "../lib/cloudinary.js";
import { firstOccurrence, parseRule } from "../../public/js/lib/recurrence.js";
import { changed } from "./changes.js";
import { checkImage, destroyImages } from "./photos.js";
import { PROJECT_COLORS } from "./projects.js";
import { moveQuestionsStatement, parseSubsteps, stepNotes } from "./step-questions.js";
import { createTask, listTasks } from "./tasks.js";

// Projects started from a goal, with Claude's help. Each time Claude is asked is a check-in:
//   start   - the plan: how to start, and the first steps (with photos of how it looks now, if any)
//   checkin - later photos and a note: what changed, a word of encouragement, the next steps
//   upkeep  - repeating tasks that keep it that way once it's done
// A check-in is a draft while photos are added, then thinking while Claude answers (in the background; the
// page's live update shows the answer), then ready or failed. Suggested tasks wait as suggestions until
// someone adds them (as real tasks in the project) or dismisses them.

export const MAX_CHECKIN_PHOTOS = 4;
/** How many of the first check-in's photos a later one sends along, to compare against. */
const START_PHOTOS_SENT = 2;
const MAX_STEPS = 8;
/** A check-in still thinking after this (the server restarted mid-answer, say) counts as failed. */
export const THINKING_TIMEOUT_MS = 5 * 60_000;
/** What Claude sees of each photo: big enough to read a room, in a format it takes. */
export const PHOTO_FOR_CLAUDE = ["c_limit,w_1568,h_1568", "f_jpg"];

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export const SYSTEM = `You help people in a shared household reach a practical goal: tidy a room, clear out a garage, get the garden ready for spring, plan a move. You turn a goal into small, concrete tasks for their shared to-do list app, and you cheer them on as they go.

How to write:
- Plain, friendly, everyday words. No productivity jargon (never "GTD", "next actions", "contexts", "sprints").
- Short. A few sentences at most for anything that isn't a task.
- Write in the same language the person writes in.

Tasks:
- Each task is one physical thing a person can do in one go, roughly 5 to 30 minutes.
- The title starts with a verb and is under 60 characters, e.g. "Clear everything off the desk" or "Bag up old papers for recycling".
- Notes are optional: one short sentence on how, or why it comes in this order. Leave them empty when the title says it all.
- Put the tasks in the order to do them. The first should be easy, to build momentum.
- Mark a task as "later" when it is nice to have rather than needed for the goal.

Photos:
- Only describe what you can actually see. If a photo is unclear or doesn't show the space, say so briefly instead of guessing.
- Be kind about mess. Never shame.

Encouragement:
- Specific and honest: point at real progress, however small. Warm, not gushing; no more than one exclamation mark.`;

const stepSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    notes: { type: "string" },
    later: { type: "boolean", description: "Nice to have rather than needed for the goal" },
  },
  required: ["title", "notes", "later"],
  additionalProperties: false,
};

const SCHEMAS = {
  start: {
    type: "object",
    properties: {
      name: { type: "string", description: "A short project name, 1-4 words, e.g. Tidy office" },
      emoji: { type: "string", description: "One emoji for the project" },
      noticed: { type: "string", description: "What you see in the photos, in 1-2 sentences; empty if there are none" },
      how_to_start: { type: "string", description: "How to get going, in 2-3 sentences" },
      steps: { type: "array", items: stepSchema, description: `3 to ${MAX_STEPS} tasks` },
    },
    required: ["name", "emoji", "noticed", "how_to_start", "steps"],
    additionalProperties: false,
  },
  checkin: {
    type: "object",
    properties: {
      what_changed: { type: "string", description: "What changed since the start, in 1-2 sentences" },
      encouragement: { type: "string", description: "One or two sentences of encouragement" },
      goal_reached: { type: "boolean", description: "Whether the goal looks done" },
      steps: { type: "array", items: stepSchema, description: `Up to ${MAX_STEPS} new tasks that aren't on their list yet; none if the goal is reached` },
    },
    required: ["what_changed", "encouragement", "goal_reached", "steps"],
    additionalProperties: false,
  },
  upkeep: {
    type: "object",
    properties: {
      intro: { type: "string", description: "One or two sentences on keeping it this way" },
      tasks: {
        type: "array",
        description: "2 to 5 small repeating tasks",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            notes: { type: "string" },
            every: { type: "integer", description: "How many units between repeats, 1 or more" },
            unit: { type: "string", enum: ["day", "week", "month"] },
            weekday: { type: "string", enum: ["any", ...WEEKDAYS], description: "For weekly tasks, the day it suits best; otherwise any" },
          },
          required: ["title", "notes", "every", "unit", "weekday"],
          additionalProperties: false,
        },
      },
    },
    required: ["intro", "tasks"],
    additionalProperties: false,
  },
};

const ASK = {
  start: "Suggest how to start, and the first tasks to reach this goal.",
  checkin: "This is a check-in. Compare with how it looked at the start (if there are photos of both), say what changed, encourage them, and suggest the next tasks that aren't on their list yet.",
  upkeep: "They've reached the goal (or nearly). Suggest a few small repeating tasks that keep it this way, each with how often.",
};

// --- Projects --------------------------------------------------------------------------

/** Starts a project from a goal, with its first check-in waiting (as a draft) for photos and the ask. */
export async function startProject(actor, { goal, notes }) {
  goal = String(goal ?? "").trim().slice(0, 300);
  if (!goal) throw new HttpError(400, "What do you want to get done?");
  notes = String(notes ?? "").trim().slice(0, 2000);
  const { n } = await db.get("SELECT COUNT(*) AS n FROM projects WHERE household_id = ?", [actor.householdId]);
  const id = newId();
  const ts = now();
  await db.batch([
    {
      sql: "INSERT INTO projects (id, household_id, name, emoji, color, goal, goal_notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      args: [id, actor.householdId, await freeName(actor.householdId, goal.slice(0, 80)), "🌱", PROJECT_COLORS[Number(n) % PROJECT_COLORS.length], goal, notes, ts, ts],
    },
    checkinInsert(actor, id, "start", ts),
  ]);
  changed(actor.householdId);
  return id;
}

/** A project with a goal, for its page. */
export async function getGoalProject(householdId, id) {
  const project = await db.get("SELECT * FROM projects WHERE id = ? AND household_id = ? AND goal IS NOT NULL", [id, householdId]);
  if (!project) throw new HttpError(404, "Project not found");
  return project;
}

/** The household's projects that have a goal, newest first, with their task counts. */
export async function listGoalProjects(householdId) {
  return db.all(
    `SELECT p.*,
            (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL AND t.is_template = 0) AS task_count,
            (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL AND t.is_template = 0 AND t.status = 'done') AS done_count
       FROM projects p WHERE p.household_id = ? AND p.goal IS NOT NULL AND p.archived = 0
      ORDER BY p.created_at DESC`,
    [householdId],
  );
}

/** `name`, or "name (2)" and so on if an open project already has it (typed #project shortcuts pick by name). */
async function freeName(householdId, name, exceptId = null) {
  const taken = new Set(
    (await db.all("SELECT name FROM projects WHERE household_id = ? AND archived = 0 AND id IS NOT ?", [householdId, exceptId]))
      .map((p) => p.name.toLowerCase()),
  );
  let candidate = name;
  for (let i = 2; taken.has(candidate.toLowerCase()); i++) candidate = `${name} (${i})`;
  return candidate;
}

// --- Check-ins -------------------------------------------------------------------------

const checkinInsert = (actor, projectId, kind, ts = now()) => ({
  sql: "INSERT INTO project_checkins (id, household_id, project_id, kind, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  args: [newId(), actor.householdId, projectId, kind, actor.id, ts],
});

export async function getCheckin(householdId, id) {
  const checkin = await db.get("SELECT * FROM project_checkins WHERE id = ? AND household_id = ?", [id, householdId]);
  if (!checkin) throw new HttpError(404, "Check-in not found");
  return checkin;
}

export async function listCheckins(householdId, projectId) {
  return db.all("SELECT * FROM project_checkins WHERE household_id = ? AND project_id = ? ORDER BY created_at, id", [householdId, projectId]);
}

/** The project's draft check-in of this kind, made if there isn't one. */
export async function openCheckin(actor, projectId, kind = "checkin") {
  await getGoalProject(actor.householdId, projectId);
  const draft = await db.get(
    "SELECT id FROM project_checkins WHERE household_id = ? AND project_id = ? AND kind = ? AND status = 'draft'",
    [actor.householdId, projectId, kind],
  );
  if (draft) return draft.id;
  const insert = checkinInsert(actor, projectId, kind);
  await db.run(insert.sql, insert.args);
  changed(actor.householdId);
  return insert.args[0];
}

/** Drops a draft check-in and its photos ("Never mind"). */
export async function discardCheckin(actor, id) {
  const checkin = await getCheckin(actor.householdId, id);
  if (checkin.status !== "draft" || checkin.kind === "start") throw new HttpError(400, "That check-in can't be dropped");
  const photos = await listCheckinPhotos(actor.householdId, [id]);
  await db.batch([
    { sql: "DELETE FROM checkin_photos WHERE checkin_id = ?", args: [id] },
    { sql: "DELETE FROM project_checkins WHERE id = ?", args: [id] },
  ]);
  changed(actor.householdId);
  await destroyImages(photos);
}

// --- Photos ----------------------------------------------------------------------------

/** Photos of the given check-ins, oldest first. */
export async function listCheckinPhotos(householdId, checkinIds) {
  if (!checkinIds.length) return [];
  return db.all(
    `SELECT * FROM checkin_photos WHERE household_id = ? AND checkin_id IN (${checkinIds.map(() => "?").join(", ")}) ORDER BY created_at, id`,
    [householdId, ...checkinIds],
  );
}

export async function getCheckinPhoto(householdId, id) {
  const photo = await db.get("SELECT * FROM checkin_photos WHERE id = ? AND household_id = ?", [id, householdId]);
  if (!photo) throw new HttpError(404, "Photo not found");
  return photo;
}

/** Adds a photo to a draft check-in (in the household's Cloudinary folder, like task photos). */
export async function addCheckinPhoto(actor, checkinId, bytes) {
  const checkin = await getCheckin(actor.householdId, checkinId);
  if (!["draft", "failed"].includes(checkin.status)) throw new HttpError(400, "Claude already has this check-in");
  const type = checkImage(bytes);
  const { n } = await db.get("SELECT COUNT(*) AS n FROM checkin_photos WHERE checkin_id = ?", [checkin.id]);
  if (Number(n) >= MAX_CHECKIN_PHOTOS) throw new HttpError(400, `A check-in can have up to ${MAX_CHECKIN_PHOTOS} photos`);
  const { publicId, width, height } = await uploadImage(bytes, type, { folder: `task-sloth/${actor.householdId}` });
  const id = newId();
  await db.run(
    "INSERT INTO checkin_photos (id, household_id, checkin_id, public_id, width, height, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [id, actor.householdId, checkin.id, publicId, width ?? null, height ?? null, actor.id, now()],
  );
  changed(actor.householdId);
  return id;
}

/** Takes a photo back off a check-in Claude hasn't answered yet. */
export async function removeCheckinPhoto(actor, photoId) {
  const photo = await getCheckinPhoto(actor.householdId, photoId);
  const checkin = await getCheckin(actor.householdId, photo.checkin_id);
  if (!["draft", "failed"].includes(checkin.status)) throw new HttpError(400, "Claude already has this photo");
  await db.run("DELETE FROM checkin_photos WHERE id = ?", [photo.id]);
  changed(actor.householdId);
  await destroyImages([photo]);
  return checkin.project_id;
}

// --- Asking Claude ---------------------------------------------------------------------

/**
 * Sends a draft (or failed) check-in to Claude. It's marked as thinking straight away; the answer comes in
 * the background, and both changes reach the page through its live update. Returns that background work,
 * for tests to wait on; it never rejects.
 */
export async function askCheckin(actor, id, { note = "", today }) {
  const checkin = await getCheckin(actor.householdId, id);
  if (checkin.status === "ready" || (checkin.status === "thinking" && !isStale(checkin))) {
    throw new HttpError(400, "Claude already has this check-in");
  }
  const result = await db.run(
    "UPDATE project_checkins SET status = 'thinking', note = ?, error = NULL, asked_at = ? WHERE id = ? AND status = ?",
    [String(note ?? "").trim().slice(0, 2000), now(), id, checkin.status],
  );
  if (!result.rowsAffected) throw new HttpError(409, "Claude already has this check-in");
  changed(actor.householdId);
  return { done: answer(actor, id, today) };
}

export const isStale = (checkin, at = Date.now()) =>
  checkin.status === "thinking" && at - Date.parse(checkin.asked_at ?? checkin.created_at) > THINKING_TIMEOUT_MS;

async function answer(actor, id, today) {
  try {
    const checkin = await getCheckin(actor.householdId, id);
    const project = await getGoalProject(actor.householdId, checkin.project_id);
    const request = await buildRequest(actor.householdId, project, checkin, today);
    const reply = await askForJson(request);
    await saveReply(actor, project, checkin, reply, today);
  } catch (err) {
    if (!(err instanceof HttpError)) console.error("check-in failed", err);
    const message = err instanceof HttpError ? err.message : "Something went wrong. Try again.";
    await db.run("UPDATE project_checkins SET status = 'failed', error = ? WHERE id = ? AND household_id = ?", [message, id, actor.householdId])
      .catch((e) => console.error("couldn't save a check-in's failure", e));
  }
  changed(actor.householdId);
}

/** What Claude is sent for a check-in: the goal, the list so far, earlier answers, and photos (start and now). */
export async function buildRequest(householdId, project, checkin, today) {
  const checkins = await listCheckins(householdId, project.id);
  const start = checkins.find((c) => c.kind === "start");
  const photos = await listCheckinPhotos(householdId, [checkin.id]);
  const startPhotos = start && start.id !== checkin.id ? (await listCheckinPhotos(householdId, [start.id])).slice(0, START_PHOTOS_SENT) : [];
  const tasks = checkin.kind === "start" ? [] : await listTasks(householdId, { projectId: project.id });

  const lines = [`Goal: ${project.goal}`];
  if (project.goal_notes) lines.push(`What they told you about it: ${project.goal_notes}`);
  lines.push(`Today: ${today}`);
  if (tasks.length) {
    lines.push("", "Their tasks for this so far:", ...tasks.map((t) => `- [${t.status === "done" ? "done" : "to do"}] ${t.title}`));
  }
  const earlier = checkins.filter((c) => c.status === "ready" && c.id !== checkin.id);
  if (earlier.length) {
    lines.push("", "Earlier check-ins:", ...earlier.map((c) => `- ${c.created_at.slice(0, 10)}${c.note ? `, they said “${c.note}”` : ""}: ${summarize(c)}`));
  }
  const notes = await stepNotes(householdId, project.id);
  if (notes.length) lines.push("", "What they've told you about single steps (keep it in mind):", ...notes);
  if (checkin.note) lines.push("", `What they say today: ${checkin.note}`);

  const image = (p) => ({ type: "image", source: { type: "url", url: signedImageUrl(p.public_id, ...PHOTO_FOR_CLAUDE) } });
  const content = [{ type: "text", text: lines.join("\n") }];
  if (startPhotos.length) content.push({ type: "text", text: `Photos from the start (${start.created_at.slice(0, 10)}):` }, ...startPhotos.map(image));
  if (photos.length) content.push({ type: "text", text: checkin.kind === "start" ? "Photos of how it looks now:" : "Photos from today:" }, ...photos.map(image));
  content.push({ type: "text", text: ASK[checkin.kind] });
  return { system: SYSTEM, content, schema: SCHEMAS[checkin.kind] };
}

/** One line on what an earlier answer said, for the next check-in's history. */
function summarize(checkin) {
  const reply = parseReply(checkin.reply);
  if (!reply) return "";
  if (checkin.kind === "start") return `plan made${reply.noticed ? ` (${reply.noticed})` : ""}`;
  if (checkin.kind === "upkeep") return "suggested upkeep";
  return reply.what_changed ?? "";
}

export function parseReply(json) {
  try {
    return json ? JSON.parse(json) : null;
  } catch {
    return null;
  }
}

/** A weekday name, or "any", as the recurrence rule's 0-6. */
const weekdayIndex = (name) => (WEEKDAYS.includes(name) ? WEEKDAYS.indexOf(name) : undefined);

/** Claude's upkeep task as a recurrence rule (public/js/lib/recurrence.js), or null if it doesn't make one. */
export function upkeepRule({ every, unit, weekday }) {
  const rule = { unit, every: Math.min(12, Math.max(1, Math.round(Number(every) || 1))) };
  if (unit === "week" && weekdayIndex(weekday) !== undefined) rule.weekday = weekdayIndex(weekday);
  return parseRule(rule);
}

const clip = (s, n) => String(s ?? "").trim().slice(0, n);

async function saveReply(actor, project, checkin, reply, today) {
  const ts = now();
  const suggestion = (kind, s, i, extra = {}) => ({
    sql: `INSERT INTO project_suggestions (id, household_id, project_id, checkin_id, kind, title, notes, list, recurrence, sort, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [newId(), actor.householdId, project.id, checkin.id, kind, clip(s.title, 300), clip(s.notes, 1000), extra.list ?? "todo", extra.recurrence ?? null, i, ts],
  });
  const steps = (reply.steps ?? []).filter((s) => clip(s.title, 300)).slice(0, MAX_STEPS)
    .map((s, i) => suggestion("step", s, i, { list: s.later ? "someday" : "todo" }));
  const upkeep = (reply.tasks ?? []).filter((s) => clip(s.title, 300))
    .map((s) => [s, upkeepRule(s)]).filter(([, rule]) => rule).slice(0, MAX_STEPS)
    .map(([s, rule], i) => suggestion("upkeep", s, i, { recurrence: JSON.stringify(rule) }));
  const statements = [
    { sql: "UPDATE project_checkins SET status = 'ready', reply = ?, error = NULL WHERE id = ?", args: [JSON.stringify(reply), checkin.id] },
    ...steps,
    ...upkeep,
  ];
  // The plan names the project, unless someone has changed it since it was started.
  if (checkin.kind === "start" && project.updated_at === project.created_at) {
    const name = clip(reply.name, 80);
    statements.push({
      sql: "UPDATE projects SET name = ?, emoji = ?, updated_at = ? WHERE id = ?",
      args: [name ? await freeName(actor.householdId, name, project.id) : project.name, clip(reply.emoji, 8) || project.emoji, ts, project.id],
    });
  }
  await db.batch(statements);
}

// --- Suggestions -----------------------------------------------------------------------

/** Suggestions still waiting for an answer, in the order Claude gave them (newest check-in first). */
export async function listSuggestions(householdId, projectId) {
  return db.all(
    `SELECT s.* FROM project_suggestions s JOIN project_checkins c ON c.id = s.checkin_id
      WHERE s.household_id = ? AND s.project_id = ? AND s.status = 'new'
      ORDER BY c.created_at DESC, s.sort`,
    [householdId, projectId],
  );
}

/** Adds the picked suggestions to the project as tasks; returns how many were added. */
export async function addSuggestions(actor, projectId, ids, { today }) {
  await getGoalProject(actor.householdId, projectId);
  const wanted = new Set(ids);
  const picked = (await listSuggestions(actor.householdId, projectId)).filter((s) => wanted.has(s.id));
  for (const s of picked) {
    const rule = parseRule(s.recurrence);
    const taskId = await createTask(actor, {
      title: s.title,
      notes: s.notes,
      projectId,
      list: s.list,
      ...(rule ? { recurrence: rule, dueDate: firstOccurrence(rule, today) } : {}),
    }, { items: parseSubsteps(s.checklist).map((text) => ({ text })) });
    // What was asked about the step (src/services/step-questions.js) carries on on its task's page.
    await db.batch([
      { sql: "UPDATE project_suggestions SET status = 'added', task_id = ? WHERE id = ?", args: [taskId, s.id] },
      moveQuestionsStatement(s.id, taskId),
    ]);
  }
  changed(actor.householdId);
  return picked.length;
}

export async function dismissSuggestion(actor, id) {
  const s = await db.get("SELECT * FROM project_suggestions WHERE id = ? AND household_id = ?", [id, actor.householdId]);
  if (!s) throw new HttpError(404, "Suggestion not found");
  await db.run("UPDATE project_suggestions SET status = 'dismissed' WHERE id = ?", [s.id]);
  changed(actor.householdId);
  return s.project_id;
}
