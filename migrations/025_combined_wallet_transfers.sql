-- Combined-currency transfer debit audit. Apply after migrations 006 and 024.
-- Back up the database before applying this migration.
CREATE TABLE IF NOT EXISTS member_wallet_transfer_debits (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  transfer_id BIGINT UNSIGNED NOT NULL,
  sender_transaction_id BIGINT UNSIGNED NOT NULL,
  source_currency ENUM('NGN','USD') NOT NULL,
  source_amount DECIMAL(20,8) NOT NULL,
  target_currency ENUM('NGN','USD') NOT NULL,
  target_amount DECIMAL(20,8) NOT NULL,
  rate_used DECIMAL(20,8) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_wallet_transfer_debit_tx (sender_transaction_id),
  KEY idx_wallet_transfer_debit_transfer (transfer_id),
  CONSTRAINT fk_wallet_transfer_debit_transfer FOREIGN KEY (transfer_id) REFERENCES member_wallet_transfers(id) ON DELETE RESTRICT,
  CONSTRAINT fk_wallet_transfer_debit_tx FOREIGN KEY (sender_transaction_id) REFERENCES financial_transactions(id) ON DELETE RESTRICT,
  CONSTRAINT chk_wallet_transfer_debit_positive CHECK (source_amount > 0 AND target_amount > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
