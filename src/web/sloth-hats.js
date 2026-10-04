// What Task Sloth wears on its head (partials/sloth-head), picked in Settings > Appearance and kept on this
// device in the hat cookie. The space helmet is drawn in CSS; the others are an emoji perched on top (app.css).

/** @type {{ value: string, label: string, emoji: string }[]} The first is the default (no cookie). */
export const SLOTH_HATS = [
  { value: "space", label: "Space helmet", emoji: "🚀" },
  { value: "mushroom", label: "Mushroom cap", emoji: "🍄" },
  { value: "top", label: "Top hat", emoji: "🎩" },
  { value: "crown", label: "Crown", emoji: "👑" },
  { value: "sun", label: "Sun hat", emoji: "👒" },
  { value: "cap", label: "Cap", emoji: "🧢" },
  { value: "none", label: "No hat", emoji: "🦥" },
];

/** The hat a cookie names, or the default for a missing or unknown one. */
export const hatOf = (cookie) => (SLOTH_HATS.some((h) => h.value === cookie) ? cookie : SLOTH_HATS[0].value);
