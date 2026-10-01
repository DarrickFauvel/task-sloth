import { db, newId, now } from "../db/client.js";
import { encrypt, hashPassword, verifyPassword } from "../lib/crypto.js";
import { checkNewPassword } from "../lib/passwords.js";
import { cancelEmailChange, requestEmailChange } from "./email-confirm.js";
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

function cleanName(name) {
  name = String(name ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  if (!name) throw new HttpError(400, "Your name can't be empty");
  return name;
}

/** Updates the name housemates see (and type after @). Returns it as saved (spaces tidied). */
export async function updateName(userId, name) {
  name = cleanName(name);
  await db.run("UPDATE users SET name = ? WHERE id = ?", [name, userId]);
  return name;
}

/** Updates the name and the color together: Settings' form without script. */
export async function updateProfile(userId, { name, color }) {
  name = cleanName(name);
  if (!MEMBER_COLORS.includes(color)) throw new HttpError(400, "Pick one of the colors");
  await db.run("UPDATE users SET name = ?, color = ? WHERE id = ?", [name, color, userId]);
}

// --- Avatar photos ---------------------------------------------------------------------------

/** The largest photo we keep. Settings shrinks it to 256×256 in the browser, which is far smaller. */
export const AVATAR_MAX_BYTES = 512 * 1024;

/** The image type of `bytes` from its first few bytes, or null if it isn't a JPEG, PNG or WebP. */
export function imageType(bytes) {
  const b = Buffer.from(bytes ?? []);
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length > 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

/** Saves the member's own photo, replacing any earlier one. */
export async function setAvatarPhoto(userId, bytes) {
  const type = imageType(bytes);
  if (!type) throw new HttpError(400, "That isn't a JPEG, PNG or WebP image");
  if (bytes.length > AVATAR_MAX_BYTES) throw new HttpError(400, "That photo is too big");
  const ts = now();
  await db.batch([
    {
      sql: `INSERT INTO avatar_photos (user_id, image, content_type, updated_at) VALUES (?, ?, ?, ?)
            ON CONFLICT (user_id) DO UPDATE SET image = excluded.image, content_type = excluded.content_type, updated_at = excluded.updated_at`,
      args: [userId, new Uint8Array(bytes), type, ts],
    },
    { sql: "UPDATE users SET avatar_photo_at = ? WHERE id = ?", args: [ts, userId] },
  ]);
}

/** Drops the member's own photo; their avatar goes back to their Google picture or initial. */
export async function removeAvatarPhoto(userId) {
  await db.batch([
    { sql: "DELETE FROM avatar_photos WHERE user_id = ?", args: [userId] },
    { sql: "UPDATE users SET avatar_photo_at = NULL WHERE id = ?", args: [userId] },
  ]);
}

/** A member's photo for someone who may see it (themselves or a housemate), or undefined. */
export async function getAvatarPhoto(viewerId, userId) {
  const row = await db.get(
    `SELECT p.image, p.content_type FROM avatar_photos p
      WHERE p.user_id = ? AND (p.user_id = ? OR EXISTS (
        SELECT 1 FROM memberships a JOIN memberships b ON a.household_id = b.household_id
         WHERE a.user_id = ? AND b.user_id = p.user_id))`,
    [userId, viewerId, viewerId],
  );
  return row && { image: Buffer.from(row.image), type: row.content_type };
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

function cleanUsername(username) {
  username = String(username ?? "").trim();
  if (!USERNAME_RE.test(username)) throw new HttpError(400, "Username must be 3–30 letters, numbers, dots, dashes or underscores");
  return username;
}

function cleanEmail(email) {
  email = String(email ?? "").trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) throw new HttpError(400, "Enter a valid email address");
  return email;
}

/** Checks and normalizes sign-up fields; throws a 400 with a message for the form. */
export function validateSignup({ username, email, password }) {
  username = cleanUsername(username);
  email = cleanEmail(email);
  password = checkNewPassword(password);
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

/**
 * Changes a password account's username and email (and, if one is typed, its password), after checking its current password (so a phone
 * left signed in can't be used to take the account over). Google and dev accounts have neither to change.
 * A new username applies at once. A new email only starts a change: it's confirmed by a link sent to it
 * (see email-confirm.js), and the account keeps signing in with the old one until then. Typing the current
 * email back in cancels a pending change.
 * Throws a 400 with a message for the form; `wrongPassword` is set when that was the problem.
 * @returns {Promise<{ usernameChanged: boolean, pendingEmail: string | null, cancelledEmail: boolean, passwordChanged: boolean }>}
 */
export async function updateSignIn(userId, { username, email, password, newPassword = "", newPasswordAgain = "", keepSession = null }) {
  const user = await db.get("SELECT * FROM users WHERE id = ?", [userId]);
  if (!user?.password_hash) throw new HttpError(400, "You sign in with Google, so there's no username or email to change here");
  username = cleanUsername(username);
  email = cleanEmail(email);
  // A new password is optional; when one is typed, it's checked before anything else changes.
  const changingPassword = Boolean(String(newPassword ?? "") || String(newPasswordAgain ?? ""));
  if (changingPassword) newPassword = checkNewPassword(newPassword, newPasswordAgain);
  if (!(await verifyPassword(String(password ?? ""), user.password_hash))) {
    throw Object.assign(new HttpError(400, "That isn't your current password"), { wrongPassword: true });
  }
  // Every other device is signed out (whoever knew the old one shouldn't stay in); this one stays.
  if (changingPassword) {
    await db.batch([
      { sql: "UPDATE users SET password_hash = ? WHERE id = ?", args: [await hashPassword(newPassword), userId] },
      { sql: "DELETE FROM sessions WHERE user_id = ? AND id IS NOT ?", args: [userId, keepSession] },
    ]);
  }
  const usernameChanged = username !== user.username;
  const emailChanged = email !== user.email.toLowerCase();
  if (usernameChanged && (await db.get("SELECT 1 FROM users WHERE username = ? COLLATE NOCASE AND id != ?", [username, userId]))) {
    throw new HttpError(400, "That username is taken");
  }
  if (emailChanged && (await db.get("SELECT 1 FROM users WHERE email = ? COLLATE NOCASE AND password_hash IS NOT NULL AND id != ?", [email, userId]))) {
    throw new HttpError(400, "There's already an account with that email");
  }
  if (usernameChanged) {
    try {
      await db.run("UPDATE users SET username = ? WHERE id = ?", [username, userId]);
    } catch (err) {
      // Lost a race with someone else taking the same name.
      if (/UNIQUE/i.test(String(err?.message))) throw new HttpError(400, "That username is taken");
      throw err;
    }
  }
  if (emailChanged) {
    await requestEmailChange({ ...user, username }, email);
    return { usernameChanged, pendingEmail: email, cancelledEmail: false, passwordChanged: changingPassword };
  }
  const cancelledEmail = Boolean(user.pending_email);
  if (cancelledEmail) await cancelEmailChange(userId);
  return { usernameChanged, pendingEmail: null, cancelledEmail, passwordChanged: changingPassword };
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
