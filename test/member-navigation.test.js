'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MEMBER_NAV_ITEMS, renderMemberNavigation } = require('../lib/member-navigation');

test('the same navigation renders all member destinations and KYC lock badges', () => {
  const html = renderMemberNavigation('/dashboard');
  const unlocked = ['/dashboard', '/profile', '/kyc', '/tools', '/market-news.html', '/market-movers.html'];
  const locked = ['/sovereign-desk', '/deposit', '/withdraw', '/transactions', '/investments', '/referrals', '/online-cooperative'];

  for (const item of MEMBER_NAV_ITEMS) {
    assert.ok(html.includes(item.label), 'missing label ' + item.label);
    if (unlocked.includes(item.href)) {
      assert.ok(html.includes('href="' + item.href + '"'), 'missing unlocked destination ' + item.href);
      assert.match(html, new RegExp('href="' + item.href + '"[^>]*' + (item.href === '/dashboard' ? 'aria-current="page"' : '')));
    } else {
      assert.match(html, new RegExp('href="/kyc\\?required=approval"[^>]*data-kyc-locked="true"[^>]*data-member-href="' + item.href + '"'), 'locked destination ' + item.href);
    }
  }

  for (const href of locked) {
    assert.match(html, new RegExp('data-kyc-locked="true"[^>]*data-member-href="' + href.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&') + '"'));
  }
  assert.equal((html.match(/class="member-kyc-lock"/g) || []).length, 7);
});

test('the shared navigation marks the current route and preserves KYC locks', () => {
  const html = renderMemberNavigation('/transactions');
  assert.match(html, /href="\/kyc\?required=approval"[^>]*aria-current="page"[^>]*data-kyc-locked="true"[^>]*data-member-href="\/transactions"/);
  assert.match(html, /href="\/kyc\?required=approval"[^>]*data-kyc-locked="true"[^>]*data-member-href="\/deposit"/);
  assert.equal((html.match(/aria-current="page"/g) || []).length, 1);
});
