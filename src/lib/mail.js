// Sending email over SMTP (config.mail, from SMTP_URL and MAIL_FROM): HTML plus a plain-text copy (see
// email-layout.js), or plain text alone.
// Without it: in development the message is printed to the console (so links can still be followed);
// in production sending fails, loudly.

import nodemailer from "nodemailer";
import { config } from "../config.js";

let transport = null;
/** @type {object[] | null} set by captureMail() in tests */
let outbox = null;

/** @param {{ to: string, subject: string, text: string, html?: string }} message */
export async function sendMail({ to, subject, text, html }) {
  if (outbox) return void outbox.push({ to, subject, text, html });
  if (!config.mail) {
    if (config.isProduction) throw new Error("Can't send email: SMTP_URL and MAIL_FROM aren't set");
    console.log(`\n[mail not configured, so here it is]\nTo: ${to}\nSubject: ${subject}\n\n${text}\n`);
    return;
  }
  const { host, port, secure, user, pass, from } = config.mail;
  transport ??= nodemailer.createTransport({ host, port, secure, requireTLS: !secure, auth: user ? { user, pass } : undefined });
  await transport.sendMail({ from, to, subject, text, html });
}

/** Tests: collect messages in the returned array instead of sending them. */
export function captureMail() {
  outbox = [];
  return outbox;
}
