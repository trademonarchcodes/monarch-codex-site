-- Monarch Codex email verification migration.
-- Apply once to the existing production database before deploying the email-verification-enabled server.
CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  member_id BIGINT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL,
  expires_at DATETIME NOT NULL,
  verified_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_email_verification_token_hash (token_hash),
  KEY idx_email_verification_member_id (member_id),
  KEY idx_email_verification_expires_at (expires_at),
  CONSTRAINT fk_email_verification_member FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
