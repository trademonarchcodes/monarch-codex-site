-- Sovereign Desk signal validation and member/admin chat.
-- BACK UP the production database first. Apply this migration exactly once.
-- If either signal column already exists, inspect the schema and apply only the missing ALTER statement.
ALTER TABLE sovereign_signals
  ADD COLUMN price VARCHAR(100) NULL AFTER direction,
  ADD COLUMN validation_status ENUM('pending','valid','invalid') NOT NULL DEFAULT 'pending' AFTER status;

-- Existing published signals are not automatically trusted: they remain hidden until explicitly validated.
UPDATE sovereign_signals SET validation_status='pending' WHERE validation_status IS NULL OR validation_status='';

CREATE TABLE IF NOT EXISTS sovereign_chat_messages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  member_id BIGINT UNSIGNED NOT NULL,
  sender_role ENUM('member','desk') NOT NULL,
  sender_member_id BIGINT UNSIGNED NOT NULL,
  body TEXT NOT NULL,
  seen_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_sovereign_chat_member_date (member_id, created_at, id),
  KEY idx_sovereign_chat_unseen (member_id, sender_role, seen_at),
  CONSTRAINT fk_sovereign_chat_member FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE,
  CONSTRAINT fk_sovereign_chat_sender FOREIGN KEY (sender_member_id) REFERENCES members(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
