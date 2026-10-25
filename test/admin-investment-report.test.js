const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('admin investment workspace includes a read-only member purchase report', () => {
  const routeStart = server.indexOf("app.get('/admin/investments'");
  const routeEnd = server.indexOf("app.post('/admin/investments/packages'", routeStart);
  assert.notEqual(routeStart, -1, 'admin investments route exists');
  assert.notEqual(routeEnd, -1, 'admin investments route has a boundary');
  const route = server.slice(routeStart, routeEnd);
  assert.match(route, /requireFinanceAdmin/);
  assert.match(route, /requireWebCategoryAccess\('invest_market','view'\)/);
  assert.match(route, /FROM member_investments i JOIN members m ON m\.id=i\.member_id/);
  assert.match(route, /principal_amount/);
  assert.match(route, /fee_amount/);
  assert.match(route, /total_charged/);
  assert.match(route, /purchase_reference/);
  assert.match(route, /Latest 200 recorded purchases/);
  assert.match(route, /This report is read-only/);
  assert.doesNotMatch(route, /UPDATE member_wallets|INSERT INTO member_wallets|DELETE FROM member_investments/);
});
