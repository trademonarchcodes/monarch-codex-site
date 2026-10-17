-- Encrypted, per-member KYC draft. Apply after reviewing the existing production schema and taking a backup.
CREATE TABLE IF NOT EXISTS kyc_drafts (
  member_id BIGINT UNSIGNED NOT NULL,
  encrypted_payload MEDIUMTEXT NOT NULL,
  current_step TINYINT UNSIGNED NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (member_id),
  CONSTRAINT fk_kyc_drafts_member FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
