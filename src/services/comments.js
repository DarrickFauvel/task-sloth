import { db, now } from "../db/client.js";
import { HttpError } from "../lib/http.js";
import { changed } from "./changes.js";

// Comments on a task (adding one is addComment in tasks.js, which assigning-with-a-note also uses). Only the author
// can delete theirs, and a delete can be undone. Each person's last look at a task's comments (comment_reads) lets
// task rows mark comments someone else left since.

/** One comment of this household's, or a 404. */
async function getComment(householdId, id) {
  const c = await db.get(
    "SELECT c.*, t.household_id FROM comments c JOIN tasks t ON t.id = c.task_id WHERE c.id = ? AND t.household_id = ?",
    [id, householdId],
  );
  if (!c) throw new HttpError(404, "Comment not found");
  return c;
}

/** Deletes your own comment (it stays restorable). @returns the comment */
export async function deleteComment(actor, id) {
  const c = await getComment(actor.householdId, id);
  if (c.author_id !== actor.id) throw new HttpError(403, "You can only delete your own comments");
  await db.run("UPDATE comments SET deleted_at = ? WHERE id = ?", [now(), id]);
  changed(actor.householdId, c.task_id);
  return c;
}

/** Undoes deleteComment. @returns the comment */
export async function restoreComment(actor, id) {
  const c = await getComment(actor.householdId, id);
  if (c.author_id !== actor.id) throw new HttpError(403, "You can only restore your own comments");
  await db.run("UPDATE comments SET deleted_at = NULL WHERE id = ?", [id]);
  changed(actor.householdId, c.task_id);
  return c;
}

/** This person has now seen the task's comments (opening the task page, or it updating while open). */
export async function markCommentsSeen(userId, taskId, at = now()) {
  await db.run(
    "INSERT INTO comment_reads (user_id, task_id, seen_at) VALUES (?, ?, ?) ON CONFLICT (user_id, task_id) DO UPDATE SET seen_at = excluded.seen_at",
    [userId, taskId, at],
  );
}

/** Ids of the household's tasks with comments from someone else that this person hasn't seen. */
export async function tasksWithNewComments(householdId, userId) {
  const rows = await db.all(
    `SELECT DISTINCT c.task_id FROM comments c
       JOIN tasks t ON t.id = c.task_id
       LEFT JOIN comment_reads r ON r.task_id = c.task_id AND r.user_id = ?
      WHERE t.household_id = ? AND c.deleted_at IS NULL AND c.author_id != ? AND (r.seen_at IS NULL OR c.created_at > r.seen_at)`,
    [userId, householdId, userId],
  );
  return new Set(rows.map((r) => r.task_id));
}
