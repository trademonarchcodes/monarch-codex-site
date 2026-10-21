'use strict';

const express = require('express');

function createAdminRoleManagementRouter({ pool, requireAdmin, csrfCheck, csrfField, adminControlPage, esc, page }) {
  const router = express.Router();
  const seniorRoles = new Set(['super_admin', 'main_admin']);
  const roleValues = new Set(['none', 'limited_admin', 'sovereign_desk_admin', 'main_admin', 'super_admin']);
  const canManage = (req, res, next) => {
    if (!seniorRoles.has(String(req.adminRole || ''))) {
      return res.status(403).send(page('Permission required', '<h1>Administrator role management is restricted</h1><p class="muted">Only authorised senior administrators can change administrator roles.</p><a class="btn" href="/admin">Return to admin</a>'));
    }
    next();
  };
  const roleLabel = value => value ? String(value).replace(/_/g, ' ') : 'Member';
  const canAssign = (actorRole, targetRole, nextRole) => {
    if (actorRole === 'super_admin') return true;
    if (actorRole !== 'main_admin') return false;
    if (targetRole === 'super_admin' || targetRole === 'main_admin') return false;
    return nextRole === 'none' || nextRole === 'limited_admin' || nextRole === 'sovereign_desk_admin';
  };

  router.get('/', requireAdmin, canManage, async (req, res, next) => {
    try {
      const query = String(req.query.q || '').trim().slice(0, 120);
      const like = '%' + query.replace(/[\\%_]/g, '\\$&') + '%';
      const [rows] = await pool.execute(
        'SELECT m.id,m.username,m.full_name,m.email,au.role,au.is_active FROM members m LEFT JOIN admin_users au ON au.member_id=m.id WHERE (? = \'\' OR m.username LIKE ? OR m.full_name LIKE ? OR m.email LIKE ? OR CAST(m.id AS CHAR) = ?) ORDER BY (au.role IS NOT NULL) DESC,m.id DESC LIMIT 200',
        [query, like, like, like, query]
      );
      const actorRole = String(req.adminRole || '');
      const optionsFor = current => {
        const options = actorRole === 'super_admin'
          ? [['none','Member — remove admin access'],['limited_admin','Limited admin'],['sovereign_desk_admin','Sovereign Desk'],['main_admin','Main admin'],['super_admin','Super admin']]
          : [['none','Member — remove admin access'],['limited_admin','Limited admin'],['sovereign_desk_admin','Sovereign Desk']];
        return options.map(([value,label]) => '<option value="' + value + '"' + ((current || 'none') === value ? ' selected' : '') + '>' + label + '</option>').join('');
      };
      const table = rows.map(member => {
        const current = member.role || 'none';
        const protectedSuper = actorRole !== 'super_admin' && ['super_admin', 'main_admin'].includes(String(member.role || ''));
        const self = Number(member.id) === Number(req.session.memberId);
        const state = member.role ? (Number(member.is_active) ? 'Active administrator' : 'Inactive administrator') : 'Member';
        const control = self
          ? '<span class="muted">Your own role cannot be changed here.</span>'
          : protectedSuper
            ? '<span class="muted">Protected super administrator</span>'
            : '<form method="post" action="/admin/roles/' + Number(member.id) + '" class="role-edit-form">' + csrfField(req) + '<label class="sr-only" for="role-' + Number(member.id) + '">Role for ' + esc(member.username) + '</label><select id="role-' + Number(member.id) + '" name="role" required>' + optionsFor(current) + '</select><button class="btn" type="submit">Save role</button></form>';
        return '<tr><td><strong>' + esc(member.full_name || member.username) + '</strong><br><small>@' + esc(member.username) + ' · ID ' + Number(member.id) + '</small></td><td>' + esc(member.email || '') + '</td><td>' + esc(roleLabel(member.role)) + '</td><td>' + esc(state) + '</td><td>' + control + '</td></tr>';
      }).join('');
      const updatedNotice = req.query.notice === 'updated' ? '<div class="ac-alert" role="status">Administrator role updated and recorded in the audit log.</div>' : '';
      const content = updatedNotice + '<section class="ac-panel"><h2>Administrator roles</h2><p class="muted">Grant or remove administrative workspace access. Sovereign Desk access does not include deposits, withdrawals, wallet balances, or financial approvals. Role changes are recorded in the admin audit log.</p><form method="get" action="/admin/roles" class="role-search"><label for="role-search">Find a member</label><input id="role-search" name="q" value="' + esc(query) + '" maxlength="120" placeholder="Username, name, email, or member ID"><button class="btn" type="submit">Search</button></form><div class="ac-table-wrap"><table class="ac-table"><thead><tr><th>Member</th><th>Email</th><th>Role</th><th>Status</th><th>Change role</th></tr></thead><tbody>' + (table || '<tr><td colspan="5">No matching members found.</td></tr>') + '</tbody></table></div><p class="muted small">Main admins can assign Limited Admin and Sovereign Desk roles, but cannot grant or change Main Admin or Super Admin. Only a Super Admin can assign senior roles. Your own role is protected.</p></section><style>.role-search{display:flex;align-items:end;gap:10px;flex-wrap:wrap;margin:16px 0 20px}.role-search label{display:grid;gap:6px;flex:1 1 240px}.role-search input,.role-edit-form select{box-sizing:border-box;min-height:44px;padding:10px 12px;border:1px solid #49443a;border-radius:10px;background:#0d0d10;color:#f7f5ef;font:inherit}.role-edit-form{display:flex;gap:8px;align-items:center;min-width:250px}.role-edit-form select{flex:1;min-width:150px}.role-edit-form .btn{white-space:nowrap}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}@media(max-width:600px){.role-edit-form{align-items:stretch;flex-direction:column;min-width:170px}.role-edit-form .btn{width:100%}}</style>';
      res.set('Cache-Control', 'no-store, private');
      res.send(adminControlPage('Administrator roles', '/admin/roles', content, req));
    } catch (error) {
      if (error.code === 'ER_NO_SUCH_TABLE') return res.status(503).send(page('Administrator access setup required', '<h1>Administrator access setup required</h1><p class="muted">The admin_users table or audit log is missing. Apply the reviewed administrator-access migrations before managing roles.</p><a class="btn" href="/admin/audit">Audit & access</a>'));
      next(error);
    }
  });

  router.post('/:memberId', requireAdmin, canManage, express.urlencoded({ extended: false, limit: '5kb' }), csrfCheck, async (req, res, next) => {
    const memberId = Number(req.params.memberId);
    const nextRole = String(req.body.role || '');
    const actorRole = String(req.adminRole || '');
    if (!Number.isSafeInteger(memberId) || memberId < 1 || !roleValues.has(nextRole)) {
      return res.status(400).send(page('Invalid role change', '<h1>Choose a valid administrator role</h1><a class="btn" href="/admin/roles">Return to roles</a>'));
    }
    if (memberId === Number(req.session.memberId)) {
      return res.status(400).send(page('Action not allowed', '<h1>You cannot change your own administrator role</h1><a class="btn" href="/admin/roles">Return to roles</a>'));
    }
    let conn;
    try {
      conn = await pool.getConnection();
      await conn.beginTransaction();
      const [targetRows] = await conn.execute('SELECT id FROM members WHERE id=? LIMIT 1 FOR UPDATE', [memberId]);
      if (!targetRows.length) {
        await conn.rollback();
        return res.status(404).send(page('Member not found', '<h1>Member account not found</h1><a class="btn" href="/admin/roles">Return to roles</a>'));
      }
      const [adminRows] = await conn.execute('SELECT member_id,role,is_active FROM admin_users FOR UPDATE');
      const activeAdmins = adminRows.filter(row => Number(row.is_active) === 1);
      const currentRow = adminRows.find(row => Number(row.member_id) === memberId);
      const currentRole = currentRow ? String(currentRow.role) : 'none';
      if (!canAssign(actorRole, currentRole === 'none' ? null : currentRole, nextRole)) {
        await conn.rollback();
        return res.status(403).send(page('Permission required', '<h1>This role change is not permitted</h1><p class="muted">Your administrator role cannot grant or modify that level of access.</p><a class="btn" href="/admin/roles">Return to roles</a>'));
      }
      if (currentRole === 'super_admin' && nextRole !== 'super_admin' && activeAdmins.filter(row => row.role === 'super_admin').length <= 1) {
        await conn.rollback();
        return res.status(409).send(page('Protected administrator access', '<h1>The last active Super Admin cannot be removed</h1><p class="muted">Promote another authorised account first, then retry this change.</p><a class="btn" href="/admin/roles">Return to roles</a>'));
      }
      if (nextRole === 'none') {
        await conn.execute('DELETE FROM admin_users WHERE member_id=?', [memberId]);
      } else {
        await conn.execute('INSERT INTO admin_users (member_id,role,is_active) VALUES (?,?,1) ON DUPLICATE KEY UPDATE role=VALUES(role),is_active=1', [memberId, nextRole]);
      }
      await conn.execute('INSERT INTO admin_audit_log (admin_member_id,action,target_type,target_id,details,ip_address) VALUES (?,?,?,?,?,?)', [
        Number(req.session.memberId), 'admin.role.updated', 'admin_users', String(memberId),
        JSON.stringify({ previous_role: currentRole, new_role: nextRole }), req.ip || null
      ]);
      await conn.commit();
      return res.redirect('/admin/roles?notice=updated');
    } catch (error) {
      if (conn) { try { await conn.rollback(); } catch (_) {} }
      if (error.code === 'ER_NO_SUCH_TABLE') return res.status(503).send(page('Administrator access setup required', '<h1>Administrator access setup required</h1><p class="muted">The admin access or audit schema is missing. No role change was committed.</p><a class="btn" href="/admin/roles">Return to roles</a>'));
      if (error.code === 'ER_BAD_FIELD_ERROR') return res.status(503).send(page('Administrator role schema needs updating', '<h1>Administrator role schema needs updating</h1><p class="muted">The database does not yet support all role options. Review migration 005 before applying any schema change.</p><a class="btn" href="/admin/roles">Return to roles</a>'));
      next(error);
    } finally {
      if (conn) conn.release();
    }
  });

  return router;
}

module.exports = createAdminRoleManagementRouter;
