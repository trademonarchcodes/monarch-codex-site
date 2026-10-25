const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const routerSource = fs.readFileSync(path.join(__dirname, '..', 'sovereign-desk.js'), 'utf8');
const migration = fs.readFileSync(path.join(__dirname, '..', 'migrations', '010_sovereign_desk_announcements.sql'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('mobile API failures return JSON support references and correlate to sanitized request IDs', () => {
  assert.match(server, /req\.get\('X-Request-ID'\)/);
  assert.match(server, /\[a-zA-Z0-9\._:-\]\{1,80\}/);
  assert.match(server, /req\.path\.startsWith\('\/api\/mobile\/'\)/);
  assert.match(server, /res\.status\(500\)\.json\(/);
  assert.match(server, /requestId/);
  assert.match(server, /stack: err && err\.stack/);
  assert.match(server, /res\.setHeader\('X-Request-ID', requestId\)/);
});

test('Sovereign Desk has real member and administrator routes for its core workflows', () => {
  for (const route of [
    "router.get('/sovereign-admin'",
    "router.get('/sovereign-admin/signals'",
    "router.post('/sovereign-admin/signals'",
    "router.get('/sovereign-admin/mentorship'",
    "router.get('/sovereign-admin/access'",
    "router.get('/sovereign-admin/announcements'",
    "router.post('/sovereign-admin/announcements'",
    "router.get('/sovereign-desk'",
    "router.get('/sovereign-desk/signals'",
    "router.get('/sovereign-desk/mentorship'",
    "router.get('/sovereign-desk/access'",
    "router.get('/sovereign-desk/announcements'"
  ]) assert.ok(routerSource.includes(route), 'Missing route: ' + route);
  assert.match(server, /createSovereignDeskRouter/);
});

test('Sovereign Desk roles are checked on the server and the router exposes no finance routes', () => {
  assert.match(routerSource, /req\.adminRole === 'sovereign_desk_admin'/);
  assert.match(routerSource, /requireAdmin/);
  assert.match(routerSource, /memberAccess\(m\.id\)/);
  assert.doesNotMatch(routerSource, /\/admin\/(?:deposits|withdrawals|balances|investments|earnings|kyc)/);
});

test('Sovereign Desk uses published database records, expiring grants, CSRF protection and audit attribution', () => {
  assert.match(routerSource, /status='published'/);
  assert.match(routerSource, /expires_at>NOW\(\)/);
  assert.match(routerSource, /csrfCheck/);
  assert.match(routerSource, /created_by,updated_by/);
  assert.match(routerSource, /admin_audit_log/);
  assert.match(routerSource, /member_notifications/);
});

test('announcement migration is additive and preserves member records', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS sovereign_announcements/);
  assert.match(migration, /FOREIGN KEY \(created_by\) REFERENCES members\(id\)/);
  assert.doesNotMatch(migration, /DROP TABLE|TRUNCATE TABLE|CREATE TABLE members\b/i);
});
