-- Monarch Codex investment packages and atomic wallet purchases.
-- Back up the production database before applying this migration.
-- No existing member, wallet, deposit, KYC, or transaction records are deleted.

CREATE TABLE IF NOT EXISTS investment_packages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(120) NOT NULL,
  description VARCHAR(1000) NOT NULL DEFAULT '',
  currency ENUM('NGN','USD') NOT NULL,
  price DECIMAL(20,8) NOT NULL,
  duration_days INT UNSIGNED NULL,
  terms VARCHAR(2000) NOT NULL DEFAULT '',
  status ENUM('draft','active','inactive') NOT NULL DEFAULT 'draft',
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_investment_packages_status_currency (status,currency,price),
  CONSTRAINT fk_investment_package_creator FOREIGN KEY (created_by) REFERENCES members(id) ON DELETE SET NULL,
  CONSTRAINT chk_investment_package_price_positive CHECK (price > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS member_investments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  member_id BIGINT UNSIGNED NOT NULL,
  package_id BIGINT UNSIGNED NULL,
  package_name_snapshot VARCHAR(120) NOT NULL,
  currency ENUM('NGN','USD') NOT NULL,
  principal_amount DECIMAL(20,8) NOT NULL,
  fee_percent DECIMAL(5,2) NOT NULL DEFAULT 1.00,
  fee_amount DECIMAL(20,8) NOT NULL,
  total_charged DECIMAL(20,8) NOT NULL,
  duration_days INT UNSIGNED NULL,
  terms_snapshot VARCHAR(2000) NOT NULL DEFAULT '',
  status ENUM('active','matured','closed') NOT NULL DEFAULT 'active',
  purchase_reference VARCHAR(100) NOT NULL,
  idempotency_key CHAR(36) NOT NULL,
  starts_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  matures_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_member_investment_reference (purchase_reference),
  UNIQUE KEY uq_member_investment_idempotency (member_id,idempotency_key),
  KEY idx_member_investments_member_created (member_id,created_at),
  KEY idx_member_investments_status_maturity (status,matures_at),
  CONSTRAINT fk_member_investment_member FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE RESTRICT,
  CONSTRAINT fk_member_investment_package FOREIGN KEY (package_id) REFERENCES investment_packages(id) ON DELETE SET NULL,
  CONSTRAINT chk_member_investment_amounts CHECK (principal_amount > 0 AND fee_amount >= 0 AND total_charged > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Existing deposit rows remain linked to deposit_requests. Investment purchases are linked
-- through investment_id and use a negative amount to represent a wallet debit.
ALTER TABLE financial_transactions
  MODIFY COLUMN deposit_request_id BIGINT UNSIGNED NULL,
  MODIFY COLUMN transaction_type ENUM('deposit_credit','investment_purchase') NOT NULL DEFAULT 'deposit_credit',
  ADD COLUMN investment_id BIGINT UNSIGNED NULL AFTER deposit_request_id,
  ADD KEY idx_financial_tx_investment (investment_id),
  ADD CONSTRAINT fk_financial_tx_investment FOREIGN KEY (investment_id) REFERENCES member_investments(id) ON DELETE RESTRICT;
