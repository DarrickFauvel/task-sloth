-- A project can show a logo (PROJECT_ICONS in src/services/projects.js, files in public/img/project-icons/) in place
-- of its emoji where there's room for a picture. The emoji stays for text (dropdowns, suggestions, toasts) and for
-- when the logo isn't set. NULL means no logo.
ALTER TABLE projects ADD COLUMN icon TEXT;
