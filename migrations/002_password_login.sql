-- Username/email + password sign-in. Google and dev-login users leave both columns NULL.
ALTER TABLE users ADD COLUMN username TEXT;
ALTER TABLE users ADD COLUMN password_hash TEXT;  -- scrypt$N$r$p$salt$hash, see src/lib/crypto.js
CREATE UNIQUE INDEX users_username ON users(username COLLATE NOCASE) WHERE username IS NOT NULL;
-- Only password accounts need unique emails; a Google account may share one.
CREATE UNIQUE INDEX users_password_email ON users(email COLLATE NOCASE) WHERE password_hash IS NOT NULL;
