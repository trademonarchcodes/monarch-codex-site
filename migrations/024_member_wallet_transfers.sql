-- Member-to-member wallet transfers. Apply after migrations 006, 011 and 016.
-- Take a verified database backup first. Existing balances and transactions are preserved.
ALTER TABLE financial_transactions
  MODIFY COLUMN transaction_type ENUM(
    'deposit_credit',
    'investment_purchase',
    'admin_bonus',
    'investment_profit',
    'loss_adjustment',
    'wallet_transfer_sent',
    'wallet_transfer_received'
  ) NOT NULL DEFAULT 'deposit_credit';

CREATE TABLE IF NOT EXISTS member_wallet_transfers (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  sender_member_id BIGINT UNSIGNED NOT NULL,
  recipient_member_id BIGINT UNSIGNED NOT NULL,
  currency ENUM('NGN','USD') NOT NULL,
  amount DECIMAL(20,8) NOT NULL,
  reference VARCHAR(190) NOT NULL,
  idempotency_key CHAR(36) NOT NULL,
  sender_transaction_id BIGINT UNSIGNED NOT NULL,
  recipient_transaction_id BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_wallet_transfer_reference (reference),
  UNIQUE KEY uq_wallet_transfer_sender_key (sender_member_id,idempotency_key),
  UNIQUE KEY uq_wallet_transfer_sender_tx (sender_transaction_id),
  UNIQUE KEY uq_wallet_transfer_recipient_tx (recipient_transaction_id),
  KEY idx_wallet_transfer_sender_created (sender_member_id,created_at),
  KEY idx_wallet_transfer_recipient_created (recipient_member_id,created_at),
  CONSTRAINT fk_wallet_transfer_sender FOREIGN KEY (sender_member_id) REFERENCES members(id) ON DELETE RESTRICT,
  CONSTRAINT fk_wallet_transfer_recipient FOREIGN KEY (recipient_member_id) REFERENCES members(id) ON DELETE RESTRICT,
  CONSTRAINT fk_wallet_transfer_sender_tx FOREIGN KEY (sender_transaction_id) REFERENCES financial_transactions(id) ON DELETE RESTRICT,
  CONSTRAINT fk_wallet_transfer_recipient_tx FOREIGN KEY (recipient_transaction_id) REFERENCES financial_transactions(id) ON DELETE RESTRICT,
  CONSTRAINT chk_wallet_transfer_distinct_members CHECK (sender_member_id <> recipient_member_id),
  CONSTRAINT chk_wallet_transfer_positive_amount CHECK (amount > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
