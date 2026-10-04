// What Task Sloth wears on its head (partials/sloth-head), picked in Settings > Appearance and kept on this
// device in the hat cookie. The space helmet is drawn in CSS; the others are an emoji perched on top (app.css).

/** @type {{ value: string, label: string, emoji: string, flip?: boolean }[]} The first is the default (no cookie).
 * `flip` mirrors the emoji (on the head in app.css, and in the picker) so it faces the way the head leans. */
export const SLOTH_HATS = [
  { value: "space", label: "Space helmet", emoji: "🚀" },
  { value: "mushroom", label: "Mushroom cap", emoji: "🍄" },
  { value: "top", label: "Top hat", emoji: "🎩" },
  { value: "crown", label: "Crown", emoji: "👑" },
  { value: "sun", label: "Sun hat", emoji: "👒", flip: true },
  { value: "cap", label: "Cap", emoji: "🧢", flip: true },
  { value: "none", label: "No hat", emoji: "🦥" },
];

/** The hat a cookie names, or the default for a missing or unknown one. */
export const hatOf = (cookie) => (SLOTH_HATS.some((h) => h.value === cookie) ? cookie : SLOTH_HATS[0].value);
