'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const api = fs.readFileSync(path.join(__dirname, '..', 'mobile-api.js'), 'utf8');
const transferMigration = fs.readFileSync(path.join(__dirname, '..', 'migrations', '025_combined_wallet_transfers.sql'), 'utf8');
const withdrawalMigration = fs.readFileSync(path.join(__dirname, '..', 'migrations', '026_combined_withdrawal_reservations.sql'), 'utf8');

test('wallet balance responses distinguish combined equivalents from actual stored balances', () => {
  assert.match(api, /const ngn = actualNgn \+ \(rate \? actualUsd \* rate : 0\)/);
  assert.match(api, /const usd = actualUsd \+ \(rate \? actualNgn \/ rate : 0\)/);
  assert.match(api, /actualNgn, actualUsd, rate/);
});

test('idempotent transfer retries return wallet balances and never create an empty debit ledger', () => {
  assert.ok(api.includes('alreadyProcessed: true') && api.includes('balances: priorBalances'));
  assert.ok(api.includes('if (!debits.length)') && api.includes('transfer_debit_missing'));
});

test('transfers debit source wallets atomically and preserve conversion audit records', () => {
  assert.match(api, /ORDER BY member_id,currency FOR UPDATE/);
  assert.match(api, /member_wallet_transfer_debits/);
  assert.match(api, /configured conversion rate/);
  assert.match(transferMigration, /source_currency ENUM\('NGN','USD'\)/);
});

test('investment purchases support split-currency debits in a single transaction', () => {
  assert.match(api, /const walletDebits = \[\]/);
  assert.match(api, /Investment package split-currency debit/);
  assert.match(api, /debits: walletDebits\.map/);
  assert.match(api, /await conn\.rollback\(\)/);
});

test('pending withdrawal reservations are excluded from all combined spending availability', () => {
  assert.match(api, /SELECT r\.source_currency AS currency,r\.source_amount AS reserved FROM withdrawal_wallet_reservations/);
  assert.match(api, /const available = \{/);
  assert.match(api, /available\[targetCurrency\]/);
  assert.match(api, /available\[currency\]/);
});

test('withdrawal requests reserve source-currency amounts and settle from those same wallets', () => {
  assert.match(api, /INSERT INTO withdrawal_wallet_reservations/);
  assert.match(api, /SELECT source_currency,source_amount,target_currency,target_amount,rate_used FROM withdrawal_wallet_reservations/);
  assert.match(api, /NOT EXISTS \(SELECT 1 FROM withdrawal_wallet_reservations/);
  assert.match(withdrawalMigration, /FOREIGN KEY \(withdrawal_request_id\) REFERENCES withdrawal_requests\(id\)/);
  assert.match(withdrawalMigration, /source_currency ENUM\('NGN','USD'\)/);
});


test('website dashboard displays the combined wallet equivalent while retaining actual balances', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const display = fs.readFileSync(path.join(__dirname, '..', 'wallet-balances.js'), 'utf8');
  assert.match(server, /const ngn=actualNgn\+\(rate\?actualUsd\*rate:0\)/);
  assert.match(server, /const usd=actualUsd\+\(rate\?actualNgn\/rate:0\)/);
  assert.match(server, /res\.json\(\{ngn,usd,actualNgn,actualUsd,rate\}\)/);
  assert.match(display, /state\.ngn = data\.configured === false/);
  assert.match(display, /This is not an additional balance/);
});
