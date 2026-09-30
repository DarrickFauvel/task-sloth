// Phone numbers in task text ("call the dentist 555-123-4567"), so the app can offer a tap-to-call link.
// Shared by the server and the browser; pure.
//
// Anything number-like is a candidate, then it has to look like a phone number: 7 to 15 digits, and either
// a leading +, a bracketed area code, at least 10 digits, or a local 555-1234. That leaves out dates
// (2026-09-30), times, prices, sizes ("10 12 14"), short counts and order numbers ("#1234567890").

const CANDIDATE = /(?<![\w+#$])(?:\+|\()?\d[\d ().-]*\d\)?(?![\w])/g;
const DATE = /^(\d{4}[-./]\d{1,2}[-./]\d{1,2}|\d{1,2}[-./]\d{1,2}[-./]\d{2,4})$/;
const LOCAL = /^\d{3}[ .-]\d{4}$/;

/** The phone number `text` spells, as a tel: URL, or null if it isn't one. */
export function telHref(text) {
  const t = text.trim();
  const digits = t.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  if (DATE.test(t) || /^\d+\.\d+$/.test(t) || /[ .-]{2}/.test(t)) return null;
  const opens = (t.match(/\(/g) ?? []).length;
  if (opens !== (t.match(/\)/g) ?? []).length || opens > 1) return null;
  if (!(t.startsWith("+") || opens || digits.length >= 10 || LOCAL.test(t))) return null;
  return `tel:${t.startsWith("+") ? "+" : ""}${digits}`;
}

/**
 * Splits text into plain runs and phone numbers: [{ text }, { text: "555-123-4567", tel: "tel:5551234567" }, …].
 * Joining every part's text gives back the original.
 */
export function splitPhones(text) {
  const parts = [];
  let last = 0;
  for (const m of String(text ?? "").matchAll(CANDIDATE)) {
    // A candidate can take in the space or bracket next to a number ("(555) 123-4567 " is fine, "4567)" isn't).
    let found = m[0].trimEnd();
    if (found.endsWith(")") && !found.includes("(")) found = found.slice(0, -1);
    const tel = telHref(found);
    if (!tel) continue;
    if (m.index > last) parts.push({ text: text.slice(last, m.index) });
    parts.push({ text: found, tel });
    last = m.index + found.length;
  }
  if (last < String(text ?? "").length) parts.push({ text: String(text).slice(last) });
  return parts;
}

/** The distinct phone numbers in any of `texts`, in order: [{ text, tel }]. */
export function findPhones(...texts) {
  const seen = new Map();
  for (const text of texts) for (const p of splitPhones(text)) if (p.tel && !seen.has(p.tel)) seen.set(p.tel, p);
  return [...seen.values()];
}
