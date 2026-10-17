'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MEMBER_NAV_ITEMS, renderMemberNavigation } = require('../lib/member-navigation');

test('the same navigation renders all member destinations and KYC lock badges', () => {
  const html = renderMemberNavigation('/dashboard');

  for (const item of MEMBER_NAV_ITEMS) {
    assert.ok(html.includes('href="' + item.href + '"'), 'missing ' + item.href);
    assert.ok(html.includes(item.label), 'missing label ' + item.label);
    assert.equal(html.includes('href="' + item.href + '" aria-current="page"'), item.href === '/dashboard');
  }

  for (const href of ['/deposit', '/withdraw', '/investments', '/referrals', '/online-cooperative']) {
    assert.match(html, new RegExp('href="' + href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"[^>]*data-kyc-locked="true"'));
  }

  assert.doesNotMatch(html, /href="\/transactions"[^>]*data-kyc-locked="true"/);
  assert.equal((html.match(/class="member-kyc-lock"/g) || []).length, 5);
});

test('the shared navigation marks the current route without changing lock policy', () => {
  const html = renderMemberNavigation('/transactions');
  assert.match(html, /href="\/transactions" aria-current="page"/);
  assert.match(html, /href="\/deposit"[^>]*data-kyc-locked="true"/);
  assert.equal((html.match(/aria-current="page"/g) || []).length, 1);
});
