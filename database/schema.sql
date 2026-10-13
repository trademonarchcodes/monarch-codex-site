-- Monarch Codex membership schema (MySQL 8+)
-- Import this file into a NEW, EMPTY Hostinger database.
-- Do not import into an existing production database without a backup.

CREATE TABLE IF NOT EXISTS members (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  monarch_uid CHAR(13) NOT NULL,
  full_name VARCHAR(120) NOT NULL,
  email VARCHAR(254) NOT NULL,
  phone VARCHAR(32) NOT NULL,
  username VARCHAR(30) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  referred_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_members_monarch_uid (monarch_uid),
  UNIQUE KEY uq_members_email (email),
  UNIQUE KEY uq_members_username (username),
  KEY idx_members_referred_by (referred_by),
  CONSTRAINT fk_members_referrer FOREIGN KEY (referred_by) REFERENCES members(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS password_resets (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  member_id BIGINT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL,
  expires_at DATETIME NOT NULL,
  used_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_password_resets_token_hash (token_hash),
  KEY idx_password_resets_member_id (member_id),
  KEY idx_password_resets_expires_at (expires_at),
  CONSTRAINT fk_password_resets_member FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS web_sessions (
  session_id VARCHAR(128) NOT NULL,
  expires INT UNSIGNED NOT NULL,
  data MEDIUMTEXT,
  PRIMARY KEY (session_id),
  KEY idx_web_sessions_expires (expires)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
