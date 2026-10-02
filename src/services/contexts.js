import { db, newId, now } from "../db/client.js";
import { HttpError } from "../lib/http.js";
import { cleanCoords } from "../../public/js/lib/places.js";

export async function listContexts(householdId) {
  return db.all(
    `SELECT cx.*,
            (SELECT COUNT(*) FROM tasks t
              WHERE t.context_id = cx.id AND t.deleted_at IS NULL AND t.is_template = 0 AND t.status = 'open') AS open_count
       FROM contexts cx WHERE cx.household_id = ? ORDER BY cx.name COLLATE NOCASE`,
    [householdId],
  );
}

export async function getContext(householdId, id) {
  const context = await db.get("SELECT * FROM contexts WHERE id = ? AND household_id = ?", [id, householdId]);
  if (!context) throw new HttpError(404, "Context not found");
  return context;
}

/**
 * Returns the id of the household's context with this name (any case), creating it if needed.
 * New contexts get each word capitalised: "home depot" -> "Home Depot" (and "IKEA" stays "IKEA").
 */
export async function ensureContext(householdId, name) {
  name = String(name ?? "").replace(/\s+/g, " ").trim().slice(0, 80).replace(/(^|\s)(\p{L})/gu, (_, s, c) => s + c.toUpperCase());
  if (!name) throw new HttpError(400, "Context needs a name");
  await db.run(
    "INSERT INTO contexts (id, household_id, name, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
    [newId(), householdId, name, now()],
  );
  const row = await db.get("SELECT id FROM contexts WHERE household_id = ? AND name = ? COLLATE NOCASE", [householdId, name]);
  return row.id;
}

/**
 * Gives a where/how a spot on the map (see migrations/012): from "I'm here now" (no label) or an address search
 * (the address as the label). Places are the household's, like the where/hows themselves.
 */
export async function setPlace(householdId, id, { lat, lng, label = null }) {
  const coords = cleanCoords(lat, lng);
  if (!coords) throw new HttpError(400, "That place couldn't be read. Try again.");
  await getContext(householdId, id);
  label = String(label ?? "").replace(/\s+/g, " ").trim().slice(0, 200) || null;
  await db.run("UPDATE contexts SET place_lat = ?, place_lng = ?, place_label = ? WHERE id = ? AND household_id = ?",
    [coords.lat, coords.lng, label, id, householdId]);
}

export async function clearPlace(householdId, id) {
  await getContext(householdId, id);
  await db.run("UPDATE contexts SET place_lat = NULL, place_lng = NULL, place_label = NULL WHERE id = ? AND household_id = ?", [id, householdId]);
}

/**
 * The household's where/hows that are places, for "Near you": each with how many open to-dos are there
 * (anyone's; Waiting on, Maybe later and tasks blocked by another don't count, since they can't be done yet).
 */
export async function listPlaces(householdId) {
  const rows = await db.all(
    `SELECT cx.id, cx.name, cx.place_lat AS lat, cx.place_lng AS lng,
            (SELECT COUNT(*) FROM tasks t
              WHERE t.context_id = cx.id AND t.deleted_at IS NULL AND t.is_template = 0 AND t.status = 'open' AND t.list = 'todo'
                AND NOT EXISTS (SELECT 1 FROM tasks b WHERE b.id = t.waiting_task_id AND b.status = 'open' AND b.deleted_at IS NULL)) AS count
       FROM contexts cx WHERE cx.household_id = ? AND cx.place_lat IS NOT NULL ORDER BY cx.name COLLATE NOCASE`,
    [householdId],
  );
  return rows.map((r) => ({ ...r, count: Number(r.count) }));
}
