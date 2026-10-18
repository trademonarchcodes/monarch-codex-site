-- Sovereign Desk signals subscription access and the first-20 event offer.
-- Back up production before applying. Additive only; does not alter existing member or finance records.
CREATE TABLE IF NOT EXISTS sovereign_signal_event_slots (
  id TINYINT UNSIGNED NOT NULL,
  claimed_count TINYINT UNSIGNED NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO sovereign_signal_event_slots (id, claimed_count) VALUES (1, 0);

CREATE TABLE IF NOT EXISTS sovereign_signal_access (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  member_id BIGINT UNSIGNED NOT NULL,
  access_type ENUM('event_free','paid') NOT NULL,
  status ENUM('pending','approved','rejected','revoked') NOT NULL DEFAULT 'pending',
  payment_reference VARCHAR(160) NULL,
  requested_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_by BIGINT UNSIGNED NULL,
  reviewed_at TIMESTAMP NULL DEFAULT NULL,
  review_reason VARCHAR(1000) NULL,
  starts_at TIMESTAMP NULL DEFAULT NULL,
  expires_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sovereign_signal_access_member (member_id),
  KEY idx_sovereign_signal_access_status (status, expires_at),
  KEY idx_sovereign_signal_access_type_date (access_type, requested_at),
  CONSTRAINT fk_sovereign_signal_access_member FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE,
  CONSTRAINT fk_sovereign_signal_access_reviewer FOREIGN KEY (reviewed_by) REFERENCES members(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
