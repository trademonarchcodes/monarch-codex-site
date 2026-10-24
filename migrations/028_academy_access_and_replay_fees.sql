-- Monarch Codex Academy full-access and per-replay billing.
-- Apply only after a verified database backup and after migration 005 and 016/024.
-- This migration is additive: it preserves existing lessons, progress, wallets, and ledger rows.

ALTER TABLE financial_transactions
  MODIFY COLUMN transaction_type ENUM(
    'deposit_credit',
    'investment_purchase',
    'admin_bonus',
    'investment_profit',
    'loss_adjustment',
    'wallet_transfer_sent',
    'wallet_transfer_received',
    'academy_access_purchase',
    'academy_replay_fee'
  ) NOT NULL DEFAULT 'deposit_credit';

ALTER TABLE academy_access
  ADD COLUMN access_source ENUM('admin','payment') NOT NULL DEFAULT 'admin' AFTER status,
  ADD COLUMN payment_transaction_id BIGINT UNSIGNED NULL AFTER granted_by,
  ADD COLUMN paid_amount DECIMAL(20,8) NULL AFTER payment_transaction_id,
  ADD COLUMN paid_currency ENUM('NGN','USD') NULL AFTER paid_amount,
  ADD COLUMN exchange_rate DECIMAL(20,8) NULL AFTER paid_currency,
  ADD UNIQUE KEY uq_academy_access_payment_tx (payment_transaction_id),
  ADD CONSTRAINT fk_academy_access_payment_tx FOREIGN KEY (payment_transaction_id) REFERENCES financial_transactions(id) ON DELETE RESTRICT;

CREATE TABLE IF NOT EXISTS academy_lesson_replays (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  member_id BIGINT UNSIGNED NOT NULL,
  lesson_id BIGINT UNSIGNED NOT NULL,
  transaction_id BIGINT UNSIGNED NOT NULL,
  idempotency_key CHAR(36) NOT NULL,
  fee_usd DECIMAL(20,8) NOT NULL DEFAULT 2.00000000,
  currency ENUM('NGN','USD') NOT NULL,
  amount_debited DECIMAL(20,8) NOT NULL,
  exchange_rate DECIMAL(20,8) NOT NULL DEFAULT 1.00000000,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_academy_replay_member_key (member_id,idempotency_key),
  KEY idx_academy_replay_member_lesson (member_id,lesson_id,created_at),
  CONSTRAINT fk_academy_replay_member FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE RESTRICT,
  CONSTRAINT fk_academy_replay_lesson FOREIGN KEY (lesson_id) REFERENCES academy_lessons(id) ON DELETE RESTRICT,
  CONSTRAINT fk_academy_replay_tx FOREIGN KEY (transaction_id) REFERENCES financial_transactions(id) ON DELETE RESTRICT,
  CONSTRAINT chk_academy_replay_fee_positive CHECK (fee_usd > 0 AND amount_debited > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
