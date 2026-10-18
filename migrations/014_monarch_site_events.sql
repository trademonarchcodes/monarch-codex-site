-- Editable homepage events with automatic expiry. Additive migration; preserves existing member and finance records.
CREATE TABLE IF NOT EXISTS monarch_site_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  title VARCHAR(180) NOT NULL,
  summary VARCHAR(1200) NOT NULL,
  event_label VARCHAR(100) NOT NULL DEFAULT 'MONARCH CODEX EVENT',
  starts_at DATETIME NOT NULL,
  ends_at DATETIME NOT NULL,
  status ENUM('draft','published','archived') NOT NULL DEFAULT 'draft',
  created_by BIGINT UNSIGNED NULL,
  updated_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_monarch_site_events_public (status, ends_at, starts_at),
  KEY idx_monarch_site_events_created (created_at),
  CONSTRAINT fk_monarch_site_events_created_by FOREIGN KEY (created_by) REFERENCES members(id) ON DELETE SET NULL,
  CONSTRAINT fk_monarch_site_events_updated_by FOREIGN KEY (updated_by) REFERENCES members(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
