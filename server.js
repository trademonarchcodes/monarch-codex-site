const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const MySQLStoreFactory = require('express-mysql-session');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');
const nodemailer = require('nodemailer');
const rateLimit = require('express-rate-limit');
const path = require('node:path');

const app = express();
const port = Number(process.env.PORT || 3000);
const required = ['SESSION_SECRET', 'DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];
for (const key of required) if (!process.env[key]) console.warn('[config] Missing environment variable:', key);
if (process.env.NODE_ENV === 'production' && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) {
  throw new Error('SESSION_SECRET must be a random value of at least 32 characters in production.');
}
const dbOptions = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  charset: 'utf8mb4'
};
const pool = mysql.createPool({ ...dbOptions, waitForConnections: true, connectionLimit: 10, queueLimit: 0 });
const MySQLStore = MySQLStoreFactory(session);
const sessionStore = new MySQLStore({ ...dbOptions, clearExpired: true, checkExpirationInterval: 900000, expiration: 86400000, createDatabaseTable: false, schema: { tableName: 'web_sessions' } });

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: { directives: {
    defaultSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
    fontSrc: ["'self'", 'https://fonts.gstatic.com'], imgSrc: ["'self'", 'data:', 'https:'],
    scriptSrc: ["'self'", "'unsafe-inline'"], connectSrc: ["'self'"], objectSrc: ["'none'"],
    frameAncestors: ["'none'"], upgradeInsecureRequests: []
  } }, crossOriginEmbedderPolicy: false
}));
app.use(express.urlencoded({ extended: false, limit: '20kb' }));
app.use(express.json({ limit: '20kb' }));
app.use(session({
  name: 'monarch.sid',
  secret: process.env.SESSION_SECRET || 'development-only-change-this-secret',
  store: sessionStore, resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 86400000 }
}));
const authLimiter = rateLimit({ windowMs: 900000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false, message: 'Too many attempts. Please wait 15 minutes and try again.' });
const resetLimiter = rateLimit({ windowMs: 3600000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false, message: 'Too many reset requests. Please try again later.' });
const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
const page = (title, body) => '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#0b0b0c"><title>' + esc(title) + ' | Monarch Codex</title><style>' +
':root{color-scheme:dark;--gold:#f3cf3c;--bg:#0b0b0c;--panel:#17171c;--muted:#b8b6c0}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top,#252111 0,#0b0b0c 45%);color:#f7f5ef;font:16px/1.6 system-ui,-apple-system,Segoe UI,sans-serif;min-height:100vh}.wrap{width:min(100% - 32px,540px);margin:48px auto}.brand{font-weight:900;letter-spacing:.08em;color:var(--gold);text-decoration:none}.panel{margin-top:20px;padding:28px;background:rgba(23,23,28,.96);border:1px solid #55491e;border-radius:22px;box-shadow:0 18px 55px #0007}h1{line-height:1.2;font-size:clamp(1.7rem,5vw,2.3rem);margin:.25em 0}.muted{color:var(--muted)}label{display:block;font-weight:700;margin:15px 0 6px}input{width:100%;padding:13px 14px;border:1px solid #484650;border-radius:10px;background:#0d0d10;color:#fff;font:inherit}input:focus{outline:2px solid var(--gold);outline-offset:1px}.password-wrap{position:relative}.password-wrap input{padding-right:54px}.password-toggle{position:absolute;right:8px;top:50%;transform:translateY(-50%);width:40px;height:40px;display:grid;place-items:center;border:0;border-radius:8px;background:transparent;color:var(--muted);cursor:pointer}.password-toggle:hover,.password-toggle:focus-visible{color:var(--gold);outline:2px solid var(--gold)}.password-toggle svg{width:21px;height:21px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.btn{display:inline-block;width:100%;margin-top:20px;padding:13px 16px;border:0;border-radius:999px;background:var(--gold);color:#121212;font:inherit;font-weight:900;text-align:center;text-decoration:none;cursor:pointer}.links{display:flex;gap:14px;flex-wrap:wrap;margin-top:18px}.links a{color:var(--gold)}.notice{padding:12px 14px;border:1px solid #625222;border-radius:10px;background:#27220f;margin:14px 0}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.stat{padding:15px;border:1px solid #48412a;border-radius:12px}.stat strong{display:block;color:var(--gold);font-size:1.2rem;overflow-wrap:anywhere}.small{font-size:.88rem}footer{margin-top:24px;color:var(--muted);font-size:.85rem}@media(max-width:420px){.panel{padding:20px}.grid{grid-template-columns:1fr}}.wrap.dashboard-wrap{width:min(calc(100% - 32px),1100px);margin:32px auto}.dashboard-wrap .panel{padding:clamp(22px,3.5vw,40px)}.dashboard-wrap .grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.dashboard-wrap .stat{min-width:0}.dashboard-wrap #refLink{font-size:clamp(.85rem,1.5vw,1rem)}.dashboard-wrap .notice{overflow-wrap:anywhere}.dashboard-layout{display:grid;grid-template-columns:248px minmax(0,1fr);gap:24px;align-items:start;margin-top:26px;transition:grid-template-columns .22s ease}.dashboard-sidebar{position:sticky;top:18px;padding:14px;background:linear-gradient(180deg,#17171b,#101013);border:1px solid #3d3520;border-radius:18px;box-shadow:0 16px 40px #0003;min-width:0}.sidebar-brand-row{padding:4px 4px 16px}.dashboard-sidebar .side-title{color:var(--gold);font-size:.7rem;font-weight:900;letter-spacing:.14em;padding:4px 6px 12px}.dashboard-sidebar nav{display:grid;gap:7px}.dashboard-sidebar a{display:flex;align-items:center;gap:12px;min-height:46px;padding:11px 12px;border-radius:12px;color:#d7d4cb;text-decoration:none;font-weight:650;transition:background .16s ease,color .16s ease,transform .16s ease}.dashboard-sidebar nav a svg{flex:0 0 21px;width:21px;height:21px;color:#aaa38c}.dashboard-sidebar a:hover,.dashboard-sidebar a:focus-visible,.dashboard-sidebar a[aria-current="page"]{background:linear-gradient(90deg,#3a3014,#262111);color:var(--gold);outline:none}.dashboard-sidebar a[aria-current="page"] svg{color:var(--gold)}.dashboard-sidebar a:hover{transform:translateX(2px)}.dashboard-section[hidden]{display:none}.dashboard-content{min-width:0}.dashboard-content .panel{margin-top:0;padding:clamp(20px,3vw,34px)}.dashboard-layout.sidebar-collapsed{grid-template-columns:78px minmax(0,1fr)}.dashboard-layout.sidebar-collapsed .dashboard-sidebar{padding:12px 9px}.dashboard-layout.sidebar-collapsed .sidebar-brand-row{justify-content:center}.dashboard-layout.sidebar-collapsed .side-title,.dashboard-layout.sidebar-collapsed .nav-text{display:none}.dashboard-layout.sidebar-collapsed .dashboard-sidebar nav a{justify-content:center;padding:12px 8px}.sidebar-desktop-toggle{display:inline-grid}.sidebar-scrim{display:none}.dashboard-section{scroll-margin-top:20px;margin-bottom:24px}.dashboard-section:last-child{margin-bottom:0}.dashboard-section h2{font-size:1.35rem;margin:0 0 8px}.section-card{padding:20px;border:1px solid #403a27;border-radius:14px;background:#111115;margin-top:14px}.section-card p:last-child{margin-bottom:0}.dashboard-topline{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap}.dashboard-topline .btn{width:auto;margin:0;padding:10px 18px}.dashboard-content .grid{grid-template-columns:repeat(2,minmax(0,1fr))}.dashboard-content .stat{min-width:0}@media(max-width:760px){.dashboard-layout,.dashboard-layout.sidebar-collapsed{grid-template-columns:1fr;gap:14px}.dashboard-sidebar,.dashboard-layout.sidebar-collapsed .dashboard-sidebar{position:fixed;z-index:1002;left:12px;top:12px;bottom:12px;width:min(300px,calc(100vw - 48px));overflow-y:auto;transform:translateX(calc(-100% - 20px));transition:transform .22s ease;box-shadow:0 24px 70px #0009}.dashboard-layout.sidebar-open .dashboard-sidebar{transform:translateX(0)}.dashboard-sidebar .side-title,.dashboard-layout.sidebar-collapsed .side-title{display:block}.dashboard-sidebar nav{display:grid;gap:6px}.dashboard-sidebar a{white-space:normal}.sidebar-desktop-toggle{display:none}.dashboard-content .panel{padding:18px}.dashboard-content .grid{grid-template-columns:1fr}.sidebar-scrim{position:fixed;inset:0;z-index:1001;border:0;background:#000a;display:block;opacity:0;visibility:hidden;transition:opacity .22s ease,visibility .22s ease}.dashboard-layout.sidebar-open .sidebar-scrim{opacity:1;visibility:visible}}@media(max-width:560px){.wrap.dashboard-wrap{width:calc(100% - 24px);margin:18px auto}.dashboard-wrap .panel{padding:18px}.dashboard-wrap .grid{grid-template-columns:1fr}.dashboard-wrap .btn{min-height:48px}}' +
'.icon-btn{display:inline-grid;place-items:center;width:42px;height:42px;flex:0 0 42px;border:1px solid #514721;border-radius:12px;background:#17171c;color:#f3cf3c;cursor:pointer}.icon-btn svg,.dashboard-sidebar nav a svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.sidebar-brand-row{display:flex;align-items:center;justify-content:space-between;gap:8px}.sidebar-brand-row .side-title{padding:4px 10px 12px}.dashboard-sidebar nav a{display:flex;align-items:center;gap:12px}.dashboard-sidebar nav a svg{flex:0 0 20px}.sidebar-scrim,.mobile-dashboard-bar{display:none}.mobile-current-tab{color:var(--gold);font-weight:800;margin-left:auto}.dashboard-topline h1{letter-spacing:-.035em}.dashboard-content>.panel{border-color:#4b421f;box-shadow:0 24px 70px #0005}.dashboard-section h2{letter-spacing:-.02em}.dashboard-section .stat{background:linear-gradient(145deg,#17171c,#101013);padding:22px}.dashboard-section .stat strong{font-size:1.35rem}.dashboard-sidebar{border-color:#373224;box-shadow:0 16px 42px #0003}.dashboard-sidebar a{transition:background .18s ease,color .18s ease,transform .18s ease}.dashboard-sidebar a:hover{transform:translateX(2px)}@media(max-width:760px){.dashboard-layout{grid-template-columns:1fr}.dashboard-sidebar{position:fixed;z-index:1002;left:12px;top:12px;bottom:12px;width:min(290px,calc(100vw - 48px));overflow-y:auto;transform:translateX(calc(-100% - 20px));transition:transform .22s ease;box-shadow:0 24px 70px #0009}.dashboard-layout.sidebar-open .dashboard-sidebar{transform:translateX(0)}.sidebar-scrim{position:fixed;inset:0;z-index:1001;border:0;background:#000a;display:block;opacity:0;visibility:hidden;transition:opacity .22s ease,visibility .22s ease}.dashboard-layout.sidebar-open .sidebar-scrim{opacity:1;visibility:visible}.sidebar-close{display:inline-grid}.mobile-dashboard-bar{display:flex;align-items:center;gap:12px;margin:0 0 12px;padding:10px 12px;border:1px solid #3d3620;border-radius:14px;background:#111115;color:#b8b6c0;font-size:.78rem;font-weight:800;letter-spacing:.08em}.dashboard-content .panel{padding:clamp(18px,4vw,28px)}.dashboard-topline{align-items:flex-start}.dashboard-topline h1{font-size:clamp(1.7rem,6vw,2.25rem)}.dashboard-sidebar nav{display:grid;overflow:visible;padding:8px 0}.dashboard-sidebar a{white-space:normal}.dashboard-sidebar .side-title{padding:10px}.dashboard-layout.sidebar-open{overflow:hidden}}@media(min-width:761px){.sidebar-close{display:none}.sidebar-scrim{display:none!important}}'</style></head><body><main class="wrap' + (title === 'Member dashboard' ? ' dashboard-wrap' : '') + '"><a class="brand" href="/">MONARCH CODEX</a><section class="panel">' + body + '</section><footer>© ' + new Date().getFullYear() + ' Monarch Codex. All rights reserved.</footer></main><script>function togglePassword(id,button){var input=document.getElementById(id);if(!input||!button)return;var show=input.type==="password";input.type=show?"text":"password";button.setAttribute("aria-label",show?"Hide password":"Show password");button.setAttribute("title",show?"Hide password":"Show password");button.setAttribute("aria-pressed",show?"true":"false");var svg=button.querySelector("svg");if(svg){var slash=svg.querySelector("[data-eye-slash]");if(show&&!slash){slash=document.createElementNS("http://www.w3.org/2000/svg","path");slash.setAttribute("d","M3 3l18 18");slash.setAttribute("data-eye-slash","true");svg.appendChild(slash);}else if(!show&&slash){slash.remove();}}}if(document.querySelector("[data-dashboard-tab]")){var tabs=[].slice.call(document.querySelectorAll("[data-dashboard-tab]"));var sections=tabs.map(function(t){return document.getElementById(t.getAttribute("data-dashboard-tab"));}).filter(Boolean);var layout=document.querySelector(".dashboard-layout");var currentLabel=document.querySelector(".mobile-current-tab");function closeSidebar(){if(layout)layout.classList.remove("sidebar-open");document.body.style.overflow="";}function showDashboardTab(id){if(!sections.some(function(s){return s.id===id;}))id="overview";sections.forEach(function(s){s.hidden=s.id!==id;});tabs.forEach(function(t){if(t.getAttribute("data-dashboard-tab")===id)t.setAttribute("aria-current","page");else t.removeAttribute("aria-current");});if(currentLabel){var active=tabs.find(function(t){return t.getAttribute("data-dashboard-tab")===id;});currentLabel.textContent=active?active.textContent.trim():"Overview";}}function openSidebar(){if(layout)layout.classList.add("sidebar-open");document.body.style.overflow="hidden";}var collapseButton=document.querySelector("[data-sidebar-collapse]");if(collapseButton&&layout){collapseButton.addEventListener("click",function(){var collapsed=layout.classList.toggle("sidebar-collapsed");collapseButton.setAttribute("aria-expanded",collapsed?"false":"true");collapseButton.setAttribute("aria-label",collapsed?"Expand sidebar":"Collapse sidebar");collapseButton.setAttribute("title",collapsed?"Expand sidebar":"Collapse sidebar");});}document.querySelectorAll("[data-sidebar-open]").forEach(function(b){b.addEventListener("click",openSidebar);});document.querySelectorAll("[data-sidebar-close]").forEach(function(b){b.addEventListener("click",closeSidebar);});tabs.forEach(function(t){t.addEventListener("click",function(e){e.preventDefault();var id=t.getAttribute("data-dashboard-tab");showDashboardTab(id);if(history.replaceState)history.replaceState(null,"","#"+id);closeSidebar();});});document.addEventListener("keydown",function(e){if(e.key==="Escape")closeSidebar();});showDashboardTab(location.hash.slice(1)||"overview");}</script></body></html>';
function csrfToken(req) { if (!req.session.csrf) req.session.csrf = crypto.randomBytes(32).toString('hex'); return req.session.csrf; }
function csrfField(req) { return '<input type="hidden" name="_csrf" value="' + esc(csrfToken(req)) + '">'; }
function csrfCheck(req, res, next) {
  const supplied = req.body && req.body._csrf, expected = req.session.csrf;
  if (!supplied || !expected || Buffer.byteLength(String(supplied)) !== Buffer.byteLength(String(expected)) || !crypto.timingSafeEqual(Buffer.from(String(supplied)), Buffer.from(String(expected)))) {
    return res.status(403).send(page('Security check', '<h1>Security check expired</h1><p class="muted">Please return to the form and try again.</p><a class="btn" href="/login">Back to login</a>'));
  }
  next();
}
function requireAuth(req, res, next) { if (!req.session.memberId) return res.redirect('/login'); next(); }
function validEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254; }
function validUsername(username) { return /^[a-zA-Z0-9_]{3,30}$/.test(username); }
function formError(title, message, back) { return page(title, '<h1>' + esc(title) + '</h1><div class="notice">' + esc(message) + '</div><a class="btn" href="' + esc(back || '/register') + '">Go back</a>'); }
function registerForm(req, message) {
  return page('Create your account', '<h1>Become a Monarch</h1><p class="muted">Create your member account. Dashboard access begins after successful registration.</p>' +
  (message ? '<div class="notice">' + esc(message) + '</div>' : '') + '<form method="post" action="/register">' + csrfField(req) + '<input type="hidden" name="ref" value="' + esc(req.query.ref || '') + '">' +
  '<label for="fullName">Full name</label><input id="fullName" name="fullName" autocomplete="name" maxlength="120" required>' +
  '<label for="email">Email address</label><input id="email" name="email" type="email" autocomplete="email" maxlength="254" required>' +
  '<label for="phone">Phone number</label><input id="phone" name="phone" type="tel" autocomplete="tel" maxlength="32" required>' +
  '<label for="username">Username</label><input id="username" name="username" autocomplete="username" minlength="3" maxlength="30" pattern="[A-Za-z0-9_]{3,30}" title="Username cannot contain spaces. Use 3–30 letters, numbers or underscores." autocapitalize="none" spellcheck="false" required><p class="muted small">No spaces allowed. Use 3–30 letters, numbers or underscores.</p>' +
  '<label for="password">Password</label><div class="password-wrap"><input id="password" name="password" type="password" autocomplete="new-password" minlength="12" maxlength="128" required><button class="password-toggle" type="button" data-toggle-password="password" onclick="togglePassword(&quot;password&quot;,this)" aria-label="Show password" title="Show password"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg></button></div><p class="muted small">Use at least 12 characters.</p>' +
  '<button class="btn" type="submit">Create account</button></form><div class="links"><a href="/login">Already a member? Log in</a></div>');
}
function loginForm(req, message) {
  return page('Member login', '<h1>Welcome back</h1><p class="muted">Sign in to your Monarch Codex account.</p>' +
  (message ? '<div class="notice">' + esc(message) + '</div>' : '') + '<form method="post" action="/login">' + csrfField(req) +
  '<label for="identity">Email or username</label><input id="identity" name="identity" autocomplete="username" required maxlength="254">' +
  '<label for="password">Password</label><div class="password-wrap"><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="128"><button class="password-toggle" type="button" data-toggle-password="password" onclick="togglePassword(&quot;password&quot;,this)" aria-label="Show password" title="Show password"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg></button></div>' +
  '<button class="btn" type="submit">Log in</button></form><div class="links"><a href="/forgot-password">Forgot password?</a><a href="/register">Create account</a></div>');
}
app.get('/health', async (_req, res) => { try { await pool.query('SELECT 1'); res.json({ ok: true, service: 'monarch-codex' }); } catch (_) { res.status(503).json({ ok: false, service: 'monarch-codex' }); } });
app.get('/register', (req, res) => res.send(registerForm(req)));
app.post('/register', authLimiter, csrfCheck, async (req, res, next) => {
  try {
    const fullName = String(req.body.fullName || '').trim(), email = String(req.body.email || '').trim().toLowerCase();
    const phone = String(req.body.phone || '').trim(), username = String(req.body.username || '').trim(), password = String(req.body.password || '');
    if (fullName.length < 2 || fullName.length > 120) return res.status(400).send(formError('Check your details', 'Enter your full name (2–120 characters).'));
    if (!validEmail(email)) return res.status(400).send(formError('Check your details', 'Enter a valid email address.'));
    if (!phone || phone.length > 32 || !/^[+()\d\s.-]{7,32}$/.test(phone)) return res.status(400).send(formError('Check your details', 'Enter a valid phone number.'));
    if (!validUsername(username) || /\s/.test(String(req.body.username || ''))) return res.status(400).send(formError('Check your details', 'Username cannot contain spaces. Use 3–30 letters, numbers or underscores.'));
    if (password.length < 12 || password.length > 128) return res.status(400).send(formError('Check your password', 'Use a password between 12 and 128 characters.'));
    const [existing] = await pool.execute('SELECT id FROM members WHERE email = ? OR username = ? LIMIT 1', [email, username]);
    if (existing.length) return res.status(409).send(formError('Account already exists', 'That email or username is already in use. Try logging in or choose another.', '/register'));
    let referrerId = null;
    const referralCode = String(req.body.ref || req.query.ref || '').trim().toUpperCase();
    if (/^MONARCH\d{6}$/.test(referralCode)) {
      const [referrers] = await pool.execute('SELECT id FROM members WHERE monarch_uid = ? LIMIT 1', [referralCode]);
      if (referrers.length) referrerId = referrers[0].id;
    }
    const passwordHash = await bcrypt.hash(password, 12);
    let insertedId = null;
    for (let attempt = 0; attempt < 12; attempt++) {
      const uid = 'MONARCH' + crypto.randomInt(0, 1000000).toString().padStart(6, '0');
      try {
        const [result] = await pool.execute('INSERT INTO members (monarch_uid, full_name, email, phone, username, password_hash, referred_by) VALUES (?, ?, ?, ?, ?, ?, ?)', [uid, fullName, email, phone, username, passwordHash, referrerId]);
        insertedId = result.insertId; break;
      } catch (e) {
        if (e && e.code === 'ER_DUP_ENTRY') {
          const [check] = await pool.execute('SELECT id FROM members WHERE email = ? OR username = ? LIMIT 1', [email, username]);
          if (check.length) return res.status(409).send(formError('Account already exists', 'That email or username is already in use.'));
          continue;
        }
        throw e;
      }
    }
    if (!insertedId) return res.status(503).send(formError('Please try again', 'We could not generate a unique member ID right now.'));
    req.session.regenerate(err => {
      if (err) return next(err);
      req.session.memberId = insertedId; req.session.csrf = crypto.randomBytes(32).toString('hex');
      req.session.save(saveErr => saveErr ? next(saveErr) : res.redirect('/dashboard'));
    });
  } catch (e) { next(e); }
});
app.get('/login', (req, res) => res.send(loginForm(req)));
app.post('/login', authLimiter, csrfCheck, async (req, res, next) => {
  try {
    const identity = String(req.body.identity || '').trim(), password = String(req.body.password || '');
    const [rows] = await pool.execute('SELECT id, password_hash FROM members WHERE email = ? OR username = ? LIMIT 1', [identity.toLowerCase(), identity]);
    const member = rows[0];
    const match = member ? await bcrypt.compare(password, member.password_hash) : false;
    if (!member || !match) return res.status(401).send(loginForm(req, 'The email/username or password is incorrect.'));
    req.session.regenerate(err => {
      if (err) return next(err);
      req.session.memberId = member.id; req.session.csrf = crypto.randomBytes(32).toString('hex');
      req.session.save(saveErr => saveErr ? next(saveErr) : res.redirect('/dashboard'));
    });
  } catch (e) { next(e); }
});
app.get('/dashboard', requireAuth, async (req, res, next) => {
  try {
    const [rows] = await pool.execute('SELECT id, monarch_uid, full_name, email, username FROM members WHERE id = ? LIMIT 1', [req.session.memberId]);
    const member = rows[0];
    if (!member) { req.session.destroy(() => res.redirect('/login')); return; }
    const [counts] = await pool.execute('SELECT COUNT(*) AS total FROM members WHERE referred_by = ?', [member.id]);
    const baseUrl = (process.env.APP_BASE_URL || 'https://monarchcodex.online').replace(/\/+$/, '');
    const referralLink = baseUrl + '/register?ref=' + encodeURIComponent(member.monarch_uid);
    const body = '<div class="dashboard-layout">' +
      '<button class="sidebar-scrim" type="button" data-sidebar-close aria-label="Close navigation"></button><aside class="dashboard-sidebar" id="memberSidebar"><div class="sidebar-brand-row"><div class="side-title">MEMBER MENU</div><button class="icon-btn sidebar-close sidebar-desktop-toggle" type="button" data-sidebar-collapse aria-label="Collapse sidebar" title="Collapse sidebar" aria-expanded="true"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6M4 4v16"/></svg></button><button class="icon-btn sidebar-close" type="button" data-sidebar-close aria-label="Close menu"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></div><nav aria-label="Member dashboard navigation">' +
      '<a href="#overview" data-dashboard-tab="overview" aria-current="page"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg><span class="nav-text">Overview</span></a><a href="#profile" data-dashboard-tab="profile"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg><span class="nav-text">Profile</span></a><a href="#kyc" data-dashboard-tab="kyc"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z"/><path d="m9 12 2 2 4-4"/></svg><span class="nav-text">KYC Verification</span></a><a href="#referrals" data-dashboard-tab="referrals"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3"/><path d="M3 20v-1a6 6 0 0 1 12 0v1M16 5a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 5v1"/></svg><span class="nav-text">Referrals</span></a><a href="#deposit" data-dashboard-tab="deposit"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M7 15h4"/></svg><span class="nav-text">Deposit</span></a>' +
      '</nav></aside><button class="sidebar-scrim" type="button" data-sidebar-close aria-label="Close navigation"></button><div class="dashboard-content"><div class="mobile-dashboard-bar"><button class="icon-btn sidebar-open" type="button" data-sidebar-open aria-label="Open navigation" aria-controls="memberSidebar"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg></button><span>MEMBER AREA</span><span class="mobile-current-tab">Overview</span></div><section class="panel">' +
      '<div class="dashboard-topline"><div><div class="muted small">MONARCH MEMBER AREA</div><h1>Welcome, ' + esc(member.full_name.split(' ')[0]) + '</h1><p class="muted">Your membership overview and account tools.</p></div>' +
      '<form method="post" action="/logout">' + csrfField(req) + '<button class="btn" type="submit">Log out</button></form></div>' +
      '<section id="overview" class="dashboard-section"><h2>Overview</h2><p class="muted">A quick look at your Monarch Codex account.</p>' +
      '<div class="grid"><div class="stat"><span class="muted small">Your Monarch ID</span><strong>' + esc(member.monarch_uid) + '</strong></div><div class="stat"><span class="muted small">Successful referrals</span><strong>' + (Number(counts[0].total) || 0) + '</strong></div></div></section>' +
      '<section id="profile" class="dashboard-section"><h2>Profile</h2><div class="section-card"><p><span class="muted">Full name</span><br><strong>' + esc(member.full_name) + '</strong></p><p><span class="muted">Email address</span><br><strong>' + esc(member.email) + '</strong></p><p><span class="muted">Username</span><br><strong>@' + esc(member.username) + '</strong></p><p class="muted small">Profile editing will be added in a future update.</p></div></section>' +
      '<section id="kyc" class="dashboard-section"><h2>KYC verification</h2><div class="section-card"><strong>Verification not yet available</strong><p class="muted">Identity verification has not been activated for this account. Do not send identity documents or sensitive personal information through this page.</p></div></section>' +
      '<section id="referrals" class="dashboard-section"><h2>Referrals</h2><p class="muted">Invite people to register using your personal link.</p><div class="section-card"><label for="refLink">Your personal referral link</label><input id="refLink" value="' + esc(referralLink) + '" readonly onclick="this.select()"><p class="muted small">Share this link to track registrations. No earnings or rewards are guaranteed.</p></div></section>' +
      '<section id="deposit" class="dashboard-section"><h2>Deposit</h2><div class="section-card"><strong>Deposits are not enabled yet</strong><p class="muted">Deposit processing will appear here after secure payment methods and transaction tracking have been configured. Do not send funds to an unverified account.</p></div></section>' +
      '</section></div></div>';
    res.send(page('Member dashboard', body));
  } catch (e) { next(e); }
});
app.post('/logout', csrfCheck, (req, res, next) => req.session.destroy(err => {
  if (err) return next(err);
  res.clearCookie('monarch.sid', { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
  res.redirect('/login');
}));
app.get('/forgot-password', (req, res) => res.send(page('Reset password', '<h1>Reset your password</h1><p class="muted">Enter your account email. If it exists, we will send reset instructions.</p><form method="post" action="/forgot-password">' + csrfField(req) + '<label for="email">Email address</label><input id="email" type="email" name="email" autocomplete="email" required maxlength="254"><button class="btn" type="submit">Send reset link</button></form><div class="links"><a href="/login">Back to login</a></div>')));
app.post('/forgot-password', resetLimiter, csrfCheck, async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const [rows] = await pool.execute('SELECT id, email FROM members WHERE email = ? LIMIT 1', [email]);
    if (rows.length && process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASSWORD) {
      const token = crypto.randomBytes(32).toString('hex'), tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      await pool.execute('UPDATE password_resets SET used_at = NOW() WHERE member_id = ? AND used_at IS NULL', [rows[0].id]);
      await pool.execute('INSERT INTO password_resets (member_id, token_hash, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 30 MINUTE))', [rows[0].id, tokenHash]);
      const transporter = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: String(process.env.SMTP_SECURE || 'false') === 'true', auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } });
      const link = (process.env.APP_BASE_URL || 'https://monarchcodex.online').replace(/\/+$/, '') + '/reset-password?token=' + token;
      await transporter.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to: rows[0].email, subject: 'Reset your Monarch Codex password', text: 'Use this one-time link within 30 minutes to reset your password: ' + link + '\nIf you did not request this, ignore this email.' });
    }
    res.send(page('Check your email', '<h1>Check your email</h1><p class="muted">If an account exists for that address and email delivery is configured, reset instructions will arrive shortly.</p><a class="btn" href="/login">Return to login</a>'));
  } catch (e) { next(e); }
});
app.get('/reset-password', async (req, res, next) => {
  try {
    const token = String(req.query.token || '');
    if (!/^[a-f0-9]{64}$/.test(token)) return res.status(400).send(formError('Invalid reset link', 'Request a new password reset link.', '/forgot-password'));
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const [rows] = await pool.execute('SELECT id FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > NOW() LIMIT 1', [tokenHash]);
    if (!rows.length) return res.status(400).send(formError('Expired reset link', 'Request a new password reset link.', '/forgot-password'));
    req.session.resetTokenHash = tokenHash;
    res.send(page('Choose a new password', '<h1>Choose a new password</h1><form method="post" action="/reset-password">' + csrfField(req) + '<label for="password">New password</label><div class="password-wrap"><input id="password" name="password" type="password" minlength="12" maxlength="128" autocomplete="new-password" required><button class="password-toggle" type="button" data-toggle-password="password" onclick="togglePassword(&quot;password&quot;,this)" aria-label="Show password" title="Show password"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg></button></div><button class="btn" type="submit">Update password</button></form>'));
  } catch (e) { next(e); }
});
app.post('/reset-password', resetLimiter, csrfCheck, async (req, res, next) => {
  try {
    const password = String(req.body.password || ''), tokenHash = req.session.resetTokenHash;
    if (password.length < 12 || password.length > 128) return res.status(400).send(formError('Check your password', 'Use a password between 12 and 128 characters.', '/forgot-password'));
    if (!tokenHash) return res.status(400).send(formError('Reset session expired', 'Request a new password reset link.', '/forgot-password'));
    const [rows] = await pool.execute('SELECT id, member_id FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > NOW() LIMIT 1', [tokenHash]);
    if (!rows.length) return res.status(400).send(formError('Expired reset link', 'Request a new password reset link.', '/forgot-password'));
    const hash = await bcrypt.hash(password, 12), conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute('UPDATE members SET password_hash = ? WHERE id = ?', [hash, rows[0].member_id]);
      await conn.execute('UPDATE password_resets SET used_at = NOW() WHERE member_id = ? AND used_at IS NULL', [rows[0].member_id]);
      await conn.commit();
    } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
    req.session.destroy(() => res.redirect('/login'));
  } catch (e) { next(e); }
});
app.use(express.static(path.join(__dirname), { index: 'index.html', dotfiles: 'ignore', maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));
app.use((req, res) => res.status(404).send(page('Not found', '<h1>Page not found</h1><a class="btn" href="/">Return to Monarch Codex</a>')));
app.use((err, _req, res, _next) => {
  console.error('[app error]', err && err.message ? err.message : 'Unknown error');
  if (res.headersSent) return;
  res.status(500).send(page('Something went wrong', '<h1>Something went wrong</h1><p class="muted">Please try again shortly.</p><a class="btn" href="/">Return home</a>'));
});
app.listen(port, () => console.log('Monarch Codex server listening on port', port));
