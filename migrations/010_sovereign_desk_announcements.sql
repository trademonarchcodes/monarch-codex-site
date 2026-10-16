-- Additive announcement storage for The Sovereign Desk.
-- Back up production and confirm earlier Sovereign Desk migrations before applying.
CREATE TABLE IF NOT EXISTS sovereign_announcements (
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
  KEY idx_sovereign_announcement_status_date (status,published_at),
  CONSTRAINT fk_sovereign_announcement_creator FOREIGN KEY (created_by) REFERENCES members(id) ON DELETE RESTRICT,
  CONSTRAINT fk_sovereign_announcement_updater FOREIGN KEY (updated_by) REFERENCES members(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
