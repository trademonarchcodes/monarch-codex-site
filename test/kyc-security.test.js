'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { encryptDocumentNumber, decryptDocumentNumber, validateIdentityImage } = require('../lib/kyc-security');

const env = { KYC_DOCUMENT_ENCRYPTION_KEY_HEX: 'ab'.repeat(32) };

test('document number encrypts and decrypts', () => {
  const encrypted = encryptDocumentNumber(' ABC12345 ', env);
  assert.notEqual(encrypted, 'ABC12345');
  assert.equal(decryptDocumentNumber(encrypted, env), 'ABC12345');
});

test('document number envelope rejects tampering', () => {
  const encrypted = encryptDocumentNumber('ABC12345', env);
  const parts = encrypted.split('.');
  parts[3] = Buffer.from('tampered').toString('base64url');
  assert.throws(() => decryptDocumentNumber(parts.join('.'), env));
});

test('missing encryption key fails closed', () => {
  assert.throws(() => encryptDocumentNumber('ABC12345', {}), /key is not configured/);
});

test('rejects files whose claimed MIME type does not match bytes', () => {
  assert.deepEqual(validateIdentityImage({ buffer: Buffer.from('not an image'), declaredMimeType: 'image/jpeg' }), { ok: false, reason: 'signature_mismatch' });
});

test('accepts PNG signature within size limit', () => {
  const pngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  assert.equal(validateIdentityImage({ buffer: pngHeader, declaredMimeType: 'image/png' }).ok, true);
});

test('rejects empty and oversized images', () => {
  assert.equal(validateIdentityImage({ buffer: Buffer.alloc(0), declaredMimeType: 'image/png' }).ok, false);
  assert.equal(validateIdentityImage({ buffer: Buffer.alloc(10), declaredMimeType: 'image/png', maxBytes: 5 }).reason, 'invalid_size');
});
