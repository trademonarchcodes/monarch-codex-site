-- Additive role-management schema. Safe to apply to the existing Monarch Codex database.
-- Existing member, admin, wallet, KYC, and transaction records are not altered.
CREATE TABLE IF NOT EXISTS member_role_catalog (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  role_key VARCHAR(80) NOT NULL,
  role_name VARCHAR(100) NOT NULL,
  description VARCHAR(500) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_by_member_id BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_member_role_catalog_role_key (role_key),
  CONSTRAINT fk_member_role_catalog_created_by FOREIGN KEY (created_by_member_id) REFERENCES members(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS member_role_assignments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  member_id BIGINT UNSIGNED NOT NULL,
  role_id BIGINT UNSIGNED NOT NULL,
  assigned_by_member_id BIGINT UNSIGNED NULL,
  assigned_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_member_role_assignment (member_id, role_id),
  KEY idx_member_role_assignments_role (role_id),
  CONSTRAINT fk_member_role_assignments_member FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE,
  CONSTRAINT fk_member_role_assignments_role FOREIGN KEY (role_id) REFERENCES member_role_catalog(id) ON DELETE CASCADE,
  CONSTRAINT fk_member_role_assignments_assigned_by FOREIGN KEY (assigned_by_member_id) REFERENCES members(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS member_role_requests (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  member_id BIGINT UNSIGNED NOT NULL,
  role_id BIGINT UNSIGNED NOT NULL,
  request_source ENUM('member','company') NOT NULL DEFAULT 'member',
  company_name VARCHAR(160) NULL,
  message VARCHAR(1000) NULL,
  status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  reviewed_by_member_id BIGINT UNSIGNED NULL,
  reviewed_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_member_role_requests_pending (status, created_at),
  KEY idx_member_role_requests_member_role (member_id, role_id, status),
  CONSTRAINT fk_member_role_requests_member FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE,
  CONSTRAINT fk_member_role_requests_role FOREIGN KEY (role_id) REFERENCES member_role_catalog(id) ON DELETE CASCADE,
  CONSTRAINT fk_member_role_requests_reviewed_by FOREIGN KEY (reviewed_by_member_id) REFERENCES members(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO member_role_catalog (role_key, role_name, description, is_active) VALUES
  ('investor', 'Investor', 'Investor role for members approved by Monarch Codex administrators.', 1),
  ('instructor', 'Instructor', 'Instructor role for approved community educators.', 1),
  ('student', 'Student', 'Student role for members participating in learning activities.', 1),
  ('founder_partner', 'Founder Partner', 'Company or partner role granted only after Monarch Codex administrator approval.', 1);
