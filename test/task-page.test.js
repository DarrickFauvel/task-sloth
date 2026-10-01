import { test } from "node:test";
import assert from "node:assert/strict";
import { editFormView, editInput, savedMessage } from "../src/web/task-page.js";

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
    {
      title: "Mow", notes: "", dueDate: null, dueTime: null, assigneeId: null, projectId: null, priority: "0", recurrence: null,
      contextName: "", tags: [],
    },
  );
});

test("editInput passes filled fields through", () => {
  const input = editInput({
    title: "Mow", notes: "front only", dueDate: "2026-10-03", dueTime: "09:30",
    assigneeId: "u1", projectId: "p1", priority: "1", recurrence: '{"unit":"week","every":2}',
    context: "  Home   Depot ", tags: "+Errand, quick_win errand",
  });
  assert.equal(input.contextName, "Home Depot");
  assert.deepEqual(input.tags, ["errand", "quick-win"]);
  assert.equal(input.dueDate, "2026-10-03");
  assert.equal(input.assigneeId, "u1");
  assert.equal(input.recurrence, '{"unit":"week","every":2}');
  assert.equal(input.notes, "front only");
});

test("editInput defaults missing notes to empty", () => {
  assert.equal(editInput({ title: "x" }).notes, "");
});

test("editFormView lists the task's tags and the saved contexts", () => {
  const view = editFormView({ tag_names: "quick-win errand" }, { ...ctx, contexts: [{ id: "l1", name: "Target" }] });
  assert.equal(view.tags, "errand quick-win");
  assert.deepEqual(view.contexts, [{ id: "l1", name: "Target" }]);
  assert.equal(editFormView({ tag_names: null }, ctx).tags, "");
});

test("editInput: picking a task to wait on, nothing, or a new task", () => {
  assert.equal(editInput({ title: "x", waitingTaskId: "abcdefghijklmnop" }).waitingTaskId, "abcdefghijklmnop");
  assert.equal(editInput({ title: "x", waitingTaskId: "" }).waitingTaskId, null);
  const fresh = editInput({ title: "x", waitingTaskId: "new", newBlocker: "  patch the walls sat " });
  assert.equal(fresh.newBlocker, "patch the walls sat");
  assert.equal("waitingTaskId" in fresh, false);
  assert.equal("newBlocker" in editInput({ title: "x" }), false, "forms without the field leave it alone");
});

test("savedMessage names the field that saved, and falls back to Saved", () => {
  assert.equal(savedMessage("priority"), "Priority saved");
  assert.equal(savedMessage("dueDate"), "Date saved");
  assert.equal(savedMessage("toString"), "Saved");
  assert.equal(savedMessage(""), "Saved");
});

test("editFormView keeps a known focus field and drops anything else", () => {
  assert.equal(editFormView({}, { ...ctx, focus: "priority" }).focus, "priority");
  assert.equal(editFormView({}, { ...ctx, focus: "__proto__" }).focus, null);
  assert.equal(editFormView({}, { ...ctx, focus: "" }).focus, null);
  assert.equal(editFormView({}, ctx).focus, null);
});

test("editFormView folds More (project, tags, priority) unless something in it is set or asked for", () => {
  const projects = [{ id: "p1", name: "House", emoji: "🏠" }];
  const plain = editFormView({ priority: 0 }, { ...ctx, projects });
  assert.deepEqual(plain.more, { summary: "No project · no tags · normal priority", open: false });
  const set = editFormView({ priority: -1, project_id: "p1", tag_names: "kids errand" }, { ...ctx, projects });
  assert.deepEqual(set.more, { summary: "🏠 House · +errand +kids · low priority", open: true });
  assert.equal(editFormView({ priority: 0 }, { ...ctx, projects, focus: "priority" }).more.open, true);
  assert.equal(editFormView({ priority: 0 }, { ...ctx, projects, focus: "dueDate" }).more.open, false);
});

test("editInput: picking a project, none, or a new one by name", () => {
  assert.equal(editInput({ projectId: "p1" }).projectId, "p1");
  assert.equal(editInput({ projectId: "" }).projectId, null);
  const created = editInput({ projectId: "new", newProject: "  Paint the hallway " });
  assert.equal(created.projectName, "Paint the hallway");
  assert.ok(!("projectId" in created));
  const unnamed = editInput({ projectId: "new", newProject: " " });
  assert.ok(!("projectId" in unnamed) && !("projectName" in unnamed));
});
