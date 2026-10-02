import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_SUGGESTIONS, shortcutName, suggestAt } from "../public/js/lib/suggest.js";
import { parseQuickAdd } from "../public/js/lib/quick-add.js";

const today = "2026-10-02"; // a Friday
const data = {
  me: "u1",
  members: [{ id: "u1", name: "Alice" }, { id: "u2", name: "Sam Lee", color: "#0f0" }],
  projects: [{ name: "Weekly shop", emoji: "🛒" }, { name: "Birthday", emoji: "🎂" }],
  contexts: [{ name: "Target" }, { name: "Home Depot" }, { name: "Joe's & Co" }],
  tags: ["errand", "kids"],
};
const at = (value, caret = value.length) => suggestAt(value, caret, data, today);
const inserts = (value, caret) => at(value, caret)?.items.map((s) => s.insert) ?? [];

test("@ suggests people first, then where / hows", () => {
  assert.deepEqual(inserts("call grandma @"), ["@me", "@sam", "@anyone", "@Target", "@Home-Depot", '@"Joe\'s & Co"']);
  assert.deepEqual(inserts("call @s"), ["@sam"]);
  assert.deepEqual(inserts("buy paint @dep"), ["@Home-Depot"], "any word of a name");
  const sam = at("call @s").items[0];
  assert.equal(sam.kind, "Who");
  assert.equal(sam.color, "#0f0");
  assert.equal(at("x @tar").items[0].kind, "Where / how");
});

test("# suggests projects and + suggests tags", () => {
  assert.deepEqual(inserts("x #"), ["#Weekly-shop", "#Birthday"]);
  assert.deepEqual(inserts("x #bi"), ["#Birthday"]);
  assert.deepEqual(inserts("x +"), ["+errand", "+kids"]);
  assert.deepEqual(inserts("x +k"), ["+kids"]);
  assert.equal(at("x #bi").strong, true, "Enter may pick it");
});

test("what's suggested is what quick add reads back", () => {
  const ctx = { today, meId: "u1", ...data, projects: [{ id: "p1", name: "Weekly shop" }], contexts: [{ id: "c1", name: "Home Depot" }, { id: "c2", name: "Joe's & Co" }] };
  assert.equal(parseQuickAdd(`paint ${inserts("x @sa")[0]}`, ctx).assigneeId, "u2");
  assert.equal(parseQuickAdd(`paint ${inserts("x @hom")[0]}`, ctx).contextId, "c1");
  assert.equal(parseQuickAdd(`paint ${inserts("x @joe")[0]}`, ctx).contextId, "c2");
  assert.equal(parseQuickAdd(`milk ${inserts("x #wee")[0]}`, ctx).projectId, "p1");
  assert.equal(shortcutName("#", "Big Trip", /^[\p{L}\p{N}_-]+$/u), "#Big-Trip");
});

test("when and repeat words, with what they mean", () => {
  const tom = at("dentist tom");
  assert.equal(tom.strong, false, "a plain word only offers; Enter still adds the task");
  assert.deepEqual(tom.items.map((s) => [s.insert, s.kind, s.detail]), [["tomorrow", "When", "Sat, Oct 3"]]);
  assert.equal(at("dentist fri").items[0].detail, "Fri, Oct 9");
  assert.deepEqual(inserts("x weekl"), ["weekly"]);
  assert.equal(at("x daily".slice(0, 5)).items[0].detail, "Daily, starting today");
  assert.ok(inserts("trash every").length <= MAX_SUGGESTIONS);
  assert.equal(at("call mom tomorrow week").items[0].detail, "Weekly, starting Sat, Oct 3", "from the day already typed");
});

test("every / next complete as a pair, replacing both words", () => {
  const r = at("trash every fr");
  assert.deepEqual(r.items.map((s) => s.insert), ["every fri"]);
  assert.equal("trash every fr".slice(r.start, r.end), "every fr");
  assert.deepEqual(inserts("party next w"), ["next week"]);
});

test("quiet for short words, other words, and what's already complete", () => {
  assert.equal(at("go to"), null);
  assert.equal(at("buy sunscreen"), null);
  assert.equal(at("trash every tue"), null);
  assert.equal(at("x +kids"), null);
  assert.equal(at("x @nobody-here"), null);
});

test("works on the word at the cursor, not just at the end", () => {
  const value = "call @s tomorrow";
  const r = at(value, 7);
  assert.deepEqual(r.items.map((s) => s.insert), ["@sam"]);
  assert.deepEqual([r.start, r.end], [5, 7]);
});
