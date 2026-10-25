const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const mobileApi = fs.readFileSync(path.join(__dirname, '..', 'mobile-api.js'), 'utf8');
const migration = fs.readFileSync(path.join(__dirname, '..', 'migrations', '029_academy_categories.sql'), 'utf8');

test('Academy category migration is additive and preserves member financial data', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS academy_categories/);
  assert.match(migration, /ALTER TABLE academy_lessons[\s\S]*ADD COLUMN category_id BIGINT UNSIGNED NULL/);
  assert.match(migration, /ON DELETE SET NULL/);
  assert.match(migration, /AI Tutorials/);
  assert.match(migration, /Trading Tutorial/);
  assert.doesNotMatch(migration, /UPDATE member_wallets|DELETE FROM|DROP TABLE|financial_transactions/i);
});

test('administrators can create, hide/show categories, and assign lessons to a category and order', () => {
  assert.match(server, /app\.post\('\/admin\/academy\/categories', requireAdmin/);
  assert.match(server, /app\.post\('\/admin\/academy\/categories\/:id\/toggle', requireAdmin/);
  assert.match(server, /app\.post\('\/admin\/academy\/lessons\/:id\/placement', requireAdmin/);
  assert.match(server, /SELECT id,name,description,sort_order,is_active FROM academy_categories/);
  assert.match(server, /category_id,created_by\) VALUES/);
  assert.match(server, /Save placement/);
});

test('member Academy orders lessons by category and lesson order without changing progress or fee rules', () => {
  assert.match(server, /LEFT JOIN academy_categories c ON c\.id=l\.category_id AND c\.is_active=1/);
  assert.match(server, /COALESCE\(c\.sort_order,999999\) ASC,c\.name ASC,l\.sort_order ASC,l\.id ASC/);
  assert.match(server, /Complete the current video before moving forward/);
  assert.match(server, /academyCharge\(conn,Number\(req\.session\.memberId\),10,'academy_access_purchase'/);
  assert.match(server, /academyCharge\(conn,Number\(req\.session\.memberId\),2,'academy_replay_fee'/);
});

test('mobile Academy API includes category identifiers and names for dynamically created categories', () => {
  assert.match(mobileApi, /categoryId:l\.category_id===null\?null:Number\(l\.category_id\)/);
  assert.match(mobileApi, /categoryName:l\.category_name\|\|'Unassigned'/);
  assert.match(mobileApi, /academy_categories/);
});
