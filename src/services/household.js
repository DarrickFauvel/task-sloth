import { db, newId, now } from "../db/client.js";
import { randomToken } from "../lib/crypto.js";
import { HttpError } from "../lib/http.js";
import { MEMBER_COLORS } from "./users.js";


export async function getHouseholdForUser(userId) {
  const household = await db.get(
    "SELECT h.* FROM households h JOIN memberships m ON m.household_id = h.id WHERE m.user_id = ?",
    [userId],
  );
  if (!household) return null;
  const members = await db.all(
    `SELECT u.id, u.name, u.email, u.avatar_url, u.avatar_photo_at, u.color, u.google_list_id, u.google_sync_error,
            (u.google_refresh_token IS NOT NULL) AS google_connected
       FROM users u JOIN memberships m ON m.user_id = u.id
      WHERE m.household_id = ? ORDER BY m.joined_at`,
    [household.id],
  );
  // Nobody can leave a household, so the earliest member is the one who created it: its owner,
  // who alone can rename it.
  return { household, members, ownerId: members[0]?.id ?? null };
}

export async function createHousehold(userId, name) {
  if (await getHouseholdForUser(userId)) throw new HttpError(400, "You're already in a household");
  const id = newId();
  const ts = now();
  await db.batch([
    { sql: "INSERT INTO households (id, name, created_at) VALUES (?, ?, ?)", args: [id, name.trim() || "Our home", ts] },
    { sql: "INSERT INTO memberships (household_id, user_id, joined_at) VALUES (?, ?, ?)", args: [id, userId, ts] },
    { sql: "UPDATE users SET color = ? WHERE id = ?", args: [MEMBER_COLORS[0], userId] },
  ]);
  return id;
}

/** Renames the household. Only its owner (see getHouseholdForUser) may. */
export async function renameHousehold(userId, name) {
  const membership = await getHouseholdForUser(userId);
  if (!membership) throw new HttpError(400, "You're not in a household");
  if (membership.ownerId !== userId) throw new HttpError(403, "Only the person who set up the household can rename it");
  name = String(name ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!name) throw new HttpError(400, "The household needs a name");
  await db.run("UPDATE households SET name = ? WHERE id = ?", [name, membership.household.id]);
  return membership.household.id;
}

export async function createInvite(householdId, userId) {
  const token = randomToken(18);
  const expires = new Date(Date.now() + 7 * 86_400_000).toISOString();
  await db.run(
    "INSERT INTO invites (token, household_id, created_by, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
    [token, householdId, userId, expires, now()],
  );
  return token;
}

export async function getInvite(token) {
  const invite = await db.get(
    `SELECT i.*, h.name AS household_name, u.name AS inviter_name
       FROM invites i JOIN households h ON h.id = i.household_id JOIN users u ON u.id = i.created_by
      WHERE i.token = ?`,
    [token],
  );
  if (!invite || invite.used_by || invite.expires_at < now()) return null;
  return invite;
}

export async function acceptInvite(token, userId) {
  const invite = await getInvite(token);
  if (!invite) throw new HttpError(404, "This invite link has expired or was already used");
  const existing = await getHouseholdForUser(userId);
  if (existing?.household.id === invite.household_id) return invite.household_id;
  if (existing) throw new HttpError(400, "You're already in another household");
  const { n } = await db.get("SELECT COUNT(*) AS n FROM memberships WHERE household_id = ?", [invite.household_id]);
  await db.batch([
    { sql: "INSERT INTO memberships (household_id, user_id, joined_at) VALUES (?, ?, ?)", args: [invite.household_id, userId, now()] },
    { sql: "UPDATE invites SET used_by = ? WHERE token = ?", args: [userId, token] },
    { sql: "UPDATE users SET color = ? WHERE id = ?", args: [MEMBER_COLORS[Number(n) % MEMBER_COLORS.length], userId] },
  ]);
  return invite.household_id;
}
