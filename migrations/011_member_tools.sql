CREATE TABLE IF NOT EXISTS member_tools (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(120) NOT NULL,
  description VARCHAR(500) NOT NULL DEFAULT '',
  url VARCHAR(2048) NOT NULL,
  category VARCHAR(80) NOT NULL DEFAULT 'Class tools',
  icon VARCHAR(24) NOT NULL DEFAULT '↗',
  sort_order INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_member_tools_active_order (is_active, sort_order, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO member_tools (title,description,url,category,icon,sort_order,is_active)
SELECT 'Bybit','Exchange app used for selected class demonstrations. Availability and features vary by region.','https://www.bybit.com/invite?ref=ZDWQB3B&medium=referral&utm_campaign=evergreen&share_to=post','Trading & exchanges','↗',10,1
WHERE NOT EXISTS (SELECT 1 FROM member_tools WHERE title='Bybit');
INSERT INTO member_tools (title,description,url,category,icon,sort_order,is_active)
SELECT 'WEEX','Exchange app used for selected class demonstrations. Availability and features vary by region.','https://weex.com/register?vipCode=h3wh','Trading & exchanges','↗',20,1
WHERE NOT EXISTS (SELECT 1 FROM member_tools WHERE title='WEEX');
INSERT INTO member_tools (title,description,url,category,icon,sort_order,is_active)
SELECT 'Google Flow','AI filmmaking and creative workflow tool for class projects.','https://labs.google/fx/tools/flow/','AI & productivity','✦',30,1
WHERE NOT EXISTS (SELECT 1 FROM member_tools WHERE title='Google Flow');
INSERT INTO member_tools (title,description,url,category,icon,sort_order,is_active)
SELECT 'TradingView','Charts and market-analysis workspace for practice and demonstrations.','https://www.tradingview.com/pricing/?share_your_love=TradeMonarch&mobileapp=true','Charts & analysis','⌁',40,1
WHERE NOT EXISTS (SELECT 1 FROM member_tools WHERE title='TradingView');
