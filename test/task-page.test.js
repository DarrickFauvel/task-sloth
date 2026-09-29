import { test } from "node:test";
import assert from "node:assert/strict";
import { editFormView, editInput } from "../src/web/task-page.js";

const ctx = { members: [{ id: "u1", name: "Alice" }], projects: [] };
const labels = (view) => view.repeats.map((r) => r.label);

test("editFormView offers the repeat presets and selects the current one", () => {
  const view = editFormView({ recurrence: '{"unit":"week","every":1}' }, ctx);
  assert.deepEqual(labels(view), ["Doesn't repeat", "Daily", "Weekly", "Every 2 weeks", "Monthly"]);
  assert.equal(view.currentRepeat, '{"unit":"week","every":1}');
  assert.ok(view.repeats.some((r) => r.value === view.currentRepeat));
});

test("editFormView selects 'Doesn't repeat' for one-off tasks", () => {
  assert.equal(editFormView({ recurrence: null }, ctx).currentRepeat, "");
  assert.equal(editFormView({ recurrence: "garbage" }, ctx).currentRepeat, "");
});

test("editFormView keeps a rule that isn't a preset selectable", () => {
  const view = editFormView({ recurrence: '{"unit":"week","every":1,"weekday":2}' }, ctx);
  assert.equal(labels(view).at(-1), "Every Tue");
  assert.equal(view.repeats.at(-1).value, view.currentRepeat);
  assert.equal(view.repeats.length, 6);
});

test("editInput turns blank fields into cleared values", () => {
  assert.deepEqual(
    editInput({ title: "Mow", notes: "", dueDate: "", dueTime: "", assigneeId: "", projectId: "", priority: "0", recurrence: "" }),
    { title: "Mow", notes: "", dueDate: null, dueTime: null, assigneeId: null, projectId: null, priority: "0", recurrence: null },
  );
});

test("editInput passes filled fields through", () => {
  const input = editInput({
    title: "Mow", notes: "front only", dueDate: "2026-10-03", dueTime: "09:30",
    assigneeId: "u1", projectId: "p1", priority: "1", recurrence: '{"unit":"week","every":2}',
  });
  assert.equal(input.dueDate, "2026-10-03");
  assert.equal(input.assigneeId, "u1");
  assert.equal(input.recurrence, '{"unit":"week","every":2}');
  assert.equal(input.notes, "front only");
});

test("editInput defaults missing notes to empty", () => {
  assert.equal(editInput({ title: "x" }).notes, "");
});
