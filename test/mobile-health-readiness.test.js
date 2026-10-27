const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mobileApi = fs.readFileSync(path.join(__dirname, '..', 'mobile-api.js'), 'utf8');

test('mobile API health endpoint verifies database readiness without leaking dependency errors', () => {
  const routeStart = mobileApi.indexOf("router.get('/health'");
  const routeEnd = mobileApi.indexOf('// Public Android update manifest', routeStart);
  assert.notEqual(routeStart, -1, 'health route exists');
  assert.notEqual(routeEnd, -1, 'health route has a clear boundary');
  const route = mobileApi.slice(routeStart, routeEnd);
  assert.ok(route.includes("await pool.query('SELECT 1 AS ready')"));
  assert.ok(route.includes('res.status(503).json'));
  assert.ok(route.includes('The API is running but its database dependency is unavailable'));
  assert.ok(!route.includes('error.message'));
  assert.ok(!route.includes('DB_PASSWORD'));
  assert.ok(!route.includes('DB_HOST'));
});
