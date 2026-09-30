import { db, newId, now } from "../db/client.js";
import { HttpError } from "../lib/http.js";
import { addDays, isValidDate } from "../../public/js/lib/dates.js";
import { nextOccurrence, parseRule } from "../../public/js/lib/recurrence.js";
import { activityStatement } from "./activity.js";
import { changed } from "./changes.js";
import { cleanTagName, ensureTags } from "./tags.js";

/** @typedef {{ id: string, householdId: string }} Actor  The signed-in user plus their household. */

/**
 * The lists a task can be on. The inbox is personal (its tasks show only to whoever added them);
 * the others are shared by the household.
 */
export const LISTS = ["inbox", "todo", "waiting", "someday"];

const TASK_SELECT = `
  SELECT t.*,
         p.name AS project_name, p.emoji AS project_emoji, p.color AS project_color,
         cx.name AS context_name,
         (SELECT group_concat(g.name, ' ') FROM task_tags tt JOIN tags g ON g.id = tt.tag_id WHERE tt.task_id = t.id) AS tag_names,
         (SELECT COUNT(*) FROM checklist_items c WHERE c.task_id = t.id) AS item_count,
         (SELECT COUNT(*) FROM checklist_items c WHERE c.task_id = t.id AND c.checked = 1) AS item_done,
         (SELECT COUNT(*) FROM comments m WHERE m.task_id = t.id) AS comment_count
    FROM tasks t LEFT JOIN projects p ON p.id = t.project_id LEFT JOIN contexts cx ON cx.id = t.context_id`;

const OPEN_ORDER = "ORDER BY t.due_date IS NULL, t.due_date, t.priority DESC, t.due_time IS NULL, t.due_time, t.sort_order, t.created_at";

/**
 * @param {string} householdId
 * @param {{ assigneeId?: string | null, creatorId?: string, list?: string, projectId?: string, contextId?: string, tag?: string, status?: "open" | "done", dueOnOrBefore?: string, templates?: boolean, limit?: number }} filter
 *   assigneeId: undefined = anyone, null = unassigned ("up for grabs")
 */
export async function listTasks(householdId, filter = {}) {
  const where = ["t.household_id = ?", "t.deleted_at IS NULL", "t.is_template = ?"];
  const args = [householdId, filter.templates ? 1 : 0];
  if (filter.assigneeId === null) where.push("t.assignee_id IS NULL");
  else if (filter.assigneeId !== undefined) (where.push("t.assignee_id = ?"), args.push(filter.assigneeId));
  if (filter.creatorId) (where.push("t.creator_id = ?"), args.push(filter.creatorId));
  if (filter.list) (where.push("t.list = ?"), args.push(filter.list));
  if (filter.projectId) (where.push("t.project_id = ?"), args.push(filter.projectId));
  if (filter.contextId) (where.push("t.context_id = ?"), args.push(filter.contextId));
  if (filter.tag) {
    where.push("EXISTS (SELECT 1 FROM task_tags tt JOIN tags g ON g.id = tt.tag_id WHERE tt.task_id = t.id AND g.name = ?)");
    args.push(filter.tag);
  }
  if (filter.status) (where.push("t.status = ?"), args.push(filter.status));
  if (filter.dueOnOrBefore) (where.push("t.due_date <= ?"), args.push(filter.dueOnOrBefore));
  const order =
    filter.status === "done" ? "ORDER BY t.completed_at DESC"
    : filter.list === "inbox" ? "ORDER BY t.created_at, t.id"
    : filter.list === "waiting" ? "ORDER BY t.waiting_since, t.created_at"
    : OPEN_ORDER;
  args.push(filter.limit ?? 500);
  return db.all(`${TASK_SELECT} WHERE ${where.join(" AND ")} ${order} LIMIT ?`, args);
}

export async function getTask(householdId, id, { includeDeleted = false } = {}) {
  const task = await db.get(`${TASK_SELECT} WHERE t.id = ? AND t.household_id = ?`, [id, householdId]);
  if (!task || (task.deleted_at && !includeDeleted)) throw new HttpError(404, "Task not found");
  return task;
}

async function assertMember(householdId, userId) {
  if (userId == null) return;
  const m = await db.get("SELECT 1 FROM memberships WHERE household_id = ? AND user_id = ?", [householdId, userId]);
  if (!m) throw new HttpError(400, "That person isn't in your household");
}

async function assertProject(householdId, projectId) {
  if (!projectId) return;
  const p = await db.get("SELECT 1 FROM projects WHERE id = ? AND household_id = ?", [projectId, householdId]);
  if (!p) throw new HttpError(400, "Unknown project");
}

async function assertContext(householdId, contextId) {
  if (!contextId) return;
  const c = await db.get("SELECT 1 FROM contexts WHERE id = ? AND household_id = ?", [contextId, householdId]);
  if (!c) throw new HttpError(400, "Unknown context");
}

/** The task's tag names, sorted: "errand quick-win" -> ["errand", "quick-win"]. */
export const tagList = (task) => (task.tag_names ? task.tag_names.split(" ").sort() : []);

const tagInserts = (taskId, tagIds) =>
  tagIds.map((tagId) => ({ sql: "INSERT INTO task_tags (task_id, tag_id) VALUES (?, ?)", args: [taskId, tagId] }));

/** Validates and normalises user-editable task fields. Only keys present in `input` are returned. */
function cleanFields(input) {
  const out = {};
  if ("title" in input) {
    out.title = String(input.title ?? "").trim().slice(0, 300);
    if (!out.title) throw new HttpError(400, "Task needs a title");
  }
  if ("notes" in input) out.notes = String(input.notes ?? "").slice(0, 10_000);
  if ("dueDate" in input) {
    out.due_date = input.dueDate || null;
    if (out.due_date && !isValidDate(out.due_date)) throw new HttpError(400, "Invalid due date");
  }
  if ("dueTime" in input) {
    out.due_time = input.dueTime || null;
    if (out.due_time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(out.due_time)) throw new HttpError(400, "Invalid time");
  }
  if ("priority" in input) out.priority = Math.max(-1, Math.min(1, Number(input.priority) || 0));
  if ("projectId" in input) out.project_id = input.projectId || null;
  if ("contextId" in input) out.context_id = input.contextId || null;
  if ("assigneeId" in input) out.assignee_id = input.assigneeId || null;
  if ("recurrence" in input) {
    const rule = parseRule(input.recurrence);
    out.recurrence = rule ? JSON.stringify(rule) : null;
  }
  if ("list" in input) {
    if (!LISTS.includes(input.list)) throw new HttpError(400, "Unknown list");
    out.list = input.list;
  }
  if ("waitingOn" in input) out.waiting_on = String(input.waitingOn ?? "").trim().slice(0, 200) || null;
  if ("listMode" in input) out.list_mode = input.listMode === "shopping" ? "shopping" : "checklist";
  return out;
}

/**
 * @param {Actor} actor
 * @param {object} input  title, notes, dueDate, dueTime, priority, projectId, contextId, tags (names), assigneeId (undefined = actor),
 *   recurrence, listMode, list (default "todo"), waitingOn
 */
export async function createTask(actor, input, { isTemplate = false, fromGoogle = false, items = [] } = {}) {
  const fields = cleanFields({ assigneeId: actor.id, ...input });
  if (fields.list === "waiting") fields.waiting_since = now().slice(0, 10);
  await assertMember(actor.householdId, fields.assignee_id);
  await assertProject(actor.householdId, fields.project_id);
  await assertContext(actor.householdId, fields.context_id);
  const tagIds = await ensureTags(actor.householdId, input.tags ?? []);
  const id = newId();
  const ts = now();
  const row = {
    id,
    household_id: actor.householdId,
    creator_id: actor.id,
    is_template: isTemplate ? 1 : 0,
    sort_order: Date.now(),
    created_at: ts,
    updated_at: ts,
    ...fields,
  };
  const cols = Object.keys(row);
  await db.batch([
    { sql: `INSERT INTO tasks (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, args: Object.values(row) },
    ...tagInserts(id, tagIds),
    ...items.map((item, i) => itemInsert(id, item, i, ts)),
    ...(isTemplate ? [] : [activityStatement(actor.householdId, fromGoogle ? null : actor.id, id, "created")]),
  ]);
  changed(actor.householdId, id, { fromGoogle });
  return id;
}

export function itemInsert(taskId, item, index, ts = now()) {
  return {
    sql: `INSERT INTO checklist_items (id, task_id, text, quantity, category, checked, sort_order, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    args: [newId(), taskId, item.text.slice(0, 300), item.quantity ?? null, item.category ?? null, Date.now() + index, ts, ts],
  };
}

/**
 * Edits a task. Assignment changes are logged as "assigned" so they show up in the feed.
 * `tags` (names), when present, replaces the task's tags.
 */
export async function updateTask(actor, id, input, { fromGoogle = false } = {}) {
  const task = await getTask(actor.householdId, id);
  const fields = cleanFields(input);
  if ("assignee_id" in fields) await assertMember(actor.householdId, fields.assignee_id);
  if ("project_id" in fields) await assertProject(actor.householdId, fields.project_id);
  if ("context_id" in fields) await assertContext(actor.householdId, fields.context_id);
  // Moving onto the waiting list starts the clock; moving off it forgets who it was waiting on.
  if (fields.list === "waiting" && task.list !== "waiting") fields.waiting_since = now().slice(0, 10);
  if (fields.list && fields.list !== "waiting") Object.assign(fields, { waiting_on: null, waiting_since: null });
  const diff = Object.fromEntries(Object.entries(fields).filter(([k, v]) => task[k] !== v));
  const tags = Array.isArray(input.tags) ? [...new Set(input.tags.map(cleanTagName).filter(Boolean))].sort() : null;
  const tagsChanged = tags !== null && tags.join(" ") !== tagList(task).join(" ");
  if (Object.keys(diff).length === 0 && !tagsChanged) return;
  const statements = [
    {
      sql: `UPDATE tasks SET ${Object.keys(diff).map((k) => `${k} = ?`).join(", ")}${Object.keys(diff).length ? ", " : ""}updated_at = ? WHERE id = ?`,
      args: [...Object.values(diff), now(), id],
    },
  ];
  if (tagsChanged) {
    statements.push({ sql: "DELETE FROM task_tags WHERE task_id = ?", args: [id] }, ...tagInserts(id, await ensureTags(actor.householdId, tags)));
  }
  const actorId = fromGoogle ? null : actor.id;
  if ("assignee_id" in diff) {
    statements.push(activityStatement(actor.householdId, actorId, id, "assigned", { from: task.assignee_id, to: diff.assignee_id }));
  }
  const updated = [...Object.keys(diff).filter((k) => k !== "assignee_id"), ...(tagsChanged ? ["tags"] : [])];
  if (updated.length) {
    statements.push(activityStatement(actor.householdId, actorId, id, "updated", { fields: updated }));
  }
  await db.batch(statements);
  changed(actor.householdId, id, { fromGoogle });
}

/** Reassigns (or claims / releases) a task, optionally leaving a note as a comment. */
export async function assignTask(actor, id, assigneeId, note = "") {
  await updateTask(actor, id, { assigneeId });
  if (note.trim()) await addComment(actor, id, note);
}

/** Marks a task done (or reopens it). Completing a recurring task schedules the next one. */
export async function setDone(actor, id, done, { today, fromGoogle = false } = {}) {
  const task = await getTask(actor.householdId, id);
  if ((task.status === "done") === done) return null;
  const ts = now();
  const actorId = fromGoogle ? null : actor.id;
  const statements = [
    {
      sql: "UPDATE tasks SET status = ?, completed_at = ?, completed_by = ?, updated_at = ? WHERE id = ?",
      args: done ? ["done", ts, actorId, ts, id] : ["open", null, null, ts, id],
    },
    activityStatement(actor.householdId, actorId, id, done ? "completed" : "reopened"),
  ];
  await db.batch(statements);
  changed(actor.householdId, id, { fromGoogle });

  const rule = parseRule(task.recurrence);
  if (done && rule && !task.next_task_id) {
    const nextDue = nextOccurrence(rule, task.due_date, today ?? ts.slice(0, 10));
    const nextId = await copyTask(actor, task, { dueDate: nextDue });
    // Remember the spawned task so completing, reopening and completing again doesn't duplicate it.
    await db.batch([
      { sql: "UPDATE tasks SET next_task_id = ? WHERE id = ?", args: [nextId, id] },
      activityStatement(actor.householdId, null, nextId, "recurred", { due: nextDue }),
    ]);
    return nextId;
  }
  return null;
}

/** Duplicates a task and its checklist (unchecked). Used for recurrence and templates. */
export async function copyTask(actor, task, overrides = {}, { isTemplate = false } = {}) {
  const items = await db.all("SELECT text, quantity, category FROM checklist_items WHERE task_id = ? ORDER BY sort_order", [task.id]);
  return createTask(
    actor,
    {
      title: task.title,
      notes: task.notes,
      dueDate: task.due_date,
      dueTime: task.due_time,
      priority: task.priority,
      projectId: task.project_id,
      contextId: task.context_id,
      tags: tagList(task),
      assigneeId: task.assignee_id,
      recurrence: task.recurrence,
      listMode: task.list_mode,
      ...overrides,
    },
    { isTemplate, items },
  );
}

export async function snoozeTask(actor, id, days, today) {
  const task = await getTask(actor.householdId, id);
  const base = task.due_date && task.due_date > today ? task.due_date : today;
  await updateTask(actor, id, { dueDate: addDays(base, days) });
}

export async function deleteTask(actor, id, { fromGoogle = false } = {}) {
  await getTask(actor.householdId, id);
  const ts = now();
  await db.batch([
    { sql: "UPDATE tasks SET deleted_at = ?, updated_at = ? WHERE id = ?", args: [ts, ts, id] },
    activityStatement(actor.householdId, fromGoogle ? null : actor.id, id, "deleted"),
  ]);
  changed(actor.householdId, id, { fromGoogle });
}

export async function restoreTask(actor, id) {
  await getTask(actor.householdId, id, { includeDeleted: true });
  await db.batch([
    { sql: "UPDATE tasks SET deleted_at = NULL, updated_at = ? WHERE id = ?", args: [now(), id] },
    activityStatement(actor.householdId, actor.id, id, "restored"),
  ]);
  changed(actor.householdId, id);
}

export async function saveAsTemplate(actor, id) {
  const task = await getTask(actor.householdId, id);
  return copyTask(actor, task, { dueDate: null, dueTime: null, assigneeId: null }, { isTemplate: true });
}

export async function useTemplate(actor, templateId, { assigneeId, dueDate } = {}) {
  const template = await getTask(actor.householdId, templateId);
  if (!template.is_template) throw new HttpError(400, "Not a template");
  return copyTask(actor, template, { assigneeId: assigneeId === undefined ? actor.id : assigneeId, dueDate: dueDate ?? null });
}

export async function deleteTemplate(actor, id) {
  const t = await getTask(actor.householdId, id);
  if (!t.is_template) throw new HttpError(400, "Not a template");
  await db.run("UPDATE tasks SET deleted_at = ? WHERE id = ?", [now(), id]);
}

export async function addComment(actor, taskId, body) {
  body = String(body ?? "").trim().slice(0, 4000);
  if (!body) throw new HttpError(400, "Comment is empty");
  await getTask(actor.householdId, taskId);
  await db.batch([
    { sql: "INSERT INTO comments (id, task_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)", args: [newId(), taskId, actor.id, body, now()] },
    activityStatement(actor.householdId, actor.id, taskId, "commented", { excerpt: body.slice(0, 80) }),
  ]);
  changed(actor.householdId, taskId);
}

export const listComments = (taskId) =>
  db.all("SELECT * FROM comments WHERE task_id = ? ORDER BY created_at", [taskId]);

export async function listDeleted(householdId) {
  return db.all(
    `${TASK_SELECT} WHERE t.household_id = ? AND t.deleted_at IS NOT NULL AND t.is_template = 0 AND t.deleted_at > ? ORDER BY t.deleted_at DESC LIMIT 30`,
    [householdId, new Date(Date.now() - 30 * 86_400_000).toISOString()],
  );
}

/** How many tasks are waiting in this person's inbox. */
export async function inboxCount(householdId, userId) {
  const row = await db.get(
    "SELECT COUNT(*) AS n FROM tasks WHERE household_id = ? AND creator_id = ? AND list = 'inbox' AND status = 'open' AND deleted_at IS NULL AND is_template = 0",
    [householdId, userId],
  );
  return Number(row.n);
}

/**
 * The next inbox task to sort: the oldest, or the oldest added after `afterId` (so "Skip" moves on).
 * @returns {Promise<{ task: object | null, left: number }>}  `left` counts the whole inbox, skipped ones included
 */
export async function nextToSort(householdId, userId, afterId = null) {
  const after = afterId ? await db.get("SELECT created_at, id FROM tasks WHERE id = ? AND household_id = ?", [afterId, householdId]) : null;
  const task = await db.get(
    `${TASK_SELECT} WHERE t.household_id = ? AND t.creator_id = ? AND t.list = 'inbox' AND t.status = 'open'
        AND t.deleted_at IS NULL AND t.is_template = 0 ${after ? "AND (t.created_at, t.id) > (?, ?)" : ""}
      ORDER BY t.created_at, t.id LIMIT 1`,
    after ? [householdId, userId, after.created_at, after.id] : [householdId, userId],
  );
  return { task: task ?? null, left: await inboxCount(householdId, userId) };
}

/** Open work per member for the "who's carrying what" glance: due within a week or undated. */
export async function workload(householdId, today) {
  return db.all(
    `SELECT assignee_id,
            SUM(CASE WHEN status = 'open' AND (due_date IS NULL OR due_date <= ?) THEN 1 ELSE 0 END) AS open_count,
            SUM(CASE WHEN status = 'open' AND due_date < ? THEN 1 ELSE 0 END) AS overdue_count,
            SUM(CASE WHEN status = 'done' AND completed_at >= ? THEN 1 ELSE 0 END) AS done_week
       FROM tasks WHERE household_id = ? AND deleted_at IS NULL AND is_template = 0
      GROUP BY assignee_id`,
    [addDays(today, 7), today, new Date(Date.now() - 7 * 86_400_000).toISOString(), householdId],
  );
}
