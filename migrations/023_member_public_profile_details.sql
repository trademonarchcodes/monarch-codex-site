-- Public profile details are separate from private account/KYC data.
-- Apply once to the production database after taking a verified backup.
CREATE TABLE IF NOT EXISTS member_public_profile_details (
  member_id BIGINT UNSIGNED NOT NULL,
  location VARCHAR(120) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (member_id),
  KEY idx_member_public_profile_location (location)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
