-- Additive member-owned weekly trade journal for The Sovereign Desk.
-- Back up production and verify existing Sovereign Desk migrations before applying.
CREATE TABLE IF NOT EXISTS sovereign_trade_journal (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  member_id BIGINT UNSIGNED NOT NULL,
  instrument VARCHAR(80) NOT NULL,
  direction ENUM('buy','sell') NOT NULL,
  outcome ENUM('profit','loss','breakeven') NOT NULL,
  trade_date DATE NOT NULL DEFAULT (CURRENT_DATE),
  notes VARCHAR(1000) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_sovereign_trade_member_date (member_id,trade_date,id),
  KEY idx_sovereign_trade_member_outcome (member_id,outcome,trade_date),
  CONSTRAINT fk_sovereign_trade_member FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
