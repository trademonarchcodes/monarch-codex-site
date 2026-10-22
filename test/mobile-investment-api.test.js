'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const api = fs.readFileSync(path.join(__dirname, '..', 'mobile-api.js'), 'utf8');

test('mobile investment purchase is a native JSON API guarded by approved KYC', () => {
  assert.match(api, /router\.post\('\/investments\/:packageId\/purchase', noStore, apiAuth, requireApprovedKycApi/);
  assert.match(api, /idempotencyKey/);
  assert.match(api, /package_unavailable/);
});

test('mobile investment purchase uses an atomic transaction and idempotency protection', () => {
  assert.match(api, /await conn\.beginTransaction\(\)/);
  assert.match(api, /WHERE member_id=\? AND idempotency_key=\? LIMIT 1 FOR UPDATE/);
  assert.match(api, /SELECT id,balance FROM member_wallets WHERE member_id=\? AND currency=\? LIMIT 1 FOR UPDATE/);
  assert.match(api, /UPDATE member_wallets SET balance=balance-\? WHERE id=\? AND balance>=\?/);
  assert.match(api, /await conn\.commit\(\)/);
  assert.match(api, /await conn\.rollback\(\)/);
});

test('mobile purchase writes investment ledger and member notification before success response', () => {
  assert.match(api, /INSERT INTO member_investments/);
  assert.match(api, /investment_purchase/);
  assert.match(api, /INSERT INTO member_notifications/);
  assert.match(api, /walletDebit/);
  assert.match(api, /insufficient_balance/);
});
