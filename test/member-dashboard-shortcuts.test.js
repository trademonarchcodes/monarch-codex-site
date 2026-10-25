'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('member dashboard quick actions expose key learning and member destinations', () => {
  const start = server.indexOf('<div class="quick-action-grid" id="quickActions">');
  const end = server.indexOf('</div><button class="show-more-actions"', start);
  assert.ok(start >= 0 && end > start, 'dashboard quick action grid should exist');
  const grid = server.slice(start, end);
  for (const [href, label] of [
    ['/academy', 'Academy'],
    ['/sovereign-desk', 'Sovereign Desk'],
    ['/community', 'Community'],
    ['/notifications', 'Notifications'],
    ['/market-movers.html', 'Live Markets'],
    ['/market-news.html', 'Feeds'],
    ['/roles', 'My Roles'],
    ['/help-support.html', 'Help & Support'],
    ['/wallet-transfer', 'Wallet Transfer'],
    ['/transactions', 'Transaction History']
  ]) {
    assert.ok(grid.includes('href="' + href + '"'), 'missing dashboard shortcut ' + href);
    assert.ok(grid.includes('<strong>' + label + '</strong>'), 'missing dashboard label ' + label);
  }
});

test('Academy shortcut is among the first visible dashboard actions', () => {
  const start = server.indexOf('<div class="quick-action-grid" id="quickActions">');
  const end = server.indexOf('</div><button class="show-more-actions"', start);
  const grid = server.slice(start, end);
  assert.ok(grid.indexOf('href="/academy"') < grid.indexOf('href="/community"'));
  assert.ok(grid.indexOf('href="/academy"') < grid.indexOf('href="/market-movers.html"'));
});
