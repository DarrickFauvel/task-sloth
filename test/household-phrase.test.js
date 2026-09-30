import { test } from "node:test";
import assert from "node:assert/strict";
import { HOUSEHOLD_PHRASES, householdPhrase } from "../src/web/household-phrase.js";

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
