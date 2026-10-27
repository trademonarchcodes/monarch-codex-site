const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const migration = fs.readFileSync(path.join(__dirname, '..', 'migrations', '028_academy_access_and_replay_fees.sql'), 'utf8');

test('Academy full access costs USD-equivalent $10 and uses the authenticated shared wallet transaction', () => {
  assert.match(server, /app\.post\('\/academy\/access\/purchase', requireAuth/);
  assert.match(server, /academyCharge\(conn,Number\(req\.session\.memberId\),10,'academy_access_purchase'/);
  assert.match(server, /academy_access_purchase/);
  assert.match(server, /UPDATE member_wallets SET balance=balance-balance/ === false ? /wallet debit/ : /UPDATE member_wallets SET balance=balance-\?/);
});

test('each previous-lesson replay costs USD-equivalent $2 and creates a one-time unlock', () => {
  assert.match(server, /app\.post\('\/academy\/lessons\/:id\/replay', requireAuth/);
  assert.match(server, /academyCharge\(conn,Number\(req\.session\.memberId\),2,'academy_replay_fee'/);
  assert.match(server, /consumed_at IS NULL/);
  assert.match(server, /UPDATE academy_lesson_replays SET consumed_at=CURRENT_TIMESTAMP WHERE id=\? AND consumed_at IS NULL/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS academy_lesson_replays/);
  assert.match(migration, /UNIQUE KEY uq_academy_replay_member_key \(member_id,idempotency_key\)/);
});

test('lesson order and administrator-granted full access are enforced server-side', () => {
  assert.match(server, /Complete the current video before moving forward/);
  assert.match(server, /last_started_at/);
  assert.match(migration, /ADD COLUMN last_started_at TIMESTAMP/);
  assert.match(server, /app\.post\('\/admin\/academy\/access', requireAdmin/);
  assert.match(server, /app\.post\('\/admin\/academy\/access\/revoke', requireAdmin/);
  assert.match(migration, /access_source ENUM\('admin','payment'\)/);
});

test('Academy migration preserves admin fee transaction type when both migrations are deployed', () => {
  for (const type of ['admin_fee_revenue', 'academy_access_purchase', 'academy_replay_fee']) {
    assert.ok(migration.includes("'" + type + "'"), 'missing transaction type: ' + type);
  }
});


test('Academy category migration is additive and seeds the requested starter categories', () => {
  const categories = fs.readFileSync(path.join(__dirname, '..', 'migrations', '029_academy_categories.sql'), 'utf8');
  assert.match(categories, /CREATE TABLE IF NOT EXISTS academy_categories/);
  assert.match(categories, /ADD COLUMN category_id BIGINT UNSIGNED NULL/);
  assert.match(categories, /AI Tutorials/);
  assert.match(categories, /Trading Tutorial/);
  assert.match(categories, /ON DELETE SET NULL/);
  assert.doesNotMatch(categories, /UPDATE member_wallets|DELETE FROM financial_transactions|TRUNCATE/i);
});

test('Academy admin category creation and lesson placement routes exist', () => {
  assert.ok(server.includes("app.post('/admin/academy/categories'"));
  assert.ok(server.includes("app.post('/admin/academy/lessons/:id/placement'"));
  assert.ok(server.includes('academy_categories SET is_active=IF'));
  assert.ok(server.includes('SET category_id=?,sort_order=? WHERE id=?'));
  assert.ok(server.includes('c.name AS category_name'));
});


test('lesson progression is scoped to the lesson category, not the whole Academy', () => {
  assert.ok(server.includes("categoryLessons=lessons.filter(item=>String(item.category_id??'')===String(l.category_id??''))"));
  assert.ok(server.includes("lessons.filter(l=>String(l.category_id??'')===String(lesson.category_id??''))"));
  assert.ok(server.includes("lessons.filter(l=>String(l.category_id??'')===String(target.category_id??''))"));
});

test('Sovereign Desk support inbox is linked and member chat endpoints are present', () => {
  assert.ok(server.includes("['/sovereign-chat-admin.html','Support inbox & reports','✉']"));
  assert.ok(server.includes("href=\"/sovereign-admin/chat\"") || server.includes("'/sovereign-admin/chat'"));
  const mobileApi = fs.readFileSync(path.join(__dirname, '..', 'mobile-api.js'), 'utf8');
  for (const route of [
    "router.get('/sovereign/chat/messages'",
    "router.post('/sovereign/chat/messages'",
    "router.delete('/sovereign/chat/messages/:id'",
    "router.post('/sovereign/chat/messages/:id/report'",
    "router.get('/sovereign/chat/admin/conversations'",
    "router.post('/sovereign/chat/admin/reports/:id/review'"
  ]) assert.ok(mobileApi.includes(route), 'missing chat route: ' + route);
});
