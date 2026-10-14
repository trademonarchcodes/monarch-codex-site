-- Monarch Codex admin access control.
-- Apply manually only after backing up the production database.
-- This migration intentionally creates no accounts and grants no access by email alone.
CREATE TABLE IF NOT EXISTS admin_users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  email VARCHAR(254) NOT NULL,
  password_hash VARCHAR(255) NULL,
  role ENUM('super_admin','limited_admin') NOT NULL,
  status ENUM('invited','active','suspended') NOT NULL DEFAULT 'invited',
  invited_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  activated_at TIMESTAMP NULL DEFAULT NULL,
  last_login_at TIMESTAMP NULL DEFAULT NULL,
  created_by_admin_id BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_admin_users_email (email),
  KEY idx_admin_users_status_role (status, role)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admin_audit_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  actor_admin_id BIGINT UNSIGNED NULL,
  action VARCHAR(80) NOT NULL,
  target_type VARCHAR(80) NULL,
  target_id VARCHAR(128) NULL,
  details JSON NULL,
  ip_address VARCHAR(45) NULL,
  user_agent VARCHAR(255) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_admin_audit_actor_time (actor_admin_id, created_at),
  KEY idx_admin_audit_action_time (action, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
