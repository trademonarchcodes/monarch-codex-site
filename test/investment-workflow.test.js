'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const migration = fs.readFileSync(path.join(__dirname, '..', 'migrations', '011_investment_packages_and_purchases.sql'), 'utf8');

test('members can reach investments from the dashboard and package page', () => {
  assert.match(server, /app\.get\('\/investments', requireAuth, requireApprovedKyc/);
  assert.match(server, /app\.post\('\/investments\/:packageId\/purchase', requireAuth, requireApprovedKyc, csrfCheck/);
  assert.match(server, /href="\/investments"/);
  assert.match(server, /name="idempotency_key"/);
});

test('investment purchase charges 1 percent on top of package principal', () => {
  assert.match(server, /ROUND\(CAST\(\? AS DECIMAL\(20,8\)\)\*0\.01,8\) AS fee/);
  assert.match(server, /balance=balance-\? WHERE id=\? AND balance>=\?/);
  assert.match(server, /total wallet deduction/);
  assert.match(migration, /fee_percent DECIMAL\(5,2\) NOT NULL DEFAULT 1\.00/);
  assert.match(migration, /total_charged DECIMAL\(20,8\) NOT NULL/);
});

test('purchase writes wallet debit, investment record and member notification in one transaction', () => {
  assert.match(server, /await conn\.beginTransaction\(\)/);
  assert.match(server, /INSERT INTO member_investments/);
  assert.match(server, /INSERT INTO financial_transactions \(member_id,deposit_request_id,investment_id,transaction_type,currency,amount,reference\)/);
  assert.match(server, /INSERT INTO member_notifications/);
  assert.match(server, /await conn\.commit\(\)/);
  assert.match(server, /await conn\.rollback\(\)/);
});

test('purchase idempotency and wallet balance locks prevent repeat charges', () => {
  assert.match(server, /UNIQUE KEY uq_member_investment_idempotency \(member_id,idempotency_key\)/);
  assert.match(server, /idempotency_key=\? LIMIT 1 FOR UPDATE/);
  assert.match(server, /SELECT id,balance FROM member_wallets WHERE member_id=\? AND currency=\? LIMIT 1 FOR UPDATE/);
  assert.match(server, /purchase=already/);
});

test('investment package data is configurable without inventing plans or returns', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS investment_packages/);
  assert.match(migration, /status ENUM\('draft','active','inactive'\)/);
  assert.match(server, /app\.get\('\/admin\/investments', requireFinanceAdmin/);
  assert.match(server, /app\.post\('\/admin\/investments\/packages', requireFinanceAdmin/);
  assert.match(server, /No investment packages are published yet/);
  assert.doesNotMatch(migration, /roi_percent|guaranteed_return|profit_rate/i);
});
