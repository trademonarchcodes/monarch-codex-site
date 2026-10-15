const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const deskMigration = fs.readFileSync(path.join(__dirname, '..', 'migrations', '004_admin_sovereign_desk.sql'), 'utf8');
const memberMigration = fs.readFileSync(path.join(__dirname, '..', 'migrations', '005_member_dashboard_and_sovereign_desk.sql'), 'utf8');

test('administrator access requires an active database role tied to the session member', () => {
  assert.match(server, /SELECT role FROM admin_users WHERE member_id = \? AND is_active = 1 LIMIT 1/);
  assert.match(server, /req\.adminRole = rows\[0\]\.role/);
  assert.match(server, /async function requireAdmin\(req, res, next\)/);
});

test('KYC submission prevents duplicate pending or approved submissions', () => {
  assert.match(server, /SELECT status FROM kyc_submissions WHERE member_id=\? ORDER BY submitted_at DESC,id DESC LIMIT 1/);
  assert.match(server, /\['pending','approved'\]\.includes\(existingKycRows\[0\]\.status\)/);
  assert.match(server, /Your KYC is already approved/);
  assert.match(server, /existingKycStatus === 'approved'/);
});

test('member notifications are scoped to the signed-in member and Academy content is database-backed', () => {
  assert.match(server, /SELECT id,notification_type,title,body,target_url,read_at,created_at FROM member_notifications WHERE member_id=\? ORDER BY created_at DESC LIMIT 100/);
  assert.match(server, /WHERE id=\? AND member_id=\?/);
  assert.match(server, /INSERT INTO academy_lessons \(title,description,content,video_url,access_level,status,created_by\)/);
  assert.match(server, /UPDATE member_notifications SET read_at=COALESCE\(read_at,CURRENT_TIMESTAMP\) WHERE member_id=\? AND read_at IS NULL/);
});

test('admin sections use real data and keep unconnected financial workflows disabled', () => {
  assert.match(server, /app\.get\('\/admin\/referrals'/);
  assert.match(server, /JOIN members r ON r\.id=c\.referred_by/);
  assert.match(server, /app\.post\('\/admin\/academy\/lessons'/);
  assert.match(server, /No verified investment records are connected/);
  assert.match(server, /A unified transaction ledger is not connected yet/);
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
