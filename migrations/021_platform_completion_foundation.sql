
CREATE TABLE IF NOT EXISTS member_notifications (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  member_id BIGINT UNSIGNED NOT NULL,
  notification_type VARCHAR(80) NOT NULL,
  title VARCHAR(180) NOT NULL,
  body VARCHAR(2000) NOT NULL,
  target_url VARCHAR(500) NULL,
  dedupe_key VARCHAR(200) NULL,
  read_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_member_notification_dedupe (member_id,dedupe_key),
  KEY idx_member_notifications_unread (member_id,read_at,created_at),
  CONSTRAINT fk_member_notifications_member FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Monarch Codex platform completion foundation.
-- Additive migration only. Back up the database and review before applying.
-- Existing members, balances, deposits, withdrawals and KYC records are not altered.

CREATE TABLE IF NOT EXISTS online_cooperative_connections (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  member_id BIGINT UNSIGNED NOT NULL,
  registered_name VARCHAR(160) NOT NULL,
  registered_email VARCHAR(254) NOT NULL,
  status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  reviewer_member_id BIGINT UNSIGNED NULL,
  review_note VARCHAR(1000) NULL,
  reviewed_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_coop_member_status (member_id,status,created_at),
  KEY idx_coop_review_queue (status,created_at),
  CONSTRAINT fk_coop_connection_member FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE,
  CONSTRAINT fk_coop_connection_reviewer FOREIGN KEY (reviewer_member_id) REFERENCES members(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS community_posts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  member_id BIGINT UNSIGNED NOT NULL,
  body TEXT NOT NULL,
  post_type ENUM('post','partner_campaign','sovereign_signal','announcement') NOT NULL DEFAULT 'post',
  status ENUM('pending','published','hidden','rejected') NOT NULL DEFAULT 'published',
  reviewed_by_member_id BIGINT UNSIGNED NULL,
  review_note VARCHAR(1000) NULL,
  reviewed_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_community_feed (status,created_at),
  KEY idx_community_member (member_id,created_at),
  CONSTRAINT fk_community_post_member FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE,
  CONSTRAINT fk_community_post_reviewer FOREIGN KEY (reviewed_by_member_id) REFERENCES members(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS community_comments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  post_id BIGINT UNSIGNED NOT NULL,
  member_id BIGINT UNSIGNED NOT NULL,
  body VARCHAR(2000) NOT NULL,
  status ENUM('published','hidden') NOT NULL DEFAULT 'published',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_community_comments_post (post_id,status,created_at),
  CONSTRAINT fk_community_comment_post FOREIGN KEY (post_id) REFERENCES community_posts(id) ON DELETE CASCADE,
  CONSTRAINT fk_community_comment_member FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS community_reports (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  post_id BIGINT UNSIGNED NOT NULL,
  reporter_member_id BIGINT UNSIGNED NOT NULL,
  reason VARCHAR(1000) NOT NULL,
  status ENUM('pending','reviewed','dismissed') NOT NULL DEFAULT 'pending',
  reviewed_by_member_id BIGINT UNSIGNED NULL,
  reviewed_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_community_reports_queue (status,created_at),
  CONSTRAINT fk_community_report_post FOREIGN KEY (post_id) REFERENCES community_posts(id) ON DELETE CASCADE,
  CONSTRAINT fk_community_reporter FOREIGN KEY (reporter_member_id) REFERENCES members(id) ON DELETE CASCADE,
  CONSTRAINT fk_community_report_reviewer FOREIGN KEY (reviewed_by_member_id) REFERENCES members(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS platform_social_links (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  link_key VARCHAR(40) NOT NULL,
  label VARCHAR(80) NOT NULL,
  url VARCHAR(1000) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 0,
  updated_by_member_id BIGINT UNSIGNED NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_platform_social_link_key (link_key),
  CONSTRAINT fk_platform_social_link_updater FOREIGN KEY (updated_by_member_id) REFERENCES members(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO platform_social_links (link_key,label,url,is_active) VALUES
 ('whatsapp','WhatsApp','https://chat.whatsapp.com/FA3x382Snhf6o68YYbsPdm',1),
 ('telegram','Telegram','https://t.me/TheMonarchCodex',1),
 ('facebook','Facebook',NULL,0),
 ('instagram','Instagram',NULL,0),
 ('youtube','YouTube','https://youtube.com/@monarchcodexonline?si=AqczxpbI9KgzMmQdQ',1),
 ('tiktok','TikTok',NULL,0),
 ('x','X',NULL,0),
 ('other','Other',NULL,0);

CREATE TABLE IF NOT EXISTS platform_admin_permissions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  admin_member_id BIGINT UNSIGNED NOT NULL,
  category_key VARCHAR(80) NOT NULL,
  access_level ENUM('green','gold','red') NOT NULL DEFAULT 'red',
  allowed_actions JSON NULL,
  updated_by_member_id BIGINT UNSIGNED NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_platform_admin_permission (admin_member_id,category_key),
  CONSTRAINT fk_platform_permission_admin FOREIGN KEY (admin_member_id) REFERENCES members(id) ON DELETE CASCADE,
  CONSTRAINT fk_platform_permission_editor FOREIGN KEY (updated_by_member_id) REFERENCES members(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS platform_action_audit (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  actor_member_id BIGINT UNSIGNED NULL,
  action_key VARCHAR(100) NOT NULL,
  target_type VARCHAR(80) NULL,
  target_id VARCHAR(100) NULL,
  details JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_platform_action_audit_created (created_at),
  KEY idx_platform_action_audit_actor (actor_member_id,created_at),
  CONSTRAINT fk_platform_action_audit_actor FOREIGN KEY (actor_member_id) REFERENCES members(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
