import { test } from "node:test";
import assert from "node:assert/strict";
import { HOUSEHOLD_PHRASES, householdPhrase, nextPhraseIndex, phraseIndex, phraseText } from "../src/web/household-phrase.js";

test("every phrase works the household name in exactly once, and stays short", () => {
  for (const p of HOUSEHOLD_PHRASES) {
    assert.equal(p.split("{h}").length, 2, p);
    assert.ok(p.replace("{h}", "").length <= 30, `too long for a phone: ${p}`);
  }
});

test("householdPhrase picks across the whole list", () => {
  assert.equal(householdPhrase("Snuggle Bus", () => 0), HOUSEHOLD_PHRASES[0].replace("{h}", "Snuggle Bus"));
  assert.equal(householdPhrase("Snuggle Bus", () => 0.9999), HOUSEHOLD_PHRASES.at(-1).replace("{h}", "Snuggle Bus"));
});

test("phraseIndex accepts only a valid index from the cookie", () => {
  assert.equal(phraseIndex("3"), 3);
  assert.equal(phraseIndex("0"), 0);
  for (const bad of [undefined, "", "-1", "1.5", "abc", String(HOUSEHOLD_PHRASES.length)]) assert.equal(phraseIndex(bad), null);
});

test("nextPhraseIndex never repeats the current line", () => {
  for (let current = 0; current < HOUSEHOLD_PHRASES.length; current++) {
    for (const r of [0, 0.5, 0.9999]) assert.notEqual(nextPhraseIndex(current, () => r), current);
  }
  assert.equal(nextPhraseIndex(null, () => 0), 0);
  assert.equal(phraseText("Snuggle Bus", 0), HOUSEHOLD_PHRASES[0].replace("{h}", "Snuggle Bus"));
});
