import { test } from "node:test";
import assert from "node:assert/strict";
import { GROUP_HUES, groupByWhere, withWhereTone } from "../src/web/task-list.js";

test("groupByWhere: one group per where/how, A–Z, Anywhere last, list order kept inside", () => {
  const t = (title, context_id = null, context_name = null) => ({ title, context_id, context_name });
  const groups = groupByWhere([
    t("buy nails", "c2", "errands"), t("water plants"), t("fix tap", "c1", "At home"),
    t("post letter", "c2", "errands"), t("hoover", "c1", "At home"),
  ]);
  assert.deepEqual(
    groups.map((g) => [g.label, g.contextId, g.tasks.map((x) => x.title)]),
    [
      ["At home", "c1", ["fix tap", "hoover"]],
      ["errands", "c2", ["buy nails", "post letter"]],
      ["Anywhere", null, ["water plants"]],
    ],
  );
  assert.deepEqual(groupByWhere([]), []);
});

test("withWhereTone: each place gets a steady color from its id; Anywhere is plain", () => {
  const g = (contextId) => withWhereTone({ label: "x", contextId, tasks: [] });
  assert.equal(g(null).tone, "plain");
  assert.equal(g(null).hue, undefined);
  assert.ok(GROUP_HUES.includes(g("c1").hue));
  assert.equal(g("c1").hue, g("c1").hue, "same id, same color");
  const hues = new Set(["a1", "b2", "c3", "d4", "e5", "f6", "g7", "h8"].map((id) => g(id).hue));
  assert.ok(hues.size > 1, "different places spread across the palette");
});
