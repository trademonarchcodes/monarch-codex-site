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
