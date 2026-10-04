// What Task Sloth wears on its head (partials/sloth-head), picked in Settings > Appearance and kept on this
// device in the hat cookie. The space helmet is drawn in CSS; the others are pictures in public/img/hats/,
// perched on top (app.css), so they look the same on every device, which emoji don't.

/** @type {{ value: string, label: string, img?: string, emoji?: string }[]} The first is the default (no cookie).
 * A hat with `img` is that picture, on the head and in the picker; the others show `emoji` in the picker. */
export const SLOTH_HATS = [
  { value: "space", label: "Space helmet", emoji: "🚀" },
  { value: "mushroom", label: "Mushroom cap", img: "/img/hats/mushroom.svg" },
  { value: "top", label: "Top hat", img: "/img/hats/top.svg" },
  { value: "crown", label: "Crown", img: "/img/hats/crown.svg" },
  { value: "sun", label: "Sun hat", img: "/img/hats/sun.svg" },
  { value: "cap", label: "Cap", img: "/img/hats/cap.svg" },
  { value: "none", label: "No hat", emoji: "🦥" },
];

/** The hat a cookie names, or the default for a missing or unknown one. */
export const hatOf = (cookie) => (SLOTH_HATS.some((h) => h.value === cookie) ? cookie : SLOTH_HATS[0].value);

/** CSS for the layout giving each picture hat's versioned URL as --hat-<value> (app.css puts it on the head).
 * Versioned, so a redrawn hat reaches phones past the service worker's cache. */
export const hatImageCss = (asset) =>
  `:root { ${SLOTH_HATS.filter((h) => h.img).map((h) => `--hat-${h.value}: url("${asset(h.img)}");`).join(" ")} }`;
