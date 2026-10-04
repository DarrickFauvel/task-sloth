import { test } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_STATES, VIEWS } from "../src/web/task-list.js";
import { parseQuickAdd } from "../public/js/lib/quick-add.js";

test("every list has an empty state that teaches", () => {
  for (const view of Object.keys(VIEWS)) {
    const e = EMPTY_STATES[view];
    assert.ok(e, `${view} has an empty state`);
    assert.ok(e.icon && e.title && e.text, `${view} has a picture, a title and a line`);
  }
});

test("the Up for grabs example really leaves a task for anyone", () => {
  const parsed = parseQuickAdd(`fix the gate ${EMPTY_STATES.grabs.example}`, { today: "2026-10-04", meId: "u1", members: [], projects: [], contexts: [] });
  assert.equal(parsed.assigneeId, null);
});
