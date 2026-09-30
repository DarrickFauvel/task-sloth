-- A photo a member uploads for their avatar. It wins over their Google picture and their initial.
-- The image lives in its own table so loading a user (every request) doesn't read it; avatar_photo_at
-- says there is one and versions its URL (/avatars/<id>?v=…) so browsers can cache it for good.
CREATE TABLE avatar_photos (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  image BLOB NOT NULL,
  content_type TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
ALTER TABLE users ADD COLUMN avatar_photo_at TEXT;
