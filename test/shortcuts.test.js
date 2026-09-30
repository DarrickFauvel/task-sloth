import { test } from "node:test";
import assert from "node:assert/strict";
import { shortcutRows } from "../src/web/shortcuts.js";
import { parseQuickAdd } from "../public/js/lib/quick-add.js";

const people = (names) => shortcutRows(names).find((r) => r.tokens.includes("@me")).tokens;

test("the @person examples are real housemates, as their first names", () => {
  assert.deepEqual(people(["Samantha Jones", "Alex"]), ["@me", "@samantha", "@alex", "@anyone"]);
  assert.deepEqual(people([]), ["@me", "@sam", "@anyone"], "a made-up name when you live alone");
  assert.deepEqual(people(["A", "B", "C"]), ["@me", "@a", "@b", "@anyone"], "at most two");
});

test("names are cut down to what an @name can contain", () => {
  assert.deepEqual(people(["Sam<img src=x>", "<script>"]), ["@me", "@sam", "@anyone"]);
});

test("every example token is understood by quick add", () => {
  const ctx = { today: "2026-09-30", meId: "u1", members: [{ id: "u1", name: "Me" }, { id: "u2", name: "Samantha" }] };
  for (const row of shortcutRows(["Samantha"])) {
    for (const token of row.tokens) {
      const parsed = parseQuickAdd(`x ${token}`, ctx);
      assert.equal(parsed.title, "x", `"${token}" should be consumed, not left in the title`);
    }
  }
});
