-- Sovereign Desk signal validation and member/admin chat.
-- BACK UP the production database first. Apply this migration exactly once.
-- Idempotently add each column only when missing. Safe if price was added manually or by a partial earlier migration.
SET @has_price := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='sovereign_signals' AND COLUMN_NAME='price');
SET @sql_price := IF(@has_price=0, 'ALTER TABLE sovereign_signals ADD COLUMN price VARCHAR(100) NULL AFTER direction', 'SELECT 1');
PREPARE stmt_price FROM @sql_price;
EXECUTE stmt_price;
DEALLOCATE PREPARE stmt_price;

SET @has_validation := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='sovereign_signals' AND COLUMN_NAME='validation_status');
SET @sql_validation := IF(@has_validation=0, 'ALTER TABLE sovereign_signals ADD COLUMN validation_status ENUM(''pending'',''valid'',''invalid'') NOT NULL DEFAULT ''pending'' AFTER status', 'SELECT 1');
PREPARE stmt_validation FROM @sql_validation;
EXECUTE stmt_validation;
DEALLOCATE PREPARE stmt_validation;

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
