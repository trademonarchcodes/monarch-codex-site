-- Monarch Codex withdrawal request workflow.
-- Apply after migrations/005_member_bank_accounts.sql, migrations/006_deposit_payment_workflow.sql,
-- and migrations/008_deposit_review_notifications.sql. Back up production data first.
-- Requests reserve wallet funds while pending/approved; funds are debited only after an admin
-- records a verified real-world transfer. Maturity eligibility is reviewed manually by an admin.

CREATE TABLE IF NOT EXISTS withdrawal_requests (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  member_id BIGINT UNSIGNED NOT NULL,
  bank_account_id BIGINT UNSIGNED NULL,
  bank_details_ciphertext MEDIUMTEXT NOT NULL,
  currency ENUM('NGN','USD') NOT NULL,
  amount DECIMAL(20,8) NOT NULL,
  member_note VARCHAR(500) NULL,
  status ENUM('pending','approved','rejected','paid','cancelled') NOT NULL DEFAULT 'pending',
  reviewer_member_id BIGINT UNSIGNED NULL,
  reviewer_note VARCHAR(1000) NULL,
  payment_reference VARCHAR(190) NULL,
  reviewed_at TIMESTAMP NULL DEFAULT NULL,
  paid_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_withdrawal_member_status_created (member_id,status,created_at),
  KEY idx_withdrawal_status_created (status,created_at),
  UNIQUE KEY uq_withdrawal_payment_reference (payment_reference),
  CONSTRAINT fk_withdrawal_member FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE RESTRICT,
  CONSTRAINT fk_withdrawal_bank_account FOREIGN KEY (bank_account_id) REFERENCES member_bank_accounts(id) ON DELETE SET NULL,
  CONSTRAINT fk_withdrawal_reviewer FOREIGN KEY (reviewer_member_id) REFERENCES members(id) ON DELETE SET NULL,
  CONSTRAINT chk_withdrawal_amount_positive CHECK (amount > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS withdrawal_ledger_entries (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  withdrawal_request_id BIGINT UNSIGNED NOT NULL,
  member_id BIGINT UNSIGNED NOT NULL,
  currency ENUM('NGN','USD') NOT NULL,
  amount DECIMAL(20,8) NOT NULL,
  payment_reference VARCHAR(190) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_withdrawal_ledger_request (withdrawal_request_id),
  UNIQUE KEY uq_withdrawal_ledger_reference (payment_reference),
  KEY idx_withdrawal_ledger_member_created (member_id,created_at),
  CONSTRAINT fk_withdrawal_ledger_request FOREIGN KEY (withdrawal_request_id) REFERENCES withdrawal_requests(id) ON DELETE RESTRICT,
  CONSTRAINT fk_withdrawal_ledger_member FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE RESTRICT,
  CONSTRAINT chk_withdrawal_ledger_amount_positive CHECK (amount > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
