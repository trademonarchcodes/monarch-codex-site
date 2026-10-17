'use strict';

const express = require('express');

module.exports = function createMonarchsDirectoryRouter({ pool, requireAuth, requireAdmin, csrfCheck, csrfField, memberPage, adminControlPage, esc }) {
  const router = express.Router();

  async function approvedKyc(memberId) {
    const [rows] = await pool.execute(
      "SELECT status FROM kyc_submissions WHERE member_id=? ORDER BY submitted_at DESC,id DESC LIMIT 1",
      [memberId]
    );
    return rows.length > 0 && String(rows[0].status || '').toLowerCase() === 'approved';
  }

  router.get('/profile/monarchs', requireAuth, async (req, res, next) => {
    try {
      const [[member]] = await pool.execute(
        'SELECT id,full_name,username FROM members WHERE id=? LIMIT 1', [req.session.memberId]
      );
      if (!member) return res.redirect('/login');
      const verified = await approvedKyc(member.id);
      let profile = null;
      try {
        const [rows] = await pool.execute('SELECT nickname,requested,approved,visible FROM monarch_public_profiles WHERE member_id=? LIMIT 1', [member.id]);
        profile = rows[0] || null;
      } catch (e) { if (e.code !== 'ER_NO_SUCH_TABLE') throw e; }
      const status = !verified
        ? '<div class="notice">Complete and pass identity verification before requesting a public Monarchs profile.</div>'
        : profile && profile.approved && profile.visible
          ? '<div class="notice">Your Monarchs profile is approved and visible on the homepage.</div>'
          : profile && profile.requested
            ? '<div class="notice">Your request is awaiting admin review. It will not appear publicly until approved.</div>'
            : '<p class="muted">Request to appear in the public Monarchs directory. An administrator must approve your profile before it becomes visible.</p>';
      const content = '<section class="ac-panel"><h2>Homepage Monarchs profile</h2>' + status +
        '<form method="post" action="/profile/monarchs" class="ac-form">' + csrfField(req) +
        '<label for="monarchNickname">Nickname</label><input id="monarchNickname" name="nickname" maxlength="80" required value="' + esc(profile?.nickname || '') + '" placeholder="The name you want displayed">' +
        '<p class="muted">Your full name and member title are sourced from your account. Main Admins are displayed as Founder; members are displayed as Member.</p>' +
        (verified ? '<label class="ac-check"><input type="checkbox" name="requestListing" value="yes"' + (profile?.requested ? ' checked' : '') + '> I agree to request a public profile on the Monarchs homepage.</label><button class="btn" type="submit">Save profile & request review</button>' : '<button class="btn" type="button" disabled>Verification required</button>') +
        '</form></section>';
      res.send(memberPage('Homepage Monarchs profile', '/profile', member, content, req));
    } catch (e) { next(e); }
  });

  router.post('/profile/monarchs', requireAuth, (req, res, next) => csrfCheck(req, res, async csrfErr => {
    if (csrfErr) return;
    try {
      const memberId = req.session.memberId;
      if (!await approvedKyc(memberId)) return res.status(403).send('<h1>KYC verification required</h1><p>Only members with approved identity verification can request a public Monarchs profile.</p><a href="/profile/monarchs">Back</a>');
      const nickname = String(req.body.nickname || '').trim();
      if (!nickname || nickname.length > 80 || /[<>]/.test(nickname)) return res.status(400).send('<h1>Check your nickname</h1><p>Use 1–80 characters without HTML tags.</p><a href="/profile/monarchs">Back</a>');
      const requested = req.body.requestListing === 'yes' ? 1 : 0;
      await pool.execute(
        'INSERT INTO monarch_public_profiles (member_id,nickname,requested,approved,visible) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE nickname=VALUES(nickname),requested=VALUES(requested),approved=IF(VALUES(nickname)<>nickname,0,approved),visible=IF(VALUES(nickname)<>nickname,0,visible)',
        [memberId, nickname, requested, 0, 0]
      );
      res.redirect('/profile/monarchs');
    } catch (e) { next(e); }
  }));

  router.get('/admin/monarchs', requireAdmin, async (req, res, next) => {
    try {
      const [rows] = await pool.query("SELECT p.member_id,p.nickname,p.requested,p.approved,p.visible,m.full_name,m.username,au.role,mp.avatar_key FROM monarch_public_profiles p JOIN members m ON m.id=p.member_id LEFT JOIN admin_users au ON au.member_id=m.id LEFT JOIN member_profiles mp ON mp.member_id=m.id ORDER BY p.requested DESC,p.updated_at DESC LIMIT 300");
      const table = rows.map(p => {
        const title = p.role === 'main_admin' || p.role === 'super_admin' ? 'Founder' : 'Member';
        const status = p.visible && p.approved ? 'Published' : p.requested ? 'Awaiting review' : 'Not requested';
        return '<tr><td>' + esc(p.full_name) + '<br><small>@' + esc(p.username) + '</small></td><td>' + esc(p.nickname) + '</td><td>' + title + '</td><td>' + status + '</td><td><form method="post" action="/admin/monarchs/' + Number(p.member_id) + '">' + csrfField(req) +
          '<label class="ac-check"><input type="checkbox" name="approved" value="yes"' + (p.approved ? ' checked' : '') + '> Approve</label><label class="ac-check"><input type="checkbox" name="visible" value="yes"' + (p.visible ? ' checked' : '') + '> Show publicly</label><button class="btn" type="submit">Save</button></form></td></tr>';
      }).join('');
      const content = '<section class="ac-panel"><h2>Monarchs homepage profiles</h2><p class="muted">Only KYC-approved members may request a listing. Confirm identity and content before publishing.</p><div class="ac-table-wrap"><table class="ac-table"><thead><tr><th>Member</th><th>Nickname</th><th>Title</th><th>Status</th><th>Admin controls</th></tr></thead><tbody>' + (table || '<tr><td colspan="5">No profile requests yet.</td></tr>') + '</tbody></table></div></section>';
      res.send(adminControlPage('Monarchs','/admin/monarchs',content,req));
    } catch (e) { if (e.code === 'ER_NO_SUCH_TABLE') return res.status(503).send('<h1>Setup required</h1><p>Apply migrations/013_monarchs_directory.sql after backing up the database.</p>'); next(e); }
  });

  router.post('/admin/monarchs/:memberId', requireAdmin, (req, res, next) => csrfCheck(req, res, async csrfErr => {
    if (csrfErr) return;
    try {
      const memberId = Number(req.params.memberId);
      if (!Number.isSafeInteger(memberId) || memberId < 1) return res.sendStatus(400);
      const approved = req.body.approved === 'yes' ? 1 : 0;
      const visible = req.body.visible === 'yes' && approved ? 1 : 0;
      if (approved && !await approvedKyc(memberId)) return res.status(400).send('<h1>Cannot publish profile</h1><p>The member must have approved KYC first.</p><a href="/admin/monarchs">Back</a>');
      await pool.execute('UPDATE monarch_public_profiles SET approved=?,visible=?,approved_by=?,approved_at=IF(?=1,NOW(),NULL) WHERE member_id=?', [approved, visible, approved ? req.session.memberId : null, approved, memberId]);
      res.redirect('/admin/monarchs');
    } catch (e) { next(e); }
  }));

  router.get('/api/public-monarchs', async (_req, res, next) => {
    try {
      const [rows] = await pool.query("SELECT p.nickname,m.full_name,m.username,m.monarch_uid,mp.avatar_key,CASE WHEN au.role IN ('main_admin','super_admin') THEN 'Founder' ELSE 'Member' END AS title FROM monarch_public_profiles p JOIN members m ON m.id=p.member_id LEFT JOIN admin_users au ON au.member_id=m.id LEFT JOIN member_profiles mp ON mp.member_id=m.id JOIN kyc_submissions k ON k.member_id=m.id AND k.status='approved' WHERE p.approved=1 AND p.visible=1 AND p.requested=1 AND k.id=(SELECT MAX(k2.id) FROM kyc_submissions k2 WHERE k2.member_id=m.id) ORDER BY p.approved_at DESC,p.member_id DESC LIMIT 60");
      res.set('Cache-Control', 'public, max-age=60');
      res.json(rows.map(p => ({ nickname: p.nickname, name: p.full_name, username: p.username, title: p.title, photo: p.avatar_key ? '/member-avatar/' + encodeURIComponent(p.avatar_key) : '/assets/images/monarch-codex-logo.svg' })));
    } catch (e) { if (e.code === 'ER_NO_SUCH_TABLE') return res.json([]); next(e); }
  });

  return router;
};
