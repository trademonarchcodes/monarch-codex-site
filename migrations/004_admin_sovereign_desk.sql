-- Sovereign Desk content and access workflow. Additive only; never reset production tables.
-- Apply after migrations/002_admin_access.sql and a verified backup.
CREATE TABLE IF NOT EXISTS sovereign_signals (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  title VARCHAR(180) NOT NULL,
  asset_pair VARCHAR(40) NOT NULL,
  direction ENUM('buy','sell','neutral') NOT NULL DEFAULT 'neutral',
  entry_zone VARCHAR(160) NULL,
  stop_loss VARCHAR(100) NULL,
  take_profit_1 VARCHAR(100) NULL,
  take_profit_2 VARCHAR(100) NULL,
  timeframe VARCHAR(40) NULL,
  explanation TEXT NOT NULL,
  status ENUM('draft','published','closed','archived') NOT NULL DEFAULT 'draft',
  published_at TIMESTAMP NULL DEFAULT NULL,
  expires_at TIMESTAMP NULL DEFAULT NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  updated_by BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_sovereign_signal_status_date (status,published_at),
  KEY idx_sovereign_signal_expiry (expires_at),
  CONSTRAINT fk_sovereign_signal_creator FOREIGN KEY (created_by) REFERENCES members(id) ON DELETE RESTRICT,
  CONSTRAINT fk_sovereign_signal_updater FOREIGN KEY (updated_by) REFERENCES members(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sovereign_guidance (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  title VARCHAR(180) NOT NULL,
  body TEXT NOT NULL,
  status ENUM('draft','published','archived') NOT NULL DEFAULT 'draft',
  published_at TIMESTAMP NULL DEFAULT NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  updated_by BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_sovereign_guidance_status_date (status,published_at),
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
  expires_at TIMESTAMP NULL DEFAULT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sovereign_access_member (member_id),
  KEY idx_sovereign_access_status (status,expires_at),
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
  PRIMARY KEY (id),
  KEY idx_sovereign_request_status_date (status,created_at),
  KEY idx_sovereign_request_member (member_id,status),
  CONSTRAINT fk_sovereign_request_member FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE,
  CONSTRAINT fk_sovereign_requester FOREIGN KEY (requested_by) REFERENCES members(id) ON DELETE RESTRICT,
  CONSTRAINT fk_sovereign_request_reviewer FOREIGN KEY (reviewed_by) REFERENCES members(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
