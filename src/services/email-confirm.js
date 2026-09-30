// Confirming email addresses for password accounts, by a link sent to the address:
// - at sign-up (purpose "verify"): the account works straight away; confirming just marks the email as checked.
// - on an email change (purpose "change"): the new address waits in users.pending_email and only replaces
//   users.email once its link is followed; the old address gets a heads-up.
// Links work once, for LINK_TTL_MS. Only a sha256 of each token is stored. Following a link shows a page with
// a Confirm button (a POST), so mail scanners that open links can't use them up.

import { createHash, randomBytes } from "node:crypto";
import { config } from "../config.js";
import { db, now } from "../db/client.js";
import { HttpError } from "../lib/http.js";
import { renderEmail } from "../lib/email-layout.js";
import { sendMail } from "../lib/mail.js";

export const LINK_TTL_MS = 24 * 3_600_000;

const hash = (token) => createHash("sha256").update(String(token)).digest("hex");

/** Password accounts have an email to confirm; Google and dev accounts count as confirmed. */
export const isPasswordAccount = (user) => Boolean(user?.username);
export const emailConfirmed = (user) => !isPasswordAccount(user) || Boolean(user.email_verified_at);

/** "sam@example.com" -> "s••@example.com", for mentioning an address to someone who may not own it. */
export function maskEmail(email) {
  const [local, domain] = String(email).split("@");
  return `${local.slice(0, 1)}${"•".repeat(Math.max(2, Math.min(local.length - 1, 6)))}@${domain}`;
}

/** Makes a fresh link for `email` (older unused links of the same purpose stop working) and returns its URL. */
async function newLink(userId, email, purpose) {
  const token = randomBytes(32).toString("base64url");
  const ts = now();
  await db.batch([
    { sql: "UPDATE email_tokens SET used_at = ? WHERE user_id = ? AND purpose = ? AND used_at IS NULL", args: [ts, userId, purpose] },
    {
      sql: "INSERT INTO email_tokens (token_hash, user_id, email, purpose, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      args: [hash(token), userId, email, purpose, new Date(Date.now() + LINK_TTL_MS).toISOString(), ts],
    },
  ]);
  return `${config.baseUrl}/email/confirm?token=${token}`;
}

/** Sends one email; if the mail server won't take it, says so in words a form can show. */
async function deliver(message) {
  try {
    await sendMail(message);
  } catch (err) {
    console.error("couldn't send email", err);
    throw new HttpError(502, "We couldn't send the email just now. Try again in a minute.");
  }
}

const EXPIRY_NOTE = "The button works once, for the next 24 hours.";

/** Sends the sign-up confirmation link to the account's current email. */
export async function sendVerifyEmail(user) {
  const link = await newLink(user.id, user.email, "verify");
  await deliver({
    to: user.email,
    subject: "Confirm your email for Task Sloth",
    ...renderEmail({
      preview: "One tap to confirm this is your email.",
      heading: "Confirm your email",
      paragraphs: [`Hi ${user.name},`, `Tap the button to confirm that **${user.email}** is your email for Task Sloth.`],
      button: { href: link, label: "Confirm email" },
      footnote: `${EXPIRY_NOTE} If you didn't make a Task Sloth account, you can ignore this email.`,
    }),
  });
}

/** The link that confirms a new email, sent when the change is asked for and again on request. */
async function sendChangeLink(user, newEmail) {
  const link = await newLink(user.id, newEmail, "change");
  await deliver({
    to: newEmail,
    subject: "Confirm your new email for Task Sloth",
    ...renderEmail({
      preview: "Confirm this address to start signing in with it.",
      heading: "Confirm your new email",
      paragraphs: [
        `Hi ${user.name},`,
        `The Task Sloth account **@${user.username}** wants to use **${newEmail}** from now on. Tap the button to confirm it.`,
        "Until you do, you still sign in with your old email.",
      ],
      button: { href: link, label: "Confirm new email" },
      footnote: `${EXPIRY_NOTE} If this wasn't you, ignore this email and nothing changes.`,
    }),
  });
}

/**
 * Starts an email change: remembers the new address as pending, sends it a confirmation link, and tells
 * the old address. The caller has already checked the password and that the address is free.
 */
export async function requestEmailChange(user, newEmail) {
  await db.run("UPDATE users SET pending_email = ? WHERE id = ?", [newEmail, user.id]);
  await sendChangeLink(user, newEmail);
  await deliver({
    to: user.email,
    subject: "Your Task Sloth email is changing",
    ...renderEmail({
      preview: `A change to ${maskEmail(newEmail)} was asked for.`,
      heading: "Your email is changing",
      paragraphs: [
        `Hi ${user.name},`,
        `Someone signed in as **@${user.username}** asked to change the account's email to **${maskEmail(newEmail)}**. It changes only once that address confirms it.`,
        "If this wasn't you, open Settings and choose Cancel change under Account.",
      ],
      button: { href: `${config.baseUrl}/settings#account-title`, label: "Open Settings" },
    }),
  });
}

/** Sends the pending change's link again, or else the sign-up one if the email isn't confirmed yet. */
export async function resendConfirmation(userId) {
  const user = await db.get("SELECT * FROM users WHERE id = ?", [userId]);
  if (!isPasswordAccount(user)) throw new HttpError(400, "Your email comes from Google, so there's nothing to confirm");
  if (user.pending_email) {
    await sendChangeLink(user, user.pending_email);
    return user.pending_email;
  }
  if (user.email_verified_at) throw new HttpError(400, "Your email is already confirmed");
  await sendVerifyEmail(user);
  return user.email;
}

export async function cancelEmailChange(userId) {
  await db.batch([
    { sql: "UPDATE users SET pending_email = NULL WHERE id = ?", args: [userId] },
    { sql: "UPDATE email_tokens SET used_at = ? WHERE user_id = ? AND purpose = 'change' AND used_at IS NULL", args: [now(), userId] },
  ]);
}

/** The link's details if it can still be used, else null. Doesn't use it up. */
async function usableLink(token) {
  const row = token ? await db.get("SELECT * FROM email_tokens WHERE token_hash = ?", [hash(token)]) : null;
  if (!row || row.used_at || row.expires_at <= now()) return null;
  const user = await db.get("SELECT id, email, pending_email FROM users WHERE id = ?", [row.user_id]);
  // A change link is only good while that address is still the pending one (not cancelled or replaced).
  if (!user || (row.purpose === "change" && user.pending_email !== row.email) || (row.purpose === "verify" && user.email !== row.email)) return null;
  return row;
}

/** Whether a usable link for `email` is out there (so pages can say "we sent a link" or offer to send one). */
export async function linkSent(userId, email) {
  const row = await db.get(
    "SELECT 1 FROM email_tokens WHERE user_id = ? AND email = ? AND used_at IS NULL AND expires_at > ?",
    [userId, email, now()],
  );
  return Boolean(row);
}

/** For the page a link opens: which address it confirms, or null if the link is used, old or unknown. */
export async function describeLink(token) {
  const row = await usableLink(token);
  return row ? { email: row.email, purpose: row.purpose } : null;
}

/** Follows a link: marks the email confirmed, or swaps in the pending one. Returns the confirmed address. */
export async function confirmEmail(token) {
  const row = await usableLink(token);
  if (!row) throw new HttpError(400, "That link has expired or was already used");
  const ts = now();
  const used = { sql: "UPDATE email_tokens SET used_at = ? WHERE token_hash = ?", args: [ts, row.token_hash] };
  if (row.purpose === "verify") {
    await db.batch([used, { sql: "UPDATE users SET email_verified_at = ? WHERE id = ?", args: [ts, row.user_id] }]);
    return row.email;
  }
  if (await db.get("SELECT 1 FROM users WHERE email = ? COLLATE NOCASE AND password_hash IS NOT NULL AND id != ?", [row.email, row.user_id])) {
    throw new HttpError(400, "Another account started using that email in the meantime");
  }
  try {
    await db.batch([
      used,
      { sql: "UPDATE users SET email = ?, pending_email = NULL, email_verified_at = ? WHERE id = ?", args: [row.email, ts, row.user_id] },
    ]);
  } catch (err) {
    if (/UNIQUE/i.test(String(err?.message))) throw new HttpError(400, "Another account started using that email in the meantime");
    throw err;
  }
  return row.email;
}
