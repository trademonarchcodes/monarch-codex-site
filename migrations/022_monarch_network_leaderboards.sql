-- Monarch Codex Network + monthly/all-time referral leaderboard.
-- Additive only. Back up production before applying.
ALTER TABLE monarch_public_profiles
  ADD COLUMN IF NOT EXISTS bio VARCHAR(600) NULL,
  ADD COLUMN IF NOT EXISTS profile_status ENUM('draft','pending','published','unpublished','rejected') NOT NULL DEFAULT 'draft';

UPDATE monarch_public_profiles
SET profile_status = CASE WHEN approved=1 AND visible=1 AND requested=1 THEN 'published'
                          WHEN requested=1 THEN 'pending'
                          WHEN approved=1 AND visible=0 THEN 'unpublished'
                          ELSE 'draft' END;

CREATE TABLE IF NOT EXISTS monarch_network_audit (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  actor_member_id BIGINT UNSIGNED NULL,
  target_member_id BIGINT UNSIGNED NOT NULL,
  action VARCHAR(80) NOT NULL,
  before_data JSON NULL,
  after_data JSON NULL,
  note VARCHAR(500) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_network_audit_target_created (target_member_id,created_at),
  KEY idx_network_audit_actor_created (actor_member_id,created_at),
  CONSTRAINT fk_network_audit_actor FOREIGN KEY (actor_member_id) REFERENCES members(id) ON DELETE SET NULL,
  CONSTRAINT fk_network_audit_target FOREIGN KEY (target_member_id) REFERENCES members(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS monarch_leaderboard_monthly_archive (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  period_month CHAR(7) NOT NULL,
  member_id BIGINT UNSIGNED NOT NULL,
  direct_referrals INT UNSIGNED NOT NULL DEFAULT 0,
  network_size INT UNSIGNED NOT NULL DEFAULT 0,
  rank_position INT UNSIGNED NOT NULL,
  archived_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_monarch_monthly_archive (period_month,member_id),
  KEY idx_monarch_monthly_archive_rank (period_month,rank_position),
  CONSTRAINT fk_monarch_monthly_archive_member FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
