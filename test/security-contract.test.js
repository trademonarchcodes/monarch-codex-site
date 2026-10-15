const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const deskMigration = fs.readFileSync(path.join(__dirname, '..', 'migrations', '004_admin_sovereign_desk.sql'), 'utf8');
const memberMigration = fs.readFileSync(path.join(__dirname, '..', 'migrations', '005_member_dashboard_and_sovereign_desk.sql'), 'utf8');

test('administrator role checks are based on the authenticated session member', () => {
  assert.match(server, /SELECT role FROM admin_users WHERE member_id = \? AND is_active = 1 LIMIT 1/);
  assert.match(server, /req\.adminRole === 'sovereign_desk_admin' && req\.path\.startsWith\('\/admin'\)/);
  assert.match(server, /admins\[0\]\.role === 'sovereign_desk_admin' \? '\/sovereign-admin' : '\/admin'/);
});

test('KYC submission prevents duplicate pending or approved submissions', () => {
  assert.match(server, /SELECT status FROM kyc_submissions WHERE member_id=\? ORDER BY submitted_at DESC LIMIT 1/);
  assert.match(server, /\['pending','approved'\]\.includes\(previousKycStatus\)/);
  assert.match(server, /previousKycStatus \? 'resubmitted' : 'submitted'/);
});

test('notifications and Academy progress are scoped to the authenticated Monarch', () => {
  assert.match(server, /FROM member_notifications WHERE member_id=\? ORDER BY created_at DESC/);
  assert.match(server, /WHERE id=\? AND member_id=\?'/);
  assert.match(server, /ON DUPLICATE KEY UPDATE completed_at=COALESCE\(completed_at,CURRENT_TIMESTAMP\)/);
});

test('premium content is checked on the server before it is displayed or completed', () => {
  assert.match(server, /l\.access_level==='free'\|\|hasPremiumAccess/);
  assert.match(server, /SELECT id FROM academy_access WHERE member_id=\? AND status='approved'/);
  assert.match(server, /return res\.status\(403\)\.send\(page\('Access required'/);
});

test('Sovereign Desk tables and private notification uniqueness are additive', () => {
  for (const table of ['sovereign_signals','sovereign_guidance','sovereign_desk_access','sovereign_access_requests']) {
    assert.match(deskMigration, new RegExp('CREATE TABLE IF NOT EXISTS ' + table));
  }
  assert.match(memberMigration, /UNIQUE KEY uq_member_notification_dedupe \(member_id,dedupe_key\)/);
  assert.match(memberMigration, /CREATE TABLE IF NOT EXISTS academy_progress/);
  assert.doesNotMatch(deskMigration + memberMigration, /DROP TABLE|TRUNCATE TABLE|CREATE TABLE members\b/i);
});

test('KYC decisions use explicit rejection reasons and notify the member', () => {
  assert.match(server, /const KYC_REJECTION_REASONS = Object\.freeze/);
  assert.match(server, /name="reason_code" required/);
  assert.match(server, /status === 'rejected' && !reason/);
  assert.match(server, /INSERT INTO member_notifications \(member_id, notification_type, title, body, target_url, dedupe_key\)/);
  assert.match(server, /Congratulations .*Your identity verification has been approved/);
  assert.match(server, /found\[0\]\.status === 'approved' && status !== 'approved'/);
});
