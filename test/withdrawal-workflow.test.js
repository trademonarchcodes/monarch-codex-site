'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const migration = fs.readFileSync(path.join(__dirname, '..', 'migrations', '009_withdrawal_requests.sql'), 'utf8');

test('KYC premium stylesheet is linked with a correctly closed href', () => {
  assert.match(server, /<link rel="stylesheet" href="\/kyc-wizard\.css\?v=20261016-premium">/);
  assert.doesNotMatch(server, /href="\/kyc-wizard\.css\?v=20261016-premium><div/);
});

test('withdrawal readiness depends on approved KYC, a saved payout account and unreserved wallet funds', () => {
  assert.match(server, /kycApproved=kycStatus==='approved'/);
  assert.match(server, /canRequest=kycApproved&&banks\.length>0&&hasFunds/);
  assert.match(server, /app\.post\('\/withdraw'/);
  assert.match(server, /status IN \('pending','approved'\)/);
  assert.doesNotMatch(server, /Withdrawals temporarily locked/);
});

test('withdrawal admin workflow requires approval before recording a verified payment', () => {
  assert.match(server, /app\.get\('\/admin\/withdrawals'/);
  assert.match(server, /app\.post\('\/admin\/withdrawals\/:id\/review'/);
  assert.match(server, /A withdrawal must be approved before a verified transfer can be recorded/);
  assert.match(server, /withdrawal_ledger_entries/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS withdrawal_requests/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS withdrawal_ledger_entries/);
  assert.match(migration, /UNIQUE KEY uq_withdrawal_ledger_request/);
});
