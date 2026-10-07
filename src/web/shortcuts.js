/**
 * The quick-add cheat sheet (views/partials/shortcuts.eta), grouped by the questions you ask
 * yourself when adding a task, most common first. `people` are the other household members'
 * names, so the @person example is someone real rather than a made-up "@sam".
 * @param {string[]} people
 * @returns {{ icon: string, title: string, note?: string, rows: { label?: string, tokens: string[] }[] }[]}
 */
export function shortcutGroups(people = []) {
  // The leading run of characters an @name can use (see public/js/lib/quick-add.js): "Mary Ann" -> "@mary".
  const handles = people
    .map((n) => String(n).trim().toLowerCase().match(/^[\p{L}\p{N}_.'-]+/u)?.[0])
    .filter(Boolean)
    .slice(0, 2)
    .map((h) => `@${h}`);
  return [
    {
      icon: "📅", title: "When",
      rows: [
        { label: "Day", tokens: ["today", "tomorrow", "fri", "oct 12"] },
        { label: "Time", tokens: ["at 3pm", "5:30pm"] },
        { label: "Repeats", tokens: ["daily", "every tue", "every 2 weeks"] },
      ],
    },
    { icon: "👤", title: "Who", rows: [{ tokens: ["@me", ...(handles.length ? handles : ["@sam"]), "@anyone"] }] },
    { icon: "📍", title: "Where / how", note: "any other @word", rows: [{ tokens: ["@Target", "@phone", '@"Home Depot"'] }] },
    {
      icon: "🏷️", title: "Group it",
      rows: [
        { label: "Tag", tokens: ["+errand", "+kids"] },
        { label: "Project (makes one if it's new)", tokens: ["#Birthday"] },
      ],
    },
    { icon: "❗", title: "Priority", note: "!! is high, !low is low", rows: [{ tokens: ["!!", "!low"] }] },
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
