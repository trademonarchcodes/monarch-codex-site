-- Additive Monarch dashboard support. Apply after reviewing schema and taking a verified backup.
-- Existing account, profile, KYC, and financial records are preserved.

ALTER TABLE admin_users
  MODIFY COLUMN role ENUM('super_admin','main_admin','limited_admin','sovereign_desk_admin') NOT NULL DEFAULT 'limited_admin';

CREATE TABLE IF NOT EXISTS member_notifications (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  member_id BIGINT UNSIGNED NOT NULL,
  notification_type VARCHAR(60) NOT NULL,
  title VARCHAR(160) NOT NULL,
  body VARCHAR(1000) NOT NULL,
  target_url VARCHAR(255) NULL,
  dedupe_key VARCHAR(190) NOT NULL,
  read_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_member_notification_dedupe (member_id,dedupe_key),
  KEY idx_member_notifications_unread (member_id,read_at,created_at),
  CONSTRAINT fk_member_notifications_member FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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
  KEY idx_academy_lessons_status_order (status,sort_order,created_at),
  CONSTRAINT fk_academy_lesson_creator FOREIGN KEY (created_by) REFERENCES members(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS academy_progress (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  member_id BIGINT UNSIGNED NOT NULL,
  lesson_id BIGINT UNSIGNED NOT NULL,
  completed_at TIMESTAMP NULL DEFAULT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_academy_progress_member_lesson (member_id,lesson_id),
  KEY idx_academy_progress_member (member_id,completed_at),
  CONSTRAINT fk_academy_progress_member FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE,
  CONSTRAINT fk_academy_progress_lesson FOREIGN KEY (lesson_id) REFERENCES academy_lessons(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Administrator rows are deliberately not provisioned by email alone. Verify account ownership
-- and explicitly add the correct member_id to admin_users through a trusted operator workflow.
