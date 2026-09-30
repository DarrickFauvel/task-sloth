import { test } from "node:test";
import assert from "node:assert/strict";
import { groupByWhere } from "../src/web/task-list.js";

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
