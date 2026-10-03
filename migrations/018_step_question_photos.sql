-- Photos with a question about a step (step_questions). A question is a draft (status 'draft', question '')
-- while its asker adds photos, then the Ask sends it with them. Like checkin_photos: the image lives on Cloudinary.
CREATE TABLE step_question_photos (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  question_id TEXT NOT NULL REFERENCES step_questions(id),
  public_id TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX step_question_photos_question ON step_question_photos(question_id, created_at);
