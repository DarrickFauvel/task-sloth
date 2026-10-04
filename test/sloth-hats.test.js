import { test } from "node:test";
import assert from "node:assert/strict";
import { SLOTH_HATS, hatOf } from "../src/web/sloth-hats.js";

test("the space helmet is the default hat", () => {
  assert.equal(SLOTH_HATS[0].value, "space");
  assert.equal(hatOf(undefined), "space");
  assert.equal(hatOf(""), "space");
});

test("a known hat is kept and an unknown one falls back", () => {
  assert.equal(hatOf("crown"), "crown");
  assert.equal(hatOf("none"), "none");
  assert.equal(hatOf("\" onload=x"), "space");
});

test("every hat has a distinct value, a label and an emoji", () => {
  assert.equal(new Set(SLOTH_HATS.map((h) => h.value)).size, SLOTH_HATS.length);
  for (const h of SLOTH_HATS) assert.ok(h.label && h.emoji, h.value);
});
