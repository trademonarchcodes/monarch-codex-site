-- Monarch Codex member transfers and service payments.
-- Back up the database and apply after migrations/006_deposit_payment_workflow.sql.
-- This is additive except for making the deposit-only ledger reference nullable and widening its type.
ALTER TABLE financial_transactions
  MODIFY deposit_request_id BIGINT UNSIGNED NULL,
  MODIFY transaction_type ENUM('deposit_credit','member_transfer_debit','member_transfer_credit','service_payment_debit') NOT NULL DEFAULT 'deposit_credit';

CREATE TABLE IF NOT EXISTS member_transfers (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  sender_member_id BIGINT UNSIGNED NOT NULL,
  recipient_member_id BIGINT UNSIGNED NOT NULL,
  currency ENUM('NGN','USD') NOT NULL,
  amount DECIMAL(20,8) NOT NULL,
  reference VARCHAR(190) NOT NULL,
  request_key CHAR(64) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_member_transfer_reference (reference),
  UNIQUE KEY uq_member_transfer_request (sender_member_id,request_key),
  KEY idx_member_transfer_recipient (recipient_member_id,created_at),
  CONSTRAINT fk_transfer_sender FOREIGN KEY (sender_member_id) REFERENCES members(id) ON DELETE RESTRICT,
  CONSTRAINT fk_transfer_recipient FOREIGN KEY (recipient_member_id) REFERENCES members(id) ON DELETE RESTRICT,
  CONSTRAINT chk_transfer_not_self CHECK (sender_member_id <> recipient_member_id),
  CONSTRAINT chk_transfer_amount_positive CHECK (amount > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS service_catalog (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(160) NOT NULL,
  description VARCHAR(1000) NULL,
  currency ENUM('NGN','USD') NOT NULL,
  price DECIMAL(20,8) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_service_catalog_active (is_active,name),
  CONSTRAINT chk_service_price_positive CHECK (price > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS service_payments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  member_id BIGINT UNSIGNED NOT NULL,
  service_id BIGINT UNSIGNED NOT NULL,
  currency ENUM('NGN','USD') NOT NULL,
  amount DECIMAL(20,8) NOT NULL,
  reference VARCHAR(190) NOT NULL,
  request_key CHAR(64) NOT NULL,
  status ENUM('completed') NOT NULL DEFAULT 'completed',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_service_payment_reference (reference),
  UNIQUE KEY uq_service_payment_request (member_id,request_key),
  KEY idx_service_payment_member_created (member_id,created_at),
  CONSTRAINT fk_service_payment_member FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE RESTRICT,
  CONSTRAINT fk_service_payment_service FOREIGN KEY (service_id) REFERENCES service_catalog(id) ON DELETE RESTRICT,
  CONSTRAINT chk_service_payment_amount_positive CHECK (amount > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
