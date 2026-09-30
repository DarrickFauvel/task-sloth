import { db, newId, now } from "../db/client.js";
import { encrypt, hashPassword, verifyPassword } from "../lib/crypto.js";
import { HttpError } from "../lib/http.js";

export const getUser = (id) => db.get("SELECT * FROM users WHERE id = ?", [id]);

/** Colors a member can pick for their avatar and the dot beside their tasks. */
export const MEMBER_COLORS = ["#6d5dfc", "#e0527a", "#1f9d8b", "#e38b1b", "#3a86ff", "#8d6e63", "#7cb342"];

/** Names for the colors, for screen readers and tooltips. */
export const MEMBER_COLOR_NAMES = {
  "#6d5dfc": "Purple", "#e0527a": "Pink", "#1f9d8b": "Teal", "#e38b1b": "Orange",
  "#3a86ff": "Blue", "#8d6e63": "Brown", "#7cb342": "Green",
};

/** Changes just the member's color (Settings saves it as soon as a swatch is picked). */
export async function updateColor(userId, color) {
  if (!MEMBER_COLORS.includes(color)) throw new HttpError(400, "Pick one of the colors");
  await db.run("UPDATE users SET color = ? WHERE id = ?", [color, userId]);
}

/** Updates the name housemates see (and type after @) and the member's color. */
export async function updateProfile(userId, { name, color }) {
  name = String(name ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  if (!name) throw new HttpError(400, "Your name can't be empty");
  if (!MEMBER_COLORS.includes(color)) throw new HttpError(400, "Pick one of the colors");
  await db.run("UPDATE users SET name = ?, color = ? WHERE id = ?", [name, color, userId]);
}

/** Creates or updates a user from their Google profile and stores their (encrypted) tokens. */
export async function upsertGoogleUser(profile, tokens) {
  const existing = await db.get("SELECT * FROM users WHERE google_sub = ?", [profile.sub]);
  const expires = new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000).toISOString();
  const refresh = tokens.refresh_token ? encrypt(tokens.refresh_token) : existing?.google_refresh_token ?? null;
  if (existing) {
    await db.run(
      `UPDATE users SET email = ?, name = ?, avatar_url = ?, google_refresh_token = ?, google_access_token = ?,
              google_token_expires_at = ?, google_sync_error = NULL WHERE id = ?`,
      [profile.email, profile.name ?? profile.email, profile.picture ?? null, refresh, encrypt(tokens.access_token), expires, existing.id],
    );
    return existing.id;
  }
  const id = newId();
  await db.run(
    `INSERT INTO users (id, google_sub, email, name, avatar_url, google_refresh_token, google_access_token, google_token_expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, profile.sub, profile.email, profile.name ?? profile.email, profile.picture ?? null, refresh, encrypt(tokens.access_token), expires, now()],
  );
  return id;
}

/** Local-only fake users for development (DEV_LOGIN=1). */
export async function upsertDevUser(handle) {
  const sub = `dev:${handle}`;
  const existing = await db.get("SELECT id FROM users WHERE google_sub = ?", [sub]);
  if (existing) return existing.id;
  const id = newId();
  const name = handle.replace(/^./, (c) => c.toUpperCase());
  await db.run("INSERT INTO users (id, google_sub, email, name, created_at) VALUES (?, ?, ?, ?, ?)", [
    id, sub, `${handle}@example.test`, name, now(),
  ]);
  return id;
}

export async function disconnectGoogle(userId) {
  await db.batch([
    {
      sql: `UPDATE users SET google_refresh_token = NULL, google_access_token = NULL, google_token_expires_at = NULL,
                   google_list_id = NULL, google_last_pull = NULL, google_sync_error = NULL WHERE id = ?`,
      args: [userId],
    },
    { sql: "DELETE FROM google_links WHERE user_id = ?", args: [userId] },
  ]);
}

// --- Username/email + password accounts ---------------------------------------------------

const USERNAME_RE = /^[a-z0-9_.-]{3,30}$/i; // no "@", so sign-in can tell a username from an email
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Checks and normalizes sign-up fields; throws a 400 with a message for the form. */
export function validateSignup({ username, email, password }) {
  username = String(username ?? "").trim();
  email = String(email ?? "").trim().toLowerCase();
  password = String(password ?? "");
  if (!USERNAME_RE.test(username)) throw new HttpError(400, "Username must be 3–30 letters, numbers, dots, dashes or underscores");
  if (email.length > 254 || !EMAIL_RE.test(email)) throw new HttpError(400, "Enter a valid email address");
  if (password.length < 8) throw new HttpError(400, "Password must be at least 8 characters");
  if (password.length > 200) throw new HttpError(400, "Password must be at most 200 characters");
  return { username, email, password };
}

export async function createPasswordUser(input) {
  const { username, email, password } = validateSignup(input);
  if (await db.get("SELECT 1 FROM users WHERE username = ? COLLATE NOCASE", [username])) {
    throw new HttpError(400, "That username is taken");
  }
  if (await db.get("SELECT 1 FROM users WHERE email = ? COLLATE NOCASE AND password_hash IS NOT NULL", [email])) {
    throw new HttpError(400, "There's already an account with that email");
  }
  const id = newId();
  try {
    await db.run(
      "INSERT INTO users (id, email, name, username, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [id, email, username, username, await hashPassword(password), now()],
    );
  } catch (err) {
    // Lost a race with a simultaneous sign-up for the same name or email.
    if (/UNIQUE/i.test(String(err?.message))) throw new HttpError(400, "That username or email is already in use");
    throw err;
  }
  return id;
}

// Compared against when no account matches, so a wrong username takes as long as a wrong password.
const DUMMY_HASH = hashPassword("not-a-real-password");

/** Returns the user id for a username-or-email and password, or null. */
export async function verifyLogin(identifier, password) {
  identifier = String(identifier ?? "").trim();
  password = String(password ?? "");
  const column = identifier.includes("@") ? "email" : "username";
  const user = identifier
    ? await db.get(`SELECT id, password_hash FROM users WHERE ${column} = ? COLLATE NOCASE AND password_hash IS NOT NULL`, [identifier])
    : null;
  const ok = await verifyPassword(password, user?.password_hash ?? (await DUMMY_HASH));
  return user && ok ? user.id : null;
}
