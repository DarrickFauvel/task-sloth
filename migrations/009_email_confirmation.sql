-- Confirming email addresses for password accounts: at sign-up, and before an email change takes effect.
-- Google (and dev) accounts are treated as confirmed without this; Google has already checked theirs.
ALTER TABLE users ADD COLUMN email_verified_at TEXT;
-- A new address waiting to be confirmed. users.email stays the old one (and signs in) until then.
ALTER TABLE users ADD COLUMN pending_email TEXT;

-- One row per link sent. Only a hash of the token is kept; the token itself is only in the email.
CREATE TABLE email_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  email TEXT NOT NULL,          -- the address the link was sent to, and confirms
  purpose TEXT NOT NULL,        -- 'verify' (the current email) or 'change' (a pending one)
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX email_tokens_user ON email_tokens(user_id);
