import { db, newId, now } from "../db/client.js";
import { randomToken } from "../lib/crypto.js";
import { HttpError } from "../lib/http.js";

const MEMBER_COLORS = ["#6d5dfc", "#e0527a", "#1f9d8b", "#e38b1b"];

export async function getHouseholdForUser(userId) {
  const household = await db.get(
    "SELECT h.* FROM households h JOIN memberships m ON m.household_id = h.id WHERE m.user_id = ?",
    [userId],
  );
  if (!household) return null;
  const members = await db.all(
    `SELECT u.id, u.name, u.email, u.avatar_url, u.color, u.google_list_id, u.google_sync_error,
            (u.google_refresh_token IS NOT NULL) AS google_connected
       FROM users u JOIN memberships m ON m.user_id = u.id
      WHERE m.household_id = ? ORDER BY m.joined_at`,
    [household.id],
  );
  return { household, members };
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

export async function renameHousehold(householdId, name) {
  if (!name.trim()) throw new HttpError(400, "Name can't be empty");
  await db.run("UPDATE households SET name = ? WHERE id = ?", [name.trim().slice(0, 80), householdId]);
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
