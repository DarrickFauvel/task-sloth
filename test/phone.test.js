import { test } from "node:test";
import assert from "node:assert/strict";
import { findPhones, splitPhones, telHref } from "../public/js/lib/phone.js";
import { decorateTask } from "../src/web/task-list.js";

test("finds phone numbers in the usual formats", () => {
  const cases = {
    "call dentist 555-123-4567": ["555-123-4567", "tel:5551234567"],
    "ring plumber (555) 123-4567 about the sink": ["(555) 123-4567", "tel:5551234567"],
    "call +44 20 7946 0958": ["+44 20 7946 0958", "tel:+442079460958"],
    "+1 (555) 123-4567": ["+1 (555) 123-4567", "tel:+15551234567"],
    "phone 555 123 4567 now": ["555 123 4567", "tel:5551234567"],
    "text 555.123.4567.": ["555.123.4567", "tel:5551234567"],
    "call 5551234567": ["5551234567", "tel:5551234567"],
    "call mum 555-1234": ["555-1234", "tel:5551234"],
  };
  for (const [text, [number, tel]] of Object.entries(cases)) assert.deepEqual(findPhones(text), [{ text: number, tel }], text);
});

test("leaves dates, prices, sizes, counts and order numbers alone", () => {
  for (const text of ["due 2026-09-30", "on 10/12/2026", "sizes 10 12 14 16", "pay $1,200.50", "buy 3 apples", "zip 12345",
    "pi 3.14159265358", "Order #1234567890", "at 15:00", "$5551234567"]) {
    assert.deepEqual(findPhones(text), [], text);
  }
  assert.equal(telHref("555--1234"), null);
  assert.equal(telHref("(555 123-4567"), null);
  assert.equal(telHref("1234567890123456"), null); // 16 digits
});

test("splitting keeps every character, in order", () => {
  const text = "call (555) 123-4567 or +1 555 765 4321, then 2026-10-01";
  const parts = splitPhones(text);
  assert.equal(parts.map((p) => p.text).join(""), text);
  assert.deepEqual(parts.filter((p) => p.tel).map((p) => p.tel), ["tel:5551234567", "tel:+15557654321"]);
  assert.deepEqual(splitPhones("no numbers here"), [{ text: "no numbers here" }]);
  assert.deepEqual(splitPhones(""), []);
});

test("a task's numbers come from its title and notes, once each", () => {
  const membership = { members: [] };
  const t = decorateTask({ title: "call the plumber 555-123-4567", notes: "Backup: 555 765 4321\nor 555-123-4567", status: "open" }, membership, "2026-09-30");
  assert.deepEqual(t.phones.map((p) => p.text), ["555-123-4567", "555 765 4321"]);
  assert.equal(t.titleParts.length, 2);
  assert.equal(decorateTask({ title: "water plants", status: "open" }, membership, "2026-09-30").phones.length, 0);
});
