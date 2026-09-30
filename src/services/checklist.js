import { db, now } from "../db/client.js";
import { HttpError } from "../lib/http.js";
import { parseChecklistInput, parseSingleItem } from "../../public/js/lib/checklist.js";
import { guessCategory } from "../../public/js/lib/groceries.js";
import { activityStatement } from "./activity.js";
import { changed } from "./changes.js";
import { getTask, itemInsert } from "./tasks.js";

export async function listItems(taskId) {
  return db.all("SELECT * FROM checklist_items WHERE task_id = ? ORDER BY sort_order, created_at", [taskId]);
}

/** Groups items by category (shopping mode) with checked items sinking to the bottom of each group. */
export function groupItems(items, mode) {
  const sorted = [...items].sort((a, b) => a.checked - b.checked || a.sort_order - b.sort_order);
  if (mode !== "shopping") return [{ name: null, items: sorted }];
  const groups = new Map();
  for (const item of sorted) {
    const name = item.category || "Other";
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(item);
  }
  // Groups with unchecked items first, "Other" last.
  return [...groups.entries()]
    .map(([name, items]) => ({ name, items }))
    .sort((a, b) =>
      a.items.every((i) => i.checked) - b.items.every((i) => i.checked) ||
      (a.name === "Other") - (b.name === "Other") ||
      a.name.localeCompare(b.name));
}

/** Adds items from free text ("milk, eggs, 2x bread"). Returns how many were added. */
export async function addItems(actor, taskId, input, { fromGoogle = false } = {}) {
  const task = await getTask(actor.householdId, taskId);
  const items = parseChecklistInput(input).slice(0, 200);
  if (items.length === 0) throw new HttpError(400, "Nothing to add");
  if (task.list_mode === "shopping") {
    for (const item of items) item.category ??= guessCategory(item.text);
  }
  const ts = now();
  await db.batch([
    ...items.map((item, i) => itemInsert(taskId, item, i, ts)),
    { sql: "UPDATE tasks SET updated_at = ? WHERE id = ?", args: [ts, taskId] },
    activityStatement(actor.householdId, fromGoogle ? null : actor.id, taskId, "checklist", { count: items.length }),
  ]);
  changed(actor.householdId, taskId, { fromGoogle });
  return items.length;
}

/** Adds one item verbatim (no comma splitting). Returns its id. */
export async function addItem(actor, taskId, { text, quantity = null, category = null, checked = false }, { fromGoogle = false } = {}) {
  await getTask(actor.householdId, taskId);
  const insert = itemInsert(taskId, { text, quantity, category }, 0);
  const id = insert.args[0];
  await db.batch([
    insert,
    ...(checked ? [{ sql: "UPDATE checklist_items SET checked = 1 WHERE id = ?", args: [id] }] : []),
  ]);
  changed(actor.householdId, taskId, { fromGoogle });
  return id;
}

async function getItem(actor, itemId) {
  const item = await db.get(
    "SELECT c.* FROM checklist_items c JOIN tasks t ON t.id = c.task_id WHERE c.id = ? AND t.household_id = ?",
    [itemId, actor.householdId],
  );
  if (!item) throw new HttpError(404, "Item not found");
  return item;
}

export async function setItemChecked(actor, itemId, checked, { fromGoogle = false } = {}) {
  const item = await getItem(actor, itemId);
  await db.run("UPDATE checklist_items SET checked = ?, checked_by = ?, updated_at = ? WHERE id = ?", [
    checked ? 1 : 0,
    checked && !fromGoogle ? actor.id : null,
    now(),
    itemId,
  ]);
  changed(actor.householdId, item.task_id, { fromGoogle });
  return item.task_id;
}

export async function updateItem(actor, itemId, { text, quantity, category }, { fromGoogle = false } = {}) {
  const item = await getItem(actor, itemId);
  await db.run("UPDATE checklist_items SET text = ?, quantity = ?, category = ?, updated_at = ? WHERE id = ?", [
    String(text ?? item.text).trim().slice(0, 300) || item.text,
    quantity === undefined ? item.quantity : quantity || null,
    category === undefined ? item.category : category || null,
    now(),
    itemId,
  ]);
  changed(actor.householdId, item.task_id, { fromGoogle });
}

export async function deleteItem(actor, itemId, { fromGoogle = false } = {}) {
  const item = await getItem(actor, itemId);
  await db.run("DELETE FROM checklist_items WHERE id = ?", [itemId]);
  changed(actor.householdId, item.task_id, { fromGoogle });
  return item.task_id;
}

/** "Reset list": uncheck everything so a weekly shopping list can be reused. */
export async function uncheckAll(actor, taskId) {
  await getTask(actor.householdId, taskId);
  await db.run("UPDATE checklist_items SET checked = 0, checked_by = NULL, updated_at = ? WHERE task_id = ?", [now(), taskId]);
  changed(actor.householdId, taskId);
}

export async function clearChecked(actor, taskId) {
  await getTask(actor.householdId, taskId);
  await db.run("DELETE FROM checklist_items WHERE task_id = ? AND checked = 1", [taskId]);
  changed(actor.householdId, taskId);
}

/**
 * The section a renamed item should be in. A section typed with the new name ("Pets: treats") wins.
 * A section the app guessed is guessed again from the new name, so "milk" renamed to "bread" moves
 * from Dairy to Bakery; one that differs from what the old name would have guessed was chosen by
 * someone, so it stays. (In checklist mode, items with no section keep none until the list becomes
 * a shopping list, which fills them in.)
 */
export function renamedCategory(item, parsed, mode) {
  if (parsed.category) return parsed.category;
  const wasGuessed = !item.category || item.category === guessCategory(item.text);
  if (!wasGuessed) return item.category;
  if (!item.category && mode !== "shopping") return null;
  return guessCategory(parsed.text);
}

/** Renames an item from its row. Returns its task, and the section it moved to on a shopping list (else null). */
export async function renameItem(actor, itemId, typed) {
  const item = await getItem(actor, itemId);
  const parsed = parseSingleItem(typed);
  if (!parsed) throw new HttpError(400, "Item needs a name");
  const task = await getTask(actor.householdId, item.task_id);
  const category = renamedCategory(item, parsed, task.list_mode);
  await updateItem(actor, itemId, { text: parsed.text, quantity: parsed.quantity, category: category ?? "" });
  const moved = task.list_mode === "shopping" && (category ?? null) !== (item.category ?? null);
  return { taskId: item.task_id, movedTo: moved ? category ?? "Other" : null };
}

/** Switching to shopping mode fills in store sections for uncategorised items. */
export async function autoCategorize(actor, taskId) {
  await getTask(actor.householdId, taskId);
  const items = await db.all("SELECT id, text FROM checklist_items WHERE task_id = ? AND category IS NULL", [taskId]);
  const updates = items
    .map((i) => ({ id: i.id, category: guessCategory(i.text) }))
    .filter((i) => i.category)
    .map((i) => ({ sql: "UPDATE checklist_items SET category = ? WHERE id = ?", args: [i.category, i.id] }));
  if (updates.length) await db.batch(updates);
}
