const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const deskTemplate = fs.readFileSync(path.join(root, 'sovereign-admin.html'), 'utf8');
const themeCss = fs.readFileSync(path.join(root, 'assets', 'css', 'admin-premium-theme.css'), 'utf8');

test('main admin shell loads the premium theme and exposes a real theme toggle', () => {
  assert.match(server, /admin-premium-theme\.css/);
  assert.match(server, /id="adminThemeToggle"/);
  assert.match(server, /localStorage\.setItem\('monarch-admin-theme',theme\)/);
  assert.match(server, /data-admin-theme/);
});

test('Sovereign Desk template loads the same theme and exposes its own toggle', () => {
  assert.match(deskTemplate, /admin-premium-theme\.css/);
  assert.match(deskTemplate, /id="deskThemeToggle"/);
  assert.match(deskTemplate, /localStorage\.setItem\("monarch-admin-theme",theme\)/);
  assert.match(deskTemplate, /assets\/images\/sovereign-desk-logo\.jpg/);
});

test('premium theme includes the agreed palette, light mode, responsive layout, and reduced-motion support', () => {
  assert.match(themeCss, /--admin-gold/);
  assert.match(themeCss, /--admin-green/);
  assert.match(themeCss, /--admin-blue/);
  assert.match(themeCss, /--admin-amber/);
  assert.match(themeCss, /html\[data-admin-theme="light"\]/);
  assert.match(themeCss, /@media\(prefers-reduced-motion:reduce\)/);
  assert.match(themeCss, /\.desk-bottom-nav/);
  assert.match(themeCss, /\.ac-bottom-nav/);
});
