import { test } from "node:test";
import assert from "node:assert/strict";
import { renderEmail } from "../src/lib/email-layout.js";

const email = renderEmail({
  preview: "One tap",
  heading: "Confirm your email",
  paragraphs: ["Hi <Sam> & co,", "Confirm **sam@example.com** now."],
  button: { href: "https://app.example.com/email/confirm?token=abc&x=1", label: "Confirm email" },
  footnote: "Works for 24 hours.",
});

test("the HTML has a real button link, bold where marked, and escapes everything else", () => {
  assert.match(email.html, /<a href="https:\/\/app\.example\.com\/email\/confirm\?token=abc&amp;x=1"[^>]*>Confirm email<\/a>/);
  assert.match(email.html, /<strong[^>]*>sam@example\.com<\/strong>/);
  assert.match(email.html, /Hi &lt;Sam&gt; &amp; co,/);
  assert.doesNotMatch(email.html, /<Sam>/);
  assert.match(email.html, /One tap/, "the inbox preview line");
});

test("the plain-text copy has the same words, the link written out, and no markup", () => {
  assert.match(email.text, /^Confirm your email\n/);
  assert.match(email.text, /Hi <Sam> & co,/);
  assert.match(email.text, /Confirm sam@example\.com now\./);
  assert.match(email.text, /Confirm email: https:\/\/app\.example\.com\/email\/confirm\?token=abc&x=1/);
  assert.doesNotMatch(email.text, /\*\*|<strong/);
});
