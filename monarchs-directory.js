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
      let publicDetails = null;
      try {
        const [rows] = await pool.execute('SELECT nickname,requested,approved,visible FROM monarch_public_profiles WHERE member_id=? LIMIT 1', [member.id]);
        profile = rows[0] || null;
      } catch (e) { if (e.code !== 'ER_NO_SUCH_TABLE') throw e; }
      try {
        const [rows] = await pool.execute('SELECT location FROM member_public_profile_details WHERE member_id=? LIMIT 1', [member.id]);
        publicDetails = rows[0] || null;
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
        '<label for="monarchNickname">Public display name</label><input id="monarchNickname" name="nickname" maxlength="80" required value="' + esc(profile?.nickname || '') + '" placeholder="The name you want displayed">' +
        '<label for="monarchLocation">Location (optional)</label><input id="monarchLocation" name="location" maxlength="120" value="' + esc(publicDetails?.location || '') + '" placeholder="City, state or country">' +
        '<p class="muted">Only share a location you are comfortable making public. Your UID and approved public roles may appear on your profile; private contact details and identity documents are not displayed.</p>' +
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
      const location = String(req.body.location || '').trim();
      if (location.length > 120 || /[<>]/.test(location)) return res.redirect('/profile/monarchs?notice=invalid_nickname');
      await pool.execute(
        'INSERT INTO monarch_public_profiles (member_id,nickname,requested,approved,visible) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE approved=IF(VALUES(requested)=0 OR nickname<>VALUES(nickname),0,approved),visible=IF(VALUES(requested)=0 OR nickname<>VALUES(nickname),0,visible),nickname=VALUES(nickname),requested=VALUES(requested)',
        [memberId, nickname, requested, 0, 0]
      );
      await pool.execute('INSERT INTO member_public_profile_details (member_id,location) VALUES (?,?) ON DUPLICATE KEY UPDATE location=VALUES(location)', [memberId, location || null]);
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
        const title = p.role ? 'Founder' : 'Members';
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
      const [rows] = await pool.query("SELECT p.nickname,m.monarch_uid,mp.avatar_key,CASE WHEN au.member_id IS NOT NULL THEN 'Administrator' ELSE 'Member' END AS title FROM monarch_public_profiles p JOIN members m ON m.id=p.member_id LEFT JOIN admin_users au ON au.member_id=m.id AND au.is_active=1 LEFT JOIN member_profiles mp ON mp.member_id=m.id LEFT JOIN kyc_submissions k ON k.member_id=m.id AND k.status='approved' AND k.id=(SELECT MAX(k2.id) FROM kyc_submissions k2 WHERE k2.member_id=m.id) WHERE p.approved=1 AND p.visible=1 AND p.requested=1 AND (au.member_id IS NOT NULL OR k.id IS NOT NULL) ORDER BY p.approved_at DESC,p.member_id DESC LIMIT 60");
      const memberIds = new Map();
      let roleMap = new Map();
      try {
        const [roleRows] = await pool.query("SELECT a.member_id,r.role_name FROM member_role_assignments a JOIN member_role_catalog r ON r.id=a.role_id WHERE r.is_active=1 ORDER BY r.role_name");
        for (const role of roleRows) {
          if (!roleMap.has(Number(role.member_id))) roleMap.set(Number(role.member_id), []);
          roleMap.get(Number(role.member_id)).push(String(role.role_name));
        }
      } catch (e) { if (e.code !== 'ER_NO_SUCH_TABLE') throw e; }
      const ids = rows.map(row => row.monarch_uid);
      const [memberRows] = ids.length ? await pool.query("SELECT id,monarch_uid FROM members WHERE monarch_uid IN (" + ids.map(() => '?').join(',') + ")", ids) : [[]];
      for (const row of memberRows) memberIds.set(String(row.monarch_uid), Number(row.id));
      res.set('Cache-Control', 'public, max-age=60');
      res.json(rows.map(p => ({ nickname: p.nickname, monarchId: p.monarch_uid, title: p.title, roles: roleMap.get(memberIds.get(String(p.monarch_uid))) || [], photo: p.avatar_key ? '/member-avatar/' + encodeURIComponent(p.avatar_key) : '/assets/images/monarch-codex-logo.svg' })));
    } catch (e) { if (e.code === 'ER_NO_SUCH_TABLE') return res.json([]); next(e); }
  });

  router.get('/public-member/:uid', async (req, res, next) => {
    try {
      const uid = String(req.params.uid || '').trim().toUpperCase();
      if (!/^MONARCH\d{6}$/.test(uid)) return res.status(404).send('Public member profile not found.');
      const [[person]] = await pool.execute(
        "SELECT m.id,m.monarch_uid,mp.avatar_key,p.nickname,d.location,CASE WHEN au.member_id IS NOT NULL THEN 'Administrator' ELSE 'Member' END AS title FROM members m JOIN monarch_public_profiles p ON p.member_id=m.id LEFT JOIN member_profiles mp ON mp.member_id=m.id LEFT JOIN member_public_profile_details d ON d.member_id=m.id LEFT JOIN admin_users au ON au.member_id=m.id AND au.is_active=1 WHERE m.monarch_uid=? AND p.requested=1 AND p.approved=1 AND p.visible=1 LIMIT 1",
        [uid]
      );
      if (!person) return res.status(404).send('This member has not published an approved public profile.');
      let roles = [];
      try {
        const [rows] = await pool.execute("SELECT r.role_name FROM member_role_assignments a JOIN member_role_catalog r ON r.id=a.role_id WHERE a.member_id=? AND r.is_active=1 ORDER BY r.role_name", [person.id]);
        roles = rows.map(row => String(row.role_name));
      } catch (e) { if (e.code !== 'ER_NO_SUCH_TABLE') throw e; }
      if (person.title === 'Administrator') roles.unshift('Administrator');
      const photo = person.avatar_key && /^[a-f0-9]{48}\.(jpg|png|webp)$/.test(String(person.avatar_key)) ? '/member-avatar/' + encodeURIComponent(person.avatar_key) : '/assets/images/monarch-codex-logo.svg';
      const roleChips = roles.length ? roles.map(role => '<span class="mc-role">' + esc(role) + '</span>').join('') : '<span class="mc-role">Member</span>';
      const page = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#09090b"><title>' + esc(person.nickname || 'Monarch') + ' · Monarch Codex</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(ellipse at top,#29220e,#09090b 58%);color:#f7f4e9;font:15px/1.6 system-ui,sans-serif}.wrap{width:min(720px,100%);margin:auto;padding:24px}.back{color:#f3cf3c;text-decoration:none;font-weight:800}.profile{margin:30px auto;padding:clamp(22px,5vw,42px);border:1px solid #5b4b22;border-radius:24px;background:linear-gradient(145deg,#1b1a16,#101012);text-align:center;box-shadow:0 24px 80px #0006}.avatar{width:124px;height:124px;border-radius:50%;object-fit:cover;border:3px solid #f3cf3c;background:#171612}.eyebrow{color:#f3cf3c;font-size:.72rem;font-weight:900;letter-spacing:.15em}.profile h1{font-size:clamp(1.7rem,5vw,2.5rem);line-height:1.1;overflow-wrap:anywhere}.uid{color:#e5d08a;font-weight:800;letter-spacing:.08em}.roles{display:flex;justify-content:center;gap:8px;flex-wrap:wrap;margin:18px 0}.mc-role{border:1px solid #5b4b22;border-radius:999px;padding:6px 12px;background:#211c10;color:#f3d979;font-size:.82rem;font-weight:800}.location{color:#c5c0b5}.foot{color:#9e998d;font-size:.8rem;margin-top:24px}</style></head><body><main class="wrap"><a class="back" href="/#monarchs">← Back to Monarchs</a><section class="profile"><p class="eyebrow">THE PEOPLE BEHIND THE KINGDOM</p><img class="avatar" src="' + photo + '" alt="Profile photo"><h1>' + esc(person.nickname || 'Monarch') + '</h1><p class="uid">' + esc(person.monarch_uid) + '</p><div class="roles">' + roleChips + '</div>' + (person.location ? '<p class="location">⌖ ' + esc(person.location) + '</p>' : '') + '<p class="foot">Only information selected for public display appears here. Private contact details and identity records are not shown.</p></section></main></body></html>';
      res.set('Cache-Control', 'public, max-age=60').send(page);
    } catch (e) { if (e.code === 'ER_NO_SUCH_TABLE') return res.status(503).send('Public profiles are being configured. Please try again later.'); next(e); }
  });

  return router;
};
