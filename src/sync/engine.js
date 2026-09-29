// Two-way sync between Task Sloth and each member's "Task Sloth" list in Google Tasks.
//
// Push: every app change to a task enqueues it; the queue mirrors the task (and its
//       checklist, as subtasks) into the *assignee's* Google list, moving it between
//       accounts when it is reassigned.
// Pull: Google Tasks has no webhooks, so we poll each member's list with updatedMin
//       and apply completions/edits/deletions made in Google (last write wins).
import { db, now } from "../db/client.js";
import { GoogleApiError } from "../google/tasks-api.js";
import { NotConnectedError } from "../google/tokens.js";
import { getHouseholdForUser } from "../services/household.js";
import * as checklist from "../services/checklist.js";
import * as tasks from "../services/tasks.js";
import { todayIn } from "../../public/js/lib/dates.js";
import { googleToItemFields, googleToTaskFields, itemToGoogle, shouldApplyRemote, taskToGoogle } from "./mapping.js";

const MAX_ATTEMPTS = 8;
const isNotFound = (err) => err instanceof GoogleApiError && (err.status === 404 || err.status === 410);

/**
 * @param {{ api: ReturnType<import("../google/tasks-api.js").createTasksApi>, appUrl: string, listTitle: string, log?: (...a: any[]) => void }} deps
 */
export function createSyncEngine({ api, appUrl, listTitle, log = console.log }) {
  let processing = null;

  async function enqueue(taskId) {
    await db.run(
      `INSERT INTO sync_queue (task_id, enqueued_at) VALUES (?, ?)
       ON CONFLICT(task_id) DO UPDATE SET enqueued_at = excluded.enqueued_at, attempts = 0, last_error = NULL`,
      [taskId, now()],
    );
  }

  /** Queues every open task assigned to the user, e.g. right after they connect Google. */
  async function enqueueAllForUser(userId) {
    const rows = await db.all(
      "SELECT id FROM tasks WHERE assignee_id = ? AND status = 'open' AND deleted_at IS NULL AND is_template = 0",
      [userId],
    );
    for (const r of rows) await enqueue(r.id);
  }

  /** Finds or creates the user's "Task Sloth" list in Google Tasks. */
  async function ensureList(userId) {
    const user = await db.get("SELECT google_list_id FROM users WHERE id = ?", [userId]);
    if (user?.google_list_id) return user.google_list_id;
    const lists = await api.listLists(userId);
    const existing = (lists.items ?? []).find((l) => l.title === listTitle);
    const list = existing ?? (await api.insertList(userId, listTitle));
    await db.run("UPDATE users SET google_list_id = ?, google_sync_error = NULL WHERE id = ?", [list.id, userId]);
    return list.id;
  }

  /** Called when a list we knew about has vanished (user deleted it in Google). */
  async function resetList(userId) {
    await db.batch([
      { sql: "UPDATE users SET google_list_id = NULL, google_last_pull = NULL WHERE id = ?", args: [userId] },
      { sql: "DELETE FROM google_links WHERE user_id = ?", args: [userId] },
    ]);
    await enqueueAllForUser(userId);
  }

  const saveLink = (type, entityId, userId, taskId, g) =>
    db.run(
      `INSERT INTO google_links (entity_type, entity_id, user_id, task_id, google_task_id, google_updated, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(entity_type, entity_id) DO UPDATE SET user_id = excluded.user_id, google_task_id = excluded.google_task_id,
         google_updated = excluded.google_updated, synced_at = excluded.synced_at`,
      [type, entityId, userId, taskId, g.id, g.updated ?? null, now()],
    );

  async function removeRemote(link) {
    const user = await db.get("SELECT google_list_id, google_refresh_token FROM users WHERE id = ?", [link.user_id]);
    if (user?.google_list_id && user.google_refresh_token) {
      try {
        await api.deleteTask(link.user_id, user.google_list_id, link.google_task_id);
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
    }
  }

  /** Mirrors one task (and its checklist) into its assignee's Google list. */
  async function pushTask(taskId) {
    const task = await db.get(
      `SELECT t.*, p.name AS project_name, p.emoji AS project_emoji,
              (SELECT COUNT(*) FROM checklist_items c WHERE c.task_id = t.id) AS item_count,
              (SELECT COUNT(*) FROM checklist_items c WHERE c.task_id = t.id AND c.checked = 1) AS item_done
         FROM tasks t LEFT JOIN projects p ON p.id = t.project_id WHERE t.id = ?`,
      [taskId],
    );
    let link = await db.get("SELECT * FROM google_links WHERE entity_type = 'task' AND entity_id = ?", [taskId]);
    const target =
      task && !task.deleted_at && !task.is_template && task.assignee_id
        ? await db.get("SELECT id FROM users WHERE id = ? AND google_refresh_token IS NOT NULL", [task.assignee_id])
        : null;

    // Unassigned, deleted, or moved to someone else: remove it from the old owner's list.
    if (link && link.user_id !== target?.id) {
      await removeRemote(link); // Google deletes the subtasks along with the parent.
      await db.run("DELETE FROM google_links WHERE task_id = ?", [taskId]);
      link = null;
    }
    if (!target) return;

    const listId = await ensureList(target.id);
    const body = taskToGoogle(task, { appUrl });
    let remote;
    if (link) {
      try {
        remote = await api.patchTask(target.id, listId, link.google_task_id, body);
      } catch (err) {
        if (!isNotFound(err)) throw err;
        await db.run("DELETE FROM google_links WHERE task_id = ?", [taskId]);
        link = null;
      }
    }
    if (!link) remote = await api.insertTask(target.id, listId, body);
    await saveLink("task", taskId, target.id, taskId, remote);

    // Checklist items become subtasks.
    const items = await db.all("SELECT * FROM checklist_items WHERE task_id = ? ORDER BY sort_order", [taskId]);
    const itemLinks = new Map(
      (await db.all("SELECT * FROM google_links WHERE entity_type = 'item' AND task_id = ?", [taskId])).map((l) => [l.entity_id, l]),
    );
    let previous = null;
    for (const item of items) {
      const itemLink = itemLinks.get(item.id);
      itemLinks.delete(item.id);
      let g = null;
      if (itemLink && item.updated_at <= itemLink.synced_at) {
        previous = itemLink.google_task_id;
        continue; // unchanged since last sync
      }
      if (itemLink) {
        try {
          g = await api.patchTask(target.id, listId, itemLink.google_task_id, itemToGoogle(item));
        } catch (err) {
          if (!isNotFound(err)) throw err;
        }
      }
      g ??= await api.insertTask(target.id, listId, itemToGoogle(item), { parent: remote.id, previous });
      await saveLink("item", item.id, target.id, taskId, g);
      previous = g.id;
    }
    // Links left over belong to items deleted in the app.
    for (const orphan of itemLinks.values()) {
      await removeRemote(orphan);
      await db.run("DELETE FROM google_links WHERE entity_type = 'item' AND entity_id = ?", [orphan.entity_id]);
    }
  }

  /** Pushes everything in the queue. Safe to call often; concurrent calls share one run. */
  function processQueue() {
    processing ??= (async () => {
      try {
        const queued = await db.all("SELECT * FROM sync_queue WHERE attempts < ? ORDER BY enqueued_at", [MAX_ATTEMPTS]);
        for (const q of queued) {
          try {
            await pushTask(q.task_id);
            await db.run("DELETE FROM sync_queue WHERE task_id = ? AND enqueued_at = ?", [q.task_id, q.enqueued_at]);
          } catch (err) {
            if (err instanceof NotConnectedError) {
              await db.run("DELETE FROM sync_queue WHERE task_id = ?", [q.task_id]);
            } else {
              log(`google push failed for task ${q.task_id}:`, err.message);
              await db.run("UPDATE sync_queue SET attempts = attempts + 1, last_error = ? WHERE task_id = ?", [String(err.message), q.task_id]);
              if (err instanceof GoogleApiError && err.status === 404) {
                const t = await db.get("SELECT assignee_id FROM tasks WHERE id = ?", [q.task_id]);
                if (t?.assignee_id) await resetList(t.assignee_id);
              }
            }
          }
        }
      } finally {
        processing = null;
      }
    })();
    return processing;
  }

  /** Applies changes made in one user's Google list since the last pull. */
  async function pullUser(userId) {
    const user = await db.get("SELECT * FROM users WHERE id = ?", [userId]);
    if (!user?.google_refresh_token || !user.google_list_id) return;
    const membership = await getHouseholdForUser(userId);
    if (!membership) return;
    const actor = { id: userId, householdId: membership.household.id };
    const today = todayIn(); // pull runs server-side; UTC is close enough for recurrence
    const startedAt = new Date(Date.now() - 5_000).toISOString();

    const remote = [];
    let pageToken;
    try {
      do {
        const page = await api.listTasks(userId, user.google_list_id, { updatedMin: user.google_last_pull ?? undefined, pageToken });
        remote.push(...(page.items ?? []));
        pageToken = page.nextPageToken;
      } while (pageToken);
    } catch (err) {
      if (isNotFound(err)) return resetList(userId);
      throw err;
    }

    // Parents before subtasks so new subtasks can find their task.
    remote.sort((a, b) => Boolean(a.parent) - Boolean(b.parent));
    for (const g of remote) {
      const link = await db.get("SELECT * FROM google_links WHERE user_id = ? AND google_task_id = ?", [userId, g.id]);
      if (link && link.google_updated === g.updated) continue; // our own write echoing back
      if (link?.entity_type === "task") await applyRemoteTask(actor, link, g, today);
      else if (link?.entity_type === "item") await applyRemoteItem(actor, link, g);
      else if (!g.deleted) await importRemote(actor, g, today);
    }
    await db.run("UPDATE users SET google_last_pull = ?, google_sync_error = NULL WHERE id = ?", [startedAt, userId]);
  }

  async function applyRemoteTask(actor, link, g, today) {
    const task = await db.get("SELECT * FROM tasks WHERE id = ?", [link.entity_id]);
    if (!task || task.deleted_at) return;
    if (!shouldApplyRemote({ remoteUpdated: g.updated, localUpdated: task.updated_at, lastSynced: link.synced_at })) {
      await enqueue(task.id); // app copy is newer; make Google match it
      return;
    }
    if (g.deleted) {
      await tasks.deleteTask(actor, task.id, { fromGoogle: true });
      await db.run("DELETE FROM google_links WHERE task_id = ?", [task.id]);
      return;
    }
    const f = googleToTaskFields(g);
    await tasks.updateTask(actor, task.id, { title: f.title, notes: f.notes, dueDate: f.dueDate }, { fromGoogle: true });
    await tasks.setDone(actor, task.id, f.done, { today, fromGoogle: true });
    await saveLink("task", task.id, link.user_id, task.id, g);
  }

  async function applyRemoteItem(actor, link, g) {
    const item = await db.get("SELECT * FROM checklist_items WHERE id = ?", [link.entity_id]);
    if (!item) return;
    if (!shouldApplyRemote({ remoteUpdated: g.updated, localUpdated: item.updated_at, lastSynced: link.synced_at })) {
      await enqueue(item.task_id);
      return;
    }
    if (g.deleted) {
      await checklist.deleteItem(actor, item.id, { fromGoogle: true });
      await db.run("DELETE FROM google_links WHERE entity_type = 'item' AND entity_id = ?", [item.id]);
      return;
    }
    const f = googleToItemFields(g);
    await checklist.updateItem(actor, item.id, { text: f.text, quantity: f.quantity }, { fromGoogle: true });
    await checklist.setItemChecked(actor, item.id, f.checked, { fromGoogle: true });
    await saveLink("item", item.id, link.user_id, item.task_id, g);
  }

  /** A task added directly in the user's "Task Sloth" Google list becomes an app task assigned to them. */
  async function importRemote(actor, g, today) {
    if (g.parent) {
      const parent = await db.get("SELECT task_id FROM google_links WHERE user_id = ? AND google_task_id = ? AND entity_type = 'task'", [actor.id, g.parent]);
      if (!parent) return;
      const f = googleToItemFields(g);
      const itemId = await checklist.addItem(actor, parent.task_id, { text: f.text, quantity: f.quantity, checked: f.checked }, { fromGoogle: true });
      await saveLink("item", itemId, actor.id, parent.task_id, g);
      return;
    }
    const f = googleToTaskFields(g);
    const id = await tasks.createTask(actor, { title: f.title, notes: f.notes, dueDate: f.dueDate, assigneeId: actor.id }, { fromGoogle: true });
    if (f.done) await tasks.setDone(actor, id, true, { today, fromGoogle: true });
    await saveLink("task", id, actor.id, id, g);
  }

  async function pullAll() {
    const users = await db.all("SELECT id FROM users WHERE google_refresh_token IS NOT NULL AND google_list_id IS NOT NULL");
    for (const u of users) {
      try {
        await pullUser(u.id);
      } catch (err) {
        if (!(err instanceof NotConnectedError)) {
          log(`google pull failed for user ${u.id}:`, err.message);
          await db.run("UPDATE users SET google_sync_error = ? WHERE id = ?", [`Last sync failed: ${err.message}`, u.id]);
        }
      }
    }
  }

  async function syncNow() {
    await processQueue();
    await pullAll();
    await processQueue();
  }

  return { enqueue, enqueueAllForUser, ensureList, pushTask, processQueue, pullUser, pullAll, syncNow };
}
