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
         (SELECT COUNT(*) FROM comments m WHERE m.task_id = t.id) AS comment_count,
         (SELECT COUNT(*) FROM task_photos ph WHERE ph.task_id = t.id) AS photo_count,
         (SELECT json_group_array(ph.id) FROM (SELECT id FROM task_photos WHERE task_id = t.id ORDER BY created_at, id LIMIT 3) ph) AS photo_ids,
         wt.title AS waiting_task_title, wt.status AS waiting_task_status,
         (SELECT json_group_array(b.title) FROM tasks b
           WHERE b.waiting_task_id = t.id AND b.status = 'open' AND b.deleted_at IS NULL) AS blocking_titles
    FROM tasks t LEFT JOIN projects p ON p.id = t.project_id LEFT JOIN contexts cx ON cx.id = t.context_id
         LEFT JOIN tasks wt ON wt.id = t.waiting_task_id AND wt.deleted_at IS NULL`;

const OPEN_ORDER = "ORDER BY t.due_date IS NULL, t.due_date, t.priority DESC, t.due_time IS NULL, t.due_time, t.sort_order, t.created_at";

/**
 * @param {string} householdId
 * @param {{ assigneeId?: string | null, creatorId?: string, list?: string, waiting?: boolean, projectId?: string, contextId?: string, tag?: string, status?: "open" | "done", completedSince?: string, dueOnOrBefore?: string, templates?: boolean, limit?: number }} filter
 *   assigneeId: undefined = anyone, null = unassigned ("up for grabs")
 *   completedSince (an ISO time): with status "open", also tasks done since then, so a finished task
 *   lingers on its list for a while; with status "done", only tasks done since then.
 */
export async function listTasks(householdId, filter = {}) {
  const where = ["t.household_id = ?", "t.deleted_at IS NULL", "t.is_template = ?"];
  const args = [householdId, filter.templates ? 1 : 0];
  if (filter.assigneeId === null) where.push("t.assignee_id IS NULL");
  else if (filter.assigneeId !== undefined) (where.push("t.assignee_id = ?"), args.push(filter.assigneeId));
  if (filter.creatorId) (where.push("t.creator_id = ?"), args.push(filter.creatorId));
  if (filter.list) (where.push("t.list = ?"), args.push(filter.list));
  // "Waiting" means anything that can't move: on the Waiting list, or blocked by another task.
  if (filter.waiting) where.push("(t.list = 'waiting' OR t.waiting_task_id IS NOT NULL)");
  if (filter.projectId) (where.push("t.project_id = ?"), args.push(filter.projectId));
  if (filter.contextId) (where.push("t.context_id = ?"), args.push(filter.contextId));
  if (filter.tag) {
    where.push("EXISTS (SELECT 1 FROM task_tags tt JOIN tags g ON g.id = tt.tag_id WHERE tt.task_id = t.id AND g.name = ?)");
    args.push(filter.tag);
  }
  if (filter.status === "open" && filter.completedSince) {
    where.push("(t.status = 'open' OR (t.status = 'done' AND t.completed_at >= ?))");
    args.push(filter.completedSince);
  } else if (filter.status) (where.push("t.status = ?"), args.push(filter.status));
  if (filter.status === "done" && filter.completedSince) (where.push("t.completed_at >= ?"), args.push(filter.completedSince));
  if (filter.dueOnOrBefore) (where.push("t.due_date <= ?"), args.push(filter.dueOnOrBefore));
  const order =
    filter.status === "done" ? "ORDER BY t.completed_at DESC"
    : filter.list === "inbox" ? "ORDER BY t.created_at, t.id"
    : filter.list === "waiting" || filter.waiting ? "ORDER BY t.waiting_since IS NULL, t.waiting_since, t.created_at"
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

/**
 * Checks that `blockerId` can block `taskId`: an open task in the same household, not the task
 * itself, and not already (directly or through a chain) waiting on `taskId`.
 */
async function assertBlocker(householdId, taskId, blockerId) {
  if (!blockerId) return;
  if (blockerId === taskId) throw new HttpError(400, "A task can't wait on itself");
  const blocker = await db.get(
    "SELECT status FROM tasks WHERE id = ? AND household_id = ? AND deleted_at IS NULL AND is_template = 0",
    [blockerId, householdId],
  );
  if (!blocker) throw new HttpError(400, "Unknown task");
  if (blocker.status !== "open") throw new HttpError(400, "That task is already done");
  if (!taskId) return;
  // Follow the chain from the blocker; reaching this task would make them wait on each other.
  for (let id = blockerId, hops = 0; id && hops < 100; hops++) {
    if (id === taskId) throw new HttpError(400, "They'd be waiting on each other");
    id = (await db.get("SELECT waiting_task_id FROM tasks WHERE id = ?", [id]))?.waiting_task_id;
  }
}

/** Open tasks blocked by this one, which it holds up until it's done. */
export const listBlockedBy = (householdId, taskId) =>
  db.all(
    "SELECT id, title FROM tasks WHERE household_id = ? AND waiting_task_id = ? AND status = 'open' AND deleted_at IS NULL ORDER BY created_at",
    [householdId, taskId],
  );

/**
 * Statements that unblock everything this task was holding up (it was finished or deleted). Anything that was
 * also on the Waiting list goes back to To do, since what it was waiting for is now done.
 */
async function releaseStatements(actor, taskId, actorId) {
  const blocked = await listBlockedBy(actor.householdId, taskId);
  const ts = now();
  const backToTodo = (col, value) => `${col} = CASE WHEN list = 'waiting' THEN ${value} ELSE ${col} END`;
  return {
    ids: blocked.map((b) => b.id),
    statements: blocked.flatMap((b) => [
      {
        sql: `UPDATE tasks SET waiting_task_id = NULL, ${backToTodo("waiting_on", "NULL")}, ${backToTodo("waiting_since", "NULL")},
                ${backToTodo("list", "'todo'")}, updated_at = ? WHERE id = ?`,
        args: [ts, b.id],
      },
      activityStatement(actor.householdId, actorId, b.id, "unblocked", { by: taskId }),
    ]),
  };
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
  if ("waitingTaskId" in input) out.waiting_task_id = input.waitingTaskId || null;
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
  await assertBlocker(actor.householdId, null, fields.waiting_task_id);
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
  if (fields.waiting_task_id) await assertBlocker(actor.householdId, id, fields.waiting_task_id);
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
  const released = done ? await releaseStatements(actor, id, actorId) : { ids: [], statements: [] };
  const statements = [
    {
      sql: "UPDATE tasks SET status = ?, completed_at = ?, completed_by = ?, updated_at = ? WHERE id = ?",
      args: done ? ["done", ts, actorId, ts, id] : ["open", null, null, ts, id],
    },
    activityStatement(actor.householdId, actorId, id, done ? "completed" : "reopened"),
    ...released.statements,
  ];
  await db.batch(statements);
  for (const taskId of [id, ...released.ids]) changed(actor.householdId, taskId, { fromGoogle });

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
  // Deleting a task also unblocks whatever was waiting on it.
  const released = await releaseStatements(actor, id, fromGoogle ? null : actor.id);
  await db.batch([
    { sql: "UPDATE tasks SET deleted_at = ?, updated_at = ? WHERE id = ?", args: [ts, ts, id] },
    activityStatement(actor.householdId, fromGoogle ? null : actor.id, id, "deleted"),
    ...released.statements,
  ]);
  for (const taskId of [id, ...released.ids]) changed(actor.householdId, taskId, { fromGoogle });
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

/** Tasks finished since `since` (an ISO time) and still done, oldest first: just who and when. */
export async function listCompletedSince(householdId, since) {
  return db.all(
    `SELECT id, title, completed_by, completed_at FROM tasks
      WHERE household_id = ? AND status = 'done' AND completed_at >= ? AND deleted_at IS NULL AND is_template = 0
      ORDER BY completed_at, id`,
    [householdId, since],
  );
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
