import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, initDb } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { captureMail } from "../src/lib/mail.js";
import {
  cancelEmailChange, confirmEmail, describeLink, emailConfirmed, linkSent, maskEmail, resendConfirmation, sendVerifyEmail,
} from "../src/services/email-confirm.js";
import { createPasswordUser, getUser, updateSignIn, upsertDevUser, verifyLogin } from "../src/services/users.js";

const dir = mkdtempSync(join(tmpdir(), "task-sloth-email-"));
const outbox = captureMail();
const tokenIn = (message) => message.text.match(/token=([\w-]+)/)?.[1];
const lastTokenTo = (to) => tokenIn(outbox.findLast((m) => m.to === to));

before(async () => {
  initDb({ url: `file:${join(dir, "test.db")}` });
  await migrate({ log: () => {} });
});
beforeEach(() => outbox.splice(0));
after(() => rmSync(dir, { recursive: true, force: true }));

test("sign-up: the link confirms the email, once", async () => {
  const id = await createPasswordUser({ username: "robin", email: "robin@example.com", password: "long enough" });
  assert.equal(emailConfirmed(await getUser(id)), false);
  await sendVerifyEmail(await getUser(id));
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].to, "robin@example.com");
  assert.match(outbox[0].text, /\/email\/confirm\?token=/);

  const token = tokenIn(outbox[0]);
  assert.deepEqual(await describeLink(token), { email: "robin@example.com", purpose: "verify" }, "looking doesn't use it up");
  assert.equal(await confirmEmail(token), "robin@example.com");
  assert.equal(emailConfirmed(await getUser(id)), true);
  await assert.rejects(confirmEmail(token), /expired or was already used/);
  assert.equal(await describeLink(token), null);
});

test("only a hash of the token is stored", async () => {
  const id = await createPasswordUser({ username: "hash", email: "hash@example.com", password: "long enough" });
  await sendVerifyEmail(await getUser(id));
  const token = tokenIn(outbox[0]);
  const rows = await db.all("SELECT token_hash FROM email_tokens WHERE user_id = ?", [id]);
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].token_hash, token);
});

test("an email change waits for the new address, then swaps it in", async () => {
  const id = await createPasswordUser({ username: "kim", email: "kim@old.com", password: "long enough" });
  await updateSignIn(id, { username: "kim", email: "kim@new.com", password: "long enough" });
  const heads = outbox.find((m) => m.to === "kim@old.com");
  assert.match(heads.text, /k••@new\.com/, "the old address hears about it, without the full new one");
  assert.equal(await verifyLogin("kim@new.com", "long enough"), null, "not until it's confirmed");

  assert.equal(await confirmEmail(lastTokenTo("kim@new.com")), "kim@new.com");
  const u = await getUser(id);
  assert.equal(u.email, "kim@new.com");
  assert.equal(u.pending_email, null);
  assert.equal(emailConfirmed(u), true, "following the link proves the new address");
  assert.equal(await verifyLogin("kim@new.com", "long enough"), id);
  assert.equal(await verifyLogin("kim@old.com", "long enough"), null);
});

test("cancelling a change kills its link", async () => {
  const id = await createPasswordUser({ username: "lee", email: "lee@old.com", password: "long enough" });
  await updateSignIn(id, { username: "lee", email: "lee@new.com", password: "long enough" });
  const token = lastTokenTo("lee@new.com");
  await cancelEmailChange(id);
  await assert.rejects(confirmEmail(token), /expired or was already used/);
  assert.equal((await getUser(id)).email, "lee@old.com");
});

test("asking again replaces the earlier link", async () => {
  const id = await createPasswordUser({ username: "max", email: "max@old.com", password: "long enough" });
  await updateSignIn(id, { username: "max", email: "max@new.com", password: "long enough" });
  const first = lastTokenTo("max@new.com");
  assert.equal(await resendConfirmation(id), "max@new.com");
  const second = lastTokenTo("max@new.com");
  assert.notEqual(first, second);
  await assert.rejects(confirmEmail(first), /expired or was already used/);
  assert.equal(await confirmEmail(second), "max@new.com");
});

test("a sign-up link stops working once the email has changed", async () => {
  const id = await createPasswordUser({ username: "ned", email: "ned@one.com", password: "long enough" });
  await sendVerifyEmail(await getUser(id));
  const verify = lastTokenTo("ned@one.com");
  await updateSignIn(id, { username: "ned", email: "ned@two.com", password: "long enough" });
  await confirmEmail(lastTokenTo("ned@two.com"));
  await assert.rejects(confirmEmail(verify), /expired or was already used/);
});

test("links expire after a day", async () => {
  const id = await createPasswordUser({ username: "old", email: "old@example.com", password: "long enough" });
  await sendVerifyEmail(await getUser(id));
  await db.run("UPDATE email_tokens SET expires_at = ? WHERE user_id = ?", [new Date(Date.now() - 1000).toISOString(), id]);
  await assert.rejects(confirmEmail(tokenIn(outbox[0])), /expired/);
});

test("if someone else takes the address meanwhile, the change is refused", async () => {
  const id = await createPasswordUser({ username: "pat", email: "pat@old.com", password: "long enough" });
  await updateSignIn(id, { username: "pat", email: "shared@example.com", password: "long enough" });
  const token = lastTokenTo("shared@example.com");
  await createPasswordUser({ username: "quick", email: "shared@example.com", password: "long enough" });
  await assert.rejects(confirmEmail(token), /Another account/);
  assert.equal((await getUser(id)).email, "pat@old.com");
});

test("resending: nothing to do once confirmed, and Google/dev accounts never need it", async () => {
  const id = await createPasswordUser({ username: "done", email: "done@example.com", password: "long enough" });
  await sendVerifyEmail(await getUser(id));
  await confirmEmail(tokenIn(outbox[0]));
  await assert.rejects(resendConfirmation(id), /already confirmed/);
  const dev = await upsertDevUser("gus");
  assert.equal(emailConfirmed(await getUser(dev)), true);
  await assert.rejects(resendConfirmation(dev), /comes from Google/);
});

test("linkSent: only while a usable link is out (older accounts never got one)", async () => {
  const id = await createPasswordUser({ username: "vic", email: "vic@example.com", password: "long enough" });
  assert.equal(await linkSent(id, "vic@example.com"), false);
  await sendVerifyEmail(await getUser(id));
  assert.equal(await linkSent(id, "vic@example.com"), true);
  await confirmEmail(tokenIn(outbox[0]));
  assert.equal(await linkSent(id, "vic@example.com"), false);
});

test("maskEmail keeps the first letter and the domain", () => {
  assert.equal(maskEmail("sam@example.com"), "s••@example.com");
  assert.equal(maskEmail("a@b.co"), "a••@b.co");
  assert.equal(maskEmail("christopher@x.org"), "c••••••@x.org");
});
