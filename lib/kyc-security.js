'use strict';

const crypto = require('node:crypto');

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png']);

/**
 * Read a 32-byte AES key from KYC_DOCUMENT_ENCRYPTION_KEY_HEX.
 * Generate it outside the app (for example: openssl rand -hex 32) and store it
 * only in the hosting provider's secret/environment settings.
 */
function getDocumentEncryptionKey(env = process.env) {
  const value = env.KYC_DOCUMENT_ENCRYPTION_KEY_HEX;
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error('KYC document encryption key is not configured correctly');
  }
  return Buffer.from(value, 'hex');
}

/** Authenticated encryption for document numbers; persist only this envelope. */
function encryptDocumentNumber(value, env = process.env) {
  if (typeof value !== 'string' || value.trim().length < 3 || value.length > 128) {
    throw new TypeError('Document number is invalid');
  }
  const key = getDocumentEncryptionKey(env);
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(value.trim(), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', nonce.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

function decryptDocumentNumber(envelope, env = process.env) {
  if (typeof envelope !== 'string') throw new TypeError('Encrypted document number is invalid');
  const parts = envelope.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new TypeError('Encrypted document number is invalid');
  const [, nonceText, tagText, ciphertextText] = parts;
  const nonce = Buffer.from(nonceText, 'base64url');
  const tag = Buffer.from(tagText, 'base64url');
  const ciphertext = Buffer.from(ciphertextText, 'base64url');
  if (nonce.length !== 12 || tag.length !== 16 || ciphertext.length === 0 || ciphertext.length > 256) {
    throw new TypeError('Encrypted document number is invalid');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', getDocumentEncryptionKey(env), nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/**
 * Validate bytes, not just a browser-supplied MIME type. Call before private
 * storage; this helper intentionally does not save or serve files.
 */
function validateIdentityImage({ buffer, declaredMimeType, maxBytes = MAX_IMAGE_BYTES } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > maxBytes) {
    return { ok: false, reason: 'invalid_size' };
  }
  if (!ALLOWED_IMAGE_TYPES.has(declaredMimeType)) {
    return { ok: false, reason: 'unsupported_type' };
  }
  const isPng = buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const isJpeg = buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if ((declaredMimeType === 'image/png' && !isPng) || (declaredMimeType === 'image/jpeg' && !isJpeg)) {
    return { ok: false, reason: 'signature_mismatch' };
  }
  return { ok: true, mimeType: declaredMimeType, size: buffer.length };
}

module.exports = { MAX_IMAGE_BYTES, encryptDocumentNumber, decryptDocumentNumber, validateIdentityImage };
