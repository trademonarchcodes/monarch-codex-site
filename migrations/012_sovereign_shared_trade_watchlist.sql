-- Shared weekly trade watchlist managed by authorised Sovereign Desk administrators.
-- Back up production and verify existing migrations before applying.
CREATE TABLE IF NOT EXISTS sovereign_weekly_trades (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  instrument VARCHAR(80) NOT NULL,
  direction ENUM('buy','sell') NOT NULL,
  outcome ENUM('profit','loss','breakeven') NOT NULL,
  trade_date DATE NOT NULL,
  notes VARCHAR(1000) NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  updated_by BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_sovereign_weekly_trade_date (trade_date,id),
  KEY idx_sovereign_weekly_trade_outcome (outcome,trade_date),
  CONSTRAINT fk_sovereign_weekly_trade_creator FOREIGN KEY (created_by) REFERENCES members(id) ON DELETE RESTRICT,
  CONSTRAINT fk_sovereign_weekly_trade_updater FOREIGN KEY (updated_by) REFERENCES members(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
