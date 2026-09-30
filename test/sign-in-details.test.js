import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, initDb } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { createPasswordUser, getUser, updateSignIn, upsertDevUser, verifyLogin } from "../src/services/users.js";

const dir = mkdtempSync(join(tmpdir(), "task-sloth-signin-"));
let sam, alex;

before(async () => {
  initDb({ url: `file:${join(dir, "test.db")}` });
  await migrate({ log: () => {} });
  sam = await createPasswordUser({ username: "sam", email: "sam@example.com", password: "correct horse" });
  alex = await createPasswordUser({ username: "alex", email: "alex@example.com", password: "battery staple" });
});
after(() => rmSync(dir, { recursive: true, force: true }));

test("with the right password, username and email change, and sign-in follows them", async () => {
  assert.equal(await updateSignIn(sam, { username: "sammy", email: " Sammy@Example.com ", password: "correct horse" }), true);
  const u = await getUser(sam);
  assert.equal(u.username, "sammy");
  assert.equal(u.email, "sammy@example.com");
  assert.equal(await verifyLogin("sammy", "correct horse"), sam);
  assert.equal(await verifyLogin("sammy@example.com", "correct horse"), sam);
  assert.equal(await verifyLogin("sam", "correct horse"), null, "the old username no longer signs in");
});

test("saving with nothing changed is fine and says so", async () => {
  assert.equal(await updateSignIn(sam, { username: "sammy", email: "sammy@example.com", password: "correct horse" }), false);
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
