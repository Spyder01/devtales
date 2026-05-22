CREATE TABLE comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  path       TEXT    NOT NULL,
  parent_id  INTEGER REFERENCES comments(id),
  author     TEXT    NOT NULL,
  body       TEXT    NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_comments_path ON comments(path);
