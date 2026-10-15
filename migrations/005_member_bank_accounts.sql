-- Multiple private payout accounts per member.
-- Back up the database first. Confirm members.id is BIGINT UNSIGNED before applying.
CREATE TABLE IF NOT EXISTS member_bank_accounts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  member_id BIGINT UNSIGNED NOT NULL,
  details_ciphertext MEDIUMTEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP NULL DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_member_bank_accounts_member_active (member_id, deleted_at, id),
  CONSTRAINT fk_member_bank_accounts_member FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO member_bank_accounts (member_id, details_ciphertext)
SELECT mp.member_id, mp.bank_details_ciphertext
FROM member_profiles mp
WHERE mp.bank_details_ciphertext IS NOT NULL
  AND mp.bank_details_ciphertext <> ''
  AND NOT EXISTS (
    SELECT 1 FROM member_bank_accounts mba
    WHERE mba.member_id = mp.member_id
      AND mba.details_ciphertext = mp.bank_details_ciphertext
  );
