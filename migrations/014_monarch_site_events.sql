-- Editable homepage events with automatic expiry. Additive migration; preserves existing member and finance records.
CREATE TABLE IF NOT EXISTS monarch_site_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  title VARCHAR(180) NOT NULL,
  summary VARCHAR(1200) NOT NULL,
  event_label VARCHAR(100) NOT NULL DEFAULT 'MONARCH CODEX EVENT',
  event_key VARCHAR(100) NULL,
  starts_at DATETIME NOT NULL,
  ends_at DATETIME NOT NULL,
  status ENUM('draft','published','archived') NOT NULL DEFAULT 'draft',
  created_by BIGINT UNSIGNED NULL,
  updated_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_monarch_site_events_public (status, ends_at, starts_at),
  KEY idx_monarch_site_events_created (created_at),
  UNIQUE KEY uq_monarch_site_events_key (event_key),
  CONSTRAINT fk_monarch_site_events_created_by FOREIGN KEY (created_by) REFERENCES members(id) ON DELETE SET NULL,
  CONSTRAINT fk_monarch_site_events_updated_by FOREIGN KEY (updated_by) REFERENCES members(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Initial editable launch event. Admins can change its dates or remove it from the Homepage events screen.
INSERT INTO monarch_site_events
  (title, summary, event_label, event_key, starts_at, ends_at, status)
SELECT
  'The Sovereign Desk Signals Launch',
  'The first 20 unique members to request access from their dashboard receive the full Sovereign Desk for 14 days free. After the 20 free places are claimed, full service costs $10 for 14 days. The public weekly trade watchlist is open to everyone. Register or log in and request access from your dashboard. Trading involves risk; profits are not guaranteed.',
  'SPECIAL ACCESS EVENT · SATURDAY, 24 OCTOBER 2026',
  'sovereign_signals_launch',
  '2026-10-24 00:00:00',
  '2026-11-24 00:00:00',
  'published'
WHERE NOT EXISTS (
  SELECT 1 FROM monarch_site_events
  WHERE event_key = 'sovereign_signals_launch'
);
