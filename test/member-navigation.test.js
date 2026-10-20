'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MEMBER_NAV_ITEMS, renderMemberNavigation } = require('../lib/member-navigation');

test('member navigation keeps every destination visible without decorative KYC locks', () => {
  const html = renderMemberNavigation('/dashboard');
  for (const item of MEMBER_NAV_ITEMS) {
    assert.ok(html.includes(item.label), 'missing label ' + item.label);
    assert.ok(html.includes('href="' + item.href + '"'), 'missing destination ' + item.href);
  }
  assert.equal((html.match(/class="member-kyc-lock"/g) || []).length, 0);
  assert.doesNotMatch(html, /data-kyc-locked="true"/);
  assert.doesNotMatch(html, /href="\/kyc\?required=approval"/);
});

test('member navigation marks exactly the current route and preserves destinations', () => {
  const html = renderMemberNavigation('/transactions');
  assert.match(html, /href="\/transactions"[^>]*aria-current="page"/);
  assert.equal((html.match(/aria-current="page"/g) || []).length, 1);
  for (const item of MEMBER_NAV_ITEMS) assert.ok(html.includes('href="' + item.href + '"'));
});
