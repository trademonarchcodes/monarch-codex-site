-- Additive Monarch dashboard and Sovereign Desk features.
-- Apply manually after reviewing the existing production schema and taking a verified backup.
-- No existing account, transaction, or application data is deleted or recreated.

ALTER TABLE admin_users
  MODIFY COLUMN role ENUM('super_admin','limited_admin','sovereign_desk_admin') NOT NULL DEFAULT 'limited_admin';

CREATE TABLE IF NOT EXISTS member_notifications (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  member_id BIGINT UNSIGNED NOT NULL,
  event_key VARCHAR(190) NOT NULL,
  category VARCHAR(60) NOT NULL,
  title VARCHAR(160) NOT NULL,
  message VARCHAR(1000) NOT NULL,
  target_path VARCHAR(255) NULL,
  read_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_member_notification_event (member_id, event_key),
  KEY idx_member_notifications_unread (member_id, read_at, created_at),
  CONSTRAINT fk_member_notifications_member FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sovereign_signals (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  title VARCHAR(180) NOT NULL,
  asset_pair VARCHAR(60) NOT NULL,
  direction ENUM('buy','sell','neutral') NOT NULL DEFAULT 'neutral',
  entry_zone VARCHAR(160) NULL,
  stop_loss VARCHAR(100) NULL,
  take_profit JSON NULL,
  timeframe VARCHAR(60) NULL,
  explanation TEXT NULL,
  status ENUM('draft','published','closed','archived') NOT NULL DEFAULT 'draft',
  published_at TIMESTAMP NULL DEFAULT NULL,
  expires_at TIMESTAMP NULL DEFAULT NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  updated_by BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_sovereign_signal_status_date (status, published_at),
  KEY idx_sovereign_signal_expiry (expires_at),
  CONSTRAINT fk_sovereign_signal_creator FOREIGN KEY (created_by) REFERENCES members(id) ON DELETE RESTRICT,
  CONSTRAINT fk_sovereign_signal_updater FOREIGN KEY (updated_by) REFERENCES members(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sovereign_desk_access (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  member_id BIGINT UNSIGNED NOT NULL,
  status ENUM('active','revoked') NOT NULL DEFAULT 'active',
  granted_by BIGINT UNSIGNED NOT NULL,
  reason VARCHAR(500) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sovereign_access_member (member_id),
  KEY idx_sovereign_access_status (status, updated_at),
  CONSTRAINT fk_sovereign_access_member FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE,
  CONSTRAINT fk_sovereign_access_granter FOREIGN KEY (granted_by) REFERENCES members(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Do not automatically grant roles based on email: verify account ownership first, then
-- explicitly provision the intended member row in admin_users.
