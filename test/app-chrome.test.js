import { test } from "node:test";
import assert from "node:assert/strict";
import { backLink, lastViewOf, LAST_VIEW_COOKIE } from "../src/web/app-chrome.js";

test("lastViewOf remembers the last list, and falls back to Mine", () => {
  assert.equal(lastViewOf({ [LAST_VIEW_COOKIE]: "waiting" }), "waiting");
  assert.equal(lastViewOf({ [LAST_VIEW_COOKIE]: "inbox" }), "inbox");
  assert.equal(lastViewOf({}), "mine");
  assert.equal(lastViewOf(), "mine");
  assert.equal(lastViewOf({ [LAST_VIEW_COOKIE]: "<script>" }), "mine", "junk is ignored");
});

test("backLink leads back to that list, by its name", () => {
  assert.deepEqual(backLink("waiting"), { href: "/?view=waiting", label: "Waiting on" });
  assert.deepEqual(backLink("all"), { href: "/?view=all", label: "Everyone" });
});
