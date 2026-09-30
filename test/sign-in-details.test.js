import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, initDb } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { createPasswordUser, getUser, updateSignIn, upsertDevUser, verifyLogin } from "../src/services/users.js";
import { captureMail } from "../src/lib/mail.js";

const dir = mkdtempSync(join(tmpdir(), "task-sloth-signin-"));
let sam, alex;
const outbox = captureMail();

before(async () => {
  initDb({ url: `file:${join(dir, "test.db")}` });
  await migrate({ log: () => {} });
  sam = await createPasswordUser({ username: "sam", email: "sam@example.com", password: "correct horse" });
  alex = await createPasswordUser({ username: "alex", email: "alex@example.com", password: "battery staple" });
});
after(() => rmSync(dir, { recursive: true, force: true }));

test("with the right password, the username changes at once and a new email waits to be confirmed", async () => {
  const result = await updateSignIn(sam, { username: "sammy", email: " Sammy@Example.com ", password: "correct horse" });
  assert.deepEqual(result, { usernameChanged: true, pendingEmail: "sammy@example.com", cancelledEmail: false });
  const u = await getUser(sam);
  assert.equal(u.username, "sammy");
  assert.equal(u.email, "sam@example.com", "the old email stays until the new one is confirmed");
  assert.equal(u.pending_email, "sammy@example.com");
  assert.equal(await verifyLogin("sammy", "correct horse"), sam);
  assert.equal(await verifyLogin("sam@example.com", "correct horse"), sam);
  assert.equal(await verifyLogin("sam", "correct horse"), null, "the old username no longer signs in");
  assert.deepEqual(outbox.map((m) => m.to), ["sammy@example.com", "sam@example.com"], "a link to the new address, a heads-up to the old");
});

test("typing the current email back in cancels a pending change", async () => {
  const result = await updateSignIn(sam, { username: "sammy", email: "sam@example.com", password: "correct horse" });
  assert.deepEqual(result, { usernameChanged: false, pendingEmail: null, cancelledEmail: true });
  assert.equal((await getUser(sam)).pending_email, null);
});

test("a wrong password changes nothing and is flagged", async () => {
  await assert.rejects(updateSignIn(sam, { username: "hacker", email: "h@example.com", password: "guess" }), (err) => {
    assert.equal(err.wrongPassword, true);
    assert.match(err.message, /current password/);
    return true;
  });
  assert.equal((await getUser(sam)).username, "sammy");
});

test("someone else's username or email is refused, whatever the case", async () => {
  await assert.rejects(updateSignIn(sam, { username: "ALEX", email: "sammy@example.com", password: "correct horse" }), /username is taken/);
  await assert.rejects(updateSignIn(sam, { username: "sammy", email: "Alex@example.com", password: "correct horse" }), /already an account/);
});

test("bad values are refused before the password is even checked", async () => {
  await assert.rejects(updateSignIn(sam, { username: "a b", email: "sammy@example.com", password: "x" }), /Username must be/);
  await assert.rejects(updateSignIn(sam, { username: "sammy", email: "nope", password: "x" }), /valid email/);
});

test("Google and dev accounts have no sign-in details to change", async () => {
  const dev = await upsertDevUser("pat");
  await assert.rejects(updateSignIn(dev, { username: "pat", email: "p@example.com", password: "x" }), /sign in with Google/);
});
