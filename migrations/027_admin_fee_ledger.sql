-- Extend the transaction ledger with auditable admin-fee revenue.
-- Keep every transaction type introduced by the Academy migration as well.
-- This additive change preserves historical transaction rows and balances.
ALTER TABLE financial_transactions
  MODIFY COLUMN transaction_type ENUM(
    'deposit_credit',
    'investment_purchase',
    'admin_bonus',
    'investment_profit',
    'loss_adjustment',
    'wallet_transfer_sent',
    'wallet_transfer_received',
    'admin_fee_revenue',
    'academy_access_purchase',
    'academy_replay_fee'
  ) NOT NULL DEFAULT 'deposit_credit';

-- Monarch Codex auditable admin fee revenue.
-- Apply after the existing member_wallets, admin_users and financial_transactions tables exist.
-- Additive only: does not alter historical balances or transactions.
CREATE TABLE IF NOT EXISTS admin_fee_ledger (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  admin_member_id BIGINT UNSIGNED NOT NULL,
  payer_member_id BIGINT UNSIGNED NOT NULL,
  fee_type VARCHAR(40) NOT NULL,
  currency ENUM('NGN','USD') NOT NULL,
  amount DECIMAL(20,8) NOT NULL,
  source_reference VARCHAR(120) NOT NULL,
  admin_transaction_id BIGINT UNSIGNED NULL,
  description VARCHAR(500) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_admin_fee_source_type (source_reference, fee_type),
  KEY idx_admin_fee_admin_created (admin_member_id, created_at),
  KEY idx_admin_fee_payer_created (payer_member_id, created_at),
  CONSTRAINT fk_admin_fee_admin_member FOREIGN KEY (admin_member_id) REFERENCES members(id) ON DELETE RESTRICT,
  CONSTRAINT fk_admin_fee_payer_member FOREIGN KEY (payer_member_id) REFERENCES members(id) ON DELETE RESTRICT,
  CONSTRAINT chk_admin_fee_positive CHECK (amount > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
