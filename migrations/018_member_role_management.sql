-- Monarch Codex member role catalogue and requests.
-- Safe additive migration: does not alter member balances, existing accounts, or admin roles.
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
  UNIQUE KEY uq_member_role_catalog_key (role_key),
  UNIQUE KEY uq_member_role_catalog_name (role_name),
  KEY idx_member_role_catalog_active (is_active, role_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS member_role_assignments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  member_id BIGINT UNSIGNED NOT NULL,
  role_id BIGINT UNSIGNED NOT NULL,
  assigned_by_member_id BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_member_role_assignment (member_id, role_id),
  KEY idx_member_role_assignments_role (role_id),
  CONSTRAINT fk_member_role_assignment_member FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE,
  CONSTRAINT fk_member_role_assignment_role FOREIGN KEY (role_id) REFERENCES member_role_catalog(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS member_role_requests (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  member_id BIGINT UNSIGNED NOT NULL,
  role_id BIGINT UNSIGNED NOT NULL,
  request_source ENUM('member','sovereign_desk') NOT NULL DEFAULT 'member',
  company_name VARCHAR(160) NULL,
  message VARCHAR(1000) NULL,
  status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  reviewed_by_member_id BIGINT UNSIGNED NULL,
  reviewed_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_member_role_requests_status_created (status, created_at),
  KEY idx_member_role_requests_member_role (member_id, role_id, status),
  CONSTRAINT fk_member_role_request_member FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE,
  CONSTRAINT fk_member_role_request_role FOREIGN KEY (role_id) REFERENCES member_role_catalog(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO member_role_catalog (role_key, role_name, description) VALUES
('investor', 'Investor', 'Member role for approved investment-related access.'),
('instructor', 'Instructor', 'Member role for approved teaching and academy access.'),
('student', 'Student', 'Member role for academy learners.'),
('founder_partner', 'Founder Partner', 'Partner role requiring administrator approval.');
