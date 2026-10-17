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
      const notice = req.query.notice === 'kyc_required' ? '<div class="ac-alert ac-alert-warning"><strong>Identity verification needed</strong><p>Complete and pass identity verification before requesting a public Monarchs profile.</p></div>' : req.query.notice === 'invalid_nickname' ? '<div class="ac-alert ac-alert-warning"><strong>Check your nickname</strong><p>Use 1–80 characters without HTML tags, then save again.</p></div>' : '';
      const status = !verified
        ? '<div class="notice">Complete and pass identity verification before requesting a public Monarchs profile.</div>'
        : profile && profile.approved && profile.visible
          ? '<div class="notice">Your Monarchs profile is approved and visible on the homepage.</div>'
          : profile && profile.requested
            ? '<div class="notice">Your request is awaiting admin review. It will not appear publicly until approved.</div>'
            : '<p class="muted">Request to appear in the public Monarchs directory. An administrator must approve your profile before it becomes visible.</p>';
      const content = notice + '<section class="ac-panel"><h2>Homepage Monarchs profile</h2>' + status +
        '<form method="post" action="/profile/monarchs" class="ac-form">' + csrfField(req) +
        '<label for="monarchNickname">Nickname</label><input id="monarchNickname" name="nickname" maxlength="80" required value="' + esc(profile?.nickname || '') + '" placeholder="The name you want displayed">' +
        '<p class="muted">Your full name and member title are sourced from your account. Main Admins are displayed as Founder; members are displayed as Members.</p>' +
        (verified ? '<label class="ac-check"><input type="checkbox" name="requestListing" value="yes"' + (profile?.requested ? ' checked' : '') + '> I agree to request a public profile on the Monarchs homepage.</label><button class="btn" type="submit">Save profile & request review</button>' : '<button class="btn" type="button" disabled>Verification required</button>') +
        '</form></section>';
      res.send(memberPage('Homepage Monarchs profile', '/profile', member, content, req));
    } catch (e) { next(e); }
  });

  router.post('/profile/monarchs', requireAuth, (req, res, next) => csrfCheck(req, res, async csrfErr => {
    if (csrfErr) return;
    try {
      const memberId = req.session.memberId;
      if (!await approvedKyc(memberId)) return res.redirect('/profile/monarchs?notice=kyc_required');
      const nickname = String(req.body.nickname || '').trim();
      if (!nickname || nickname.length > 80 || /[<>]/.test(nickname)) return res.redirect('/profile/monarchs?notice=invalid_nickname');
      const requested = req.body.requestListing === 'yes' ? 1 : 0;
      await pool.execute(
        'INSERT INTO monarch_public_profiles (member_id,nickname,requested,approved,visible) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE approved=IF(VALUES(requested)=0 OR nickname<>VALUES(nickname),0,approved),visible=IF(VALUES(requested)=0 OR nickname<>VALUES(nickname),0,visible),nickname=VALUES(nickname),requested=VALUES(requested)',
        [memberId, nickname, requested, 0, 0]
      );
      res.redirect('/profile/monarchs');
    } catch (e) { next(e); }
  }));

  router.get('/admin/monarchs', requireAdmin, async (req, res, next) => {
    try {
      const [[admin]] = await pool.query("SELECT m.id,m.full_name,m.username,au.role,mp.avatar_key,p.nickname,p.requested,p.approved,p.visible FROM admin_users au JOIN members m ON m.id=au.member_id LEFT JOIN member_profiles mp ON mp.member_id=m.id LEFT JOIN monarch_public_profiles p ON p.member_id=m.id WHERE au.member_id=? AND au.is_active=1 LIMIT 1",[req.session.memberId]);
      const ownPhoto = admin && admin.avatar_key && /^[a-f0-9]{48}\.(jpg|png|webp)$/.test(String(admin.avatar_key)) ? '/member-avatar/'+encodeURIComponent(admin.avatar_key) : '/assets/images/monarch-codex-logo.svg';
      const ownStatus = admin && admin.visible && admin.approved ? 'Published on homepage' : admin && admin.requested ? 'Awaiting review' : 'Not published';
      const ownProfile = '<section class="ac-panel"><h2>Publish your admin profile</h2><p class="muted">Update your public nickname and choose whether your administrator profile appears in the homepage Monarchs section. This uses your saved admin profile photo.</p><div style="display:flex;align-items:center;gap:14px;margin:16px 0;flex-wrap:wrap"><img src="'+ownPhoto+'" alt="Your profile photo" style="width:84px;height:84px;object-fit:cover;border-radius:50%;border:2px solid #dfbd62"><div><strong>'+esc(admin.full_name||admin.username||'Administrator')+'</strong><p class="muted" style="margin:4px 0">@'+esc(admin.username||'')+'</p><span class="badge">'+ownStatus+'</span><p><a class="btn" href="/admin/profile/photo">Update profile photo</a></p></div></div><form method="post" action="/admin/monarchs/self" class="ac-form">'+csrfField(req)+'<label for="adminPublicNickname">Public nickname</label><input id="adminPublicNickname" name="nickname" maxlength="80" required value="'+esc(admin.nickname||'')+'" placeholder="Name to display on the homepage"><label class="ac-check"><input type="checkbox" name="publish" value="yes"'+(admin.visible&&admin.approved&&admin.requested?' checked':'')+'> Publish my profile on the homepage</label><button class="btn" type="submit">Save and update homepage</button></form><p class="muted">Administrator profiles can be published by an authenticated administrator. Member-submitted profiles remain subject to identity verification and admin approval.</p></section>';
      const [rows] = await pool.query("SELECT p.member_id,p.nickname,p.requested,p.approved,p.visible,m.full_name,m.username,au.role,mp.avatar_key FROM monarch_public_profiles p JOIN members m ON m.id=p.member_id LEFT JOIN admin_users au ON au.member_id=m.id LEFT JOIN member_profiles mp ON mp.member_id=m.id ORDER BY p.requested DESC,p.updated_at DESC LIMIT 300");
      const table = rows.map(p => {
        const title = p.role === 'main_admin' ? 'Founder' : 'Members';
        const status = p.visible && p.approved ? 'Published' : p.requested ? 'Awaiting review' : 'Not requested';
        return '<tr><td>' + esc(p.full_name) + '<br><small>@' + esc(p.username) + '</small></td><td>' + esc(p.nickname) + '</td><td>' + title + '</td><td>' + status + '</td><td><form method="post" action="/admin/monarchs/' + Number(p.member_id) + '">' + csrfField(req) +
          '<label class="ac-check"><input type="checkbox" name="approved" value="yes"' + (p.approved ? ' checked' : '') + '> Approve</label><label class="ac-check"><input type="checkbox" name="visible" value="yes"' + (p.visible ? ' checked' : '') + '> Show publicly</label><button class="btn" type="submit">Save</button></form></td></tr>';
      }).join('');
      const adminNotice = req.query.notice === 'invalid_nickname' ? '<section class="ac-panel"><div class="ac-alert ac-alert-warning"><strong>Check your nickname</strong><p>Use 1–80 characters without HTML tags, then save again.</p></div></section>' : req.query.notice === 'member_kyc_required' ? '<section class="ac-panel"><div class="ac-alert ac-alert-warning"><strong>Identity verification required</strong><p>This member must have approved identity verification before their profile can be published.</p></div></section>' : '';
      const content = adminNotice + ownProfile + '<section class="ac-panel"><h2>Member homepage requests</h2><p class="muted">Review member requests, approve suitable profiles and control public visibility.</p><div class="ac-table-wrap"><table class="ac-table"><thead><tr><th>Member</th><th>Nickname</th><th>Title</th><th>Status</th><th>Admin controls</th></tr></thead><tbody>' + (table || '<tr><td colspan="5">No profile requests yet.</td></tr>') + '</tbody></table></div></section>';
      res.send(adminControlPage('Homepage profiles','/admin/monarchs',content,req));
    } catch (e) { if (e.code === 'ER_NO_SUCH_TABLE') return res.status(503).send('<h1>Setup required</h1><p>Apply migrations/013_monarchs_directory.sql after backing up the database.</p>'); next(e); }
  });

  router.post('/admin/monarchs/self', requireAdmin, (req, res, next) => csrfCheck(req, res, async csrfErr => {
    if (csrfErr) return;
    try {
      const memberId = Number(req.session.memberId);
      const nickname = String(req.body.nickname || '').trim();
      if (!nickname || nickname.length > 80 || /[<>]/.test(nickname)) return res.redirect('/admin/monarchs?notice=invalid_nickname');
      const publish = req.body.publish === 'yes';
      // Administrator self-publication is controlled by the authenticated admin role; member submissions still require approved KYC.
      await pool.execute(
        'INSERT INTO monarch_public_profiles (member_id,nickname,requested,approved,visible,approved_by,approved_at) VALUES (?,?,?,?,?,?,IF(?=1,NOW(),NULL)) ON DUPLICATE KEY UPDATE nickname=VALUES(nickname),requested=VALUES(requested),approved=VALUES(approved),visible=VALUES(visible),approved_by=VALUES(approved_by),approved_at=IF(VALUES(approved)=1,NOW(),NULL)',
        [memberId,nickname,publish?1:0,publish?1:0,publish?1:0,publish?memberId:null,publish?1:0]
      );
      res.redirect('/admin/monarchs');
    } catch (e) { next(e); }
  }));

  router.post('/admin/monarchs/:memberId', requireAdmin, (req, res, next) => csrfCheck(req, res, async csrfErr => {
    if (csrfErr) return;
    try {
      const memberId = Number(req.params.memberId);
      if (!Number.isSafeInteger(memberId) || memberId < 1) return res.sendStatus(400);
      const approved = req.body.approved === 'yes' ? 1 : 0;
      const visible = req.body.visible === 'yes' && approved ? 1 : 0;
      const [[targetAdmin]] = await pool.execute('SELECT member_id FROM admin_users WHERE member_id=? AND is_active=1 LIMIT 1',[memberId]);
      if (approved && !targetAdmin && !await approvedKyc(memberId)) return res.redirect('/admin/monarchs?notice=member_kyc_required');
      await pool.execute('UPDATE monarch_public_profiles SET approved=?,visible=?,approved_by=?,approved_at=IF(?=1,NOW(),NULL) WHERE member_id=?', [approved, visible, approved ? req.session.memberId : null, approved, memberId]);
      res.redirect('/admin/monarchs');
    } catch (e) { next(e); }
  }));

  router.get('/api/public-monarchs', async (_req, res, next) => {
    try {
      const [rows] = await pool.query("SELECT p.nickname,m.monarch_uid,mp.avatar_key,CASE WHEN au.member_id IS NOT NULL THEN 'Founder' ELSE 'Members' END AS title FROM monarch_public_profiles p JOIN members m ON m.id=p.member_id LEFT JOIN admin_users au ON au.member_id=m.id AND au.is_active=1 LEFT JOIN member_profiles mp ON mp.member_id=m.id LEFT JOIN kyc_submissions k ON k.member_id=m.id AND k.status='approved' AND k.id=(SELECT MAX(k2.id) FROM kyc_submissions k2 WHERE k2.member_id=m.id) WHERE p.approved=1 AND p.visible=1 AND p.requested=1 AND (au.member_id IS NOT NULL OR k.id IS NOT NULL) ORDER BY p.approved_at DESC,p.member_id DESC LIMIT 60");
      res.set('Cache-Control', 'public, max-age=60');
      res.json(rows.map(p => ({ nickname: p.nickname, monarchId: p.monarch_uid, title: p.title, photo: p.avatar_key ? '/member-avatar/' + encodeURIComponent(p.avatar_key) : '/assets/images/monarch-codex-logo.svg' })));
    } catch (e) { if (e.code === 'ER_NO_SUCH_TABLE') return res.json([]); next(e); }
  });

  return router;
};
