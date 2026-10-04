import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { SLOTH_HATS, hatImageCss, hatOf } from "../src/web/sloth-hats.js";

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

test("every hat has a distinct value, a label and a picture or an emoji", () => {
  assert.equal(new Set(SLOTH_HATS.map((h) => h.value)).size, SLOTH_HATS.length);
  for (const h of SLOTH_HATS) assert.ok(h.label && (h.img || h.emoji), h.value);
});

test("every hat picture exists", () => {
  for (const h of SLOTH_HATS.filter((h) => h.img)) assert.ok(existsSync(new URL(`../public${h.img}`, import.meta.url)), h.img);
});

test("the hat CSS gives each picture hat its versioned URL", () => {
  const css = hatImageCss((path) => `${path}?v=abc`);
  assert.match(css, /--hat-crown: url\("\/img\/hats\/crown\.svg\?v=abc"\);/);
  assert.doesNotMatch(css, /--hat-space|--hat-none/);
});
