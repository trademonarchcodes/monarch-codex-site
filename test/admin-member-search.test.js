'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'mobile-api.js'), 'utf8');

test('admin member search omits the empty query predicate and supports partial matches', () => {
  assert.ok(source.includes("const whereClause=q?' WHERE ('+searchClause+')':'';"));
  assert.ok(source.includes("const params=q?searchFields.map(()=>'%'+q+'%'):[];"));
  assert.ok(source.includes("FROM members m'+whereClause+' ORDER BY m.id DESC LIMIT 200'"));
});
