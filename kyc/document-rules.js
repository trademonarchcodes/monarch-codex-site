/**
 * Country/document validation primitives for Monarch Codex KYC.
 *
 * Important: do not claim that one regex covers every country's identity documents.
 * Add reviewed country-specific rules as each issuing authority's requirements are verified.
 * This file validates format only; it does not establish that a document is genuine.
 */
'use strict';

const DOCUMENT_TYPES = {
  NG: [
    { value: 'nin', label: 'National Identification Number (NIN)' },
    { value: 'bvn', label: 'Bank Verification Number (BVN)' },
    { value: 'drivers_license', label: "Driver's licence" },
    { value: 'passport', label: 'International passport' },
    { value: 'national_id', label: 'National identity card' }
  ],
  DEFAULT: [
    { value: 'passport', label: 'Passport' },
    { value: 'national_id', label: 'National identity card' },
    { value: 'drivers_license', label: "Driver's licence" },
    { value: 'residence_permit', label: 'Residence permit' }
  ]
};

const RULES = {
  'NG:nin': {
    label: 'NIN',
    normalize: value => String(value || '').replace(/\s+/g, ''),
    pattern: /^\d{11}$/,
    message: 'NIN must contain exactly 11 digits.'
  },
  'NG:bvn': {
    label: 'BVN',
    normalize: value => String(value || '').replace(/\s+/g, ''),
    pattern: /^\d{11}$/,
    message: 'BVN must contain exactly 11 digits.'
  }
};

function getDocumentTypes(issuingCountry) {
  const country = String(issuingCountry || '').trim().toUpperCase();
  return country === 'NG' ? DOCUMENT_TYPES.NG : DOCUMENT_TYPES.DEFAULT;
}

function validateDocumentNumber({ issuingCountry, documentType, documentNumber }) {
  const country = String(issuingCountry || '').trim().toUpperCase();
  const type = String(documentType || '').trim().toLowerCase();
  const raw = String(documentNumber || '').trim();
  if (!/^[A-Z]{2}$/.test(country)) {
    return { valid: false, normalized: '', message: 'Select the document issuing country.' };
  }
  if (!getDocumentTypes(country).some(item => item.value === type)) {
    return { valid: false, normalized: '', message: 'Select a document type available for the issuing country.' };
  }
  if (!raw || raw.length > 64) {
    return { valid: false, normalized: '', message: 'Enter a document number of 1–64 characters.' };
  }

  const rule = RULES[country + ':' + type];
  if (rule) {
    const normalized = rule.normalize(raw);
    if (!rule.pattern.test(normalized)) {
      return { valid: false, normalized: '', message: rule.message };
    }
    return { valid: true, normalized, message: '' };
  }

  // A conservative common-format guard only. Exact format validation must be
  // configured for this issuing country and document type before claiming strict validation.
  const normalized = raw.replace(/\s+/g, ' ').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 .\-/]{0,63}$/.test(normalized)) {
    return { valid: false, normalized: '', message: 'Use only letters, numbers, spaces, dots, hyphens, or slashes.' };
  }
  return {
    valid: false,
    normalized: '',
    message: 'Strict format validation is not configured for this country and document type yet. Choose a supported document or contact support.',
    formatSpecificRuleConfigured: false
  };
}

module.exports = { DOCUMENT_TYPES, getDocumentTypes, validateDocumentNumber };
