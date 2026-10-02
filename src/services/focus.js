// Focus sessions: one person works through a project's or a where/how's tasks, one at a time (views/pages/focus.eta).
// The task on screen is the one they're "working on now" (startWorking), so the household sees it as usual, and
// everyone's lists say who is focusing on what (focusLines).
//
// Which tasks: open To do tasks there that are yours or nobody's, not blocked, and not something someone else is
// doing right now. "Skip" sends one to the back; "Not today" leaves it out of this session (and hands a task the
// session made yours back to nobody). A session ends when you end it, start another, or your day ends.
import { db, newId, now } from "../db/client.js";
import { HttpError } from "../lib/http.js";
import { changed } from "./changes.js";
import { getContext } from "./contexts.js";
import { getProject } from "./projects.js";
import { getTask, isWorking, listTasks, setDone, startWorking, stopWorking, updateTask } from "./tasks.js";

/** @typedef {import("./tasks.js").Actor} Actor */

const ids = (json) => {
  try {
    const list = JSON.parse(json ?? "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
};

/** This person's session that's still on, or null. */
export async function getFocus(actor) {
  const row = await db.get(
    "SELECT * FROM focus_sessions WHERE household_id = ? AND user_id = ? AND ended_at IS NULL AND until > ? ORDER BY started_at DESC LIMIT 1",
    [actor.householdId, actor.id, now()],
  );
  return row ? { ...row, skipped: ids(row.skipped), set_aside: ids(row.set_aside), claimed: ids(row.claimed) } : null;
}

/** What a session is about: { kind: "project" | "context", id, name, emoji? }. */
export async function sessionTarget(householdId, { project_id, context_id }) {
  if (project_id) {
    const p = await getProject(householdId, project_id);
    return { kind: "project", id: p.id, name: p.name, emoji: p.emoji };
  }
  const c = await getContext(householdId, context_id);
  return { kind: "context", id: c.id, name: c.name };
}

/** Whether `task` can be in `userId`'s session (leaving aside which project or place it's in). */
export function eligible(task, userId, at = now()) {
  return (
    task.status === "open" &&
    task.list === "todo" &&
    (!task.assignee_id || task.assignee_id === userId) &&
    !(task.waiting_task_id && task.waiting_task_status === "open") &&
    !(task.working_by && task.working_by !== userId && isWorking(task, at))
  );
}

/** The session's tasks in the order they'll come up: the list's usual order, then skipped ones in the order skipped. */
export async function sessionQueue(actor, session) {
  const tasks = await listTasks(actor.householdId, {
    status: "open",
    list: "todo",
    ...(session.project_id ? { projectId: session.project_id } : { contextId: session.context_id }),
  });
  const at = now();
  const open = tasks.filter((t) => eligible(t, actor.id, at) && !session.set_aside.includes(t.id));
  const skippedAt = (t) => session.skipped.indexOf(t.id);
  return [...open.filter((t) => skippedAt(t) < 0), ...open.filter((t) => skippedAt(t) >= 0).sort((a, b) => skippedAt(a) - skippedAt(b))];
}

/** How many of the session's tasks this person has finished since it started. */
export async function sessionDone(actor, session) {
  const column = session.project_id ? "project_id" : "context_id";
  const row = await db.get(
    `SELECT COUNT(*) AS n FROM tasks WHERE household_id = ? AND ${column} = ? AND status = 'done' AND completed_by = ?
       AND completed_at >= ? AND deleted_at IS NULL`,
    [actor.householdId, session.project_id ?? session.context_id, actor.id, session.started_at],
  );
  return Number(row?.n ?? 0);
}

async function save(session, fields) {
  const cols = Object.keys(fields);
  await db.run(
    `UPDATE focus_sessions SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`,
    [...cols.map((c) => (Array.isArray(fields[c]) ? JSON.stringify(fields[c]) : fields[c])), session.id],
  );
  Object.assign(session, fields);
  changed(session.household_id); // everyone's "focusing on" line
}

/**
 * Puts the first task in the queue on screen: you're working on it now. A task nobody had becomes yours, and the
 * session remembers that, so setting it aside hands it back.
 */
async function advance(actor, session) {
  const [next] = await sessionQueue(actor, session);
  if (!next) return null;
  if (!(next.working_by === actor.id && isWorking(next))) {
    const { claimed } = await startWorking(actor, next.id, { until: session.until });
    if (claimed) await save(session, { claimed: [...session.claimed, next.id] });
  }
  return next.id;
}

/**
 * Starts a session on a project or a where/how (`target`: { projectId } or { contextId }), ending any other one
 * of yours. `until` (ISO) is the end of your day.
 */
export async function startFocus(actor, target, { until }) {
  const projectId = target.projectId || null;
  const contextId = projectId ? null : target.contextId || null;
  if (projectId) await getProject(actor.householdId, projectId).catch(() => { throw new HttpError(400, "Unknown project"); });
  else if (contextId) await getContext(actor.householdId, contextId).catch(() => { throw new HttpError(400, "Unknown where / how"); });
  else throw new HttpError(400, "Pick a project or a where / how");
  const ts = now();
  await db.batch([
    { sql: "UPDATE focus_sessions SET ended_at = ? WHERE household_id = ? AND user_id = ? AND ended_at IS NULL", args: [ts, actor.householdId, actor.id] },
    {
      sql: "INSERT INTO focus_sessions (id, household_id, user_id, project_id, context_id, started_at, until) VALUES (?, ?, ?, ?, ?, ?, ?)",
      args: [newId(), actor.householdId, actor.id, projectId, contextId, ts, until],
    },
  ]);
  const session = await getFocus(actor);
  if (session) await advance(actor, session);
  changed(actor.householdId);
  return session;
}

/** The task must be the one on screen (or at least in the queue), so an old page can't act on the wrong task. */
async function inQueue(actor, session, taskId) {
  const queue = await sessionQueue(actor, session);
  if (!queue.some((t) => t.id === taskId)) throw new HttpError(409, "That task isn't up in your session any more");
}

/** Done: finishes it and brings up the next one. Returns setDone's next repeat, if any. */
export async function completeInSession(actor, session, taskId, { today }) {
  await inQueue(actor, session, taskId);
  const nextRepeat = await setDone(actor, taskId, true, { today });
  await advance(actor, session);
  return nextRepeat;
}

/** Skip: to the back of the queue, and the next one comes up. */
export async function skipInSession(actor, session, taskId) {
  await inQueue(actor, session, taskId);
  await save(session, { skipped: [...session.skipped.filter((id) => id !== taskId), taskId] });
  const next = await advance(actor, session);
  // Skipping the only one left keeps it on screen; you're still on it.
  if (next !== taskId) await stopIfMine(actor, taskId);
}

/** Not today: out of this session. A task the session made yours goes back to nobody. */
export async function setAsideInSession(actor, session, taskId) {
  await inQueue(actor, session, taskId);
  await save(session, { set_aside: [...session.set_aside, taskId] });
  if (session.claimed.includes(taskId)) await updateTask(actor, taskId, { assigneeId: null });
  await stopIfMine(actor, taskId);
  await advance(actor, session);
}

async function stopIfMine(actor, taskId) {
  const task = await getTask(actor.householdId, taskId).catch(() => null);
  if (task?.working_by === actor.id) await stopWorking(actor, taskId);
}

/** Ends the session (and "working on now" for the task on screen). Returns how many it finished. */
export async function endFocus(actor, session) {
  const done = await sessionDone(actor, session);
  const [current] = await sessionQueue(actor, session);
  await save(session, { ended_at: now() });
  if (current) await stopIfMine(actor, current.id);
  return done;
}

/**
 * Every session on in the household, for the line at the top of the lists: who, on what, and how far along
 * ({ userId, target, done, total }).
 */
export async function householdSessions(householdId) {
  const rows = await db.all(
    "SELECT user_id FROM focus_sessions WHERE household_id = ? AND ended_at IS NULL AND until > ? GROUP BY user_id",
    [householdId, now()],
  );
  const lines = await Promise.all(
    rows.map(async ({ user_id }) => {
      const actor = { id: user_id, householdId };
      const session = await getFocus(actor);
      // A project or where/how that's gone since leaves nothing to show.
      const target = session && (await sessionTarget(householdId, session).catch(() => null));
      if (!target) return null;
      const [done, queue] = await Promise.all([sessionDone(actor, session), sessionQueue(actor, session)]);
      return { userId: user_id, target, done, total: done + queue.length };
    }),
  );
  return lines.filter(Boolean);
}

/**
 * Picks the session back up after you've been elsewhere: you're working on its first task again (say you'd
 * started something else meanwhile). Returns that task's id, or null when there's nothing left.
 */
export const resumeFocus = (actor, session) => advance(actor, session);

/**
 * What you could focus on: each project and where/how with tasks you could take on now, and how many
 * ({ kind, id, name, emoji?, count }), busiest first.
 */
export async function focusChoices(actor) {
  const tasks = await listTasks(actor.householdId, { status: "open", list: "todo" });
  const at = now();
  const counts = new Map();
  const bump = (key, make) => {
    if (!counts.has(key)) counts.set(key, { ...make(), count: 0 });
    counts.get(key).count++;
  };
  for (const t of tasks.filter((t) => eligible(t, actor.id, at))) {
    if (t.project_id) bump(`p:${t.project_id}`, () => ({ kind: "project", id: t.project_id, name: t.project_name, emoji: t.project_emoji }));
    if (t.context_id) bump(`c:${t.context_id}`, () => ({ kind: "context", id: t.context_id, name: t.context_name }));
  }
  const byCount = (a, b) => b.count - a.count || a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  const all = [...counts.values()];
  return { projects: all.filter((c) => c.kind === "project").sort(byCount), contexts: all.filter((c) => c.kind === "context").sort(byCount) };
}
