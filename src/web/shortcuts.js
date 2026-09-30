/**
 * The quick-add cheat sheet (views/partials/shortcuts.eta). `people` are the other household
 * members' names, so the @person example is someone real rather than a made-up "@sam".
 * @param {string[]} people
 */
export function shortcutRows(people = []) {
  // The leading run of characters an @name can use (see public/js/lib/quick-add.js): "Mary Ann" -> "@mary".
  const handles = people
    .map((n) => String(n).trim().toLowerCase().match(/^[\p{L}\p{N}_.'-]+/u)?.[0])
    .filter(Boolean)
    .slice(0, 2)
    .map((h) => `@${h}`);
  return [
    { tokens: ["fri", "tomorrow", "oct 12", "in 3 days"], what: "When it's due" },
    { tokens: ["at 3pm", "5:30pm"], what: "What time" },
    { tokens: ["every tue", "daily", "every 2 weeks"], what: "Repeats" },
    { tokens: ["@me", ...(handles.length ? handles : ["@sam"]), "@anyone"], what: "Who does it (a name from your household)" },
    { tokens: ["@Target", "@phone", '@"Home Depot"'], what: "Where or how you'll do it (any @word that isn't a person)" },
    { tokens: ["+errand", "+kids"], what: "Tags, to group things your own way" },
    { tokens: ["#Birthday"], what: "Part of a bigger project" },
    { tokens: ["!!", "!low"], what: "High or low priority" },
  ];
}

export const SHORTCUT_EXAMPLE = "return library books sat @library +kids";

/**
 * Datastar click handler for a token button: appends its data-token to the add box (bound to
 * $quick), closes the drawer, and puts the cursor back at the end of the box.
 */
export const INSERT_TOKEN = [
  "$quick = ($quick.trim() + ' ' + el.dataset.token).trim() + ' '",
  "el.closest('dialog').close()",
  "setTimeout(() => { const i = document.querySelector('#quick-add input[name=quick]'); i.focus(); i.setSelectionRange(i.value.length, i.value.length) })",
].join("; ");
