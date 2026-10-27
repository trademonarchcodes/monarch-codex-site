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
  assert.ok(route.includes('requireFinanceAdmin'));
  assert.ok(route.includes("requireWebCategoryAccess('invest_market','view')"));
  assert.ok(route.includes('FROM member_investments i JOIN members m ON m.id=i.member_id'));
  assert.ok(route.includes('principal_amount'));
  assert.ok(route.includes('fee_amount'));
  assert.ok(route.includes('total_charged'));
  assert.ok(route.includes('purchase_reference'));
  assert.ok(route.includes('Latest 200 recorded purchases'));
  assert.ok(route.includes('This report is read-only'));
  assert.ok(!route.includes('UPDATE member_wallets'));
  assert.ok(!route.includes('INSERT INTO member_wallets'));
  assert.ok(!route.includes('DELETE FROM member_investments'));
});
