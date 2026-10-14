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
const MySQLStore = MySQLStoreFactory(session);
const sessionStore = new MySQLStore({ ...dbOptions, clearExpired: true, checkExpirationInterval: 900000, expiration: 86400000, createDatabaseTable: true, schema: { tableName: 'web_sessions' } });

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
':root{color-scheme:dark;--gold:#f3cf3c;--bg:#0b0b0c;--panel:#17171c;--muted:#b8b6c0}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top,#252111 0,#0b0b0c 45%);color:#f7f5ef;font:16px/1.6 system-ui,-apple-system,Segoe UI,sans-serif;min-height:100vh}.wrap{width:min(100% - 32px,540px);margin:48px auto}.brand{font-weight:900;letter-spacing:.08em;color:var(--gold);text-decoration:none}.panel{margin-top:20px;padding:28px;background:rgba(23,23,28,.96);border:1px solid #55491e;border-radius:22px;box-shadow:0 18px 55px #0007}h1{line-height:1.2;font-size:clamp(1.7rem,5vw,2.3rem);margin:.25em 0}.muted{color:var(--muted)}label{display:block;font-weight:700;margin:15px 0 6px}input{width:100%;padding:13px 14px;border:1px solid #484650;border-radius:10px;background:#0d0d10;color:#fff;font:inherit}input:focus{outline:2px solid var(--gold);outline-offset:1px}.password-wrap{position:relative}.password-wrap input{padding-right:54px}.password-toggle{position:absolute;right:8px;top:50%;transform:translateY(-50%);width:40px;height:40px;display:grid;place-items:center;border:0;border-radius:8px;background:transparent;color:var(--muted);cursor:pointer}.password-toggle:hover,.password-toggle:focus-visible{color:var(--gold);outline:2px solid var(--gold)}.password-toggle svg{width:21px;height:21px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.btn{display:inline-block;width:100%;margin-top:20px;padding:13px 16px;border:0;border-radius:999px;background:var(--gold);color:#121212;font:inherit;font-weight:900;text-align:center;text-decoration:none;cursor:pointer}.links{display:flex;gap:14px;flex-wrap:wrap;margin-top:18px}.links a{color:var(--gold)}.notice{padding:12px 14px;border:1px solid #625222;border-radius:10px;background:#27220f;margin:14px 0}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.stat{padding:15px;border:1px solid #48412a;border-radius:12px}.stat strong{display:block;color:var(--gold);font-size:1.2rem;overflow-wrap:anywhere}.small{font-size:.88rem}footer{margin-top:24px;color:var(--muted);font-size:.85rem}@media(max-width:420px){.panel{padding:20px}.grid{grid-template-columns:1fr}}.wrap.dashboard-wrap{width:min(calc(100% - 32px),1100px);margin:32px auto}.dashboard-wrap .panel{padding:clamp(22px,3.5vw,40px)}.dashboard-wrap .grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.dashboard-wrap .stat{min-width:0}.dashboard-wrap #refLink{font-size:clamp(.85rem,1.5vw,1rem)}.dashboard-wrap .notice{overflow-wrap:anywhere}.dashboard-layout{display:grid;grid-template-columns:248px minmax(0,1fr);gap:24px;align-items:start;margin-top:26px;transition:grid-template-columns .22s ease}.dashboard-sidebar{position:sticky;top:18px;padding:14px;background:linear-gradient(180deg,#17171b,#101013);border:1px solid #3d3520;border-radius:18px;box-shadow:0 16px 40px #0003;min-width:0}.sidebar-brand-row{padding:4px 4px 16px}.dashboard-sidebar .side-title{color:var(--gold);font-size:.7rem;font-weight:900;letter-spacing:.14em;padding:4px 6px 12px}.dashboard-sidebar nav{display:grid;gap:7px}.dashboard-sidebar a{display:flex;align-items:center;gap:12px;min-height:46px;padding:11px 12px;border-radius:12px;color:#d7d4cb;text-decoration:none;font-weight:650;transition:background .16s ease,color .16s ease,transform .16s ease}.dashboard-sidebar nav a svg{flex:0 0 21px;width:21px;height:21px;color:#aaa38c}.dashboard-sidebar a:hover,.dashboard-sidebar a:focus-visible,.dashboard-sidebar a[aria-current="page"]{background:linear-gradient(90deg,#3a3014,#262111);color:var(--gold);outline:none}.dashboard-sidebar a[aria-current="page"] svg{color:var(--gold)}.dashboard-sidebar a:hover{transform:translateX(2px)}.dashboard-section[hidden]{display:none}.dashboard-content{min-width:0}.dashboard-content .panel{margin-top:0;padding:clamp(20px,3vw,34px)}.sidebar-logout{border-top:1px solid #38311f;margin-top:18px;padding-top:14px}.sidebar-logout form{margin:0}.sidebar-logout-btn{width:100%;display:flex;align-items:center;gap:12px;min-height:46px;padding:11px 12px;border:1px solid #4b3028;border-radius:12px;background:#211514;color:#f0b3a7;font:inherit;font-weight:700;text-align:left;cursor:pointer}.sidebar-logout-btn svg{width:20px;height:20px;flex:0 0 20px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.sidebar-logout-btn:hover,.sidebar-logout-btn:focus-visible{background:#35201d;outline:2px solid #6e3b32;outline-offset:2px}.dashboard-layout.sidebar-collapsed .sidebar-logout-btn{justify-content:center;padding:12px 8px}.dashboard-layout.sidebar-collapsed .sidebar-logout-btn .nav-text{display:none}.dashboard-layout.sidebar-collapsed{grid-template-columns:78px minmax(0,1fr)}.dashboard-layout.sidebar-collapsed .dashboard-sidebar{padding:12px 9px}.dashboard-layout.sidebar-collapsed .sidebar-brand-row{justify-content:center}.dashboard-layout.sidebar-collapsed .side-title,.dashboard-layout.sidebar-collapsed .nav-text{display:none}.dashboard-layout.sidebar-collapsed .dashboard-sidebar nav a{justify-content:center;padding:12px 8px}.sidebar-desktop-toggle{display:inline-grid}.sidebar-scrim{display:none}.dashboard-section{scroll-margin-top:20px;margin-bottom:24px}.dashboard-section:last-child{margin-bottom:0}.dashboard-section h2{font-size:1.35rem;margin:0 0 8px}.section-card{padding:20px;border:1px solid #403a27;border-radius:14px;background:#111115;margin-top:14px}.section-card p:last-child{margin-bottom:0}.dashboard-topline{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap}.dashboard-topline .btn{width:auto;margin:0;padding:10px 18px}.dashboard-content .grid{grid-template-columns:repeat(2,minmax(0,1fr))}.dashboard-content .stat{min-width:0}@media(max-width:760px){.dashboard-layout,.dashboard-layout.sidebar-collapsed{grid-template-columns:1fr;gap:14px}.dashboard-sidebar,.dashboard-layout.sidebar-collapsed .dashboard-sidebar{position:fixed;z-index:1002;left:12px;top:12px;bottom:12px;width:min(300px,calc(100vw - 48px));overflow-y:auto;transform:translateX(calc(-100% - 20px));transition:transform .22s ease;box-shadow:0 24px 70px #0009}.dashboard-layout.sidebar-open .dashboard-sidebar{transform:translateX(0)}.dashboard-sidebar .side-title,.dashboard-layout.sidebar-collapsed .side-title{display:block}.dashboard-sidebar nav{display:grid;gap:6px}.dashboard-sidebar a{white-space:normal}.sidebar-desktop-toggle{display:none}.dashboard-content .panel{padding:18px}.dashboard-content .grid{grid-template-columns:1fr}.sidebar-scrim{position:fixed;inset:0;z-index:1001;border:0;background:#000a;display:block;opacity:0;visibility:hidden;transition:opacity .22s ease,visibility .22s ease}.dashboard-layout.sidebar-open .sidebar-scrim{opacity:1;visibility:visible}}@media(max-width:560px){.wrap.dashboard-wrap{width:calc(100% - 24px);margin:18px auto}.dashboard-wrap .panel{padding:18px}.dashboard-wrap .grid{grid-template-columns:1fr}.dashboard-wrap .btn{min-height:48px}}' +
'.copy-value{display:flex;align-items:center;gap:10px;min-width:0;margin-top:8px}.copy-value strong{overflow-wrap:anywhere;min-width:0}.copy-value input{min-width:0;flex:1}.copy-btn{flex:0 0 auto;border:1px solid #65551e;border-radius:10px;background:#28220f;color:#f3cf3c;padding:10px 13px;font:inherit;font-size:.85rem;font-weight:800;cursor:pointer}.copy-btn:hover,.copy-btn:focus-visible{background:#3a3014;outline:2px solid #f3cf3c;outline-offset:2px}.icon-btn{display:inline-grid;place-items:center;width:42px;height:42px;flex:0 0 42px;border:1px solid #514721;border-radius:12px;background:#17171c;color:#f3cf3c;cursor:pointer}.icon-btn svg,.dashboard-sidebar nav a svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.sidebar-brand-row{display:flex;align-items:center;justify-content:space-between;gap:8px}.sidebar-brand-row .side-title{padding:4px 10px 12px}.dashboard-sidebar nav a{display:flex;align-items:center;gap:12px}.dashboard-sidebar nav a svg{flex:0 0 20px}.sidebar-scrim,.mobile-dashboard-bar{display:none}.mobile-current-tab{color:var(--gold);font-weight:800;margin-left:auto}.dashboard-topline h1{letter-spacing:-.035em}.dashboard-content>.panel{border-color:#4b421f;box-shadow:0 24px 70px #0005}.dashboard-section h2{letter-spacing:-.02em}.dashboard-section .stat{background:linear-gradient(145deg,#17171c,#101013);padding:22px}.dashboard-section .stat strong{font-size:1.35rem}.dashboard-sidebar{border-color:#373224;box-shadow:0 16px 42px #0003}.dashboard-sidebar a{transition:background .18s ease,color .18s ease,transform .18s ease}.dashboard-sidebar a:hover{transform:translateX(2px)}@media(max-width:760px){.dashboard-layout{grid-template-columns:1fr}.dashboard-sidebar{position:fixed;z-index:1002;left:12px;top:12px;bottom:12px;width:min(290px,calc(100vw - 48px));overflow-y:auto;transform:translateX(calc(-100% - 20px));transition:transform .22s ease;box-shadow:0 24px 70px #0009}.dashboard-layout.sidebar-open .dashboard-sidebar{transform:translateX(0)}.sidebar-scrim{position:fixed;inset:0;z-index:1001;border:0;background:#000a;display:block;opacity:0;visibility:hidden;transition:opacity .22s ease,visibility .22s ease}.dashboard-layout.sidebar-open .sidebar-scrim{opacity:1;visibility:visible}.sidebar-close{display:inline-grid}.mobile-dashboard-bar{display:flex;align-items:center;gap:12px;margin:0 0 12px;padding:10px 12px;border:1px solid #3d3620;border-radius:14px;background:#111115;color:#b8b6c0;font-size:.78rem;font-weight:800;letter-spacing:.08em}.dashboard-content .panel{padding:clamp(18px,4vw,28px)}.dashboard-topline{align-items:flex-start}.dashboard-topline h1{font-size:clamp(1.7rem,6vw,2.25rem)}.dashboard-sidebar nav{display:grid;overflow:visible;padding:8px 0}.dashboard-sidebar a{white-space:normal}.dashboard-sidebar .side-title{padding:10px}.dashboard-layout.sidebar-open{overflow:hidden}}@media(min-width:761px){.sidebar-close{display:none}.sidebar-scrim{display:none!important}}' + '</style></head><body><main class="wrap' + (title === 'Member dashboard' ? ' dashboard-wrap' : '') + '"><a class="brand" href="/">MONARCH CODEX</a><section class="panel">' + body + '</section><footer>© ' + new Date().getFullYear() + ' Monarch Codex. All rights reserved.</footer></main><script>document.querySelectorAll("[data-copy-target]").forEach(function(button){button.addEventListener("click",async function(){var target=document.getElementById(button.getAttribute("data-copy-target"));if(!target)return;var value=target.value!==undefined?target.value:target.textContent.trim();try{if(navigator.clipboard&&window.isSecureContext){await navigator.clipboard.writeText(value);}else{var temp=document.createElement("textarea");temp.value=value;temp.style.position="fixed";temp.style.opacity="0";document.body.appendChild(temp);temp.select();var ok=document.execCommand("copy");temp.remove();if(!ok)throw new Error("copy failed");}var original=button.textContent;button.textContent="Copied!";setTimeout(function(){button.textContent=original;},1400);}catch(_){if(target.select)target.select();button.textContent="Select and copy";}});});function togglePassword(id,button){var input=document.getElementById(id);if(!input||!button)return;var show=input.type==="password";input.type=show?"text":"password";button.setAttribute("aria-label",show?"Hide password":"Show password");button.setAttribute("title",show?"Hide password":"Show password");button.setAttribute("aria-pressed",show?"true":"false");var svg=button.querySelector("svg");if(svg){var slash=svg.querySelector("[data-eye-slash]");if(show&&!slash){slash=document.createElementNS("http://www.w3.org/2000/svg","path");slash.setAttribute("d","M3 3l18 18");slash.setAttribute("data-eye-slash","true");svg.appendChild(slash);}else if(!show&&slash){slash.remove();}}}document.addEventListener("click",function(e){var button=e.target.closest("[data-toggle-password]");if(!button)return;e.preventDefault();togglePassword(button.getAttribute("data-toggle-password"),button);});document.querySelectorAll("[data-password-toggle]").forEach(function(button){button.addEventListener("click",function(e){e.preventDefault();togglePassword(button.getAttribute("data-password-toggle"),button);});});if(document.querySelector("[data-dashboard-tab]")){var tabs=[].slice.call(document.querySelectorAll("[data-dashboard-tab]"));var sections=tabs.map(function(t){return document.getElementById(t.getAttribute("data-dashboard-tab"));}).filter(Boolean);var layout=document.querySelector(".dashboard-layout");var currentLabel=document.querySelector(".mobile-current-tab");function closeSidebar(){if(layout)layout.classList.remove("sidebar-open");document.body.style.overflow="";}function showDashboardTab(id){if(!sections.some(function(s){return s.id===id;}))id="overview";sections.forEach(function(s){s.hidden=s.id!==id;});tabs.forEach(function(t){if(t.getAttribute("data-dashboard-tab")===id)t.setAttribute("aria-current","page");else t.removeAttribute("aria-current");});if(currentLabel){var active=tabs.find(function(t){return t.getAttribute("data-dashboard-tab")===id;});currentLabel.textContent=active?active.textContent.trim():"Overview";}}function openSidebar(){if(layout)layout.classList.add("sidebar-open");document.body.style.overflow="hidden";}var collapseButton=document.querySelector("[data-sidebar-collapse]");if(collapseButton&&layout){collapseButton.addEventListener("click",function(){var collapsed=layout.classList.toggle("sidebar-collapsed");collapseButton.setAttribute("aria-expanded",collapsed?"false":"true");collapseButton.setAttribute("aria-label",collapsed?"Expand sidebar":"Collapse sidebar");collapseButton.setAttribute("title",collapsed?"Expand sidebar":"Collapse sidebar");});}document.querySelectorAll("[data-sidebar-open]").forEach(function(b){b.addEventListener("click",openSidebar);});document.querySelectorAll("[data-sidebar-close]").forEach(function(b){b.addEventListener("click",closeSidebar);});tabs.forEach(function(t){t.addEventListener("click",function(e){e.preventDefault();var id=t.getAttribute("data-dashboard-tab");showDashboardTab(id);if(history.replaceState)history.replaceState(null,"","#"+id);closeSidebar();});});document.addEventListener("keydown",function(e){if(e.key==="Escape")closeSidebar();});showDashboardTab(location.hash.slice(1)||"overview");var actionGrid=document.getElementById("quickActions"),more=document.getElementById("toggleActions");if(actionGrid&&more){more.addEventListener("click",function(){var expanded=actionGrid.classList.toggle("actions-expanded");more.setAttribute("aria-expanded",String(expanded));more.textContent=expanded?"Fewer actions":"More actions";});}}</script></body></html>';
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
  const queryRef = String(req.query.ref || '').trim().toUpperCase();
  if (queryRef) req.session.registrationReferralCode = queryRef;
  const lockedRef = String(req.session.registrationReferralCode || '').trim().toUpperCase();
  const countries = [['+234','Nigeria'],['+1','United States / Canada'],['+44','United Kingdom'],['+233','Ghana'],['+254','Kenya'],['+27','South Africa'],['+91','India'],['+971','United Arab Emirates'],['+61','Australia'],['+353','Ireland'],['+49','Germany'],['+33','France']];
  const countryOptions = countries.map(([code,name]) => '<option value="' + code + '"' + (code === '+234' ? ' selected' : '') + '>' + name + ' (' + code + ')</option>').join('');
  const body = '<link rel="stylesheet" href="/member-dashboard.css"><style>.register-form{max-width:620px;margin:0 auto}.register-form .register-intro{color:#aaa7af;line-height:1.65;margin:8px 0 25px}.register-form .register-field{margin:0 0 17px}.register-form label{display:block;margin:0 0 7px;font-weight:650;color:#e9e5db}.register-form input,.register-form select{width:100%;box-sizing:border-box;min-height:47px;padding:12px 13px;border:1px solid #39363a;border-radius:11px;background:#111114;color:#f6f2e8;font:inherit}.register-form input:focus,.register-form select:focus{outline:2px solid #9e812c;outline-offset:1px;border-color:#d6b844}.register-form .password-wrap{display:flex;position:relative}.register-form .password-wrap input{padding-right:53px}.register-form .password-toggle{position:absolute;right:5px;top:5px;width:38px;height:37px;display:grid;place-items:center;border:0;border-radius:8px;background:#252219;color:#e6c84e;cursor:pointer}.register-form .password-toggle svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}.register-form .field-help{font-size:.78rem;color:#96929b;line-height:1.5;margin:7px 0 0}.register-form .password-rules{display:grid;gap:6px;margin:10px 0 0;padding:12px;border:1px solid #2e2c30;border-radius:10px;background:#0d0d10}.register-form .password-rules span{font-size:.78rem;color:#a7a3ac}.register-form .password-rules span:before{content:"○";display:inline-block;width:20px;color:#aaa}.register-form .password-rules .rule-pass{color:#8fdaa5}.register-form .password-rules .rule-pass:before{content:"✓";color:#8fdaa5}.register-form .field-error{color:#ff737d!important}.register-form .field-valid{color:#8fdaa5!important}.register-form .phone-row{display:grid;grid-template-columns:minmax(145px,.8fr) minmax(0,1.4fr);gap:9px}.register-form .register-submit{width:100%;margin-top:5px;min-height:49px}.register-form [aria-invalid=true]{border-color:#e05b66!important}.register-form .register-referral{border-top:1px solid #302d29;padding-top:19px;margin-top:21px}@media(max-width:420px){.register-form .phone-row{grid-template-columns:1fr}.register-form .register-field{margin-bottom:15px}}</style><section class="register-form"><h1>Join Monarch Codex</h1><p class="register-intro">Create your account to access your personal dashboard, manage your membership and take your next steps with Monarch Codex.</p>' +
  (message ? '<div class="notice">' + esc(message) + '</div>' : '') + '<form id="registerForm" method="post" action="/register" novalidate>' + csrfField(req) +
  '<div class="register-field"><label for="fullName">Full name</label><input id="fullName" name="fullName" autocomplete="name" maxlength="120" required></div>' +
  '<div class="register-field"><label for="email">Email address</label><input id="email" name="email" type="email" autocomplete="email" maxlength="254" required></div>' +
  '<div class="register-field"><label for="phoneCountryCode">Phone number</label><div class="phone-row"><select id="phoneCountryCode" name="phoneCountryCode" aria-label="Country calling code">' + countryOptions + '</select><input id="phone" name="phone" type="tel" inputmode="tel" autocomplete="tel-national" maxlength="16" placeholder="e.g. 803 123 4567" required aria-describedby="phoneHelp"></div><p class="field-help" id="phoneHelp">Choose your country code and enter your number without the calling code.</p><p class="field-help" id="phoneFeedback" aria-live="polite"></p></div>' +
  '<div class="register-field"><label for="username">Username</label><input id="username" name="username" autocomplete="username" minlength="3" maxlength="30" pattern="[A-Za-z0-9_]{3,30}" title="Use 3–30 letters, numbers or underscores, with no spaces." autocapitalize="none" spellcheck="false" required><p class="field-help">Use 3–30 letters, numbers or underscores. No spaces.</p></div>' +
  '<div class="register-field"><label for="password">Password</label><div class="password-wrap"><input id="password" name="password" type="password" autocomplete="new-password" minlength="12" maxlength="128" required aria-describedby="passwordRules"><button class="password-toggle" type="button" data-password-toggle="password" aria-label="Show password" title="Show password"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg></button></div><div class="password-rules" id="passwordRules" aria-live="polite"><span data-rule="length">At least 12 characters (8 is the minimum, 12+ is recommended)</span><span data-rule="upper">At least one capital letter (A–Z)</span><span data-rule="number">At least one number (0–9)</span><span data-rule="special">At least one special symbol (e.g. ! @ # $)</span></div></div>' +
  '<div class="register-field"><label for="confirmPassword">Confirm password</label><div class="password-wrap"><input id="confirmPassword" name="confirmPassword" type="password" autocomplete="new-password" maxlength="128" required aria-describedby="confirmFeedback"><button class="password-toggle" type="button" data-password-toggle="confirmPassword" aria-label="Show confirmation password" title="Show confirmation password"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg></button></div><p class="field-help" id="confirmFeedback" aria-live="polite">Enter the same password again.</p></div>' +
  '<div class="register-field register-referral"><label for="referralCode">Referral code <span class="field-help">(optional)</span></label><input id="referralCode" name="referralCode" maxlength="20" autocapitalize="characters" value="' + esc(lockedRef) + '"' + (lockedRef ? ' readonly aria-describedby="referralHelp"' : '') + '><p id="referralHelp" class="field-help">' + (lockedRef ? 'This referral is linked to the person who invited you.' : 'Have a referral code? Enter it here.') + '</p></div>' +
  '<p class="field-help" id="formFeedback" aria-live="polite"></p><button class="btn register-submit" type="submit">Create my account</button></form><div class="links"><a href="/login">Already a member? Log in</a></div></section>' +
  '<script>(function(){var form=document.getElementById("registerForm");if(!form)return;var pw=document.getElementById("password"),confirm=document.getElementById("confirmPassword"),phone=document.getElementById("phone"),country=document.getElementById("phoneCountryCode"),feedback=document.getElementById("confirmFeedback"),phoneFeedback=document.getElementById("phoneFeedback"),formFeedback=document.getElementById("formFeedback");function checkPassword(){var v=pw.value;var checks={length:v.length>=12,upper:/[A-Z]/.test(v),number:/[0-9]/.test(v),special:/[^A-Za-z0-9\s]/.test(v)};Object.keys(checks).forEach(function(k){var el=document.querySelector("[data-rule=\""+k+"\"]");if(el)el.classList.toggle("rule-pass",checks[k])});pw.setAttribute("aria-invalid",Object.values(checks).every(Boolean)?"false":"true");return Object.values(checks).every(Boolean)}function checkMatch(){if(!confirm.value){feedback.textContent="Enter the same password again.";feedback.className="field-help";confirm.setAttribute("aria-invalid","false");return false}var ok=pw.value===confirm.value;feedback.textContent=ok?"Passwords match.":"Passwords do not match.";feedback.className="field-help "+(ok?"field-valid":"field-error");confirm.setAttribute("aria-invalid",ok?"false":"true");return ok}function checkPhone(){var digits=phone.value.replace(/\D/g,"");var code=country.value;var min=code==="+234"?10:7,max=code==="+234"?11:12;var ok=digits.length>=min&&digits.length<=max;phoneFeedback.textContent=phone.value?(ok?"Number length looks valid for the selected calling code.":"Check the number length for "+code+"."):"";phoneFeedback.className="field-help "+(phone.value?(ok?"field-valid":"field-error"):"");phone.setAttribute("aria-invalid",phone.value&&!ok?"true":"false");return ok}pw.addEventListener("input",function(){checkPassword();if(confirm.value)checkMatch()});confirm.addEventListener("input",checkMatch);phone.addEventListener("input",checkPhone);country.addEventListener("change",checkPhone);form.addEventListener("submit",function(e){var valid=checkPassword()&&checkMatch()&&checkPhone()&&form.checkValidity();if(!valid){e.preventDefault();formFeedback.textContent="Please correct the highlighted fields before continuing.";formFeedback.className="field-help field-error";form.reportValidity()}})})();</script>';
  return page('Create your account', body);
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
    const phoneDigits = String(req.body.phone || '').replace(/\D/g, ''), phoneCountryCode = String(req.body.phoneCountryCode || '+234').trim(), phone = phoneCountryCode + phoneDigits, username = String(req.body.username || '').trim(), password = String(req.body.password || ''), confirmPassword = String(req.body.confirmPassword || '');
    if (fullName.length < 2 || fullName.length > 120) return res.status(400).send(formError('Check your details', 'Enter your full name (2–120 characters).'));
    if (!validEmail(email)) return res.status(400).send(formError('Check your details', 'Enter a valid email address.'));
    if (!/^\+\d{1,4}$/.test(phoneCountryCode) || phoneDigits.length < (phoneCountryCode === '+234' ? 10 : 7) || phoneDigits.length > (phoneCountryCode === '+234' ? 11 : 12)) return res.status(400).send(formError('Check your details', 'Check your country calling code and phone number length.'));
    if (!validUsername(username) || /\s/.test(String(req.body.username || ''))) return res.status(400).send(formError('Check your details', 'Username cannot contain spaces. Use 3–30 letters, numbers or underscores.'));
    if (password.length < 12 || password.length > 128 || !/[A-Z]/.test(password) || !/[0-9]/.test(password) || !/[^A-Za-z0-9\s]/.test(password)) return res.status(400).send(formError('Check your password', 'Use 12–128 characters with a capital letter, a number and a special symbol.'));
    if (password !== confirmPassword) return res.status(400).send(formError('Check your password', 'Your passwords do not match. Please confirm your password again.'));
    const [existing] = await pool.execute('SELECT id FROM members WHERE email = ? OR username = ? LIMIT 1', [email, username]);
    if (existing.length) return res.status(409).send(formError('Account already exists', 'That email or username is already in use. Try logging in or choose another.', '/register'));
    let referrerId = null;
    const referralCode = String(req.session.registrationReferralCode || req.body.referralCode || req.query.ref || '').trim().toUpperCase();
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
      delete req.session.registrationReferralCode;
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
app.get('/admin', requireAdmin, async (req, res, next) => {
  try {
    const [[members]] = await pool.query('SELECT COUNT(*) AS total FROM members');
    const [[recent]] = await pool.query('SELECT COUNT(*) AS total FROM members WHERE created_at >= DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 7 DAY)');
    const [[admins]] = await pool.query('SELECT COUNT(*) AS total FROM admin_users WHERE is_active = 1');
    let kycCount = null;
    try {
      const [[kyc]] = await pool.query("SELECT COUNT(*) AS total FROM kyc_submissions WHERE status = 'pending'");
      kycCount = Number(kyc.total) || 0;
    } catch (e) { if (!e || e.code !== 'ER_NO_SUCH_TABLE') throw e; }
    const stat = (label, value, hint) => '<article class="admin-stat"><span>' + esc(label) + '</span><strong>' + esc(value) + '</strong><small>' + esc(hint) + '</small></article>';
    const body = '<style>.admin-shell{max-width:1200px;margin:0 auto}.admin-head{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap}.admin-tag{display:inline-flex;align-items:center;gap:8px;border:1px solid #5b4c20;border-radius:999px;padding:7px 12px;color:#f3cf3c;font-size:.78rem;font-weight:800;letter-spacing:.06em}.admin-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin:24px 0}.admin-stat{padding:20px;border:1px solid #403a27;border-radius:16px;background:linear-gradient(145deg,#19191d,#101013);min-width:0}.admin-stat span,.admin-stat small{display:block;color:#b8b6c0}.admin-stat strong{display:block;font-size:clamp(1.5rem,4vw,2.2rem);color:#f3cf3c;margin:10px 0;overflow-wrap:anywhere}.admin-stat small{font-size:.82rem}.admin-panel{padding:22px;border:1px solid #403a27;border-radius:16px;background:#121215;margin-top:16px}.admin-links{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.admin-link{display:block;padding:16px;border:1px solid #39352a;border-radius:12px;color:#f7f5ef;text-decoration:none;background:#17171b}.admin-link:hover,.admin-link:focus-visible{border-color:#b99a2c;outline:2px solid #8e7628}.admin-link strong{display:block;color:#f3cf3c}.admin-link small{display:block;color:#b8b6c0;margin-top:5px}.admin-warning{padding:14px;border:1px solid #6b5520;background:#28210f;border-radius:12px;color:#e9dfb7;margin-top:16px}.admin-actions{display:flex;gap:10px;flex-wrap:wrap}.admin-actions a{width:auto;padding:10px 16px;margin:0}.admin-role{font-size:.82rem;color:#d4d0c5}@media(max-width:700px){.admin-grid{grid-template-columns:1fr 1fr}.admin-links{grid-template-columns:1fr}}@media(max-width:430px){.admin-grid{grid-template-columns:1fr}.admin-panel{padding:16px}}</style><div class="admin-shell"><div class="admin-head"><div><span class="muted small">MONARCH CODEX / CONTROL CENTER</span><h1>Admin dashboard</h1><p class="muted">Operational overview and account administration.</p></div><div><span class="admin-tag">● ADMIN ACCESS</span><p class="admin-role">Role: ' + esc(req.adminRole.replace(/_/g,' ')) + '</p></div></div><div class="admin-grid">' +
      stat('Total members', Number(members.total)||0, 'Registered member accounts') +
      stat('New members · 7 days', Number(recent.total)||0, 'Recent registrations') +
      stat('Active administrators', Number(admins.total)||0, 'Explicitly provisioned accounts') +
      stat('Pending KYC reviews', kycCount === null ? 'Not configured' : kycCount, kycCount === null ? 'KYC migration or table unavailable' : 'Submissions awaiting review') +
      stat('Deposits', 'Disabled', 'No live payment processing connected') +
      stat('Withdrawals', 'Disabled', 'No live payout processing connected') +
      '</div><section class="admin-panel"><h2>Management</h2><p class="muted">Review and operational tools. Financial actions remain disabled until ledger, controls, and required compliance reviews are completed.</p><div class="admin-links"><a class="admin-link" href="/admin#members"><strong>Member accounts</strong><small>Member totals and account administration</small></a><a class="admin-link" href="/admin#verification"><strong>KYC verification</strong><small>' + (kycCount === null ? 'Not yet connected to review queue' : 'Pending submissions: ' + kycCount) + '</small></a><a class="admin-link" href="/admin#audit"><strong>Audit and access</strong><small>Admin roles are explicitly provisioned in the database</small></a><a class="admin-link" href="/dashboard"><strong>Member dashboard</strong><small>Return to your member account</small></a></div><div class="admin-warning"><strong>Setup still required:</strong> this dashboard does not automatically make any email an admin. Apply the migration and explicitly provision the intended member account before access is granted.</div></section><div class="admin-actions"><a class="btn" href="/dashboard">Member area</a></div></div>';
    res.send(page('Admin dashboard', body));
  } catch (e) { next(e); }
});


app.get('/admin/kyc', requireAdmin, async (req,res,next) => {
  try {
    const [rows] = await pool.query("SELECT id,member_id,legal_full_name,contact_email,document_type,document_issuer_country,document_number_last4,status,submitted_at FROM kyc_submissions ORDER BY submitted_at DESC LIMIT 200");
    const items = rows.map(row => '<tr><td>' + esc(row.id) + '</td><td>' + esc(row.legal_full_name) + '<br><small>' + esc(row.contact_email) + '</small></td><td>' + esc(row.document_type) + ' (' + esc(row.document_issuer_country) + ')<br><small>•••• ' + esc(row.document_number_last4) + '</small></td><td>' + esc(row.status) + '</td><td><form method="post" action="/admin/kyc/' + encodeURIComponent(row.id) + '/review">' + csrfField(req) + '<select name="status" required><option value="pending">Pending</option><option value="approved">Approve</option><option value="rejected">Reject</option><option value="needs_resubmission">Request resubmission</option></select><input name="note" maxlength="1000" placeholder="Reviewer note (optional)"><button class="btn" type="submit">Save</button></form></td></tr>').join('');
    const body = '<div class="wrap"><h1>KYC review queue</h1><p class="muted">Sensitive documents are stored encrypted outside the public web directory. This list never displays full document numbers or document files.</p><div class="panel" style="overflow:auto"><table style="width:100%;border-collapse:collapse"><thead><tr><th>ID</th><th>Member</th><th>Document</th><th>Status</th><th>Review</th></tr></thead><tbody>' + (items || '<tr><td colspan="5">No submissions yet.</td></tr>') + '</tbody></table></div><p><a class="btn" href="/admin">Back to admin</a></p></div><style>td,th{padding:12px;text-align:left;border-bottom:1px solid #39352a;vertical-align:top}td form{display:grid;gap:7px;min-width:190px}td input,td select{padding:9px;border-radius:8px;background:#0d0d10;color:#fff;border:1px solid #45434c}td small{color:#aaa}</style>';
    res.send(page('KYC review queue', body));
  } catch(e) { next(e); }
});
app.post('/admin/kyc/:id/review', requireAdmin, express.urlencoded({extended:false,limit:'5kb'}), csrfCheck, async (req,res,next) => {
  const id = String(req.params.id || '');
  const status = req.body.status;
  const note = String(req.body.note || '').trim().slice(0,1000);
  if (!/^\\d{1,20}$/.test(id) || !['pending','approved','rejected','needs_resubmission'].includes(status)) return res.status(400).send(page('Invalid review','<h1>Invalid review request</h1>'));
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
  try {
    const [rows] = await pool.execute('SELECT id, monarch_uid, full_name, email, username FROM members WHERE id = ? LIMIT 1', [req.session.memberId]);
    const member = rows[0];
    if (!member) { req.session.destroy(() => res.redirect('/login')); return; }
    const [counts] = await pool.execute('SELECT COUNT(*) AS total FROM members WHERE referred_by = ?', [member.id]);
    const baseUrl = (process.env.APP_BASE_URL || 'https://monarchcodex.online').replace(/\/+$/, '');
    const referralLink = baseUrl + '/register?ref=' + encodeURIComponent(member.monarch_uid);
    const body = '<link rel="stylesheet" href="/member-dashboard.css"><div class="dashboard-layout">'+
      '<button class="sidebar-scrim" type="button" data-sidebar-close aria-label="Close navigation"></button><aside class="dashboard-sidebar" id="memberSidebar"><div class="sidebar-brand-row"><div class="side-title">MEMBER MENU</div><button class="icon-btn sidebar-close sidebar-desktop-toggle" type="button" data-sidebar-collapse aria-label="Collapse sidebar" title="Collapse sidebar" aria-expanded="true"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6M4 4v16"/></svg></button><button class="icon-btn sidebar-close" type="button" data-sidebar-close aria-label="Close menu"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></div><nav aria-label="Member dashboard navigation">' +
      '<a href="/dashboard" aria-current="page"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg><span class="nav-text">Overview</span></a><a href="/profile"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg><span class="nav-text">Profile</span></a><a href="/kyc"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z"/><path d="m9 12 2 2 4-4"/></svg><span class="nav-text">KYC Verification</span></a><a href="/referrals"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3"/><path d="M3 20v-1a6 6 0 0 1 12 0v1M16 5a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 5v1"/></svg><span class="nav-text">Referrals</span></a><a href="/deposit"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M7 15h4"/></svg><span class="nav-text">Deposit</span></a><a href="/withdraw"><span aria-hidden="true">↗</span><span class="nav-text">Withdraw</span></a><a href="/transactions"><span aria-hidden="true">◷</span><span class="nav-text">Transactions</span></a>' +'</nav><div class="sidebar-uid"><span class="muted small">YOUR MONARCH ID</span><div class="sidebar-uid-value"><strong id="memberUid">' + esc(member.monarch_uid) + '</strong><button class="copy-btn" type="button" data-copy-target="memberUid" aria-label="Copy Monarch ID">Copy</button></div></div><div class="sidebar-logout"><form method="post" action="/logout">' + csrfField(req) + '<button class="sidebar-logout-btn" type="submit"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 17l5-5-5-5M15 12H3M21 4v16"/></svg><span class="nav-text">Log out</span></button></form></div></aside><button class="sidebar-scrim" type="button" data-sidebar-close aria-label="Close navigation"></button><div class="dashboard-content"><div class="mobile-dashboard-bar"><button class="icon-btn sidebar-open" type="button" data-sidebar-open aria-label="Open navigation" aria-controls="memberSidebar"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg></button><span>MEMBER AREA</span><span class="mobile-current-tab">Overview</span></div><section class="panel">' +
      '<div class="dashboard-topline"><div><div class="muted small">MONARCH MEMBER AREA</div><h1>Welcome, ' + esc(member.full_name.split(' ')[0]) + '</h1><p class="muted">Your membership overview and account tools.</p></div></div>' +
      '<section id="overview" class="dashboard-section overview-intro"><div class="overview-title-row"><div><span class="muted small">YOUR ACCOUNT</span><h2>Overview</h2></div><span class="account-live"><i></i> Account active</span></div>' +
      '<div class="grid dashboard-metrics"><div class="stat balance-primary"><span class="muted small">Total balance</span><strong>—</strong><p class="muted small">Wallet ledger not connected</p></div><div class="stat"><span class="muted small">Investment balance</span><strong>—</strong><p class="muted small">Awaiting verified records</p></div><div class="stat"><span class="muted small">Earnings</span><strong>—</strong><p class="muted small">Awaiting verified records</p></div><div class="stat"><span class="muted small">Verification</span><strong>Not submitted</strong><a class="metric-link" href="/kyc">Verify account <span aria-hidden="true">→</span></a></div></div>' +
      '<div class="dashboard-section referral-summary"><div><span class="muted small">SUCCESSFUL REFERRALS</span><strong>' + (Number(counts[0].total) || 0) + '</strong></div><a href="/referrals">View referrals <span aria-hidden="true">→</span></a></div></section>' +
      '<section class="dashboard-section action-section"><div class="section-heading-row"><div><h2>Quick actions</h2><p class="muted">Everything you need, one tap away.</p></div><a href="/transactions" class="muted small">Activity <span aria-hidden="true">↗</span></a></div><div class="quick-action-grid" id="quickActions"><a href="/deposit"><span>＋</span><strong>Deposit</strong><small>Add funds</small></a><a href="/withdraw"><span>↗</span><strong>Withdraw</strong><small>Cash out</small></a><a href="/kyc"><span>◇</span><strong>Verify</strong><small>Identity check</small></a><a href="/transactions"><span>↻</span><strong>History</strong><small>Transactions</small></a><a href="/referrals"><span>♧</span><strong>Referrals</strong><small>Invite friends</small></a><a href="/profile"><span>◉</span><strong>Profile</strong><small>Account details</small></a></div><button class="show-more-actions" type="button" id="toggleActions" aria-expanded="false" hidden>More actions</button></section>' +
      '<section class="dashboard-section"><div class="dashboard-topline"><div><h2>Account activity</h2><p class="muted">Your member ID and referral count are live account information. Financial activity will appear once the transaction ledger is connected.</p></div><a href="/transactions" class="copy-btn" style="text-decoration:none">View activity</a></div><div class="section-card"><strong>Membership active</strong><p class="muted small">Your Monarch ID is ready to use. No deposit, withdrawal, or earnings history is being fabricated or displayed as real.</p></div></section>' +
      '</section></div></div>';
    res.send(page('Member dashboard', body + "<script>(function(){var layout=document.querySelector(\".dashboard-layout\");if(!layout)return;var openers=layout.querySelectorAll(\"[data-sidebar-open]\"),closers=layout.querySelectorAll(\"[data-sidebar-close]\"),collapse=layout.querySelector(\"[data-sidebar-collapse\");function close(){layout.classList.remove(\"sidebar-open\")}openers.forEach(function(b){b.addEventListener(\"click\",function(){layout.classList.add(\"sidebar-open\")})});closers.forEach(function(b){b.addEventListener(\"click\",close)});if(collapse)collapse.addEventListener(\"click\",function(){layout.classList.toggle(\"sidebar-collapsed\");collapse.setAttribute(\"aria-expanded\",String(!layout.classList.contains(\"sidebar-collapsed\")))});document.addEventListener(\"keydown\",function(e){if(e.key===\"Escape\")close()});})();</script>"));
  } catch (e) { next(e); }
});

function memberPage(title, active, member, content, req) {
  const items = [['/dashboard','Overview','◫'],['/profile','Profile','◎'],['/kyc','Verification','◇'],['/deposit','Deposit','＋'],['/withdraw','Withdraw','↗'],['/transactions','Transactions','↔'],['/referrals','Referrals','♧']];
  const nav = items.map(([href,label,mark]) => '<a href="' + href + '"' + (href===active?' aria-current="page"':'') + '><span class="member-nav-icon" aria-hidden="true">' + mark + '</span><span>' + label + '</span></a>').join('');
  const firstName = esc((member.full_name || 'Member').split(' ')[0]);
  const uid = esc(member.monarch_uid || 'Pending');
  const body = '<link rel="stylesheet" href="/member-dashboard.css"><div class="member-experience"><aside class="member-rail" id="memberRail"><a class="member-brand" href="/dashboard"><span class="member-brand-mark">M</span><span><strong>MONARCH</strong><small>CODEX</small></span></a><div class="member-rail-label">YOUR ACCOUNT</div><nav aria-label="Member navigation">' + nav + '</nav><div class="member-rail-account"><span class="member-rail-label">MEMBER ID</span><div class="member-rail-uid"><strong id="memberUid">' + uid + '</strong><button type="button" class="member-copy-uid" data-copy-uid aria-label="Copy member ID">Copy</button></div><small>Keep your account details private.</small></div><div class="member-rail-logout"><form method="post" action="/logout">' + csrfField(req) + '<button type="submit">↪ <span>Log out</span></button></form></div></aside><div class="member-workspace"><header class="member-mobile-head"><button type="button" class="member-menu-toggle" aria-label="Open navigation" aria-expanded="false" data-member-menu>☰</button><a class="member-brand" href="/dashboard"><span class="member-brand-mark">M</span><span><strong>MONARCH</strong><small>CODEX</small></span></a><span class="member-live-dot" aria-label="Secure account"></span></header><div class="member-page-heading"><div><p class="member-overline">MONARCH CODEX / MEMBER AREA</p><h1>' + firstName + ', welcome back.</h1><p>Manage your account, verification and funds in one place.</p></div><div class="member-heading-status"><span></span> Account workspace</div></div><main class="member-main"><div class="member-content-heading"><div><span class="member-overline">ACCOUNT MANAGEMENT</span><h2>' + esc(title) + '</h2></div><span class="member-secure-label">⌑ Secure session</span></div>' + content + '</main><footer class="member-footer"><span>MONARCH CODEX</span><span>Move with clarity. Build with purpose.</span></footer></div></div><div class="member-mobile-scrim" data-member-close></div><div class="page-loading" id="pageLoading" aria-live="polite"><span class="page-spinner"></span><strong>Opening page…</strong></div><script>(function(){var rail=document.getElementById("memberRail"),toggle=document.querySelector("[data-member-menu]"),scrim=document.querySelector("[data-member-close]");function close(){rail.classList.remove("is-open");scrim.classList.remove("is-visible");if(toggle)toggle.setAttribute("aria-expanded","false")}if(toggle)toggle.addEventListener("click",function(){rail.classList.toggle("is-open");scrim.classList.toggle("is-visible");toggle.setAttribute("aria-expanded",rail.classList.contains("is-open")?"true":"false")});if(scrim)scrim.addEventListener("click",close);document.querySelectorAll(".member-experience nav a").forEach(function(a){a.addEventListener("click",function(){var loader=document.getElementById("pageLoading");if(loader)loader.classList.add("show")})});var copy=document.querySelector("[data-copy-uid]");if(copy)copy.addEventListener("click",async function(){try{await navigator.clipboard.writeText(document.getElementById("memberUid").textContent);copy.textContent="Copied";setTimeout(function(){copy.textContent="Copy"},1400)}catch(e){copy.textContent="Select ID"}})})();</script>';
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
app.get('/profile', requireAuth, async (req,res,next)=>{try{const m=await getMemberForPage(req,res);if(!m)return;res.send(memberPage('Profile','/profile',m,'<div class="member-card"><p><span class="muted">Monarch UID</span><br><strong>'+esc(m.monarch_uid)+'</strong></p><p><span class="muted">Full name</span><br><strong>'+esc(m.full_name)+'</strong></p><p><span class="muted">Email</span><br><strong>'+esc(m.email)+'</strong></p><p><span class="muted">Username</span><br><strong>@'+esc(m.username)+'</strong></p><p class="muted small">Profile editing and payout methods require protected database fields and are not enabled yet.</p></div>',req));}catch(e){next(e)}});

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
        const files = req.files || {};
        const front = files.documentFront && files.documentFront[0];
        const back = files.documentBack && files.documentBack[0];
        const selfie = files.selfie && files.selfie[0];
        const docNumber = String(b.documentNumber || '').trim();
        if (!validKycText(b.legalFullName,160) || !/^\\d{4}-\\d{2}-\\d{2}$/.test(b.dateOfBirth || '') ||
            !validKycText(b.phoneNumber,32) || !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(b.contactEmail || '') ||
            !['NG','GH','KE','ZA'].includes(b.countryCode) || !validKycText(b.stateRegion,120) ||
            !validKycText(b.localityLga,120) || !validKycText(b.streetAddress,240) ||
            !['national_id','passport','drivers_license','voters_card'].includes(b.documentType) ||
            !['NG','GH','KE','ZA'].includes(b.documentIssuerCountry) || !validKycText(docNumber,80) ||
            (b.documentType === 'national_id' && b.documentIssuerCountry === 'NG' && !/^\\d{11}$/.test(docNumber)) ||
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
    const content = `
      <div class="kyc-intro">Complete your verification in a few steps. You can go back to check your answers before submitting.</div>
      <div class="kyc-security-note"><span class="kyc-lock" aria-hidden="true">◆</span><span><strong>Secure verification</strong><small>The KYC submission endpoint has been added to the site code. However, server configuration and a successful test submission have not yet been confirmed. Do not enter real identity details or upload real documents until testing succeeds.</small></span></div>
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
          <div class="kyc-hint">The submission endpoint is implemented, but it requires encrypted identity storage, private document storage, and the database migration to be configured on the server.</div>
        </section>
        <section class="kyc-stage" data-stage="3" hidden>
          <p class="kyc-stage-kicker">STEP 04 OF 04</p><h2>Documents & selfie</h2><p class="kyc-stage-copy">Exchange-style verification normally needs a clear image of your document and a selfie. Use sample documents only until the server configuration and test submission are confirmed.</p>
          <div class="kyc-upload-grid">
            <label class="kyc-upload-card" for="kycFront"><span class="kyc-upload-icon">＋</span><strong>Front of ID</strong><small>Upload an image from your device</small><input id="kycFront" name="documentFront" type="file" accept="image/jpeg,image/png" data-preview="kycFrontPreview"><img id="kycFrontPreview" alt="Front of ID preview" hidden></label>
            <label class="kyc-upload-card" for="kycBackImage"><span class="kyc-upload-icon">＋</span><strong>Back of ID</strong><small>Upload the back image from your device</small><input id="kycBackImage" name="documentBack" type="file" accept="image/jpeg,image/png" data-preview="kycBackPreview"><img id="kycBackPreview" alt="Back of ID preview" hidden></label>
            <div class="kyc-upload-card kyc-selfie-card"><span class="kyc-upload-icon">◎</span><strong>Live selfie</strong><small>Use your front camera to take a selfie</small><video id="kycSelfieVideo" autoplay playsinline muted hidden></video><canvas id="kycSelfieCanvas" hidden></canvas><img id="kycSelfiePreview" alt="Captured selfie preview" hidden><div class="kyc-camera-actions"><button type="button" class="kyc-camera-btn" id="kycStartCamera">Open camera</button><button type="button" class="kyc-camera-btn" id="kycCaptureSelfie" hidden>Capture selfie</button><button type="button" class="kyc-camera-btn" id="kycRetakeSelfie" hidden>Retake</button></div><p class="kyc-camera-status" id="kycCameraStatus" aria-live="polite">Selfie is camera capture only; image file selection is disabled.</p></div>
          </div>
          <div class="kyc-consent"><label for="kycConfirm"><input type="checkbox" id="kycConfirm" required> I confirm that the information is accurate and the images belong to me.</label></div>
          <div class="kyc-final-note" id="kycSubmitNotice" role="status">The server-side submission endpoint is implemented in the code, but successful operation has not yet been verified on this hosting account. Do not use real identity documents until server storage and database setup are complete and a test submission succeeds.</div>
        </section>
        <div class="kyc-actions"><button type="button" id="kycBack" class="kyc-btn kyc-btn-secondary" hidden>Back</button><span class="kyc-steps-count" id="kycStepCount">Step 1 of 4</span><button type="button" id="kycNext" class="kyc-btn kyc-btn-primary">Continue <span aria-hidden="true">→</span></button></div>
        <p class="kyc-form-message" id="kycMessage" aria-live="polite"></p>
      </form>`;
    res.send(wizardPage('KYC Verification', content, req));
  } catch (e) { next(e); }
});
app.get('/deposit', requireAuth, async (req,res,next)=>{try{const m=await getMemberForPage(req,res);if(!m)return;const content='<div class="member-card"><div class="member-steps" id="depositProgress"><span>1 · Amount</span><span>2 · Payment</span><span>3 · Review</span></div><form id="depositWizard"><section class="deposit-step" data-step="0"><h3>Choose deposit amount</h3><label for="depositAmount">Amount (NGN)</label><input id="depositAmount" type="number" min="100" max="10000000" step="1" inputmode="numeric" required><p class="muted small">Enter the amount you intend to deposit.</p></section><section class="deposit-step" data-step="1" hidden><h3>Payment instructions</h3><div class="notice">Official payment instructions are not configured yet. Do not transfer money or send funds to an account shared in chat. This step is a preview only.</div><p class="muted">Once an administrator configures and verifies the payment destination, the official instructions will appear here.</p></section><section class="deposit-step" data-step="2" hidden><h3>Review deposit request</h3><p>Amount: <strong id="depositSummary"></strong></p><div class="notice">Deposits cannot be submitted yet because verified payment instructions and transaction records have not been activated. No payment will be recorded and no wallet will be credited.</div></section><div class="links"><button class="copy-btn" id="depositBack" type="button" hidden>Back</button><button class="btn" id="depositNext" type="button">Continue</button></div><p id="depositMessage" class="muted small" aria-live="polite">Step 1 of 3</p></form></div><style>.deposit-step[hidden]{display:none}.deposit-step label{display:block;margin:14px 0 6px}.deposit-step input{width:100%;padding:12px;border:1px solid #484650;border-radius:10px;background:#0d0d10;color:#fff;font:inherit}</style><script>(function(){var f=document.getElementById("depositWizard");if(!f)return;var s=[].slice.call(f.querySelectorAll(".deposit-step")),n=document.getElementById("depositNext"),b=document.getElementById("depositBack"),m=document.getElementById("depositMessage"),p=document.getElementById("depositProgress").querySelectorAll("span"),i=0;function render(){s.forEach(function(x,j){x.hidden=j!==i});[].forEach.call(p,function(x,j){x.style.opacity=j===i?"1":".55"});b.hidden=i===0;n.textContent=i===s.length-1?"Submit request":"Continue";m.textContent="Step "+(i+1)+" of "+s.length;if(i===2)document.getElementById("depositSummary").textContent="₦"+Number(document.getElementById("depositAmount").value||0).toLocaleString("en-NG")}n.addEventListener("click",function(){if(i===0&&!document.getElementById("depositAmount").checkValidity()){document.getElementById("depositAmount").reportValidity();return}if(i<s.length-1){i++;render()}else{m.textContent="Deposits are not active yet. No request was submitted and no funds were moved."}});b.addEventListener("click",function(){if(i>0)i--;render()});render()})();</script><div class="member-card"><strong>Deposit history</strong><p class="muted small">Your actual deposit history will appear here after the secure transaction workflow is enabled. Uploading a receipt alone will never credit a wallet.</p></div>';res.send(wizardPage('Deposit',content,req));}catch(e){next(e)}});
app.get('/withdraw', requireAuth, async (req,res,next)=>{try{const m=await getMemberForPage(req,res);if(!m)return;res.send(memberPage('Withdraw','/withdraw',m,'<div class="member-card"><strong>Withdrawals are locked</strong><p class="muted">Withdrawal requests require KYC approval, configured payout destinations, and a secure transaction ledger.</p></div>',req));}catch(e){next(e)}});
app.get('/transactions', requireAuth, async (req,res,next)=>{try{const m=await getMemberForPage(req,res);if(!m)return;res.send(memberPage('Transaction history','/transactions',m,'<div class="member-card"><strong>No transaction history available yet</strong><p class="muted">Once deposits and withdrawals are securely activated, each transaction will show its amount, currency, reference, date and status.</p></div>',req));}catch(e){next(e)}});
app.get('/referrals', requireAuth, async (req,res,next)=>{try{const m=await getMemberForPage(req,res);if(!m)return;const [counts]=await pool.execute('SELECT COUNT(*) AS total FROM members WHERE referred_by = ?',[m.id]);const base=String(process.env.APP_BASE_URL||'https://monarchcodex.online').replace(/\/+$/,'');const link=base+'/register?ref='+encodeURIComponent(m.monarch_uid);const content='<div class="member-card"><p class="muted small">YOUR MONARCH UID</p><div class="copy-value"><strong id="pageUid">'+esc(m.monarch_uid)+'</strong><button class="copy-btn" type="button" data-copy-target="pageUid">Copy UID</button></div><p class="muted small">YOUR PERSONAL REFERRAL LINK</p><div class="copy-value"><input id="pageReferralLink" value="'+esc(link)+'" readonly><button class="copy-btn" type="button" data-copy-target="pageReferralLink">Copy link</button></div><p class="muted small">Referral attribution is recorded when a new account successfully registers using your code.</p></div><div class="grid"><div class="stat"><span class="muted small">Registered referrals</span><strong>'+Number(counts[0].total||0)+'</strong></div></div>';res.send(memberPage('Referrals','/referrals',m,content,req));}catch(e){next(e)}});
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
