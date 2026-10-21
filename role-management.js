const express = require('express');
const crypto = require('node:crypto');

function createRoleManagementRouter({ pool, requireWebCategoryAccess }) {
  const router = express.Router();
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const keyFor = value => String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);
  const csrfToken = req => { if (!req.session.csrf) req.session.csrf = crypto.randomBytes(32).toString('hex'); return req.session.csrf; };
  const csrfField = req => '<input type="hidden" name="_csrf" value="' + esc(csrfToken(req)) + '">';
  const csrf = (req, res, next) => {
    const supplied = String(req.body && req.body._csrf || ''), expected = String(req.session && req.session.csrf || '');
    if (!supplied || !expected || Buffer.byteLength(supplied) !== Buffer.byteLength(expected) || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) return res.status(403).send('Security check expired. Return to the form and try again.');
    next();
  };
  const shell = (title, content, admin = false) => '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#09090b"><title>' + esc(title) + ' · Monarch Codex</title><style>*{box-sizing:border-box}body{margin:0;background:#09090b;color:#f6f1e5;font:15px/1.6 system-ui,sans-serif}.wrap{width:min(1180px,100%);margin:auto;padding:clamp(16px,3vw,32px)}.top{display:flex;justify-content:space-between;align-items:center;gap:14px;margin-bottom:24px}.brand{font-weight:950;letter-spacing:.08em;color:#f3cf3c}.nav{display:flex;flex-wrap:wrap;gap:8px}.nav a,.btn{display:inline-flex;align-items:center;justify-content:center;padding:10px 14px;border-radius:10px;border:1px solid #4a412b;background:#171612;color:#f3cf3c;text-decoration:none;font-weight:800;cursor:pointer}.hero,.card{padding:clamp(18px,3vw,26px);border:1px solid #383226;border-radius:18px;background:linear-gradient(145deg,#1b1a16,#111113);margin-bottom:16px}.hero h1{margin:0;color:#f3cf3c;font-size:clamp(25px,4vw,38px);line-height:1.15}.muted{color:#aaa69a}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,290px),1fr));gap:14px}.field{display:grid;gap:6px;margin:10px 0}.field label{font-size:12px;font-weight:800;color:#d8c98f}.field input,.field textarea,.field select{width:100%;padding:11px 12px;border-radius:9px;border:1px solid #49412f;background:#0d0d0f;color:#fff;font:inherit}.tablewrap{overflow:auto}table{width:100%;border-collapse:collapse;min-width:650px}th,td{text-align:left;padding:11px;border-bottom:1px solid #373126;vertical-align:top}th{color:#e7d28d;font-size:12px}.pill{display:inline-block;border:1px solid #49412f;border-radius:99px;padding:3px 9px;color:#e7d28d;font-size:12px}.danger{color:#ffb4a8;border-color:#67423c}.success{color:#9ee0b4}.notice{padding:12px;border:1px solid #51472e;border-radius:10px;margin:12px 0;background:#1a1812}.actions{display:flex;gap:8px;flex-wrap:wrap}.btn.gold{background:#f3cf3c;color:#17140a;border-color:#f3cf3c}.small{font-size:12px}@media(max-width:520px){.top{align-items:flex-start;flex-direction:column}.wrap{padding:14px}}</style></head><body><main class="wrap"><header class="top"><div class="brand">MONARCH CODEX</div><nav class="nav"><a href="' + (admin ? '/admin' : '/dashboard') + '">Dashboard</a><a href="' + (admin ? '/admin/roles' : '/roles') + '">Role management</a><a href="/logout">Sign out</a></nav></header>' + content + '</main></body></html>';
  const memberAuth = async (req, res, next) => {
    if (!req.session || !req.session.memberId) return res.redirect('/login');
    try {
      const [rows] = await pool.execute('SELECT is_blocked FROM members WHERE id=? LIMIT 1', [req.session.memberId]);
      if (!rows.length || Number(rows[0].is_blocked) === 1) return res.status(403).send('Account access is restricted.');
      next();
    } catch (e) { next(e); }
  };
  const adminAuth = async (req, res, next) => {
    if (!req.session || !req.session.memberId) return res.redirect('/login');
    try {
      const [rows] = await pool.execute('SELECT role FROM admin_users WHERE member_id=? AND is_active=1 LIMIT 1', [req.session.memberId]);
      if (!rows.length || !['super_admin','main_admin'].includes(String(rows[0].role))) return res.status(403).send('Only authorised Monarch Codex administrators can manage member roles.');
      req.adminRole = rows[0].role;
      next();
    } catch (e) { next(e); }
  };
  const ensureReady = async () => {
    const [tables] = await pool.query("SHOW TABLES LIKE 'member_role_catalog'");
    if (!tables.length) { const e = new Error('Role management migration is not applied. Apply migrations/018_member_role_management.sql.'); e.code = 'ROLE_MIGRATION_REQUIRED'; throw e; }
  };
  router.get('/roles', memberAuth, async (req, res, next) => {
    try {
      await ensureReady();
      const [[member]] = await pool.execute('SELECT full_name,monarch_uid FROM members WHERE id=? LIMIT 1', [req.session.memberId]);
      const [roles] = await pool.query("SELECT r.id,r.role_name,r.description, a.id AS assignment_id FROM member_role_catalog r LEFT JOIN member_role_assignments a ON a.role_id=r.id AND a.member_id=? WHERE r.is_active=1 AND LOWER(r.role_key)<>'founder' AND LOWER(r.role_name)<>'founder' ORDER BY r.role_name", [req.session.memberId]);
      const [requests] = await pool.execute("SELECT q.id,q.status,q.message,q.created_at,r.role_name FROM member_role_requests q JOIN member_role_catalog r ON r.id=q.role_id WHERE q.member_id=? AND LOWER(r.role_key)<>'founder' AND LOWER(r.role_name)<>'founder' ORDER BY q.created_at DESC LIMIT 20", [req.session.memberId]);
      const roleCards = roles.map(r => '<article class="card"><h2>' + esc(r.role_name) + '</h2><p class="muted">' + esc(r.description || 'Role access is subject to administrator approval.') + '</p>' + (r.assignment_id ? '<span class="pill success">Assigned</span>' : '<form method="post" action="/roles/request/' + Number(r.id) + '">' + csrfField(req) + '<div class="field"><label>Why are you requesting this role?</label><textarea name="message" maxlength="1000" rows="3" placeholder="Briefly explain your request"></textarea></div><button class="btn gold" type="submit">Request role</button></form>') + '</article>').join('');
      const history = requests.map(q => '<tr><td>' + esc(q.role_name) + '</td><td><span class="pill">' + esc(q.status) + '</span></td><td>' + esc(q.message || '—') + '</td><td>' + esc(q.created_at) + '</td></tr>').join('');
      res.send(shell('My roles', '<section class="hero"><p class="muted">MEMBER ACCESS</p><h1>My roles</h1><p class="muted">Hello ' + esc(member.full_name) + '. Request access here. Roles are only assigned after review by an authorised administrator.</p></section><section class="grid">' + roleCards + '</section><section class="card"><h2>Request history</h2><div class="tablewrap"><table><thead><tr><th>Role</th><th>Status</th><th>Message</th><th>Requested</th></tr></thead><tbody>' + (history || '<tr><td colspan="4">No role requests yet.</td></tr>') + '</tbody></table></div></section>'));
    } catch (e) { if (e.code === 'ROLE_MIGRATION_REQUIRED') return res.status(503).send(shell('Roles not configured', '<section class="hero"><h1>Role management is being prepared</h1><p>' + esc(e.message) + '</p></section>')); next(e); }
  });
  router.post('/roles/request/:roleId', memberAuth, csrf, async (req, res, next) => {
    try {
      await ensureReady();
      const roleId = Number(req.params.roleId), message = String(req.body.message || '').trim().slice(0, 1000);
      if (!Number.isSafeInteger(roleId) || roleId < 1) return res.sendStatus(400);
      const [[role]] = await pool.execute('SELECT id FROM member_role_catalog WHERE id=? AND is_active=1 AND LOWER(role_key)<>'founder' AND LOWER(role_name)<>'founder' LIMIT 1', [roleId]);
      if (!role) return res.status(404).send('That role is not available.');
      const [[assigned]] = await pool.execute('SELECT id FROM member_role_assignments WHERE member_id=? AND role_id=? LIMIT 1', [req.session.memberId, roleId]);
      if (assigned) return res.redirect('/roles?notice=already-assigned');
      const [[pending]] = await pool.execute("SELECT id FROM member_role_requests WHERE member_id=? AND role_id=? AND status='pending' LIMIT 1", [req.session.memberId, roleId]);
      if (pending) return res.redirect('/roles?notice=already-pending');
      await pool.execute("INSERT INTO member_role_requests (member_id,role_id,request_source,message,status) VALUES (?,?, 'member',?,'pending')", [req.session.memberId, roleId, message || null]);
      res.redirect('/roles?notice=requested');
    } catch (e) { if (e.code === 'ROLE_MIGRATION_REQUIRED') return res.status(503).send('Role management is not configured yet.'); next(e); }
  });
  router.get('/admin/roles', adminAuth, requireWebCategoryAccess ? requireWebCategoryAccess('members_roles','view') : (_req,_res,next)=>next(), async (req, res, next) => {
    try {
      await ensureReady();
      const [roles] = await pool.query('SELECT r.id,r.role_key,r.role_name,r.description,r.is_active,COUNT(a.id) AS assigned_count FROM member_role_catalog r LEFT JOIN member_role_assignments a ON a.role_id=r.id GROUP BY r.id ORDER BY r.role_name');
      const [requests] = await pool.query("SELECT q.id,q.member_id,q.request_source,q.company_name,q.message,q.created_at,r.role_name,m.full_name,m.email,m.monarch_uid FROM member_role_requests q JOIN member_role_catalog r ON r.id=q.role_id JOIN members m ON m.id=q.member_id WHERE q.status='pending' ORDER BY q.created_at ASC LIMIT 200");
      const [members] = await pool.query('SELECT id,full_name,email,monarch_uid FROM members ORDER BY id DESC LIMIT 100');
      const roleRows = roles.map(r => '<tr><td>' + Number(r.id) + '</td><td><form method="post" action="/admin/roles/catalog" class="field">' + csrfField(req) + '<input type="hidden" name="roleId" value="' + Number(r.id) + '"><input name="roleName" value="' + esc(r.role_name) + '" maxlength="100" required><input name="description" value="' + esc(r.description || '') + '" maxlength="500" placeholder="Description"><label><input type="checkbox" name="isActive" value="1" ' + (Number(r.is_active) ? 'checked' : '') + '> Active</label><button class="btn" type="submit">Save role</button></form></td><td><code>' + esc(r.role_key) + '</code></td><td>' + Number(r.assigned_count) + '</td></tr>').join('');
      const requestRows = requests.map(q => '<tr><td>' + esc(q.full_name) + '<br><span class="muted">' + esc(q.email) + ' · ' + esc(q.monarch_uid) + '</span></td><td>' + esc(q.role_name) + '</td><td>' + esc(q.request_source) + (q.company_name ? '<br>' + esc(q.company_name) : '') + '</td><td>' + esc(q.message || '—') + '</td><td><form method="post" action="/admin/roles/requests/' + Number(q.id) + '">' + csrfField(req) + '<button class="btn gold" name="decision" value="approve" type="submit">Approve</button> <button class="btn danger" name="decision" value="reject" type="submit">Reject</button></form></td></tr>').join('');
      const memberRows = members.map(m => '<tr><td>' + esc(m.full_name) + '<br><span class="muted">' + esc(m.email) + ' · ' + esc(m.monarch_uid) + '</span></td><td><form method="post" action="/admin/roles/assign">' + csrfField(req) + '<input type="hidden" name="memberId" value="' + Number(m.id) + '"><select name="roleId" required>' + roles.filter(r => Number(r.is_active)).map(r => '<option value="' + Number(r.id) + '">' + esc(r.role_name) + '</option>').join('') + '</select> <button class="btn" name="action" value="assign" type="submit">Assign</button></form></td></tr>').join('');
      const content = '<section class="hero"><p class="muted">MONARCH CODEX ADMINISTRATION</p><h1>Role management</h1><p class="muted">Create and edit role options, review member requests, and assign or remove roles. Member requests never grant access automatically.</p></section><section class="grid"><div class="card"><h2>Add a role</h2><form method="post" action="/admin/roles/catalog">' + csrfField(req) + '<div class="field"><label>Role name</label><input name="roleName" maxlength="100" placeholder="e.g. Community Lead" required></div><div class="field"><label>Description</label><textarea name="description" maxlength="500" rows="3"></textarea></div><button class="btn gold" type="submit">Add role</button></form><p class="muted small">Role names and keys are unique. Existing assignments are retained when a role is edited.</p></div><div class="card"><h2>Current role options</h2><div class="tablewrap"><table><thead><tr><th>ID</th><th>Edit role</th><th>Key</th><th>Assigned</th></tr></thead><tbody>' + (roleRows || '<tr><td colspan="4">No roles configured.</td></tr>') + '</tbody></table></div></div></section><section class="card"><h2>Pending requests</h2><div class="tablewrap"><table><thead><tr><th>Member</th><th>Requested role</th><th>Source</th><th>Message</th><th>Review</th></tr></thead><tbody>' + (requestRows || '<tr><td colspan="5">No pending requests.</td></tr>') + '</tbody></table></div></section><section class="card"><h2>Assign roles manually</h2><p class="muted">The member list shows the 100 newest accounts. Assignments are unique per member and role.</p><div class="tablewrap"><table><thead><tr><th>Member</th><th>Assign</th></tr></thead><tbody>' + (memberRows || '<tr><td colspan="2">No members found.</td></tr>') + '</tbody></table></div></section>';
      res.send(shell('Role management', content, true));
    } catch (e) { if (e.code === 'ROLE_MIGRATION_REQUIRED') return res.status(503).send(shell('Roles not configured', '<section class="hero"><h1>Role management is being prepared</h1><p>' + esc(e.message) + '</p></section>', true)); next(e); }
  });
  router.post('/admin/roles/catalog', adminAuth, csrf, requireWebCategoryAccess ? requireWebCategoryAccess('members_roles','manage') : (_req,_res,next)=>next(), async (req, res, next) => {
    try {
      await ensureReady();
      const id = Number(req.body.roleId || 0), name = String(req.body.roleName || '').trim(), description = String(req.body.description || '').trim().slice(0,500), active = req.body.isActive === undefined && id ? 0 : (req.body.isActive === '1' ? 1 : 0);
      const key = keyFor(name);
      if (!name || name.length > 100 || !key) return res.status(400).send('Enter a valid role name.');
      if (key === 'founder') return res.status(403).send('Founder is reserved exclusively for the Monarch Codex Super Admin and cannot be created as a member role.');
      if (id) await pool.execute('UPDATE member_role_catalog SET role_key=?,role_name=?,description=?,is_active=? WHERE id=?', [key,name,description||null,active,id]);
      else await pool.execute('INSERT INTO member_role_catalog (role_key,role_name,description,is_active,created_by_member_id) VALUES (?,?,?,1,?)', [key,name,description||null,req.session.memberId]);
      res.redirect('/admin/roles');
    } catch (e) { if (e.code === 'ER_DUP_ENTRY') return res.status(409).send(shell('Duplicate role', '<section class="hero"><h1>That role already exists</h1><p>Role names and role keys must be unique. No duplicate was added.</p><a class="btn" href="/admin/roles">Back to roles</a></section>', true)); next(e); }
  });
  router.post('/admin/roles/requests/:requestId', adminAuth, csrf, requireWebCategoryAccess ? requireWebCategoryAccess('members_roles',req=>req.body.decision==='approve'?'approve':'reject') : (_req,_res,next)=>next(), async (req, res, next) => {
    try {
      await ensureReady();
      const id = Number(req.params.requestId), decision = String(req.body.decision || '');
      if (!Number.isSafeInteger(id) || id < 1 || !['approve','reject'].includes(decision)) return res.sendStatus(400);
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [[request]] = await connection.execute("SELECT q.id,q.member_id,q.role_id,q.status,r.role_key,r.role_name FROM member_role_requests q JOIN member_role_catalog r ON r.id=q.role_id WHERE q.id=? FOR UPDATE", [id]);
        if (!request || request.status !== 'pending') { await connection.rollback(); return res.status(409).send('This request has already been reviewed.'); }
        if (decision === 'approve' && (String(request.role_key).toLowerCase() === 'founder' || String(request.role_name).toLowerCase() === 'founder')) { await connection.rollback(); return res.status(403).send('Founder is reserved exclusively for the Monarch Codex Super Admin.'); }
        if (decision === 'approve') await connection.execute('INSERT IGNORE INTO member_role_assignments (member_id,role_id,assigned_by_member_id) VALUES (?,?,?)', [request.member_id,request.role_id,req.session.memberId]);
        await connection.execute('UPDATE member_role_requests SET status=?,reviewed_by_member_id=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=?', [decision === 'approve' ? 'approved' : 'rejected',req.session.memberId,id]);
        await connection.commit();
      } catch (e) { await connection.rollback(); throw e; } finally { connection.release(); }
      res.redirect('/admin/roles');
    } catch (e) { next(e); }
  });
  router.post('/admin/roles/assign', adminAuth, csrf, requireWebCategoryAccess ? requireWebCategoryAccess('members_roles','manage') : (_req,_res,next)=>next(), async (req, res, next) => {
    try {
      await ensureReady();
      const memberId = Number(req.body.memberId), roleId = Number(req.body.roleId), action = String(req.body.action || 'assign');
      if (!Number.isSafeInteger(memberId) || memberId < 1 || !Number.isSafeInteger(roleId) || roleId < 1 || !['assign','remove'].includes(action)) return res.sendStatus(400);
      const [[targetRole]] = await pool.execute('SELECT role_key,role_name FROM member_role_catalog WHERE id=? LIMIT 1',[roleId]);
      if (!targetRole) return res.status(404).send('Role not found.');
      if (String(targetRole.role_key).toLowerCase() === 'founder' || String(targetRole.role_name).toLowerCase() === 'founder') return res.status(403).send('Founder cannot be assigned to members.');
      if (action === 'assign') await pool.execute('INSERT IGNORE INTO member_role_assignments (member_id,role_id,assigned_by_member_id) VALUES (?,?,?)', [memberId,roleId,req.session.memberId]);
      else await pool.execute('DELETE FROM member_role_assignments WHERE member_id=? AND role_id=?', [memberId,roleId]);
      res.redirect('/admin/roles');
    } catch (e) { next(e); }
  });
  router.get('/sovereign-admin/roles/request', async (req,res,next) => {
    if (!req.session || !req.session.memberId) return res.redirect('/login');
    try {
      const [[admin]] = await pool.execute('SELECT role FROM admin_users WHERE member_id=? AND is_active=1 LIMIT 1', [req.session.memberId]);
      if (!admin || admin.role !== 'sovereign_desk_admin') return res.status(403).send('Only the Sovereign Desk administrator can submit this company request.');
      await ensureReady();
      res.send(shell('Partner request','<section class="hero"><p class="muted">SOVEREIGN DESK · COMPANY REQUEST</p><h1>Request Partner role</h1><p class="muted">Submit this request on behalf of the company. It will be reviewed by a Monarch Codex administrator and will not grant access automatically.</p></section><section class="card"><form method="post" action="/sovereign-admin/roles/partner-request">'+csrfField(req)+'<div class="field"><label>Company / partner name</label><input name="companyName" value="Sovereign Desk" maxlength="160" required></div><div class="field"><label>Reason for request</label><textarea name="message" rows="4" maxlength="1000" required>Request Partner role for the Sovereign Desk company.</textarea></div><button class="btn gold" type="submit">Submit company request</button></form></section>',true));
    } catch(e) { if(e.code==='ROLE_MIGRATION_REQUIRED')return res.status(503).send(shell('Roles not configured','<section class="hero"><h1>Role management is being prepared</h1><p>'+esc(e.message)+'</p></section>',true)); next(e); }
  });
  router.post('/sovereign-admin/roles/partner-request', csrf, async (req, res, next) => {
    if (!req.session || !req.session.memberId) return res.redirect('/login');
    try {
      const [[admin]] = await pool.execute('SELECT role FROM admin_users WHERE member_id=? AND is_active=1 LIMIT 1', [req.session.memberId]);
      if (!admin || admin.role !== 'sovereign_desk_admin') return res.status(403).send('Only the Sovereign Desk administrator can submit a company Partner request.');
      await ensureReady();
      const [[role]] = await pool.execute("SELECT id FROM member_role_catalog WHERE role_key='partner' AND is_active=1 LIMIT 1");
      if (!role) return res.status(409).send('Partner role is not active. Contact a Monarch Codex administrator.');
      const [[pending]] = await pool.execute("SELECT id FROM member_role_requests WHERE member_id=? AND role_id=? AND status='pending' LIMIT 1", [req.session.memberId,role.id]);
      if (!pending) await pool.execute("INSERT INTO member_role_requests (member_id,role_id,request_source,company_name,message,status) VALUES (?,?, 'sovereign_desk',? ,?,'pending')", [req.session.memberId,role.id,String(req.body.companyName||'Sovereign Desk').trim().slice(0,160),String(req.body.message||'Company role request').trim().slice(0,1000)]);
      res.redirect('/sovereign-admin?roleRequest=pending');
    } catch (e) { next(e); }
  });
  return router;
}

module.exports = createRoleManagementRouter;
