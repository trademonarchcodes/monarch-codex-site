-- Monarch Codex explicit administrator access control.
-- Run after the core members table exists. This migration does not grant access to any account.
CREATE TABLE IF NOT EXISTS admin_users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  member_id BIGINT UNSIGNED NOT NULL,
  role ENUM('super_admin','limited_admin') NOT NULL DEFAULT 'limited_admin',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_admin_users_member (member_id),
  KEY idx_admin_users_active_role (is_active, role),
  CONSTRAINT fk_admin_users_member FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  admin_member_id BIGINT UNSIGNED NOT NULL,
  action VARCHAR(100) NOT NULL,
  target_type VARCHAR(60) NULL,
  target_id VARCHAR(100) NULL,
  details JSON NULL,
  ip_address VARCHAR(45) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_admin_audit_created (created_at),
  KEY idx_admin_audit_actor (admin_member_id, created_at),
  CONSTRAINT fk_admin_audit_admin FOREIGN KEY (admin_member_id) REFERENCES members(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
