// Parses pasted/typed checklist input into items.
//
//   "milk, eggs, 2x bread"            -> 3 items, bread quantity "2"
//   "Produce: apples, 3 bananas"      -> items in category "Produce"
//   one item per line also works (paste a whole list)

const UNITS = "kg|g|lb|lbs|oz|l|ml|dozen|doz|packs?|bags?|cans?|bottles?|box|boxes|jars?|loaf|loaves|bunch(?:es)?|cartons?|rolls?";

/** Splits a single item into { text, quantity }. */
export function parseItem(raw) {
  const s = raw.trim().replace(/\s+/g, " ");
  let m = s.match(/^(\d+(?:[.,]\d+)?)\s*x\s+(.+)$/i); // 2x bread / 2 x bread
  if (m) return { text: m[2], quantity: m[1] };
  m = s.match(/^(.+?)\s+x\s*(\d+(?:[.,]\d+)?)$/i); // bread x2
  if (m) return { text: m[1], quantity: m[2] };
  m = s.match(new RegExp(`^(\\d+(?:[.,/]\\d+)?\\s*(?:${UNITS})?)\\s+(.+)$`, "i")); // 2 lb chicken / 3 apples
  if (m) return { text: m[2], quantity: m[1].trim() };
  return { text: s, quantity: null };
}

/** Strips a leading bullet ("- ", "1.", "[ ]") and an optional "Section:" prefix from one line. */
function splitLine(line) {
  const rest = line.replace(/^\s*(?:[-*•]|\[\s?[xX ]?\]|\d+[.)])\s+/, ""); // strip bullets / "1." / "[ ]"
  const cat = rest.match(/^\s*([\p{L}][\p{L}\s&]{1,30}):\s*(.*)$/u);
  return cat ? { category: cat[1].trim(), rest: cat[2] } : { category: null, rest };
}

/** One item as typed when renaming it: an optional "Section:" prefix and a quantity, but no splitting on commas. */
export function parseSingleItem(input) {
  const { category, rest } = splitLine(String(input ?? "").replace(/\s+/g, " "));
  const item = parseItem(rest);
  return item.text ? { ...item, category } : null;
}

/** @returns {{ text: string, quantity: string | null, category: string | null }[]} */
export function parseChecklistInput(input) {
  const items = [];
  for (const line of String(input).split(/\r?\n/)) {
    const { category, rest } = splitLine(line);
    for (const part of rest.split(/[,;]/)) {
      if (!part.trim()) continue;
      items.push({ ...parseItem(part), category });
    }
  }
  return items.filter((i) => i.text);
}
