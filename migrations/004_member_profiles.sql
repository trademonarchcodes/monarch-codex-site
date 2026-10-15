-- Member profile settings. Back up the database before applying.
-- Apply manually after confirming members.id is BIGINT UNSIGNED.
CREATE TABLE IF NOT EXISTS member_profiles (
  member_id BIGINT UNSIGNED NOT NULL,
  phone_number VARCHAR(32) NULL,
  bank_details_ciphertext MEDIUMTEXT NULL,
  avatar_key VARCHAR(64) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (member_id),
  UNIQUE KEY uq_member_profiles_avatar (avatar_key),
  CONSTRAINT fk_member_profiles_member FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
