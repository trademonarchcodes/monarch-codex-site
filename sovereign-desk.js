'use strict';

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');

function createSovereignDeskRouter(deps) {
  const { pool, requireAuth, requireApprovedKyc, requireAdmin, csrfCheck, csrfField, adminControlPage, memberPage, getMemberForPage, esc } = deps;
  const router = express.Router();
  const urlencoded = express.urlencoded({ extended: false, limit: '12kb' });
  const idOk = value => /^\d{1,20}$/.test(String(value || ''));
  const clean = (value, max) => String(value == null ? '' : value).trim().slice(0, max);
  const statusLabel = value => esc(String(value || '').replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()));
  const dateLabel = value => value ? esc(value instanceof Date ? value.toISOString().replace('T', ' ').slice(0, 16) : value) : '—';
  const moneyText = value => esc(String(value || ''));
  const dbUnavailable = async (res, next, error, title) => {
    if (!error || !['ER_NO_SUCH_TABLE', 'ER_BAD_FIELD_ERROR', 'ER_NO_SUCH_COLUMN'].includes(error.code)) return next(error);
    const requirements = [
      ['sovereign_signals', '004_admin_sovereign_desk.sql'],
      ['sovereign_guidance', '004_admin_sovereign_desk.sql'],
      ['sovereign_desk_access', '004_admin_sovereign_desk.sql'],
      ['sovereign_access_requests', '004_admin_sovereign_desk.sql'],
      ['member_notifications', '005_member_dashboard_and_sovereign_desk.sql'],
      ['sovereign_announcements', '010_sovereign_desk_announcements.sql'],
      ['sovereign_chat_messages', '012_sovereign_desk_validation_and_chat.sql']
    ];
    let present = new Set(), roleType = '', checkFailed = false;
    try {
      const [rows] = await pool.execute('SHOW TABLES');
      present = new Set(rows.map(row => Object.values(row)[0]));
      const [columns] = await pool.execute("SHOW COLUMNS FROM admin_users LIKE 'role'");
      roleType = columns[0] ? String(columns[0].Type || '') : '';
    } catch (_) { checkFailed = true; }
    const rows = requirements.map(([name, migration]) => '<tr><td><code>'+esc(name)+'</code></td><td>'+esc(migration)+'</td><td><span class="status '+(checkFailed?'unknown':present.has(name)?'ready':'missing')+'">'+(checkFailed?'Could not verify':present.has(name)?'Found':'Missing')+'</span></td></tr>').join('');
    const roleReady = roleType.includes('sovereign_desk_admin');
    const roleRow = '<tr><td><code>admin_users.role</code></td><td>005_member_dashboard_and_sovereign_desk.sql</td><td><span class="status '+(checkFailed?'unknown':roleReady?'ready':'missing')+'">'+(checkFailed?'Could not verify':roleReady?'Role supported':'Role not confirmed')+'</span></td></tr>';
    const intro = checkFailed ? 'The schema check could not complete. Confirm the application is connected to the intended database and that the database user can inspect its tables.' : 'This page checks the database without changing it. Missing tables or an unsupported administrator role can prevent the workspace from opening.';
    const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+esc(title||'Sovereign Desk setup required')+'</title><style>:root{color-scheme:dark;--gold:#f3cf3c}*{box-sizing:border-box}body{margin:0;padding:20px;background:radial-gradient(circle at top,#252111,#0b0b0c 55%);color:#f7f5ef;font:16px/1.6 system-ui,sans-serif}.wrap{max-width:1000px;margin:10px auto}.brand{color:var(--gold);font-weight:900;letter-spacing:.12em;text-decoration:none}.panel{margin-top:18px;padding:clamp(16px,3vw,32px);border:1px solid #55491e;border-radius:18px;background:#17171cf5}h1{font-size:clamp(1.7rem,5vw,2.4rem);line-height:1.2}h2{font-size:1.1rem;margin-top:24px}code{color:var(--gold);overflow-wrap:anywhere}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:10px;border-bottom:1px solid #39352a;vertical-align:top}.status{display:inline-block;border:1px solid;border-radius:99px;padding:2px 9px;font-size:.8rem;font-weight:800}.ready{color:#a6e3b1;border-color:#326b43}.missing{color:#ffb4a9;border-color:#754138}.unknown{color:#e5d9a1;border-color:#75652e}.notice{margin:18px 0;padding:14px;border:1px solid #75652e;border-radius:12px;background:#28220f}.muted{color:#b8b6c0}.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:22px}.btn{display:inline-block;padding:11px 17px;border-radius:99px;background:var(--gold);color:#111;font-weight:850;text-decoration:none}.secondary{background:#1a1914;color:var(--gold);border:1px solid #66551e}li{margin:8px 0}@media(max-width:600px){body{padding:12px}.panel{padding:14px}th,td{padding:7px 5px;font-size:.86rem}}</style></head><body><main class="wrap"><a class="brand" href="/">MONARCH CODEX</a><section class="panel"><p class="muted">WORKSPACE HEALTH CHECK</p><h1>'+esc(title||'Sovereign Desk setup required')+'</h1><p>'+intro+'</p><div class="notice"><strong>Before changing production:</strong> take a verified full database backup. Do not run a migration twice without inspecting its effects; migration 005 contains an ALTER TABLE statement.</div><h2>Database requirements</h2><div style="overflow-x:auto"><table><thead><tr><th>Table / role</th><th>Migration</th><th>Status</th></tr></thead><tbody>'+rows+roleRow+'</tbody></table></div><h2>Safe recovery order</h2><ol><li>Confirm Hostinger phpMyAdmin is showing the same database configured for the website.</li><li>Back up the database and confirm the export completed.</li><li>Compare the table statuses above with each migration file. Apply only missing changes in dependency order: <code>004_admin_sovereign_desk.sql</code>, required changes from <code>005_member_dashboard_and_sovereign_desk.sql</code>, then <code>010_sovereign_desk_announcements.sql</code>.</li><li>Before migration 005, inspect <code>admin_users.role</code> and its other tables. Do not repeat its ALTER TABLE blindly.</li><li>Restart the Node app and reload this page.</li></ol><p class="muted">Read-only check: no tables, roles, member accounts or financial records are changed here.</p><div class="actions"><a class="btn" href="/sovereign-admin">Recheck Sovereign Desk</a><a class="btn secondary" href="/admin">Return to admin</a></div></section></main></body></html>';
    res.set('Cache-Control', 'no-store, private');
    return res.status(503).send(html);
  };
  const adminOnly = (req, res, next) => {
    if (req.adminRole === 'sovereign_desk_admin' || ['super_admin', 'main_admin'].includes(req.adminRole)) return next();
    return res.status(403).send('This administrator role cannot manage The Sovereign Desk.');
  };
  const deskAdminPage = (req, res, title, active, content) => {
    res.set('Cache-Control', 'no-store');
    const template = fs.readFileSync(path.join(__dirname, 'sovereign-admin.html'), 'utf8');
    const links = [
      ['/sovereign-admin', 'Overview', '◫'],
      ['/sovereign-admin/signals', 'Signals', '↗'],
      ['/sovereign-admin/mentorship', 'Guidance & content', '✦'],
      ['/sovereign-admin/access', 'Desk access', '♙'],
      ['/sovereign-admin/chat', 'Member chat', '◉'],
      ['/sovereign-admin/announcements', 'Announcements', '▤'],
      ['/sovereign-admin/activity', 'Workspace activity', '◷'],
      ['/admin/profile', 'My admin profile', '◎']
    ];
    const nav = links.map(([url, label, symbol]) => {
      const isActive = active === url || (url !== '/sovereign-admin' && active.startsWith(url + '/'));
      return '<a href="' + url + '"' + (isActive ? ' aria-current="page"' : '') + '><span class="nav-icon" aria-hidden="true">' + symbol + '</span><span>' + label + '</span><span class="nav-arrow" aria-hidden="true">↗</span></a>';
    }).join('');
    const adminReturn = ['super_admin', 'main_admin'].includes(req.adminRole)
      ? '<a href="/admin"><span class="nav-icon" aria-hidden="true">⌂</span><span>Main Admin Dashboard</span><span class="nav-arrow" aria-hidden="true">↗</span></a>'
      : '';
    const role = String(req.adminRole || 'sovereign_desk_admin').replace(/_/g, ' ').toUpperCase();
    const replacements = {
      '{{TITLE}}': esc(title),
      '{{ROLE}}': esc(role),
      '{{NAV}}': adminReturn + nav + '<div style="margin-top:18px;padding-top:14px;border-top:1px solid #514322"><form method="post" action="/logout" style="margin:0">' + csrfField(req) + '<button type="submit" style="width:100%;min-height:44px;display:flex;align-items:center;gap:10px;padding:11px 12px;border:1px solid #70443b;border-radius:11px;background:#241614;color:#f0b3a7;font:inherit;font-weight:800;text-align:left;cursor:pointer">↪ <span>Log out securely</span></button></form></div>',
      '{{CONTENT}}': content
    };
    let html = template;
    for (const [key, value] of Object.entries(replacements)) html = html.split(key).join(value);
    return res.send(html);
  };
  const panel = (title, description, inner) => '<section class="ac-panel"><h2>' + title + '</h2>' + (description ? '<p>' + description + '</p>' : '') + inner + '</section>';
  const table = (heads, rows, empty) => '<div class="ac-table-wrap"><table class="ac-table"><thead><tr>' + heads.map(h => '<th>' + h + '</th>').join('') + '</tr></thead><tbody>' + (rows || '<tr><td colspan="' + heads.length + '">' + empty + '</td></tr>') + '</tbody></table></div>';
  const postForm = (req, action, fields, button, extra = '') => '<form method="post" action="' + action + '">' + csrfField(req) + fields + '<button class="btn" type="submit">' + button + '</button>' + extra + '</form>';
  const notice = text => text ? '<div class="ac-alert" role="status">' + esc(text) + '</div>' : '';
  const signalForm = (req, signal = {}) => postForm(req, signal.id ? '/sovereign-admin/signals/' + Number(signal.id) + '/update' : '/sovereign-admin/signals',
    '<label>Instrument</label><input name="asset_pair" maxlength="40" required placeholder="e.g. XAUUSD, EURUSD, BTCUSDT" value="' + esc(signal.asset_pair || '') + '">' +
    '<label>Action</label><select name="direction" required><option value="buy"' + (signal.direction === 'buy' ? ' selected' : '') + '>BUY</option><option value="sell"' + (signal.direction === 'sell' ? ' selected' : '') + '>SELL</option></select>' +
    '<label>Price / entry</label><input name="price" maxlength="100" required placeholder="Enter price or entry zone" value="' + esc(signal.price || signal.entry_zone || '') + '">' +
    '<div class="ac-tiles"><div><label>Take profit (optional)</label><input name="take_profit_1" maxlength="100" value="' + esc(signal.take_profit_1 || '') + '"></div><div><label>Stop loss (optional)</label><input name="stop_loss" maxlength="100" value="' + esc(signal.stop_loss || '') + '"></div></div>' +
    '<label>Signal note (optional)</label><textarea name="explanation" rows="3" maxlength="12000">' + esc(signal.explanation || '') + '</textarea>' +
    '<label>Validation decision</label><select name="validation_status" required><option value="pending"' + (!signal.validation_status || signal.validation_status === 'pending' ? ' selected' : '') + '>Pending — hidden from members</option><option value="valid"' + (signal.validation_status === 'valid' ? ' selected' : '') + '>Valid — approve for members</option><option value="invalid"' + (signal.validation_status === 'invalid' ? ' selected' : '') + '>Invalid — keep hidden</option></select>' +
    '<label>Expiry (optional)</label><input name="expires_at" type="datetime-local" value="' + esc(signal.expires_at ? String(signal.expires_at).replace(' ', 'T').slice(0, 16) : '') + '">',
    signal.id ? 'Save signal changes' : 'Save signal for validation');
  const guidanceForm = (req, item = {}) => postForm(req, item.id ? '/sovereign-admin/mentorship/' + Number(item.id) + '/update' : '/sovereign-admin/mentorship',
    '<label>Mentorship title</label><input name="title" maxlength="180" required value="' + esc(item.title || '') + '">' +
    '<label>Mentorship content</label><textarea name="body" rows="7" maxlength="20000" required>' + esc(item.body || '') + '</textarea>',
    item.id ? 'Save mentorship changes' : 'Save mentorship as draft');

  router.get('/sovereign-admin', requireAdmin, adminOnly, async (req, res, next) => {
    try {
      const [[signals]] = await pool.execute("SELECT COUNT(*) total, SUM(status='published') published FROM sovereign_signals");
      const [[guidance]] = await pool.execute("SELECT COUNT(*) total, SUM(status='published') published FROM sovereign_guidance");
      const [[access]] = await pool.execute("SELECT COUNT(*) total, SUM(status='approved' AND (expires_at IS NULL OR expires_at>NOW())) active FROM sovereign_desk_access");
      const [[requests]] = await pool.execute("SELECT COUNT(*) total, SUM(status='pending') pending FROM sovereign_access_requests");
      const [[announcements]] = await pool.execute("SELECT COUNT(*) total, SUM(status='published') published FROM sovereign_announcements");
      const content = '<div class="ac-overview-hero"><div><p class="ac-hero-kicker">THE SOVEREIGN DESK</p><h2>Your trading education workspace, connected to real records.</h2><p>Publish market analysis, manage mentorship resources, control member access and send workspace announcements. No finance or KYC controls are exposed here.</p></div><span class="ac-hero-mark" aria-hidden="true">⌁</span></div>' +
        '<div class="ac-stats">' +
        [['Published signals',signals.published || 0,'of '+Number(signals.total || 0)+' saved'],['Published mentorship',guidance.published || 0,'of '+Number(guidance.total || 0)+' saved'],['Active access grants',access.active || 0,'approved and not expired'],['Pending access requests',requests.pending || 0,'awaiting review']].map(x=>'<article class="ac-stat"><span>'+x[0]+'</span><strong>'+Number(x[1])+'</strong><small>'+x[2]+'</small></article>').join('') +
        '</div><div class="ac-section-head"><div><h2>Workspace operations</h2><p>Manage each workflow from its dedicated screen.</p></div></div><div class="ac-tiles">' +
        [['/sovereign-admin/signals','Signals','Draft, publish, close and archive analysis.'],['/sovereign-admin/mentorship','Mentorship','Publish learning and mentorship resources.'],['/sovereign-admin/access','Members & access','Review requests, grant access and revoke expired or inappropriate access.'],['/sovereign-admin/chat','Member chat','Reply to members in private conversations with sent and seen receipts.'],['/sovereign-admin/announcements','Announcements','Publish updates and notify desk members.'],['/sovereign-admin/activity','Workspace activity','Recent signals, content and access decisions.']].map(x=>'<a class="ac-tile" href="'+x[0]+'"><span><strong>'+x[1]+'</strong><small>'+x[2]+'</small></span></a>').join('') +
        '</div><section class="ac-panel"><h2>Announcement status</h2><p>'+Number(announcements.published || 0)+' published announcements out of '+Number(announcements.total || 0)+' saved. Announcements are delivered to signed-in members who have active Sovereign Desk access.</p></section>';
      deskAdminPage(req,res,'The Sovereign Desk · Overview','/sovereign-admin',content);
    } catch (e) { dbUnavailable(res,next,e,'Sovereign Desk setup required'); }
  });

  router.get('/sovereign-admin/signals', requireAdmin, adminOnly, async (req,res,next) => {
    try {
      const [rows] = await pool.execute('SELECT id,title,asset_pair,direction,price,entry_zone,stop_loss,take_profit_1,take_profit_2,timeframe,explanation,status,validation_status,published_at,expires_at,created_at FROM sovereign_signals ORDER BY created_at DESC LIMIT 100');
      const tableRows = rows.map(s=>'<tr><td><strong>'+esc(s.asset_pair)+' · '+esc(s.direction.toUpperCase())+'</strong><br><small>Price: '+esc(s.price||s.entry_zone||'—')+'</small><br><small>TP: '+esc(s.take_profit_1||'—')+' · SL: '+esc(s.stop_loss||'—')+'</small></td><td>'+statusLabel(s.validation_status||'pending')+'<br><small>Delivery: '+statusLabel(s.status)+'</small></td><td>'+dateLabel(s.published_at || s.created_at)+'</td><td><div class="ac-actions"><a class="copy-btn" href="/sovereign-admin/signals/'+Number(s.id)+'/edit">Edit / validate</a>'+postForm(req,'/sovereign-admin/signals/'+Number(s.id)+'/status','<select name="status" aria-label="Signal delivery status"><option value="draft">Keep hidden</option><option value="published">Publish (valid only)</option><option value="closed">Close</option><option value="archived">Archive</option></select>','Apply')+'</div></td></tr>').join('');
      const content = panel('Create a signal','Enter the instrument, BUY/SELL action, price and optional take-profit/stop-loss. A signal stays hidden until explicitly marked VALID and published.',signalForm(req)) +
        panel('Saved signals','Signals are stored in the database; publishing timestamps and status are recorded.',table(['Signal','Status','Published / created','Actions'],tableRows,'No signals have been created yet.'));
      deskAdminPage(req,res,'Signals & analysis','/sovereign-admin/signals',notice(req.query.saved ? 'Signal saved.' : req.query.status ? 'Signal status updated.' : '')+content);
    } catch(e){dbUnavailable(res,next,e,'Signals setup required');}
  });

  router.post('/sovereign-admin/signals', requireAdmin, adminOnly, urlencoded, csrfCheck, async(req,res,next)=>{
    const asset=clean(req.body.asset_pair,40), direction=clean(req.body.direction,10), price=clean(req.body.price,100), explanation=clean(req.body.explanation,12000), validation=clean(req.body.validation_status,12);
    const title=(asset+' '+direction.toUpperCase()).slice(0,180);
    if(!asset||!['buy','sell'].includes(direction)||!price||!['pending','valid','invalid'].includes(validation))return res.status(400).send('Instrument, BUY/SELL action, price and validation decision are required.');
    const expiresRaw=clean(req.body.expires_at,30), expires=expiresRaw?expiresRaw.replace('T',' ')+':00':null, publish=validation==='valid';
    try{
      await pool.execute('INSERT INTO sovereign_signals (title,asset_pair,direction,price,entry_zone,stop_loss,take_profit_1,explanation,status,validation_status,published_at,expires_at,created_by,updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [title,asset,direction,price,price,clean(req.body.stop_loss,100)||null,clean(req.body.take_profit_1,100)||null,explanation||'',publish?'published':'draft',validation,publish?new Date():null,expires||null,req.session.memberId,req.session.memberId]);
      res.redirect('/sovereign-admin/signals?saved=1');
    }catch(e){dbUnavailable(res,next,e,'Signals setup required');}
  });

  router.get('/sovereign-admin/signals/:id/edit', requireAdmin, adminOnly, async(req,res,next)=>{
    if(!idOk(req.params.id))return res.status(400).send('Invalid signal id.');
    try{
      const [[s]]=await pool.execute('SELECT * FROM sovereign_signals WHERE id=? LIMIT 1',[req.params.id]);
      if(!s)return res.status(404).send('Signal not found.');
      deskAdminPage(req,res,'Edit signal','/sovereign-admin/signals',panel('Edit signal','Changes are saved as an auditably attributed update.',signalForm(req,s)));
    }catch(e){dbUnavailable(res,next,e,'Signals setup required');}
  });

  router.post('/sovereign-admin/signals/:id/update', requireAdmin, adminOnly, urlencoded, csrfCheck, async(req,res,next)=>{
    if(!idOk(req.params.id))return res.status(400).send('Invalid signal id.');
    const asset=clean(req.body.asset_pair,40),direction=clean(req.body.direction,10),price=clean(req.body.price,100),explanation=clean(req.body.explanation,12000),validation=clean(req.body.validation_status,12),expiresRaw=clean(req.body.expires_at,30),expires=expiresRaw?expiresRaw.replace('T',' ')+':00':null;
    const title=(asset+' '+direction.toUpperCase()).slice(0,180),publish=validation==='valid';
    if(!asset||!['buy','sell'].includes(direction)||!price||!['pending','valid','invalid'].includes(validation))return res.status(400).send('Instrument, BUY/SELL action, price and validation decision are required.');
    try{
      const [result]=await pool.execute('UPDATE sovereign_signals SET title=?,asset_pair=?,direction=?,price=?,entry_zone=?,stop_loss=?,take_profit_1=?,explanation=?,validation_status=?,status=?,published_at=CASE WHEN ?=1 THEN COALESCE(published_at,CURRENT_TIMESTAMP) ELSE NULL END,expires_at=?,updated_by=? WHERE id=?',
      [title,asset,direction,price,price,clean(req.body.stop_loss,100)||null,clean(req.body.take_profit_1,100)||null,explanation||'',validation,publish?'published':'draft',publish?1:0,expires||null,req.session.memberId,req.params.id]);
      if(!result.affectedRows)return res.status(404).send('Signal not found.');
      res.redirect('/sovereign-admin/signals?saved=1');
    }catch(e){dbUnavailable(res,next,e,'Signals setup required');}
  });

  router.post('/sovereign-admin/signals/:id/status', requireAdmin, adminOnly, urlencoded, csrfCheck, async(req,res,next)=>{
    const requested=clean(req.body.status,20);
    if(!idOk(req.params.id)||!['draft','published','closed','archived'].includes(requested))return res.status(400).send('Invalid signal status.');
    try{
      const [[signal]]=await pool.execute('SELECT validation_status FROM sovereign_signals WHERE id=? LIMIT 1',[req.params.id]);
      if(!signal)return res.status(404).send('Signal not found.');
      if(requested==='published'&&signal.validation_status!=='valid')return res.status(409).send('Mark this signal VALID before publishing it to members.');
      const [result]=await pool.execute("UPDATE sovereign_signals SET status=?,published_at=CASE WHEN ?='published' THEN COALESCE(published_at,CURRENT_TIMESTAMP) ELSE published_at END,updated_by=? WHERE id=?",[requested,requested,req.session.memberId,req.params.id]);
      if(!result.affectedRows)return res.status(404).send('Signal not found.');
      res.redirect('/sovereign-admin/signals?status=updated');
    }catch(e){dbUnavailable(res,next,e,'Signals setup required');}
  });

  router.get('/sovereign-admin/guidance', requireAdmin, adminOnly, (req,res) => res.redirect('/sovereign-admin/mentorship'));

  router.get('/sovereign-admin/mentorship', requireAdmin, adminOnly, async(req,res,next)=>{
    try{
      const [rows]=await pool.execute('SELECT id,title,body,status,published_at,created_at FROM sovereign_guidance ORDER BY created_at DESC LIMIT 100');
      const rowHtml=rows.map(g=>'<tr><td><strong>'+esc(g.title)+'</strong><br><small>'+esc(g.body).slice(0,180)+'</small></td><td>'+statusLabel(g.status)+'</td><td>'+dateLabel(g.published_at||g.created_at)+'</td><td><a class="copy-btn" href="/sovereign-admin/mentorship/'+Number(g.id)+'/edit">Edit</a>'+postForm(req,'/sovereign-admin/mentorship/'+Number(g.id)+'/status','<select name="status"><option value="draft">Draft</option><option value="published">Publish</option><option value="archived">Archive</option></select>','Update')+'</td></tr>').join('');
      const content=panel('Create mentorship content','Use this space for lessons, mentorship notes and structured guidance.',guidanceForm(req))+panel('Saved mentorship resources','Published content is visible only to members with active desk access.',table(['Resource','Status','Date','Actions'],rowHtml,'No mentorship content has been created.'));
      deskAdminPage(req,res,'Mentorship & guidance','/sovereign-admin/mentorship',notice(req.query.saved?'Mentorship content saved.':req.query.status?'Status updated':'')+content);
    }catch(e){dbUnavailable(res,next,e,'Mentorship setup required');}
  });

  router.post('/sovereign-admin/mentorship',requireAdmin,adminOnly,urlencoded,csrfCheck,async(req,res,next)=>{
    const title=clean(req.body.title,180),body=clean(req.body.body,20000);
    if(!title||!body)return res.status(400).send('Title and mentorship content are required.');
    try{
      await pool.execute("INSERT INTO sovereign_guidance (title,body,status,created_by,updated_by) VALUES (?,?,'draft',?,?)",[title,body,req.session.memberId,req.session.memberId]);
      res.redirect('/sovereign-admin/mentorship?saved=1');
    }catch(e){dbUnavailable(res,next,e,'Mentorship setup required');}
  });

  router.get('/sovereign-admin/mentorship/:id/edit',requireAdmin,adminOnly,async(req,res,next)=>{
    if(!idOk(req.params.id))return res.status(400).send('Invalid content id.');
    try{const [[g]]=await pool.execute('SELECT * FROM sovereign_guidance WHERE id=? LIMIT 1',[req.params.id]);if(!g)return res.status(404).send('Content not found.');deskAdminPage(req,res,'Edit mentorship','/sovereign-admin/mentorship',panel('Edit mentorship','Update the saved content.',guidanceForm(req,g)));}catch(e){dbUnavailable(res,next,e,'Mentorship setup required');}
  });

  router.post('/sovereign-admin/mentorship/:id/update',requireAdmin,adminOnly,urlencoded,csrfCheck,async(req,res,next)=>{
    if(!idOk(req.params.id))return res.status(400).send('Invalid content id.');
    const title=clean(req.body.title,180),body=clean(req.body.body,20000);
    if(!title||!body)return res.status(400).send('Title and mentorship content are required.');
    try{const [result]=await pool.execute('UPDATE sovereign_guidance SET title=?,body=?,updated_by=? WHERE id=?',[title,body,req.session.memberId,req.params.id]);if(!result.affectedRows)return res.status(404).send('Content not found.');res.redirect('/sovereign-admin/mentorship?saved=1');}catch(e){dbUnavailable(res,next,e,'Mentorship setup required');}
  });

  router.post('/sovereign-admin/mentorship/:id/status',requireAdmin,adminOnly,urlencoded,csrfCheck,async(req,res,next)=>{
    if(!idOk(req.params.id)||!['draft','published','archived'].includes(req.body.status))return res.status(400).send('Invalid content status.');
    try{const [result]=await pool.execute("UPDATE sovereign_guidance SET status=?,published_at=CASE WHEN ?='published' THEN COALESCE(published_at,CURRENT_TIMESTAMP) ELSE published_at END,updated_by=? WHERE id=?",[req.body.status,req.body.status,req.session.memberId,req.params.id]);if(!result.affectedRows)return res.status(404).send('Content not found.');res.redirect('/sovereign-admin/mentorship?status=updated');}catch(e){dbUnavailable(res,next,e,'Mentorship setup required');}
  });

  router.get('/sovereign-admin/access',requireAdmin,adminOnly,async(req,res,next)=>{
    try{
      const [members]=await pool.execute('SELECT m.id,m.monarch_uid,m.full_name,m.email,m.username,a.status,a.reason,a.granted_at,a.expires_at FROM members m LEFT JOIN sovereign_desk_access a ON a.member_id=m.id ORDER BY a.updated_at DESC,m.id DESC LIMIT 200');
      const [requests]=await pool.execute("SELECT r.id,r.member_id,r.reason,r.status,r.created_at,m.full_name,m.email,m.monarch_uid FROM sovereign_access_requests r JOIN members m ON m.id=r.member_id ORDER BY (r.status='pending') DESC,r.created_at DESC LIMIT 150");
      const memberRows=members.map(m=>'<tr><td><strong>'+esc(m.full_name||m.username)+'</strong><br><small>'+esc(m.monarch_uid)+' · '+esc(m.email)+'</small></td><td>'+statusLabel(m.status||'no access')+'</td><td>'+dateLabel(m.expires_at)+'</td><td>'+postForm(req,'/sovereign-admin/access/'+Number(m.id),' <input type="hidden" name="member_id" value="'+Number(m.id)+'"><label>Expiry (optional)</label><input type="datetime-local" name="expires_at" value=""><label>Reason</label><input name="reason" maxlength="1000" placeholder="Access review note"><select name="decision"><option value="approved">Grant / renew access</option><option value="revoked">Revoke access</option></select>','Save access')+'</td></tr>').join('');
      const requestRows=requests.map(r=>'<tr><td><strong>'+esc(r.full_name||r.monarch_uid)+'</strong><br><small>'+esc(r.email)+' · '+esc(r.monarch_uid)+'</small></td><td>'+esc(r.reason)+'</td><td>'+statusLabel(r.status)+'</td><td>'+dateLabel(r.created_at)+'</td><td>'+(r.status==='pending'?postForm(req,'/sovereign-admin/access-requests/'+Number(r.id),' <label>Review note</label><input name="review_reason" maxlength="1000" placeholder="Optional explanation"><select name="decision" required><option value="approved">Approve and grant access</option><option value="rejected">Reject request</option></select>','Review request'):'Reviewed')+'</td></tr>').join('');
      const content=panel('Access requests','Review member requests. Approving a request creates an explicit access grant; no payment is assumed or fabricated.',table(['Member','Request reason','Status','Requested','Review'],requestRows,'No access requests yet.'))+
        panel('Member access control','Grant access only after verifying the membership/subscription arrangement outside this screen. Expiry is optional; access expires automatically when the timestamp passes.',table(['Member','Current access','Expiry','Manage'],memberRows,'No members found.'));
      deskAdminPage(req,res,'Members & access','/sovereign-admin/access',notice(req.query.saved?'Access updated.':req.query.review?'Request reviewed':'')+content);
    }catch(e){dbUnavailable(res,next,e,'Access setup required');}
  });

  router.post('/sovereign-admin/access/:memberId',requireAdmin,adminOnly,urlencoded,csrfCheck,async(req,res,next)=>{
    const memberId=String(req.params.memberId),decision=clean(req.body.decision,20),reason=clean(req.body.reason,1000),expiry=clean(req.body.expires_at,30);
    if(!idOk(memberId)||!['approved','revoked'].includes(decision))return res.status(400).send('Invalid access change.');
    try{
      const [[member]]=await pool.execute('SELECT id FROM members WHERE id=? LIMIT 1',[memberId]);
      if(!member)return res.status(404).send('Member not found.');
      await pool.execute("INSERT INTO sovereign_desk_access (member_id,status,reason,granted_by,expires_at) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE status=VALUES(status),reason=VALUES(reason),granted_by=VALUES(granted_by),granted_at=CASE WHEN VALUES(status)='approved' THEN CURRENT_TIMESTAMP ELSE granted_at END,expires_at=VALUES(expires_at)",[memberId,decision,reason||null,req.session.memberId,decision==='approved'&&expiry?expiry.replace('T',' ')+':00':null]);
      await pool.execute('INSERT INTO admin_audit_log (admin_member_id,action,target_type,target_id,details,ip_address) VALUES (?,?,?,?,?,?)',[req.session.memberId,'sovereign_access.'+decision,'member',memberId,JSON.stringify({reason}),req.ip||null]).catch(()=>{});
      res.redirect('/sovereign-admin/access?saved=1');
    }catch(e){dbUnavailable(res,next,e,'Access setup required');}
  });

  router.post('/sovereign-admin/access-requests/:id',requireAdmin,adminOnly,urlencoded,csrfCheck,async(req,res,next)=>{
    const id=String(req.params.id),decision=clean(req.body.decision,20),reviewReason=clean(req.body.review_reason,1000);
    if(!idOk(id)||!['approved','rejected'].includes(decision))return res.status(400).send('Invalid request decision.');
    const conn=await pool.getConnection();
    try{
      await conn.beginTransaction();
      const [[r]]=await conn.execute('SELECT id,member_id,status FROM sovereign_access_requests WHERE id=? LIMIT 1 FOR UPDATE',[id]);
      if(!r){await conn.rollback();return res.status(404).send('Access request not found.');}
      if(r.status!=='pending'){await conn.rollback();return res.status(409).send('This access request has already been reviewed.');}
      await conn.execute('UPDATE sovereign_access_requests SET status=?,reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP,review_reason=? WHERE id=?',[decision,req.session.memberId,reviewReason||null,id]);
      if(decision==='approved')await conn.execute("INSERT INTO sovereign_desk_access (member_id,status,reason,granted_by) VALUES (?,'approved',?,?) ON DUPLICATE KEY UPDATE status='approved',reason=VALUES(reason),granted_by=VALUES(granted_by),granted_at=CURRENT_TIMESTAMP,expires_at=NULL",[r.member_id,reviewReason||'Access request approved',req.session.memberId]);
      await conn.execute('INSERT INTO admin_audit_log (admin_member_id,action,target_type,target_id,details,ip_address) VALUES (?,?,?,?,?,?)',[req.session.memberId,'sovereign_access_request.'+decision,'access_request',id,JSON.stringify({member_id:r.member_id,review_reason:reviewReason}),req.ip||null]).catch(()=>{});
      await conn.commit();
      await pool.execute('INSERT INTO member_notifications (member_id,notification_type,title,body,target_url,dedupe_key) VALUES (?,?,?,?,?,?)',[r.member_id,'sovereign_access',decision==='approved'?'Sovereign Desk access approved':'Sovereign Desk access request reviewed',decision==='approved'?'Your access to The Sovereign Desk has been approved.':'Your access request was not approved.'+(reviewReason?' Review note: '+reviewReason:''),'/sovereign-desk','sovereign-access-request:'+id+':'+decision]).catch(()=>{});
      res.redirect('/sovereign-admin/access?review=1');
    }catch(e){await conn.rollback();dbUnavailable(res,next,e,'Access setup required');}finally{conn.release();}
  });

  router.get('/sovereign-admin/announcements',requireAdmin,adminOnly,async(req,res,next)=>{
    try{
      const [rows]=await pool.execute('SELECT id,title,body,status,published_at,created_at FROM sovereign_announcements ORDER BY created_at DESC LIMIT 100');
      const rowHtml=rows.map(a=>'<tr><td><strong>'+esc(a.title)+'</strong><br><small>'+esc(a.body).slice(0,180)+'</small></td><td>'+statusLabel(a.status)+'</td><td>'+dateLabel(a.published_at||a.created_at)+'</td><td>'+postForm(req,'/sovereign-admin/announcements/'+Number(a.id)+'/status','<select name="status"><option value="draft">Draft</option><option value="published">Publish & notify</option><option value="archived">Archive</option></select>','Update status')+'</td></tr>').join('');
      const create=postForm(req,'/sovereign-admin/announcements','<label>Announcement title</label><input name="title" maxlength="180" required><label>Announcement message</label><textarea name="body" rows="4" maxlength="6000" required></textarea>','Save announcement as draft');
      deskAdminPage(req,res,'Announcements','/sovereign-admin/announcements',notice(req.query.saved?'Announcement saved.':req.query.status?'Announcement status updated':'')+panel('Create announcement','Publishing sends an in-app notification to members with active desk access.',create)+panel('Saved announcements','Only published announcements appear in the member workspace.',table(['Announcement','Status','Date','Actions'],rowHtml,'No announcements have been created.')));
    }catch(e){dbUnavailable(res,next,e,'Announcements setup required');}
  });

  router.post('/sovereign-admin/announcements',requireAdmin,adminOnly,urlencoded,csrfCheck,async(req,res,next)=>{
    const title=clean(req.body.title,180),body=clean(req.body.body,6000);
    if(!title||!body)return res.status(400).send('Announcement title and message are required.');
    try{await pool.execute("INSERT INTO sovereign_announcements (title,body,status,created_by,updated_by) VALUES (?,?,'draft',?,?)",[title,body,req.session.memberId,req.session.memberId]);res.redirect('/sovereign-admin/announcements?saved=1');}catch(e){dbUnavailable(res,next,e,'Announcements setup required');}
  });

  router.post('/sovereign-admin/announcements/:id/status',requireAdmin,adminOnly,urlencoded,csrfCheck,async(req,res,next)=>{
    const id=String(req.params.id),status=clean(req.body.status,20);
    if(!idOk(id)||!['draft','published','archived'].includes(status))return res.status(400).send('Invalid announcement status.');
    try{
      const conn=await pool.getConnection();
      try{
        await conn.beginTransaction();
        const [[a]]=await conn.execute('SELECT id,title,body,status FROM sovereign_announcements WHERE id=? LIMIT 1 FOR UPDATE',[id]);
        if(!a){await conn.rollback();return res.status(404).send('Announcement not found.');}
        await conn.execute("UPDATE sovereign_announcements SET status=?,published_at=CASE WHEN ?='published' THEN COALESCE(published_at,CURRENT_TIMESTAMP) ELSE published_at END,updated_by=? WHERE id=?",[status,status,req.session.memberId,id]);
        if(status==='published'&&a.status!=='published'){
          await conn.execute("INSERT INTO member_notifications (member_id,notification_type,title,body,target_url,dedupe_key) SELECT a.member_id,'sovereign_announcement',?, ?, '/sovereign-desk/announcements', CONCAT('sovereign-announcement:',? ,':',a.member_id) FROM sovereign_desk_access a WHERE a.status='approved' AND (a.expires_at IS NULL OR a.expires_at>NOW()) ON DUPLICATE KEY UPDATE title=VALUES(title)",
          [a.title,clean(a.body,900),id]);
        }
        await conn.execute('INSERT INTO admin_audit_log (admin_member_id,action,target_type,target_id,details,ip_address) VALUES (?,?,?,?,?,?)',[req.session.memberId,'sovereign_announcement.'+status,'announcement',id,JSON.stringify({status}),req.ip||null]).catch(()=>{});
        await conn.commit();
      }catch(e){await conn.rollback();throw e;}finally{conn.release();}
      res.redirect('/sovereign-admin/announcements?status=updated');
    }catch(e){dbUnavailable(res,next,e,'Announcements setup required');}
  });

  router.get('/sovereign-admin/activity',requireAdmin,adminOnly,async(req,res,next)=>{
    try{
      const [signals]=await pool.execute('SELECT id,title,status,updated_at FROM sovereign_signals ORDER BY updated_at DESC LIMIT 20');
      const [guidance]=await pool.execute('SELECT id,title,status,updated_at FROM sovereign_guidance ORDER BY updated_at DESC LIMIT 20');
      const [access]=await pool.execute('SELECT a.member_id,a.status,a.updated_at,m.full_name,m.monarch_uid FROM sovereign_desk_access a JOIN members m ON m.id=a.member_id ORDER BY a.updated_at DESC LIMIT 30');
      const rows=[...signals.map(x=>({kind:'Signal',name:x.title,status:x.status,at:x.updated_at})),...guidance.map(x=>({kind:'Mentorship',name:x.title,status:x.status,at:x.updated_at})),...access.map(x=>({kind:'Member access',name:(x.full_name||x.monarch_uid)+' · '+x.monarch_uid,status:x.status,at:x.updated_at}))].sort((a,b)=>new Date(b.at)-new Date(a.at)).slice(0,60);
      deskAdminPage(req,res,'Workspace activity','/sovereign-admin/activity',panel('Recent activity','Latest saved content and member access records. This is a workspace activity view, not a substitute for the platform-wide security audit log.',table(['Area','Record','Status','Updated'],rows.map(x=>'<tr><td>'+x.kind+'</td><td>'+esc(x.name)+'</td><td>'+statusLabel(x.status)+'</td><td>'+dateLabel(x.at)+'</td></tr>').join(''),'No workspace activity yet.')));
    }catch(e){dbUnavailable(res,next,e,'Activity setup required');}
  });

  // Desk inbox: each member has a private conversation with the Sovereign Desk.
  router.get('/sovereign-admin/chat', requireAdmin, adminOnly, async(req,res,next)=>{
    try{
      const [rows]=await pool.execute("SELECT m.member_id,mem.full_name,mem.username,MAX(m.created_at) last_message,SUM(CASE WHEN m.sender_role='member' AND m.seen_at IS NULL THEN 1 ELSE 0 END) unread, SUBSTRING_INDEX(GROUP_CONCAT(m.body ORDER BY m.id DESC SEPARATOR '\\n'), '\\n', 1) preview FROM sovereign_chat_messages m JOIN members mem ON mem.id=m.member_id GROUP BY m.member_id,mem.full_name,mem.username ORDER BY MAX(m.created_at) DESC LIMIT 200");
      const items=rows.map(x=>'<a class="sd-inbox-row" href="/sovereign-admin/chat/'+Number(x.member_id)+'"><span class="sd-inbox-avatar">'+esc(String(x.full_name||x.username||'M').slice(0,1).toUpperCase())+'</span><span class="sd-inbox-copy"><strong>'+esc(x.full_name||x.username||'Member')+'</strong><small>@'+esc(x.username||'member')+' · '+dateLabel(x.last_message)+'</small><span>'+esc(x.preview||'New conversation')+'</span></span>'+(Number(x.unread)>0?'<b class="sd-unread">'+Number(x.unread)+'</b>':'')+'</a>').join('');
      const content='<style>.sd-inbox{display:grid;gap:9px}.sd-inbox-row{display:flex;align-items:center;gap:12px;padding:14px;border:1px solid #383328;border-radius:15px;background:linear-gradient(120deg,#1b1914,#111113);text-decoration:none;color:#f4ead0}.sd-inbox-avatar{display:grid;place-items:center;width:43px;height:43px;flex:0 0 43px;border-radius:50%;background:linear-gradient(135deg,#f4d77d,#a87d24);color:#19150b;font-weight:950}.sd-inbox-copy{display:grid;gap:4px;min-width:0;flex:1}.sd-inbox-copy small,.sd-inbox-copy span{color:#aaa69b;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sd-unread{display:grid;place-items:center;min-width:23px;height:23px;padding:0 6px;border-radius:99px;background:#e5c46a;color:#17130a;font-size:11px}</style><section class="ac-panel"><div class="ac-page-head"><div><h2>Member conversations</h2><p class="muted">Private one-to-one conversations with members. Opening a thread marks their messages as seen by the Desk.</p></div></div><div class="sd-inbox">'+(items||'<p class="muted">No member messages yet. Conversations will appear here when a member writes to the Desk.</p>')+'</div></section>';
      deskAdminPage(req,res,'Sovereign Desk · Chat','/sovereign-admin/chat',content);
    }catch(e){dbUnavailable(res,next,e,'Sovereign Desk chat setup required');}
  });
  router.get('/sovereign-admin/chat/:memberId', requireAdmin, adminOnly, async(req,res,next)=>{
    if(!idOk(req.params.memberId))return res.status(400).send('Invalid member id.');
    try{
      const [[member]]=await pool.execute('SELECT id,full_name,username,monarch_uid FROM members WHERE id=? LIMIT 1',[req.params.memberId]);
      if(!member)return res.status(404).send('Member not found.');
      await pool.execute("UPDATE sovereign_chat_messages SET seen_at=CURRENT_TIMESTAMP WHERE member_id=? AND sender_role='member' AND seen_at IS NULL",[member.id]);
      const [messages]=await pool.execute('SELECT id,sender_role,body,created_at,seen_at FROM sovereign_chat_messages WHERE member_id=? ORDER BY id ASC LIMIT 500',[member.id]);
      const bubbles=messages.map(x=>'<div class="sd-chat-line '+(x.sender_role==='desk'?'from-desk':'from-member')+'"><div class="sd-chat-bubble">'+esc(x.body).replace(/\n/g,'<br>')+'<small>'+dateLabel(x.created_at)+(x.sender_role==='desk'?' · '+(x.seen_at?'Seen ✓✓':'Sent ✓'):'')+'</small></div></div>').join('');
      const form=postForm(req,'/sovereign-admin/chat/'+Number(member.id),' <label>Reply to '+esc(member.full_name||member.username)+'</label><textarea name="body" rows="3" maxlength="4000" required placeholder="Write a helpful reply…"></textarea>','Send reply');
      const content='<style>.sd-chat-shell{display:grid;gap:14px}.sd-chat-toolbar{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}.sd-chat-log{display:flex;flex-direction:column;gap:10px;min-height:220px;max-height:58vh;overflow:auto;padding:16px;border:1px solid #393326;border-radius:16px;background:radial-gradient(ellipse at top,#292316,#101012 70%)}.sd-chat-line{display:flex}.sd-chat-line.from-desk{justify-content:flex-end}.sd-chat-bubble{max-width:min(82%,560px);padding:11px 14px;border:1px solid #39352b;border-radius:15px 15px 15px 4px;background:#202024;color:#eee9dc;line-height:1.65;overflow-wrap:anywhere}.from-desk .sd-chat-bubble{border-color:#6e5b2a;border-radius:15px 15px 4px 15px;background:linear-gradient(135deg,#342a12,#211d14)}.sd-chat-bubble small{display:block;margin-top:5px;color:#b8ad8b;font-size:10px;text-align:right}.sd-chat-shell form{padding:14px;border:1px solid #393326;border-radius:15px;background:#151518}.sd-chat-shell textarea{width:100%;box-sizing:border-box;padding:12px;border:1px solid #403a2d;border-radius:12px;background:#0d0d0f;color:#fff;font:inherit}.sd-chat-shell form .btn{margin-top:10px}@media(max-width:560px){.sd-chat-log{padding:10px;max-height:56vh}.sd-chat-bubble{max-width:92%}}</style><section class="ac-panel sd-chat-shell"><div class="sd-chat-toolbar"><div><h2>'+esc(member.full_name||member.username||'Member')+'</h2><p class="muted">'+esc(member.monarch_uid||'')+' · Private Desk conversation</p></div><a class="copy-btn" href="/sovereign-admin/chat">← All chats</a></div><div class="sd-chat-log">'+(bubbles||'<p class="muted">This conversation is ready. Send the first message below.</p>')+'</div>'+form+'</section>';
      deskAdminPage(req,res,'Chat · '+(member.full_name||member.username),'/sovereign-admin/chat',content);
    }catch(e){dbUnavailable(res,next,e,'Sovereign Desk chat setup required');}
  });
  router.post('/sovereign-admin/chat/:memberId', requireAdmin, adminOnly, urlencoded, csrfCheck, async(req,res,next)=>{
    if(!idOk(req.params.memberId))return res.status(400).send('Invalid member id.');
    const body=clean(req.body.body,4000);
    if(!body)return res.redirect('/sovereign-admin/chat/'+req.params.memberId);
    try{
      const [[member]]=await pool.execute('SELECT id FROM members WHERE id=? LIMIT 1',[req.params.memberId]);
      if(!member)return res.status(404).send('Member not found.');
      await pool.execute("INSERT INTO sovereign_chat_messages (member_id,sender_role,sender_member_id,body) VALUES (?,'desk',?,?)",[member.id,req.session.memberId,body]);
      res.redirect('/sovereign-admin/chat/'+Number(member.id)+'?sent=1');
    }catch(e){dbUnavailable(res,next,e,'Sovereign Desk chat setup required');}
  });

  const memberNav = (active) => '<nav class="sd-member-nav" aria-label="Sovereign Desk navigation">'+[['/sovereign-desk','Overview'],['/sovereign-desk/signals','Signals'],['/sovereign-desk/mentorship','Mentorship'],['/sovereign-desk/access','Access'],['/sovereign-desk/announcements','Announcements'],['/sovereign-desk/chat','Desk chat']].map(([u,t])=>'<a href="'+u+'"'+(active===u?' aria-current="page"':'')+'>'+t+'</a>').join('')+'</nav>';
  const memberStyles = '<style>.sd-member{display:grid;gap:17px;color:#eee9dc}.sd-member-hero{padding:clamp(20px,4vw,34px);border:1px solid #5b4a23;border-radius:20px;background:radial-gradient(ellipse at 90% 0,#d7b95722,transparent 42%),linear-gradient(135deg,#1c1a15,#111113)}.sd-member-hero .kicker{color:#dfbd62;font-size:10px;font-weight:900;letter-spacing:.16em}.sd-member-hero h2{margin:8px 0;color:#fff6df;font-size:clamp(24px,4vw,34px);letter-spacing:-.04em}.sd-member-hero p,.sd-member p{color:#aaa69b;line-height:1.75;font-size:13px}.sd-member-nav{display:flex;gap:8px;flex-wrap:wrap}.sd-member-nav a{padding:10px 13px;border:1px solid #383328;border-radius:11px;color:#cfc7b2;text-decoration:none;font-size:12px;font-weight:800}.sd-member-nav a[aria-current=page],.sd-member-nav a:hover{border-color:#8b7337;background:#241f12;color:#f1d77e}.sd-member-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.sd-member-card{min-width:0;padding:18px;border:1px solid #383328;border-radius:15px;background:linear-gradient(145deg,#19191a,#111113)}.sd-member-card h3{margin:0 0 8px;color:#f4e8bd;font-size:16px}.sd-member-card p{margin:6px 0}.sd-member-list{display:grid;gap:12px}.sd-member-item{padding:17px;border:1px solid #343025;border-radius:14px;background:#121214}.sd-member-item h3{margin:0 0 8px;color:#f0d681}.sd-member-item p{white-space:pre-wrap;overflow-wrap:anywhere}.sd-member-tag{display:inline-block;padding:6px 9px;border:1px solid #574a27;border-radius:99px;color:#e5cb7e;font-size:10px;font-weight:850}.sd-member form label{display:block;margin:12px 0 6px;color:#d9d0bb;font-size:12px;font-weight:750}.sd-member form input,.sd-member form textarea{width:100%;box-sizing:border-box;padding:12px;border:1px solid #403a2d;border-radius:10px;background:#0d0d0f;color:#fff;font:inherit}.sd-member form textarea{min-height:95px}.sd-member .btn{width:auto;margin-top:12px}@media(max-width:560px){.sd-member-grid{grid-template-columns:1fr}.sd-member-nav{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}.sd-member-nav a{text-align:center}.sd-member-nav a:first-child{grid-column:1/-1}}@media(prefers-reduced-motion:reduce){.sd-member *{transition:none!important}}</style>';
  const renderMember = (req,res,m,title,active,body) => {
    res.set('Cache-Control','no-store');
    res.send(memberPage(title,active,m,memberStyles+'<div class="sd-member">'+memberNav(active)+body+'</div>',req));
  };
  async function memberAccess(memberId) {
    const [[row]] = await pool.execute("SELECT status,expires_at FROM sovereign_desk_access WHERE member_id=? LIMIT 1",[memberId]);
    return Boolean(row && row.status==='approved' && (!row.expires_at || new Date(row.expires_at).getTime()>Date.now()));
  }
  function noAccessContent(m) {
    return '<section class="sd-member-hero"><span class="kicker">THE SOVEREIGN DESK</span><h2>Your private trading workspace.</h2><p>Signals, mentorship and announcements are available to members with an active access grant.</p></section><section class="sd-member-card"><h3>Access is not active yet</h3><p>Submit an access request for the team to review. An administrator must approve it before private content becomes visible.</p><a class="btn" href="/sovereign-desk/access">Request access</a></section>';
  }
  router.get('/sovereign-desk',requireAuth,requireApprovedKyc,async(req,res,next)=>{
    try{
      const m=await getMemberForPage(req,res);if(!m)return;
      const active=await memberAccess(m.id);
      if(!active)return renderMember(req,res,m,'The Sovereign Desk','/sovereign-desk',noAccessContent(m));
      const [[signals]]=await pool.execute("SELECT COUNT(*) total FROM sovereign_signals WHERE status='published' AND (expires_at IS NULL OR expires_at>NOW())");
      const [[mentorship]]=await pool.execute("SELECT COUNT(*) total FROM sovereign_guidance WHERE status='published'");
      const [[announcements]]=await pool.execute("SELECT COUNT(*) total FROM sovereign_announcements WHERE status='published'");
      const body='<section class="sd-member-hero"><span class="kicker">PRIVATE MEMBER WORKSPACE</span><h2>Welcome to The Sovereign Desk.</h2><p>Access your published analysis, mentorship library and announcements from one focused workspace. Trading analysis is educational and is not a guarantee of results.</p></section><div class="sd-member-grid"><article class="sd-member-card"><h3>Published signals</h3><p><strong>'+Number(signals.total||0)+'</strong> active signals</p><a href="/sovereign-desk/signals">Explore signals ↗</a></article><article class="sd-member-card"><h3>Mentorship library</h3><p><strong>'+Number(mentorship.total||0)+'</strong> resources</p><a href="/sovereign-desk/mentorship">Open mentorship ↗</a></article><article class="sd-member-card"><h3>Announcements</h3><p><strong>'+Number(announcements.total||0)+'</strong> published updates</p><a href="/sovereign-desk/announcements">Read updates ↗</a></article><article class="sd-member-card"><h3>Access status</h3><p>Your access is active. Access may be revoked or expire based on your membership arrangement.</p><a href="/sovereign-desk/access">View access details ↗</a></article></div>';
      renderMember(req,res,m,'The Sovereign Desk','/sovereign-desk',body);
    }catch(e){if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).send('The Sovereign Desk is being configured. Please try again later.');next(e);}
  });
  router.get('/sovereign-desk/signals',requireAuth,requireApprovedKyc,async(req,res,next)=>{
    try{const m=await getMemberForPage(req,res);if(!m)return;if(!await memberAccess(m.id))return renderMember(req,res,m,'Desk signals','/sovereign-desk/signals',noAccessContent(m));
      const [rows]=await pool.execute("SELECT title,asset_pair,direction,price,entry_zone,stop_loss,take_profit_1,take_profit_2,timeframe,explanation,published_at,expires_at FROM sovereign_signals WHERE status='published' AND validation_status='valid' AND (expires_at IS NULL OR expires_at>NOW()) ORDER BY published_at DESC,id DESC LIMIT 100");
      const content='<section class="sd-member-hero"><span class="kicker">MARKET ANALYSIS</span><h2>Signals & market notes</h2><p>Published analysis from The Sovereign Desk. Use your own risk controls and independent judgment.</p></section><div class="sd-member-list">'+(rows.map(s=>'<article class="sd-member-item"><span class="sd-member-tag">'+esc(s.direction.toUpperCase())+' · '+esc(s.asset_pair)+'</span><h3>'+esc(s.title)+'</h3><p>'+esc(s.explanation)+'</p><div class="sd-member-grid"><div><small>Entry zone</small><p>'+esc(s.entry_zone||'Not specified')+'</p></div><div><small>Timeframe</small><p>'+esc(s.timeframe||'Not specified')+'</p></div><div><small>Stop loss</small><p>'+esc(s.stop_loss||'Not specified')+'</p></div><div><small>Targets</small><p>'+(s.take_profit_1?esc(s.take_profit_1):'—')+(s.take_profit_2?' / '+esc(s.take_profit_2):'')+'</p></div></div><small>Published '+dateLabel(s.published_at)+' · Expires '+dateLabel(s.expires_at)+'</small></article>').join('')||'<article class="sd-member-card"><h3>No published signals yet</h3><p>New signals will appear here after the desk team publishes them.</p></article>')+'</div>';
      renderMember(req,res,m,'Signals','/sovereign-desk/signals',content);
    }catch(e){if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).send('The Sovereign Desk is being configured. Please try again later.');next(e);}
  });
  router.get('/sovereign-desk/mentorship',requireAuth,requireApprovedKyc,async(req,res,next)=>{
    try{const m=await getMemberForPage(req,res);if(!m)return;if(!await memberAccess(m.id))return renderMember(req,res,m,'Mentorship','/sovereign-desk/mentorship',noAccessContent(m));
      const [rows]=await pool.execute("SELECT title,body,published_at FROM sovereign_guidance WHERE status='published' ORDER BY published_at DESC,id DESC LIMIT 100");
      const content='<section class="sd-member-hero"><span class="kicker">LEARNING & GUIDANCE</span><h2>Mentorship library</h2><p>Practical education and desk guidance for your continued learning.</p></section><div class="sd-member-list">'+(rows.map(g=>'<article class="sd-member-item"><h3>'+esc(g.title)+'</h3><p>'+esc(g.body)+'</p><small>Published '+dateLabel(g.published_at)+'</small></article>').join('')||'<article class="sd-member-card"><h3>No mentorship resources yet</h3><p>Published lessons and guidance will appear here.</p></article>')+'</div>';
      renderMember(req,res,m,'Mentorship','/sovereign-desk/mentorship',content);
    }catch(e){if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).send('The Sovereign Desk is being configured. Please try again later.');next(e);}
  });
  router.get('/sovereign-desk/announcements',requireAuth,requireApprovedKyc,async(req,res,next)=>{
    try{const m=await getMemberForPage(req,res);if(!m)return;if(!await memberAccess(m.id))return renderMember(req,res,m,'Announcements','/sovereign-desk/announcements',noAccessContent(m));
      const [rows]=await pool.execute("SELECT title,body,published_at FROM sovereign_announcements WHERE status='published' ORDER BY published_at DESC,id DESC LIMIT 100");
      const content='<section class="sd-member-hero"><span class="kicker">DESK UPDATES</span><h2>Announcements</h2><p>Important updates from The Sovereign Desk.</p></section><div class="sd-member-list">'+(rows.map(a=>'<article class="sd-member-item"><h3>'+esc(a.title)+'</h3><p>'+esc(a.body)+'</p><small>Published '+dateLabel(a.published_at)+'</small></article>').join('')||'<article class="sd-member-card"><h3>No announcements yet</h3><p>New desk announcements will appear here.</p></article>')+'</div>';
      renderMember(req,res,m,'Announcements','/sovereign-desk/announcements',content);
    }catch(e){if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).send('The Sovereign Desk is being configured. Please try again later.');next(e);}
  });
  router.get('/sovereign-desk/access',requireAuth,requireApprovedKyc,async(req,res,next)=>{
    try{
      const m=await getMemberForPage(req,res);if(!m)return;
      const [grants]=await pool.execute('SELECT status,reason,granted_at,expires_at FROM sovereign_desk_access WHERE member_id=? LIMIT 1',[m.id]);
      const [requests]=await pool.execute('SELECT id,status,reason,review_reason,created_at,reviewed_at FROM sovereign_access_requests WHERE member_id=? ORDER BY created_at DESC LIMIT 20',[m.id]);
      const active=await memberAccess(m.id);
      const grant=grants[0];
      const requestForm=postForm(req,'/sovereign-desk/access/request','<label>Why are you requesting access?</label><textarea name="reason" maxlength="1000" required placeholder="Tell the team briefly about your request"></textarea>','Submit access request');
      const history=requests.map(r=>'<article class="sd-member-item"><span class="sd-member-tag">'+statusLabel(r.status)+'</span><p>'+esc(r.reason)+'</p><small>Submitted '+dateLabel(r.created_at)+(r.reviewed_at?' · Reviewed '+dateLabel(r.reviewed_at):'')+'</small>'+(r.review_reason?'<p>Review note: '+esc(r.review_reason)+'</p>':'')+'</article>').join('');
      const body='<section class="sd-member-hero"><span class="kicker">MEMBERSHIP & ACCESS</span><h2>Desk access</h2><p>Access is granted by the desk team after the membership arrangement is checked. Submitting a request does not confirm payment or guarantee approval.</p></section><article class="sd-member-card"><h3>'+ (active?'Access active':'Access not active')+'</h3><p>Status: '+statusLabel(grant&&grant.status||'not granted')+'</p><p>Expiry: '+dateLabel(grant&&grant.expires_at)+'</p>'+(grant&&grant.reason?'<p>Note: '+esc(grant.reason)+'</p>':'')+(!active?requestForm:'')+'</article><section><h3>Request history</h3><div class="sd-member-list">'+(history||'<p>No access requests submitted yet.</p>')+'</div></section>';
      renderMember(req,res,m,'Desk access','/sovereign-desk/access',body);
    }catch(e){if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).send('The Sovereign Desk access workflow is not configured yet.');next(e);}
  });
  router.post('/sovereign-desk/access/request',requireAuth,requireApprovedKyc,urlencoded,csrfCheck,async(req,res,next)=>{
    const reason=clean(req.body.reason,1000);
    if(!reason)return res.status(400).send('Please explain why you are requesting access.');
    try{
      const active=await memberAccess(req.session.memberId);
      if(active)return res.redirect('/sovereign-desk/access');
      const [[pending]]=await pool.execute("SELECT id FROM sovereign_access_requests WHERE member_id=? AND status='pending' LIMIT 1",[req.session.memberId]);
      if(pending)return res.redirect('/sovereign-desk/access?pending=1');
      await pool.execute("INSERT INTO sovereign_access_requests (member_id,requested_by,status,reason) VALUES (?,?,'pending',?)",[req.session.memberId,req.session.memberId,reason]);
      res.redirect('/sovereign-desk/access?requested=1');
    }catch(e){if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).send('The Sovereign Desk access workflow is not configured yet.');next(e);}
  });

  router.get('/sovereign-desk/chat',requireAuth,requireApprovedKyc,async(req,res,next)=>{
    try{
      const m=await getMemberForPage(req,res);if(!m)return;
      await pool.execute("UPDATE sovereign_chat_messages SET seen_at=CURRENT_TIMESTAMP WHERE member_id=? AND sender_role='desk' AND seen_at IS NULL",[m.id]);
      const [messages]=await pool.execute('SELECT id,sender_role,body,created_at,seen_at FROM sovereign_chat_messages WHERE member_id=? ORDER BY id ASC LIMIT 500',[m.id]);
      const bubbles=messages.map(x=>'<div class="sd-chat-line '+(x.sender_role==='member'?'from-member':'from-desk')+'"><div class="sd-chat-bubble">'+esc(x.body).replace(/\n/g,'<br>')+'<small>'+dateLabel(x.created_at)+(x.sender_role==='member'?' · '+(x.seen_at?'Seen ✓✓':'Sent ✓'):'')+'</small></div></div>').join('');
      const form=postForm(req,'/sovereign-desk/chat','<label>Message the Sovereign Desk</label><textarea name="body" rows="3" maxlength="4000" required placeholder="Ask a question or send a message…"></textarea>','Send message');
      const body='<section class="sd-member-hero"><span class="kicker">PRIVATE MESSAGES</span><h2>Chat with Sovereign Desk</h2><p>Message the Desk team directly. ✓ Sent · ✓✓ Seen when the team opens your message.</p></section><style>.sd-chat-shell{display:grid;gap:14px}.sd-chat-log{display:flex;flex-direction:column;gap:10px;min-height:220px;max-height:55vh;overflow:auto;padding:14px;border:1px solid #393326;border-radius:16px;background:radial-gradient(ellipse at top,#292316,#101012 70%)}.sd-chat-line{display:flex}.sd-chat-line.from-member{justify-content:flex-end}.sd-chat-bubble{max-width:min(85%,560px);padding:11px 14px;border:1px solid #39352b;border-radius:15px 15px 15px 4px;background:#202024;color:#eee9dc;line-height:1.65;overflow-wrap:anywhere}.from-member .sd-chat-bubble{border-color:#6e5b2a;border-radius:15px 15px 4px 15px;background:linear-gradient(135deg,#342a12,#211d14)}.sd-chat-bubble small{display:block;margin-top:5px;color:#b8ad8b;font-size:10px;text-align:right}.sd-chat-shell form{padding:14px;border:1px solid #393326;border-radius:15px;background:#151518}.sd-chat-shell textarea{width:100%;box-sizing:border-box;padding:12px;border:1px solid #403a2d;border-radius:12px;background:#0d0d0f;color:#fff;font:inherit}.sd-chat-shell form .btn{margin-top:10px}@media(max-width:560px){.sd-chat-log{padding:10px}.sd-chat-bubble{max-width:93%}}</style><section class="sd-chat-shell"><div class="sd-chat-log">'+(bubbles||'<p class="muted">Welcome. Send your first message to start a private conversation with the Desk.</p>')+'</div>'+form+'</section>';
      renderMember(req,res,m,'Chat with Sovereign Desk','/sovereign-desk/chat',body);
    }catch(e){if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).send('Sovereign Desk chat is being configured. Please try again later.');next(e);}
  });
  router.post('/sovereign-desk/chat',requireAuth,requireApprovedKyc,urlencoded,csrfCheck,async(req,res,next)=>{
    const body=clean(req.body.body,4000);
    if(!body)return res.redirect('/sovereign-desk/chat');
    try{
      await pool.execute("INSERT INTO sovereign_chat_messages (member_id,sender_role,sender_member_id,body) VALUES (?,'member',?,?)",[req.session.memberId,req.session.memberId,body]);
      res.redirect('/sovereign-desk/chat?sent=1');
    }catch(e){if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).send('Sovereign Desk chat is being configured. Please try again later.');next(e);}
  });

  return router;
}

module.exports = createSovereignDeskRouter;
