import { db, newId, now } from "../db/client.js";
import { HttpError } from "../lib/http.js";
import { cleanCoords, distanceMeters } from "../../public/js/lib/places.js";

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

/** A where/how can have this many spots (every branch of a shop nearby, say). */
export const MAX_SPOTS = 20;
/** A new spot this close to one the where/how already has is the same shop: it updates that one instead. */
export const SAME_SPOT_METERS = 75;

/**
 * Adds a spot on the map to a where/how (see migrations/013): from "I'm here now" (no label) or an address search
 * (the address as the label). Spots are the household's, like the where/hows themselves.
 * @returns {Promise<"added" | "updated">}
 */
export async function addSpot(householdId, contextId, { lat, lng, label = null }) {
  const coords = cleanCoords(lat, lng);
  if (!coords) throw new HttpError(400, "That place couldn't be read. Try again.");
  const context = await getContext(householdId, contextId);
  label = String(label ?? "").replace(/\s+/g, " ").trim().slice(0, 200) || null;
  const spots = await db.all("SELECT id, lat, lng FROM context_spots WHERE context_id = ?", [contextId]);
  const same = spots.find((s) => distanceMeters(s, coords) <= SAME_SPOT_METERS);
  if (same) {
    await db.run("UPDATE context_spots SET lat = ?, lng = ?, label = ? WHERE id = ?", [coords.lat, coords.lng, label, same.id]);
    return "updated";
  }
  if (spots.length >= MAX_SPOTS) throw new HttpError(400, `${context.name} already has ${MAX_SPOTS} spots. Remove one first.`);
  await db.run("INSERT INTO context_spots (id, context_id, lat, lng, label, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [newId(), contextId, coords.lat, coords.lng, label, now()]);
  return "added";
}

export async function removeSpot(householdId, spotId) {
  const spot = await db.get(
    "SELECT s.id FROM context_spots s JOIN contexts cx ON cx.id = s.context_id WHERE s.id = ? AND cx.household_id = ?",
    [spotId, householdId],
  );
  if (!spot) throw new HttpError(404, "Spot not found");
  await db.run("DELETE FROM context_spots WHERE id = ?", [spotId]);
}

/** Every spot in the household, oldest first: { id, context_id, lat, lng, label, created_at }. */
export const listSpots = (householdId) =>
  db.all(
    `SELECT s.id, s.context_id, s.lat, s.lng, s.label, s.created_at FROM context_spots s JOIN contexts cx ON cx.id = s.context_id
      WHERE cx.household_id = ? ORDER BY s.created_at, s.id`,
    [householdId],
  );

/**
 * The household's spots, for "Near you": each with its where/how and how many open to-dos are there (anyone's;
 * Waiting on, Maybe later and tasks blocked by another don't count, since they can't be done yet).
 */
export async function listPlaces(householdId) {
  const rows = await db.all(
    `SELECT s.id, cx.id AS context_id, cx.name, s.lat, s.lng,
            (SELECT COUNT(*) FROM tasks t
              WHERE t.context_id = cx.id AND t.deleted_at IS NULL AND t.is_template = 0 AND t.status = 'open' AND t.list = 'todo'
                AND NOT EXISTS (SELECT 1 FROM tasks b WHERE b.id = t.waiting_task_id AND b.status = 'open' AND b.deleted_at IS NULL)) AS count
       FROM context_spots s JOIN contexts cx ON cx.id = s.context_id
      WHERE cx.household_id = ? ORDER BY cx.name COLLATE NOCASE, s.created_at`,
    [householdId],
  );
  return rows.map((r) => ({ ...r, count: Number(r.count) }));
}
