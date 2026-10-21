-- Sovereign Desk governance concerns, access-review requests, and recorded decisions.
-- Additive only. Back up production and verify the target database before applying.
CREATE TABLE IF NOT EXISTS sovereign_governance_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  item_type ENUM('concern','access_review','decision') NOT NULL,
  status ENUM('open','in_review','resolved','rejected','recorded') NOT NULL DEFAULT 'open',
  title VARCHAR(180) NOT NULL,
  details TEXT NOT NULL,
  subject_member_id BIGINT UNSIGNED NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  decision_text TEXT NULL,
  decided_by BIGINT UNSIGNED NULL,
  decided_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_sovereign_governance_status_date (status,created_at),
  KEY idx_sovereign_governance_type_date (item_type,created_at),
  KEY idx_sovereign_governance_subject (subject_member_id,status),
  CONSTRAINT fk_sovereign_governance_subject FOREIGN KEY (subject_member_id) REFERENCES members(id) ON DELETE SET NULL,
  CONSTRAINT fk_sovereign_governance_creator FOREIGN KEY (created_by) REFERENCES members(id) ON DELETE RESTRICT,
  CONSTRAINT fk_sovereign_governance_decider FOREIGN KEY (decided_by) REFERENCES members(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
