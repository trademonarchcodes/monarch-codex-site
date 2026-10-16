'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const migration = fs.readFileSync(path.join(__dirname, '..', 'migrations', '009_withdrawal_requests.sql'), 'utf8');

test('KYC premium stylesheet is linked with a correctly closed href', () => {
  assert.ok(server.includes('<link rel="stylesheet" href="/kyc-wizard.css?v=20261016-rebuild2">'));
  assert.ok(!server.includes('href="/kyc-wizard.css?v=20261016-rebuild2><div'));
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


test('approved KYC renders through the dedicated premium page shell', () => {
  assert.match(server, /if \(existingKycStatus === 'approved'\)/);
  assert.match(server, /return res\.send\(wizardPage\('KYC Verification',approvedContent,req\)\)/);
  assert.match(server, /kyc-status-card/);
  assert.match(server, /kyc-member-links/);
  assert.doesNotMatch(server, /Continue to withdrawals/);
  assert.match(server, /res\.set\('Cache-Control','no-store'\);\s*if \(existingKycStatus === 'approved'\)/);
});


test('KYC status pages share the dedicated verification shell and normalize stored status', () => {
  assert.ok(server.includes("existingKycStatus = String(existingKycRows[0].status || '').trim().toLowerCase();"));
  assert.ok(server.includes("return res.send(wizardPage('KYC Verification',approvedContent,req));"));
  assert.ok(server.includes("return res.send(wizardPage('KYC Verification',pendingContent,req));"));
  assert.ok(!server.includes("return res.send(memberPage('KYC verification','/kyc',m,pendingContent,req));"));
  assert.ok(server.includes('kyc-status-card'));
  assert.ok(server.includes('kyc-review-notice'));
  assert.ok(server.includes('href="/kyc-wizard.css?v=20261016-rebuild2"'));
});

test('KYC page styling is a single responsive design system for form and review states', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'kyc-wizard.css'), 'utf8');
  assert.ok(css.includes('.kyc-status-card'));
  assert.ok(css.includes('.kyc-status-pending'));
  assert.ok(css.includes('.kyc-review-notice.is-rejected'));
  assert.ok(css.includes('@media(max-width:520px)'));
  assert.ok(css.includes('prefers-reduced-motion:reduce'));
  assert.ok(!css.includes('/* Approved state: purpose-built success screen'));
});

test('KYC submission requires a back image except for passports and redirects to review status', () => {
  const client = fs.readFileSync(path.join(__dirname, '..', 'kyc-wizard.js'), 'utf8');
  assert.ok(server.includes("!front || (!back && b.documentType !== 'passport') || !selfie"));
  assert.ok(client.includes("selectedDocType !== 'passport' && (!backImage.files || !backImage.files.length)"));
  assert.ok(client.includes("window.location.assign('/kyc')"));
});


test('withdrawal page layout is scoped, responsive and offers account shortcuts', () => {
  assert.match(server, /withdraw-overview/);
  assert.match(server, /withdraw-hero-nav/);
  assert.match(server, /@media\(max-width:820px\)/);
  assert.match(server, /\.withdraw-page \.withdraw-panel/);
  assert.match(server, /withdraw-history-empty/);
});
