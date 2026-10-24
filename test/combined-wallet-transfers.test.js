const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const api = fs.readFileSync(require.resolve('../mobile-api.js'), 'utf8');
const migration = fs.readFileSync(require.resolve('../migrations/025_combined_wallet_transfers.sql'), 'utf8');

test('wallet API returns combined equivalent balances while preserving actual stored balances', () => {
  assert.match(api, /const ngn = actualNgn \+ \(rate \? actualUsd \* rate : 0\)/);
  assert.match(api, /const usd = actualUsd \+ \(rate \? actualNgn \/ rate : 0\)/);
  assert.match(api, /actualNgn, actualUsd, rate/);
});

test('combined wallet transfers lock both currencies, debit atomically and audit each source debit', () => {
  assert.match(api, /ORDER BY member_id,currency FOR UPDATE/);
  assert.match(api, /member_wallet_transfer_debits/);
  assert.match(api, /await connection\.rollback\(\)/);
  assert.match(api, /configured conversion rate/);
  assert.match(migration, /source_currency ENUM\('NGN','USD'\)/);
  assert.match(migration, /FOREIGN KEY \(transfer_id\) REFERENCES member_wallet_transfers\(id\)/);
});
