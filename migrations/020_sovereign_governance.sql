-- Additive Sovereign Desk governance records. Does not change financial or member-access records.
CREATE TABLE IF NOT EXISTS sovereign_governance_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  item_type ENUM('concern','access_review') NOT NULL,
  subject VARCHAR(180) NOT NULL,
  details TEXT NOT NULL,
  target_member_id BIGINT UNSIGNED NULL,
  submitted_by BIGINT UNSIGNED NOT NULL,
  status ENUM('open','under_review','resolved','closed') NOT NULL DEFAULT 'open',
  resolution_note VARCHAR(2000) NULL,
  reviewed_by BIGINT UNSIGNED NULL,
  reviewed_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_sovereign_governance_status_created (status,created_at),
  KEY idx_sovereign_governance_target (target_member_id,status),
  CONSTRAINT fk_sovereign_governance_target FOREIGN KEY (target_member_id) REFERENCES members(id) ON DELETE SET NULL,
  CONSTRAINT fk_sovereign_governance_submitter FOREIGN KEY (submitted_by) REFERENCES members(id) ON DELETE RESTRICT,
  CONSTRAINT fk_sovereign_governance_reviewer FOREIGN KEY (reviewed_by) REFERENCES members(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sovereign_governance_decisions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  governance_item_id BIGINT UNSIGNED NULL,
  decision_title VARCHAR(180) NOT NULL,
  decision_details TEXT NOT NULL,
  recorded_by BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_sovereign_governance_decisions_item (governance_item_id,created_at),
  KEY idx_sovereign_governance_decisions_date (created_at),
  CONSTRAINT fk_sovereign_governance_decision_item FOREIGN KEY (governance_item_id) REFERENCES sovereign_governance_items(id) ON DELETE SET NULL,
  CONSTRAINT fk_sovereign_governance_decision_recorder FOREIGN KEY (recorded_by) REFERENCES members(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
