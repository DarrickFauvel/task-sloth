import { db, newId, now } from "../db/client.js";

/**
 * Records something that happened. `actorId` is null when the change came from Google.
 * Returns a statement so callers can include it in a batch.
 */
export function activityStatement(householdId, actorId, taskId, verb, detail = null) {
  return {
    sql: "INSERT INTO activity (id, household_id, actor_id, task_id, verb, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    args: [newId(), householdId, actorId, taskId, verb, detail ? JSON.stringify(detail) : null, now()],
  };
}

export async function logActivity(...args) {
  const { sql, args: values } = activityStatement(...args);
  await db.run(sql, values);
}

/** Newest first. `since` (an ISO time) leaves out anything older. */
export async function listActivity(householdId, { taskId, since, limit = 50 } = {}) {
  const where = ["a.household_id = ?"];
  const args = [householdId];
  if (taskId) (where.push("a.task_id = ?"), args.push(taskId));
  if (since) (where.push("a.created_at >= ?"), args.push(since));
  const rows = await db.all(
    `SELECT a.*, t.title AS task_title, t.deleted_at AS task_deleted_at
       FROM activity a LEFT JOIN tasks t ON t.id = a.task_id
      WHERE ${where.join(" AND ")}
      ORDER BY a.created_at DESC LIMIT ?`,
    [...args, limit],
  );
  return rows.map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : {} }));
}

/** Human sentence for an activity row, e.g. "Sam reassigned “Groceries” to you". */
export function describeActivity(a, ctx) {
  const { actor, action, sentence } = activityParts(a, ctx);
  return sentence ?? `${actor} ${action}`;
}

/**
 * An activity row split into who and what, so several of one person's actions can share a sentence ("Sam added
 * and completed …"): `actor` ("You", "Sam", "Google Tasks") and `action` ("added", "assigned to Sam"). Rows that
 * aren't anyone's doing ("Ready to go:") have a whole `sentence` instead.
 */
export function activityParts(a, { membersById, meId }) {
  const who = (id) => (id === meId ? "you" : (membersById[id]?.name.split(" ")[0] ?? "someone"));
  const actor = a.actor_id ? who(a.actor_id).replace(/^you$/, "You") : "Google Tasks";
  const d = a.detail ?? {};
  const did = (action) => ({ actor, action, sentence: null });
  switch (a.verb) {
    case "created": return did("added");
    case "completed": return did("completed");
    case "reopened": return did("reopened");
    case "assigned":
      if (!d.to) return did("put up for grabs");
      if (d.to === a.actor_id) return did("claimed");
      return did(`assigned to ${who(d.to)}`);
    case "updated": return did("edited");
    case "deleted": return did("deleted");
    case "restored": return did("restored");
    case "commented": return did("commented on");
    case "photo": return did("added a photo to");
    case "checklist": return did(`added ${d.count} item${d.count === 1 ? "" : "s"} to`);
    case "recurred": return { actor: null, action: null, sentence: "Next occurrence scheduled for" };
    case "unblocked": return { actor: null, action: null, sentence: "Ready to go:" };
    case "snoozed": return did("snoozed");
    case "reset": return did(a.actor_id === meId ? "did your weekly reset" : "did their weekly reset");
    default: return did(a.verb);
  }
}
