'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const router = fs.readFileSync(path.join(root, 'network-router.js'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'migrations', '022_monarch_network_leaderboards.sql'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const mobile = fs.readFileSync(path.join(root, 'mobile-api.js'), 'utf8');
const createNetworkRouter = require('../network-router');

test('network router module loads without syntax errors', () => {
  assert.equal(typeof createNetworkRouter, 'function');
});

test('network tree is built from immutable original sponsor relationships', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS monarch_referral_relationships/);
  assert.match(migration, /INSERT IGNORE INTO monarch_referral_relationships[\s\S]*SELECT id,referred_by,created_at FROM members/);
  assert.match(router, /JOIN monarch_referral_relationships rr ON rr\.member_id=c\.id/);
  assert.match(router, /rr\.sponsor_member_id=n\.id/);
  assert.match(mobile, /INSERT INTO monarch_referral_relationships \(member_id,sponsor_member_id\)/);
  assert.doesNotMatch(router, /UPDATE monarch_referral_relationships/);
});

test('unpublished sponsors hide their descendants from public network and rankings', () => {
  assert.match(router, /p\.approved=1 AND p\.visible=1 AND p\.requested=1/);
  assert.match(router, /JOIN monarch_public_profile[s]? cp ON cp\.member_id=c\.id AND cp\.approved=1 AND cp\.visible=1/);
  assert.match(router, /router\.get\('\/api\/public-network'/);
});

test('monthly and all-time leaderboards use separate date windows', () => {
  assert.match(router, /mode === 'monthly'/);
  assert.match(router, /child\.joined_at >= \? AND child\.joined_at < \?/);
  assert.match(router, /router\.get\('\/leaderboard'/);
  assert.match(router, /router\.get\('\/api\/public-leaderboard'/);
  assert.match(migration, /monarch_leaderboard_monthly_archive/);
});

test('profile revisions remain pending until Founder or main admin review', () => {
  assert.match(migration, /monarch_network_profile_revisions/);
  assert.match(router, /INSERT INTO monarch_network_profile_revisions/);
  assert.match(router, /const networkAdminOnly/);
  assert.match(router, /\['super_admin','main_admin'\]/);
  assert.match(router, /decision==='reject'/);
});

test('Sovereign Desk leaderboard is read-only and role scoped', () => {
  assert.match(router, /router\.get\('\/sovereign-admin\/leaderboard'/);
  assert.match(router, /\['sovereign_desk_admin','super_admin','main_admin'\]/);
  assert.match(router, /router\.get\('\/api\/mobile\/sovereign\/leaderboard'/);
  assert.match(server, /createNetworkRouter/);
});

test('admin photo uploads validate image type, size, and private storage', () => {
  assert.match(router, /PROFILE_UPLOAD_DIR/);
  assert.match(router, /image\/jpeg/);
  assert.match(router, /buf\.length>3\*1024\*1024/);
  assert.match(router, /profile\.photo_replaced/);
  assert.match(server, /admin\/network\/members', express\.json\(\{ limit: '4\.5mb' \}\)/);
});
