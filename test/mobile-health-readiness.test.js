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
  assert.match(route, /await pool.query('SELECT 1 AS ready')/);
  assert.match(route, /res.status(503).json/);
  assert.match(route, /The API is running but its database dependency is unavailable/);
  assert.doesNotMatch(route, /error.message|stack|DB_PASSWORD|DB_HOST/);
});
