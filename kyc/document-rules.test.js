/**
 * Unit tests for KYC document format validation.
 * Run with: node --test kyc/document-rules.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getDocumentTypes, validateDocumentNumber } = require('./document-rules');

test('Nigeria offers NIN, BVN, licence, passport and national ID options', () => {
  const types = getDocumentTypes('NG').map(item => item.value);
  for (const expected of ['nin', 'bvn', 'drivers_license', 'passport', 'national_id']) {
    assert.ok(types.includes(expected));
  }
});

test('NIN requires exactly 11 digits', () => {
  assert.equal(validateDocumentNumber({ issuingCountry: 'NG', documentType: 'nin', documentNumber: '12345678901' }).valid, true);
  assert.equal(validateDocumentNumber({ issuingCountry: 'NG', documentType: 'nin', documentNumber: '1234567890' }).valid, false);
  assert.equal(validateDocumentNumber({ issuingCountry: 'NG', documentType: 'nin', documentNumber: '123456789012' }).valid, false);
  assert.equal(validateDocumentNumber({ issuingCountry: 'NG', documentType: 'nin', documentNumber: '12345abc901' }).valid, false);
});

test('BVN requires exactly 11 digits', () => {
  assert.equal(validateDocumentNumber({ issuingCountry: 'NG', documentType: 'bvn', documentNumber: '12345678901' }).valid, true);
  assert.equal(validateDocumentNumber({ issuingCountry: 'NG', documentType: 'bvn', documentNumber: '1234567890' }).valid, false);
  assert.equal(validateDocumentNumber({ issuingCountry: 'NG', documentType: 'bvn', documentNumber: '123456789012' }).valid, false);
});

test('unknown country-specific document rules fail closed', () => {
  const result = validateDocumentNumber({ issuingCountry: 'GB', documentType: 'passport', documentNumber: '123ABC456' });
  assert.equal(result.valid, false);
  assert.match(result.message, /not configured/i);
});

test('document type must be available for selected issuing country', () => {
  const result = validateDocumentNumber({ issuingCountry: 'GB', documentType: 'nin', documentNumber: '12345678901' });
  assert.equal(result.valid, false);
});
