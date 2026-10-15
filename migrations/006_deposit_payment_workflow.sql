-- Monarch Codex deposits, configurable payment destinations, FX settings and wallet ledger.
-- Apply manually in phpMyAdmin after taking a database backup. No existing records are dropped.
CREATE TABLE IF NOT EXISTS deposit_pricing_settings (
  id TINYINT UNSIGNED NOT NULL,
  base_usd_ngn_rate DECIMAL(18,6) NULL,
  markup_percent DECIMAL(7,4) NOT NULL DEFAULT 0.1000,
  bank_fee_usd DECIMAL(10,2) NOT NULL DEFAULT 2.00,
  wallet_fee_usd DECIMAL(10,2) NOT NULL DEFAULT 1.00,
  updated_by BIGINT UNSIGNED NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT chk_deposit_pricing_singleton CHECK (id = 1),
  CONSTRAINT fk_deposit_pricing_admin FOREIGN KEY (updated_by) REFERENCES members(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO deposit_pricing_settings (id, base_usd_ngn_rate, markup_percent, bank_fee_usd, wallet_fee_usd)
VALUES (1, NULL, 0.1000, 2.00, 1.00)
ON DUPLICATE KEY UPDATE id = VALUES(id);

CREATE TABLE IF NOT EXISTS deposit_payment_methods (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  method_type ENUM('bank','wallet') NOT NULL,
  currency ENUM('NGN','USD') NOT NULL,
  label VARCHAR(120) NOT NULL,
  bank_name VARCHAR(120) NULL,
  account_name VARCHAR(160) NULL,
  account_number VARCHAR(80) NULL,
  bank_code VARCHAR(80) NULL,
  wallet_network VARCHAR(80) NULL,
  wallet_asset VARCHAR(40) NULL,
  wallet_address VARCHAR(255) NULL,
  instructions VARCHAR(1000) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_deposit_methods_active_currency (is_active,currency,method_type),
  CONSTRAINT fk_deposit_method_creator FOREIGN KEY (created_by) REFERENCES members(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS member_wallets (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  member_id BIGINT UNSIGNED NOT NULL,
  currency ENUM('NGN','USD') NOT NULL,
  balance DECIMAL(20,8) NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_member_wallet_currency (member_id,currency),
  CONSTRAINT fk_member_wallet_member FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS deposit_requests (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  member_id BIGINT UNSIGNED NOT NULL,
  currency ENUM('NGN','USD') NOT NULL,
  amount DECIMAL(20,8) NOT NULL,
  fee_usd DECIMAL(12,4) NOT NULL,
  fee_amount DECIMAL(20,8) NOT NULL,
  base_usd_ngn_rate DECIMAL(18,6) NOT NULL,
  effective_usd_ngn_rate DECIMAL(18,6) NOT NULL,
  total_due DECIMAL(20,8) NOT NULL,
  payment_method_id BIGINT UNSIGNED NOT NULL,
  payment_reference VARCHAR(190) NOT NULL,
  proof_storage_key VARCHAR(255) NULL,
  proof_mime_type VARCHAR(100) NULL,
  proof_original_name VARCHAR(255) NULL,
  member_note VARCHAR(1000) NULL,
  status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  reviewer_member_id BIGINT UNSIGNED NULL,
  reviewer_note VARCHAR(1000) NULL,
  reviewed_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_deposit_member_created (member_id,created_at),
  KEY idx_deposit_status_created (status,created_at),
  UNIQUE KEY uq_deposit_member_reference (member_id,payment_reference),
  CONSTRAINT fk_deposit_request_member FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE RESTRICT,
  CONSTRAINT fk_deposit_payment_method FOREIGN KEY (payment_method_id) REFERENCES deposit_payment_methods(id) ON DELETE RESTRICT,
  CONSTRAINT fk_deposit_reviewer FOREIGN KEY (reviewer_member_id) REFERENCES members(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS financial_transactions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  member_id BIGINT UNSIGNED NOT NULL,
  deposit_request_id BIGINT UNSIGNED NOT NULL,
  transaction_type ENUM('deposit_credit') NOT NULL DEFAULT 'deposit_credit',
  currency ENUM('NGN','USD') NOT NULL,
  amount DECIMAL(20,8) NOT NULL,
  reference VARCHAR(190) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_financial_tx_deposit_request (deposit_request_id),
  UNIQUE KEY uq_financial_tx_reference (reference),
  KEY idx_financial_tx_member_created (member_id,created_at),
  CONSTRAINT fk_financial_tx_member FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE RESTRICT,
  CONSTRAINT fk_financial_tx_deposit FOREIGN KEY (deposit_request_id) REFERENCES deposit_requests(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
