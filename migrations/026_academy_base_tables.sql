-- Monarch Codex Academy base tables.
-- Additive only: creates Academy tables if absent; does not alter wallets,
-- balances, financial transactions, members, or existing lesson records.
-- Take a verified production database backup before applying.
-- Apply before migrations/028_academy_access_and_replay_fees.sql.

CREATE TABLE IF NOT EXISTS academy_lessons (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  title VARCHAR(180) NOT NULL,
  description VARCHAR(1000) NOT NULL DEFAULT '',
  content MEDIUMTEXT NOT NULL,
  video_url VARCHAR(1000) NULL,
  access_level ENUM('free','premium') NOT NULL DEFAULT 'free',
  status ENUM('draft','published','archived') NOT NULL DEFAULT 'draft',
  sort_order INT NOT NULL DEFAULT 0,
  created_by BIGINT UNSIGNED NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_academy_lessons_status_order (status, sort_order, created_at),
  CONSTRAINT fk_academy_lesson_creator
    FOREIGN KEY (created_by) REFERENCES members(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS academy_access (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  member_id BIGINT UNSIGNED NOT NULL,
  status ENUM('approved','revoked') NOT NULL DEFAULT 'approved',
  granted_by BIGINT UNSIGNED NOT NULL,
  reason VARCHAR(500) NULL,
  expires_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_academy_access_member (member_id),
  KEY idx_academy_access_status (status, expires_at),
  CONSTRAINT fk_academy_access_member
    FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE,
  CONSTRAINT fk_academy_access_granter
    FOREIGN KEY (granted_by) REFERENCES members(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS academy_progress (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  member_id BIGINT UNSIGNED NOT NULL,
  lesson_id BIGINT UNSIGNED NOT NULL,
  completed_at TIMESTAMP NULL DEFAULT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_academy_progress_member_lesson (member_id, lesson_id),
  KEY idx_academy_progress_member (member_id, completed_at),
  CONSTRAINT fk_academy_progress_member
    FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE,
  CONSTRAINT fk_academy_progress_lesson
    FOREIGN KEY (lesson_id) REFERENCES academy_lessons(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
