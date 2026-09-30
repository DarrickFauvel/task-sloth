import { test } from "node:test";
import assert from "node:assert/strict";
import { shortcutGroups } from "../src/web/shortcuts.js";
import { parseQuickAdd } from "../public/js/lib/quick-add.js";

const who = (names) => shortcutGroups(names).find((g) => g.title === "Who").rows[0].tokens;
const allTokens = (groups) => groups.flatMap((g) => g.rows.flatMap((r) => r.tokens));

test("groups follow the questions you ask when adding a task", () => {
  assert.deepEqual(shortcutGroups().map((g) => g.title), ["When", "Who", "Where / how", "Group it", "Priority"]);
});

test("the @person examples are real housemates, as their first names", () => {
  assert.deepEqual(who(["Samantha Jones", "Alex"]), ["@me", "@samantha", "@alex", "@anyone"]);
  assert.deepEqual(who([]), ["@me", "@sam", "@anyone"], "a made-up name when you live alone");
  assert.deepEqual(who(["A", "B", "C"]), ["@me", "@a", "@b", "@anyone"], "at most two");
});

test("names are cut down to what an @name can contain", () => {
  assert.deepEqual(who(["Sam<img src=x>", "<script>"]), ["@me", "@sam", "@anyone"]);
});

test("every example token is understood by quick add", () => {
  const ctx = { today: "2026-09-30", meId: "u1", members: [{ id: "u1", name: "Me" }, { id: "u2", name: "Samantha" }] };
  for (const token of allTokens(shortcutGroups(["Samantha"]))) {
    const parsed = parseQuickAdd(`x ${token}`, ctx);
    assert.equal(parsed.title, "x", `"${token}" should be consumed, not left in the title`);
  }
});
