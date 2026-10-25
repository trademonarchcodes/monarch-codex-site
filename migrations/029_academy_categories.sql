-- Monarch Codex Academy categories and lesson placement.
-- Additive only: does not alter wallets, financial transactions, existing lesson content, or student progress.
-- Take a verified production database backup before applying.
CREATE TABLE IF NOT EXISTS academy_categories (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(100) NOT NULL,
  slug VARCHAR(100) NOT NULL,
  description VARCHAR(500) NOT NULL DEFAULT '',
  sort_order INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_academy_categories_name (name),
  UNIQUE KEY uq_academy_categories_slug (slug),
  KEY idx_academy_categories_active_order (is_active, sort_order, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
ALTER TABLE academy_lessons
  ADD COLUMN category_id BIGINT UNSIGNED NULL AFTER description,
  ADD KEY idx_academy_lessons_category_order (category_id, sort_order, id),
  ADD CONSTRAINT fk_academy_lesson_category
    FOREIGN KEY (category_id) REFERENCES academy_categories(id) ON DELETE SET NULL;
INSERT IGNORE INTO academy_categories (name, slug, description, sort_order, is_active)
VALUES
  ('AI Tutorials', 'ai-tutorials', 'Learn practical AI tools and workflows.', 10, 1),
  ('Trading Tutorial', 'trading-tutorial', 'Learn trading concepts and disciplined practice.', 20, 1);
