    ['/sovereign-admin','Desk overview','◫'],['/sovereign-admin/signals','Signals','↗'],['/sovereign-admin/guidance','Guidance & content','✦'],['/sovereign-admin/access','Desk access','♙'],['/sovereign-admin/activity','My activity','▤'],['/dashboard','Member view','↗']
  ] : [
    ['/admin','Overview','◫'],['/admin/members','Monarchs','♙'],['/admin/kyc','KYC review','◇'],
    ['/admin/deposits','Deposits','↓'],['/admin/withdrawals','Withdrawals','↑'],['/admin/investments','Investments','◆'],
    ['/admin/transactions','Transactions','◷'],['/admin/balances','Balance management','＋'],['/admin/earnings','Profits & bonuses','✦'],
    ['/admin/referrals','Referrals','⇄'],['/admin/academy','Academy','▣'],['/admin/sovereign-desk','Sovereign Desk','⌁'],
    ['/admin/notifications','Notifications','♧'],['/admin/audit','Audit & access','▤'],['/admin/settings','Settings','⚙'],['/dashboard','Member view','↗']
  ];
  const links = nav.map(([url,label,icon]) => '<a class="ac-nav '+((active===url || (url !== '/admin' && active.startsWith(url+'/')))?'is-active':'')+'" href="'+url+'"><span>'+icon+'</span><b>'+label+'</b></a>').join('');
  const role = esc((req.adminRole || 'admin').replace(/_/g,' ').toUpperCase());
  return page(title, `<style>
  .ac-layout{width:100%;max-width:1450px;margin:0 auto;display:grid;grid-template-columns:230px minmax(0,1fr);gap:20px;align-items:start}
  .ac-side{position:sticky;top:14px;min-height:0;padding:16px 12px;border:1px solid #393522;border-radius:20px;background:linear-gradient(180deg,#17171b,#0d0d10)}
  .ac-brand{padding:8px 10px 18px;color:#f3cf3c;font-weight:900;letter-spacing:.12em;font-size:.86rem;line-height:1.5}
  .ac-side-label{padding:8px 10px;color:#777783;font-size:.7rem;letter-spacing:.13em;font-weight:800}
  .ac-side{max-height:calc(100vh - 28px);overflow-y:auto;overscroll-behavior:contain}.ac-nav{min-height:42px}.ac-nav b{line-height:1.25}
  .ac-nav-group{margin:12px 0 5px;padding:8px 10px 2px;color:#777783;font-size:.68rem;font-weight:900;letter-spacing:.12em;text-transform:uppercase}
  .ac-coming{display:flex;gap:12px;align-items:flex-start;padding:16px;border:1px solid #37333b;border-radius:14px;background:#151519;margin-top:12px}.ac-coming strong{color:#f3cf3c;display:block}.ac-coming p{margin:5px 0 0;color:#aaa9b4}
  .ac-page-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap}.ac-page-head .ac-pill{white-space:nowrap}
  .ac-nav{display:flex;gap:12px;align-items:center;padding:12px 13px;margin:4px 0;border-radius:12px;text-decoration:none;color:#b8b6c0;border:1px solid transparent}
  .ac-nav span{width:22px;text-align:center;font-size:1.1rem}.ac-nav b{font-size:.91rem}
  .ac-nav:hover,.ac-nav.is-active{background:#292411;border-color:#5b4c20;color:#f3cf3c}
  .ac-secure{margin-top:26px;padding:13px;border-radius:13px;background:#111115;border:1px solid #33313a;color:#b8b6c0;font-size:.78rem;line-height:1.5}
  .ac-main{min-width:0}.ac-top{display:flex;justify-content:space-between;gap:14px;align-items:flex-start;flex-wrap:wrap;margin:4px 0 20px;padding:4px 2px}.ac-top .muted{margin:8px 0 0;line-height:1.55}
  .ac-kicker{color:#f3cf3c;letter-spacing:.13em;font-size:.73rem;font-weight:900}.ac-top h1{margin:8px 0;font-size:clamp(1.65rem,4vw,2.5rem)}
  .ac-pill{border:1px solid #625322;background:#28210f;color:#f3cf3c;border-radius:999px;padding:9px 13px;font-size:.8rem;font-weight:800}
  .ac-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:13px}.ac-stat,.ac-panel{background:linear-gradient(145deg,#19191e,#111114);border:1px solid #37332a;border-radius:18px;padding:19px;min-width:0}
  .ac-stat span,.ac-stat small{display:block;color:#aaa9b4}.ac-stat strong{display:block;color:#f3cf3c;font-size:clamp(1.45rem,3vw,2.1rem);margin:12px 0;overflow-wrap:anywhere}.ac-stat small{font-size:.8rem}
  .ac-panel{margin-top:16px}.ac-panel>p{line-height:1.65;max-width:70ch}.ac-panel h2{margin-top:0}.ac-tiles{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
  .ac-tile{display:block;padding:17px;border-radius:14px;border:1px solid #36333b;background:#151519;text-decoration:none;color:#f5f4f0;min-height:94px;transition:border-color .18s ease,background .18s ease}.ac-tile:focus-visible,.ac-nav:focus-visible{outline:2px solid #f3cf3c;outline-offset:3px}.ac-tile:hover{border-color:#b99a2c}.ac-tile strong{display:block;color:#f3cf3c}.ac-tile small{display:block;color:#aaa9b4;margin-top:7px;line-height:1.5}
  .ac-alert{margin-top:15px;padding:14px;border:1px solid #655221;background:#241e0e;color:#e7ddb4;border-radius:13px}
  .ac-table-wrap{overflow:auto}.ac-table{width:100%;border-collapse:collapse;min-width:600px}.ac-table th,.ac-table td{text-align:left;padding:12px;border-bottom:1px solid #35323a}.ac-table th{color:#aaa9b4;font-size:.78rem}
   .ac-mobilebar{display:none}.ac-drawer-scrim{display:none}
  @media(max-width:800px){.ac-layout{display:block;width:100%}.ac-mobilebar{display:flex;align-items:center;gap:12px;margin:0 0 14px;padding:12px 14px;border:1px solid #393522;border-radius:14px;background:#141418}.ac-menu-toggle{display:inline-grid;place-items:center;width:42px;height:42px;border:1px solid #5b4c20;border-radius:11px;background:#292411;color:#f3cf3c;font-size:1.45rem}.ac-mobile-title{font-weight:800;color:#f3cf3c;letter-spacing:.08em;font-size:.78rem}.ac-drawer-scrim{position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.68);border:0;width:100%;height:100%;padding:0}.ac-layout.ac-menu-open .ac-drawer-scrim{display:block}.ac-side{position:fixed;z-index:1001;left:0;top:0;bottom:0;width:min(84vw,310px);max-height:100dvh;overflow-y:auto;transform:translateX(-105%);transition:transform .22s ease;border-radius:0 20px 20px 0;padding:18px 14px;box-shadow:18px 0 45px rgba(0,0,0,.35)}.ac-layout.ac-menu-open .ac-side{transform:translateX(0)}.ac-brand{padding:5px 6px 16px}.ac-side-label,.ac-secure{display:block}.ac-side nav{display:block}.ac-nav{display:flex;min-width:0;padding:12px 10px;margin:4px 0;gap:10px;background:transparent;border-color:transparent}.ac-nav b{font-size:.88rem;line-height:1.25}.ac-nav span{flex:0 0 22px}.ac-side form{margin-top:12px}.ac-side form .btn{margin-top:0!important;min-height:44px}.ac-top{margin:2px 0 16px}.ac-stats{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.ac-stat{padding:15px;border-radius:15px}.ac-panel{margin-top:12px;padding:16px;border-radius:16px}}
  @media(max-width:480px){.ac-nav{gap:9px;padding:11px 10px}.ac-nav b{font-size:.84rem}.ac-nav span{width:20px}.ac-tiles{grid-template-columns:1fr;gap:9px}.ac-tile{min-height:0;padding:15px}.ac-stat{padding:13px}.ac-stat strong{font-size:1.45rem;margin:9px 0}.ac-stat span{font-size:.83rem;line-height:1.4}.ac-stat small{font-size:.74rem;line-height:1.4}.ac-top h1{font-size:1.8rem}.ac-pill{font-size:.72rem;padding:8px 10px}.ac-table{min-width:650px}}
  @media(max-width:480px){.ac-nav{gap:7px;padding:10px 8px}.ac-nav b{font-size:.76rem}.ac-nav span{width:17px}.ac-tiles{grid-template-columns:1fr;gap:9px}.ac-tile{min-height:0;padding:15px}.ac-stat{padding:13px}.ac-stat strong{font-size:1.45rem;margin:9px 0}.ac-stat span{font-size:.83rem;line-height:1.4}.ac-stat small{font-size:.74rem;line-height:1.4}.ac-top h1{font-size:1.8rem}.ac-pill{font-size:.72rem;padding:8px 10px}.ac-table{min-width:650px}}
  </style><div class="ac-layout" id="adminLayout"><div class="ac-mobilebar"><button class="ac-menu-toggle" type="button" id="adminMenuToggle" aria-label="Open admin navigation" aria-expanded="false">☰</button><span class="ac-mobile-title">MONARCH CODEX · ADMIN</span></div><button class="ac-drawer-scrim" type="button" id="adminDrawerScrim" aria-label="Close admin navigation"></button><aside class="ac-side" id="adminSidebar"><div class="ac-brand">MONARCH CODEX <span style="display:block;color:#aaa9b4;font-size:.7rem;letter-spacing:.06em;margin-top:6px">ADMIN CONTROL CENTRE</span></div><div class="ac-side-label">WORKSPACE</div>${links}<div class="ac-secure"><strong style="color:#f3cf3c">Secure session</strong><br>Administrator access is checked on the server for each protected page.</div><form method="post" action="/logout">${csrfField(req)}<button class="btn" style="width:100%;margin-top:14px" type="submit">Log out</button></form></aside><main class="ac-main"><header class="ac-top"><div><div class="ac-kicker">MONARCH CODEX / CONTROL CENTRE</div><h1>${esc(title)}</h1><p class="muted">Operations, member access and compliance oversight.</p></div><span class="ac-pill">● ${role}</span></header>${content}</main></div><script>(function(){var layout=document.getElementById('adminLayout'),toggle=document.getElementById('adminMenuToggle'),scrim=document.getElementById('adminDrawerScrim'),sidebar=document.getElementById('adminSidebar');if(!layout||!toggle||!scrim||!sidebar)return;function close(){layout.classList.remove('ac-menu-open');toggle.setAttribute('aria-expanded','false');toggle.setAttribute('aria-label','Open admin navigation')}function open(){layout.classList.add('ac-menu-open');toggle.setAttribute('aria-expanded','true');toggle.setAttribute('aria-label','Close admin navigation')}toggle.addEventListener('click',function(){layout.classList.contains('ac-menu-open')?close():open()});scrim.addEventListener('click',close);sidebar.querySelectorAll('a').forEach(function(a){a.addEventListener('click',close)});document.addEventListener('keydown',function(e){if(e.key==='Escape')close()});window.addEventListener('resize',function(){if(window.innerWidth>800)close()})})();</script>`);
}
app.get('/admin', requireAdmin, async (req,res,next) => {
  try {
    const [[members]] = await pool.query('SELECT COUNT(*) AS total FROM members');
    let recentTotal = '—';
    try { const [[recent]] = await pool.query('SELECT COUNT(*) AS total FROM members WHERE created_at >= DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 7 DAY)'); recentTotal = Number(recent.total)||0; } catch (e) { if (!['ER_BAD_FIELD_ERROR','ER_BAD_TABLE_ERROR'].includes(e.code)) throw e; }
    const [[admins]] = await pool.query('SELECT COUNT(*) AS total FROM admin_users WHERE is_active = 1');
    let kycCount = null;
    try { const [[kyc]] = await pool.query("SELECT COUNT(*) AS total FROM kyc_submissions WHERE status = 'pending'"); kycCount = Number(kyc.total)||0; } catch(e) { if(e.code!=='ER_NO_SUCH_TABLE') throw e; }
    const stat = (label,value,hint) => '<article class="ac-stat"><span>'+esc(label)+'</span><strong>'+esc(value)+'</strong><small>'+esc(hint)+'</small></article>';
    const content = '<section class="ac-stats">'+stat('Total members',Number(members.total)||0,'Registered accounts')+stat('New members · 7 days',recentTotal,'Recent registrations')+stat('Active administrators',Number(admins.total)||0,'Explicitly provisioned admins')+stat('Pending KYC',kycCount===null?'Not configured':kycCount,kycCount===null?'Apply the KYC migration':'Awaiting review')+stat('Deposits','Disabled','No verified payment workflow')+stat('Withdrawals','Disabled','No approved payout workflow')+'</section><section class="ac-panel"><h2>Management workspace</h2><p class="muted">Core control-centre areas. Deposits and withdrawals stay disabled until secure ledger and payout processing are connected.</p><div class="ac-tiles"><a class="ac-tile" href="/admin/members"><strong>Member management →</strong><small>Review member accounts and account status.</small></a><a class="ac-tile" href="/admin/kyc"><strong>KYC review queue →</strong><small>'+(kycCount===null?'Database migration required':kycCount+' submissions pending')+'</small></a><a class="ac-tile" href="/admin#audit"><strong>Admin access & audit →</strong><small>Review access controls and audit readiness.</small></a><a class="ac-tile" href="/dashboard"><strong>Member dashboard →</strong><small>Open the member experience separately.</small></a></div>'+(kycCount===null?'<div class="ac-alert"><strong>KYC needs setup.</strong> The KYC submission table is not available yet; submissions and review cannot work until the migration is applied.</div>':'')+'</section>';
    res.send(adminControlPage('Overview','/admin',content,req));
  } catch(e) { next(e); }
});

// Administrative sections are intentionally explicit: unsupported workflows are labelled as not connected,
// never filled with fake account or financial records. Main admin sections remain protected by requireAdmin.
const adminSectionInfo = {
  '/admin/deposits': ['Deposits','Review deposit requests and payment references.','A verified payment provider, deposit-request records, and an auditable ledger are not connected yet. No deposit can be approved or credited here.'],
  '/admin/withdrawals': ['Withdrawals','Review payout requests, fees, and processing status.','Payout processing and the ledger are not connected yet. Withdrawals remain disabled to prevent duplicate or unsafe deductions.'],
  '/admin/investments': ['Investments','Review investment packages and active investment records.','No verified investment records are connected to this control centre yet. No package returns or earnings are being fabricated.'],
  '/admin/transactions': ['Transactions','Inspect recorded financial transactions.','A unified transaction ledger is not connected yet. This page will not invent transactions or balances.'],
  '/admin/balances': ['Balance management','Record authorised credits, debits, bonuses, refunds, and adjustments.','Financial adjustments are unavailable until a transactional ledger and idempotent balance rules are implemented and verified.'],
  '/admin/earnings': ['Profits & bonuses','Review separately recorded profit and bonus operations.','No verified profit/bonus ledger is connected. Do not use this page to promise or fabricate earnings.'],
  '/admin/referrals': ['Referral monitoring','Review platform referral activity and eligible earnings.','Referral attribution exists in member registration, but platform-wide earnings and audit reporting are not yet connected here.'],
  '/admin/academy': ['Academy management','Manage learning content and eligible access.','The existing Academy management data source has not yet been connected to this control centre.'],
  '/admin/sovereign-desk': ['Sovereign Desk','Manage signals and guidance through the dedicated Desk workspace.','Signal records and publication workflows are not yet connected to this Main Admin section.'],
  '/admin/notifications': ['Notifications','Review administrative alerts and delivery status.','A persisted notification centre is not yet connected. No alerts are being presented as delivered.'],
  '/admin/settings': ['Platform settings','Review supported administrative configuration.','No safe platform-settings editor is connected. Sensitive configuration remains environment-managed.'],
  '/admin/audit': ['Audit & access','Review provisioned administrator access and audit readiness.','Administrator roles are read from the database. A complete immutable audit stream is not yet connected.']
};
for (const [route, info] of Object.entries(adminSectionInfo)) {
  app.get(route, requireAdmin, async (req,res,next) => {
    if (req.adminRole === 'sovereign_desk_admin') return res.status(403).send(page('Access denied','<h1>Access denied</h1><p class="muted">This section is reserved for Main Admin.</p><a class="btn" href="/sovereign-admin">Return to Sovereign Desk</a>'));
    try {
      const content = '<section class="ac-panel"><div class="ac-page-head"><div><h2>'+esc(info[0])+'</h2><p class="muted">'+esc(info[1])+'</p></div><span class="ac-pill">Not connected</span></div><div class="ac-coming"><span aria-hidden="true">◈</span><div><strong>Live backend connection required</strong><p>'+esc(info[2])+'</p></div></div><p class="muted small">This status is deliberate: no mock records, balances, payment approvals, or signal results are shown as real.</p></section>';
      res.send(adminControlPage(info[0],route,content,req));
    } catch(e) { next(e); }
  });
}
app.get('/admin/members', requireAdmin, async (req,res,next)=>{
  try {
    const [rows] = await pool.query('SELECT m.id,m.username,m.full_name,m.email,m.monarch_uid,au.role,au.is_active FROM members m LEFT JOIN admin_users au ON au.member_id=m.id ORDER BY m.id DESC LIMIT 200');
    const table=rows.map(m=>'<tr><td>'+esc(m.id)+'</td><td><strong>'+esc(m.username)+'</strong><br><small>'+esc(m.full_name||'')+'</small></td><td>'+esc(m.email)+'</td><td>'+esc(m.monarch_uid||'—')+'</td><td>'+esc(m.role?m.role.replace(/_/g,' '):'Member')+'</td><td>'+esc(m.role?(Number(m.is_active)?'Active admin':'Inactive admin'):'Member account')+'</td></tr>').join('');
    const content='<section class="ac-panel"><h2>Member accounts</h2><p class="muted">Showing up to 200 most recently created accounts. Admin status is sourced from the admin access table.</p><div class="ac-table-wrap"><table class="ac-table"><thead><tr><th>ID</th><th>Account</th><th>Email</th><th>Monarch ID</th><th>Role</th><th>Status</th></tr></thead><tbody>'+(table||'<tr><td colspan="6">No accounts found.</td></tr>')+'</tbody></table></div></section>';
    res.send(adminControlPage('Members','/admin/members',content,req));
  } catch(e){next(e);}
});

app.get('/admin/kyc/:id', requireAdmin, async (req,res,next) => {
  try {
    const id=String(req.params.id||''); if(!/^\d{1,20}$/.test(id)) return res.sendStatus(400);
    const [rows]=await pool.execute('SELECT k.*,m.username,m.monarch_uid FROM kyc_submissions k JOIN members m ON m.id=k.member_id WHERE k.id=? LIMIT 1',[id]);
    if(!rows.length) return res.status(404).send(page('Not found','<h1>KYC submission not found</h1><a class="btn" href="/admin/kyc">Back to queue</a>'));
    const k=rows[0]; let docNumber='Unable to decrypt with current key';
    try { docNumber=decryptKycBuffer(Buffer.from(k.document_number_ciphertext||'','base64'),getKycStorageConfig().key).toString('utf8'); } catch (_) {}
    const fields=[['Member',k.username+' ('+k.monarch_uid+')'],['Full legal name',k.legal_full_name],['Date of birth',k.date_of_birth],['Email',k.contact_email],['Phone',k.phone_number],['Country',k.country_code],['State / region',k.state_region],['City / LGA',k.locality_lga],['Street address',k.street_address],['Document type',k.document_type],['Issuing country',k.document_issuer_country],['Document number',docNumber],['Submitted',k.submitted_at],['Status',k.status]];
    const details=fields.map(([a,b])=>'<div class="kyc-detail"><span>'+esc(a)+'</span><strong>'+esc(b==null?'—':b)+'</strong></div>').join('');
    const docs=[['front','Front of ID',k.document_front_private_key],['back','Back of ID',k.document_back_private_key],['selfie','Selfie',k.selfie_private_key]];
    const images=docs.map(([kind,label,key])=>key?'<figure class="kyc-doc"><figcaption>'+esc(label)+'</figcaption><img src="/admin/kyc/'+encodeURIComponent(id)+'/document/'+kind+'" alt="'+esc(label)+'"></figure>':'<div class="kyc-doc"><strong>'+esc(label)+'</strong><p class="muted">No image supplied.</p></div>').join('');
    const body='<style>.kyc-details{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.kyc-detail{padding:9px;border:1px solid #39352a;border-radius:10px;background:#111115;min-width:0;overflow-wrap:anywhere}.kyc-detail span{display:block;color:#aaa9b4;font-size:.78rem}.kyc-detail strong{display:block;margin-top:4px;font-size:.88rem;line-height:1.35}.kyc-doc-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;align-items:start}.kyc-doc{padding:9px;margin:0;border:1px solid #39352a;border-radius:10px;background:#111115;min-width:0;overflow:hidden}.kyc-doc figcaption{font-weight:600;font-size:.85rem}.kyc-doc img{display:block;width:100%;height:clamp(150px,22vw,260px);object-fit:contain;background:#080809;border-radius:8px;margin-top:8px}.kyc-review-form{display:grid;gap:10px}.kyc-review-form select,.kyc-review-form textarea{width:100%;padding:12px;background:#0d0d10;color:#fff;border:1px solid #45434c;border-radius:9px;font:inherit}.kyc-back-link{display:inline-flex;align-items:center;justify-content:center;gap:8px;margin-top:16px;padding:10px 15px;border:1px solid #6b5a1b;border-radius:10px;color:#f6d43c;background:#211d10;text-decoration:none;font-weight:700;line-height:1.25}.kyc-back-link:hover{background:#30280e;text-decoration:none}@media(max-width:760px){.kyc-details{grid-template-columns:repeat(2,minmax(0,1fr))}.kyc-doc-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.kyc-doc img{height:clamp(160px,40vw,240px)}}@media(max-width:420px){.kyc-details{grid-template-columns:1fr}.kyc-doc-grid{grid-template-columns:1fr}.kyc-doc img{height:240px}}</style><section class="ac-panel"><p class="muted">Private identity information is shown only to an authenticated administrator. Handle it as confidential data.</p><h2>Applicant information</h2><div class="kyc-details">'+details+'</div><h2 style="margin-top:24px">Identity images</h2><div class="kyc-doc-grid">'+images+'</div><h2 style="margin-top:24px">Review decision</h2><form class="kyc-review-form" method="post" action="/admin/kyc/'+esc(id)+'/review">'+csrfField(req)+'<label for="kycStatus">Decision</label><select id="kycStatus" name="status" required><option value="pending" '+(k.status==='pending'?'selected':'')+'>Keep pending</option><option value="approved">Approve</option><option value="rejected">Reject</option><option value="needs_resubmission">Request resubmission</option></select><label for="kycNote">Reviewer note (optional)</label><textarea id="kycNote" name="note" rows="3" maxlength="1000">'+esc(k.reviewer_note||'')+'</textarea><button class="btn" type="submit">Save review decision</button></form><a class="btn" href="/admin/kyc">Back to review queue</a></section>';
    res.send(adminControlPage('KYC applicant review','/admin/kyc',body,req));
  } catch(e){next(e);}
});
app.get('/admin/kyc/:id/document/:kind', requireAdmin, async(req,res,next)=>{
  try {
    const id=String(req.params.id||''),kind=String(req.params.kind||'');
    const cols={front:'document_front_private_key',back:'document_back_private_key',selfie:'selfie_private_key'};
    if(!/^\d{1,20}$/.test(id)||!Object.prototype.hasOwnProperty.call(cols,kind)) return res.sendStatus(404);
    const [rows]=await pool.execute('SELECT '+cols[kind]+' AS private_key FROM kyc_submissions WHERE id=? LIMIT 1',[id]);
    if(!rows.length||!rows[0].private_key||!/^[a-f0-9]{48}\.enc$/.test(rows[0].private_key)) return res.sendStatus(404);
    const config=getKycStorageConfig(),encrypted=fs.readFileSync(path.join(config.directory,rows[0].private_key)),image=decryptKycBuffer(encrypted,config.key);
    let mime=''; if(image.subarray(0,3).equals(Buffer.from([255,216,255])))mime='image/jpeg';else if(image.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))mime='image/png';else return res.sendStatus(415);
    res.set({'Content-Type':mime,'Content-Disposition':'inline','Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff'});return res.send(image);
  } catch(e){if(e.code==='ENOENT'||e.message==='Invalid encrypted KYC file.')return res.sendStatus(404);next(e);}
});
app.get('/admin/kyc', requireAdmin, async (req,res,next) => {
  try {
    const [rows] = await pool.query("SELECT id,member_id,legal_full_name,contact_email,document_type,document_issuer_country,document_number_last4,status,submitted_at FROM kyc_submissions ORDER BY submitted_at DESC LIMIT 200");
    const items = rows.map(row => '<tr><td>' + esc(row.id) + '</td><td><strong>' + esc(row.legal_full_name) + '</strong><br><small>' + esc(row.contact_email) + '</small><br><a href="/admin/kyc/' + encodeURIComponent(row.id) + '">View application &amp; images →</a></td><td>' + esc(row.document_type) + ' (' + esc(row.document_issuer_country) + ')<br><small>•••• ' + esc(row.document_number_last4) + '</small></td><td>' + esc(row.status) + '</td><td><a class="btn" href="/admin/kyc/' + encodeURIComponent(row.id) + '">Review application</a></td></tr>').join('');
    const body = '<div class="wrap"><h1>KYC review queue</h1><p class="muted">Documents are encrypted outside the public web directory. Open an application to inspect submitted information and images before making a review decision.</p><div class="panel" style="overflow:auto"><table style="width:100%;border-collapse:collapse"><thead><tr><th>ID</th><th>Member</th><th>Document</th><th>Status</th><th>Review</th></tr></thead><tbody>' + (items || '<tr><td colspan="5">No submissions yet.</td></tr>') + '</tbody></table></div><p><a class="btn" href="/admin">Back to admin</a></p></div><style>td,th{padding:12px;text-align:left;border-bottom:1px solid #39352a;vertical-align:top}td form{display:grid;gap:7px;min-width:190px}td input,td select{padding:9px;border-radius:8px;background:#0d0d10;color:#fff;border:1px solid #45434c}td small{color:#aaa}</style>';
    res.send(adminControlPage('KYC review','/admin/kyc', '<section class="ac-panel">' + body + '</section>', req));
  } catch(e) { next(e); }
});
app.post('/admin/kyc/:id/review', requireAdmin, express.urlencoded({extended:false,limit:'5kb'}), csrfCheck, async (req,res,next) => {
  const id = String(req.params.id || '');
  const status = req.body.status;
  const note = String(req.body.note || '').trim().slice(0,1000);
  if (!/^\d{1,20}$/.test(id) || !['pending','approved','rejected','needs_resubmission'].includes(status)) return res.status(400).send(page('Invalid review','<h1>Invalid review request</h1>'));
  try {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [found] = await conn.execute('SELECT id FROM kyc_submissions WHERE id = ? FOR UPDATE',[id]);
      if (!found.length) { await conn.rollback(); return res.status(404).send(page('Not found','<h1>KYC submission not found</h1>')); }
      await conn.execute('UPDATE kyc_submissions SET status = ?, reviewer_member_id = ?, reviewer_note = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?',[status,req.session.memberId,note || null,id]);
      await conn.execute('INSERT INTO kyc_review_events (submission_id,actor_member_id,event_type,note) VALUES (?,?,?,?)',[id,req.session.memberId,status,note || null]);
      await conn.commit();
    } catch(e) { await conn.rollback(); throw e; } finally { conn.release(); }
    return res.redirect('/admin/kyc');
  } catch(e) { next(e); }
});

app.get('/dashboard', requireAuth, async (req, res, next) => {