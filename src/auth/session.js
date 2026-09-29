import { db, now } from "../db/client.js";
import { config } from "../config.js";
import { randomToken, sha256 } from "../lib/crypto.js";
import { setCookie } from "../lib/http.js";

const COOKIE = "sloth_session";
const MAX_AGE_DAYS = 60;

export async function startSession(res, userId) {
  const token = randomToken();
  const expires = new Date(Date.now() + MAX_AGE_DAYS * 86_400_000).toISOString();
  await db.run("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)", [sha256(token), userId, expires, now()]);
  setCookie(res, COOKIE, token, { maxAge: MAX_AGE_DAYS * 86_400, secure: config.baseUrl.startsWith("https") });
}

/** Returns the signed-in user for this request, extending the session when it's past halfway. */
export async function loadSession(cookies) {
  const token = cookies[COOKIE];
  if (!token) return null;
  const row = await db.get(
    `SELECT s.id AS session_id, s.expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
    [sha256(token)],
  );
  if (!row || row.expires_at < now()) return null;
  delete row.password_hash; // req.user is passed to every template; keep the hash out of it
  const halfway = new Date(Date.now() + (MAX_AGE_DAYS / 2) * 86_400_000).toISOString();
  if (row.expires_at < halfway) {
    const expires = new Date(Date.now() + MAX_AGE_DAYS * 86_400_000).toISOString();
    await db.run("UPDATE sessions SET expires_at = ? WHERE id = ?", [expires, row.session_id]);
  }
  return row;
}

export async function endSession(res, cookies) {
  const token = cookies[COOKIE];
  if (token) await db.run("DELETE FROM sessions WHERE id = ?", [sha256(token)]);
  setCookie(res, COOKIE, "", { maxAge: 0 });
}
