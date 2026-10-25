const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const wizard = fs.readFileSync(path.join(__dirname, '..', 'kyc-wizard.js'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('KYC wizard optimizes large camera images before multipart submission', () => {
  assert.match(wizard, /function prepareKycImage\(file, outputName\)/);
  assert.match(wizard, /2000 \/ Math\.max\(width, height\)/);
  assert.match(wizard, /canvas\.toBlob/);
  assert.match(wizard, /for \(var imageField of \['documentFront', 'documentBack', 'selfie'\]\)/);
  assert.match(wizard, /data\.set\(imageField, preparedImage/);
  assert.match(wizard, /Uploading your optimized verification photos securely/);
});

test('KYC wizard gives safe guidance for interrupted connections without assuming submission failed', () => {
  assert.match(wizard, /connection was interrupted before the server confirmed your submission/i);
  assert.match(wizard, /Reload the KYC page to check whether it arrived before retrying/i);
  assert.match(server, /SELECT id,status,document_front_private_key,document_back_private_key,selfie_private_key FROM kyc_submissions WHERE member_id=\? ORDER BY submitted_at DESC,id DESC LIMIT 1 FOR UPDATE/);
  assert.match(server, /already under review/);
});
