'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const mobileApi = fs.readFileSync(path.join(__dirname, '..', 'mobile-api.js'), 'utf8');

test('community post deletion is restricted to the signed-in author and soft-hides the post', () => {
  assert.match(server, /app\.post\('\/community\/posts\/:id\/delete',[\s\S]*?UPDATE community_posts SET status='hidden' WHERE id=\? AND member_id=\? AND status='published'/);
  assert.match(server, /community\.post_deleted/);
  assert.match(mobileApi, /router\.delete\('\/community\/posts\/:id',[\s\S]*?UPDATE community_posts SET status='hidden' WHERE id=\? AND member_id=\? AND status='published'/);
});

test('community comment deletion is restricted to the signed-in author and correct post', () => {
  assert.match(server, /UPDATE community_comments SET status='hidden' WHERE id=\? AND post_id=\? AND member_id=\? AND status='published'/);
  assert.match(mobileApi, /router\.delete\('\/community\/posts\/:postId\/comments\/:commentId',[\s\S]*?UPDATE community_comments SET status='hidden' WHERE id=\? AND post_id=\? AND member_id=\? AND status='published'/);
});

test('community API marks posts and comments owned by the current member for native delete controls', () => {
  assert.match(mobileApi, /\(p\.member_id=\? \) AS isMine/);
  assert.match(mobileApi, /\(c\.member_id=\? \) AS isMine/);
});

test('administrator navigation exposes the community feed without removing moderation', () => {
  assert.match(server, /\['\/community','Community feed','◉'\]/);
  assert.match(server, /\['\/admin\/community-moderation','Community moderation','◉'\]/);
});
