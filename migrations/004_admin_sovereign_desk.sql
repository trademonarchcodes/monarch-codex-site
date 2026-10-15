-- Additive Sovereign Desk and notification schema.
-- Apply to the existing Monarch Codex database after migrations/002_admin_access.sql.
-- This migration never drops, truncates, or recreates existing tables.
--
-- The two administrator emails below are provisioned only if matching member accounts
-- already exist. If either account has not registered, create the account first and rerun
-- this migration. Keep DB credentials out of source control.

ALTER TABLE admin_users
  MODIFY COLUMN role ENUM('super_admin','limited_admin','main_admin','sovereign_desk_admin')
  NOT NULL DEFAULT 'limited_admin';

INSERT INTO admin_users (member_id, role, is_active)
SELECT id, 'super_admin', 1
FROM members
WHERE LOWER(email) = LOWER('trademonarchofficial@gmail.com')
LIMIT 1
ON DUPLICATE KEY UPDATE role = 'super_admin', is_active = 1;

INSERT INTO admin_users (member_id, role, is_active)
SELECT id, 'sovereign_desk_admin', 1
FROM members
WHERE LOWER(email) = LOWER('handsomeprovidence38@gmail.com')
LIMIT 1
ON DUPLICATE KEY UPDATE role = 'sovereign_desk_admin', is_active = 1;

CREATE TABLE IF NOT EXISTS sovereign_signals (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  title VARCHAR(180) NOT NULL,
  asset_pair VARCHAR(40) NOT NULL,
  direction ENUM('buy','sell','neutral') NOT NULL,
  entry_zone VARCHAR(160) NULL,
  stop_loss VARCHAR(100) NULL,
  take_profit_1 VARCHAR(100) NULL,
  take_profit_2 VARCHAR(100) NULL,
  timeframe VARCHAR(40) NULL,
  explanation TEXT NOT NULL,
  status ENUM('draft','published','closed','archived') NOT NULL DEFAULT 'draft',
  published_at TIMESTAMP NULL DEFAULT NULL,
  expires_at DATETIME NULL DEFAULT NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  updated_by BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_sovereign_signal_status_published (status, published_at),
  KEY idx_sovereign_signal_expiry (expires_at),
  KEY idx_sovereign_signal_creator (created_by, created_at),
  CONSTRAINT fk_sovereign_signal_creator FOREIGN KEY (created_by) REFERENCES members(id) ON DELETE RESTRICT,
  CONSTRAINT fk_sovereign_signal_updater FOREIGN KEY (updated_by) REFERENCES members(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sovereign_guidance (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  title VARCHAR(180) NOT NULL,
  body MEDIUMTEXT NOT NULL,
  status ENUM('draft','published','archived') NOT NULL DEFAULT 'draft',
  published_at TIMESTAMP NULL DEFAULT NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  updated_by BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_sovereign_guidance_status_published (status, published_at),
  CONSTRAINT fk_sovereign_guidance_creator FOREIGN KEY (created_by) REFERENCES members(id) ON DELETE RESTRICT,
  CONSTRAINT fk_sovereign_guidance_updater FOREIGN KEY (updated_by) REFERENCES members(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sovereign_desk_access (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  member_id BIGINT UNSIGNED NOT NULL,
  status ENUM('approved','revoked') NOT NULL DEFAULT 'approved',
  reason VARCHAR(1000) NULL,
  granted_by BIGINT UNSIGNED NOT NULL,
  granted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NULL DEFAULT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sovereign_desk_access_member (member_id),
  KEY idx_sovereign_desk_access_status_expiry (status, expires_at),
  CONSTRAINT fk_sovereign_access_member FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE,
  CONSTRAINT fk_sovereign_access_granter FOREIGN KEY (granted_by) REFERENCES members(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sovereign_access_requests (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  member_id BIGINT UNSIGNED NOT NULL,
  requested_by BIGINT UNSIGNED NOT NULL,
  status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  reason VARCHAR(1000) NOT NULL,
  reviewed_by BIGINT UNSIGNED NULL,
  reviewed_at TIMESTAMP NULL DEFAULT NULL,
  review_reason VARCHAR(1000) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_sovereign_request_status_created (status, created_at),
  KEY idx_sovereign_request_member (member_id, status),
  CONSTRAINT fk_sovereign_request_member FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE,
  CONSTRAINT fk_sovereign_requester FOREIGN KEY (requested_by) REFERENCES members(id) ON DELETE RESTRICT,
  CONSTRAINT fk_sovereign_request_reviewer FOREIGN KEY (reviewed_by) REFERENCES members(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS member_notifications (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  member_id BIGINT UNSIGNED NOT NULL,
  notification_type VARCHAR(50) NOT NULL,
  title VARCHAR(180) NOT NULL,
  body VARCHAR(1000) NOT NULL,
  target_url VARCHAR(500) NULL,
  dedupe_key VARCHAR(255) NULL,
  read_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_member_notification_dedupe (dedupe_key),
  KEY idx_member_notifications_unread (member_id, read_at, created_at),
  CONSTRAINT fk_member_notification_member FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- After applying, verify both expected rows exist in admin_users and roles are correct.
-- Do not promote arbitrary accounts to admin. The application blocks legacy limited_admin
-- accounts from these new control areas until their role has been explicitly reviewed.
