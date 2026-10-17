-- Monarch Codex member account controls.
-- Back up the database before applying this migration.
ALTER TABLE members
  ADD COLUMN is_blocked TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN blocked_at DATETIME NULL,
  ADD COLUMN blocked_by BIGINT UNSIGNED NULL,
  ADD COLUMN block_reason VARCHAR(500) NULL;
