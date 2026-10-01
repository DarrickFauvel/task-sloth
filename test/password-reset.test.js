import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, initDb } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { captureMail } from "../src/lib/mail.js";
import { confirmEmail, describeLink, describeResetLink, emailConfirmed, requestPasswordReset, resetPassword } from "../src/services/email-confirm.js";
import { createPasswordUser, getUser, upsertDevUser, verifyLogin } from "../src/services/users.js";

const dir = mkdtempSync(join(tmpdir(), "task-sloth-reset-"));
const outbox = captureMail();
const tokenIn = (message) => message.text.match(/token=([\w-]+)/)?.[1];
let id;

before(async () => {
  initDb({ url: `file:${join(dir, "test.db")}` });
  await migrate({ log: () => {} });
  id = await createPasswordUser({ username: "robin", email: "robin@example.com", password: "old password" });
});
beforeEach(() => outbox.splice(0));
after(() => rmSync(dir, { recursive: true, force: true }));

test("a reset link goes to the account's email, by username or email; nobody else gets one", async () => {
  await requestPasswordReset("Robin");
  await requestPasswordReset("ROBIN@example.com");
  assert.deepEqual(outbox.map((m) => m.to), ["robin@example.com", "robin@example.com"]);
  assert.match(outbox[0].text, /\/password\/reset\?token=/);
  assert.match(outbox[0].subject, /Reset your Task Sloth password/);

  outbox.splice(0);
  await requestPasswordReset("nobody");
  await requestPasswordReset("nobody@example.com");
  await requestPasswordReset("");
  await upsertDevUser("devvy");
  await requestPasswordReset("devvy");
  assert.equal(outbox.length, 0, "no account, or not a password account: nothing sent");
});

test("only the newest link works, and only for resetting", async () => {
  await requestPasswordReset("robin");
  await requestPasswordReset("robin");
  const [older, newer] = outbox.map(tokenIn);
  assert.equal(await describeResetLink(older), null, "asking again retires the older link");
  assert.deepEqual(await describeResetLink(newer), { username: "robin" });
  assert.equal(await describeLink(newer), null, "the confirm-email page won't take it");
  await assert.rejects(confirmEmail(newer), /expired or was already used/);
});

test("the new password is checked, then replaces the old one once, signs everyone out and confirms the email", async () => {
  await requestPasswordReset("robin");
  const token = tokenIn(outbox[0]);
  await assert.rejects(resetPassword(token, "short", "short"), /at least 8/);
  await assert.rejects(resetPassword(token, "new password", "new passw0rd"), /don't match/);
  await db.run("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES ('s1', ?, '2099-01-01', '2026-01-01')", [id]);

  assert.equal(await resetPassword(token, "new password", "new password"), id);
  assert.equal(await verifyLogin("robin", "new password"), id);
  assert.equal(await verifyLogin("robin", "old password"), null);
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?", [id])).n, 0);
  assert.equal(emailConfirmed(await getUser(id)), true);
  await assert.rejects(resetPassword(token, "another one", "another one"), /expired or was already used/);
});

test("a link stops working once it's old, or the account's email has changed", async () => {
  await requestPasswordReset("robin");
  const token = tokenIn(outbox[0]);
  await db.run("UPDATE email_tokens SET expires_at = ? WHERE purpose = 'reset' AND used_at IS NULL", [new Date(Date.now() - 1000).toISOString()]);
  assert.equal(await describeResetLink(token), null);

  outbox.splice(0);
  await requestPasswordReset("robin");
  const fresh = tokenIn(outbox[0]);
  await db.run("UPDATE users SET email = 'robin@new.example' WHERE id = ?", [id]);
  assert.equal(await describeResetLink(fresh), null);
  await db.run("UPDATE users SET email = 'robin@example.com' WHERE id = ?", [id]);
});
