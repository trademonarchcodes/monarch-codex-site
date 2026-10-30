'use strict';

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

module.exports = function createNetworkRouter({ pool, requireAuth, requireAdmin, csrfCheck, csrfField, memberPage, adminControlPage, esc }) {
  const router = express.Router();
  const founderEmail = 'trademonarchofficial@gmail.com';
  const safe = value => esc(String(value == null ? '' : value));
  const monthStart = () => new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const monthKey = () => {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  };
  const publicBase = 'https://monarchcodex.online';

  async function founderId() {
    const [[founder]] = await pool.execute(
      "SELECT m.id FROM members m LEFT JOIN admin_users a ON a.member_id=m.id AND a.is_active=1 WHERE LOWER(m.email)=LOWER(?) ORDER BY a.role='super_admin' DESC LIMIT 1",
      [founderEmail]
    );
    if (founder) return Number(founder.id);
    const [[fallback]] = await pool.query("SELECT member_id AS id FROM admin_users WHERE is_active=1 AND role IN ('super_admin','main_admin') ORDER BY FIELD(role,'super_admin','main_admin') LIMIT 1");
    return fallback ? Number(fallback.id) : null;
  }

  async function publicTree() {
    const rootId = await founderId();
    if (!rootId) return null;
    const [rows] = await pool.execute(`
      WITH RECURSIVE visible_network AS (
        SELECT m.id,m.referred_by,root_rel.sponsor_member_id AS original_sponsor_id,m.monarch_uid,m.full_name,m.username,m.created_at,m.id AS root_id,
               COALESCE(NULLIF(p.nickname,''),m.full_name,m.username) AS display_name,
               p.bio,mp.avatar_key,0 AS depth,CAST(CONCAT('/',m.id,'/') AS CHAR(4000)) AS path
        FROM members m
        LEFT JOIN monarch_public_profiles p ON p.member_id=m.id
        LEFT JOIN member_profiles mp ON mp.member_id=m.id
        LEFT JOIN monarch_referral_relationships root_rel ON root_rel.member_id=m.id
        WHERE m.id=? AND COALESCE(m.is_blocked,0)=0
        UNION ALL
        SELECT c.id,c.referred_by,rr.sponsor_member_id AS original_sponsor_id,c.monarch_uid,c.full_name,c.username,c.created_at,n.root_id,
               COALESCE(NULLIF(p.nickname,''),c.full_name,c.username) AS display_name,
               p.bio,mp.avatar_key,n.depth+1,
               CONCAT(n.path,c.id,'/')
        FROM members c
        JOIN monarch_referral_relationships rr ON rr.member_id=c.id
        JOIN visible_network n ON (rr.sponsor_member_id=n.id OR (n.id=n.root_id AND rr.sponsor_member_id IS NULL))
        JOIN monarch_public_profiles p ON p.member_id=c.id
        LEFT JOIN member_profiles mp ON mp.member_id=c.id
        WHERE p.approved=1 AND p.visible=1 AND p.requested=1
          AND p.profile_status='published'
          AND COALESCE(c.is_blocked,0)=0
          AND n.depth<30
          AND LOCATE(CONCAT('/',c.id,'/'),n.path)=0
      )
      SELECT n.id,n.referred_by,n.original_sponsor_id,n.monarch_uid,n.username,n.display_name,n.bio,n.avatar_key,n.created_at,n.depth,
             CASE WHEN a.member_id IS NOT NULL THEN 'Founder' ELSE 'Member' END AS account_type,
             GROUP_CONCAT(DISTINCT rc.role_name ORDER BY rc.role_name SEPARATOR '||') AS roles,
             (SELECT COUNT(*) FROM monarch_referral_relationships ch WHERE ch.sponsor_member_id=n.id) AS direct_registered,
             (SELECT COUNT(*) FROM visible_network d WHERE d.path LIKE CONCAT(n.path,'%') AND d.id<>n.id) AS published_descendants
      FROM visible_network n
      LEFT JOIN admin_users a ON a.member_id=n.id AND a.is_active=1
      LEFT JOIN member_role_assignments ra ON ra.member_id=n.id
      LEFT JOIN member_role_catalog rc ON rc.id=ra.role_id AND rc.is_active=1
      GROUP BY n.id,n.referred_by,n.original_sponsor_id,n.monarch_uid,n.username,n.display_name,n.bio,n.avatar_key,n.created_at,n.depth,n.path,a.member_id
      ORDER BY n.depth,n.display_name
    `, [rootId]);
    return { rootId, rows };
  }

  function buildTree(rows) {
    const byId = new Map();
    for (const row of rows) byId.set(Number(row.id), {
      id:Number(row.id), sponsorId:Number(row.depth)===0?null:(row.original_sponsor_id==null?Number(rows[0]?.id):Number(row.original_sponsor_id)),
      username:row.username || '', name:row.display_name || 'Monarch member',
      monarchId:row.monarch_uid || '', bio:row.bio || '',
      avatarUrl:row.avatar_key && /^[a-f0-9]{48}\.(jpg|png|webp)$/.test(row.avatar_key) ? '/member-avatar/'+encodeURIComponent(row.avatar_key) : '',
      roles:String(row.roles || '').split('||').filter(Boolean),
      accountType:row.account_type, depth:Number(row.depth),
      directRegistered:Number(row.direct_registered || 0),
      publishedDescendants:Number(row.published_descendants || 0),
      children:[]
    });
    let root = null;
    for (const node of byId.values()) {
      if (node.sponsorId && byId.has(node.sponsorId)) byId.get(node.sponsorId).children.push(node);
      else if (node.id === (rows[0] ? Number(rows[0].id) : -1)) root = node;
    }
    if (!root && rows.length) root = byId.get(Number(rows.find(r => Number(r.depth) === 0)?.id));
    const sort = node => { node.children.sort((a,b)=>a.name.localeCompare(b.name)); node.children.forEach(sort); };
    if (root) sort(root);
    return root;
  }

  async function leaderboard(mode, period) {
    const rootId = await founderId();
    if (!rootId) return [];
    const start = mode === 'monthly' ? (period && /^\d{4}-\d{2}$/.test(period) ? new Date(Number(period.slice(0,4)),Number(period.slice(5,7))-1,1) : monthStart()) : null;
    const end = start ? new Date(start.getFullYear(),start.getMonth()+1,1) : null;
    const timeClause = start ? ' AND child.joined_at >= ? AND child.joined_at < ?' : '';
    const [rows] = await pool.execute(`
      WITH RECURSIVE reachable AS (
        SELECT m.id,m.referred_by,m.id AS root_id,0 AS depth,CAST(CONCAT('/',m.id,'/') AS CHAR(4000)) AS path
        FROM members m WHERE m.id=?
        UNION ALL
        SELECT c.id,c.referred_by,r.root_id,r.depth+1,CONCAT(r.path,c.id,'/')
        FROM members c JOIN monarch_referral_relationships rr ON rr.member_id=c.id JOIN reachable r ON (rr.sponsor_member_id=r.id OR (r.id=r.root_id AND rr.sponsor_member_id IS NULL))
        JOIN monarch_public_profiles cp ON cp.member_id=c.id AND cp.approved=1 AND cp.visible=1 AND cp.requested=1 AND cp.profile_status='published'
        WHERE r.depth<30 AND LOCATE(CONCAT('/',c.id,'/'),r.path)=0
      )
      SELECT m.id,m.username,COALESCE(NULLIF(p.nickname,''),m.full_name,m.username) AS display_name,
             mp.avatar_key,COUNT(DISTINCT CASE WHEN child.id IS NOT NULL THEN child.id END) AS direct_referrals,
             (SELECT COUNT(*) FROM reachable d WHERE d.path LIKE CONCAT(r.path,'%') AND d.id<>m.id) AS network_size,
             GROUP_CONCAT(DISTINCT rc.role_name ORDER BY rc.role_name SEPARATOR '||') AS roles
      FROM reachable r JOIN members m ON m.id=r.id
      JOIN monarch_public_profiles p ON p.member_id=m.id AND p.approved=1 AND p.visible=1 AND p.requested=1 AND p.profile_status='published'
      LEFT JOIN member_profiles mp ON mp.member_id=m.id
      LEFT JOIN monarch_referral_relationships child ON child.sponsor_member_id=m.id ${timeClause}
      LEFT JOIN member_role_assignments ra ON ra.member_id=m.id
      LEFT JOIN member_role_catalog rc ON rc.id=ra.role_id AND rc.is_active=1
      WHERE m.id<>?
      GROUP BY m.id,m.username,p.nickname,m.full_name,mp.avatar_key,r.path
      ORDER BY direct_referrals DESC,network_size DESC,m.id ASC
      LIMIT 100
    `, start ? [rootId,start,end,rootId] : [rootId,rootId]);
    return rows.map((r,i)=>({...r,rank:i+1,direct_referrals:Number(r.direct_referrals||0),network_size:Number(r.network_size||0),roles:String(r.roles||'').split('||').filter(Boolean)}));
  }

  function renderTreeNode(node, depth=0) {
    if (!node) return '';
    const avatar = node.avatarUrl ? '<img src="'+safe(node.avatarUrl)+'" alt="" loading="lazy">' : '<span class="network-avatar-fallback">♛</span>';
    const roles = node.roles.map(r=>'<span class="network-role">'+safe(r)+'</span>').join('');
    const children = node.children.map(c=>renderTreeNode(c,depth+1)).join('');
    return '<li class="network-node" data-depth="'+depth+'"><details '+(depth<1?'open':'')+'><summary><span class="network-card">'+avatar+'<span class="network-person"><strong>'+safe(node.name)+'</strong><small>@'+safe(node.username)+'</small><span class="network-roles">'+roles+'</span><small>'+node.directRegistered+' direct registrations · '+node.publishedDescendants+' published descendants</small></span><span class="network-expand">'+(node.children.length?'＋':'•')+'</span></span></summary>'+(children?'<ul>'+children+'</ul>':'')+'</details></li>';
  }

  function styles() {
    return '<style>.network-page{color:var(--text,#f8f5ed)}.network-hero{padding:24px;border:1px solid #7b6330;border-radius:20px;background:radial-gradient(circle at 85% 10%,#b58a302b,transparent 45%),#101012}.network-hero h1{color:#e7c46b;margin:0 0 8px}.network-actions{display:flex;gap:10px;flex-wrap:wrap;margin:18px 0}.network-actions input,.network-actions select{padding:11px;border:1px solid #8b7139;border-radius:10px;background:#111;color:#fff}.network-tree{overflow:auto;padding:16px;background:#0c0c0e;border:1px solid #4d4026;border-radius:18px}.network-tree ul{padding-left:28px;margin:12px 0 0 16px;border-left:1px solid #a9873b;list-style:none}.network-node{position:relative;margin:12px 0}.network-node details>summary{list-style:none;cursor:pointer}.network-node details>summary::-webkit-details-marker{display:none}.network-card{display:flex;align-items:center;gap:12px;min-width:245px;max-width:370px;padding:12px;border:1px solid #6c572d;border-radius:15px;background:linear-gradient(130deg,#1b1a17,#0d0d0e);box-shadow:0 8px 24px #0005}.network-card img,.network-avatar-fallback{width:48px;height:48px;object-fit:cover;border-radius:50%;border:2px solid #d6b45e;display:grid;place-items:center;color:#e7c46b}.network-person{display:flex;flex-direction:column;gap:3px;min-width:0}.network-person strong{color:#f3d889}.network-person small{color:#aaa;font-size:11px}.network-roles{display:flex;gap:4px;flex-wrap:wrap}.network-role{font-size:10px;border:1px solid #8b7139;border-radius:20px;padding:2px 6px;color:#e6c36b}.network-expand{margin-left:auto;color:#d7b65d}.network-empty{padding:24px;text-align:center;color:#aaa}.network-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}.network-stat{padding:16px;border:1px solid #5b4929;border-radius:14px;background:#141311}.network-stat strong{display:block;font-size:26px;color:#e7c46b}.network-table{width:100%;border-collapse:collapse}.network-table th,.network-table td{padding:11px;border-bottom:1px solid #393329;text-align:left}.network-table th{color:#e7c46b}.network-rank{font-weight:800;color:#e7c46b}.network-podium{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:16px 0}.network-podium>div{padding:14px 8px;text-align:center;border:1px solid #8a7039;border-radius:14px;background:linear-gradient(#292214,#121212)}.network-podium img{width:54px;height:54px;border-radius:50%;object-fit:cover}.network-muted{color:#aaa}.network-form{display:grid;gap:10px;max-width:720px}.network-form input,.network-form textarea,.network-form select{padding:11px;border:1px solid #756039;border-radius:9px;background:#111;color:#fff}.network-form button,.network-button{padding:10px 14px;border:1px solid #b7964c;border-radius:9px;background:#b7964c;color:#111;font-weight:800;cursor:pointer}.network-danger{background:#3b2020;color:#fff}.network-inline{display:inline-flex;gap:6px;align-items:center}</style>';
  }

  router.get('/network', async (req,res,next) => {
    try {
      const data=await publicTree();
      const root=data?buildTree(data.rows):null;
      const content=styles()+'<main class="network-page"><section class="network-hero"><p class="network-muted">THE MONARCH CODEX ORGANIZATION</p><h1>Monarch Codex Network</h1><p>Explore the published member network and its verified referral connections.</p><div class="network-actions"><input id="networkSearch" placeholder="Search published members..." aria-label="Search members"><a class="network-button" href="/leaderboard">View leaderboards</a></div></section><section class="network-tree" aria-label="Referral network"><ul>'+ (root?renderTreeNode(root):'<li class="network-empty">The network is being prepared for publication.</li>') +'</ul></section></main><script>document.getElementById("networkSearch")?.addEventListener("input",function(){const q=this.value.toLowerCase();document.querySelectorAll(".network-node").forEach(n=>{const hit=n.textContent.toLowerCase().includes(q);n.style.opacity=!q||hit?"1":".25";if(q&&hit){let d=n.querySelector("details");if(d)d.open=true;}})});</script>';
      if(req.session&&req.session.memberId){const [[m]]=await pool.execute('SELECT id,full_name,username FROM members WHERE id=? LIMIT 1',[req.session.memberId]);return res.send(memberPage('Monarch Codex Network','/network',m,content,req));}
      return res.send('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Monarch Codex Network</title><body style="margin:0;background:#09090b;color:#fff;font:15px system-ui;padding:20px">'+content+'<p><a href="/login" style="color:#e7c46b">Member login</a></p></body></html>');
    } catch(e){next(e);}
  });

  router.get('/leaderboard', async (req,res,next) => {
    try {
      const mode=req.query.period==='monthly'?'monthly':'all_time';
      const rows=await leaderboard(mode);
      const cards=rows.map(r=>'<tr><td class="network-rank">#'+r.rank+'</td><td><strong>'+safe(r.display_name)+'</strong><br><small>@'+safe(r.username)+'</small></td><td>'+r.direct_referrals+'</td><td>'+r.network_size+'</td></tr>').join('');
      const podium=rows.slice(0,3).map((r,i)=>'<div><span class="network-rank">#'+r.rank+'</span><p><strong>'+safe(r.display_name)+'</strong></p><small>'+r.direct_referrals+' referrals</small></div>').join('');
      const content=styles()+'<main class="network-page"><section class="network-hero"><p class="network-muted">RECOGNITION & NETWORK GROWTH</p><h1>Monarch Codex Leaderboard</h1><p>Monthly rankings reset automatically each calendar month. All-time rankings preserve overall referral performance.</p><div class="network-actions"><a class="network-button" href="/leaderboard?period=monthly">This month</a><a class="network-button" href="/leaderboard?period=all_time">All time</a><a href="/network" class="network-button">Explore network</a></div></section><div class="network-podium">'+(podium||'<p class="network-empty">No published rankings yet.</p>')+'</div><section class="network-tree"><table class="network-table"><thead><tr><th>Rank</th><th>Member</th><th>'+(mode==='monthly'?'This month':'All-time')+' direct referrals</th><th>Network size</th></tr></thead><tbody>'+(cards||'<tr><td colspan="4">No eligible published members yet.</td></tr>')+'</tbody></table></section></main>';
      if(req.session&&req.session.memberId){const [[m]]=await pool.execute('SELECT id,full_name,username FROM members WHERE id=? LIMIT 1',[req.session.memberId]);return res.send(memberPage('Leaderboard','/leaderboard',m,content,req));}
      return res.send('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Leaderboard</title><body style="margin:0;background:#09090b;color:#fff;font:15px system-ui;padding:20px">'+content+'<p><a href="/login" style="color:#e7c46b">Member login</a></p></body></html>');
    } catch(e){next(e);}
  });

  router.get('/api/mobile/network/profile',async(req,res,next)=>{try{
    if(!req.session||!req.session.memberId)return res.status(401).json({error:'authentication_required'});
    const [[m]]=await pool.execute(`SELECT m.full_name,m.username,p.nickname,p.bio,p.profile_status,(SELECT r.nickname FROM monarch_network_profile_revisions r WHERE r.member_id=m.id AND r.status='pending' ORDER BY r.id DESC LIMIT 1) AS pending_nickname,(SELECT r.bio FROM monarch_network_profile_revisions r WHERE r.member_id=m.id AND r.status='pending' ORDER BY r.id DESC LIMIT 1) AS pending_bio FROM members m LEFT JOIN monarch_public_profiles p ON p.member_id=m.id WHERE m.id=?`,[req.session.memberId]);
    if(!m)return res.status(404).json({error:'member_not_found'});
    res.set('Cache-Control','no-store, private').json({profile:m});
  }catch(e){next(e);}});
  router.post('/api/mobile/network/profile',async(req,res,next)=>{try{
    if(!req.session||!req.session.memberId)return res.status(401).json({error:'authentication_required'});
    const nickname=String(req.body.nickname||'').trim(),bio=String(req.body.bio||'').trim();
    if(!nickname||nickname.length>80||/[<>]/.test(nickname)||bio.length>600||/[<>]/.test(bio))return res.status(400).json({error:'invalid_profile',message:'Check your display name and biography.'});
    const [result]=await pool.execute("INSERT INTO monarch_network_profile_revisions (member_id,nickname,bio,status) VALUES (?,?,?,'pending')",[req.session.memberId,nickname,bio]);
    res.status(201).json({ok:true,revisionId:result.insertId,status:'pending',message:'Your profile changes were submitted for admin review.'});
  }catch(e){next(e);}});

  router.get('/api/mobile/network',async(req,res,next)=>{try{
    if(!req.session||!req.session.memberId)return res.status(401).json({error:'authentication_required'});
    const data=await publicTree();res.set('Cache-Control','no-store, private').json({tree:data?buildTree(data.rows):null,totalPublished:data?data.rows.length:0});
  }catch(e){next(e);}});
  router.get('/api/mobile/leaderboard',async(req,res,next)=>{try{
    if(!req.session||!req.session.memberId)return res.status(401).json({error:'authentication_required'});
    const period=req.query.period==='monthly'?'monthly':'all_time';res.set('Cache-Control','no-store, private').json({period,month:period==='monthly'?monthKey():null,rows:await leaderboard(period)});
  }catch(e){next(e);}});
  router.get('/api/mobile/admin/network/leaderboard',async(req,res,next)=>{try{
    if(!req.session||!req.session.memberId)return res.status(401).json({error:'authentication_required'});
    const [[a]]=await pool.execute('SELECT role FROM admin_users WHERE member_id=? AND is_active=1 LIMIT 1',[req.session.memberId]);
    if(!a||a.role==='sovereign_desk_admin')return res.status(403).json({error:'forbidden'});
    const period=req.query.period==='monthly'?'monthly':'all_time';res.set('Cache-Control','no-store, private').json({period,rows:await leaderboard(period)});
  }catch(e){next(e);}});
  router.get('/api/mobile/sovereign/leaderboard',async(req,res,next)=>{try{
    if(!req.session||!req.session.memberId)return res.status(401).json({error:'authentication_required'});
    const [[a]]=await pool.execute('SELECT role FROM admin_users WHERE member_id=? AND is_active=1 LIMIT 1',[req.session.memberId]);
    if(!a||!['sovereign_desk_admin','super_admin','main_admin'].includes(a.role))return res.status(403).json({error:'forbidden'});
    const period=req.query.period==='monthly'?'monthly':'all_time';res.set('Cache-Control','no-store, private').json({period,rows:await leaderboard(period)});
  }catch(e){next(e);}});

  router.get('/api/public-network', async (_req,res,next)=>{try{const data=await publicTree();res.set('Cache-Control','public,max-age=30').json({tree:data?buildTree(data.rows):null,totalPublished:data?data.rows.length:0});}catch(e){next(e);}});
  router.get('/api/public-leaderboard', async (req,res,next)=>{try{const period=req.query.period==='monthly'?'monthly':'all_time';res.set('Cache-Control','public,max-age=60').json({period,month:period==='monthly'?monthKey():null,rows:await leaderboard(period)});}catch(e){next(e);}});

  router.get('/network/profile',requireAuth,async(req,res,next)=>{try{
    const [[m]]=await pool.execute(`SELECT m.id,m.full_name,m.username,p.nickname,p.bio,p.requested,p.approved,p.visible,p.profile_status,(SELECT r.nickname FROM monarch_network_profile_revisions r WHERE r.member_id=m.id AND r.status='pending' ORDER BY r.id DESC LIMIT 1) AS pending_nickname,(SELECT r.bio FROM monarch_network_profile_revisions r WHERE r.member_id=m.id AND r.status='pending' ORDER BY r.id DESC LIMIT 1) AS pending_bio FROM members m LEFT JOIN monarch_public_profiles p ON p.member_id=m.id WHERE m.id=?`,[req.session.memberId]);
    if(!m)return res.redirect('/login');
    const content=styles()+'<section class="ac-panel"><h2>My public network profile</h2><p class="network-muted">Submit your display name and biography for Founder/Admin review. Your profile is not public until approved.</p><form class="network-form" method="post" action="/network/profile">'+csrfField(req)+'<label>Public display name<input name="nickname" maxlength="80" required value="'+safe(m.pending_nickname||m.nickname||m.full_name)+'"></label><label>Biography<textarea name="bio" rows="4" maxlength="600">'+safe(m.pending_bio||m.bio||'')+'</textarea></label><button type="submit">Submit profile for approval</button></form><p class="network-muted">Status: '+safe(m.pending_revision_id?'Pending review':(m.profile_status||'draft'))+'</p></section>';
    res.send(memberPage('My Network Profile','/network',m,content,req));
  }catch(e){next(e);}});
  router.post('/network/profile',requireAuth,(req,res,next)=>csrfCheck(req,res,async err=>{if(err)return;try{
    const nickname=String(req.body.nickname||'').trim(),bio=String(req.body.bio||'').trim();
    if(!nickname||nickname.length>80||/[<>]/.test(nickname)||bio.length>600||/[<>]/.test(bio))return res.status(400).send('Please check your profile fields.');
    await pool.execute("INSERT INTO monarch_network_profile_revisions (member_id,nickname,bio,status) VALUES (?,?,?,'pending')",[req.session.memberId,nickname,bio]);
    res.redirect('/network/profile');
  }catch(e){next(e);}}));

  router.get('/admin/network',requireAdmin,async(req,res,next)=>{try{
    if(req.adminRole==='sovereign_desk_admin')return res.sendStatus(403);
    const [rows]=await pool.query("SELECT m.id,m.full_name,m.username,m.email,COALESCE(pr.nickname,p.nickname) AS nickname,COALESCE(pr.bio,p.bio) AS bio,p.profile_status,p.requested,p.approved,p.visible,mp.avatar_key,pr.id AS pending_revision_id FROM members m LEFT JOIN monarch_public_profiles p ON p.member_id=m.id LEFT JOIN member_profiles mp ON mp.member_id=m.id LEFT JOIN monarch_network_profile_revisions pr ON pr.id=(SELECT MAX(r2.id) FROM monarch_network_profile_revisions r2 WHERE r2.member_id=m.id AND r2.status='pending') ORDER BY (pr.id IS NOT NULL) DESC,m.created_at DESC LIMIT 300");
    const table=rows.map(m=>'<tr><td>'+safe(m.full_name)+'<br><small>@'+safe(m.username)+'</small></td><td>'+safe(m.nickname||'—')+'</td><td>'+safe(m.profile_status||'draft')+'</td><td><form method="post" action="/admin/network/members/'+m.id+'" class="network-form">'+csrfField(req)+'<input name="nickname" maxlength="80" value="'+safe(m.nickname||m.full_name)+'" aria-label="Display name"><textarea name="bio" maxlength="600" aria-label="Biography">'+safe(m.bio||'')+'</textarea><input name="username" maxlength="30" value="'+safe(m.username)+'" aria-label="Username"><label>Publication decision<select name="decision"><option value="publish">Publish / approve updates</option><option value="reject">Reject pending revision</option><option value="unpublish">Unpublish profile</option></select></label><button type="submit">Save profile</button></form><form class="network-photo-form" data-member-id="'+m.id+'">'+csrfField(req)+'<input type="file" accept="image/jpeg,image/png,image/webp" required><button type="submit">Upload photo</button></form></td></tr>').join('');
    const content=styles()+'<section class="ac-panel"><h2>Network profile administration</h2><p>Review profile submissions, edit usernames and public descriptions, then publish or unpublish profiles. Photographs can be uploaded here using the existing private profile-photo storage.</p><div class="ac-table-wrap"><table class="network-table"><thead><tr><th>Member</th><th>Display name</th><th>Status</th><th>Admin controls</th></tr></thead><tbody>'+table+'</tbody></table></div></section>';
    res.send(adminControlPage('Monarch Network','/admin/network',content+'<script>document.querySelectorAll(".network-photo-form").forEach(f=>f.addEventListener("submit",e=>{e.preventDefault();const file=f.querySelector("input[type=file]").files[0];if(!file)return;const reader=new FileReader();reader.onload=async()=>{const token=f.querySelector("[name=_csrf]")?.value||"";const response=await fetch("/admin/network/members/"+f.dataset.memberId+"/photo",{method:"POST",headers:{"Content-Type":"application/json","X-CSRF-Token":token},body:JSON.stringify({_csrf:token,mimeType:file.type,imageBase64:reader.result})});if(response.ok){alert("Profile photograph updated.");location.reload();}else{const data=await response.json().catch(()=>({}));alert(data.message||"Photo upload failed.");}};reader.readAsDataURL(file);}));</script>',req));
  }catch(e){next(e);}});
  router.post('/admin/network/members/:id',requireAdmin,(req,res,next)=>csrfCheck(req,res,async err=>{if(err)return;try{
    if(req.adminRole==='sovereign_desk_admin')return res.sendStatus(403);
    const id=Number(req.params.id),nickname=String(req.body.nickname||'').trim(),bio=String(req.body.bio||'').trim(),username=String(req.body.username||'').trim();
    if(!Number.isSafeInteger(id)||id<1||!nickname||nickname.length>80||/[<>]/.test(nickname)||bio.length>600||/[<>]/.test(bio)||!/^[A-Za-z0-9_]{3,30}$/.test(username))return res.status(400).send('Invalid profile details.');
    const decision=String(req.body.decision||'publish');if(!['publish','reject','unpublish'].includes(decision))return res.status(400).send('Invalid publication decision.');const publish=decision==='publish';
    const connection=await pool.getConnection();
    try{
      await connection.beginTransaction();
      const [[target]]=await connection.execute('SELECT id,username FROM members WHERE id=? FOR UPDATE',[id]);
      const [[pendingRevision]]=await connection.execute("SELECT id,nickname,bio FROM monarch_network_profile_revisions WHERE member_id=? AND status='pending' ORDER BY id DESC LIMIT 1 FOR UPDATE",[id]);
      const [[currentProfile]]=await connection.execute('SELECT nickname,bio,profile_status,requested,approved,visible FROM monarch_public_profiles WHERE member_id=? LIMIT 1 FOR UPDATE',[id]);
      if(!target){await connection.rollback();return res.sendStatus(404);}
      const [[dupe]]=await connection.execute('SELECT id FROM members WHERE LOWER(username)=LOWER(?) AND id<>? LIMIT 1',[username,id]);
      if(dupe){await connection.rollback();return res.status(409).send('That username is already in use.');}
      const [[actor]]=await connection.execute('SELECT role FROM admin_users WHERE member_id=? AND is_active=1 LIMIT 1',[req.session.memberId]);
      if(!actor||actor.role==='sovereign_desk_admin'){await connection.rollback();return res.sendStatus(403);}
      await connection.execute('UPDATE members SET username=? WHERE id=?',[username,id]);
      if(decision==='reject'){if(currentProfile)await connection.execute('UPDATE monarch_public_profiles SET approved=?,visible=?,profile_status=? WHERE member_id=?',[currentProfile.approved,currentProfile.visible,currentProfile.profile_status,id]);}else{await connection.execute("INSERT INTO monarch_public_profiles (member_id,nickname,bio,requested,approved,visible,profile_status,approved_by,approved_at) VALUES (?,?,?,?,?,?,?,?,IF(?=1,NOW(),NULL)) ON DUPLICATE KEY UPDATE nickname=VALUES(nickname),bio=VALUES(bio),requested=1,approved=VALUES(approved),visible=VALUES(visible),profile_status=VALUES(profile_status),approved_by=VALUES(approved_by),approved_at=IF(VALUES(approved)=1,NOW(),NULL)",[id,nickname,bio,1,publish?1:0,publish?1:0,publish?'published':'unpublished',req.session.memberId,publish?1:0]);}
      if(pendingRevision)await connection.execute("UPDATE monarch_network_profile_revisions SET status=?,reviewed_by_member_id=?,reviewed_at=NOW() WHERE id=?",[decision==='publish'?'approved':'rejected',req.session.memberId,pendingRevision.id]);
      await connection.execute('INSERT INTO monarch_network_audit (actor_member_id,target_member_id,action,before_data,after_data) VALUES (?,?,?,?,?)',[req.session.memberId,id,'profile.admin_updated',JSON.stringify({username:target.username}),JSON.stringify({username,nickname,bio,published:publish})]);
      await connection.commit();
    }catch(e){await connection.rollback();throw e;}finally{connection.release();}
    res.redirect('/admin/network');
  }catch(e){next(e);}}));

  router.post('/admin/network/members/:id/photo',requireAdmin,(req,res,next)=>csrfCheck(req,res,async err=>{if(err)return;let newPath=null;try{
    if(req.adminRole==='sovereign_desk_admin')return res.sendStatus(403);
    const id=Number(req.params.id),mime=String(req.body.mimeType||''),encoded=String(req.body.imageBase64||'');
    if(!Number.isSafeInteger(id)||id<1)return res.status(400).json({error:'invalid_member_id'});
    if(!['image/jpeg','image/png','image/webp'].includes(mime)||!encoded||encoded.length>4*1024*1024)return res.status(400).json({error:'invalid_image',message:'Choose a JPG, PNG or WebP image under 3 MB.'});
    const buf=Buffer.from(encoded.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/,''),'base64');
    const valid=(mime==='image/jpeg'&&buf[0]===255&&buf[1]===216&&buf[2]===255)||(mime==='image/png'&&buf.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))||(mime==='image/webp'&&buf.toString('ascii',0,4)==='RIFF'&&buf.toString('ascii',8,12)==='WEBP');
    if(!valid||!buf.length||buf.length>3*1024*1024)return res.status(400).json({error:'invalid_image',message:'The uploaded file is not a valid supported image.'});
    const dir=process.env.PROFILE_UPLOAD_DIR;
    if(!dir||!path.isAbsolute(dir)||dir===path.resolve(__dirname)||dir.startsWith(path.resolve(__dirname)+path.sep))return res.status(503).json({error:'uploads_unavailable',message:'Private profile photo storage is not configured.'});
    fs.mkdirSync(dir,{recursive:true,mode:0o700});
    const ext={'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp'}[mime],key=crypto.randomBytes(24).toString('hex')+ext;
    newPath=path.join(dir,key);fs.writeFileSync(newPath,buf,{mode:0o600,flag:'wx'});
    const [[target]]=await pool.execute('SELECT id FROM members WHERE id=? LIMIT 1',[id]);if(!target){fs.unlinkSync(newPath);return res.sendStatus(404);}
    const [oldRows]=await pool.execute('SELECT avatar_key FROM member_profiles WHERE member_id=? LIMIT 1',[id]);const old=String(oldRows[0]?.avatar_key||'');
    await pool.execute('INSERT INTO member_profiles (member_id,avatar_key) VALUES (?,?) ON DUPLICATE KEY UPDATE avatar_key=VALUES(avatar_key)',[id,key]);
    await pool.execute('INSERT INTO monarch_network_audit (actor_member_id,target_member_id,action,before_data,after_data) VALUES (?,?,?,?,?)',[req.session.memberId,id,'profile.photo_replaced',JSON.stringify({avatar_key:old||null}),JSON.stringify({avatar_key:key})]);
    if(old&&old!==key&&/^[a-f0-9]{48}\.(jpg|png|webp)$/.test(old)){try{fs.unlinkSync(path.join(dir,old));}catch(e){if(e.code!=='ENOENT')console.error('[network photo cleanup] failed');}}
    res.json({ok:true,photoUrl:'/member-avatar/'+encodeURIComponent(key)});
  }catch(e){if(newPath){try{fs.unlinkSync(newPath);}catch(_){}}next(e);}}));

  router.get('/admin/network/leaderboard',requireAdmin,async(req,res,next)=>{try{
    if(req.adminRole==='sovereign_desk_admin')return res.sendStatus(403);
    const period=req.query.period==='monthly'?'monthly':'all_time',rows=await leaderboard(period);
    const body=rows.map(r=>'<tr><td>#'+r.rank+'</td><td>'+safe(r.display_name)+' <small>@'+safe(r.username)+'</small></td><td>'+r.direct_referrals+'</td><td>'+r.network_size+'</td></tr>').join('');
    res.send(adminControlPage('Network leaderboard','/admin/network/leaderboard',styles()+'<section class="ac-panel"><h2>Network leaderboard administration</h2><p>Monthly rankings reset automatically on the first day of each calendar month. All-time rankings are cumulative.</p><p><a class="network-button" href="?period=monthly">Monthly</a> <a class="network-button" href="?period=all_time">All time</a></p><table class="network-table"><thead><tr><th>Rank</th><th>Member</th><th>Direct referrals</th><th>Network size</th></tr></thead><tbody>'+body+'</tbody></table></section>','/admin/network/leaderboard',req));
  }catch(e){next(e);}});

  router.get('/sovereign-admin/leaderboard',requireAuth,async(req,res,next)=>{try{
    const [[admin]]=await pool.execute('SELECT role FROM admin_users WHERE member_id=? AND is_active=1 LIMIT 1',[req.session.memberId]);
    if(!admin||!['sovereign_desk_admin','super_admin','main_admin'].includes(admin.role))return res.sendStatus(403);
    const period=req.query.period==='monthly'?'monthly':'all_time',rows=await leaderboard(period);
    const body=rows.map(r=>'<tr><td>#'+r.rank+'</td><td>'+safe(r.display_name)+'</td><td>'+r.direct_referrals+'</td><td>'+r.network_size+'</td></tr>').join('');
    res.send('<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="background:#0b0b0d;color:#f6f0df;font:15px system-ui;padding:20px">'+styles()+'<main class="network-page"><section class="network-hero"><h1>Network leaderboard</h1><p>Read-only view. Sovereign Desk permissions do not grant Monarch Codex profile, role or financial administration.</p><a class="network-button" href="?period=monthly">Monthly</a> <a class="network-button" href="?period=all_time">All time</a></section><table class="network-table"><thead><tr><th>Rank</th><th>Member</th><th>Direct referrals</th><th>Network size</th></tr></thead><tbody>'+body+'</tbody></table><p><a href="/sovereign-admin" style="color:#e7c46b">Back to Sovereign Desk</a></p></main></body></html>');
  }catch(e){next(e);}});

  router.post('/admin/network/archive-month',requireAdmin,(req,res,next)=>csrfCheck(req,res,async err=>{if(err)return;try{
    if(req.adminRole==='sovereign_desk_admin')return res.sendStatus(403);
    const period=String(req.body.period||monthKey());
    if(!/^\d{4}-\d{2}$/.test(period)||period>=monthKey())return res.status(400).send('Only a completed month can be archived.');
    const rows=await leaderboard('monthly',period);
    const conn=await pool.getConnection();
    try{await conn.beginTransaction();for(const r of rows)await conn.execute('INSERT INTO monarch_leaderboard_monthly_archive (period_month,member_id,direct_referrals,network_size,rank_position,display_name,username) VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE direct_referrals=VALUES(direct_referrals),network_size=VALUES(network_size),rank_position=VALUES(rank_position),display_name=VALUES(display_name),username=VALUES(username)',[period,r.id,r.direct_referrals,r.network_size,r.rank,r.display_name,r.username]);await conn.commit();}catch(e){await conn.rollback();throw e;}finally{conn.release();}
    res.redirect('/admin/network/leaderboard?archived='+encodeURIComponent(period));
  }catch(e){next(e);}}));

  return router;
};
