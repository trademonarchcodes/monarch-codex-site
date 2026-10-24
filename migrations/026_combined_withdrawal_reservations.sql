-- Combined-currency wallet reservations for withdrawal requests.
-- Take a database backup, then apply after the existing wallet and withdrawal migrations.
CREATE TABLE IF NOT EXISTS withdrawal_wallet_reservations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  withdrawal_request_id BIGINT UNSIGNED NOT NULL,
  member_id BIGINT UNSIGNED NOT NULL,
  source_currency ENUM('NGN','USD') NOT NULL,
  source_amount DECIMAL(20,8) NOT NULL,
  target_currency ENUM('NGN','USD') NOT NULL,
  target_amount DECIMAL(20,8) NOT NULL,
  rate_used DECIMAL(18,8) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_withdrawal_reservation_source (withdrawal_request_id,source_currency),
  KEY idx_withdrawal_reservation_member_currency (member_id,source_currency),
  CONSTRAINT fk_withdrawal_reservation_request FOREIGN KEY (withdrawal_request_id) REFERENCES withdrawal_requests(id) ON DELETE RESTRICT,
  CONSTRAINT fk_withdrawal_reservation_member FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE RESTRICT,
  CONSTRAINT chk_withdrawal_reservation_positive CHECK (source_amount > 0 AND target_amount > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
