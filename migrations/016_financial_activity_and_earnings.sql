-- Monarch Codex financial activity and earnings ledger extension.
-- Back up the production database before applying this migration.
-- Existing wallet, deposit, investment, and transaction records are preserved.
ALTER TABLE financial_transactions
  MODIFY COLUMN transaction_type ENUM(
    'deposit_credit',
    'investment_purchase',
    'admin_bonus',
    'investment_profit',
    'loss_adjustment'
  ) NOT NULL DEFAULT 'deposit_credit',
  ADD COLUMN admin_member_id BIGINT UNSIGNED NULL AFTER investment_id,
  ADD COLUMN admin_note VARCHAR(500) NULL AFTER reference,
  ADD KEY idx_financial_tx_type_created (transaction_type, created_at),
  ADD CONSTRAINT fk_financial_tx_admin
    FOREIGN KEY (admin_member_id) REFERENCES members(id) ON DELETE SET NULL;
