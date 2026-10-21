'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const roles = fs.readFileSync(path.join(root, 'admin-role-management.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const desk = fs.readFileSync(path.join(root, 'sovereign-desk.js'), 'utf8');
const governanceMigration = fs.readFileSync(path.join(root, 'migrations', '016_sovereign_governance.sql'), 'utf8');
const deskTemplate = fs.readFileSync(path.join(root, 'sovereign-admin.html'), 'utf8');

test('administrator role editor is linked from the main admin workspace and mounted behind authentication', () => {
  assert.match(server, /createAdminRoleManagementRouter/);
  assert.match(server, /app\.use\('\/admin\/roles'/);
  assert.match(server, /\/admin\/roles','Administrator roles'/);
  assert.match(server, /tile\('\/admin\/roles','Administrator roles'/);
  assert.match(roles, /router\.get\('\/'/);
  assert.match(roles, /router\.post\('\/:memberId'/);
  assert.match(roles, /requireAdmin/);
  assert.match(roles, /csrfCheck/);
});

test('role editor restricts role grants, prevents self changes, protects the last Super Admin, and audits changes', () => {
  assert.match(roles, /seniorRoles = new Set\(\['super_admin', 'main_admin'\]\)/);
  assert.match(roles, /memberId === Number\(req\.session\.memberId\)/);
  assert.match(roles, /actorRole !== 'super_admin'/);
  assert.match(roles, /currentRole === 'super_admin' && nextRole !== 'super_admin'/);
  assert.match(roles, /admin_audit_log/);
  assert.match(roles, /beginTransaction\(\)/);
  assert.match(roles, /rollback\(\)/);
  assert.doesNotMatch(roles, /\/admin\/(?:deposits|withdrawals|balances|investments|earnings)/);
});

test('admin dashboards preserve a compact desktop rail and responsive bottom navigation', () => {
  assert.match(server, /grid-template-columns:76px minmax\(0,1fr\)/);
  assert.match(server, /ac-bottom-nav/);
  assert.match(server, /aria-label="Admin primary navigation"/);
  assert.match(server, /aria-label="\+esc\(label\)\+" title="\+esc\(label\)\+"/);
  assert.match(deskTemplate, /grid-template-columns:76px minmax\(0,1fr\)/);
  assert.match(deskTemplate, /desk-bottom-nav/);
  assert.match(desk, /'\{\{BOTTOM_NAV\}\}': mobileNav/);
});

test('Sovereign Desk governance records are persisted, permission-checked, CSRF-protected and audited', () => {
  assert.match(desk, /router\.get\('\/sovereign-admin\/governance'/);
  assert.match(desk, /router\.post\('\/sovereign-admin\/governance'/);
  assert.match(desk, /router\.post\('\/sovereign-admin\/governance\/:id\/status'/);
  assert.match(desk, /requireAdmin, adminOnly/);
  assert.match(desk, /csrfCheck/);
  assert.match(desk, /admin_audit_log/);
  assert.match(desk, /sovereign_governance_items/);
  assert.match(desk, /These actions never approve financial transactions/);
  assert.match(governanceMigration, /CREATE TABLE IF NOT EXISTS sovereign_governance_items/);
  assert.match(governanceMigration, /FOREIGN KEY \(created_by\) REFERENCES members\(id\)/);
  assert.doesNotMatch(governanceMigration, /DROP TABLE|TRUNCATE TABLE|CREATE TABLE members\b/i);
});
