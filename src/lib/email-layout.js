// The look of the app's emails: one centered card with a heading, a few paragraphs and an optional button,
// as HTML plus a plain-text copy of the same words (sent together; mail apps pick one). The HTML sticks to what
// mail apps render reliably: tables, inline styles, no images, no external CSS. The button is a colored table
// cell around a link ("bulletproof" in email circles), and the raw link follows it for mail apps that block it.

const ACCENT = "#6d5dfc";
const INK = "#1d1b1a";
const MUTED = "#6b6560";
const PAGE = "#f4f2ef";
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

const escape = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/**
 * @param {object} email
 * @param {string} email.preview   the line inbox lists show after the subject (hidden in the message itself)
 * @param {string} email.heading
 * @param {string[]} email.paragraphs  plain text; **bold** marks a word or address to stand out
 * @param {{ href: string, label: string }} [email.button]
 * @param {string} [email.footnote]  small print under the button, e.g. when the link expires
 * @returns {{ html: string, text: string }}
 */
export function renderEmail({ preview, heading, paragraphs, button, footnote }) {
  const rich = (p) => escape(p).replace(/\*\*(.+?)\*\*/g, `<strong style="color:${INK}">$1</strong>`);
  const plain = (p) => p.replace(/\*\*(.+?)\*\*/g, "$1");

  const para = (p) => `<p style="margin:0 0 16px;font:16px/1.55 ${FONT};color:${INK}">${rich(p)}</p>`;
  const buttonHtml = button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px">
        <tr><td align="center" bgcolor="${ACCENT}" style="border-radius:10px">
          <a href="${escape(button.href)}" target="_blank"
             style="display:inline-block;padding:14px 28px;font:600 16px/1 ${FONT};color:#ffffff;text-decoration:none;border-radius:10px">${escape(button.label)}</a>
        </td></tr>
      </table>
      <p style="margin:0 0 6px;font:13px/1.5 ${FONT};color:${MUTED}">Button not working? Copy this link into your browser:</p>
      <p style="margin:0 0 20px;font:13px/1.5 ${FONT};word-break:break-all"><a href="${escape(button.href)}" style="color:${ACCENT}">${escape(button.href)}</a></p>`
    : "";
  const footnoteHtml = footnote ? `<p style="margin:0;font:13px/1.5 ${FONT};color:${MUTED}">${rich(footnote)}</p>` : "";

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escape(heading)}</title>
</head>
<body style="margin:0;padding:0;background:${PAGE}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escape(preview)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAGE}">
  <tr><td align="center" style="padding:32px 16px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px">
      <tr><td style="padding:0 4px 16px;font:700 18px/1 ${FONT};color:${INK}">Task Sloth</td></tr>
      <tr><td style="background:#ffffff;border-radius:14px;padding:32px 28px">
        <h1 style="margin:0 0 16px;font:700 22px/1.3 ${FONT};color:${INK}">${escape(heading)}</h1>
        ${paragraphs.map(para).join("\n        ")}
        ${buttonHtml}
        ${footnoteHtml}
      </td></tr>
      <tr><td style="padding:16px 4px 0;font:12px/1.5 ${FONT};color:${MUTED}">You're getting this because of your Task Sloth account.</td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;

  const text = [
    heading,
    "",
    ...paragraphs.flatMap((p) => [plain(p), ""]),
    ...(button ? [`${button.label}: ${button.href}`, ""] : []),
    ...(footnote ? [plain(footnote), ""] : []),
    "— Task Sloth",
  ].join("\n");

  return { html, text };
}
