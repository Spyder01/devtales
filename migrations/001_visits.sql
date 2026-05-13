CREATE TABLE visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  session_id TEXT NOT NULL,
  scroll_depth INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX unique_visit
ON visits (path, session_id);
