'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'mobile-api.js'), 'utf8');

test('admin member search omits the empty query predicate and supports partial matches', () => {
  assert.match(source, /const whereClause=q\?' WHERE \('\+searchClause\+'\)':'';/);
  assert.match(source, /const params=q\?searchFields\.map\(\)=>'%'\+q\+'%'\):\[\];/);
  assert.match(source, /FROM members m'\+whereClause\+' ORDER BY m\.id DESC LIMIT 200'/);
});
