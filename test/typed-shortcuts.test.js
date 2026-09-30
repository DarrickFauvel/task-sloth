import { test } from "node:test";
import assert from "node:assert/strict";
import { describeDetails, shortcutsInTitle, withTypedShortcuts } from "../src/web/typed-shortcuts.js";

const ctx = {
  today: "2026-09-30", // a Wednesday
  meId: "u-me",
  members: [{ id: "u-me", name: "Darrick" }, { id: "u-sam", name: "Samantha" }],
  projects: [{ id: "p-bday", name: "Birthday" }],
  contexts: [{ id: "c-phone", name: "Phone" }],
};
const task = (fields = {}) => ({ title: "old", list: "todo", tag_names: null, ...fields });

test("a plain rename only changes the title", () => {
  const { input, summary } = shortcutsInTitle("call grandma", task(), ctx);
  assert.deepEqual(input, { title: "call grandma" });
  assert.equal(summary, "");
});

test("shortcuts in the new name are applied and described", () => {
  const { input, summary } = shortcutsInTitle("call grandma sun @phone", task(), ctx);
  assert.deepEqual(input, { title: "call grandma", dueDate: "2026-10-04", contextId: "c-phone" });
  assert.equal(summary, "Sun · @Phone");
});

test("typed tags are added to the task's tags, not swapped for them", () => {
  const { input } = shortcutsInTitle("batteries +errand", task({ tag_names: "kids" }), ctx);
  assert.deepEqual(input.tags, ["kids", "errand"]);
});

test("an inbox task with a real detail moves to To do; priority alone doesn't count", () => {
  assert.equal(shortcutsInTitle("fix chair fri", task({ list: "inbox" }), ctx).input.list, "todo");
  assert.equal(shortcutsInTitle("fix chair !!", task({ list: "inbox" }), ctx).input.list, undefined);
  assert.equal(shortcutsInTitle("fix chair fri", task({ list: "someday" }), ctx).input.list, undefined, "other lists stay put");
});

test("a name that's only shortcuts keeps the old title", () => {
  assert.equal(shortcutsInTitle("@phone", task({ title: "call the bank" }), ctx).input.title, "call the bank");
});

test("describeDetails covers every kind of detail", () => {
  assert.equal(
    describeDetails({ dueDate: "2026-10-01", dueTime: "15:00", assigneeId: "u-sam", contextName: "Target", tags: ["errand"], projectId: "p-bday", priority: 1 }, ctx),
    "Tomorrow 15:00 · for Samantha · @Target · +errand · #Birthday · high priority",
  );
  assert.equal(describeDetails({ recurrence: { unit: "week", every: 1 }, dueDate: "2026-09-30", assigneeId: null }, ctx), "Today · ↻ Weekly · for anyone");
});

test("sort page: the picked answer wins, typed details fill the gaps", () => {
  const typed = { title: "call grandma", dueDate: "2026-10-04", contextId: "c-phone", assigneeId: "u-sam", list: "todo" };
  // To do with a blank Where/how and Who left on Me: the typed @phone and @sam survive.
  assert.deepEqual(withTypedShortcuts(typed, { title: "call grandma sun @phone @sam", list: "todo", assigneeId: "u-me", contextName: "" }, "u-me"), {
    title: "call grandma", dueDate: "2026-10-04", contextId: "c-phone", assigneeId: "u-sam", list: "todo",
  });
  // Maybe later: the list is the answer's, not the typed one.
  assert.equal(withTypedShortcuts(typed, { title: "x", list: "someday" }, "u-me").list, "someday");
  // An explicit pick beats the typed detail.
  assert.equal(withTypedShortcuts(typed, { title: "x", list: "todo", dueDate: "2026-10-09" }, "u-me").dueDate, "2026-10-09");
  assert.equal(withTypedShortcuts(typed, { title: "x", list: "todo", assigneeId: null, contextName: "" }, "u-me").assigneeId, null, "Anyone was picked on purpose");
});
