import { test } from "node:test";
import assert from "node:assert/strict";
import { parseChecklistInput, parseItem } from "../public/js/lib/checklist.js";
import { guessCategory } from "../public/js/lib/groceries.js";
import { groupItems } from "../src/services/checklist.js";

test("parseItem pulls out quantities", () => {
  assert.deepEqual(parseItem("2x bread"), { text: "bread", quantity: "2" });
  assert.deepEqual(parseItem("2 x bread"), { text: "bread", quantity: "2" });
  assert.deepEqual(parseItem("bread x2"), { text: "bread", quantity: "2" });
  assert.deepEqual(parseItem("2 lb chicken"), { text: "chicken", quantity: "2 lb" });
  assert.deepEqual(parseItem("3 bananas"), { text: "bananas", quantity: "3" });
  assert.deepEqual(parseItem("1/2 dozen eggs"), { text: "eggs", quantity: "1/2 dozen" });
  assert.deepEqual(parseItem("  olive   oil "), { text: "olive oil", quantity: null });
});

test("parseChecklistInput splits on commas, semicolons and lines", () => {
  assert.deepEqual(parseChecklistInput("milk, eggs; 2x bread").map((i) => i.text), ["milk", "eggs", "bread"]);
  assert.deepEqual(parseChecklistInput("milk\neggs\r\nbread").map((i) => i.text), ["milk", "eggs", "bread"]);
  assert.deepEqual(parseChecklistInput(" , ,\n\n"), []);
});

test("parseChecklistInput strips bullets and checkboxes from pasted lists", () => {
  const items = parseChecklistInput("- milk\n* eggs\n• jam\n1. bread\n2) butter\n[ ] tea\n[x] coffee");
  assert.deepEqual(items.map((i) => i.text), ["milk", "eggs", "jam", "bread", "butter", "tea", "coffee"]);
});

test("parseChecklistInput reads a leading 'Category:' as the section", () => {
  assert.deepEqual(parseChecklistInput("Produce: apples, 3 bananas\nmilk"), [
    { text: "apples", quantity: null, category: "Produce" },
    { text: "bananas", quantity: "3", category: "Produce" },
    { text: "milk", quantity: null, category: null },
  ]);
});

test("guessCategory matches whole words and plurals", () => {
  assert.equal(guessCategory("Bananas"), "Produce");
  assert.equal(guessCategory("strawberries"), "Produce");
  assert.equal(guessCategory("cherry tomatoes"), "Produce");
  assert.equal(guessCategory("eggs"), "Dairy & eggs");
  assert.equal(guessCategory("2% milk"), "Dairy & eggs");
  assert.equal(guessCategory("chicken thighs"), "Meat & seafood");
  assert.equal(guessCategory("dog food"), "Pets");
  assert.equal(guessCategory("mystery item"), null);
  assert.equal(guessCategory(""), null);
});

test("guessCategory prefers the longest keyword", () => {
  assert.equal(guessCategory("peanut butter"), "Pantry");
  assert.equal(guessCategory("ice cream"), "Frozen");
  assert.equal(guessCategory("sour cream"), "Dairy & eggs");
  assert.equal(guessCategory("paper towels"), "Household");
  assert.equal(guessCategory("sparkling water"), "Drinks");
});

test("guessCategory doesn't match keywords inside other words", () => {
  assert.equal(guessCategory("eggplant"), "Produce");
  assert.equal(guessCategory("watermelon"), "Produce");
  assert.equal(guessCategory("hamburger buns"), "Bakery");
  assert.equal(guessCategory("cantaloupe"), "Produce");
  assert.equal(guessCategory("pineapple"), "Produce");
  assert.equal(guessCategory("scanner"), null);
});

const item = (id, { checked = 0, category = null, sort = 0 } = {}) => ({ id, checked, category, sort_order: sort });
const ids = (groups) => groups.map((g) => [g.name, g.items.map((i) => i.id)]);

test("groupItems in checklist mode keeps one group, checked items last", () => {
  const items = [item("a", { checked: 1, sort: 1 }), item("b", { sort: 3 }), item("c", { sort: 2 })];
  assert.deepEqual(ids(groupItems(items, "checklist")), [[null, ["c", "b", "a"]]]);
});

test("groupItems in shopping mode groups by section", () => {
  const items = [
    item("milk", { category: "Dairy & eggs" }),
    item("mystery"),
    item("apples", { category: "Produce", sort: 2 }),
    item("kale", { category: "Produce", checked: 1, sort: 1 }),
    item("tape", { category: "Household", checked: 1 }),
  ];
  assert.deepEqual(ids(groupItems(items, "shopping")), [
    ["Dairy & eggs", ["milk"]],
    ["Produce", ["apples", "kale"]],
    ["Other", ["mystery"]],
    ["Household", ["tape"]], // fully checked sections sink to the bottom, even below "Other"
  ]);
});
