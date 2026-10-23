'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dashboard = fs.readFileSync(path.join(__dirname, '..', 'member-dashboard.js'), 'utf8');
const deposit = fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', 'deposit-wizard.js'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('member dashboard exposes a Monarch ID copy control and handles it with a fallback', () => {
  assert.match(server, /data-copy-target="memberUid"/);
  assert.match(dashboard, /document\.addEventListener\('click'/);
  assert.match(dashboard, /\[data-copy-target\]/);
  assert.match(dashboard, /navigator\.clipboard\.writeText/);
  assert.match(dashboard, /document\.execCommand\('copy'\)/);
});

test('deposit destination cards expose copy controls for bank and wallet details', () => {
  assert.match(deposit, /field\(fields,'Account number',m\.account_number,'Copy account number'\)/);
  assert.match(deposit, /field\(fields,'Account name',m\.account_name,'Copy account name'\)/);
  assert.match(deposit, /field\(fields,'Wallet address',m\.wallet_address,'Copy address'\)/);
  assert.match(deposit, /navigator\.clipboard\.writeText/);
  assert.match(deposit, /window\.prompt\('Copy this payment detail manually:'/);
});
