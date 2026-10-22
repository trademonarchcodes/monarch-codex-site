const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const mobileApi = fs.readFileSync(path.join(__dirname, '..', 'mobile-api.js'), 'utf8');
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

test('admins can inspect KYC document images and selfie at full size', () => {
  assert.match(server, /data-image-src="\/admin\/kyc\/\x27\+encodeURIComponent\(id\)\+\x27\/document\/\x27\+kind/);
  assert.match(server, /class="kyc-image-dialog"/);
  assert.match(server, /class="kyc-image-dialog-image"/);
  assert.match(server, /Open full size/);
  assert.match(server, /app\.get\('\/admin\/kyc\/:id\/document\/:kind', requireAdmin/);
  assert.match(server, /no-store, private/);
});

test('KYC decisions use explicit rejection reasons and notify the member', () => {
  assert.match(server, /const KYC_REJECTION_REASONS = Object\.freeze/);
  assert.match(server, /name="reason_code" required/);
  assert.match(server, /status === 'rejected' && !reason/);
  assert.match(server, /INSERT INTO member_notifications \(member_id, notification_type, title, body, target_url, dedupe_key\)/);
  assert.match(server, /Congratulations .*Your identity verification has been approved/);
  assert.match(server, /found\[0\]\.status === 'approved' && status !== 'approved'/);
});

test('member referrals page has responsive invite panels and preserves copy/link attribution', () => {
  assert.match(server, /app\.get\('\/referrals', requireAuth/);
  assert.match(server, /referral-hero/);
  assert.match(server, /referral-stat-grid/);
  assert.match(server, /id="pageReferralLink" value="\$\{esc\(link\)\}"/);
  assert.match(server, /data-copy-target="pageReferralLink"/);
  assert.match(server, /data-copy-target="pageUid"/);
  assert.match(server, /\/register\?ref=/);
  assert.match(server, /@media\(max-width:650px\)/);
  assert.match(server, /@media\(max-width:420px\)/);
  assert.match(server, /prefers-reduced-motion:reduce/);
  assert.match(server, /Referral attribution is recorded when a new account successfully registers using your code/);
});


test('member profile redesign preserves secure account workflows and adds responsive presentation', () => {
  assert.ok(server.includes("app.get('/profile', requireAuth"));
  assert.match(server, /profile-experience/);
  assert.match(server, /profile-hero/);
  assert.match(server, /profile-form-grid/);
  assert.match(server, /profilePhotoChooserPage\(req,'\/profile\/photo','\/profile'/);
  assert.ok(server.includes('action="/profile/bank"'));
  assert.ok(server.includes("action=\"/profile/bank/'+encodeURIComponent(b.id)+'/delete\""));
  assert.match(server, /decryptProfileValue\(row\.details_ciphertext\)/);
  assert.match(server, /slice\(-4\)/);
  assert.match(server, /@media\(max-width:620px\)/);
  assert.match(server, /prefers-reduced-motion:reduce/);
});

test('transaction history uses member-owned database records and mobile-friendly status cards', () => {
  assert.ok(server.includes("app.get('/transactions', requireAuth"));
  assert.match(server, /financial_transactions WHERE member_id=\?/);
  assert.match(server, /deposit_requests d JOIN deposit_payment_methods p ON p\.id=d\.payment_method_id WHERE d\.member_id=\?/);
  assert.match(server, /Completed transactions/);
  assert.match(server, /Deposit requests/);
  assert.match(server, /Awaiting review/);
  assert.match(server, /data-label="Date"/);
  assert.match(server, /tx-status-completed/);
  assert.match(server, /@media\(max-width:680px\)/);
  assert.match(server, /No completed transactions yet/);
  assert.match(server, /No deposit requests yet/);
});

test('admin control centre has grouped navigation, responsive shell, and role-aware workspaces', () => {
  assert.match(server, /function adminControlPage\(title, active, content, req\)/);
  assert.match(server, /Financial operations/);
  assert.match(server, /Members & verification/);
  assert.match(server, /Notifications & security/);
  assert.match(server, /adminNavSearch/);
  assert.match(server, /ac-layout\.ac-menu-open \.ac-side/);
  assert.match(server, /@media\(max-width:820px\)/);
  assert.match(server, /prefers-reduced-motion:reduce/);
  assert.match(server, /req\.adminRole === 'sovereign_desk_admin'/);
  assert.match(server, /\/sovereign-admin\/signals/);
  assert.match(server, /Protected workspace/);
});

test('deposit review is transactional, diagnoses missing schema, and exposes failed live alerts', () => {
  assert.match(server, /app\.post\('\/admin\/deposits\/:id\/review'/);
  assert.match(server, /SELECT \* FROM deposit_requests WHERE id=\? FOR UPDATE/);
  assert.match(server, /INSERT INTO financial_transactions \(member_id,deposit_request_id,transaction_type,currency,amount,reference\)/);
  assert.match(server, /Deposit review support tables are missing/);
  assert.match(server, /Deposit database schema is out of date/);
  assert.match(server, /Deposit alert needs attention/);
  assert.match(server, /Pending deposit count unavailable; open deposits to check manually/);
  assert.match(server, /ORDER BY \(d\.status='pending'\) DESC,d\.created_at DESC LIMIT 150/);
});

test('admin overview uses live database metrics and clearly labels unconnected financial workflows', () => {
  assert.match(server, /SELECT COUNT\(\*\) AS total FROM members/);
  assert.match(server, /SELECT COUNT\(\*\) AS total FROM admin_users WHERE is_active = 1/);
  assert.match(server, /SELECT COUNT\(\*\) AS total FROM kyc_submissions WHERE status = 'pending'/);
  assert.match(server, /SELECT COUNT\(\*\) AS total FROM deposit_requests WHERE status='pending'/);
  assert.match(server, /SELECT COUNT\(\*\) AS total FROM withdrawal_requests WHERE status='pending'/);
  assert.match(server, /stat\('Pending deposits'/);
  assert.match(server, /stat\('Pending withdrawals'/);
  assert.match(server, /Deposit review .*needs checking/);
  assert.match(server, /Withdrawal review .*needs checking/);
  assert.match(server, /ac-overview-hero/);
  assert.match(server, /Workflow readiness/);
  assert.match(server, /The admin workspace supports payment-method management and request review/);
  assert.match(server, /Investment packages/);
  assert.match(server, /SELECT COUNT\(\*\) AS total FROM community_posts WHERE status='pending'/);
  assert.match(server, /SELECT COUNT\(\*\) AS total FROM online_cooperative_connections WHERE status='pending'/);
  assert.match(server, /SELECT COUNT\(\*\) AS total FROM member_notifications WHERE read_at IS NULL/);
  assert.match(server, /tile\('\/admin\/investments','Investment packages'/);
  assert.match(server, /tile\('\/admin\/community-moderation','Community moderation'/);
  assert.match(server, /never filled with fake account or financial records/i);
});

test('Sovereign Desk setup screen diagnoses missing schema without modifying production data', () => {
  const desk = fs.readFileSync(path.join(__dirname, '..', 'sovereign-desk.js'), 'utf8');
  for (const table of ['sovereign_signals','sovereign_guidance','sovereign_desk_access','sovereign_access_requests','member_notifications','sovereign_announcements']) {
    assert.ok(desk.includes("'" + table + "'"), 'setup diagnostics should check ' + table);
  }
  assert.match(desk, /SHOW TABLES/);
  assert.match(desk, /SHOW COLUMNS FROM admin_users LIKE 'role'/);
  assert.match(desk, /Do not run a migration twice/);
  assert.match(desk, /004_admin_sovereign_desk\.sql/);
  assert.match(desk, /005_member_dashboard_and_sovereign_desk\.sql/);
  assert.match(desk, /010_sovereign_desk_announcements\.sql/);
  assert.match(desk, /Read-only check/);
});

test('mobile investments endpoint returns active opportunities and only the signed-in member portfolio', () => {
  assert.match(mobileApi, /router\.get\('\/investments', noStore, apiAuth/);
  assert.match(mobileApi, /FROM investment_packages WHERE status='active' ORDER BY id ASC/);
  assert.match(mobileApi, /FROM member_investments WHERE member_id=\? ORDER BY created_at DESC,id DESC LIMIT 200/);
  assert.match(mobileApi, /investment_setup_required/);
  assert.match(mobileApi, /Cache-Control', 'no-store, private/);
  assert.doesNotMatch(mobileApi.slice(mobileApi.indexOf("router.get('/investments'"), mobileApi.indexOf("Native KYC status")), /INSERT INTO|UPDATE member_wallets|financial_transactions/);
});
