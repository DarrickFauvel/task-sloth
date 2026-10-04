-- The Forest sloth look swaps the member and project colors for forest ones (MEMBER_COLORS in
-- src/services/users.js). Each old color moves to the new color in the same place in the list; anything
-- else is left alone. (The columns' DEFAULT stays the old purple; inserts now set the color themselves.)
UPDATE users SET color = CASE color
  WHEN '#6d5dfc' THEN '#5b8a3c' WHEN '#e0527a' THEN '#b04a6b' WHEN '#1f9d8b' THEN '#2f8f6b' WHEN '#e38b1b' THEN '#c0693b'
  WHEN '#3a86ff' THEN '#3c7fa6' WHEN '#8d6e63' THEN '#8a6a4f' WHEN '#7cb342' THEN '#7a68b5' END
WHERE color IN ('#6d5dfc', '#e0527a', '#1f9d8b', '#e38b1b', '#3a86ff', '#8d6e63', '#7cb342');
UPDATE projects SET color = CASE color
  WHEN '#6d5dfc' THEN '#5b8a3c' WHEN '#e0527a' THEN '#b04a6b' WHEN '#1f9d8b' THEN '#2f8f6b' WHEN '#e38b1b' THEN '#c0693b'
  WHEN '#3a86ff' THEN '#3c7fa6' WHEN '#8d6e63' THEN '#8a6a4f' WHEN '#7cb342' THEN '#7a68b5' END
WHERE color IN ('#6d5dfc', '#e0527a', '#1f9d8b', '#e38b1b', '#3a86ff', '#8d6e63', '#7cb342');
