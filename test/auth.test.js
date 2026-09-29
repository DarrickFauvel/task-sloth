import { test } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword } from "../src/lib/crypto.js";
import { createRateLimit } from "../src/lib/rate-limit.js";
import { validateSignup } from "../src/services/users.js";

test("hashPassword round-trips and salts each hash", async () => {
  const a = await hashPassword("correct horse");
  const b = await hashPassword("correct horse");
  assert.match(a, /^scrypt\$16384\$8\$1\$[\w-]+\$[\w-]+$/);
  assert.notEqual(a, b);
  assert.equal(await verifyPassword("correct horse", a), true);
  assert.equal(await verifyPassword("correct horsE", a), false);
  assert.equal(await verifyPassword("", a), false);
});

test("verifyPassword normalizes Unicode so the same password typed differently still matches", async () => {
  const hash = await hashPassword("café-pass"); // é as one code point
  assert.equal(await verifyPassword("café-pass", hash), true); // e + combining accent
});

test("verifyPassword rejects missing or malformed hashes", async () => {
  assert.equal(await verifyPassword("x", null), false);
  assert.equal(await verifyPassword("x", ""), false);
  assert.equal(await verifyPassword("x", "bcrypt$whatever"), false);
});

test("rate limit allows `limit` hits per window, per key", () => {
  let t = 0;
  const rl = createRateLimit({ limit: 2, windowMs: 1000, now: () => t });
  assert.equal(rl.isLimited("a"), false);
  rl.hit("a");
  assert.equal(rl.isLimited("a"), false);
  rl.hit("a");
  assert.equal(rl.isLimited("a"), true);
  assert.equal(rl.isLimited("b"), false, "keys are independent");
  t = 1000;
  assert.equal(rl.isLimited("a"), false, "a new window starts fresh");
  rl.hit("a");
  assert.equal(rl.isLimited("a"), false, "and counts from zero");
});

test("rate limit reset clears a key", () => {
  const rl = createRateLimit({ limit: 1, windowMs: 1000, now: () => 0 });
  rl.hit("a");
  assert.equal(rl.isLimited("a"), true);
  rl.reset("a");
  assert.equal(rl.isLimited("a"), false);
});

const valid = { username: "sam_k", email: "Sam@Example.com ", password: "hunter22!" };
const rejects = (fields, message) => assert.throws(() => validateSignup({ ...valid, ...fields }), { status: 400, message });

test("validateSignup normalizes valid input", () => {
  assert.deepEqual(validateSignup({ ...valid, username: "  sam_k " }), { username: "sam_k", email: "sam@example.com", password: "hunter22!" });
});

test("validateSignup rejects bad usernames", () => {
  rejects({ username: "sa" }, /Username/);
  rejects({ username: "a".repeat(31) }, /Username/);
  rejects({ username: "sam k" }, /Username/);
  rejects({ username: "sam@home" }, /Username/);
  rejects({ username: undefined }, /Username/);
});

test("validateSignup rejects bad emails and passwords", () => {
  rejects({ email: "not-an-email" }, /email/);
  rejects({ email: "a@b" }, /email/);
  rejects({ email: `${"a".repeat(250)}@b.co` }, /email/);
  rejects({ password: "short" }, /at least 8/);
  rejects({ password: "x".repeat(201) }, /at most 200/);
});
