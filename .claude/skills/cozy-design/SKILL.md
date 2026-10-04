---
name: cozy-design
description: Task Sloth's "Forest sloth" look and feel — palette tokens, shapes, type, motion and voice. Use before adding or changing any UI in this repo, including CSS in public/css/app.css, Eta templates in views/, empty states, hints, toasts, emails (src/lib/email-layout.js) or member/project colors, so new screens feel as cozy and friendly as the rest.
---

# Forest sloth design

Task Sloth should feel like a calm, cozy cabin in the woods: parchment and moss by day, a soft forest floor at night, rounded and unhurried. Everything below lives in `public/css/app.css`. Use what's there before adding anything new, and follow the "UI conventions" in `CLAUDE.md` as well (one primary button per screen, `.panel` cards, toasts, `.pill` and `.token` chips, plain language).

## Color tokens

Never write a literal color in CSS or a template. Use these tokens, which already change for dark mode:

| Token | Use it for |
|---|---|
| `--bg` | The page (parchment `#f5f2e8` by day, forest night `#131913`). Also sheets and menus. |
| `--surface` | Anything sitting on the page: `.panel` cards and resting tiles. A shade lighter than `--bg`. |
| `--fg` / `--muted` | Body text (bark ink) and secondary text, hints and meta. |
| `--line` | Borders and dividers. |
| `--accent` | Links, focus rings and selected states. It's moss by default and becomes the signed-in person's own color (`--you`). Its lightness is clamped for contrast, so don't override it. |
| `--gradient` / `--gradient-soft` | Filled primary buttons, ticked boxes and selected pills / gentle highlight patches. |
| `--tint`, `--tint-strong`, `--tint-line` | Tips, highlighted cards and selected rows. |
| `--danger` | Destructive actions and errors only. |
| `--shade` | The color shadows and backdrops are mixed from: bark by day, near-black at night. |

- **Shadows:** `--shadow-soft` for things resting on the page (panels) and `--shadow-lift` for things floating above it (toasts, dragged rows, popovers). For a one-off shadow, mix it from `--shade`. Never use `rgb(0 0 0 / …)`.
- **Member and project colors:** they come from the forest palette `MEMBER_COLORS` in `src/services/users.js`: Moss, Berry, Fern, Clay, River, Bark and Heather. `PROJECT_COLORS` is the same list. White text on each has a contrast ratio of about 4:1 or better. Changing the palette means a migration that moves the stored values (see `migrations/019_forest_colors.sql`).
- **Email:** `src/lib/email-layout.js` can't use CSS tokens, so its constants copy the light theme: change them together.

## Shape

- **Corners:** `--radius` (0.85rem) for controls and `--radius-lg` (1.25rem) for cards. Pills and progress bars are fully round (`999px`). No sharp corners.
- **Cards:** a `.panel` has a 1px `--line` border, a `--surface` background and `--shadow-soft`. Don't stack heavy borders inside cards; use spacing instead.

## Type

- **Font:** Nunito, a rounded variable font self-hosted from `public/fonts/` (OFL license). Use `font-weight` for emphasis: 600 for buttons and labels, 700 for strong headings.
- **Sizes:** use the fluid `--step-*` scale and the `--space-*` spacing tokens, never fixed `px` sizes.

## Motion

- **Feel:** gentle and a little springy. The house easing for "pop" is `cubic-bezier(0.3, 1.6, 0.5, 1)`, and `ease` works for fades.
- **Presses and hovers:** buttons scale to 0.97 when pressed and lift 1px on hover (pointer devices only).
- **Reduced motion:** every animation or transition needs a `@media (prefers-reduced-motion: reduce)` fallback that turns it off.

## Pictures and voice

- **Emoji:** they are the illustrations. Use the `.emoji` class so `data-icons="off"` hides them, plus `aria-hidden="true"`. Empty states use `<p class="empty-icon emoji">`, which sits on a round moss patch. Nature emoji fit the theme: 🌱 🌿 🍃 🌳 🦥 🍄 ☕.
- **Words:** warm, plain and encouraging, never guilt-tripping. Match the voice of `src/web/encouragement.js`. Avoid GTD jargon, and give every screen a hint or an empty state that teaches.
- **Task Sloth talking:** when the app itself speaks (encouragement, a kind nudge, a cheer), use a `.sloth-says` speech bubble: `partials/sloth-head` (pass `toggle: true` so tapping the head tucks the words away, remembered in the `sloth` cookie) and a `.bubble`. Cheering toasts pass `sloth: true` to `partials/flash`. Plain status messages and form errors stay as they are.

## Before shipping UI

1. Check light and dark (Settings → theme) and the system theme.
2. Check at phone width (about 360px) first, then wider.
3. Check text contrast: 4.5:1 for body text, and the accent on `--bg` and `--surface`.
4. Turn on reduced motion and check that nothing moves.
5. Turn icons off and check that nothing breaks or leaves a gap.
6. Look for literal colors or black shadows: `grep -nE '#[0-9a-fA-F]{3,6}\b|rgb\(0 0 0' public/css/app.css`. The toast and photo-viewer whites are intentional.
