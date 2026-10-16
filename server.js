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
const fs = require('node:fs');
const multer = require('multer');

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
const depositProofDir = path.resolve(process.env.DEPOSIT_STORAGE_DIR || path.join(__dirname, '.private-deposit-proofs'));
const depositProofUpload = multer({
  storage: multer.diskStorage({
    destination(_req, _file, cb) { fs.mkdir(depositProofDir, { recursive: true, mode: 0o700 }, err => cb(err, depositProofDir)); },
    filename(_req, file, cb) {
      const ext = file.mimetype === 'application/pdf' ? '.pdf' : (file.mimetype === 'image/png' ? '.png' : (file.mimetype === 'image/webp' ? '.webp' : '.jpg'));
      cb(null, crypto.randomUUID() + ext);
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter(_req, file, cb) {
    if (!['image/jpeg','image/png','image/webp','application/pdf'].includes(file.mimetype)) return cb(new Error('Upload a JPG, PNG, WEBP or PDF payment proof.'));
    cb(null, true);
  }
});
function parseDepositProof(req,res,next) {
  depositProofUpload.single('payment_proof')(req,res,err => {
    if (err) return res.status(400).send(formError('Invalid payment proof', err.message || 'Choose a supported proof file under 5 MB.', '/deposit'));
    next();
  });
}
const MySQLStore = MySQLStoreFactory(session);
const sessionStore = new MySQLStore({ ...dbOptions, clearExpired: true, checkExpirationInterval: 900000, expiration: 86400000, createDatabaseTable: true, schema: { tableName: 'web_sessions' } });

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: { directives: {
    defaultSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
    fontSrc: ["'self'", 'https://fonts.gstatic.com'], imgSrc: ["'self'", 'data:', 'https:', 'blob:'],
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
const mailConfigured = () => Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASSWORD);
async function sendAppEmail({ to, subject, text, html }) {
  if (!mailConfigured()) { console.warn('[mail] SMTP is not configured; skipped email:', subject); return false; }
  const transporter = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 465), secure: String(process.env.SMTP_SECURE || 'true') === 'true', auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } });
  await transporter.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to, subject, text, ...(html ? { html } : {}) });
  return true;
}
const page = (title, body) => '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#0b0b0c"><title>' + esc(title) + ' | Monarch Codex</title><style>' +
':root{color-scheme:dark;--gold:#f3cf3c;--bg:#0b0b0c;--panel:#17171c;--muted:#b8b6c0}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top,#252111 0,#0b0b0c 45%);color:#f7f5ef;font:16px/1.6 system-ui,-apple-system,Segoe UI,sans-serif;min-height:100vh}.wrap{width:min(100% - 32px,540px);margin:48px auto}.brand{font-weight:900;letter-spacing:.08em;color:var(--gold);text-decoration:none}.panel{margin-top:20px;padding:28px;background:rgba(23,23,28,.96);border:1px solid #55491e;border-radius:22px;box-shadow:0 18px 55px #0007}h1{line-height:1.2;font-size:clamp(1.7rem,5vw,2.3rem);margin:.25em 0}.muted{color:var(--muted)}label{display:block;font-weight:700;margin:15px 0 6px}input{width:100%;padding:13px 14px;border:1px solid #484650;border-radius:10px;background:#0d0d10;color:#fff;font:inherit}input:focus{outline:2px solid var(--gold);outline-offset:1px}.password-wrap{position:relative}.password-wrap input{padding-right:54px}.password-toggle{position:absolute;right:8px;top:50%;transform:translateY(-50%);width:40px;height:40px;display:grid;place-items:center;border:0;border-radius:8px;background:transparent;color:var(--muted);cursor:pointer}.password-toggle:hover,.password-toggle:focus-visible{color:var(--gold);outline:2px solid var(--gold)}.password-toggle svg{width:21px;height:21px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.btn{display:inline-block;width:100%;margin-top:20px;padding:13px 16px;border:0;border-radius:999px;background:var(--gold);color:#121212;font:inherit;font-weight:900;text-align:center;text-decoration:none;cursor:pointer}.links{display:flex;gap:14px;flex-wrap:wrap;margin-top:18px}.links a{color:var(--gold)}.notice{padding:12px 14px;border:1px solid #625222;border-radius:10px;background:#27220f;margin:14px 0}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.stat{padding:15px;border:1px solid #48412a;border-radius:12px}.stat strong{display:block;color:var(--gold);font-size:1.2rem;overflow-wrap:anywhere}.small{font-size:.88rem}footer{margin-top:24px;color:var(--muted);font-size:.85rem}@media(max-width:420px){.panel{padding:20px}.grid{grid-template-columns:1fr}}.wrap.dashboard-wrap{width:min(calc(100% - 32px),1100px);margin:32px auto}.dashboard-wrap .panel{padding:clamp(22px,3.5vw,40px)}.dashboard-wrap .grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.dashboard-wrap .stat{min-width:0}.dashboard-wrap #refLink{font-size:clamp(.85rem,1.5vw,1rem)}.dashboard-wrap .notice{overflow-wrap:anywhere}.dashboard-layout{display:grid;grid-template-columns:248px minmax(0,1fr);gap:24px;align-items:start;margin-top:26px;transition:grid-template-columns .22s ease}.dashboard-sidebar{position:sticky;top:18px;padding:14px;background:linear-gradient(180deg,#17171b,#101013);border:1px solid #3d3520;border-radius:18px;box-shadow:0 16px 40px #0003;min-width:0}.sidebar-brand-row{padding:4px 4px 16px}.dashboard-sidebar .side-title{color:var(--gold);font-size:.7rem;font-weight:900;letter-spacing:.14em;padding:4px 6px 12px}.dashboard-sidebar nav{display:grid;gap:7px}.dashboard-sidebar a{display:flex;align-items:center;gap:12px;min-height:46px;padding:11px 12px;border-radius:12px;color:#d7d4cb;text-decoration:none;font-weight:650;transition:background .16s ease,color .16s ease,transform .16s ease}.dashboard-sidebar nav a svg{flex:0 0 21px;width:21px;height:21px;color:#aaa38c}.dashboard-sidebar a:hover,.dashboard-sidebar a:focus-visible,.dashboard-sidebar a[aria-current="page"]{background:linear-gradient(90deg,#3a3014,#262111);color:var(--gold);outline:none}.dashboard-sidebar a[aria-current="page"] svg{color:var(--gold)}.dashboard-sidebar a:hover{transform:translateX(2px)}.dashboard-section[hidden]{display:none}.dashboard-content{min-width:0}.dashboard-content .panel{margin-top:0;padding:clamp(20px,3vw,34px)}.sidebar-logout{border-top:1px solid #38311f;margin-top:18px;padding-top:14px}.sidebar-logout form{margin:0}.sidebar-logout-btn{width:100%;display:flex;align-items:center;gap:12px;min-height:46px;padding:11px 12px;border:1px solid #4b3028;border-radius:12px;background:#211514;color:#f0b3a7;font:inherit;font-weight:700;text-align:left;cursor:pointer}.sidebar-logout-btn svg{width:20px;height:20px;flex:0 0 20px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.sidebar-logout-btn:hover,.sidebar-logout-btn:focus-visible{background:#35201d;outline:2px solid #6e3b32;outline-offset:2px}.dashboard-layout.sidebar-collapsed .sidebar-logout-btn{justify-content:center;padding:12px 8px}.dashboard-layout.sidebar-collapsed .sidebar-logout-btn .nav-text{display:none}.dashboard-layout.sidebar-collapsed{grid-template-columns:78px minmax(0,1fr)}.dashboard-layout.sidebar-collapsed .dashboard-sidebar{padding:12px 9px}.dashboard-layout.sidebar-collapsed .sidebar-brand-row{justify-content:center}.dashboard-layout.sidebar-collapsed .side-title,.dashboard-layout.sidebar-collapsed .nav-text{display:none}.dashboard-layout.sidebar-collapsed .dashboard-sidebar nav a{justify-content:center;padding:12px 8px}.sidebar-desktop-toggle{display:inline-grid}.sidebar-scrim{display:none}.dashboard-section{scroll-margin-top:20px;margin-bottom:24px}.dashboard-section:last-child{margin-bottom:0}.dashboard-section h2{font-size:1.35rem;margin:0 0 8px}.section-card{padding:20px;border:1px solid #403a27;border-radius:14px;background:#111115;margin-top:14px}.section-card p:last-child{margin-bottom:0}.dashboard-topline{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap}.dashboard-topline .btn{width:auto;margin:0;padding:10px 18px}.dashboard-content .grid{grid-template-columns:repeat(2,minmax(0,1fr))}.dashboard-content .stat{min-width:0}@media(max-width:760px){.dashboard-layout,.dashboard-layout.sidebar-collapsed{grid-template-columns:1fr;gap:14px}.dashboard-sidebar,.dashboard-layout.sidebar-collapsed .dashboard-sidebar{position:fixed;z-index:1002;left:12px;top:12px;bottom:12px;width:min(300px,calc(100vw - 48px));overflow-y:auto;transform:translateX(calc(-100% - 20px));transition:transform .22s ease;box-shadow:0 24px 70px #0009}.dashboard-layout.sidebar-open .dashboard-sidebar{transform:translateX(0)}.dashboard-sidebar .side-title,.dashboard-layout.sidebar-collapsed .side-title{display:block}.dashboard-sidebar nav{display:grid;gap:6px}.dashboard-sidebar a{white-space:normal}.sidebar-desktop-toggle{display:none}.dashboard-content .panel{padding:18px}.dashboard-content .grid{grid-template-columns:1fr}.sidebar-scrim{position:fixed;inset:0;z-index:1001;border:0;background:#000a;display:block;opacity:0;visibility:hidden;transition:opacity .22s ease,visibility .22s ease}.dashboard-layout.sidebar-open .sidebar-scrim{opacity:1;visibility:visible}}@media(max-width:560px){.wrap.dashboard-wrap{width:calc(100% - 24px);margin:18px auto}.dashboard-wrap .panel{padding:18px}.dashboard-wrap .grid{grid-template-columns:1fr}.dashboard-wrap .btn{min-height:48px}}' +
'.wrap.admin-wrap{width:calc(100% - 40px);max-width:none;margin:28px auto}.admin-wrap>.panel{padding:clamp(18px,2vw,30px);margin-top:18px}.admin-wrap .ac-layout{width:100%;max-width:none;grid-template-columns:270px minmax(0,1fr);gap:24px}.admin-wrap .ac-main{width:100%;min-width:0}.admin-wrap .ac-stats{grid-template-columns:repeat(3,minmax(0,1fr))}.admin-wrap .ac-tiles{grid-template-columns:repeat(2,minmax(0,1fr))}@media(min-width:1100px){.admin-wrap .ac-stats{grid-template-columns:repeat(4,minmax(0,1fr))}}@media(max-width:800px){.wrap.admin-wrap{width:calc(100% - 24px);margin:18px auto}.admin-wrap>.panel{padding:clamp(14px,3vw,22px)}.admin-wrap .ac-layout{display:block;width:100%}.admin-wrap .ac-stats{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:480px){.wrap.admin-wrap{width:calc(100% - 16px);margin:12px auto}.admin-wrap>.panel{padding:12px}.admin-wrap .ac-tiles{grid-template-columns:1fr}}.copy-value{display:flex;align-items:center;gap:10px;min-width:0;margin-top:8px}.copy-value strong{overflow-wrap:anywhere;min-width:0}.copy-value input{min-width:0;flex:1}.copy-btn{flex:0 0 auto;border:1px solid #65551e;border-radius:10px;background:#28220f;color:#f3cf3c;padding:10px 13px;font:inherit;font-size:.85rem;font-weight:800;cursor:pointer}.copy-btn:hover,.copy-btn:focus-visible{background:#3a3014;outline:2px solid #f3cf3c;outline-offset:2px}.icon-btn{display:inline-grid;place-items:center;width:42px;height:42px;flex:0 0 42px;border:1px solid #514721;border-radius:12px;background:#17171c;color:#f3cf3c;cursor:pointer}.icon-btn svg,.dashboard-sidebar nav a svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.sidebar-brand-row{display:flex;align-items:center;justify-content:space-between;gap:8px}.sidebar-brand-row .side-title{padding:4px 10px 12px}.dashboard-sidebar nav a{display:flex;align-items:center;gap:12px}.dashboard-sidebar nav a svg{flex:0 0 20px}.sidebar-scrim,.mobile-dashboard-bar{display:none}.mobile-current-tab{color:var(--gold);font-weight:800;margin-left:auto}.dashboard-topline h1{letter-spacing:-.035em}.dashboard-content>.panel{border-color:#4b421f;box-shadow:0 24px 70px #0005}.dashboard-section h2{letter-spacing:-.02em}.dashboard-section .stat{background:linear-gradient(145deg,#17171c,#101013);padding:22px}.dashboard-section .stat strong{font-size:1.35rem}.dashboard-sidebar{border-color:#373224;box-shadow:0 16px 42px #0003}.dashboard-sidebar a{transition:background .18s ease,color .18s ease,transform .18s ease}.dashboard-sidebar a:hover{transform:translateX(2px)}@media(max-width:760px){.dashboard-layout{grid-template-columns:1fr}.dashboard-sidebar{position:fixed;z-index:1002;left:12px;top:12px;bottom:12px;width:min(290px,calc(100vw - 48px));overflow-y:auto;transform:translateX(calc(-100% - 20px));transition:transform .22s ease;box-shadow:0 24px 70px #0009}.dashboard-layout.sidebar-open .dashboard-sidebar{transform:translateX(0)}.sidebar-scrim{position:fixed;inset:0;z-index:1001;border:0;background:#000a;display:block;opacity:0;visibility:hidden;transition:opacity .22s ease,visibility .22s ease}.dashboard-layout.sidebar-open .sidebar-scrim{opacity:1;visibility:visible}.sidebar-close{display:inline-grid}.mobile-dashboard-bar{display:flex;align-items:center;gap:12px;margin:0 0 12px;padding:10px 12px;border:1px solid #3d3620;border-radius:14px;background:#111115;color:#b8b6c0;font-size:.78rem;font-weight:800;letter-spacing:.08em}.dashboard-content .panel{padding:clamp(18px,4vw,28px)}.dashboard-topline{align-items:flex-start}.dashboard-topline h1{font-size:clamp(1.7rem,6vw,2.25rem)}.dashboard-sidebar nav{display:grid;overflow:visible;padding:8px 0}.dashboard-sidebar a{white-space:normal}.dashboard-sidebar .side-title{padding:10px}.dashboard-layout.sidebar-open{overflow:hidden}}@media(min-width:761px){.sidebar-close{display:none}.sidebar-scrim{display:none!important}}' + '</style></head><body><main class="wrap' + (title === 'Member dashboard' ? ' dashboard-wrap' : (body.includes('id="adminLayout"') ? ' admin-wrap' : '')) + '"><a class="brand" href="/">MONARCH CODEX</a><section class="panel">' + body + '</section><footer>© ' + new Date().getFullYear() + ' Monarch Codex. All rights reserved.</footer></main><script>document.querySelectorAll("[data-copy-target]").forEach(function(button){button.addEventListener("click",async function(){var target=document.getElementById(button.getAttribute("data-copy-target"));if(!target)return;var value=target.value!==undefined?target.value:target.textContent.trim();try{if(navigator.clipboard&&window.isSecureContext){await navigator.clipboard.writeText(value);}else{var temp=document.createElement("textarea");temp.value=value;temp.style.position="fixed";temp.style.opacity="0";document.body.appendChild(temp);temp.select();var ok=document.execCommand("copy");temp.remove();if(!ok)throw new Error("copy failed");}var original=button.textContent;button.textContent="Copied!";setTimeout(function(){button.textContent=original;},1400);}catch(_){if(target.select)target.select();button.textContent="Select and copy";}});});function togglePassword(id,button){var input=document.getElementById(id);if(!input||!button)return;var show=input.type==="password";input.type=show?"text":"password";button.setAttribute("aria-label",show?"Hide password":"Show password");button.setAttribute("title",show?"Hide password":"Show password");button.setAttribute("aria-pressed",show?"true":"false");var svg=button.querySelector("svg");if(svg){var slash=svg.querySelector("[data-eye-slash]");if(show&&!slash){slash=document.createElementNS("http://www.w3.org/2000/svg","path");slash.setAttribute("d","M3 3l18 18");slash.setAttribute("data-eye-slash","true");svg.appendChild(slash);}else if(!show&&slash){slash.remove();}}}document.addEventListener("click",function(e){var button=e.target.closest("[data-toggle-password]");if(!button)return;e.preventDefault();togglePassword(button.getAttribute("data-toggle-password"),button);});document.querySelectorAll("[data-password-toggle]").forEach(function(button){button.addEventListener("click",function(e){e.preventDefault();togglePassword(button.getAttribute("data-password-toggle"),button);});});if(document.querySelector("[data-dashboard-tab]")){var tabs=[].slice.call(document.querySelectorAll("[data-dashboard-tab]"));var sections=tabs.map(function(t){return document.getElementById(t.getAttribute("data-dashboard-tab"));}).filter(Boolean);var layout=document.querySelector(".dashboard-layout");var currentLabel=document.querySelector(".mobile-current-tab");function closeSidebar(){if(layout)layout.classList.remove("sidebar-open");document.body.style.overflow="";}function showDashboardTab(id){if(!sections.some(function(s){return s.id===id;}))id="overview";sections.forEach(function(s){s.hidden=s.id!==id;});tabs.forEach(function(t){if(t.getAttribute("data-dashboard-tab")===id)t.setAttribute("aria-current","page");else t.removeAttribute("aria-current");});if(currentLabel){var active=tabs.find(function(t){return t.getAttribute("data-dashboard-tab")===id;});currentLabel.textContent=active?active.textContent.trim():"Overview";}}function openSidebar(){if(layout)layout.classList.add("sidebar-open");document.body.style.overflow="hidden";}var collapseButton=document.querySelector("[data-sidebar-collapse]");if(collapseButton&&layout){collapseButton.addEventListener("click",function(){var collapsed=layout.classList.toggle("sidebar-collapsed");collapseButton.setAttribute("aria-expanded",collapsed?"false":"true");collapseButton.setAttribute("aria-label",collapsed?"Expand sidebar":"Collapse sidebar");collapseButton.setAttribute("title",collapsed?"Expand sidebar":"Collapse sidebar");});}document.querySelectorAll("[data-sidebar-open]").forEach(function(b){b.addEventListener("click",openSidebar);});document.querySelectorAll("[data-sidebar-close]").forEach(function(b){b.addEventListener("click",closeSidebar);});tabs.forEach(function(t){t.addEventListener("click",function(e){e.preventDefault();var id=t.getAttribute("data-dashboard-tab");showDashboardTab(id);if(history.replaceState)history.replaceState(null,"","#"+id);closeSidebar();});});document.addEventListener("keydown",function(e){if(e.key==="Escape")closeSidebar();});showDashboardTab(location.hash.slice(1)||"overview");var actionGrid=document.getElementById("quickActions"),more=document.getElementById("toggleActions");if(actionGrid&&more){more.addEventListener("click",function(){var expanded=actionGrid.classList.toggle("actions-expanded");more.setAttribute("aria-expanded",String(expanded));more.textContent=expanded?"Fewer actions":"More actions";});}}</script></body></html>';
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
function validUsername(username) { return /^[a-zA-Z0-9_]{6,30}$/.test(username); }
function formError(title, message, back) { return page(title, '<h1>' + esc(title) + '</h1><div class="notice">' + esc(message) + '</div><a class="btn" href="' + esc(back || '/register') + '">Go back</a>'); }
function dbSetupNotice(title, migrationPath) {
  const safePath = String(migrationPath || '').replaceAll('..', '').replace(/^\/+/, '');
  const migrationUrl = 'https://github.com/trademonarchcodes/monarch-codex-site/blob/main/' + safePath;
  return page(title || 'Database setup required',
    '<h1>Database setup required</h1>' +
    '<div class="notice">A required database table or column is missing. Please ask the site administrator to apply the indicated database migration in the correct database, then restart the application.</div>' +
    '<p class="muted">Required migration: <code>' + esc(safePath || 'not specified') + '</code></p>' +
    '<p><a href="' + esc(migrationUrl) + '" target="_blank" rel="noopener noreferrer">View migration file on GitHub</a></p>' +
    '<a class="btn" href="/admin">Return to admin</a>');
}
function registerForm(req, message) {
  const queryRef = String(req.query.ref || '').trim().toUpperCase();
  if (queryRef) req.session.registrationReferralCode = queryRef;
  const lockedRef = String(req.session.registrationReferralCode || '').trim().toUpperCase();
  const countries = [['+234','Nigeria'],['+1','United States / Canada'],['+44','United Kingdom'],['+233','Ghana'],['+254','Kenya'],['+27','South Africa'],['+91','India'],['+971','United Arab Emirates'],['+61','Australia'],['+353','Ireland'],['+49','Germany'],['+33','France']];
  const countryOptions = countries.map(([code,name]) => '<option value="' + code + '"' + (code === '+234' ? ' selected' : '') + '>' + name + ' (' + code + ')</option>').join('');
  const body = '<link rel="stylesheet" href="/member-dashboard.css"><style>.register-form{max-width:620px;margin:0 auto}.register-form .register-intro{color:#aaa7af;line-height:1.65;margin:8px 0 25px}.register-form .register-field{margin:0 0 17px}.register-form label{display:block;margin:0 0 7px;font-weight:650;color:#e9e5db}.register-form input,.register-form select{width:100%;box-sizing:border-box;min-height:47px;padding:12px 13px;border:1px solid #39363a;border-radius:11px;background:#111114;color:#f6f2e8;font:inherit}.register-form input:focus,.register-form select:focus{outline:2px solid #9e812c;outline-offset:1px;border-color:#d6b844}.register-form .password-wrap{display:flex;position:relative}.register-form .password-wrap input{padding-right:53px}.register-form .password-toggle{position:absolute;right:5px;top:5px;width:38px;height:37px;display:grid;place-items:center;border:0;border-radius:8px;background:#252219;color:#e6c84e;cursor:pointer}.register-form .password-toggle svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}.register-form .field-help{font-size:.78rem;color:#96929b;line-height:1.5;margin:7px 0 0}.register-form .password-rules{display:grid;gap:6px;margin:10px 0 0;padding:12px;border:1px solid #2e2c30;border-radius:10px;background:#0d0d10}.register-form .password-rules span{font-size:.78rem;color:#a7a3ac}.register-form .password-rules span:before{content:"○";display:inline-block;width:20px;color:#aaa}.register-form .password-rules .rule-pass{color:#8fdaa5}.register-form .password-rules .rule-pass:before{content:"✓";color:#8fdaa5}.register-form .field-error{color:#ff737d!important}.register-form .field-valid{color:#8fdaa5!important}.register-form .phone-row{display:grid;grid-template-columns:minmax(145px,.8fr) minmax(0,1.4fr);gap:9px}.register-form .register-consent{display:flex;align-items:flex-start;gap:11px;margin:22px 0 14px;padding:15px;border:1px solid #494126;border-radius:12px;background:#15140f}.register-form .register-consent input[type=checkbox]{width:20px;height:20px;min-height:20px;flex:0 0 20px;margin:3px 0 0;accent-color:#f3cf3c}.register-form .register-consent label{display:inline;margin:0;font-weight:600;line-height:1.6}.register-form .register-consent a{color:#f3cf3c;text-underline-offset:3px}.register-form .register-submit{width:100%;margin-top:5px;min-height:49px}.register-form .register-submit:disabled{opacity:.42;cursor:not-allowed;filter:grayscale(.55)}.register-form [aria-invalid=true]{border-color:#e05b66!important}.register-form .register-referral{border-top:1px solid #302d29;padding-top:19px;margin-top:21px}@media(max-width:420px){.register-form .phone-row{grid-template-columns:1fr}.register-form .register-field{margin-bottom:15px}}</style><section class="register-form"><div class="links" style="margin:0 0 18px"><a href="/">← Back to homepage</a></div><h1>Join Monarch Codex</h1><p class="register-intro">Create your account to access your personal dashboard, manage your membership and take your next steps with Monarch Codex.</p>' +
  (message ? '<div class="notice">' + esc(message) + '</div>' : '') + '<form id="registerForm" method="post" action="/register" novalidate>' + csrfField(req) +
  '<div class="register-field"><label for="fullName">Full name</label><input id="fullName" name="fullName" autocomplete="name" maxlength="120" required></div>' +
  '<div class="register-field"><label for="email">Email address</label><input id="email" name="email" type="email" autocomplete="email" maxlength="254" required></div>' +
  '<div class="register-field"><label for="phoneCountryCode">Phone number</label><div class="phone-row"><select id="phoneCountryCode" name="phoneCountryCode" aria-label="Country calling code">' + countryOptions + '</select><input id="phone" name="phone" type="tel" inputmode="tel" autocomplete="tel-national" maxlength="16" placeholder="e.g. 803 123 4567" required aria-describedby="phoneHelp"></div><p class="field-help" id="phoneHelp">Choose your country code and enter your number without the calling code.</p><p class="field-help" id="phoneFeedback" aria-live="polite"></p></div>' +
  '<div class="register-field"><label for="username">Username</label><input id="username" name="username" autocomplete="username" minlength="6" maxlength="30" pattern="[A-Za-z0-9_]{6,30}" title="Use 6–30 letters, numbers or underscores, with no spaces." autocapitalize="none" spellcheck="false" required aria-describedby="usernameFeedback"><p class="field-help" id="usernameFeedback" aria-live="polite">Use 6–30 letters, numbers or underscores. No spaces. Usernames must be unique.</p></div>' +
  '<div class="register-field"><label for="password">Password</label><div class="password-wrap"><input id="password" name="password" type="password" autocomplete="new-password" minlength="12" maxlength="128" required aria-describedby="passwordRules"><button class="password-toggle" type="button" data-password-toggle="password" aria-label="Show password" title="Show password"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg></button></div><div class="password-rules" id="passwordRules" aria-live="polite"><span data-rule="length">At least 12 characters</span><span data-rule="upper">At least one capital letter (A–Z)</span><span data-rule="number">At least one number (0–9)</span><span data-rule="special">At least one special symbol (e.g. ! @ # $)</span></div></div>' +
  '<div class="register-field"><label for="confirmPassword">Confirm password</label><div class="password-wrap"><input id="confirmPassword" name="confirmPassword" type="password" autocomplete="new-password" maxlength="128" required aria-describedby="confirmFeedback"><button class="password-toggle" type="button" data-password-toggle="confirmPassword" aria-label="Show confirmation password" title="Show confirmation password"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg></button></div><p class="field-help" id="confirmFeedback" aria-live="polite">Enter the same password again.</p></div>' +
  '<div class="register-field register-referral"><label for="referralCode">Referral code <span class="field-help">(optional)</span></label><input id="referralCode" name="referralCode" maxlength="20" autocapitalize="characters" value="' + esc(lockedRef) + '"' + (lockedRef ? ' readonly aria-describedby="referralHelp"' : '') + '><p id="referralHelp" class="field-help" aria-live="polite">' + (lockedRef ? 'This referral is linked to the person who invited you.' : 'Have a referral code? Enter it here.') + '</p></div>' +
  '<div class="register-consent"><input id="acceptPolicies" name="acceptPolicies" type="checkbox" required aria-describedby="consentHelp"><div><label for="acceptPolicies">I agree to the <a href="/terms.html" target="_blank" rel="noopener noreferrer">Terms &amp; Conditions</a> and <a href="/privacy.html" target="_blank" rel="noopener noreferrer">Privacy Policy</a>.</label><p class="field-help" id="consentHelp">Please read these policies before creating your account.</p></div></div><p class="field-help" id="formFeedback" aria-live="polite"></p><button class="btn register-submit" type="submit" disabled>Create my account</button></form><div class="links"><a href="/login">Already a member? Log in</a></div></section>' +
  '<script>(function(){var form=document.getElementById("registerForm");if(!form)return;var pw=document.getElementById("password"),confirm=document.getElementById("confirmPassword"),phone=document.getElementById("phone"),country=document.getElementById("phoneCountryCode"),feedback=document.getElementById("confirmFeedback"),phoneFeedback=document.getElementById("phoneFeedback"),formFeedback=document.getElementById("formFeedback");var referral=document.getElementById("referralCode"),referralHelp=document.getElementById("referralHelp");var username=document.getElementById("username"),usernameFeedback=document.getElementById("usernameFeedback"),referral=document.getElementById("referralCode"),referralHelp=document.getElementById("referralHelp"),referralState=true,referralRequest=0;function checkReferral(){var code=referral.value.trim().toUpperCase(),request=++referralRequest;if(!code){referralState=true;referralHelp.textContent="Referral code is optional.";referralHelp.className="field-help";referral.setAttribute("aria-invalid","false");canSubmit();return}if(!/^MONARCH[0-9]{6}$/.test(code)){referralState=false;referralHelp.textContent="Invalid referral code format. Check the code and try again.";referralHelp.className="field-help field-error";referral.setAttribute("aria-invalid","true");canSubmit();return}referralState=null;referralHelp.textContent="Checking referral code…";referralHelp.className="field-help";referral.setAttribute("aria-invalid","false");fetch("/api/referral-check?code="+encodeURIComponent(code),{credentials:"same-origin"}).then(function(response){if(!response.ok)throw new Error("check failed");return response.json()}).then(function(result){if(request!==referralRequest)return;if(result.exists){referralState=true;referralHelp.textContent="Referral code verified.";referralHelp.className="field-help field-valid";referral.setAttribute("aria-invalid","false")}else{referralState=false;referralHelp.textContent=result.error==="verification_unavailable"?"Could not verify the referral code. Please try again.":"Referral code does not exist. Please check it.";referralHelp.className="field-help field-error";referral.setAttribute("aria-invalid","true")}canSubmit()}).catch(function(){if(request!==referralRequest)return;referralState=false;referralHelp.textContent="Could not verify the referral code. Please try again.";referralHelp.className="field-help field-error";referral.setAttribute("aria-invalid","true");canSubmit()})}referral.addEventListener("input",checkReferral);function checkUsername(){var v=username.value;var ok=/^[A-Za-z0-9_]{6,30}$/.test(v);var message="";if(!v)message="Username is required.";else if(/\s/.test(v))message="Spaces are not allowed in usernames.";else if(v.length<6)message="Username must be at least 6 characters.";else if(v.length>30)message="Username cannot exceed 30 characters.";else if(!/^[A-Za-z0-9_]+$/.test(v))message="Use only letters, numbers and underscores.";else message="Format looks good. Username must be unique.";usernameFeedback.textContent=message;usernameFeedback.className="field-help "+(ok?"field-valid":(v?"field-error":""));username.setAttribute("aria-invalid",ok?"false":(v?"true":"false"));return ok}username.addEventListener("input",function(){checkUsername();canSubmit()});function checkPassword(){var v=pw.value;var checks={length:v.length>=12,upper:/[A-Z]/.test(v),number:/[0-9]/.test(v),special:/[^A-Za-z0-9\\s]/.test(v)};Object.keys(checks).forEach(function(k){var el=document.querySelector("[data-rule="+k+"]");if(el)el.classList.toggle("rule-pass",checks[k])});pw.setAttribute("aria-invalid",Object.values(checks).every(Boolean)?"false":"true");return Object.values(checks).every(Boolean)}function checkMatch(){if(!confirm.value){feedback.textContent="Enter the same password again.";feedback.className="field-help";confirm.setAttribute("aria-invalid","false");return false}var ok=pw.value===confirm.value;feedback.textContent=ok?"Passwords match.":"Passwords do not match.";feedback.className="field-help "+(ok?"field-valid":"field-error");confirm.setAttribute("aria-invalid",ok?"false":"true");return ok}function checkPhone(){var digits=phone.value.replace(/\\D/g,"");var code=country.value;var min=code==="+234"?10:7,max=code==="+234"?11:12;var ok=digits.length>=min&&digits.length<=max;phoneFeedback.textContent=phone.value?(ok?"Number length looks valid for the selected calling code.":"Check the number length for "+code+"."):"";phoneFeedback.className="field-help "+(phone.value?(ok?"field-valid":"field-error"):"");phone.setAttribute("aria-invalid",phone.value&&!ok?"true":"false");return ok}pw.addEventListener("input",function(){checkPassword();if(confirm.value)checkMatch()});confirm.addEventListener("input",checkMatch);phone.addEventListener("input",checkPhone);country.addEventListener("change",checkPhone);var consent=document.getElementById("acceptPolicies"),submitButton=form.querySelector(".register-submit");function canSubmit(){var basics=["fullName","email"].every(function(id){var el=document.getElementById(id);return el&&el.value.trim()&&el.checkValidity()})&&checkUsername();var ready=basics&&referralState===true&&checkPassword()&&checkMatch()&&checkPhone()&&consent.checked;submitButton.disabled=!ready;return ready}form.querySelectorAll("input,select").forEach(function(el){el.addEventListener("input",canSubmit);el.addEventListener("change",canSubmit)});form.addEventListener("submit",function(e){var valid=canSubmit()&&form.checkValidity();if(!valid){e.preventDefault();formFeedback.textContent=consent.checked?"Please complete all required fields correctly before continuing.":"Please accept the Terms & Conditions and Privacy Policy after completing your details.";formFeedback.className="field-help field-error";form.reportValidity()}});if(referral.value.trim())checkReferral();canSubmit()})();</script>';
  return page('Create your account', body);
}
function loginForm(req, message) {
  return page('Member login', '<div class="links" style="margin:0 0 18px"><a href="/">← Back to homepage</a></div><h1>Welcome back</h1><p class="muted">Sign in to your Monarch Codex account.</p>' +
  (message ? '<div class="notice">' + esc(message) + '</div>' : '') + '<form method="post" action="/login">' + csrfField(req) +
  '<label for="identity">Email or username</label><input id="identity" name="identity" autocomplete="username" required maxlength="254">' +
  '<label for="password">Password</label><div class="password-wrap"><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="128"><button class="password-toggle" type="button" data-toggle-password="password" onclick="togglePassword(&quot;password&quot;,this)" aria-label="Show password" title="Show password"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg></button></div>' +
  '<button class="btn" type="submit">Log in</button></form><div class="links"><a href="/forgot-password">Forgot password?</a><a href="/resend-verification">Resend verification email</a><a href="/register">Create account</a></div>');
}
app.get('/health', async (_req, res) => { try { await pool.query('SELECT 1'); res.json({ ok: true, service: 'monarch-codex' }); } catch (_) { res.status(503).json({ ok: false, service: 'monarch-codex' }); } });
app.get('/api/wallet-balances', requireAuth, async (req,res,next) => {
  try {
    const [rows]=await pool.execute('SELECT currency,balance FROM member_wallets WHERE member_id=?',[req.session.memberId]);
    let ngn=0,usd=0,rate=null;
    for(const row of rows){if(row.currency==='NGN')ngn=Number(row.balance)||0;if(row.currency==='USD')usd=Number(row.balance)||0;}
    const [[fx]]=await pool.query('SELECT base_usd_ngn_rate,markup_percent FROM deposit_pricing_settings WHERE id=1');
    if(fx && fx.base_usd_ngn_rate!==null)rate=Number(fx.base_usd_ngn_rate)*(1+Number(fx.markup_percent)/100);
    res.set('Cache-Control','no-store');
    res.json({ngn,usd,rate});
  } catch(e) {
    if(e.code==='ER_NO_SUCH_TABLE'){res.set('Cache-Control','no-store');return res.json({ngn:0,usd:0,rate:null,configured:false});}
    next(e);
  }
});
app.get('/api/referral-check', async (req, res) => { try { const code = String(req.query.code || '').trim().toUpperCase(); if (!/^MONARCH\d{6}$/.test(code)) return res.json({ exists: false }); const [rows] = await pool.execute('SELECT id FROM members WHERE monarch_uid = ? LIMIT 1', [code]); return res.json({ exists: rows.length > 0 }); } catch (_) { return res.status(503).json({ exists: false, error: 'verification_unavailable' }); } });
app.get('/register', (req, res) => res.send(registerForm(req)));
app.post('/register', authLimiter, csrfCheck, async (req, res, next) => {
  try {
    const fullName = String(req.body.fullName || '').trim(), email = String(req.body.email || '').trim().toLowerCase();
    const phoneDigits = String(req.body.phone || '').replace(/\D/g, ''), phoneCountryCode = String(req.body.phoneCountryCode || '+234').trim(), phone = phoneCountryCode + phoneDigits, username = String(req.body.username || '').trim(), password = String(req.body.password || ''), confirmPassword = String(req.body.confirmPassword || '');
    if (req.body.acceptPolicies !== 'on') return res.status(400).send(formError('Agreement required', 'Please accept the Terms & Conditions and Privacy Policy before creating your account.'));
    if (fullName.length < 2 || fullName.length > 120) return res.status(400).send(formError('Check your details', 'Enter your full name (2–120 characters).'));
    if (!validEmail(email)) return res.status(400).send(formError('Check your details', 'Enter a valid email address.'));
    if (!/^\+\d{1,4}$/.test(phoneCountryCode) || phoneDigits.length < (phoneCountryCode === '+234' ? 10 : 7) || phoneDigits.length > (phoneCountryCode === '+234' ? 11 : 12)) return res.status(400).send(formError('Check your details', 'Check your country calling code and phone number length.'));
    if (!validUsername(username) || /\s/.test(String(req.body.username || ''))) return res.status(400).send(formError('Check your details', 'Username must be 6–30 characters, with no spaces. Use only letters, numbers or underscores.'));
    if (password.length < 12 || password.length > 128 || !/[A-Z]/.test(password) || !/[0-9]/.test(password) || !/[^A-Za-z0-9\\s]/.test(password)) return res.status(400).send(formError('Check your password', 'Use 12–128 characters with a capital letter, a number and a special symbol.'));
    if (password !== confirmPassword) return res.status(400).send(formError('Check your password', 'Your passwords do not match. Please confirm your password again.'));
    const [existing] = await pool.execute('SELECT id, email, username FROM members WHERE LOWER(email) = LOWER(?) OR LOWER(username) = LOWER(?) LIMIT 1', [email, username]);
    if (existing.length) {
      const sameUsername = String(existing[0].username || '').toLowerCase() === username.toLowerCase();
      return res.status(409).send(formError(sameUsername ? 'Username already taken' : 'Account already exists', sameUsername ? 'That username is already in use. Please choose a different username.' : 'That email is already in use. Try logging in or choose another email.', '/register'));
    }
    let referrerId = null;
    const referralCode = String(req.session.registrationReferralCode || req.body.referralCode || req.query.ref || '').trim().toUpperCase();
    if (referralCode) {
      if (!/^MONARCH\d{6}$/.test(referralCode)) return res.status(400).send(formError('Invalid referral code', 'That referral code is not valid. Check it and try again.'));
      const [referrers] = await pool.execute('SELECT id FROM members WHERE monarch_uid = ? LIMIT 1', [referralCode]);
      if (!referrers.length) return res.status(400).send(formError('Referral code not found', 'That referral code does not exist. Please correct it or remove it.', '/register'));
      referrerId = referrers[0].id;
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
    const memberRows = await pool.execute('SELECT monarch_uid FROM members WHERE id = ? LIMIT 1', [insertedId]);
    const memberUid = memberRows[0][0].monarch_uid;
    sendAppEmail({ to: email, subject: 'Welcome to Monarch Codex', text: 'Hello ' + fullName + ',\n\nWelcome to Monarch Codex. Your account has been created successfully. Your Monarch ID is ' + memberUid + '.\n\nSign in at ' + (process.env.APP_BASE_URL || 'https://monarchcodex.online') + '/login. If you did not create this account, please contact support.' }).catch(e => console.error('[mail] Welcome email failed:', e.message));
    (async () => {
      const token = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      await pool.execute('UPDATE email_verification_tokens SET verified_at = NOW() WHERE member_id = ? AND verified_at IS NULL', [insertedId]);
      await pool.execute('INSERT INTO email_verification_tokens (member_id, token_hash, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 24 HOUR))', [insertedId, tokenHash]);
      const verifyLink = (process.env.APP_BASE_URL || 'https://monarchcodex.online').replace(/\/+$/, '') + '/verify-email?token=' + token;
      await sendAppEmail({ to: email, subject: 'Verify your Monarch Codex email', text: 'Hello ' + fullName + ',\n\nVerify your email address within 24 hours using this link: ' + verifyLink + '\n\nIf you did not create this account, you can ignore this email.' });
    })().catch(e => console.error('[mail] Verification email failed:', e.message));
    delete req.session.registrationReferralCode;
    return res.redirect('/verification-pending');
  } catch (e) { next(e); }
});
app.get('/verification-pending', (req, res) => res.send(page('Verify your email', '<h1>Check your inbox</h1><p class="muted">We sent a verification link to the email address you used to register. Open it within 24 hours before logging in.</p><a class="btn" href="/resend-verification">Resend verification email</a><div class="links"><a href="/login">Back to login</a></div>')));
app.get('/resend-verification', (req, res) => res.send(page('Resend verification', '<h1>Resend verification email</h1><p class="muted">Enter the email address you used to register.</p><form method="post" action="/resend-verification">' + csrfField(req) + '<label for="email">Email address</label><input id="email" name="email" type="email" maxlength="254" required><button class="btn" type="submit">Send verification link</button></form><div class="links"><a href="/login">Back to login</a></div>')));
app.post('/resend-verification', resetLimiter, csrfCheck, async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (validEmail(email)) {
      const [members] = await pool.execute('SELECT id, full_name, email, email_verified_at FROM members WHERE email = ? LIMIT 1', [email]);
      if (members.length && !members[0].email_verified_at) {
        const member = members[0], token = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        await pool.execute('UPDATE email_verification_tokens SET verified_at = NOW() WHERE member_id = ? AND verified_at IS NULL', [member.id]);
        await pool.execute('INSERT INTO email_verification_tokens (member_id, token_hash, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 24 HOUR))', [member.id, tokenHash]);
        const verifyLink = (process.env.APP_BASE_URL || 'https://monarchcodex.online').replace(/\/+$/, '') + '/verify-email?token=' + token;
        await sendAppEmail({ to: member.email, subject: 'Verify your Monarch Codex email', text: 'Hello ' + member.full_name + ',\n\nVerify your email address within 24 hours using this link: ' + verifyLink + '\n\nIf you did not create this account, you can ignore this email.' });
      }
    }
    return res.send(page('Check your email', '<h1>Check your email</h1><p class="muted">If an unverified account exists for that address, a new verification link will be sent shortly.</p><a class="btn" href="/login">Return to login</a>'));
  } catch (e) { next(e); }
});
app.get('/verify-email', async (req, res, next) => {
  try {
    const token = String(req.query.token || '');
    if (!/^[a-f0-9]{64}$/.test(token)) return res.status(400).send(page('Invalid verification link', '<h1>Invalid verification link</h1><p class="muted">Request a new verification email or contact support.</p><a class="btn" href="/login">Go to login</a>'));
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const [rows] = await pool.execute('SELECT id, member_id FROM email_verification_tokens WHERE token_hash = ? AND verified_at IS NULL AND expires_at > NOW() LIMIT 1', [tokenHash]);
    if (!rows.length) return res.status(400).send(page('Link expired', '<h1>This verification link is invalid or has expired</h1><p class="muted">Please contact support if you need a new verification link.</p><a class="btn" href="/login">Go to login</a>'));
    await pool.execute('UPDATE email_verification_tokens SET verified_at = NOW() WHERE id = ? AND verified_at IS NULL', [rows[0].id]);
    await pool.execute('UPDATE members SET email_verified_at = NOW() WHERE id = ? AND email_verified_at IS NULL', [rows[0].member_id]);
    await pool.execute('UPDATE email_verification_tokens SET verified_at = NOW() WHERE member_id = ? AND verified_at IS NULL', [rows[0].member_id]);
    return res.send(page('Email verified', '<h1>Email verified successfully</h1><p class="muted">Your Monarch Codex email address is now verified.</p><a class="btn" href="/login">Log in to your account</a>'));
  } catch (e) { next(e); }
});
app.get('/login', (req, res) => res.send(loginForm(req)));
app.post('/login', authLimiter, csrfCheck, async (req, res, next) => {
  try {
    const identity = String(req.body.identity || '').trim(), password = String(req.body.password || '');
    const [rows] = await pool.execute('SELECT id, password_hash, email_verified_at FROM members WHERE email = ? OR username = ? LIMIT 1', [identity.toLowerCase(), identity]);
    const member = rows[0];
    const match = member ? await bcrypt.compare(password, member.password_hash) : false;
    if (!member || !match) return res.status(401).send(loginForm(req, 'The email/username or password is incorrect.'));
    if (!member.email_verified_at) return res.status(403).send(loginForm(req, 'Please verify your email using the link we sent you before logging in. If you cannot find it, use the resend verification option below.'));
    req.session.regenerate(err => {
      if (err) return next(err);
      req.session.memberId = member.id; req.session.csrf = crypto.randomBytes(32).toString('hex');
      pool.execute('SELECT role FROM admin_users WHERE member_id = ? AND is_active = 1 LIMIT 1',[member.id])
        .then(([admins]) => {
          const destination = admins.length ? '/admin' : '/dashboard';
          req.session.save(saveErr => saveErr ? next(saveErr) : res.redirect(destination));
        })
        .catch(next);
    });
  } catch (e) { next(e); }
});

// Admin access is granted only by an explicit row in admin_users; email alone never grants privileges.
async function requireAdmin(req, res, next) {
  if (!req.session.memberId) return res.redirect('/login');
  try {
    const [rows] = await pool.execute(
      'SELECT role FROM admin_users WHERE member_id = ? AND is_active = 1 LIMIT 1',
      [req.session.memberId]
    );
    if (!rows.length) return res.status(403).send(page('Admin access required',
      '<h1>Admin access required</h1><p class="muted">This account has not been provisioned for administrator access. Sign in with an authorised admin account or contact the site owner.</p><a class="btn" href="/dashboard">Return to member dashboard</a>'));
    req.adminRole = rows[0].role;
    next();
  } catch (e) {
    if (e && e.code === 'ER_NO_SUCH_TABLE') return res.status(503).send(page('Admin setup required',
      '<h1>Admin setup required</h1><p class="muted">The admin database migration has not been applied yet. Apply migrations/002_admin_access.sql, then provision an admin account securely.</p><a class="btn" href="/dashboard">Return to dashboard</a>'));
    next(e);
  }
}
function adminControlPage(title, active, content, req) {
  const deskOnly = req.adminRole === 'sovereign_desk_admin';
  const nav = deskOnly ? [
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
  /* Consistent spacing across every admin workspace, not just the overview */
  .ac-main{padding:0 4px 28px}
  .ac-top{margin:8px 0 26px;padding:4px 0 18px;border-bottom:1px solid #28262a}
  .ac-stats{gap:15px}
  .ac-stat,.ac-panel{padding:clamp(16px,2vw,24px);border-radius:15px}
  .ac-stat{min-height:122px}
  .ac-stat strong{line-height:1.2;overflow-wrap:anywhere}
  .ac-panel{margin-top:20px}
  .ac-panel h2,.ac-panel h3{margin-bottom:12px}
  .ac-panel p{line-height:1.65}
  .ac-tiles{gap:14px}
  .ac-tile{padding:19px;min-height:104px}
  .ac-panel form label{display:block;margin:15px 0 6px;color:#d7d2c4;font-size:.86rem;font-weight:700}
  .ac-panel input:not([type=checkbox]):not([type=radio]):not([type=hidden]),.ac-panel select,.ac-panel textarea{display:block;box-sizing:border-box;width:100%;max-width:100%;min-height:44px;margin:0 0 10px;padding:10px 12px;border:1px solid #39363d;border-radius:10px;background:#0d0d10;color:#f4f1e8}
  .ac-panel textarea{min-height:96px;resize:vertical}
  .ac-panel details{margin-top:12px;padding:12px;border:1px solid #302d2b;border-radius:11px;background:#121215}
  .ac-panel summary{cursor:pointer;color:#e3ca62;font-weight:700;line-height:1.5}
  .ac-panel form .copy-btn,.ac-panel form .btn{margin:8px 8px 0 0;min-height:40px}
  .ac-table-wrap{border:1px solid #302d2b;border-radius:12px;background:#121215}
  .ac-table{min-width:680px}
  .ac-table th{position:sticky;top:0;background:#17171b}
  .ac-table td{line-height:1.55;overflow-wrap:anywhere;vertical-align:top}
  .ac-panel>.notice,.ac-panel>.ac-alert{margin:12px 0}
  @media(max-width:800px){.ac-main{padding:0}.ac-top{margin:2px 0 20px;padding-bottom:16px}.ac-stats{gap:10px}.ac-stat{min-height:110px}.ac-panel{margin-top:14px}.ac-table-wrap{margin-inline:-2px;max-width:100%}}
  @media(max-width:480px){.ac-top{gap:10px}.ac-top h1{margin:7px 0}.ac-stats{gap:8px}.ac-stat{min-height:100px;padding:12px}.ac-panel{padding:14px}.ac-table{min-width:680px}.ac-panel details{padding:10px}}

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
  if (['/admin/deposits','/admin/referrals','/admin/academy','/admin/sovereign-desk','/admin/notifications','/admin/audit','/admin/settings'].includes(route)) continue;
  app.get(route, requireAdmin, async (req,res,next) => {
    if (req.adminRole === 'sovereign_desk_admin') return res.status(403).send(page('Access denied','<h1>Access denied</h1><p class="muted">This section is reserved for Main Admin.</p><a class="btn" href="/sovereign-admin">Return to Sovereign Desk</a>'));
    try {
      const content = '<section class="ac-panel"><div class="ac-page-head"><div><h2>'+esc(info[0])+'</h2><p class="muted">'+esc(info[1])+'</p></div><span class="ac-pill">Not connected</span></div><div class="ac-coming"><span aria-hidden="true">◈</span><div><strong>Live backend connection required</strong><p>'+esc(info[2])+'</p></div></div><p class="muted small">This status is deliberate: no mock records, balances, payment approvals, or signal results are shown as real.</p></section>';
      res.send(adminControlPage(info[0],route,content,req));
    } catch(e) { next(e); }
  });
}
function requireFinanceAdmin(req,res,next) {
  requireAdmin(req,res,() => {
    if (!['super_admin','main_admin'].includes(req.adminRole)) return res.status(403).send(page('Main admin access required','<h1>Main admin access required</h1><p class="muted">Only Super Admin or Main Admin can change payment destinations, pricing, or approve deposits.</p><a class="btn" href="/admin">Return to admin</a>'));
    next();
  });
}
app.get('/admin/deposits', requireFinanceAdmin, async (req,res,next) => {
  try {
    const [[pricing]] = await pool.query('SELECT base_usd_ngn_rate,markup_percent,bank_fee_usd,wallet_fee_usd FROM deposit_pricing_settings WHERE id=1');
    const [methods] = await pool.query('SELECT * FROM deposit_payment_methods ORDER BY is_active DESC,currency,method_type,id DESC');
    const [requests] = await pool.query('SELECT d.*,m.username,m.full_name,m.email,p.label AS payment_label,p.method_type FROM deposit_requests d JOIN members m ON m.id=d.member_id JOIN deposit_payment_methods p ON p.id=d.payment_method_id ORDER BY d.created_at DESC LIMIT 150');
    const methodRows = methods.map(m => {
      const details = m.method_type === 'bank'
        ? '<strong>' + esc(m.bank_name || '') + '</strong><br>Account name: ' + esc(m.account_name || '') + '<br>Account number: ' + esc(m.account_number || '') + (m.bank_code ? '<br>Bank code: ' + esc(m.bank_code) : '')
        : '<strong>' + esc(m.wallet_network || '') + ' · ' + esc(m.wallet_asset || '') + '</strong><br><span style="overflow-wrap:anywhere">' + esc(m.wallet_address || '') + '</span>';
      return '<tr><td><strong>' + esc(m.label) + '</strong><br><small>' + esc(m.currency + ' · ' + m.method_type.toUpperCase()) + '</small></td><td>' + details + (m.instructions ? '<p class="muted small">' + esc(m.instructions) + '</p>' : '') + '</td><td>' + (Number(m.is_active) ? '<span class="ac-pill">Active</span>' : '<span class="ac-pill">Inactive</span>') + '</td><td><form method="post" action="/admin/deposits/methods/' + Number(m.id) + '/status">' + csrfField(req) + '<input type="hidden" name="is_active" value="' + (Number(m.is_active) ? '0' : '1') + '"><button class="copy-btn" type="submit">' + (Number(m.is_active) ? 'Deactivate' : 'Activate') + '</button></form><details style="margin-top:8px"><summary>Edit details</summary><form method="post" action="/admin/deposits/methods">' + csrfField(req) + '<input type="hidden" name="id" value="' + Number(m.id) + '"><label>Label</label><input name="label" maxlength="120" value="' + esc(m.label) + '" required><label>Currency</label><select name="currency"><option value="NGN"' + (m.currency==='NGN'?' selected':'') + '>NGN</option><option value="USD"' + (m.currency==='USD'?' selected':'') + '>USD</option></select><label>Method type</label><select name="method_type"><option value="bank"' + (m.method_type==='bank'?' selected':'') + '>Bank account</option><option value="wallet"' + (m.method_type==='wallet'?' selected':'') + '>Wallet address</option></select><label>Bank name</label><input name="bank_name" maxlength="120" value="' + esc(m.bank_name || '') + '"><label>Account name</label><input name="account_name" maxlength="160" value="' + esc(m.account_name || '') + '"><label>Account number</label><input name="account_number" maxlength="80" value="' + esc(m.account_number || '') + '"><label>Bank code (optional)</label><input name="bank_code" maxlength="80" value="' + esc(m.bank_code || '') + '"><label>Wallet network</label><input name="wallet_network" maxlength="80" value="' + esc(m.wallet_network || '') + '"><label>Wallet asset</label><input name="wallet_asset" maxlength="40" value="' + esc(m.wallet_asset || '') + '"><label>Wallet address</label><input name="wallet_address" maxlength="255" value="' + esc(m.wallet_address || '') + '"><label>Member instructions</label><textarea name="instructions" maxlength="1000" rows="3">' + esc(m.instructions || '') + '</textarea><button class="copy-btn" type="submit">Save changes</button></form></details></td></tr>';
    }).join('');
    const requestRows = requests.map(d => '<tr><td>#' + Number(d.id) + '<br><small>' + esc(d.created_at) + '</small></td><td><strong>' + esc(d.full_name || d.username) + '</strong><br><small>' + esc(d.email) + '</small></td><td>' + esc(d.currency + ' ' + Number(d.amount).toLocaleString('en-US',{maximumFractionDigits:8})) + '<br><small>Fee: ' + esc(d.currency + ' ' + Number(d.fee_amount).toLocaleString('en-US',{maximumFractionDigits:8})) + ' · Total: ' + esc(d.currency + ' ' + Number(d.total_due).toLocaleString('en-US',{maximumFractionDigits:8})) + '</small></td><td>' + esc(d.payment_label) + '<br><small>' + esc(d.payment_reference) + '</small><br><a href="/admin/deposits/' + Number(d.id) + '/proof">Download proof</a></td><td><span class="ac-pill">' + esc(d.status.toUpperCase()) + '</span>' + (d.reviewer_note ? '<p class="muted small">' + esc(d.reviewer_note) + '</p>' : '') + '</td><td>' + (d.status === 'pending' ? '<form method="post" action="/admin/deposits/' + Number(d.id) + '/review">' + csrfField(req) + '<label>Review note</label><input name="reviewer_note" maxlength="1000" placeholder="Verification notes"><button class="copy-btn" name="decision" value="approved" type="submit">Approve & credit</button> <button class="copy-btn" name="decision" value="rejected" type="submit">Reject</button></form>' : esc(d.reviewed_at || '—')) + '</td></tr>').join('');
    const effective = pricing && pricing.base_usd_ngn_rate !== null ? Number(pricing.base_usd_ngn_rate) * (1 + Number(pricing.markup_percent)/100) : null;
    const pricingSummary = effective === null ? 'Exchange rate not configured yet. Configure it in Platform settings before members can submit deposits.' : 'Final member conversion rate: ₦' + effective.toLocaleString('en-NG',{maximumFractionDigits:6}) + ' per $1. Bank fee: $' + Number(pricing.bank_fee_usd).toFixed(2) + '; wallet fee: $' + Number(pricing.wallet_fee_usd).toFixed(2) + '.';
    const content = '<section class="ac-panel"><div class="ac-page-head"><div><h2>Payment destinations</h2><p class="muted">Create and edit official bank accounts and wallet addresses. Inactive destinations are hidden from members. Existing methods are deactivated rather than deleted so deposit history remains intact.</p></div><a class="ac-pill" href="/admin/settings">Edit pricing →</a></div><p class="ac-alert">' + esc(pricingSummary) + '</p><details open><summary><strong>Add payment destination</strong></summary><form method="post" action="/admin/deposits/methods">' + csrfField(req) + '<label>Display label</label><input name="label" maxlength="120" placeholder="e.g. Monarch NGN Bank Transfer" required><label>Currency</label><select name="currency" required><option value="NGN">Naira (NGN)</option><option value="USD">US Dollars (USD)</option></select><label>Method type</label><select name="method_type" required><option value="bank">Bank account</option><option value="wallet">Wallet address</option></select><label>Bank name</label><input name="bank_name" maxlength="120"><label>Account name</label><input name="account_name" maxlength="160"><label>Account number</label><input name="account_number" maxlength="80"><label>Bank code (optional)</label><input name="bank_code" maxlength="80"><label>Wallet network</label><input name="wallet_network" maxlength="80" placeholder="e.g. TRC20"><label>Wallet asset</label><input name="wallet_asset" maxlength="40" placeholder="e.g. USDT"><label>Wallet address</label><input name="wallet_address" maxlength="255"><label>Instructions for members (optional)</label><textarea name="instructions" maxlength="1000" rows="3"></textarea><button class="btn" type="submit">Save payment destination</button></form></details><div class="ac-table-wrap"><table class="ac-table"><thead><tr><th>Destination</th><th>Payment details</th><th>Status</th><th>Manage</th></tr></thead><tbody>' + (methodRows || '<tr><td colspan="4">No payment destinations configured. Add a verified bank account or wallet address above.</td></tr>') + '</tbody></table></div></section><section class="ac-panel"><h2>Deposit requests</h2><p class="muted">Requests stay pending until an administrator independently verifies the incoming payment. Approval credits the selected currency wallet exactly once.</p><div class="ac-table-wrap"><table class="ac-table"><thead><tr><th>Request</th><th>Member</th><th>Amount & fee</th><th>Destination / reference</th><th>Status</th><th>Review</th></tr></thead><tbody>' + (requestRows || '<tr><td colspan="6">No deposit requests yet.</td></tr>') + '</tbody></table></div></section>';
    res.send(adminControlPage('Deposits','/admin/deposits',content,req));
  } catch(e) { if(e.code === 'ER_NO_SUCH_TABLE') return res.status(503).send(dbSetupNotice('Deposit workflow setup required','migrations/006_deposit_payment_workflow.sql')); next(e); }
});
app.post('/admin/deposits/methods', requireFinanceAdmin, express.urlencoded({extended:false,limit:'10kb'}), csrfCheck, async (req,res,next) => {
  const id = String(req.body.id || '').trim();
  const type = String(req.body.method_type || '');
  const currency = String(req.body.currency || '');
  const label = String(req.body.label || '').trim().slice(0,120);
  const bankName = String(req.body.bank_name || '').trim().slice(0,120);
  const accountName = String(req.body.account_name || '').trim().slice(0,160);
  const accountNumber = String(req.body.account_number || '').trim().slice(0,80);
  const bankCode = String(req.body.bank_code || '').trim().slice(0,80);
  const walletNetwork = String(req.body.wallet_network || '').trim().slice(0,80);
  const walletAsset = String(req.body.wallet_asset || '').trim().slice(0,40);
  const walletAddress = String(req.body.wallet_address || '').trim().slice(0,255);
  const instructions = String(req.body.instructions || '').trim().slice(0,1000);
  if (!label || !['bank','wallet'].includes(type) || !['NGN','USD'].includes(currency) || (type==='bank' && (!bankName || !accountName || !accountNumber)) || (type==='wallet' && (!walletNetwork || !walletAsset || !walletAddress))) {
    return res.status(400).send(page('Check payment details','<h1>Check payment details</h1><p class="muted">Bank methods need a bank name, account name and account number. Wallet methods need a network, asset and address.</p><a class="btn" href="/admin/deposits">Return to deposits</a>'));
  }
  try {
    const values=[type,currency,label,bankName||null,accountName||null,accountNumber||null,bankCode||null,walletNetwork||null,walletAsset||null,walletAddress||null,instructions||null];
    if (id) {
      if (!/^\d{1,20}$/.test(id)) return res.status(400).send(page('Invalid payment destination','<h1>Invalid payment destination</h1><a class="btn" href="/admin/deposits">Return to deposits</a>'));
      const [result]=await pool.execute('UPDATE deposit_payment_methods SET method_type=?,currency=?,label=?,bank_name=?,account_name=?,account_number=?,bank_code=?,wallet_network=?,wallet_asset=?,wallet_address=?,instructions=? WHERE id=?',[...values,id]);
      if (!result.affectedRows) return res.status(404).send(page('Destination not found','<h1>Payment destination not found</h1><a class="btn" href="/admin/deposits">Return to deposits</a>'));
    } else {
      await pool.execute('INSERT INTO deposit_payment_methods (method_type,currency,label,bank_name,account_name,account_number,bank_code,wallet_network,wallet_asset,wallet_address,instructions,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',[...values,req.session.memberId]);
    }
    await pool.execute('INSERT INTO admin_audit_log (admin_member_id,action,target_type,target_id,details,ip_address) VALUES (?,?,?,?,?,?)',[req.session.memberId,id?'deposit.method.updated':'deposit.method.created','deposit_payment_method',id||'new',JSON.stringify({method_type:type,currency,label}),req.ip||null]);
    res.redirect('/admin/deposits');
  } catch(e) { if(e.code === 'ER_NO_SUCH_TABLE') return res.status(503).send(dbSetupNotice('Deposit workflow setup required','migrations/006_deposit_payment_workflow.sql')); next(e); }
});
app.post('/admin/deposits/methods/:id/status', requireFinanceAdmin, express.urlencoded({extended:false,limit:'5kb'}), csrfCheck, async (req,res,next) => {
  const id=String(req.params.id||''), active=String(req.body.is_active||'');
  if (!/^\d{1,20}$/.test(id) || !['0','1'].includes(active)) return res.status(400).send(page('Invalid destination status','<h1>Invalid destination status</h1><a class="btn" href="/admin/deposits">Return to deposits</a>'));
  try {
    const [result]=await pool.execute('UPDATE deposit_payment_methods SET is_active=? WHERE id=?',[Number(active),id]);
    if (!result.affectedRows) return res.status(404).send(page('Destination not found','<h1>Payment destination not found</h1><a class="btn" href="/admin/deposits">Return to deposits</a>'));
    await pool.execute('INSERT INTO admin_audit_log (admin_member_id,action,target_type,target_id,details,ip_address) VALUES (?,?,?,?,?,?)',[req.session.memberId,Number(active)?'deposit.method.activated':'deposit.method.deactivated','deposit_payment_method',id,JSON.stringify({is_active:Number(active)}),req.ip||null]);
    res.redirect('/admin/deposits');
  } catch(e) { if(e.code === 'ER_NO_SUCH_TABLE') return res.status(503).send(dbSetupNotice('Deposit workflow setup required','migrations/006_deposit_payment_workflow.sql')); next(e); }
});
app.get('/admin/deposits/:id/proof', requireFinanceAdmin, async (req,res,next) => {
  try {
    const id=String(req.params.id||'');
    if (!/^\\d{1,20}$/.test(id)) return res.status(400).send(page('Invalid proof','<h1>Invalid payment proof</h1>'));
    const [[row]]=await pool.execute('SELECT proof_storage_key,proof_mime_type FROM deposit_requests WHERE id=?',[id]);
    if (!row || !row.proof_storage_key) return res.status(404).send(page('Proof not found','<h1>Payment proof not found</h1><a class="btn" href="/admin/deposits">Return to deposits</a>'));
    const fileName=path.basename(row.proof_storage_key), filePath=path.resolve(depositProofDir,fileName);
    if (!filePath.startsWith(depositProofDir+path.sep) || !fs.existsSync(filePath)) return res.status(404).send(page('Proof not found','<h1>Payment proof file not found</h1><a class="btn" href="/admin/deposits">Return to deposits</a>'));
    res.type(row.proof_mime_type||'application/octet-stream');
    res.set('Content-Disposition','attachment; filename="payment-proof-'+id+'"');
    res.set('X-Content-Type-Options','nosniff');
    res.sendFile(filePath);
  } catch(e) { if(e.code==='ER_NO_SUCH_TABLE') return res.status(503).send(dbSetupNotice('Deposit workflow setup required','migrations/006_deposit_payment_workflow.sql')); next(e); }
});
app.post('/admin/deposits/:id/review', requireFinanceAdmin, express.urlencoded({extended:false,limit:'5kb'}), csrfCheck, async (req,res,next) => {
  const id=String(req.params.id||''), decision=String(req.body.decision||''), note=String(req.body.reviewer_note||'').trim().slice(0,1000);
  if (!/^\d{1,20}$/.test(id) || !['approved','rejected'].includes(decision)) return res.status(400).send(page('Invalid deposit review','<h1>Invalid deposit review</h1><a class="btn" href="/admin/deposits">Return to deposits</a>'));
  const conn=await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows]=await conn.execute('SELECT * FROM deposit_requests WHERE id=? FOR UPDATE',[id]);
    if (!rows.length) { await conn.rollback(); return res.status(404).send(page('Deposit not found','<h1>Deposit request not found</h1><a class="btn" href="/admin/deposits">Return to deposits</a>')); }
    const d=rows[0];
    if (d.status!=='pending') { await conn.rollback(); return res.status(409).send(page('Deposit already reviewed','<h1>This deposit has already been reviewed</h1><p class="muted">It cannot be approved or credited a second time.</p><a class="btn" href="/admin/deposits">Return to deposits</a>')); }
    if (decision==='approved') {
      await conn.execute('INSERT INTO member_wallets (member_id,currency,balance) VALUES (?,?,?) ON DUPLICATE KEY UPDATE balance=balance+VALUES(balance)',[d.member_id,d.currency,d.amount]);
      await conn.execute('INSERT INTO financial_transactions (member_id,deposit_request_id,transaction_type,currency,amount,reference) VALUES (?,?,?,?,?,?)',[d.member_id,d.id,'deposit_credit',d.currency,d.amount,'DEP-'+d.id]);
    }
    await conn.execute('UPDATE deposit_requests SET status=?,reviewer_member_id=?,reviewer_note=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=?',[decision,req.session.memberId,note||null,id]);
    await conn.execute('INSERT INTO admin_audit_log (admin_member_id,action,target_type,target_id,details,ip_address) VALUES (?,?,?,?,?,?)',[req.session.memberId,'deposit.'+decision,'deposit_request',String(id),JSON.stringify({currency:d.currency,amount:d.amount,fee_amount:d.fee_amount,note}),req.ip||null]);
    await conn.commit();
    res.redirect('/admin/deposits');
  } catch(e) { try { await conn.rollback(); } catch(_) {} if(e.code === 'ER_NO_SUCH_TABLE') return res.status(503).send(dbSetupNotice('Deposit workflow setup required','migrations/006_deposit_payment_workflow.sql')); next(e); }
  finally { conn.release(); }
});

app.get('/admin/referrals', requireAdmin, async (req,res,next) => {
  try {
    const [rows] = await pool.query('SELECT c.id,c.full_name,c.username,c.email,c.monarch_uid,c.created_at,r.full_name AS referrer_name,r.username AS referrer_username,r.monarch_uid AS referrer_uid FROM members c JOIN members r ON r.id=c.referred_by ORDER BY c.created_at DESC LIMIT 300');
    const items = rows.map(r => '<tr><td><strong>' + esc(r.full_name || r.username) + '</strong><br><small>' + esc(r.email) + '</small><br>' + esc(r.monarch_uid || '—') + '</td><td><strong>' + esc(r.referrer_name || r.referrer_username) + '</strong><br><small>' + esc(r.referrer_username) + ' · ' + esc(r.referrer_uid || '—') + '</small></td><td>' + esc(r.created_at || '—') + '</td></tr>').join('');
    const content = '<section class="ac-panel"><h2>Referral attribution</h2><p class="muted">These rows come from the members.referred_by relationship. Referral commissions and earnings are not displayed because no verified commission ledger is connected.</p><div class="ac-table-wrap"><table class="ac-table"><thead><tr><th>Referred member</th><th>Referrer</th><th>Registered</th></tr></thead><tbody>' + (items || '<tr><td colspan="3">No referred members found.</td></tr>') + '</tbody></table></div></section>';
    res.send(adminControlPage('Referral monitoring','/admin/referrals',content,req));
  } catch(e) { next(e); }
});
app.get('/admin/academy', requireAdmin, async (req,res,next) => {
  try {
    const [rows] = await pool.query('SELECT l.id,l.title,l.description,l.access_level,l.status,l.sort_order,l.created_at,m.username AS creator FROM academy_lessons l LEFT JOIN members m ON m.id=l.created_by ORDER BY l.sort_order ASC,l.created_at DESC LIMIT 200');
    const items = rows.map(l => '<tr><td><strong>' + esc(l.title) + '</strong><br><small>' + esc(l.description || '') + '</small></td><td>' + esc(l.access_level) + '</td><td>' + esc(l.status) + '</td><td>' + esc(l.creator || '—') + '</td><td><form method="post" action="/admin/academy/lessons/' + encodeURIComponent(l.id) + '/status">' + csrfField(req) + '<select name="status" aria-label="Lesson status"><option value="draft"' + (l.status === 'draft' ? ' selected' : '') + '>Draft</option><option value="published"' + (l.status === 'published' ? ' selected' : '') + '>Published</option><option value="archived"' + (l.status === 'archived' ? ' selected' : '') + '>Archived</option></select><button class="btn" type="submit">Save status</button></form></td></tr>').join('');
    const content = '<section class="ac-panel"><h2>Create a lesson</h2><p class="muted">Create educational content. Premium access remains controlled by an explicit access grant; publishing a lesson does not grant premium access.</p><form method="post" action="/admin/academy/lessons" class="ac-form">' + csrfField(req) + '<label>Lesson title<input name="title" required maxlength="180"></label><label>Description<textarea name="description" rows="2" maxlength="1000"></textarea></label><label>Lesson content<textarea name="content" rows="8" required maxlength="50000"></textarea></label><label>Optional video URL<input name="video_url" type="url" maxlength="1000" placeholder="https://…"></label><label>Access level<select name="access_level"><option value="free">Free</option><option value="premium">Premium</option></select></label><label>Initial status<select name="status"><option value="draft">Draft</option><option value="published">Published</option></select></label><button class="btn" type="submit">Create lesson</button></form></section><section class="ac-panel"><h2>Lessons</h2><div class="ac-table-wrap"><table class="ac-table"><thead><tr><th>Lesson</th><th>Access</th><th>Status</th><th>Created by</th><th>Update</th></tr></thead><tbody>' + (items || '<tr><td colspan="5">No lessons created yet.</td></tr>') + '</tbody></table></div></section><style>.ac-form{display:grid;gap:12px;max-width:820px}.ac-form label{display:grid;gap:6px}.ac-form input,.ac-form textarea,.ac-form select,td select{width:100%;min-width:0;padding:10px;border-radius:8px;background:#0d0d10;color:#fff;border:1px solid #45434c;font:inherit}.ac-form textarea{resize:vertical}</style>';
    res.send(adminControlPage('Academy management','/admin/academy',content,req));
  } catch(e) { if(e.code === 'ER_NO_SUCH_TABLE') return res.status(503).send(dbSetupNotice('Academy setup required','migrations/005_member_dashboard_and_sovereign_desk.sql')); next(e); }
});
app.post('/admin/academy/lessons', requireAdmin, express.urlencoded({extended:false,limit:'60kb'}), csrfCheck, async (req,res,next) => {
  try {
    const title = String(req.body.title || '').trim().slice(0,180);
    const description = String(req.body.description || '').trim().slice(0,1000);
    const content = String(req.body.content || '').trim().slice(0,50000);
    const accessLevel = ['free','premium'].includes(req.body.access_level) ? req.body.access_level : 'free';
    const status = ['draft','published'].includes(req.body.status) ? req.body.status : 'draft';
    const rawVideoUrl = String(req.body.video_url || '').trim().slice(0,1000);
    let videoUrl = null;
    if (rawVideoUrl) {
      try { const parsed = new URL(rawVideoUrl); if (!['http:','https:'].includes(parsed.protocol)) throw new Error('Unsupported URL protocol'); videoUrl = parsed.toString(); }
      catch (_) { return res.status(400).send(page('Invalid video URL','<h1>Enter a valid HTTPS or HTTP video URL</h1><a class="btn" href="/admin/academy">Return to Academy</a>')); }
    }
    if (!title || !content) return res.status(400).send(page('Lesson details required','<h1>Enter a lesson title and content</h1><a class="btn" href="/admin/academy">Return to Academy</a>'));
    await pool.execute('INSERT INTO academy_lessons (title,description,content,video_url,access_level,status,created_by) VALUES (?,?,?,?,?,?,?)',[title,description,content,videoUrl,accessLevel,status,req.session.memberId]);
    res.redirect('/admin/academy');
  } catch(e) { if(e.code === 'ER_NO_SUCH_TABLE') return res.status(503).send(dbSetupNotice('Academy setup required','migrations/005_member_dashboard_and_sovereign_desk.sql')); next(e); }
});
app.post('/admin/academy/lessons/:id/status', requireAdmin, express.urlencoded({extended:false,limit:'5kb'}), csrfCheck, async (req,res,next) => {
  const id = String(req.params.id || '');
  const status = String(req.body.status || '');
  if (!/^\d{1,20}$/.test(id) || !['draft','published','archived'].includes(status)) return res.status(400).send(page('Invalid lesson update','<h1>Invalid lesson status</h1><a class="btn" href="/admin/academy">Return to Academy</a>'));
  try {
    const [result] = await pool.execute('UPDATE academy_lessons SET status=? WHERE id=?',[status,id]);
    if (!result.affectedRows) return res.status(404).send(page('Lesson not found','<h1>Lesson not found</h1><a class="btn" href="/admin/academy">Return to Academy</a>'));
    res.redirect('/admin/academy');
  } catch(e) { if(e.code === 'ER_NO_SUCH_TABLE') return res.status(503).send(dbSetupNotice('Academy setup required','migrations/005_member_dashboard_and_sovereign_desk.sql')); next(e); }
});
app.get('/admin/sovereign-desk', requireAdmin, (req,res) => {
  if (req.adminRole === 'sovereign_desk_admin') return res.redirect('/sovereign-admin');
  res.redirect('/sovereign-admin');
});
app.get('/admin/notifications', requireAdmin, async (req,res,next) => {
  try {
    const [rows] = await pool.query('SELECT n.id,n.notification_type,n.title,n.body,n.target_url,n.read_at,n.created_at,m.full_name,m.username,m.email FROM member_notifications n JOIN members m ON m.id=n.member_id ORDER BY n.created_at DESC LIMIT 200');
    const items = rows.map(n => '<tr><td><strong>' + esc(n.title) + '</strong><br><small>' + esc(n.notification_type) + '</small><p>' + esc(n.body) + '</p></td><td>' + esc(n.full_name || n.username) + '<br><small>' + esc(n.email) + '</small></td><td>' + esc(n.read_at ? 'Read' : 'Unread') + '</td><td>' + esc(n.created_at) + '</td></tr>').join('');
    const content = '<section class="ac-panel"><h2>Member notification log</h2><p class="muted">This is the persisted in-app notification log for members. Email send attempts are logged separately by the application and are not represented as confirmed delivery here.</p><div class="ac-table-wrap"><table class="ac-table"><thead><tr><th>Notification</th><th>Member</th><th>Read status</th><th>Created</th></tr></thead><tbody>' + (items || '<tr><td colspan="4">No member notifications recorded yet.</td></tr>') + '</tbody></table></div></section>';
    res.send(adminControlPage('Notifications','/admin/notifications',content,req));
  } catch(e) { if(e.code === 'ER_NO_SUCH_TABLE') return res.status(503).send(dbSetupNotice('Notification setup required','migrations/005_member_dashboard_and_sovereign_desk.sql')); next(e); }
});
app.get('/admin/audit', requireAdmin, async (req,res,next) => {
  try {
    const [admins] = await pool.query('SELECT a.member_id,a.role,a.is_active,a.created_at,m.username,m.full_name,m.email FROM admin_users a JOIN members m ON m.id=a.member_id ORDER BY a.created_at DESC LIMIT 100');
    const [events] = await pool.query('SELECT l.action,l.target_type,l.target_id,l.details,l.ip_address,l.created_at,m.username FROM admin_audit_log l JOIN members m ON m.id=l.admin_member_id ORDER BY l.created_at DESC LIMIT 100');
    const adminRows = admins.map(a => '<tr><td>' + esc(a.full_name || a.username) + '<br><small>' + esc(a.email) + '</small></td><td>' + esc(String(a.role).replace(/_/g,' ')) + '</td><td>' + esc(Number(a.is_active) ? 'Active' : 'Inactive') + '</td><td>' + esc(a.created_at) + '</td></tr>').join('');
    const eventRows = events.map(e => '<tr><td>' + esc(e.action) + '</td><td>' + esc(e.target_type || '—') + ' ' + esc(e.target_id || '') + '</td><td>' + esc(e.username) + '</td><td>' + esc(typeof e.details === 'string' ? e.details : JSON.stringify(e.details || {})) + '</td><td>' + esc(e.created_at) + '</td></tr>').join('');
    const content = '<section class="ac-panel"><h2>Provisioned administrators</h2><div class="ac-table-wrap"><table class="ac-table"><thead><tr><th>Account</th><th>Role</th><th>Status</th><th>Added</th></tr></thead><tbody>' + (adminRows || '<tr><td colspan="4">No administrator rows found.</td></tr>') + '</tbody></table></div></section><section class="ac-panel"><h2>Recent audit events</h2><div class="ac-table-wrap"><table class="ac-table"><thead><tr><th>Action</th><th>Target</th><th>Actor</th><th>Details</th><th>Date</th></tr></thead><tbody>' + (eventRows || '<tr><td colspan="5">No audit events recorded yet.</td></tr>') + '</tbody></table></div></section>';
    res.send(adminControlPage('Audit & access','/admin/audit',content,req));
  } catch(e) { if(e.code === 'ER_NO_SUCH_TABLE') return res.status(503).send(dbSetupNotice('Audit setup required','migrations/002_admin_access.sql')); next(e); }
});
app.get('/admin/settings', requireAdmin, async (req,res,next) => {
  try {
    const [[pricing]] = await pool.query('SELECT base_usd_ngn_rate,markup_percent,bank_fee_usd,wallet_fee_usd,updated_at FROM deposit_pricing_settings WHERE id=1');
    const settings = [
      ['Database connection variables', Boolean(process.env.DB_HOST && process.env.DB_USER && process.env.DB_PASSWORD && process.env.DB_NAME)],
      ['Session secret', Boolean(process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32)],
      ['SMTP host and account', Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASSWORD)],
      ['Sender address', Boolean(process.env.MAIL_FROM)],
      ['Public application URL', Boolean(process.env.APP_BASE_URL)],
      ['KYC storage directory and encryption key', Boolean(process.env.KYC_STORAGE_DIR && process.env.KYC_ENCRYPTION_KEY)]
    ];
    const rows = settings.map(([label,ok]) => '<tr><td>' + esc(label) + '</td><td><span class="ac-pill">' + (ok ? 'Configured' : 'Needs configuration') + '</span></td></tr>').join('');
    const rate = pricing && pricing.base_usd_ngn_rate !== null ? esc(pricing.base_usd_ngn_rate) : '';
    const markup = pricing ? esc(pricing.markup_percent) : '0.1000';
    const bankFee = pricing ? esc(pricing.bank_fee_usd) : '2.00';
    const walletFee = pricing ? esc(pricing.wallet_fee_usd) : '1.00';
    const content = '<section class="ac-panel"><h2>Deposit pricing controls</h2><p class="muted">Set the original USD/NGN reference rate and internal margin. Members see only the final applied conversion rate. The initial rate is intentionally blank until an administrator enters a verified rate.</p>' +
      '<form method="post" action="/admin/settings/deposit-pricing">' + csrfField(req) +
      '<label for="baseRate">Original USD → NGN rate (₦ per $1)</label><input id="baseRate" name="base_usd_ngn_rate" type="number" min="0.000001" max="1000000" step="0.000001" value="' + rate + '" required>' +
      '<label for="markupPercent">Internal rate margin (%)</label><input id="markupPercent" name="markup_percent" type="number" min="0" max="10" step="0.0001" value="' + markup + '" required>' +
      '<label for="bankFee">Bank deposit fee (USD)</label><input id="bankFee" name="bank_fee_usd" type="number" min="0" max="10000" step="0.01" value="' + bankFee + '" required>' +
      '<label for="walletFee">Wallet-address deposit fee (USD)</label><input id="walletFee" name="wallet_fee_usd" type="number" min="0" max="10000" step="0.01" value="' + walletFee + '" required>' +
      '<button class="btn" type="submit">Save deposit pricing</button></form><p class="muted small">Last updated: ' + esc(pricing ? pricing.updated_at : 'Not configured') + '</p></section>' +
      '<section class="ac-panel"><h2>Environment configuration health</h2><p class="muted">This page never displays passwords, secret keys, or private storage paths. Change secrets in Hostinger environment settings, not here.</p><div class="ac-table-wrap"><table class="ac-table"><thead><tr><th>Setting</th><th>Status</th></tr></thead><tbody>' + rows + '</tbody></table></div></section>';
    res.send(adminControlPage('Platform settings','/admin/settings',content,req));
  } catch(e) { if(e.code === 'ER_NO_SUCH_TABLE') return res.status(503).send(dbSetupNotice('Deposit pricing setup required','migrations/006_deposit_payment_workflow.sql')); next(e); }
});
app.post('/admin/settings/deposit-pricing', requireFinanceAdmin, express.urlencoded({extended:false,limit:'5kb'}), csrfCheck, async (req,res,next) => {
  const base = Number(req.body.base_usd_ngn_rate);
  const markup = Number(req.body.markup_percent);
  const bankFee = Number(req.body.bank_fee_usd);
  const walletFee = Number(req.body.wallet_fee_usd);
  if (!Number.isFinite(base) || base <= 0 || base > 1000000 || !Number.isFinite(markup) || markup < 0 || markup > 10 || !Number.isFinite(bankFee) || bankFee < 0 || bankFee > 10000 || !Number.isFinite(walletFee) || walletFee < 0 || walletFee > 10000) {
    return res.status(400).send(page('Invalid deposit pricing','<h1>Check deposit pricing</h1><p class="muted">Enter a positive exchange rate, a margin from 0 to 10%, and valid non-negative fees.</p><a class="btn" href="/admin/settings">Return to settings</a>'));
  }
  try {
    await pool.execute('UPDATE deposit_pricing_settings SET base_usd_ngn_rate=?,markup_percent=?,bank_fee_usd=?,wallet_fee_usd=?,updated_by=? WHERE id=1',[base,markup,bankFee,walletFee,req.session.memberId]);
    await pool.execute('INSERT INTO admin_audit_log (admin_member_id,action,target_type,target_id,details,ip_address) VALUES (?,?,?,?,?,?)',[req.session.memberId,'deposit.pricing.updated','deposit_pricing_settings','1',JSON.stringify({base_usd_ngn_rate:base,markup_percent:markup,bank_fee_usd:bankFee,wallet_fee_usd:walletFee}),req.ip||null]);
    res.redirect('/admin/settings');
  } catch(e) { if(e.code === 'ER_NO_SUCH_TABLE') return res.status(503).send(dbSetupNotice('Deposit pricing setup required','migrations/006_deposit_payment_workflow.sql')); next(e); }
});

app.get('/admin/members', requireAdmin, async (req,res,next)=>{
  try {
    const [rows] = await pool.query('SELECT m.id,m.username,m.full_name,m.email,m.monarch_uid,au.role,au.is_active FROM members m LEFT JOIN admin_users au ON au.member_id=m.id ORDER BY m.id DESC LIMIT 200');
    const table=rows.map(m=>'<tr><td>'+esc(m.id)+'</td><td><strong>'+esc(m.username)+'</strong><br><small>'+esc(m.full_name||'')+'</small></td><td>'+esc(m.email)+'</td><td>'+esc(m.monarch_uid||'—')+'</td><td>'+esc(m.role?m.role.replace(/_/g,' '):'Member')+'</td><td>'+esc(m.role?(Number(m.is_active)?'Active admin':'Inactive admin'):'Member account')+'</td></tr>').join('');
    const content='<section class="ac-panel"><h2>Member accounts</h2><p class="muted">Showing up to 200 most recently created accounts. Admin status is sourced from the admin access table.</p><div class="ac-table-wrap"><table class="ac-table"><thead><tr><th>ID</th><th>Account</th><th>Email</th><th>Monarch ID</th><th>Role</th><th>Status</th></tr></thead><tbody>'+(table||'<tr><td colspan="6">No accounts found.</td></tr>')+'</tbody></table></div></section>';
    res.send(adminControlPage('Members','/admin/members',content,req));
  } catch(e){next(e);}
});

const KYC_REJECTION_REASONS = Object.freeze({
  nin_mismatch: { label: 'NIN does not match the submitted details', message: 'The NIN or identity details do not match the information submitted. Please check your details and contact support if you believe this is an error.' },
  details_mismatch: { label: 'Name or personal details do not match ID', message: 'The personal details provided do not match the identity document. Please correct the information and resubmit.' },
  unclear_image: { label: 'ID image is blurry, cropped, or unreadable', message: 'The identity document image is not clear enough to verify. Please upload a clear, complete image with all required details visible.' },
  fake_identity: { label: 'Document appears altered or cannot be authenticated', message: 'We could not authenticate the submitted identity document. Please contact support before submitting a valid, original document.' },
  expired_document: { label: 'Identity document appears expired', message: 'The submitted identity document appears to be expired. Please provide a valid, current document accepted for verification.' },
  wrong_document: { label: 'Unsupported or incorrect document type', message: 'The submitted document type cannot be accepted for this verification. Please check the accepted document types and submit the correct document.' },
  missing_information: { label: 'Required information is missing', message: 'Some required identity information or document images are missing. Please complete all required fields and upload the requested images.' },
  duplicate_submission: { label: 'Duplicate submission', message: 'This application appears to duplicate an existing verification submission. Please contact support if you believe this is incorrect.' },
  other: { label: 'Other verification issue', message: 'We could not approve this verification submission. Please contact support for clarification before resubmitting.' }
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
    const images=docs.map(([kind,label,key])=>key?'<figure class="kyc-doc"><figcaption>'+esc(label)+'</figcaption><button type="button" class="kyc-image-open" data-image-src="/admin/kyc/'+encodeURIComponent(id)+'/document/'+kind+'" data-image-label="'+esc(label)+'" aria-label="View '+esc(label)+' full size"><img src="/admin/kyc/'+encodeURIComponent(id)+'/document/'+kind+'" alt="'+esc(label)+'"></button><a class="kyc-image-full-link" href="/admin/kyc/'+encodeURIComponent(id)+'/document/'+kind+'" target="_blank" rel="noopener">Open full size ↗</a></figure>':'<div class="kyc-doc"><strong>'+esc(label)+'</strong><p class="muted">No image supplied.</p></div>').join('');
    const body='<style>.kyc-details{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.kyc-detail{padding:9px;border:1px solid #39352a;border-radius:10px;background:#111115;min-width:0;overflow-wrap:anywhere}.kyc-detail span{display:block;color:#aaa9b4;font-size:.78rem}.kyc-detail strong{display:block;margin-top:4px;font-size:.88rem;line-height:1.35}.kyc-doc-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;align-items:start}.kyc-doc{padding:9px;margin:0;border:1px solid #39352a;border-radius:10px;background:#111115;min-width:0;overflow:hidden}.kyc-doc figcaption{font-weight:600;font-size:.85rem}.kyc-image-open{display:block;width:100%;padding:0;border:0;background:#080809;border-radius:8px;cursor:zoom-in;margin-top:8px}.kyc-doc img{display:block;width:100%;height:clamp(150px,22vw,260px);object-fit:contain;background:#080809;border-radius:8px}.kyc-image-full-link{display:inline-flex;margin-top:9px;font-size:.82rem;font-weight:700;color:#f6d43c;text-decoration:none}.kyc-image-full-link:hover{text-decoration:underline}.kyc-image-dialog{width:min(96vw,1400px);max-width:96vw;max-height:94dvh;padding:14px;border:1px solid #57515f;border-radius:16px;background:#101014;color:#fff;box-shadow:0 20px 80px #000b}.kyc-image-dialog::backdrop{background:#000d;backdrop-filter:blur(4px)}.kyc-image-dialog-head{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:10px}.kyc-image-dialog-title{font-weight:700;overflow-wrap:anywhere}.kyc-image-dialog-close{padding:9px 13px;border:1px solid #625c6b;border-radius:9px;background:#24232a;color:#fff;font:inherit;cursor:pointer}.kyc-image-dialog-image{display:block;max-width:100%;max-height:calc(94dvh - 90px);width:auto;height:auto;object-fit:contain;margin:auto;border-radius:8px}.kyc-review-panel{margin-top:12px;padding:clamp(14px,3vw,22px);border:1px solid #45404b;border-radius:16px;background:linear-gradient(145deg,#17161c,#101014);box-shadow:0 12px 32px #0003}.kyc-review-form{display:grid;gap:10px}.kyc-review-form label{display:block;margin-top:4px;color:#e8e5ee;font-size:.9rem;font-weight:650;line-height:1.45}.kyc-review-form select,.kyc-review-form textarea{display:block;width:100%;min-height:46px;margin-top:7px;padding:12px 14px;background:#0d0d10;color:#fff;border:1px solid #514c5a;border-radius:10px;font:inherit;line-height:1.4;box-sizing:border-box}.kyc-review-form select{cursor:pointer;color-scheme:dark}.kyc-review-form textarea{min-height:100px;resize:vertical}.kyc-review-form select:focus-visible,.kyc-review-form textarea:focus-visible{outline:2px solid #f6d43c;outline-offset:2px;border-color:#f6d43c}.kyc-save-review{display:inline-flex;align-items:center;justify-content:center;min-height:46px;padding:12px 18px;border:1px solid #d8b82d;border-radius:10px;background:#f6d43c;color:#17130a;font-weight:800;font:inherit;cursor:pointer}.kyc-save-review:hover,.kyc-save-review:focus-visible{background:#ffe36b;outline:2px solid #f6d43c;outline-offset:2px}.kyc-back-link{display:inline-flex;align-items:center;justify-content:center;gap:8px;margin-top:16px;padding:10px 15px;border:1px solid #6b5a1b;border-radius:10px;color:#f6d43c;background:#211d10;text-decoration:none;font-weight:700;line-height:1.25}.kyc-back-link:hover{background:#30280e;text-decoration:none}@media(max-width:760px){.kyc-details{grid-template-columns:repeat(2,minmax(0,1fr))}.kyc-doc-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.kyc-doc img{height:clamp(160px,40vw,240px)}}@media(max-width:420px){.kyc-details{grid-template-columns:1fr}.kyc-doc-grid{grid-template-columns:1fr}.kyc-doc img{height:240px}}</style><section class="ac-panel"><p class="muted">Private identity information is shown only to an authenticated administrator. Handle it as confidential data.</p><h2>Applicant information</h2><div class="kyc-details">'+details+'</div><h2 style="margin-top:24px">Identity images</h2><div class="kyc-doc-grid">'+images+'</div><h2 style="margin-top:24px">Review decision</h2><div class="kyc-review-panel"><form class="kyc-review-form" id="kycReviewForm" method="post" action="/admin/kyc/'+esc(id)+'/review">'+csrfField(req)+'<label for="kycStatus">Decision</label><select id="kycStatus" name="status" required><option value="pending" '+(k.status==='pending'?'selected':'')+'>Keep pending</option><option value="approved">Approve</option><option value="rejected">Reject</option><option value="needs_resubmission">Request resubmission</option></select><label for="kycReason">Rejection reason (required when rejecting)</label><select id="kycReason" name="reason_code"><option value="">Choose a reason</option>'+Object.entries(KYC_REJECTION_REASONS).map(([value,reason])=>'<option value="'+esc(value)+'">'+esc(reason.label)+'</option>').join('')+'</select><label for="kycNote">Additional reviewer note / instructions</label><textarea id="kycNote" name="note" rows="3" maxlength="1000" placeholder="Add clear instructions for the member">'+esc(k.reviewer_note||'')+'</textarea><button class="btn kyc-save-review" type="submit">Save review decision</button></form></div><a class="kyc-back-link" href="/admin/kyc">← Back to review queue</a></section><script>(function(){var form=document.getElementById("kycReviewForm"),status=document.getElementById("kycStatus"),reason=document.getElementById("kycReason");if(!form||!status||!reason)return;function syncReason(){reason.required=status.value==="rejected";reason.setAttribute("aria-required",reason.required?"true":"false")}status.addEventListener("change",syncReason);syncReason();form.addEventListener("submit",function(event){var messages={approved:"Approve this KYC application and notify the member?",rejected:"Reject this KYC application and send the selected reason to the member?",needs_resubmission:"Request a new KYC submission and send the instructions to the member?",pending:"Keep this application pending?"};if(!window.confirm(messages[status.value]||"Save this review decision?"))event.preventDefault()})})();</script><dialog class="kyc-image-dialog" id="kycImageDialog" aria-label="Full-size identity image"><div class="kyc-image-dialog-head"><span class="kyc-image-dialog-title" id="kycImageDialogTitle">Identity image</span><button class="kyc-image-dialog-close" id="kycImageDialogClose" type="button">Close ✕</button></div><img class="kyc-image-dialog-image" id="kycImageDialogImage" alt="Full-size identity document or selfie"></dialog><script>(function(){var d=document.getElementById(\'kycImageDialog\'),img=document.getElementById(\'kycImageDialogImage\'),title=document.getElementById(\'kycImageDialogTitle\'),close=document.getElementById(\'kycImageDialogClose\');if(!d||!img||!title||!close)return;document.querySelectorAll(\'[data-image-src]\').forEach(function(b){b.addEventListener(\'click\',function(){img.src=b.getAttribute(\'data-image-src\');img.alt=b.getAttribute(\'data-image-label\')||\'Identity image\';title.textContent=b.getAttribute(\'data-image-label\')||\'Identity image\';if(typeof d.showModal===\'function\')d.showModal();else{d.setAttribute(\'open\',\'\');d.style.position=\'fixed\';d.style.inset=\'2vh 2vw\';d.style.zIndex=\'99999\'}})});function shut(){if(typeof d.close===\'function\'&&d.open)d.close();else d.removeAttribute(\'open\');img.removeAttribute(\'src\')}close.addEventListener(\'click\',shut);d.addEventListener(\'click\',function(e){if(e.target===d)shut()});d.addEventListener(\'close\',function(){img.removeAttribute(\'src\')})})();</script>';
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
    const rejectionOptions = Object.entries(KYC_REJECTION_REASONS).map(([value, reason]) => '<option value="' + esc(value) + '">' + esc(reason.label) + '</option>').join('');
    const reviewKey = String(req.query.review || '');
    const emailKey = String(req.query.email || '');
    const reviewMessages = { approved: 'KYC application approved successfully.', rejected: 'KYC application rejected successfully.', needs_resubmission: 'Resubmission request saved successfully.' };
    const emailMessages = { sent: 'The email was accepted by the mail server.', skipped: 'Email was not sent because SMTP is not configured.', failed: 'The decision was saved, but the email could not be sent. Check the server mail logs and SMTP settings.', no_address: 'The decision was saved, but the member has no email address.' };
    const reviewNotice = reviewMessages[reviewKey] ? '<div class="ac-alert" role="status" style="border-color:#2e9c5d;background:#102a1c;color:#d4ffe2"><strong>Success:</strong> ' + esc(reviewMessages[reviewKey]) + ' ' + esc(emailMessages[emailKey] || '') + '</div>' : '';
    const items = rows.map(row => {
      const action = '/admin/kyc/' + encodeURIComponent(row.id) + '/review';
      return '<tr><td>' + esc(row.id) + '</td><td><strong>' + esc(row.legal_full_name) + '</strong><br><small>' + esc(row.contact_email) + '</small><br><a class="kyc-application-link" href="/admin/kyc/' + encodeURIComponent(row.id) + '" aria-label="Review application and identity images for ' + esc(row.legal_full_name) + '"><span>View application</span><span aria-hidden="true">↗</span></a></td><td>' + esc(row.document_type) + ' (' + esc(row.document_issuer_country) + ')<br><small>•••• ' + esc(row.document_number_last4) + '</small></td><td>' + esc(row.status) + '</td><td><div class="kyc-queue-actions"><a class="btn" href="/admin/kyc/' + encodeURIComponent(row.id) + '">Review</a>' +
        (row.status === 'approved' ? '<span class="kyc-approved-label">Approved ✓</span>' :
        '<form method="post" action="' + action + '" class="kyc-approve-form" onsubmit="return confirm(&quot;Approve this KYC application? The member will be notified by email if email delivery is configured.&quot;)">' + csrfField(req) + '<input type="hidden" name="status" value="approved"><button class="btn kyc-approve" type="submit">✓ Approve</button></form>' +
        '<details class="kyc-reject-details"><summary class="btn kyc-reject">✕ Reject</summary><form method="post" action="' + action + '" class="kyc-reject-form" onsubmit="return confirm(&quot;Send this rejection to the member? The selected reason and any guidance will be saved and sent as a notification.&quot;)">' + csrfField(req) + '<input type="hidden" name="status" value="rejected"><label>Reason for rejection<select name="reason_code" required><option value="">Choose a reason</option>' + rejectionOptions + '</select></label><label>Additional message (optional)<textarea name="note" rows="2" maxlength="1000" placeholder="Add specific guidance for the member"></textarea></label><button class="btn kyc-confirm-reject" type="submit">Confirm rejection &amp; send</button></form></details>') +
        '</div></td></tr>';
    }).join('');
    const body = '<div class="wrap"><h1>KYC review queue</h1>' + reviewNotice + '<p class="muted">Documents are encrypted outside the public web directory. Open an application to inspect submitted information and images before making a review decision.</p><div class="panel" style="overflow:auto"><table style="width:100%;border-collapse:collapse"><thead><tr><th>ID</th><th>Member</th><th>Document</th><th>Status</th><th>Review</th></tr></thead><tbody>' + (items || '<tr><td colspan="5">No submissions yet.</td></tr>') + '</tbody></table></div><p><a class="btn" href="/admin">Back to admin</a></p></div><style>td,th{padding:12px;text-align:left;border-bottom:1px solid #39352a;vertical-align:top}td form{display:grid;gap:7px;min-width:190px}td input,td select,td textarea{padding:9px;border-radius:8px;background:#0d0d10;color:#fff;border:1px solid #45434c;font:inherit;max-width:100%}.kyc-queue-actions{display:flex;flex-wrap:wrap;align-items:flex-start;gap:8px;min-width:190px}.kyc-queue-actions .btn{display:inline-flex;align-items:center;justify-content:center;padding:9px 12px;cursor:pointer;text-decoration:none}.kyc-application-link{display:inline-flex;align-items:center;justify-content:space-between;gap:12px;max-width:100%;margin-top:9px;padding:8px 11px;border:1px solid #66551d;border-radius:9px;background:#211d10;color:#f6d43c;text-decoration:none;font-size:.82rem;font-weight:750;line-height:1.3;white-space:nowrap}.kyc-application-link span:last-child{font-size:1rem;transition:transform .15s ease}.kyc-application-link:hover,.kyc-application-link:focus-visible{background:#30280e;border-color:#f6d43c;text-decoration:none;outline:2px solid #f6d43c;outline-offset:2px}.kyc-application-link:hover span:last-child{transform:translate(2px,-2px)}.kyc-approve{background:#176b3a;color:#fff;border:1px solid #2e9c5d}.kyc-approve:hover,.kyc-approve:focus-visible{background:#21864b;outline:2px solid #62d995;outline-offset:2px}.kyc-reject-details{min-width:180px}.kyc-reject-details summary{list-style:none}.kyc-reject-details summary::-webkit-details-marker{display:none}.kyc-reject{background:#251414;color:#ffb5b5;border:1px solid #744040}.kyc-reject-form{margin-top:8px;padding:12px;border:1px solid #39352a;border-radius:10px;background:#111115;min-width:240px}.kyc-reject-form label{display:grid;gap:6px;font-size:.85rem}.kyc-confirm-reject{background:#5a2020;color:#fff;border:1px solid #8b3d3d}.kyc-approved-label{color:#8fddb2;font-weight:700;padding:8px}.ac-table-wrap{overflow-x:auto}td small{color:#aaa}@media(max-width:640px){.kyc-queue-actions{min-width:160px}.kyc-reject-form{min-width:220px}}</style>';
    res.send(adminControlPage('KYC review','/admin/kyc', '<section class="ac-panel">' + body + '</section>', req));
  } catch(e) { next(e); }
});
app.post('/admin/kyc/:id/review', requireAdmin, express.urlencoded({extended:false,limit:'5kb'}), csrfCheck, async (req,res,next) => {
  const id = String(req.params.id || '');
  const status = req.body.status;
  const reasonCode = String(req.body.reason_code || '').trim();
  const submittedNote = String(req.body.note || '').trim().slice(0,1000);
  const reason = Object.prototype.hasOwnProperty.call(KYC_REJECTION_REASONS, reasonCode) ? KYC_REJECTION_REASONS[reasonCode] : null;
  const note = (status === 'rejected'
    ? [reason ? reason.message : '', submittedNote ? 'Additional details: ' + submittedNote : ''].filter(Boolean).join('\n\n')
    : submittedNote).slice(0, 1000);
  if (!/^\d{1,20}$/.test(id) || !['pending','approved','rejected','needs_resubmission'].includes(status)) return res.status(400).send(page('Invalid review','<h1>Invalid review request</h1>'));
  if (status === 'rejected' && !reason) return res.status(400).send(page('Rejection reason required','<h1>Please choose a rejection reason</h1><p class="muted">Choose a reason so the member receives clear instructions.</p><a class="btn" href="/admin/kyc/' + esc(id) + '">Return to review</a>'));
  if (status === 'needs_resubmission' && !note) return res.status(400).send(page('Review reason required','<h1>Please provide resubmission instructions</h1><p class="muted">A clear reason is required when requesting resubmission.</p><a class="btn" href="/admin/kyc/' + esc(id) + '">Return to review</a>'));
  try {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [found] = await conn.execute('SELECT id,status FROM kyc_submissions WHERE id = ? FOR UPDATE',[id]);
      if (!found.length) { await conn.rollback(); return res.status(404).send(page('Not found','<h1>KYC submission not found</h1>')); }
      if (found[0].status === status) { await conn.rollback(); return res.redirect('/admin/kyc'); }
      if (found[0].status === 'approved' && status !== 'approved') { await conn.rollback(); return res.status(409).send(page('KYC already approved','<h1>This KYC application is already approved</h1><p class="muted">Approved verification cannot be reversed through this form.</p><a class="btn" href="/admin/kyc">Back to review queue</a>')); }
      await conn.execute('UPDATE kyc_submissions SET status = ?, reviewer_member_id = ?, reviewer_note = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?',[status,req.session.memberId,note || null,id]);
      await conn.execute('INSERT INTO kyc_review_events (submission_id,actor_member_id,event_type,note) VALUES (?,?,?,?)',[id,req.session.memberId,status,note || null]);
      await conn.execute('INSERT INTO admin_audit_log (admin_member_id, action, target_type, target_id, details, ip_address) VALUES (?, ?, ?, ?, ?, ?)',[req.session.memberId,'kyc.' + status,'kyc_submission',String(id),JSON.stringify({status,reason_code:status === 'rejected' ? reasonCode : null}),req.ip || null]);
      const [applicantRows] = await conn.execute('SELECT m.id AS member_id, m.full_name, m.email FROM kyc_submissions k JOIN members m ON m.id = k.member_id WHERE k.id = ? LIMIT 1',[id]);
      var kycApplicant = applicantRows[0] || null;
      await conn.commit();
    } catch(e) { await conn.rollback(); throw e; } finally { conn.release(); }
    let emailStatus = 'not_applicable';
    if (kycApplicant) {
      const baseUrl = (process.env.APP_BASE_URL || 'https://monarchcodex.online').replace(/\/+$/, '');
      const messages = {
        approved: { subject: 'Your Monarch Codex KYC is approved', text: 'Congratulations ' + kycApplicant.full_name + '! Your identity verification has been approved. You can review your status in your dashboard: ' + baseUrl + '/dashboard' },
        rejected: { subject: 'An update on your Monarch Codex KYC', text: 'Hello ' + kycApplicant.full_name + ', your identity verification was not approved. Reason from our review team: ' + (note || 'Please contact support for clarification.') + '\n\nPlease review your submission and contact support if you need help: ' + baseUrl + '/kyc' },
        needs_resubmission: { subject: 'Action needed: resubmit your Monarch Codex KYC', text: 'Hello ' + kycApplicant.full_name + ', we need you to resubmit your identity verification. Reason and instructions: ' + (note || 'Please review your submitted details and documents, then submit again.') + '\n\nContinue here: ' + baseUrl + '/kyc' }
      };
      const notification = messages[status];
      const inAppMessages = {
        approved: { title: 'KYC approved', body: 'Congratulations ' + kycApplicant.full_name + '! Your identity verification has been approved. Your KYC status is now approved.', target: '/dashboard' },
        rejected: { title: 'KYC review update', body: 'Your identity verification was not approved. Reason: ' + note + ' Please review the feedback and contact support if needed.', target: '/kyc' },
        needs_resubmission: { title: 'KYC resubmission required', body: 'Please update your identity verification. Instructions: ' + note, target: '/kyc' }
      };
      const inApp = inAppMessages[status];
      if (inApp) {
        await pool.execute(
          'INSERT INTO member_notifications (member_id, notification_type, title, body, target_url, dedupe_key) VALUES (?, ?, ?, ?, ?, ?)',
          [kycApplicant.member_id, 'kyc_review', inApp.title, inApp.body.slice(0, 1000), inApp.target, 'kyc-review:' + id + ':' + status + ':' + Date.now()]
        ).catch(e => console.error('[notification] KYC in-app notification failed:', e.message));
      }
      if (notification && kycApplicant.email) {
        try {
          const sent = await sendAppEmail({ to: kycApplicant.email, ...notification });
          emailStatus = sent ? 'sent' : 'skipped';
        } catch(e) {
          emailStatus = 'failed';
          console.error('[mail] KYC notification failed:', e.message);
        }
      } else if (notification) {
        emailStatus = 'no_address';
      }
    }
    return res.redirect('/admin/kyc?review=' + encodeURIComponent(status) + '&email=' + encodeURIComponent(emailStatus));
  } catch(e) { next(e); }
});

app.get('/notifications', requireAuth, async (req,res,next) => {
  try {
    const m = await getMemberForPage(req,res);
    if (!m) return;
    const [rows] = await pool.execute('SELECT id,notification_type,title,body,target_url,read_at,created_at FROM member_notifications WHERE member_id=? ORDER BY created_at DESC LIMIT 100',[m.id]);
    const unread = rows.filter(n => !n.read_at).length;
    const items = rows.map(n => {
      const safeTarget = typeof n.target_url === 'string' && /^\/(?!\/)/.test(n.target_url) ? n.target_url : null;
      return '<article class="member-card notification-card ' + (n.read_at ? 'is-read' : 'is-unread') + '"><div class="notification-head"><div><small>' + esc(n.notification_type.replace(/_/g,' ')) + ' · ' + esc(n.created_at) + '</small><h3>' + esc(n.title) + '</h3></div><span class="ac-pill">' + (n.read_at ? 'Read' : 'New') + '</span></div><p>' + esc(n.body) + '</p><div class="notification-actions">' + (safeTarget ? '<a class="btn" href="' + esc(safeTarget) + '">Open</a>' : '') + (!n.read_at ? '<form method="post" action="/notifications/' + encodeURIComponent(n.id) + '/read">' + csrfField(req) + '<button class="btn" type="submit">Mark as read</button></form>' : '') + '</div></article>';
    }).join('');
    const content = '<section class="member-card"><div class="notification-head"><div><h2>Your notifications</h2><p class="muted">Updates about KYC and your Monarch Codex account.</p></div><strong>' + unread + ' unread</strong></div>' + (unread ? '<form method="post" action="/notifications/read-all">' + csrfField(req) + '<button class="btn" type="submit">Mark all as read</button></form>' : '') + '</section>' + (items || '<section class="member-card"><h3>You are all caught up</h3><p class="muted">New account updates will appear here.</p></section>') + '<style>.notification-card.is-unread{border-color:#8a7227}.notification-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}.notification-head h3{margin:8px 0}.notification-head small{color:#aaa}.notification-actions{display:flex;flex-wrap:wrap;gap:8px}.notification-actions form{margin:0}@media(max-width:480px){.notification-head{display:block}.notification-head .ac-pill{display:inline-block;margin-top:8px}}</style>';
    res.send(memberPage('Notifications','/notifications',m,content,req));
  } catch(e) { if(e.code === 'ER_NO_SUCH_TABLE') return res.status(503).send(page('Notifications unavailable','<h1>Notifications are not configured yet</h1><p class="muted">The site owner must apply migrations/005_member_dashboard_and_sovereign_desk.sql.</p>')); next(e); }
});
app.post('/notifications/read-all', requireAuth, express.urlencoded({extended:false,limit:'5kb'}), csrfCheck, async (req,res,next) => {
  try {
    await pool.execute('UPDATE member_notifications SET read_at=COALESCE(read_at,CURRENT_TIMESTAMP) WHERE member_id=? AND read_at IS NULL',[req.session.memberId]);
    res.redirect('/notifications');
  } catch(e) { if(e.code === 'ER_NO_SUCH_TABLE') return res.status(503).send(page('Notifications unavailable','<h1>Notifications are not configured yet</h1>')); next(e); }
});
app.post('/notifications/:id/read', requireAuth, express.urlencoded({extended:false,limit:'5kb'}), csrfCheck, async (req,res,next) => {
  const id = String(req.params.id || '');
  if (!/^\d{1,20}$/.test(id)) return res.sendStatus(400);
  try {
    await pool.execute('UPDATE member_notifications SET read_at=COALESCE(read_at,CURRENT_TIMESTAMP) WHERE id=? AND member_id=?',[id,req.session.memberId]);
    res.redirect('/notifications');
  } catch(e) { if(e.code === 'ER_NO_SUCH_TABLE') return res.status(503).send(page('Notifications unavailable','<h1>Notifications are not configured yet</h1>')); next(e); }
});

app.get('/dashboard', requireAuth, async (req, res, next) => {
  try {
    const [rows] = await pool.execute('SELECT id, monarch_uid, full_name, email, username FROM members WHERE id = ? LIMIT 1', [req.session.memberId]);
    const member = rows[0];
    if (!member) { req.session.destroy(() => res.redirect('/login')); return; }
    const [counts] = await pool.execute('SELECT COUNT(*) AS total FROM members WHERE referred_by = ?', [member.id]);
    let unreadNotificationCount = 0, dashboardNotifications = [];
    try {
      const [[notificationCount]] = await pool.execute('SELECT COUNT(*) AS total FROM member_notifications WHERE member_id=? AND read_at IS NULL', [member.id]);
      unreadNotificationCount = Number(notificationCount && notificationCount.total) || 0;
      const [notificationRows] = await pool.execute('SELECT id,notification_type,title,body,target_url,read_at,created_at FROM member_notifications WHERE member_id=? ORDER BY created_at DESC LIMIT 3', [member.id]);
      dashboardNotifications = notificationRows;
    } catch (e) {
      if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
    }
    let verificationStatus = 'Not submitted', verificationHint = 'Verify account';
    try { const [kycRows] = await pool.execute('SELECT status FROM kyc_submissions WHERE member_id = ? ORDER BY submitted_at DESC, id DESC LIMIT 1', [member.id]); if (kycRows.length) { const labels = {pending:'Pending review',approved:'Approved',rejected:'Rejected',needs_resubmission:'Resubmission required'}; verificationStatus = labels[kycRows[0].status] || 'Submitted'; verificationHint = ['rejected','needs_resubmission'].includes(kycRows[0].status) ? 'Review verification' : 'View verification'; } } catch (e) { if (e.code !== 'ER_NO_SUCH_TABLE') throw e; }
    const baseUrl = (process.env.APP_BASE_URL || 'https://monarchcodex.online').replace(/\/+$/, '');
    const referralLink = baseUrl + '/register?ref=' + encodeURIComponent(member.monarch_uid);
    const body = '<link rel="stylesheet" href="/member-dashboard.css"><div class="dashboard-layout">'+
      '<button class="sidebar-scrim" type="button" data-sidebar-close aria-label="Close navigation"></button><aside class="dashboard-sidebar" id="memberSidebar"><div class="sidebar-brand-row"><div class="side-title">MEMBER MENU</div><button class="icon-btn sidebar-close sidebar-desktop-toggle" type="button" data-sidebar-collapse aria-label="Collapse sidebar" title="Collapse sidebar" aria-expanded="true"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6M4 4v16"/></svg></button><button class="icon-btn sidebar-close" type="button" data-sidebar-close aria-label="Close menu"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></div><nav aria-label="Member dashboard navigation">' +
      '<a href="/dashboard" aria-current="page"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg><span class="nav-text">Overview</span></a>' + '<a href="/notifications" class="member-notifications-link"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></svg><span class="nav-text">Notifications</span>' + (unreadNotificationCount ? '<span class="notification-nav-count">' + (unreadNotificationCount > 99 ? '99+' : unreadNotificationCount) + '</span>' : '') + '</a><a href="/profile"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg><span class="nav-text">Profile</span></a><a href="/kyc"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z"/><path d="m9 12 2 2 4-4"/></svg><span class="nav-text">KYC Verification</span></a><a href="/referrals"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3"/><path d="M3 20v-1a6 6 0 0 1 12 0v1M16 5a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 5v1"/></svg><span class="nav-text">Referrals</span></a><a href="/deposit"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M7 15h4"/></svg><span class="nav-text">Deposit</span></a><a href="/withdraw"><span aria-hidden="true">↗</span><span class="nav-text">Withdraw</span></a><a href="/transactions"><span aria-hidden="true">◷</span><span class="nav-text">Transactions</span></a>' +'</nav><div class="sidebar-uid"><span class="muted small">YOUR MONARCH ID</span><div class="sidebar-uid-value"><strong id="memberUid">' + esc(member.monarch_uid) + '</strong><button class="copy-btn" type="button" data-copy-target="memberUid" aria-label="Copy Monarch ID">Copy</button></div></div><div class="sidebar-logout"><form method="post" action="/logout">' + csrfField(req) + '<button class="sidebar-logout-btn" type="submit"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 17l5-5-5-5M15 12H3M21 4v16"/></svg><span class="nav-text">Log out</span></button></form></div></aside><button class="sidebar-scrim" type="button" data-sidebar-close aria-label="Close navigation"></button><div class="dashboard-content"><div class="mobile-dashboard-bar"><button class="icon-btn sidebar-open" type="button" data-sidebar-open aria-label="Open navigation" aria-controls="memberSidebar"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg></button><span>MEMBER AREA</span><span class="mobile-current-tab">Overview</span></div><section class="panel">' +
      '<div class="dashboard-topline"><div><div class="muted small">MONARCH MEMBER AREA</div><h1>Welcome, ' + esc(member.full_name.split(' ')[0]) + '</h1><p class="muted">Your membership overview and account tools.</p></div></div>' +
      '<section id="overview" class="dashboard-section overview-intro"><div class="overview-title-row"><div><span class="muted small">YOUR ACCOUNT</span><h2>Overview</h2></div><span class="account-live"><i></i> Account active</span></div>' +
      '<div class="grid dashboard-metrics"><div class="stat balance-primary"><span class="muted small balance-display-label">Total wallet balance</span><div class="currency-toggle" role="group" aria-label="Choose wallet display currency"><button type="button" class="currency-toggle-option is-active" data-currency-toggle="NGN" aria-pressed="true"><span>₦</span> NGN</button><button type="button" class="currency-toggle-option" data-currency-toggle="USD" aria-pressed="false"><span>$</span> USD</button></div><select id="balanceCurrency" class="currency-select-accessible" aria-label="Wallet display currency"><option value="NGN" selected>Naira (NGN)</option><option value="USD">US Dollars (USD)</option></select><strong id="totalBalance">—</strong><p class="muted small" id="balanceConversionNote">Loading your wallet balances…</p></div><div class="stat"><span class="muted small">Naira wallet</span><strong id="walletNgn">₦0.00</strong><p class="muted small">Available NGN balance</p></div><div class="stat"><span class="muted small">Dollar wallet</span><strong id="walletUsd">$0.00</strong><p class="muted small">Available USD balance</p></div><div class="stat"><span class="muted small">Investment balance</span><strong>—</strong><p class="muted small">Awaiting verified records</p></div><div class="stat"><span class="muted small">Earnings</span><strong>—</strong><p class="muted small">Awaiting verified records</p></div><div class="stat"><span class="muted small">Verification</span><strong>' + esc(verificationStatus) + '</strong><a class="metric-link" href="/kyc">' + esc(verificationHint) + ' <span aria-hidden="true">→</span></a></div></div>' +
      '<div class="dashboard-section referral-summary"><div><span class="muted small">SUCCESSFUL REFERRALS</span><strong>' + (Number(counts[0].total) || 0) + '</strong></div><a href="/referrals">View referrals <span aria-hidden="true">→</span></a></div>' +
      '<section class="dashboard-notifications"><div class="dashboard-notifications-heading"><div><span class="muted small">ACCOUNT UPDATES</span><h3>Notifications</h3><p class="muted small">'+(unreadNotificationCount ? unreadNotificationCount+' unread' : 'You’re up to date')+'</p></div><a href="/notifications" class="notification-view-all">View all <span aria-hidden="true">→</span></a></div>' +
      (dashboardNotifications.length ? '<div class="dashboard-notification-list">' + dashboardNotifications.map(function(n){const safeTarget=typeof n.target_url==='string' && /^\/(?!\/)/.test(n.target_url) ? n.target_url : '/notifications'; return '<a class="dashboard-notification-item '+(n.read_at?'is-read':'is-unread')+'" href="'+esc(safeTarget)+'"><span class="dashboard-notification-indicator" aria-hidden="true"></span><span class="dashboard-notification-copy"><strong>'+esc(n.title)+'</strong><span>'+esc(n.body)+'</span><small>'+esc(n.created_at)+'</small></span><span class="dashboard-notification-state">'+(n.read_at?'Read':'New')+'</span></a>';}).join('') + '</div>' : '<p class="dashboard-notifications-empty">No notifications yet. Important account updates will appear here.</p>') +
      '</section></section>' +
      '<section class="dashboard-section action-section"><div class="section-heading-row"><div><h2>Quick actions</h2><p class="muted">Everything you need, one tap away.</p></div><a href="/transactions" class="muted small">Activity <span aria-hidden="true">↗</span></a></div><div class="quick-action-grid" id="quickActions"><a href="/deposit"><span>＋</span><strong>Deposit</strong><small>Add funds</small></a><a href="/withdraw"><span>↗</span><strong>Withdraw</strong><small>Cash out</small></a><a href="/kyc"><span>◇</span><strong>Verify</strong><small>Identity check</small></a><a href="/transactions"><span>↻</span><strong>History</strong><small>Transactions</small></a><a href="/referrals"><span>♧</span><strong>Referrals</strong><small>Invite friends</small></a><a href="/profile"><span>◉</span><strong>Profile</strong><small>Account details</small></a></div><button class="show-more-actions" type="button" id="toggleActions" aria-expanded="false" hidden>More actions</button></section>' +
      '<section class="dashboard-section"><div class="dashboard-topline"><div><h2>Account activity</h2><p class="muted">Your member ID and referral count are live account information. Financial activity will appear once the transaction ledger is connected.</p></div><a href="/transactions" class="copy-btn" style="text-decoration:none">View activity</a></div><div class="section-card"><strong>Membership active</strong><p class="muted small">Your Monarch ID is ready to use. No deposit, withdrawal, or earnings history is being fabricated or displayed as real.</p></div></section>' +
      '</section></div></div>';
    res.send(page('Member dashboard', body + '<script src="/wallet-balances.js" defer></script>' + "<script>(function(){var layout=document.querySelector(\".dashboard-layout\");if(!layout)return;var openers=layout.querySelectorAll(\"[data-sidebar-open]\"),closers=layout.querySelectorAll(\"[data-sidebar-close]\"),collapse=layout.querySelector(\"[data-sidebar-collapse\");function close(){layout.classList.remove(\"sidebar-open\")}openers.forEach(function(b){b.addEventListener(\"click\",function(){layout.classList.add(\"sidebar-open\")})});closers.forEach(function(b){b.addEventListener(\"click\",close)});if(collapse)collapse.addEventListener(\"click\",function(){layout.classList.toggle(\"sidebar-collapsed\");collapse.setAttribute(\"aria-expanded\",String(!layout.classList.contains(\"sidebar-collapsed\")))});document.addEventListener(\"keydown\",function(e){if(e.key===\"Escape\")close()});})();</script>"));
  } catch (e) { next(e); }
});

function memberPage(title, active, member, content, req) {
  const items = [['/dashboard','Overview','◫'],['/profile','Profile','◎'],['/kyc','Verification','◇'],['/deposit','Deposit','＋'],['/withdraw','Withdraw','↗'],['/transactions','Transactions','↔'],['/referrals','Referrals','♧']];
  const nav = items.map(([href,label,mark]) => '<a href="' + href + '"' + (href===active?' aria-current="page"':'') + '><span class="member-nav-icon" aria-hidden="true">' + mark + '</span><span>' + label + '</span></a>').join('');
  const firstName = esc((member.full_name || 'Member').split(' ')[0]);
  const uid = esc(member.monarch_uid || 'Pending');
  const body = '<link rel="stylesheet" href="/member-dashboard.css"><div class="member-experience"><aside class="member-rail" id="memberRail"><a class="member-brand" href="/dashboard"><span class="member-brand-mark"><img src="/assets/images/monarch-codex-logo.svg" alt="Monarch Codex" style="width:100%;height:100%;object-fit:contain"></span><span><strong>MONARCH</strong><small>CODEX</small></span></a><div class="member-rail-label">YOUR ACCOUNT</div><nav aria-label="Member navigation">' + nav + '</nav><div class="member-rail-account"><span class="member-rail-label">MEMBER ID</span><div class="member-rail-uid"><strong id="memberUid">' + uid + '</strong><button type="button" class="member-copy-uid" data-copy-uid aria-label="Copy member ID">Copy</button></div><small>Keep your account details private.</small></div><div class="member-rail-logout"><form method="post" action="/logout">' + csrfField(req) + '<button type="submit">↪ <span>Log out</span></button></form></div></aside><div class="member-workspace"><header class="member-mobile-head"><button type="button" class="member-menu-toggle" aria-label="Open navigation" aria-expanded="false" data-member-menu>☰</button><a class="member-brand" href="/dashboard"><span class="member-brand-mark"><img src="/assets/images/monarch-codex-logo.svg" alt="Monarch Codex" style="width:100%;height:100%;object-fit:contain"></span><span><strong>MONARCH</strong><small>CODEX</small></span></a><span class="member-live-dot" aria-label="Secure account"></span></header><div class="member-page-heading"><div><p class="member-overline">MONARCH CODEX / MEMBER AREA</p><h1>' + firstName + ', welcome back.</h1><p>Manage your account, verification and funds in one place.</p></div><div class="member-heading-status"><span></span> Account workspace</div></div><main class="member-main"><div class="member-content-heading"><div><span class="member-overline">ACCOUNT MANAGEMENT</span><h2>' + esc(title) + '</h2></div><span class="member-secure-label">⌑ Secure session</span></div>' + content + '</main><footer class="member-footer"><span>MONARCH CODEX</span><span>Move with clarity. Build with purpose.</span></footer></div></div><div class="member-mobile-scrim" data-member-close></div><div class="page-loading" id="pageLoading" aria-live="polite"><span class="page-spinner"></span><strong>Opening page…</strong></div><script>(function(){var rail=document.getElementById("memberRail"),toggle=document.querySelector("[data-member-menu]"),scrim=document.querySelector("[data-member-close]");function close(){rail.classList.remove("is-open");scrim.classList.remove("is-visible");if(toggle)toggle.setAttribute("aria-expanded","false")}if(toggle)toggle.addEventListener("click",function(){rail.classList.toggle("is-open");scrim.classList.toggle("is-visible");toggle.setAttribute("aria-expanded",rail.classList.contains("is-open")?"true":"false")});if(scrim)scrim.addEventListener("click",close);document.querySelectorAll(".member-experience nav a").forEach(function(a){a.addEventListener("click",function(){var loader=document.getElementById("pageLoading");if(loader)loader.classList.add("show")})});var copy=document.querySelector("[data-copy-uid]");if(copy)copy.addEventListener("click",async function(){try{await navigator.clipboard.writeText(document.getElementById("memberUid").textContent);copy.textContent="Copied";setTimeout(function(){copy.textContent="Copy"},1400)}catch(e){copy.textContent="Select ID"}})})();</script>';
  return page('Member dashboard', body);
}
function wizardPage(title, content, req) {
  if (title === 'KYC Verification') {
    const body = '<link rel="stylesheet" href="/kyc-wizard.css"><div class="kyc-page"><header class="kyc-page-head"><a class="kyc-cancel" href="/dashboard">Cancel</a><div><p class="kyc-eyebrow">ACCOUNT VERIFICATION</p><h1>KYC Verification</h1></div><span class="kyc-head-spacer" aria-hidden="true"></span></header>' + content + '</div><script src="/kyc-wizard.js" defer></script>';
    return page(title, body);
  }
  const body = '<style>.wizard-shell{max-width:680px;margin:24px auto;padding:clamp(18px,4vw,34px);min-height:70vh}.wizard-head{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:30px}.wizard-head h1{font-size:1.2rem;margin:0}.wizard-cancel{color:#d7d4cb;text-decoration:none;border:1px solid #403a27;border-radius:10px;padding:10px 14px}.wizard-progress{display:flex;align-items:flex-start;gap:0;margin:0 0 32px}.wizard-progress .wizard-node{display:flex;flex-direction:column;align-items:center;gap:8px;flex:1;min-width:0;color:#8d897e;font-size:.78rem;text-align:center}.wizard-progress .wizard-dot{display:grid;place-items:center;width:32px;height:32px;border-radius:50%;border:1px solid #514721;background:#111115;color:#aaa}.wizard-progress .wizard-node.active .wizard-dot,.wizard-progress .wizard-node.done .wizard-dot{background:#f3cf3c;border-color:#f3cf3c;color:#17140a}.wizard-progress .wizard-node.active,.wizard-progress .wizard-node.done{color:#f3cf3c}.wizard-track{height:2px;background:#403a27;flex:1;margin:15px -2px 0;position:relative}.wizard-track span{display:block;height:100%;width:0;background:#f3cf3c;transition:width .3s ease}.wizard-panel{padding:clamp(18px,4vw,30px);border:1px solid #403a27;border-radius:18px;background:#111115}.wizard-panel h2{margin-top:0}.wizard-actions{display:flex;justify-content:space-between;gap:12px;margin-top:28px}.wizard-actions button{min-width:120px}.wizard-actions .wizard-continue{margin-left:auto}.wizard-foot{color:#8d897e;font-size:.85rem;margin-top:16px}.wizard-panel .member-card{padding:0;border:0;background:transparent}.wizard-panel .member-steps{display:none}@media(max-width:520px){.wizard-shell{margin:8px auto;padding:14px}.wizard-progress .wizard-node{font-size:.68rem}.wizard-progress .wizard-dot{width:28px;height:28px}.wizard-track{margin-top:13px}}</style><div class="wizard-shell"><header class="wizard-head"><a class="wizard-cancel" href="/dashboard">Cancel</a><h1>' + esc(title) + '</h1><span style="width:60px"></span></header><main class="wizard-panel">' + content + '</main></div><script>(function(){var k=document.getElementById("kycWizard"),d=document.getElementById("depositWizard");var form=k||d;if(!form)return;var isKyc=!!k;var progress=document.createElement("div");progress.className="wizard-progress";var count=isKyc?4:3;var names=isKyc?["Details","Address","Identity","Review"]:["Amount","Payment","Review"];for(var i=0;i<count;i++){if(i){var track=document.createElement("div");track.className="wizard-track";track.innerHTML="<span></span>";progress.appendChild(track)}var node=document.createElement("div");node.className="wizard-node";node.innerHTML="<span class=wizard-dot>"+(i+1)+"</span><span>"+names[i]+"</span>";progress.appendChild(node)}form.parentNode.insertBefore(progress,form);var steps=[].slice.call(form.querySelectorAll(isKyc?".kyc-step":".deposit-step"));var next=document.getElementById(isKyc?"kycNext":"depositNext"),back=document.getElementById(isKyc?"kycBack":"depositBack");function sync(){var idx=steps.findIndex(function(x){return !x.hidden});if(idx<0)idx=0;var nodes=progress.querySelectorAll(".wizard-node"),tracks=progress.querySelectorAll(".wizard-track span");nodes.forEach(function(n,i){n.classList.toggle("active",i===idx);n.classList.toggle("done",i<idx)});tracks.forEach(function(t,i){t.style.width=idx>i?"100%":"0"});if(back)back.textContent="Back";if(next)next.classList.add("wizard-continue")}var observer=new MutationObserver(sync);steps.forEach(function(x){observer.observe(x,{attributes:true,attributeFilter:["hidden"]})});if(next)next.addEventListener("click",function(){setTimeout(sync,0)});if(back)back.addEventListener("click",function(){setTimeout(sync,0)});sync()})();</script>';
  return page(title, body);
}
async function getMemberForPage(req, res) {
  const [rows] = await pool.execute('SELECT id, monarch_uid, full_name, email, username FROM members WHERE id = ? LIMIT 1', [req.session.memberId]);
  if (rows.length) return rows[0];
  req.session.destroy(() => res.redirect('/login'));
  return null;
}

// Profile changes are authenticated, validated, and constrained by KYC status.
function profileKey() {
  const key = Buffer.from(String(process.env.KYC_ENCRYPTION_KEY || ''), 'base64');
  if (key.length !== 32) { const e = new Error('Profile encryption is not configured.'); e.status = 503; throw e; }
  return key;
}
function encryptProfileValue(value) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', profileKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}
function decryptProfileValue(value) {
  if (!value) return '';
  const data = Buffer.from(value, 'base64'), iv = data.subarray(0,12), tag = data.subarray(12,28), encrypted = data.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', profileKey(), iv); decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}
const profilePhotoUpload = multer({storage:multer.memoryStorage(),limits:{fileSize:3*1024*1024},fileFilter:(_req,file,cb)=>cb(null,['image/jpeg','image/png','image/webp'].includes(file.mimetype))}).single('profilePhoto');
app.get('/profile', requireAuth, async (req,res,next)=>{
  try {
    const [rows] = await pool.execute('SELECT id,monarch_uid,full_name,email,username FROM members WHERE id=? LIMIT 1',[req.session.memberId]);
    const m=rows[0]; if(!m){req.session.destroy(()=>res.redirect('/login'));return;}
    let profile={phone:'',bankName:'',bankAccountName:'',bankAccountNumber:'',avatarKey:null,kycLocked:false};
    try {
      const [p]=await pool.execute('SELECT phone_number,bank_details_ciphertext,avatar_key FROM member_profiles WHERE member_id=? LIMIT 1',[m.id]);
      if(p.length){profile.phone=p[0].phone_number||'';profile.avatarKey=p[0].avatar_key; if(p[0].bank_details_ciphertext){const b=JSON.parse(decryptProfileValue(p[0].bank_details_ciphertext));profile.bankName=b.bankName||'';profile.bankAccountName=b.bankAccountName||'';profile.bankAccountNumber=b.bankAccountNumber||'';}}
    } catch(e){if(e.code!=='ER_NO_SUCH_TABLE')throw e;}
    let savedBankRows=[];
    try { [savedBankRows]=await pool.execute('SELECT id,details_ciphertext,created_at FROM member_bank_accounts WHERE member_id=? AND deleted_at IS NULL ORDER BY id DESC',[m.id]); }
    catch(e){if(e.code!=='ER_NO_SUCH_TABLE')throw e;}
    const savedBanks=savedBankRows.map(row=>({id:row.id,...JSON.parse(decryptProfileValue(row.details_ciphertext))}));
    try {const [k]=await pool.execute("SELECT id FROM kyc_submissions WHERE member_id=? AND status IN ('pending','approved') LIMIT 1",[m.id]);profile.kycLocked=k.length>0;} catch(e){if(e.code!=='ER_NO_SUCH_TABLE')throw e;}
    const avatar=profile.avatarKey?'/member-avatar/'+encodeURIComponent(profile.avatarKey):'/assets/images/monarch-codex-logo.svg';
    const lock=profile.kycLocked;
    const content='<style>.profile-head{display:flex;gap:18px;align-items:center;margin-bottom:24px}.profile-avatar{width:96px;height:96px;object-fit:cover;border-radius:50%;border:2px solid #f3cf3c;background:#17171c}.profile-form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 16px}.profile-form-grid .full{grid-column:1/-1}.profile-card{padding:20px;border:1px solid #403a27;border-radius:16px;background:#111115;margin:16px 0}.profile-card h3{margin-top:0}.profile-save{width:auto;padding:12px 24px}.profile-hint{color:#b8b6c0;font-size:.86rem}.saved-bank-row{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 0;border-top:1px solid #403a27}.saved-bank-row form{margin:0}.profile-public{color:#f3cf3c}@media(max-width:520px){.profile-form-grid{grid-template-columns:1fr}.profile-form-grid .full{grid-column:auto}.profile-head{align-items:flex-start}.profile-avatar{width:76px;height:76px}}</style>'+
      '<div class="profile-head"><img class="profile-avatar" src="'+avatar+'" alt="Profile picture" id="profileAvatar"><div><h3>'+esc(m.full_name)+'</h3><p class="muted">@'+esc(m.username)+'</p><a class="profile-public" href="/members/'+encodeURIComponent(m.username)+'">View public profile ↗</a></div></div>'+
      '<div class="profile-card"><h3>Profile picture</h3><p class="profile-hint">JPG, PNG or WebP, up to 3 MB. Your picture is shown on your public profile.</p><form method="post" action="/profile/photo" enctype="multipart/form-data">'+csrfField(req)+'<label for="profilePhoto">Choose a picture</label><input id="profilePhoto" name="profilePhoto" type="file" accept="image/jpeg,image/png,image/webp" required><button class="btn profile-save" type="submit">Upload picture</button></form></div>'+
      '<form method="post" action="/profile" class="profile-card">'+csrfField(req)+'<h3>Personal details</h3><div class="profile-form-grid"><div><label for="fullName">Full name</label><input id="fullName" name="fullName" value="'+esc(m.full_name)+'" maxlength="160" required '+(lock?'readonly':'')+'></div><div><label for="username">Username</label><input id="username" name="username" value="'+esc(m.username)+'" pattern="[A-Za-z0-9_]{3,30}" maxlength="30" required></div><div><label for="email">Email</label><input id="email" type="email" name="email" value="'+esc(m.email)+'" maxlength="254" required></div><div><label for="phone">Phone number</label><input id="phone" type="tel" name="phone" value="'+esc(profile.phone)+'" maxlength="32" autocomplete="tel"></div></div><p class="profile-hint">'+(lock?'Your legal name is locked while KYC is pending or approved. If your application was rejected, correct your details and resubmit.':'You can update your name until you submit KYC. Once KYC starts, your name is locked to protect verification integrity.')+'</p><button class="btn profile-save" type="submit">Save personal details</button></form>'+
      '<section class="profile-card"><h3>Saved bank accounts</h3><p class="profile-hint">Your bank accounts are stored encrypted and remain private. You can add more than one and choose a saved account when withdrawals are enabled.</p>'+ (savedBanks.length?savedBanks.map(b=>'<div class="saved-bank-row"><div><strong>'+esc(b.bankName)+'</strong><div class="profile-hint">'+esc(b.bankAccountName)+' · account ending '+esc(String(b.bankAccountNumber||'').slice(-4))+'</div></div><form method="post" action="/profile/bank/'+encodeURIComponent(b.id)+'/delete">'+csrfField(req)+'<button class="btn profile-save" type="submit" aria-label="Remove bank account">Remove</button></form></div>').join(''):'<p class="profile-hint">No saved bank accounts yet.</p>')+'</section>'+
      '<form method="post" action="/profile/bank" class="profile-card">'+csrfField(req)+'<h3>Add a bank account</h3><p class="profile-hint">Enter the account details exactly as registered with your bank. Saving details does not initiate a payment.</p><div class="profile-form-grid"><div><label for="bankName">Bank name</label><input id="bankName" name="bankName" maxlength="120" required></div><div><label for="bankAccountName">Account name</label><input id="bankAccountName" name="bankAccountName" maxlength="160" required></div><div class="full"><label for="bankAccountNumber">Account number</label><input id="bankAccountNumber" name="bankAccountNumber" inputmode="numeric" maxlength="34" autocomplete="off" required></div></div><button class="btn profile-save" type="submit">Save bank account</button></form>';
    res.send(memberPage('Profile','/profile',m,content,req));
  } catch(e){next(e);}
});
app.post('/profile', requireAuth, csrfCheck, async(req,res,next)=>{
  try{
    const fullName=String(req.body.fullName||'').trim(),username=String(req.body.username||'').trim(),email=String(req.body.email||'').trim().toLowerCase(),phone=String(req.body.phone||'').trim();
    if(!/^[A-Za-z0-9_]{3,30}$/.test(username)||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254||phone.length>32||fullName.length===0||fullName.length>160) return res.status(400).send(page('Invalid profile','<h1>Check your profile details</h1><a class="btn" href="/profile">Back to profile</a>'));
    let hasKyc=false;
    try { const [[status]]=await pool.execute("SELECT EXISTS(SELECT 1 FROM kyc_submissions WHERE member_id=? AND status IN ('pending','approved')) AS has_kyc",[req.session.memberId]); hasKyc=Number(status.has_kyc)>0; }
    catch(e){if(e.code!=='ER_NO_SUCH_TABLE')throw e;}
    if(hasKyc){const [[m]]=await pool.execute('SELECT full_name FROM members WHERE id=?',[req.session.memberId]);if(fullName!==m.full_name)return res.status(400).send(page('Name locked','<h1>Your name is locked</h1><p class="muted">Your KYC is pending or approved. Your legal name cannot be changed during this status.</p><a class="btn" href="/profile">Back to profile</a>'));}
    const [[dupe]]=await pool.execute('SELECT SUM(username = ?) AS username_used, SUM(email = ?) AS email_used FROM members WHERE id <> ?',[username,email,req.session.memberId]);
    if(Number(dupe.username_used)>0||Number(dupe.email_used)>0)return res.status(409).send(page('Profile conflict','<h1>Username or email is already in use</h1><a class="btn" href="/profile">Back to profile</a>'));
    await pool.execute('UPDATE members SET full_name=?,username=?,email=? WHERE id=?',[fullName,username,email,req.session.memberId]);
    await pool.execute('INSERT INTO member_profiles (member_id,phone_number) VALUES (?,?) ON DUPLICATE KEY UPDATE phone_number=VALUES(phone_number)',[req.session.memberId,phone||null]);
    res.redirect('/profile');
  }catch(e){if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).send(page('Profile setup required','<h1>Profile updates are not configured yet</h1><p class="muted">The site owner must apply the member profile migration first.</p>'));next(e);}
});
app.post('/profile/bank', requireAuth, csrfCheck, async(req,res,next)=>{
  try{
    const bankName=String(req.body.bankName||'').trim(),bankAccountName=String(req.body.bankAccountName||'').trim(),bankAccountNumber=String(req.body.bankAccountNumber||'').trim();
    if(!bankName||!bankAccountName||!/^\d{6,34}$/.test(bankAccountNumber)||bankName.length>120||bankAccountName.length>160||(/[<>]/.test(bankName+bankAccountName)))return res.status(400).send(page('Invalid bank details','<h1>Check your bank details</h1><p class="muted">Enter a bank name, account name, and account number containing 6–34 digits.</p><a class="btn" href="/profile">Back to profile</a>'));
    const ciphertext=encryptProfileValue(JSON.stringify({bankName,bankAccountName,bankAccountNumber}));
    await pool.execute('INSERT INTO member_bank_accounts (member_id,details_ciphertext) VALUES (?,?)',[req.session.memberId,ciphertext]);
    res.redirect('/profile');
  }catch(e){if(e.code==='ER_NO_SUCH_TABLE'||e.status===503)return res.status(503).send(page('Profile setup required','<h1>Bank accounts are not configured yet</h1><p class="muted">The site owner must apply the bank-account migration first.</p><a class="btn" href="/profile">Back to profile</a>'));next(e);}
});
app.post('/profile/bank/:id/delete', requireAuth, csrfCheck, async(req,res,next)=>{
  try{
    const id=Number(req.params.id);
    if(!Number.isSafeInteger(id)||id<1)return res.status(400).send(page('Invalid bank account','<h1>Invalid bank account</h1><a class="btn" href="/profile">Back to profile</a>'));
    await pool.execute('UPDATE member_bank_accounts SET deleted_at=CURRENT_TIMESTAMP WHERE id=? AND member_id=? AND deleted_at IS NULL',[id,req.session.memberId]);
    res.redirect('/profile');
  }catch(e){if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).send(page('Bank accounts not configured','<h1>Apply the bank-account migration first</h1><a class="btn" href="/profile">Back to profile</a>'));next(e);}
});
app.post('/profile/photo', requireAuth, (req,res,next)=>profilePhotoUpload(req,res,async err=>{
  if(err)return res.status(400).send(page('Photo upload failed','<h1>Choose a JPG, PNG or WebP image under 3 MB.</h1><a class="btn" href="/profile">Back to profile</a>'));
  try{
    csrfCheck(req,res,async csrfErr=>{
      if(csrfErr)return;
      if(!req.file)return res.status(400).send(page('Photo required','<h1>Choose a profile picture</h1><a class="btn" href="/profile">Back to profile</a>'));
      const mime=req.file.mimetype,buf=req.file.buffer;
      const valid=(mime==='image/jpeg'&&buf[0]===255&&buf[1]===216&&buf[2]===255)||(mime==='image/png'&&buf.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))||(mime==='image/webp'&&buf.toString('ascii',0,4)==='RIFF'&&buf.toString('ascii',8,12)==='WEBP');
      if(!valid)return res.status(400).send(page('Invalid image','<h1>That file is not a valid supported image.</h1><a class="btn" href="/profile">Back to profile</a>'));
      const dir=process.env.PROFILE_UPLOAD_DIR;
      if(!dir||!path.isAbsolute(dir)||dir===path.resolve(__dirname)||dir.startsWith(path.resolve(__dirname)+path.sep))return res.status(503).send(page('Uploads unavailable','<h1>Profile photo storage is not configured</h1><p class="muted">The site owner must configure private upload storage.</p>'));
      fs.mkdirSync(dir,{recursive:true,mode:0o700});
      const key=crypto.randomBytes(24).toString('hex')+({ 'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp'}[mime]);
      fs.writeFileSync(path.join(dir,key),buf,{mode:0o600,flag:'wx'});
      await pool.execute('INSERT INTO member_profiles (member_id,avatar_key) VALUES (?,?) ON DUPLICATE KEY UPDATE avatar_key=VALUES(avatar_key)',[req.session.memberId,key]);
      res.redirect('/profile');
    });
  }catch(e){next(e);}
}));
app.get('/member-avatar/:key', async(req,res,next)=>{
  try{
    const key=String(req.params.key||'');
    if(!/^[a-f0-9]{48}\.(jpg|png|webp)$/.test(key))return res.sendStatus(404);
    const [rows]=await pool.execute('SELECT member_id FROM member_profiles WHERE avatar_key=? LIMIT 1',[key]);
    if(!rows.length)return res.sendStatus(404);
    const dir=process.env.PROFILE_UPLOAD_DIR;
    if(!dir||!path.isAbsolute(dir)||dir===path.resolve(__dirname)||dir.startsWith(path.resolve(__dirname)+path.sep))return res.sendStatus(404);
    res.set('Cache-Control','public, max-age=3600');
    res.sendFile(path.join(dir,key),{headers:{'X-Content-Type-Options':'nosniff'}},err=>{if(err&&!res.headersSent)res.sendStatus(404);});
  }catch(e){next(e);}
});
app.get('/members/:username', async(req,res,next)=>{
  try{
    const username=String(req.params.username||'');
    const [rows]=await pool.execute('SELECT id,full_name,username FROM members WHERE username=? LIMIT 1',[username]);
    if(!rows.length)return res.status(404).send(page('Profile not found','<h1>Member not found</h1><a class="btn" href="/">Return home</a>'));
    let avatar='/assets/images/monarch-codex-logo.svg';
    try{const [p]=await pool.execute('SELECT avatar_key FROM member_profiles WHERE member_id=? LIMIT 1',[rows[0].id]);if(p[0]&&p[0].avatar_key)avatar='/member-avatar/'+encodeURIComponent(p[0].avatar_key);}catch(e){if(e.code!=='ER_NO_SUCH_TABLE')throw e;}
    const body='<style>.public-profile{max-width:560px;margin:0 auto;text-align:center}.public-avatar{width:130px;height:130px;object-fit:cover;border-radius:50%;border:2px solid #f3cf3c;margin:10px auto 20px;display:block}</style><div class="public-profile"><img class="public-avatar" src="'+avatar+'" alt="Profile picture"><h1>'+esc(rows[0].full_name)+'</h1><p class="muted">@'+esc(rows[0].username)+'</p><p class="muted">Monarch Codex member</p><a class="btn" href="/">Return to Monarch Codex</a></div>';
    res.send(page('Member profile',body));
  }catch(e){next(e);}
});


const kycUploadLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false });
function getKycStorageConfig() {
  const directory = process.env.KYC_STORAGE_DIR;
  const keyText = process.env.KYC_ENCRYPTION_KEY;
  if (!directory || !path.isAbsolute(directory) || directory === path.resolve(__dirname) || directory.startsWith(path.resolve(__dirname) + path.sep)) {
    const err = new Error('Private KYC storage must be configured as an absolute directory outside the application folder.');
    err.status = 503; throw err;
  }
  let key;
  try { key = Buffer.from(keyText || '', 'base64'); } catch (_) { key = Buffer.alloc(0); }
  if (key.length !== 32) { const err = new Error('KYC encryption key is not configured.'); err.status = 503; throw err; }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return { directory, key };
}
function encryptKycBuffer(buffer, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  return Buffer.concat([Buffer.from('MC1'), iv, cipher.getAuthTag(), encrypted]);
}
function decryptKycBuffer(payload, key) {
  if (!Buffer.isBuffer(payload) || payload.length < 31 || payload.subarray(0,3).toString('ascii') !== 'MC1') throw new Error('Invalid encrypted KYC file.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, payload.subarray(3,15));
  decipher.setAuthTag(payload.subarray(15,31));
  return Buffer.concat([decipher.update(payload.subarray(31)), decipher.final()]);
}
const kycUpload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 3, fileSize: 8 * 1024 * 1024, fields: 20, fieldSize: 4096 },
  fileFilter: (_req, file, cb) => {
    if (!['image/jpeg', 'image/png'].includes(file.mimetype)) return cb(new Error('Only JPG and PNG identity images are accepted.'));
    cb(null, true);
  }
}).fields([{ name: 'documentFront', maxCount: 1 }, { name: 'documentBack', maxCount: 1 }, { name: 'selfie', maxCount: 1 }]);
function validKycText(value, max) { return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max; }
app.post('/kyc/submit', requireAuth, kycUploadLimiter, (req, res, next) => {
  kycUpload(req, res, async err => {
    if (err) return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Each image must be 8 MB or smaller.' : 'Upload rejected. Use JPG or PNG images.' });
    try {
      csrfCheck(req, res, async csrfErr => {
        if (csrfErr) return;
        let config;
        try { config = getKycStorageConfig(); } catch (e) { return res.status(e.status || 503).json({ error: 'Secure KYC storage is not configured yet.' }); }
        const b = req.body || {};
        const [existingKycRows] = await pool.execute('SELECT status FROM kyc_submissions WHERE member_id=? ORDER BY submitted_at DESC,id DESC LIMIT 1',[req.session.memberId]);
        if (existingKycRows.length && ['pending','approved'].includes(existingKycRows[0].status)) {
          const alreadyApproved = existingKycRows[0].status === 'approved';
          return res.status(409).json({
            error: alreadyApproved ? 'Your KYC is already approved. You do not need to submit it again.' : 'Your KYC is already under review. Please wait for the review result.',
            status: existingKycRows[0].status
          });
        }
        const files = req.files || {};
        const front = files.documentFront && files.documentFront[0];
        const back = files.documentBack && files.documentBack[0];
        const selfie = files.selfie && files.selfie[0];
        const docNumber = String(b.documentNumber || '').trim();
        if (!validKycText(b.legalFullName,160) || !/^\d{4}-\d{2}-\d{2}$/.test(b.dateOfBirth || '') ||
            !validKycText(b.phoneNumber,32) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.contactEmail || '') ||
            !['NG','GH','KE','ZA'].includes(b.countryCode) || !validKycText(b.stateRegion,120) ||
            !validKycText(b.localityLga,120) || !validKycText(b.streetAddress,240) ||
            !['national_id','passport','drivers_license','voters_card'].includes(b.documentType) ||
            !['NG','GH','KE','ZA'].includes(b.documentIssuerCountry) || !validKycText(docNumber,80) ||
            (b.documentType === 'national_id' && b.documentIssuerCountry === 'NG' && !/^\d{11}$/.test(docNumber)) ||
            !front || !selfie || b.confirmOwnership !== 'yes') {
          return res.status(400).json({ error: 'Check all required fields, the NIN length, consent, and required images.' });
        }
        if (![front,back,selfie].filter(Boolean).every(f => ['image/jpeg','image/png'].includes(f.mimetype))) return res.status(400).json({ error: 'Only JPG and PNG images are accepted.' });
        const stored = [];
        try {
          for (const [kind,file] of [['front',front],['back',back],['selfie',selfie]]) {
            if (!file) { stored.push(null); continue; }
            const id = crypto.randomBytes(24).toString('hex') + '.enc';
            fs.writeFileSync(path.join(config.directory,id), encryptKycBuffer(file.buffer,config.key), { flag:'wx', mode:0o600 });
            stored.push(id);
          }
          const numberCipher = encryptKycBuffer(Buffer.from(docNumber,'utf8'),config.key).toString('base64');
          const conn = await pool.getConnection();
          let submissionId;
          try {
            await conn.beginTransaction();
            const [result] = await conn.execute(
              "INSERT INTO kyc_submissions (member_id,legal_full_name,date_of_birth,country_code,state_region,locality_lga,street_address,phone_number,contact_email,document_type,document_issuer_country,document_number_ciphertext,document_number_last4,document_front_private_key,document_back_private_key,selfie_private_key,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending')",
              [req.session.memberId,b.legalFullName.trim(),b.dateOfBirth,b.countryCode,b.stateRegion.trim(),b.localityLga.trim(),b.streetAddress.trim(),b.phoneNumber.trim(),b.contactEmail.trim(),b.documentType,b.documentIssuerCountry,numberCipher,docNumber.slice(-4),stored[0],stored[1],stored[2]]);
            submissionId = result.insertId;
            await conn.execute("INSERT INTO kyc_review_events (submission_id,actor_member_id,event_type) VALUES (?,?,'submitted')",[submissionId,req.session.memberId]);
            await conn.commit();
          } catch (dbErr) { await conn.rollback(); throw dbErr; } finally { conn.release(); }
          return res.status(201).json({ ok:true, submissionId, status:'pending', message:'Your verification has been submitted for review.' });
        } catch (e) {
          for (const id of stored.filter(Boolean)) { try { fs.unlinkSync(path.join(config.directory,id)); } catch (_) {} }
          if (e && e.code === 'ER_NO_SUCH_TABLE') return res.status(503).json({ error:'KYC database migration has not been applied.' });
          console.error('[kyc submission]', e && e.code ? e.code : 'submission_failed');
          return res.status(500).json({ error:'Could not save verification securely. Please try again later.' });
        }
      });
    } catch (e) { next(e); }
  });
});

app.get('/kyc', requireAuth, async (req,res,next) => {
  try {
    const m = await getMemberForPage(req,res);
    if (!m) return;
    let existingKycStatus = null;
    let existingKycNote = '';
    try {
      const [existingKycRows] = await pool.execute('SELECT status, reviewer_note, submitted_at FROM kyc_submissions WHERE member_id=? ORDER BY submitted_at DESC,id DESC LIMIT 1',[m.id]);
      if (existingKycRows.length) {
        existingKycStatus = existingKycRows[0].status;
        existingKycNote = existingKycRows[0].reviewer_note || '';
      }
    } catch (e) { if (e.code !== 'ER_NO_SUCH_TABLE') throw e; }
    let kycReady = false;
    let kycReadinessMessage = 'Secure verification is temporarily unavailable. Your information and documents will not be submitted.';
    try {
      const storage = getKycStorageConfig();
      fs.accessSync(storage.directory, fs.constants.W_OK);
      await pool.execute('SELECT 1 FROM kyc_submissions LIMIT 0');
      await pool.execute('SELECT 1 FROM kyc_review_events LIMIT 0');
      kycReady = true;
      kycReadinessMessage = 'Your identity documents are encrypted before private storage. The server will re-check readiness when you submit.';
    } catch (readinessError) {
      if (readinessError && readinessError.code === 'ER_NO_SUCH_TABLE') {
        kycReadinessMessage = 'Secure verification setup is incomplete because the KYC database migration has not been applied. Your information and documents will not be submitted.';
      } else if (readinessError && ['ER_ACCESS_DENIED_ERROR','ECONNREFUSED','ETIMEDOUT','ENOTFOUND'].includes(readinessError.code)) {
        kycReadinessMessage = 'Secure verification cannot connect to its database right now. Your information and documents will not be submitted.';
      } else if (readinessError && readinessError.status === 503) {
        kycReadinessMessage = 'Secure document storage is not configured yet. Your information and documents will not be submitted.';
      } else {
        console.error('[kyc readiness]', readinessError && readinessError.code ? readinessError.code : 'readiness_check_failed');
        kycReadinessMessage = 'Secure verification could not confirm that storage and database services are ready. Your information and documents will not be submitted.';
      }
    }
    if (existingKycStatus === 'approved') {
      const approvedContent = '<section class="ac-panel"><p class="ac-pill">KYC approved</p><h1>Congratulations, your identity is verified!</h1><p>Your KYC status is approved. You do not need to submit identity documents again.</p><p><a class="btn" href="/dashboard">Return to dashboard</a></p></section>';
      return res.send(memberPage('KYC verification','/kyc',m,approvedContent,req));
    }
    if (existingKycStatus === 'pending') {
      const pendingContent = '<section class="ac-panel"><p class="ac-pill">Under review</p><h1>Your KYC submission is being reviewed</h1><p>Please wait for our review team to contact you by email and through your dashboard notifications. You do not need to submit another application.</p><p><a class="btn" href="/dashboard">Return to dashboard</a></p></section>';
      return res.send(memberPage('KYC verification','/kyc',m,pendingContent,req));
    }
    const statusNotice = existingKycStatus === 'rejected'
      ? '<section class="ac-panel"><h2>Changes needed before verification</h2><p>' + esc(existingKycNote || 'Your previous submission was not approved. Please review your details and submit again.') + '</p></section>'
      : existingKycStatus === 'needs_resubmission'
        ? '<section class="ac-panel"><h2>Please resubmit your verification</h2><p>' + esc(existingKycNote || 'Please review your submitted information and documents, then submit again.') + '</p></section>'
        : '';
    const content = `
      ${statusNotice}
      <div class="kyc-intro">Complete your verification in a few steps. You can go back to check your answers before submitting.</div>
      <div class="kyc-security-note ${kycReady ? 'is-ready' : 'is-unavailable'}" role="status" aria-live="polite"><span class="kyc-lock" aria-hidden="true">◆</span><span><strong>${kycReady ? 'Secure verification ready' : 'Secure verification unavailable'}</strong><small>${esc(kycReadinessMessage)}</small></span></div>
      <div class="kyc-progress" role="list" aria-label="Verification progress">
        <div class="kyc-progress-step is-active" data-progress-step="0" role="listitem"><span class="kyc-step-dot">1</span><span class="kyc-step-name">Personal</span></div><span class="kyc-progress-line"><i></i></span>
        <div class="kyc-progress-step" data-progress-step="1" role="listitem"><span class="kyc-step-dot">2</span><span class="kyc-step-name">Address</span></div><span class="kyc-progress-line"><i></i></span>
        <div class="kyc-progress-step" data-progress-step="2" role="listitem"><span class="kyc-step-dot">3</span><span class="kyc-step-name">Identity</span></div><span class="kyc-progress-line"><i></i></span>
        <div class="kyc-progress-step" data-progress-step="3" role="listitem"><span class="kyc-step-dot">4</span><span class="kyc-step-name">Photos</span></div>
      </div>
      <form id="kycWizard" novalidate>
        ${csrfField(req)}
        <section class="kyc-stage is-current" data-stage="0">
          <p class="kyc-stage-kicker">STEP 01 OF 04</p><h2>Let's start with you</h2><p class="kyc-stage-copy">Enter your personal details exactly as they appear on your identity document.</p>
          <label for="kycName">Full legal name</label><input id="kycName" name="legalFullName" value="${esc(m.full_name)}" maxlength="160" autocomplete="name" required>
          <div class="kyc-two-col"><div><label for="kycDob">Date of birth</label><input id="kycDob" name="dateOfBirth" type="date" required></div><div><label for="kycPhone">Phone number</label><input id="kycPhone" name="phoneNumber" type="tel" maxlength="32" autocomplete="tel" required></div></div>
          <label for="kycEmail">Email address</label><input id="kycEmail" name="contactEmail" type="email" value="${esc(m.email)}" maxlength="254" autocomplete="email" required>
        </section>
        <section class="kyc-stage" data-stage="1" hidden>
          <p class="kyc-stage-kicker">STEP 02 OF 04</p><h2>Where do you live?</h2><p class="kyc-stage-copy">Use your current residential address. We may use it to confirm your identity.</p>
          <label for="kycCountry">Country of residence</label><select id="kycCountry" name="countryCode" required><option value="NG" selected>Nigeria</option><option value="GH">Ghana</option><option value="KE">Kenya</option><option value="ZA">South Africa</option><option value="OTHER">Other</option></select>
          <label for="kycState">State / region</label><input id="kycState" name="stateRegion" maxlength="120" autocomplete="address-level1" required>
          <div class="kyc-two-col"><div><label for="kycLga">City / LGA</label><input id="kycLga" name="localityLga" maxlength="120" autocomplete="address-level2" required></div><div><label for="kycAddress">Street address</label><input id="kycAddress" name="streetAddress" maxlength="240" autocomplete="street-address" required></div></div>
        </section>
        <section class="kyc-stage" data-stage="2" hidden>
          <p class="kyc-stage-kicker">STEP 03 OF 04</p><h2>Verify your identity</h2><p class="kyc-stage-copy">Choose the document you will use and enter its details carefully.</p>
          <label for="kycDocType">Identity document</label><select id="kycDocType" name="documentType" required><option value="">Select a document</option><option value="national_id">National identity card</option><option value="passport">International passport</option><option value="drivers_license">Driver's licence</option><option value="voters_card">Voter's card</option></select>
          <label for="kycDocCountry">Issuing country</label><select id="kycDocCountry" name="documentIssuerCountry" required><option value="NG" selected>Nigeria</option><option value="GH">Ghana</option><option value="KE">Kenya</option><option value="ZA">South Africa</option></select>
          <label for="kycDocNumber">Document number</label><input id="kycDocNumber" name="documentNumber" maxlength="80" autocomplete="off" aria-describedby="kycDocNumberError" required><p id="kycDocNumberError" class="kyc-field-error" role="alert" hidden></p>
          <div class="kyc-hint">Your document details are encrypted before storage. Submit only genuine documents belonging to you.</div>
        </section>
        <section class="kyc-stage" data-stage="3" hidden>
          <p class="kyc-stage-kicker">STEP 04 OF 04</p><h2>Documents & selfie</h2><p class="kyc-stage-copy">Please provide clear images of your document and a selfie. Do not continue if verification is unavailable.</p>
          <div class="kyc-upload-grid">
            <label class="kyc-upload-card" for="kycFront"><span class="kyc-upload-icon">＋</span><strong>Front of ID</strong><small>Upload an image from your device</small><input id="kycFront" name="documentFront" type="file" accept="image/jpeg,image/png" data-preview="kycFrontPreview"><img id="kycFrontPreview" alt="Front of ID preview" hidden></label>
            <label class="kyc-upload-card" for="kycBackImage"><span class="kyc-upload-icon">＋</span><strong>Back of ID</strong><small>Upload the back image from your device</small><input id="kycBackImage" name="documentBack" type="file" accept="image/jpeg,image/png" data-preview="kycBackPreview"><img id="kycBackPreview" alt="Back of ID preview" hidden></label>
            <div class="kyc-upload-card kyc-selfie-card"><span class="kyc-upload-icon">◎</span><strong>Live selfie</strong><small>Use your front camera to take a selfie</small><video id="kycSelfieVideo" autoplay playsinline muted hidden></video><canvas id="kycSelfieCanvas" hidden></canvas><img id="kycSelfiePreview" alt="Captured selfie preview" hidden><div class="kyc-camera-actions"><button type="button" class="kyc-camera-btn" id="kycStartCamera">Open camera</button><button type="button" class="kyc-camera-btn" id="kycCaptureSelfie" hidden>Capture selfie</button><button type="button" class="kyc-camera-btn" id="kycRetakeSelfie" hidden>Retake</button></div><p class="kyc-camera-status" id="kycCameraStatus" aria-live="polite">Selfie is camera capture only; image file selection is disabled.</p></div>
          </div>
          <div class="kyc-consent"><label for="kycConfirm"><input type="checkbox" id="kycConfirm" required> I confirm that the information is accurate and the images belong to me.</label></div>
          <div class="kyc-final-note" id="kycSubmitNotice" role="status">Your documents are encrypted for private storage. Submission is checked securely when you send your application.</div>
        </section>
        <div class="kyc-actions"><button type="button" id="kycBack" class="kyc-btn kyc-btn-secondary" hidden>Back</button><span class="kyc-steps-count" id="kycStepCount">Step 1 of 4</span><button type="button" id="kycNext" class="kyc-btn kyc-btn-primary">Continue <span aria-hidden="true">→</span></button></div>
        <p class="kyc-form-message" id="kycMessage" aria-live="polite"></p>
      </form>`;
    res.send(wizardPage('KYC Verification', content, req));
  } catch (e) { next(e); }
});
app.get('/deposit', requireAuth, async (req,res,next) => {
  try {
    const m=await getMemberForPage(req,res); if(!m)return;
    const [[pricing]] = await pool.query('SELECT base_usd_ngn_rate,markup_percent,bank_fee_usd,wallet_fee_usd FROM deposit_pricing_settings WHERE id=1');
    const [methods] = await pool.query('SELECT id,method_type,currency,label,bank_name,account_name,account_number,bank_code,wallet_network,wallet_asset,wallet_address,instructions FROM deposit_payment_methods WHERE is_active=1 ORDER BY currency,method_type,label');
    const [history] = await pool.query('SELECT d.id,d.currency,d.amount,d.fee_amount,d.total_due,d.payment_reference,d.status,d.created_at,d.reviewer_note,p.label AS payment_label FROM deposit_requests d JOIN deposit_payment_methods p ON p.id=d.payment_method_id WHERE d.member_id=? ORDER BY d.created_at DESC LIMIT 30',[m.id]);
    const baseRate=pricing && pricing.base_usd_ngn_rate!==null ? Number(pricing.base_usd_ngn_rate) : null;
    const effectiveRate=baseRate!==null ? baseRate*(1+Number(pricing.markup_percent)/100) : null;
    const methodsJson=JSON.stringify(methods.map(x=>({id:Number(x.id),method_type:x.method_type,currency:x.currency,label:x.label,bank_name:x.bank_name,account_name:x.account_name,account_number:x.account_number,bank_code:x.bank_code,wallet_network:x.wallet_network,wallet_asset:x.wallet_asset,wallet_address:x.wallet_address,instructions:x.instructions}))).replace(/</g,'\\u003c');
    const pricingJson=JSON.stringify({effectiveRate,bankFeeUsd:Number(pricing.bank_fee_usd),walletFeeUsd:Number(pricing.wallet_fee_usd)}).replace(/</g,'\\u003c');
    const historyRows=history.map(d=>'<tr><td>#'+Number(d.id)+'<br><small>'+esc(d.created_at)+'</small></td><td>'+esc(d.currency+' '+Number(d.amount).toLocaleString('en-US',{maximumFractionDigits:8}))+'<br><small>Fee '+esc(d.currency+' '+Number(d.fee_amount).toLocaleString('en-US',{maximumFractionDigits:8}))+'</small></td><td>'+esc(d.payment_label)+'<br><small>'+esc(d.payment_reference)+'</small></td><td><span class="ac-pill">'+esc(d.status.toUpperCase())+'</span>'+(d.reviewer_note?'<p class="muted small">'+esc(d.reviewer_note)+'</p>':'')+'</td></tr>').join('');
    const notice=req.query.submitted==='1'?'<div class="notice">Your deposit request was submitted and is pending independent payment verification. Your wallet has not been credited yet.</div>':'';
    const notReady=effectiveRate===null?'<div class="notice">Deposits are not open yet. The administrator must configure the current USD/NGN reference rate in Admin → Settings.</div>':(methods.length===0?'<div class="notice">No active payment destinations are available right now. Please check back later.</div>':'');
    const content='<div class="member-card"><h2>Make a deposit</h2><p class="muted">Choose Naira or US Dollars, select an active official payment destination, and enter your payment reference. The calculator updates instantly using the current platform rate and the applicable fee.</p>'+notice+notReady+
      '<form id="depositForm" method="post" action="/deposit" enctype="multipart/form-data">'+csrfField(req)+
      '<label for="depositCurrency">Deposit currency</label><select id="depositCurrency" name="currency" required><option value="NGN">Naira (NGN)</option><option value="USD">US Dollars (USD)</option></select>'+
      '<label for="depositAmount">Deposit amount</label><input id="depositAmount" name="amount" type="number" min="1" max="1000000000" step="0.01" inputmode="decimal" required>'+
      '<label for="depositMethod">Payment destination</label><select id="depositMethod" name="payment_method_id" required><option value="">Choose an active destination</option></select>'+
      '<div id="depositPaymentDetails" class="deposit-payment-details" hidden></div>'+
      '<section class="section-card" aria-live="polite"><h3 style="margin-top:0">Live deposit calculator</h3><p>Applied conversion rate: <strong id="calcRate">—</strong></p><div class="grid"><div class="stat"><span class="muted small">Deposit amount</span><strong id="calcAmount">—</strong></div><div class="stat"><span class="muted small">Transaction fee</span><strong id="calcFee">—</strong><small id="calcFeeOther">—</small></div><div class="stat"><span class="muted small">Total to send</span><strong id="calcTotal">—</strong></div><div class="stat"><span class="muted small">Approx. other-currency value</span><strong id="calcOther">—</strong></div></div><p class="muted small">The fee is added to the deposit amount. The displayed conversion rate already includes the platform rate adjustment; the internal pricing formula is not shown.</p></section>'+
      '<label for="paymentReference">Transfer reference / transaction ID</label><input id="paymentReference" name="payment_reference" maxlength="190" autocomplete="off" required placeholder="Enter the bank transfer reference or blockchain transaction ID">'+
      '<label for="paymentProof">Payment receipt / proof (JPG, PNG, WEBP or PDF · max 5 MB)</label><input id="paymentProof" name="payment_proof" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" required>'+
      '<p class="muted small">Upload a receipt or transaction proof so the admin can verify the payment independently.</p>'+
      '<label for="memberNote">Additional note (optional)</label><textarea id="memberNote" name="member_note" maxlength="1000" rows="3" placeholder="Optional details to help the admin verify your payment"></textarea>'+
      '<button class="btn" type="submit" '+(effectiveRate===null||methods.length===0?'disabled':'')+'>Submit deposit for verification</button><p class="muted small">Do not submit until you have actually sent the payment. Requests remain pending until an administrator independently verifies them.</p></form></div>'+
      '<div class="member-card"><h2>Deposit history</h2><div class="ac-table-wrap"><table class="ac-table"><thead><tr><th>Request</th><th>Amount / fee</th><th>Payment details</th><th>Status</th></tr></thead><tbody>'+(historyRows||'<tr><td colspan="4">No deposit requests yet.</td></tr>')+'</tbody></table></div></div>'+
      '<style>#depositForm label{display:block;margin:14px 0 6px}#depositForm input,#depositForm select,#depositForm textarea{width:100%;padding:12px;border:1px solid #484650;border-radius:10px;background:#0d0d10;color:#fff;font:inherit}#depositForm .btn:disabled{opacity:.45;cursor:not-allowed}.member-card{margin-top:16px}.member-card .section-card{margin-top:18px}.member-card .ac-table{min-width:580px}</style>'+
      '<script>(function(){var methods='+methodsJson+',pricing='+pricingJson+';var currency=document.getElementById("depositCurrency"),amount=document.getElementById("depositAmount"),select=document.getElementById("depositMethod"),details=document.getElementById("depositPaymentDetails");function money(v,c){return new Intl.NumberFormat(c==="NGN"?"en-NG":"en-US",{style:"currency",currency:c,maximumFractionDigits:c==="NGN"?2:2}).format(Number.isFinite(v)?v:0)}function fillMethods(){var old=select.value;select.innerHTML=\"<option value=&quot;&quot;>Choose an active destination</option>\";methods.filter(function(x){return x.currency===currency.value}).forEach(function(x){var o=document.createElement("option");o.value=String(x.id);o.textContent=x.label+" ("+x.method_type+")";select.appendChild(o)});if([].some.call(select.options,function(o){return o.value===old}))select.value=old;render()}function render(){var method=methods.find(function(x){return String(x.id)===select.value});var a=Number(amount.value||0),c=currency.value,r=pricing.effectiveRate,feeUsd=method&&method.method_type==="wallet"?pricing.walletFeeUsd:pricing.bankFeeUsd;document.getElementById("calcRate").textContent=r?("1 USD = "+money(r,"NGN")):"Not configured";if(!method){details.hidden=true;details.replaceChildren();}else{details.hidden=false;details.replaceChildren();var head=document.createElement("div");head.className="deposit-destination-head";var icon=document.createElement("span");icon.className="deposit-asset-icon";icon.textContent=method.method_type==="wallet"?(method.wallet_asset||"◈").slice(0,4):"₦";var heading=document.createElement("div");heading.className="deposit-destination-title";var title=document.createElement("strong");title.textContent=method.label||"Payment destination";var sub=document.createElement("span");sub.textContent=(method.currency||c)+" · "+(method.method_type==="wallet"?"Crypto wallet":"Bank transfer");heading.appendChild(title);heading.appendChild(sub);head.appendChild(icon);head.appendChild(heading);var badge=document.createElement("span");badge.className="deposit-network-badge";badge.textContent=method.method_type==="wallet"?(method.wallet_network||"Network required"):"Official bank details";head.appendChild(badge);details.appendChild(head);var fields=document.createElement("div");fields.className="deposit-destination-fields";function field(label,value,code){if(!value)return;var wrap=document.createElement("div");wrap.className="deposit-destination-field"+(code?" is-address":"");var caption=document.createElement("span");caption.textContent=label;var valueNode=document.createElement(code?"code":"strong");valueNode.textContent=value;wrap.appendChild(caption);wrap.appendChild(valueNode);if(code){var copy=document.createElement("button");copy.type="button";copy.className="deposit-copy-button";copy.textContent="Copy address";copy.addEventListener("click",function(){var done=function(){copy.textContent="Copied!";setTimeout(function(){copy.textContent="Copy address"},1600)};if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(value).then(done).catch(function(){fallbackCopy(value,copy,done)})}else fallbackCopy(value,copy,done)});wrap.appendChild(copy)}fields.appendChild(wrap)}function fallbackCopy(value,button,done){var temp=document.createElement("textarea");temp.value=value;temp.style.position="fixed";temp.style.opacity="0";document.body.appendChild(temp);temp.select();try{if(document.execCommand("copy"))done();else button.textContent="Select address to copy"}catch(e){button.textContent="Copy unavailable"}temp.remove()}if(method.method_type==="bank"){field("Bank",method.bank_name);field("Account name",method.account_name);field("Account number",method.account_number,true);field("Bank code",method.bank_code)}else{field("Asset",method.wallet_asset);field("Wallet address",method.wallet_address,true)}details.appendChild(fields);if(method.instructions){var note=document.createElement("p");note.className="deposit-destination-instructions";note.textContent=method.instructions;details.appendChild(note)}}if(!a||a<0||!r){["calcAmount","calcFee","calcTotal","calcOther","calcFeeOther"].forEach(function(id){document.getElementById(id).textContent="—"});return}var fee=method?(c==="NGN"?feeUsd*r:feeUsd):0;document.getElementById("calcAmount").textContent=money(a,c);document.getElementById("calcFee").textContent=money(fee,c);document.getElementById("calcFeeOther").textContent=c==="NGN"?money(fee/r,"USD"):money(fee*r,"NGN");document.getElementById("calcTotal").textContent=money(a+fee,c);document.getElementById("calcOther").textContent=c==="NGN"?money(a/r,"USD"):money(a*r,"NGN")}currency.addEventListener("change",fillMethods);amount.addEventListener("input",render);select.addEventListener("change",render);fillMethods()})();</script>';
    res.send(wizardPage('Deposit',content,req));
  } catch(e) { if(e.code==='ER_NO_SUCH_TABLE') return res.status(503).send(memberPage('Deposit','/deposit',await getMemberForPage(req,res),'Deposit setup is not complete. The administrator must apply migrations/006_deposit_payment_workflow.sql.',req)); next(e); }
});
app.post('/deposit', requireAuth, parseDepositProof, csrfCheck, async (req,res,next) => {
  const currency=String(req.body.currency||''), methodId=String(req.body.payment_method_id||''), reference=String(req.body.payment_reference||'').trim().slice(0,190), note=String(req.body.member_note||'').trim().slice(0,1000);
  const amount=Number(req.body.amount);
  if (!['NGN','USD'].includes(currency) || !/^\d{1,20}$/.test(methodId) || !Number.isFinite(amount) || amount<=0 || amount>1000000000 || !reference) return res.status(400).send(formError('Check your deposit details','Enter a valid currency, amount, active payment destination and transfer reference.','/deposit'));
  try {
    const m=await getMemberForPage(req,res); if(!m)return;
    const [[pricing]]=await pool.query('SELECT base_usd_ngn_rate,markup_percent,bank_fee_usd,wallet_fee_usd FROM deposit_pricing_settings WHERE id=1');
    if(!pricing || pricing.base_usd_ngn_rate===null || Number(pricing.base_usd_ngn_rate)<=0) return res.status(503).send(formError('Deposits not open','The administrator has not configured the current exchange rate yet.','/deposit'));
    const [[method]]=await pool.execute('SELECT id,method_type,currency,is_active FROM deposit_payment_methods WHERE id=?',[methodId]);
    if(!method || !Number(method.is_active) || method.currency!==currency) return res.status(400).send(formError('Payment destination unavailable','Choose an active payment destination for the selected currency.','/deposit'));
    const base=Number(pricing.base_usd_ngn_rate), rate=base*(1+Number(pricing.markup_percent)/100), feeUsd=method.method_type==='wallet'?Number(pricing.wallet_fee_usd):Number(pricing.bank_fee_usd), fee=currency==='NGN'?feeUsd*rate:feeUsd, total=amount+fee;
    await pool.execute('INSERT INTO deposit_requests (member_id,currency,amount,fee_usd,fee_amount,base_usd_ngn_rate,effective_usd_ngn_rate,total_due,payment_method_id,payment_reference,proof_storage_key,proof_mime_type,proof_original_name,member_note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',[m.id,currency,amount,feeUsd,fee,base,rate,total,methodId,reference,req.file.filename,req.file.mimetype,path.basename(req.file.originalname).slice(0,255),note||null]);
    res.redirect('/deposit?submitted=1');
  } catch(e) { if(req.file) fs.unlink(req.file.path,()=>{}); if(e.code==='ER_DUP_ENTRY') return res.status(409).send(formError('Reference already submitted','This payment reference has already been submitted for your account. Check your deposit history or contact support.','/deposit')); if(e.code==='ER_NO_SUCH_TABLE') return res.status(503).send(dbSetupNotice('Deposit workflow setup required','migrations/006_deposit_payment_workflow.sql')); next(e); }
});
app.get('/withdraw', requireAuth, async (req,res,next)=>{try{const m=await getMemberForPage(req,res);if(!m)return;const [rows]=await pool.execute('SELECT id,details_ciphertext FROM member_bank_accounts WHERE member_id=? AND deleted_at IS NULL ORDER BY id DESC',[m.id]);const banks=rows.map(r=>({id:r.id,...JSON.parse(decryptProfileValue(r.details_ciphertext))}));const body='<div class="member-card"><h2>Withdrawal requests</h2><p class="muted">Choose a saved payout account for a future withdrawal request. Withdrawals remain disabled until KYC approval, payout processing, and the transaction ledger are operational.</p>'+(banks.length?'<form><label for="withdrawBank">Saved bank account</label><select id="withdrawBank" name="bankAccountId" disabled required>'+banks.map(b=>'<option value="'+esc(b.id)+'">'+esc(b.bankName)+' — '+esc(b.bankAccountName)+' (••••'+esc(String(b.bankAccountNumber||'').slice(-4))+')</option>').join('')+'</select><p class="muted">Account selection will be enabled when withdrawal requests go live.</p></form>':'<p>No bank accounts saved yet. <a href="/profile">Add a bank account in your profile</a>.</p>')+'<p><a class="btn" href="/profile">Manage bank accounts</a></p><strong>Withdrawals are currently locked</strong></div>';res.send(memberPage('Withdraw','/withdraw',m,body,req));}catch(e){if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).send(memberPage('Withdraw','/withdraw',await getMemberForPage(req,res),'Withdrawals are unavailable until the bank-account database migration is applied.',req));next(e)}});
app.get('/transactions', requireAuth, async (req,res,next) => {
  try {
    const m=await getMemberForPage(req,res); if(!m)return;
    const [transactions]=await pool.execute('SELECT id,currency,amount,reference,created_at FROM financial_transactions WHERE member_id=? ORDER BY created_at DESC LIMIT 100',[m.id]);
    const [requests]=await pool.execute('SELECT d.id,d.currency,d.amount,d.fee_amount,d.total_due,d.payment_reference,d.status,d.created_at,d.reviewer_note,p.label AS payment_label FROM deposit_requests d JOIN deposit_payment_methods p ON p.id=d.payment_method_id WHERE d.member_id=? ORDER BY d.created_at DESC LIMIT 100',[m.id]);
    const txRows=transactions.map(t=>'<tr><td>'+esc(t.created_at)+'</td><td>Deposit credit</td><td>'+esc(t.currency+' '+Number(t.amount).toLocaleString('en-US',{maximumFractionDigits:8}))+'</td><td>'+esc(t.reference)+'</td><td><span class="ac-pill">COMPLETED</span></td></tr>').join('');
    const reqRows=requests.map(d=>'<tr><td>'+esc(d.created_at)+'</td><td>'+esc(d.payment_label)+'<br><small>'+esc(d.payment_reference)+'</small></td><td>'+esc(d.currency+' '+Number(d.amount).toLocaleString('en-US',{maximumFractionDigits:8}))+'<br><small>Fee: '+esc(d.currency+' '+Number(d.fee_amount).toLocaleString('en-US',{maximumFractionDigits:8}))+' · Total: '+esc(d.currency+' '+Number(d.total_due).toLocaleString('en-US',{maximumFractionDigits:8}))+'</small></td><td><span class="ac-pill">'+esc(d.status.toUpperCase())+'</span>'+(d.reviewer_note?'<p class="muted small">'+esc(d.reviewer_note)+'</p>':'')+'</td></tr>').join('');
    const body='<div class="member-card"><h2>Completed transactions</h2><p class="muted small">Only approved deposits that have been credited to your wallet appear as completed transactions.</p><div class="ac-table-wrap"><table class="ac-table"><thead><tr><th>Date</th><th>Type</th><th>Amount</th><th>Reference</th><th>Status</th></tr></thead><tbody>'+(txRows||'<tr><td colspan="5">No completed transactions yet.</td></tr>')+'</tbody></table></div></div><div class="member-card"><h2>Deposit requests</h2><div class="ac-table-wrap"><table class="ac-table"><thead><tr><th>Date</th><th>Payment destination / reference</th><th>Amount / fee</th><th>Status</th></tr></thead><tbody>'+(reqRows||'<tr><td colspan="4">No deposit requests yet.</td></tr>')+'</tbody></table></div></div><style>.ac-table{width:100%;border-collapse:collapse;min-width:580px}.ac-table th,.ac-table td{padding:12px;text-align:left;border-bottom:1px solid #35323a;vertical-align:top}.ac-table-wrap{overflow-x:auto}</style>';
    res.send(memberPage('Transaction history','/transactions',m,body,req));
  } catch(e) { if(e.code==='ER_NO_SUCH_TABLE') return res.status(503).send(memberPage('Transaction history','/transactions',await getMemberForPage(req,res),'Deposit ledger setup is not complete. Please check back later.',req)); next(e); }
});
app.get('/referrals', requireAuth, async (req,res,next)=>{try{const m=await getMemberForPage(req,res);if(!m)return;const [counts]=await pool.execute('SELECT COUNT(*) AS total FROM members WHERE referred_by = ?',[m.id]);const base=String(process.env.APP_BASE_URL||'https://monarchcodex.online').replace(/\/+$/,'');const link=base+'/register?ref='+encodeURIComponent(m.monarch_uid);const content='<div class="member-card"><p class="muted small">YOUR MONARCH UID</p><div class="copy-value"><strong id="pageUid">'+esc(m.monarch_uid)+'</strong><button class="copy-btn" type="button" data-copy-target="pageUid">Copy UID</button></div><p class="muted small">YOUR PERSONAL REFERRAL LINK</p><div class="copy-value"><input id="pageReferralLink" value="'+esc(link)+'" readonly><button class="copy-btn" type="button" data-copy-target="pageReferralLink">Copy link</button></div><p class="muted small">Referral attribution is recorded when a new account successfully registers using your code.</p></div><div class="grid"><div class="stat"><span class="muted small">Registered referrals</span><strong>'+Number(counts[0].total||0)+'</strong></div></div>';res.send(memberPage('Referrals','/referrals',m,content,req));}catch(e){next(e)}});
app.post('/logout', csrfCheck, (req, res, next) => req.session.destroy(err => {
  if (err) return next(err);
  res.clearCookie('monarch.sid', { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
  res.redirect('/');
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
// Serve only explicitly public website files. Never expose the application directory (server.js, migrations, package files, or private data) through static hosting.
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get(['/privacy.html', '/terms.html', '/market-news.html', '/online-cooperative.html', '/sovereign-desk.html'], (req, res) => {
  res.sendFile(path.join(__dirname, path.basename(req.path)));
});
app.get(['/style.css', '/member-dashboard.css', '/kyc-wizard.css', '/kyc-wizard.js', '/wallet-balances.js'], (req, res) => {
  res.sendFile(path.join(__dirname, path.basename(req.path)));
});
app.use('/assets', express.static(path.join(__dirname, 'assets'), { dotfiles: 'ignore', maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));
app.use((req, res) => res.status(404).send(page('Not found', '<h1>Page not found</h1><a class="btn" href="/">Return to Monarch Codex</a>')));
app.use((err, _req, res, _next) => {
  console.error('[app error]', err && err.message ? err.message : 'Unknown error');
  if (res.headersSent) return;
  res.status(500).send(page('Something went wrong', '<h1>Something went wrong</h1><p class="muted">Please try again shortly.</p><a class="btn" href="/">Return home</a>'));
});
app.listen(port, () => console.log('Monarch Codex server listening on port', port));