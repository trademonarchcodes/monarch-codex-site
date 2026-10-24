'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const api = fs.readFileSync(path.join(__dirname, '..', 'mobile-api.js'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const helper = fs.readFileSync(path.join(__dirname, '..', 'lib', 'admin-fees.js'), 'utf8');
const migration = fs.readFileSync(path.join(__dirname, '..', 'migrations', '027_admin_fee_ledger.sql'), 'utf8');

test('investment fee is 10% and principal plus fee is charged', () => {
  assert.match(api, /\*0\.10,8\) AS fee/);
  assert.match(api, /total_charged/);
  assert.match(api, /10% fee for investment package/);
  assert.match(server, /\*0\.10,8\) AS fee/);
  assert.match(server, /fee_percent/);
  assert.match(server, /total_charged/);
  assert.match(server, /10% fee for investment package/);
});

test('wallet transfer fee is 5% from the gross transfer amount', () => {
  assert.match(api, /const transferFee = Math\.round\(amount \* 0\.05 \* 1e8\) \/ 1e8/);
  assert.match(api, /const recipientAmount = Math\.round\(\(amount - transferFee\) \* 1e8\) \/ 1e8/);
  assert.match(api, /feeType: 'transfer_fee'/);
  assert.match(api, /\[recipientAmount,recipientWallet\.id\]/);
});

test('admin fees are idempotently credited to the active Super Admin wallet with an audit ledger row', () => {
  assert.match(helper, /role='super_admin' AND is_active=1/);
  assert.match(helper, /INSERT IGNORE INTO admin_fee_ledger/);
  assert.match(helper, /UPDATE member_wallets SET balance=balance\+\?/);
  assert.match(helper, /admin_fee_revenue/);
  assert.match(migration, /uq_admin_fee_source_type/);
  assert.match(migration, /admin_fee_revenue/);
});
