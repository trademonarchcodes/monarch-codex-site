const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const MySQLStoreFactory = require('express-mysql-session');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');
const nodemailer = require('nodemailer');
const rateLimit = require('express-rate-limit');
// express-rate-limit v7 exports ipKeyGenerator; older installed versions do not. Keep startup/login compatible during dependency refresh.
const ipKeyGenerator = rateLimit.ipKeyGenerator || (ip => String(ip || '0.0.0.0'));
const path = require('node:path');
const fs = require('node:fs');
const multer = require('multer');
const createSovereignDeskRouter = require('./sovereign-desk');
const { renderMemberNavigation } = require('./lib/member-navigation');
const createMonarchsDirectoryRouter = require('./monarchs-directory');
const createToolsRouter = require('./tools');
const createMobileApiRouter = require('./mobile-api');
const createRoleManagementRouter = require('./role-management');

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

const ensurePresenceFeedbackTables = async () => {
  const statements = [
    "CREATE TABLE IF NOT EXISTS member_presence (member_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,last_seen_at TIMESTAMP NULL DEFAULT NULL,online_until TIMESTAMP NULL DEFAULT NULL,show_status TINYINT(1) NOT NULL DEFAULT 1,updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
    "CREATE TABLE IF NOT EXISTS member_feedback (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,member_id BIGINT UNSIGNED NOT NULL,category ENUM('feature_request','bug_report','improvement','other') NOT NULL,title VARCHAR(160) NOT NULL,description TEXT NOT NULL,status ENUM('received','under_review','planned','in_progress','implemented','declined') NOT NULL DEFAULT 'received',admin_note VARCHAR(2000) NULL,image_mime VARCHAR(40) NULL,image_data MEDIUMBLOB NULL,reviewed_by BIGINT UNSIGNED NULL,reviewed_at TIMESTAMP NULL,created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,KEY idx_member_feedback_member(member_id,created_at),KEY idx_member_feedback_status(status,created_at)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
    "CREATE TABLE IF NOT EXISTS community_post_media (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,post_id BIGINT UNSIGNED NOT NULL,image_mime VARCHAR(40) NOT NULL,image_data MEDIUMBLOB NOT NULL,created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE KEY uq_community_post_media_post(post_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"
  ];
  for (const sql of statements) await pool.query(sql);
};

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
const communityImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter(_req,file,cb) { if(!['image/jpeg','image/png','image/webp'].includes(file.mimetype))return cb(new Error('Choose a JPG, PNG or WebP image under 5 MB.'));cb(null,true); }
});
function validCommunityImage(file) {
  const b=file&&file.buffer;if(!b||b.length<12)return false;
  return (b[0]===0xff&&b[1]===0xd8&&b[2]===0xff)||(b[0]===0x89&&b[1]===0x50&&b[2]===0x4e&&b[3]===0x47)||(b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP');
}
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
// Profile-photo JSON is base64-encoded and can be up to 3 MB; keep the larger limit scoped to this endpoint.
app.use('/api/mobile/profile/photo', express.json({ limit: '4.5mb' }));
app.use(express.json({ limit: '20kb' }));
app.use(session({
  name: 'monarch.sid',
  secret: process.env.SESSION_SECRET || 'development-only-change-this-secret',
  store: sessionStore, resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 86400000 }
}));
// Site-wide Monarch Codex feedback screens: turn plain-text responses and existing success notices into branded, mobile-friendly feedback.
app.use((req,res,next)=>{
  const originalSend=res.send;
  res.send=function(payload){
    if(typeof payload!=='string') return originalSend.call(this,payload);
    const type=String(res.getHeader('Content-Type')||'');
    const isHtml=type.includes('text/html')||/<(?:!doctype html|html|head|body)\b/i.test(payload);
    const isPlain=!isHtml&&(!type||type.includes('text/plain'));
    const success=/\b(success|successful|verified|activated|approved|completed|submitted|welcome|created|updated|saved|sent|claimed|payment received|request received)\b/i.test(payload)&&!/\b(error|failed|unable|not successful|could not|cannot|insufficient|invalid|already claimed|have been claimed)\b/i.test(payload);
    if(isHtml&&!res.locals.mcSuccessInjected){
      res.locals.mcSuccessInjected=true;
      const style='<style id="mc-feedback-motion-style">.mc-success-toast{position:fixed;z-index:20000;inset:0;width:100%;height:100%;box-sizing:border-box;padding:24px;display:flex;flex-direction:column;align-items:center;justify-content:center;overflow:hidden;border:0;border-radius:0;background:#fff;color:#111;text-align:center;opacity:0;pointer-events:none;transition:opacity .28s ease,transform .38s cubic-bezier(.2,.8,.2,1)}.mc-success-toast.mc-show{opacity:1;transform:translateX(0);pointer-events:auto}.mc-success-backdrop{position:fixed;inset:0;z-index:19999;background:#fff;opacity:0;pointer-events:none;transition:opacity .25s}.mc-success-backdrop.mc-show{opacity:1;pointer-events:auto}.mc-success-avatar{position:absolute;inset:0;width:100%;height:100%;margin:0;overflow:hidden;border:0;border-radius:0;box-shadow:none;background:#fff;z-index:0;opacity:1;pointer-events:none}.mc-success-avatar:after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,#ffffff1c,#ffffffa8 48%,#ffffffd9);}.mc-success-avatar img{width:100%;height:100%;object-fit:cover;object-position:28% center;display:block;filter:saturate(.9);animation:mc-avatar-pan 7s ease-in-out infinite alternate}.mc-success-toast>*:not(.mc-success-avatar){z-index:2}.mc-success-toast h2{animation:mc-title-in .65s .1s both}.mc-success-toast .mc-success-check{animation:mc-pop .6s .18s both}.mc-success-confetti i{border-radius:2px;box-shadow:0 0 8px #f3cf3c66;animation:mc-fall 3.6s linear infinite}.mc-success-confetti i:nth-child(3n){animation-duration:4.2s}.mc-success-confetti i:nth-child(4n){animation-duration:2.8s}@keyframes mc-avatar-pan{0%{transform:scale(1.04) translateX(-1.5%)}100%{transform:scale(1.16) translateX(1.5%)}}@keyframes mc-title-in{0%{transform:translateY(28px) scale(.94);opacity:0}100%{transform:translateY(0) scale(1);opacity:1}}.mc-success-check{width:68px;height:68px;display:grid;place-items:center;margin:0 auto 16px;border-radius:50%;background:#f3cf3c;color:#17140a;font-size:39px;font-weight:900;box-shadow:0 0 0 10px #f3cf3c35;animation:mc-pop .55s .12s both}.mc-success-toast h2{position:relative;max-width:700px;margin:0 0 22px;padding:18px 24px;border:1px solid #d4b63d;border-radius:20px;background:#ffffffed;color:#161616;font-size:clamp(1.65rem,6vw,3rem);line-height:1.12;box-shadow:0 18px 50px #0002}.mc-success-toast p{display:none}.mc-success-close{position:relative;margin-top:0;width:min(100%,440px);padding:16px 22px;border:0;border-radius:999px;background:linear-gradient(110deg,#f4dc82,#d8ad3d);color:#17140a;font:inherit;font-weight:900;cursor:pointer;box-shadow:0 12px 28px #b28b252e;overflow:hidden}.mc-success-close:after{content:"";position:absolute;inset:-40% auto -40% -35%;width:25%;transform:skewX(-22deg);background:linear-gradient(90deg,transparent,#fff9,transparent);animation:mc-buttonshine 2.8s ease-in-out infinite}@keyframes mc-buttonshine{0%,60%,100%{left:-35%}80%{left:120%}}.mc-success-confetti{position:absolute;inset:0;overflow:hidden;pointer-events:none;border-radius:inherit}.mc-success-confetti i{position:absolute;top:-15px;width:8px;height:15px;background:#f3cf3c;animation:mc-fall 3.6s linear infinite}.mc-success-confetti i:nth-child(3n){background:#fff0a3}.mc-success-confetti i:nth-child(2n){background:#c79b20}@keyframes mc-pop{0%{transform:scale(.3);opacity:0}70%{transform:scale(1.15)}100%{transform:scale(1);opacity:1}}@keyframes mc-fall{0%{transform:translate3d(0,-5vh,0) rotate(0);opacity:0}12%{opacity:1}100%{transform:translate3d(35px,110vh,0) rotate(720deg);opacity:0}}.mc-feedback-page{min-height:100vh;box-sizing:border-box;display:grid;place-items:center;padding:22px;background:radial-gradient(ellipse at 50% 0%,rgba(243,207,60,.13),transparent 50%),#09090b;color:#f7f4e9;font:16px/1.65 system-ui,-apple-system,sans-serif}.mc-feedback-card{width:min(520px,100%);box-sizing:border-box;padding:clamp(24px,6vw,38px);border:1px solid rgba(243,207,60,.38);border-radius:26px;background:linear-gradient(145deg,#1b1a16,#101012);box-shadow:0 24px 80px #0008;text-align:center}.mc-feedback-card h1{color:#f3cf3c;margin:0 0 12px;font-size:clamp(1.5rem,6vw,2rem)}.mc-feedback-card p{margin:0;color:#d5d0c3;overflow-wrap:anywhere}.mc-feedback-mark{width:60px;height:60px;display:grid;place-items:center;border-radius:20px;margin:0 auto 18px;background:rgba(243,207,60,.13);border:1px solid rgba(243,207,60,.45);color:#f3cf3c;font-size:28px}.mc-feedback-link{display:inline-block;margin-top:24px;padding:12px 24px;border-radius:999px;background:#f3cf3c;color:#17140a;text-decoration:none;font-weight:850}@media(prefers-reduced-motion:reduce){.mc-success-toast,.mc-success-backdrop{transition:none}.mc-success-confetti i{animation:none;display:none}.mc-success-avatar img,.mc-success-toast h2,.photo-success-overlay:before,.photo-success-card:after{animation:none!important}}.mc-success-toast{padding:clamp(14px,3vw,36px);display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);grid-template-rows:1fr;align-items:center;gap:0;background:radial-gradient(ellipse at 20% 45%,#064c39 0%,#021d19 42%,#010b0b 100%);color:#f7fffb;text-align:center}.mc-success-avatar{inset:0 auto 0 0;width:54%;height:100%;background:#031a16;opacity:1}.mc-success-avatar:after{background:linear-gradient(90deg,#00130c00 55%,#00130cbd 100%),linear-gradient(0deg,#00130c66,#00130c00 45%)}.mc-success-avatar img{object-fit:cover;object-position:center 18%;filter:saturate(1.08) contrast(1.04);animation:mc-avatar-pan 8s ease-in-out infinite alternate}.mc-success-toast>*:not(.mc-success-avatar){grid-column:2;position:relative;z-index:2}.mc-success-confetti{z-index:3}.mc-success-toast .mc-success-check{grid-row:1;align-self:end;margin:0 auto 18px;width:clamp(68px,9vw,110px);height:clamp(68px,9vw,110px);border:4px solid #38ff77;background:radial-gradient(circle at 35% 25%,#29ff68,#00a83e 75%);color:#fff;font-size:clamp(40px,6vw,66px);box-shadow:0 0 0 9px #00e65c25,0 0 42px #00ff6a88;animation:mc-green-pop .75s cubic-bezier(.2,1.5,.5,1) both}.mc-success-toast h2{grid-row:2;max-width:650px;margin:0 auto 24px;padding:0;border:0;border-radius:0;background:transparent;color:#fff;font-size:clamp(2rem,5.2vw,4.4rem);line-height:1.02;letter-spacing:-.035em;text-transform:none;text-shadow:0 5px 30px #0008;box-shadow:none}.mc-success-toast h2:after{content:"";display:block;width:70%;height:3px;margin:18px auto 0;border-radius:9px;background:linear-gradient(90deg,transparent,#00ff78,transparent);box-shadow:0 0 16px #00ff7866}.mc-success-toast p{display:none}.mc-success-close{grid-row:3;width:min(100%,560px);min-height:64px;margin:0 auto;padding:18px 24px;border:1px solid #7affad;border-radius:999px;background:linear-gradient(110deg,#00d85c,#00f27b,#00b94d);color:#fff;font-size:clamp(1.05rem,2.5vw,1.4rem);box-shadow:0 10px 35px #00e65c38,inset 0 1px #ffffff55}.mc-success-close:after{background:linear-gradient(90deg,transparent,#ffffffb8,transparent)}.mc-success-toast.mc-show{transform:translateX(0);animation:mc-success-enter .6s cubic-bezier(.2,.8,.2,1) both}.mc-success-backdrop{background:#010b09}.mc-success-confetti i{background:#00ff6a;box-shadow:0 0 9px #00ff7c88}.mc-success-confetti i:nth-child(3n){background:#ffe15a}.mc-success-confetti i:nth-child(2n){background:#e9fff4}@keyframes mc-green-pop{0%{transform:scale(.25) rotate(-20deg);opacity:0}70%{transform:scale(1.12) rotate(4deg)}100%{transform:scale(1) rotate(0);opacity:1}}@keyframes mc-success-enter{0%{opacity:0;transform:translateX(4%)}100%{opacity:1;transform:translateX(0)}}@media(max-width:680px){.mc-success-toast{grid-template-columns:1fr;grid-template-rows:minmax(30vh,42vh) auto auto auto;align-content:center;gap:0;padding:18px 20px}.mc-success-avatar{inset:0 0 auto;width:100%;height:48%}.mc-success-avatar:after{background:linear-gradient(0deg,#00130c 0%,#00130c00 55%),linear-gradient(90deg,#00130c00,#00130c22)}.mc-success-toast>*:not(.mc-success-avatar){grid-column:1}.mc-success-toast .mc-success-check{grid-row:2;align-self:center;margin:0 auto 14px;width:76px;height:76px}.mc-success-toast h2{grid-row:3;font-size:clamp(2rem,9vw,3.3rem);margin:0 auto 22px;max-width:100%}.mc-success-close{grid-row:4;min-height:60px}.mc-success-confetti{z-index:4}}@media(prefers-reduced-motion:reduce){.mc-success-toast.mc-show,.mc-success-toast .mc-success-check{animation:none!important}.mc-success-avatar img{animation:none!important}}</style>';
      const script='<script>(function(){function init(){var candidates=[].slice.call(document.querySelectorAll(".notice,.alert,.alert-success,.success-message,.success-notice,[role=status],[data-success-message]"));var node=candidates.find(function(n){return /success|successful|verified|activated|approved|completed|submitted|welcome|created|updated|saved|sent|claimed|payment received|request received/i.test(n.textContent||"")&&!/error|failed|unable|not successful/i.test(n.textContent||"")});if(!node||document.querySelector(".mc-success-toast"))return;var msg=(node.textContent||"").trim();if(!msg||msg.length>600)return;var backdrop=document.createElement("div");backdrop.className="mc-success-backdrop";var modal=document.createElement("section");modal.className="mc-success-toast";modal.setAttribute("role","status");modal.setAttribute("aria-live","polite");modal.innerHTML="<div class=\\"mc-success-confetti\\">"+Array.from({length:32},function(_,i){return "<i style=\\"left:"+(i*3.1)+"%;animation-delay:"+(Math.random()*.7)+"s\\"></i>"}).join("")+"</div><div class=\\"mc-success-avatar\\"><img src=\\"/assets/images/monarch-success-avatar.jpg\\" alt=\\"Monarch Codex avatar\\"></div><div class=\\"mc-success-check\\">✓</div><h2></h2><button class=\\"mc-success-close\\">Continue →</button>";var clean=msg.replace(/\\s+/g," ").replace(/[.!]+$/,"").trim();modal.querySelector("h2").textContent=clean.length>92?clean.slice(0,89)+"…":clean;function close(){modal.classList.remove("mc-show");backdrop.classList.remove("mc-show");setTimeout(function(){modal.remove();backdrop.remove()},300)}modal.querySelector("button").onclick=close;backdrop.onclick=close;document.addEventListener("keydown",function(e){if(e.key==="Escape")close()},{once:true});document.body.append(backdrop,modal);requestAnimationFrame(function(){backdrop.classList.add("mc-show");modal.classList.add("mc-show")})}if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init);else init()})();</script>';
      payload=payload.replace('</head>','<script defer src="/assets/js/app-shell.js?v=20261019-app1"></script>'+style+'</head>').replace('</body>',script+'</body>');
      return originalSend.call(this,payload);
    }
    if(isPlain&&payload.trim().length>0&&payload.length<1800&&this.statusCode>=200&&this.statusCode<500){
      const safe=payload.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
      const heading=success?'Success, Monarch!':'Let’s get this sorted';
      const mark=success?'✓':'✦';
      const avatar=success?'<div class="mc-success-avatar"><img src="/assets/images/monarch-success-avatar.jpg" alt="Monarch Codex avatar"></div>':'';
      const confetti=success?'<div class="mc-success-confetti">'+Array.from({length:18},(_,i)=>'<i style="left:'+(i*5.7)+'%;animation-delay:'+(i*.018)+'s"></i>').join('')+'</div>':'';
      const page='<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#09090b"><title>'+heading+' · Monarch Codex</title>'+style+'</head><body><main class="mc-feedback-page"><section class="mc-feedback-card">'+confetti+avatar+'<div class="mc-feedback-mark">'+mark+'</div><h1>'+heading+'</h1><p>'+safe+'</p><a class="mc-feedback-link" href="javascript:history.back()">Go back</a></section></main>'+(success?script:'')+'</body></html>';
      res.setHeader('Content-Type','text/html; charset=utf-8');
      return originalSend.call(this,page);
    }
    return originalSend.call(this,payload);
  };
  next();
});
// Shared mobile-carrier NATs can represent many legitimate members. Keep network-wide limits high enough for a community launch; the stricter per-account login/reset limits still deter targeted abuse.
const registrationLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 1000, standardHeaders: 'draft-7', legacyHeaders: false, message: 'The registration safety limit was reached. Please wait and try again.' });
// Do not impose a shared-IP login ceiling: Hostinger/mobile-carrier NAT can put many real members behind one address. Limit failed attempts per account+IP instead; successful logins do not consume the allowance.
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 50, standardHeaders: 'draft-7', legacyHeaders: false, skipSuccessfulRequests: true, keyGenerator: req => ipKeyGenerator(req.ip || '0.0.0.0') + ':' + String(req.body && req.body.identity || '').trim().toLowerCase().slice(0, 254), message: 'Too many unsuccessful attempts for this account. Please wait 15 minutes and try again.' });
const resetNetworkLimiter = rateLimit({ windowMs: 3600000, limit: 100, standardHeaders: 'draft-7', legacyHeaders: false, message: 'The password-reset safety limit for this network was reached. Please try again later.' });
const resetLimiter = rateLimit({ windowMs: 3600000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false, keyGenerator: req => ipKeyGenerator(req.ip || '0.0.0.0') + ':' + String(req.body && req.body.email || '').trim().toLowerCase().slice(0, 254), message: 'Too many requests for this email address. Please try again later.' });
const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
const mailConfigured = () => Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASSWORD);
async function sendAppEmail({ to, subject, text, html }) {
  if (!mailConfigured()) { console.warn('[mail] SMTP is not configured; skipped email:', subject); return false; }
  const transporter = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 465), secure: String(process.env.SMTP_SECURE || 'true') === 'true', auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } });
  const safeSubject = esc(subject || 'Account notification');
  const safeBody = esc(text || '').replace(/\n{2,}/g, '</p><p style="margin:0 0 16px;line-height:1.8;color:#e4dfd2">').replace(/\n/g, '<br>');
  const brandedHtml = '<div style="margin:0;padding:28px 14px;background:#08090b;font-family:Arial,Helvetica,sans-serif;color:#f8f5eb"><div style="max-width:600px;margin:auto;background:#111216;border:1px solid #5a4b24;border-radius:20px;overflow:hidden"><header style="padding:28px 22px;text-align:center;background:#211b0e"><div style="font-size:12px;letter-spacing:3px;color:#f3cf3c;font-weight:bold">MONARCH CODEX</div><h1 style="font-size:24px;line-height:1.3;margin:16px 0 0">' + safeSubject + '</h1></header><main style="padding:26px 24px"><p style="margin:0 0 16px;line-height:1.8;color:#e4dfd2">' + safeBody + '</p></main><footer style="padding:18px;text-align:center;border-top:1px solid #302a1a;color:#a49d8b;font-size:12px">BUILD WEALTH. BUILD A KINGDOM.<br>Monarch Codex · Automated account notification</footer></div></div>';
  await transporter.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to, subject, text, html: html || brandedHtml });
  return true;
}
const page = (title, body) => '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#0b0b0c"><title>' + esc(title) + ' | Monarch Codex</title><style>' +
':root{color-scheme:dark;--gold:#f3cf3c;--bg:#0b0b0c;--panel:#17171c;--muted:#b8b6c0}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top,#252111 0,#0b0b0c 45%);color:#f7f5ef;font:16px/1.6 system-ui,-apple-system,Segoe UI,sans-serif;min-height:100vh}.wrap{width:min(100% - 32px,540px);margin:48px auto}.brand{font-weight:900;letter-spacing:.08em;color:var(--gold);text-decoration:none}.panel{margin-top:20px;padding:28px;background:rgba(23,23,28,.96);border:1px solid #55491e;border-radius:22px;box-shadow:0 18px 55px #0007}h1{line-height:1.2;font-size:clamp(1.7rem,5vw,2.3rem);margin:.25em 0}.muted{color:var(--muted)}label{display:block;font-weight:700;margin:15px 0 6px}input{width:100%;padding:13px 14px;border:1px solid #484650;border-radius:10px;background:#0d0d10;color:#fff;font:inherit}input:focus{outline:2px solid var(--gold);outline-offset:1px}.password-wrap{position:relative}.password-wrap input{padding-right:54px}.password-toggle{position:absolute;right:8px;top:50%;transform:translateY(-50%);width:40px;height:40px;display:grid;place-items:center;border:0;border-radius:8px;background:transparent;color:var(--muted);cursor:pointer}.password-toggle:hover,.password-toggle:focus-visible{color:var(--gold);outline:2px solid var(--gold)}.password-toggle svg{width:21px;height:21px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.btn{display:inline-block;width:100%;margin-top:20px;padding:13px 16px;border:0;border-radius:999px;background:var(--gold);color:#121212;font:inherit;font-weight:900;text-align:center;text-decoration:none;cursor:pointer}.links{display:flex;gap:14px;flex-wrap:wrap;margin-top:18px}.links a{color:var(--gold)}.notice{padding:12px 14px;border:1px solid #625222;border-radius:10px;background:#27220f;margin:14px 0}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.stat{padding:15px;border:1px solid #48412a;border-radius:12px}.stat strong{display:block;color:var(--gold);font-size:1.2rem;overflow-wrap:anywhere}.small{font-size:.88rem}footer{margin-top:24px;color:var(--muted);font-size:.85rem}@media(max-width:420px){.panel{padding:20px}.grid{grid-template-columns:1fr}}.wrap.dashboard-wrap{width:min(calc(100% - 32px),1100px);margin:32px auto}.dashboard-wrap .panel{padding:clamp(22px,3.5vw,40px)}.dashboard-wrap .grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.dashboard-wrap .stat{min-width:0}.dashboard-wrap #refLink{font-size:clamp(.85rem,1.5vw,1rem)}.dashboard-wrap .notice{overflow-wrap:anywhere}.dashboard-layout{display:grid;grid-template-columns:248px minmax(0,1fr);gap:24px;align-items:start;margin-top:26px;transition:grid-template-columns .22s ease}.dashboard-sidebar{position:sticky;top:18px;padding:14px;background:linear-gradient(180deg,#17171b,#101013);border:1px solid #3d3520;border-radius:18px;box-shadow:0 16px 40px #0003;min-width:0}.sidebar-brand-row{padding:4px 4px 16px}.dashboard-sidebar .side-title{color:var(--gold);font-size:.7rem;font-weight:900;letter-spacing:.14em;padding:4px 6px 12px}.dashboard-sidebar nav{display:grid;gap:7px}.dashboard-sidebar a{display:flex;align-items:center;gap:12px;min-height:46px;padding:11px 12px;border-radius:12px;color:#d7d4cb;text-decoration:none;font-weight:650;transition:background .16s ease,color .16s ease,transform .16s ease}.dashboard-sidebar nav a svg{flex:0 0 21px;width:21px;height:21px;color:#aaa38c}.dashboard-sidebar a:hover,.dashboard-sidebar a:focus-visible,.dashboard-sidebar a[aria-current="page"]{background:linear-gradient(90deg,#3a3014,#262111);color:var(--gold);outline:none}.dashboard-sidebar a[aria-current="page"] svg{color:var(--gold)}.dashboard-sidebar a:hover{transform:translateX(2px)}.dashboard-section[hidden]{display:none}.dashboard-content{min-width:0}.dashboard-content .panel{margin-top:0;padding:clamp(20px,3vw,34px)}.sidebar-logout{border-top:1px solid #38311f;margin-top:18px;padding-top:14px}.sidebar-logout form{margin:0}.sidebar-logout-btn{width:100%;display:flex;align-items:center;gap:12px;min-height:46px;padding:11px 12px;border:1px solid #4b3028;border-radius:12px;background:#211514;color:#f0b3a7;font:inherit;font-weight:700;text-align:left;cursor:pointer}.sidebar-logout-btn svg{width:20px;height:20px;flex:0 0 20px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.sidebar-logout-btn:hover,.sidebar-logout-btn:focus-visible{background:#35201d;outline:2px solid #6e3b32;outline-offset:2px}.dashboard-layout.sidebar-collapsed .sidebar-logout-btn{justify-content:center;padding:12px 8px}.dashboard-layout.sidebar-collapsed .sidebar-logout-btn .nav-text{display:none}.dashboard-layout.sidebar-collapsed{grid-template-columns:78px minmax(0,1fr)}.dashboard-layout.sidebar-collapsed .dashboard-sidebar{padding:12px 9px}.dashboard-layout.sidebar-collapsed .sidebar-brand-row{justify-content:center}.dashboard-layout.sidebar-collapsed .side-title,.dashboard-layout.sidebar-collapsed .nav-text{display:none}.dashboard-layout.sidebar-collapsed .dashboard-sidebar nav a{justify-content:center;padding:12px 8px}.sidebar-desktop-toggle{display:inline-grid}.sidebar-scrim{display:none}.dashboard-section{scroll-margin-top:20px;margin-bottom:24px}.dashboard-section:last-child{margin-bottom:0}.dashboard-section h2{font-size:1.35rem;margin:0 0 8px}.section-card{padding:20px;border:1px solid #403a27;border-radius:14px;background:#111115;margin-top:14px}.section-card p:last-child{margin-bottom:0}.dashboard-topline{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap}.dashboard-topline .btn{width:auto;margin:0;padding:10px 18px}.dashboard-content .grid{grid-template-columns:repeat(2,minmax(0,1fr))}.dashboard-content .stat{min-width:0}@media(max-width:760px){.dashboard-layout,.dashboard-layout.sidebar-collapsed{grid-template-columns:1fr;gap:14px}.dashboard-sidebar,.dashboard-layout.sidebar-collapsed .dashboard-sidebar{position:fixed;z-index:1002;left:12px;top:12px;bottom:12px;width:min(300px,calc(100vw - 48px));overflow-y:auto;transform:translateX(calc(-100% - 20px));transition:transform .22s ease;box-shadow:0 24px 70px #0009}.dashboard-layout.sidebar-open .dashboard-sidebar{transform:translateX(0)}.dashboard-sidebar .side-title,.dashboard-layout.sidebar-collapsed .side-title{display:block}.dashboard-sidebar nav{display:grid;gap:6px}.dashboard-sidebar a{white-space:normal}.sidebar-desktop-toggle{display:none}.dashboard-content .panel{padding:18px}.dashboard-content .grid{grid-template-columns:1fr}.sidebar-scrim{position:fixed;inset:0;z-index:1001;border:0;background:#000a;display:block;opacity:0;visibility:hidden;transition:opacity .22s ease,visibility .22s ease}.dashboard-layout.sidebar-open .sidebar-scrim{opacity:1;visibility:visible}}@media(max-width:560px){.wrap.dashboard-wrap{width:calc(100% - 24px);margin:18px auto}.dashboard-wrap .panel{padding:18px}.dashboard-wrap .grid{grid-template-columns:1fr}.dashboard-wrap .btn{min-height:48px}}' +
'.wrap.admin-wrap{width:calc(100% - 40px);max-width:none;margin:28px auto}.admin-wrap>.panel{padding:clamp(18px,2vw,30px);margin-top:18px}.admin-wrap .ac-layout{width:100%;max-width:none;grid-template-columns:270px minmax(0,1fr);gap:24px}.admin-wrap .ac-main{width:100%;min-width:0}.admin-wrap .ac-stats{grid-template-columns:repeat(3,minmax(0,1fr))}.admin-wrap .ac-tiles{grid-template-columns:repeat(2,minmax(0,1fr))}@media(min-width:1100px){.admin-wrap .ac-stats{grid-template-columns:repeat(4,minmax(0,1fr))}}@media(max-width:800px){.wrap.admin-wrap{width:calc(100% - 24px);margin:18px auto}.admin-wrap>.panel{padding:clamp(14px,3vw,22px)}.admin-wrap .ac-layout{display:block;width:100%}.admin-wrap .ac-stats{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:480px){.wrap.admin-wrap{width:calc(100% - 16px);margin:12px auto}.admin-wrap>.panel{padding:12px}.admin-wrap .ac-tiles{grid-template-columns:1fr}}.copy-value{display:flex;align-items:center;gap:10px;min-width:0;margin-top:8px}.copy-value strong{overflow-wrap:anywhere;min-width:0}.copy-value input{min-width:0;flex:1}.copy-btn{flex:0 0 auto;border:1px solid #65551e;border-radius:10px;background:#28220f;color:#f3cf3c;padding:10px 13px;font:inherit;font-size:.85rem;font-weight:800;cursor:pointer}.copy-btn:hover,.copy-btn:focus-visible{background:#3a3014;outline:2px solid #f3cf3c;outline-offset:2px}.icon-btn{display:inline-grid;place-items:center;width:42px;height:42px;flex:0 0 42px;border:1px solid #514721;border-radius:12px;background:#17171c;color:#f3cf3c;cursor:pointer}.icon-btn svg,.dashboard-sidebar nav a svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.sidebar-brand-row{display:flex;align-items:center;justify-content:space-between;gap:8px}.sidebar-brand-row .side-title{padding:4px 10px 12px}.dashboard-sidebar nav a{display:flex;align-items:center;gap:12px}.dashboard-sidebar nav a svg{flex:0 0 20px}.sidebar-scrim,.mobile-dashboard-bar{display:none}.mobile-current-tab{color:var(--gold);font-weight:800;margin-left:auto}.dashboard-topline h1{letter-spacing:-.035em}.dashboard-content>.panel{border-color:#4b421f;box-shadow:0 24px 70px #0005}.dashboard-section h2{letter-spacing:-.02em}.dashboard-section .stat{background:linear-gradient(145deg,#17171c,#101013);padding:22px}.dashboard-section .stat strong{font-size:1.35rem}.dashboard-sidebar{border-color:#373224;box-shadow:0 16px 42px #0003}.dashboard-sidebar a{transition:background .18s ease,color .18s ease,transform .18s ease}.dashboard-sidebar a:hover{transform:translateX(2px)}@media(max-width:760px){.dashboard-layout{grid-template-columns:1fr}.dashboard-sidebar{position:fixed;z-index:1002;left:12px;top:12px;bottom:12px;width:min(290px,calc(100vw - 48px));overflow-y:auto;transform:translateX(calc(-100% - 20px));transition:transform .22s ease;box-shadow:0 24px 70px #0009}.dashboard-layout.sidebar-open .dashboard-sidebar{transform:translateX(0)}.sidebar-scrim{position:fixed;inset:0;z-index:1001;border:0;background:#000a;display:block;opacity:0;visibility:hidden;transition:opacity .22s ease,visibility .22s ease}.dashboard-layout.sidebar-open .sidebar-scrim{opacity:1;visibility:visible}.sidebar-close{display:inline-grid}.mobile-dashboard-bar{display:flex;align-items:center;gap:12px;margin:0 0 12px;padding:10px 12px;border:1px solid #3d3620;border-radius:14px;background:#111115;color:#b8b6c0;font-size:.78rem;font-weight:800;letter-spacing:.08em}.dashboard-content .panel{padding:clamp(18px,4vw,28px)}.dashboard-topline{align-items:flex-start}.dashboard-topline h1{font-size:clamp(1.7rem,6vw,2.25rem)}.dashboard-sidebar nav{display:grid;overflow:visible;padding:8px 0}.dashboard-sidebar a{white-space:normal}.dashboard-sidebar .side-title{padding:10px}.dashboard-layout.sidebar-open{overflow:hidden}}@media(min-width:761px){.sidebar-close{display:none}.sidebar-scrim{display:none!important}}html[data-theme="light"]{color-scheme:light}html[data-theme="light"] body{background:#f5f6f8!important;color:#191b20!important}html[data-theme="light"] .wrap{color:#191b20}html[data-theme="light"] .panel,html[data-theme="light"] .ac-side,html[data-theme="light"] .ac-stat,html[data-theme="light"] .ac-panel,html[data-theme="light"] .ac-tile,html[data-theme="light"] .ac-coming,html[data-theme="light"] .ac-table-wrap,html[data-theme="light"] .member-rail,html[data-theme="light"] .member-main .panel,html[data-theme="light"] .member-main .section-card,html[data-theme="light"] .member-main .stat,html[data-theme="light"] .member-main .card,html[data-theme="light"] .member-main .member-card{background:#fff!important;color:#191b20!important;border-color:#e5e6ea!important;box-shadow:0 8px 28px #16161608!important}html[data-theme="light"] .ac-top h1,html[data-theme="light"] .ac-main h2,html[data-theme="light"] .ac-main h3,html[data-theme="light"] .ac-brand,html[data-theme="light"] .ac-nav,html[data-theme="light"] .member-brand,html[data-theme="light"] .member-page-heading h1,html[data-theme="light"] .member-content-heading h2{color:#202127!important}html[data-theme="light"] .muted,html[data-theme="light"] .ac-panel p,html[data-theme="light"] .ac-stat small,html[data-theme="light"] .ac-tile small,html[data-theme="light"] .member-page-heading p{color:#737782!important}html[data-theme="light"] input,html[data-theme="light"] select,html[data-theme="light"] textarea{background:#fff!important;color:#202127!important;border-color:#dedfe4!important}.mc-theme-toggle{position:fixed;z-index:1200;top:12px;right:14px;min-height:38px;padding:0 12px;border:1px solid #5a5037;border-radius:999px;background:#171719;color:#f4eddd;font:700 12px system-ui;cursor:pointer;box-shadow:0 5px 22px #0002}@media(max-width:760px){.wrap,.member-experience,.ac-layout{width:100%!important;max-width:none!important;margin:0!important;border-radius:0!important}.mc-theme-toggle{top:10px;right:10px;min-height:35px;padding:0 10px;font-size:11px}.ac-main{width:100%!important;min-width:0!important;padding:14px!important}.ac-stats{grid-template-columns:repeat(2,minmax(0,1fr))!important}.ac-tiles{grid-template-columns:repeat(2,minmax(0,1fr))!important}.member-workspace{min-width:0!important;width:100%!important;padding-left:14px!important;padding-right:14px!important}}' + '</style></head><body>' + '<script>(function(){var r=document.documentElement,k="monarch-codex-theme",v="dark";try{v=localStorage.getItem(k)||"dark"}catch(e){}r.setAttribute("data-theme",v==="light"?"light":"dark");document.addEventListener("DOMContentLoaded",function(){var b=document.createElement("button");b.type="button";b.className="mc-theme-toggle";b.setAttribute("aria-label","Switch colour theme");function p(){var l=r.getAttribute("data-theme")==="light";b.textContent=l?"☾ Dark mode":"☀ Light mode";b.setAttribute("aria-pressed",l?"true":"false")}b.addEventListener("click",function(){var n=r.getAttribute("data-theme")==="light"?"dark":"light";r.setAttribute("data-theme",n);try{localStorage.setItem(k,n)}catch(e){}p()});p();document.body.appendChild(b)})})();</script>' + '<main class="wrap' + (body.includes('class="member-experience"') ? ' member-wrap' : (title === 'Member dashboard' ? ' dashboard-wrap' : (body.includes('id="adminLayout"') ? ' admin-wrap' : ''))) + '"><a class="brand" href="/">MONARCH CODEX</a><section class="panel">' + body + '</section><footer>© ' + new Date().getFullYear() + ' Monarch Codex. All rights reserved.</footer></main><script>document.querySelectorAll("[data-copy-target]").forEach(function(button){button.addEventListener("click",async function(){var target=document.getElementById(button.getAttribute("data-copy-target"));if(!target)return;var value=target.value!==undefined?target.value:target.textContent.trim();try{if(navigator.clipboard&&window.isSecureContext){await navigator.clipboard.writeText(value);}else{var temp=document.createElement("textarea");temp.value=value;temp.style.position="fixed";temp.style.opacity="0";document.body.appendChild(temp);temp.select();var ok=document.execCommand("copy");temp.remove();if(!ok)throw new Error("copy failed");}var original=button.textContent;button.textContent="Copied!";setTimeout(function(){button.textContent=original;},1400);}catch(_){if(target.select)target.select();button.textContent="Select and copy";}});});function togglePassword(id,button){var input=document.getElementById(id);if(!input||!button)return;var show=input.type==="password";input.type=show?"text":"password";button.setAttribute("aria-label",show?"Hide password":"Show password");button.setAttribute("title",show?"Hide password":"Show password");button.setAttribute("aria-pressed",show?"true":"false");var svg=button.querySelector("svg");if(svg){var slash=svg.querySelector("[data-eye-slash]");if(show&&!slash){slash=document.createElementNS("http://www.w3.org/2000/svg","path");slash.setAttribute("d","M3 3l18 18");slash.setAttribute("data-eye-slash","true");svg.appendChild(slash);}else if(!show&&slash){slash.remove();}}}document.addEventListener("click",function(e){var button=e.target.closest("[data-toggle-password]");if(!button)return;e.preventDefault();togglePassword(button.getAttribute("data-toggle-password"),button);});document.querySelectorAll("[data-password-toggle]").forEach(function(button){button.addEventListener("click",function(e){e.preventDefault();togglePassword(button.getAttribute("data-password-toggle"),button);});});if(document.querySelector("[data-dashboard-tab]")){var tabs=[].slice.call(document.querySelectorAll("[data-dashboard-tab]"));var sections=tabs.map(function(t){return document.getElementById(t.getAttribute("data-dashboard-tab"));}).filter(Boolean);var layout=document.querySelector(".dashboard-layout");var currentLabel=document.querySelector(".mobile-current-tab");function closeSidebar(){if(layout)layout.classList.remove("sidebar-open");document.body.style.overflow="";}function showDashboardTab(id){if(!sections.some(function(s){return s.id===id;}))id="overview";sections.forEach(function(s){s.hidden=s.id!==id;});tabs.forEach(function(t){if(t.getAttribute("data-dashboard-tab")===id)t.setAttribute("aria-current","page");else t.removeAttribute("aria-current");});if(currentLabel){var active=tabs.find(function(t){return t.getAttribute("data-dashboard-tab")===id;});currentLabel.textContent=active?active.textContent.trim():"Overview";}}function openSidebar(){if(layout)layout.classList.add("sidebar-open");document.body.style.overflow="hidden";}var collapseButton=document.querySelector("[data-sidebar-collapse]");if(collapseButton&&layout){collapseButton.addEventListener("click",function(){var collapsed=layout.classList.toggle("sidebar-collapsed");collapseButton.setAttribute("aria-expanded",collapsed?"false":"true");collapseButton.setAttribute("aria-label",collapsed?"Expand sidebar":"Collapse sidebar");collapseButton.setAttribute("title",collapsed?"Expand sidebar":"Collapse sidebar");});}document.querySelectorAll("[data-sidebar-open]").forEach(function(b){b.addEventListener("click",openSidebar);});document.querySelectorAll("[data-sidebar-close]").forEach(function(b){b.addEventListener("click",closeSidebar);});tabs.forEach(function(t){t.addEventListener("click",function(e){e.preventDefault();var id=t.getAttribute("data-dashboard-tab");showDashboardTab(id);if(history.replaceState)history.replaceState(null,"","#"+id);closeSidebar();});});document.addEventListener("keydown",function(e){if(e.key==="Escape")closeSidebar();});showDashboardTab(location.hash.slice(1)||"overview");var actionGrid=document.getElementById("quickActions"),more=document.getElementById("toggleActions");if(actionGrid&&more){more.addEventListener("click",function(){var expanded=actionGrid.classList.toggle("actions-expanded");more.setAttribute("aria-expanded",String(expanded));more.textContent=expanded?"Fewer actions":"More actions";});}}</script></body></html>';
function csrfToken(req) { if (!req.session.csrf) req.session.csrf = crypto.randomBytes(32).toString('hex'); return req.session.csrf; }
function csrfField(req) { return '<input type="hidden" name="_csrf" value="' + esc(csrfToken(req)) + '">'; }
function csrfCheck(req, res, next) {
  const supplied = req.body && req.body._csrf, expected = req.session.csrf;
  if (!supplied || !expected || Buffer.byteLength(String(supplied)) !== Buffer.byteLength(String(expected)) || !crypto.timingSafeEqual(Buffer.from(String(supplied)), Buffer.from(String(expected)))) {
    return res.status(403).send(page('Security check', '<h1>Security check expired</h1><p class="muted">Please return to the form and try again.</p><a class="btn" href="/login">Back to login</a>'));
  }
  next();
}
async function requireAuth(req, res, next) {
  if (!req.session.memberId) return res.redirect('/login');
  try {
    const [rows] = await pool.execute('SELECT is_blocked FROM members WHERE id=? LIMIT 1', [req.session.memberId]);
    if (!rows.length || Number(rows[0].is_blocked) === 1) {
      req.session.destroy(() => {});
      return res.status(403).send(page('Account access restricted', '<h1>Account access restricted</h1><p class="muted">This account is blocked or unavailable. Please contact Monarch Codex support if you believe this is a mistake.</p><a class="btn" href="/login">Return to login</a>'));
    }
    next();
  } catch (e) {
    if (e && (e.code === 'ER_BAD_FIELD_ERROR' || e.code === 'ER_NO_SUCH_TABLE')) return next();
    next(e);
  }
}
async function requireApprovedKyc(req, res, next) {
  try {
    const [rows] = await pool.execute("SELECT status FROM kyc_submissions WHERE member_id=? ORDER BY submitted_at DESC,id DESC LIMIT 1", [req.session.memberId]);
    if (rows.length && String(rows[0].status || '').trim().toLowerCase() === 'approved') return next();
    return res.redirect('/kyc?required=approval');
  } catch (error) {
    if (error && error.code === 'ER_NO_SUCH_TABLE') return res.redirect('/kyc?required=approval');
    return next(error);
  }
}
// Enforce the KYC lock on the server, not just in dashboard navigation.
const KYC_RESTRICTED_MEMBER_ROOTS = [
  '/sovereign-desk', '/deposit', '/withdraw', '/transactions',
  '/investments', '/referrals', '/online-cooperative', '/notifications',
  '/api/deposit-quote', '/api/deposit-status'
];
app.use(async (req, res, next) => {
  if (!req.session || !req.session.memberId) return next();
  const pathname = req.path;
  const restricted = KYC_RESTRICTED_MEMBER_ROOTS.some(root => pathname === root || pathname.startsWith(root + '/'));
  if (!restricted) return next();
  try {
    const [rows] = await pool.execute(
      "SELECT status FROM kyc_submissions WHERE member_id=? ORDER BY submitted_at DESC,id DESC LIMIT 1",
      [req.session.memberId]
    );
    if (rows.length && String(rows[0].status || '').trim().toLowerCase() === 'approved') return next();
    if (req.method === 'GET' || req.method === 'HEAD') return res.redirect('/kyc?required=approval');
    return res.status(403).send(page('Verification required',
      '<h1>Complete verification first</h1><p class="muted">This section stays locked until your identity verification is approved.</p><a class="btn" href="/kyc?required=approval">Continue to verification</a>'));
  } catch (error) {
    if (error && error.code === 'ER_NO_SUCH_TABLE') {
      if (req.method === 'GET' || req.method === 'HEAD') return res.redirect('/kyc?required=approval');
      return res.status(403).send(page('Verification required', '<h1>Complete verification first</h1><p class="muted">Your verification status is not available yet. Please open the verification page.</p><a class="btn" href="/kyc">Verify account</a>'));
    }
    return next(error);
  }
});
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
  const body = '<link rel="stylesheet" href="/member-dashboard.css?v=20261019-light-contrast1"><style>.register-form{max-width:620px;margin:0 auto}.register-form .register-intro{color:#aaa7af;line-height:1.65;margin:8px 0 25px}.register-form .register-field{margin:0 0 17px}.register-form label{display:block;margin:0 0 7px;font-weight:650;color:#e9e5db}.register-form input,.register-form select{width:100%;box-sizing:border-box;min-height:47px;padding:12px 13px;border:1px solid #39363a;border-radius:11px;background:#111114;color:#f6f2e8;font:inherit}.register-form input:focus,.register-form select:focus{outline:2px solid #9e812c;outline-offset:1px;border-color:#d6b844}.register-form .password-wrap{display:flex;position:relative}.register-form .password-wrap input{padding-right:53px}.register-form .password-toggle{position:absolute;right:5px;top:5px;width:38px;height:37px;display:grid;place-items:center;border:0;border-radius:8px;background:#252219;color:#e6c84e;cursor:pointer}.register-form .password-toggle svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}.register-form .field-help{font-size:.78rem;color:#96929b;line-height:1.5;margin:7px 0 0}.register-form .password-rules{display:grid;gap:6px;margin:10px 0 0;padding:12px;border:1px solid #2e2c30;border-radius:10px;background:#0d0d10}.register-form .password-rules span{font-size:.78rem;color:#a7a3ac}.register-form .password-rules span:before{content:"○";display:inline-block;width:20px;color:#aaa}.register-form .password-rules .rule-pass{color:#8fdaa5}.register-form .password-rules .rule-pass:before{content:"✓";color:#8fdaa5}.register-form .field-error{color:#ff737d!important}.register-form .field-valid{color:#8fdaa5!important}.register-form .phone-row{display:grid;grid-template-columns:minmax(145px,.8fr) minmax(0,1.4fr);gap:9px}.register-form .register-consent{display:flex;align-items:flex-start;gap:11px;margin:22px 0 14px;padding:15px;border:1px solid #494126;border-radius:12px;background:#15140f}.register-form .register-consent input[type=checkbox]{width:20px;height:20px;min-height:20px;flex:0 0 20px;margin:3px 0 0;accent-color:#f3cf3c}.register-form .register-consent label{display:inline;margin:0;font-weight:600;line-height:1.6}.register-form .register-consent a{color:#f3cf3c;text-underline-offset:3px}.register-form .register-submit{width:100%;margin-top:5px;min-height:49px}.register-form .register-submit:disabled{opacity:.42;cursor:not-allowed;filter:grayscale(.55)}.register-form [aria-invalid=true]{border-color:#e05b66!important}.register-form .register-referral{border-top:1px solid #302d29;padding-top:19px;margin-top:21px}@media(max-width:420px){.register-form .phone-row{grid-template-columns:1fr}.register-form .register-field{margin-bottom:15px}}</style><section class="register-form"><div class="links" style="margin:0 0 18px"><a href="/">← Back to homepage</a></div><h1>Join Monarch Codex</h1><p class="register-intro">Create your account to access your personal dashboard, manage your membership and take your next steps with Monarch Codex.</p>' +
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

// Public market feeds. Cache upstream responses so one popular news page does not
// create a burst of requests to third-party publishers.
const marketFeedCache = new Map();
async function cachedMarketFeed(key, ttlMs, loader) {
  const cached = marketFeedCache.get(key);
  if (cached && Date.now() - cached.at < ttlMs) return cached.value;
  const value = await loader();
  marketFeedCache.set(key, { at: Date.now(), value });
  return value;
}
async function fetchMarketSource(url, accept) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'MonarchCodexMarketFeeds/1.0 (+https://monarchcodex.online)', accept: accept || 'application/json, application/rss+xml, application/xml, text/xml' },
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error('Market source returned HTTP ' + response.status);
  return response.text();
}
function xmlText(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ').trim();
}
function parseRss(xml, source) {
  const items = String(xml).match(/<(?:item|entry)\b[\s\S]*?<\/(?:item|entry)>/gi) || [];
  return items.slice(0, 35).map(item => {
    const get = (...names) => {
      for (const name of names) {
        const match = item.match(new RegExp('<' + name + '\\b[^>]*>([\\s\\S]*?)<\\/' + name + '>', 'i'));
        if (match) return xmlText(match[1]);
      }
      return '';
    };
    const linkTag = item.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*\/?\s*>/i);
    const link = get('link') || (linkTag ? linkTag[1] : '');
    const summary = get('description', 'summary', 'content:encoded', 'content');
    const publishedAt = get('pubDate', 'published', 'updated', 'dc:date');
    return { title: get('title'), summary: summary.slice(0, 420), url: /^https?:\/\//i.test(link) ? link : '', publishedAt, source };
  }).filter(item => item.title && item.url);
}
app.get('/api/market-news/forex-calendar', async (_req, res) => {
  try {
    const events = await cachedMarketFeed('forex-calendar', 5 * 60 * 1000, async () => {
      const raw = await fetchMarketSource('https://nfs.faireconomy.media/ff_calendar_thisweek.json');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('Unexpected calendar response');
      return parsed.map(event => {
        const impactRaw = String(event.impact || event.Impact || 'Low').toLowerCase();
        const impact = impactRaw.includes('high') || impactRaw.includes('holiday') ? 'high' : impactRaw.includes('medium') ? 'medium' : 'low';
        return {
          date: event.date || event.Date || event.datetime || '',
          currency: String(event.country || event.currency || event.Currency || '').toUpperCase(),
          impact,
          title: event.title || event.event || event.Event || 'Economic release',
          actual: event.actual || event.Actual || '',
          forecast: event.forecast || event.Forecast || '',
          previous: event.previous || event.Previous || ''
        };
      }).filter(event => event.currency && event.title);
    });
    res.set('Cache-Control', 'private, max-age=60').json({ events, updatedAt: new Date().toISOString(), source: 'Forex Factory calendar mirror', sourceUrl: 'https://www.forexfactory.com/calendar' });
  } catch (error) {
    console.warn('[market-news] Forex calendar unavailable:', error.message);
    res.status(502).json({ message: 'The economic calendar is temporarily unavailable. Please refresh shortly.', events: [], updatedAt: null, sourceUrl: 'https://www.forexfactory.com/calendar' });
  }
});
app.get('/api/market-news/crypto', async (_req, res) => {
  try {
    const articles = await cachedMarketFeed('crypto-news', 5 * 60 * 1000, async () => {
      const sources = [
        { name: 'Cointelegraph', url: 'https://cointelegraph.com/rss' },
        { name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' }
      ];
      const results = await Promise.allSettled(sources.map(async source => parseRss(await fetchMarketSource(source.url, 'application/rss+xml, application/xml, text/xml'), source.name)));
      const combined = results.flatMap(result => result.status === 'fulfilled' ? result.value : []);
      const seen = new Set();
      return combined.filter(article => {
        const key = article.url || article.title;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).sort((a, b) => (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0)).slice(0, 40);
    });
    res.set('Cache-Control', 'private, max-age=60').json({ articles, updatedAt: new Date().toISOString(), sources: ['Cointelegraph', 'CoinDesk'] });
  } catch (error) {
    console.warn('[market-news] Crypto news unavailable:', error.message);
    res.status(502).json({ message: 'Crypto news sources are temporarily unavailable. Please refresh shortly.', articles: [], updatedAt: null });
  }
});


const liveMarketCache = new Map();
async function getLiveMarketCache(key, ttlMs, loader) {
  const item = liveMarketCache.get(key);
  if (item && Date.now() - item.at < ttlMs) return { value: item.value, cached: true };
  try {
    const value = await loader();
    liveMarketCache.set(key, { at: Date.now(), value });
    return { value, cached: false };
  } catch (error) {
    // Keep the last successful quote set available during provider outages/rate limits.
    if (item && item.value) {
      console.warn('[live-markets] Serving stale cache for', key, '-', error.message);
      return { value: { ...item.value, stale: true }, cached: true };
    }
    throw error;
  }
}
app.get('/api/live-markets/crypto', async (req, res) => {
  const allowed = new Set(['USD', 'NGN', 'EUR', 'GBP']);
  const convert = String(req.query.convert || 'USD').toUpperCase();
  if (!allowed.has(convert)) return res.status(400).json({ message: 'Unsupported quote currency.' });
  try {
    const result = await getLiveMarketCache('crypto-listings-' + convert, 30 * 1000, async () => {
      const query = new URLSearchParams({
        vs_currency: convert.toLowerCase(), order: 'market_cap_desc',
        per_page: '100', page: '1', sparkline: 'false',
        price_change_percentage: '24h'
      });
      let coins;
      let global = {};
      let source = 'CoinGecko';
      try {
        const raw = await fetchMarketSource('https://api.coingecko.com/api/v3/coins/markets?' + query.toString(), 'application/json');
        const listings = JSON.parse(raw);
        if (!Array.isArray(listings) || !listings.length) throw new Error('CoinGecko returned no listings');
        coins = listings.map((coin, index) => ({
          id: coin.id, name: coin.name, symbol: coin.symbol, slug: coin.id,
          cmc_rank: coin.market_cap_rank || index + 1, logo: coin.image || '',
          circulating_supply: coin.circulating_supply,
          quote: { [convert]: {
            price: coin.current_price, percent_change_24h: coin.price_change_percentage_24h,
            market_cap: coin.market_cap, volume_24h: coin.total_volume
          } }
        }));
        // Global statistics are optional; a failure here must not break otherwise valid coin prices.
        try {
          const globalParsed = JSON.parse(await fetchMarketSource('https://api.coingecko.com/api/v3/global', 'application/json'));
          const metrics = globalParsed && globalParsed.data;
          if (metrics) global = { total_market_cap: { USD: metrics.total_market_cap && metrics.total_market_cap.usd }, total_volume_24h: { USD: metrics.total_volume && metrics.total_volume.usd } };
        } catch (error) { console.warn('[live-markets] Global metrics unavailable:', error.message); }
      } catch (primaryError) {
        // Independent public fallback helps recover when CoinGecko is rate-limited or unavailable.
        console.warn('[live-markets] CoinGecko unavailable; trying CoinCap:', primaryError.message);
        const fallback = JSON.parse(await fetchMarketSource('https://api.coincap.io/v2/assets?limit=100', 'application/json'));
        if (!Array.isArray(fallback.data) || !fallback.data.length) throw primaryError;
        let fxRate = 1;
        if (convert !== 'USD') {
          const fx = JSON.parse(await fetchMarketSource('https://open.er-api.com/v6/latest/USD', 'application/json'));
          if (fx.result !== 'success' || !Number(fx.rates && fx.rates[convert])) throw new Error('Could not convert fallback prices to ' + convert);
          fxRate = Number(fx.rates[convert]);
        }
        source = 'CoinCap fallback';
        coins = fallback.data.map((coin, index) => ({
          id: coin.id, name: coin.name, symbol: coin.symbol, slug: coin.id,
          cmc_rank: Number(coin.rank) || index + 1, logo: '',
          circulating_supply: Number(coin.supply) || null,
          quote: { [convert]: {
            price: Number(coin.priceUsd) * fxRate,
            percent_change_24h: Number(coin.changePercent24Hr),
            market_cap: Number(coin.marketCapUsd) * fxRate,
            volume_24h: Number(coin.volumeUsd24Hr) * fxRate
          } }
        }));
      }
      return { coins, global, source, updatedAt: new Date().toISOString() };
    });
    res.set('Cache-Control', 'no-store').json({ ...result.value, cached: result.cached });
  } catch (error) {
    console.warn('[live-markets] Crypto quotes unavailable:', error.message);
    res.status(502).json({ message: 'Market data provider is temporarily unavailable. Please retry shortly.' });
  }
});
app.get('/api/live-markets/forex', async (_req, res) => {
  try {
    const result = await getLiveMarketCache('fx-reference-usd', 30 * 60 * 1000, async () => {
      const normalizeRates = (rawRates) => {
        if (!rawRates || typeof rawRates !== 'object') throw new Error('Provider returned no rates');
        const rates = Object.fromEntries(Object.entries(rawRates)
          .map(([code, value]) => [String(code).toUpperCase(), Number(value)])
          .filter(([code, value]) => /^[A-Z]{3}$/.test(code) && Number.isFinite(value) && value > 0));
        rates.USD = 1;
        if (!rates.NGN || !rates.EUR || !rates.GBP) throw new Error('Provider is missing required NGN, EUR or GBP rates');
        return rates;
      };
      const providers = [
        {
          name: 'ExchangeRate-API',
          url: 'https://open.er-api.com/v6/latest/USD',
          parse(parsed) {
            if (parsed.result !== 'success') throw new Error('Unexpected ExchangeRate-API response');
            return { rates: normalizeRates(parsed.rates), date: parsed.time_last_update_utc || parsed.time_last_update_unix || null };
          }
        },
        {
          name: 'Currency API (Cloudflare Pages)',
          url: 'https://latest.currency-api.pages.dev/v1/currencies/usd.json',
          parse(parsed) {
            return { rates: normalizeRates(parsed.usd), date: parsed.date || null };
          }
        },
        {
          name: 'Currency API (jsDelivr)',
          url: 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json',
          parse(parsed) {
            return { rates: normalizeRates(parsed.usd), date: parsed.date || null };
          }
        },
        {
          name: 'Currency API (GitHub mirror)',
          url: 'https://cdn.jsdelivr.net/gh/fawazahmed0/currency-api@1/latest/v1/currencies/usd.json',
          parse(parsed) {
            return { rates: normalizeRates(parsed.usd), date: parsed.date || null };
          }
        }
      ];
      const attempts = providers.map(async provider => {
        try {
          const parsed = JSON.parse(await fetchMarketSource(provider.url, 'application/json'));
          const normalized = provider.parse(parsed);
          console.info('[live-markets] FX rates loaded from', provider.name);
          return { rates: { base_code: 'USD', rates: normalized.rates, date: normalized.date }, updatedAt: new Date().toISOString(), source: provider.name, sourceUrl: provider.url, rateDate: normalized.date };
        } catch (error) {
          console.warn('[live-markets] FX provider failed:', provider.name, error.message);
          throw new Error(provider.name + ': ' + error.message);
        }
      });
      try {
        // Race independent providers so one slow or blocked host doesn't delay a healthy fallback.
        return await Promise.any(attempts);
      } catch (error) {
        const failures = error && error.errors ? error.errors.map(item => item.message).join(' | ') : String(error);
        throw new Error(failures || 'No FX providers available');
      }
    });
    res.set('Cache-Control', 'no-store').json({ ...result.value, cached: result.cached });
  } catch (error) {
    console.warn('[live-markets] FX reference rates unavailable:', error.message);
    res.status(502).json({ message: 'FX reference providers are temporarily unavailable. Please retry shortly.' });
  }
});
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
app.post('/register', registrationLimiter, csrfCheck, async (req, res, next) => {
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
      await pool.execute('INSERT INTO email_verification_tokens (member_id, token_hash, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 24 HOUR))', [insertedId, tokenHash]);      const verifyLink = (process.env.APP_BASE_URL || 'https://monarchcodex.online').replace(/\/+$/, '') + '/verify-email?token=' + token;      await sendAppEmail({ to: email, subject: 'Verify your Monarch Codex email', text: 'Hello ' + fullName + ',\n\nVerify your email address within 24 hours using this link: ' + verifyLink + '\n\nIf you did not create this account, you can ignore this email.' });    })().catch(e => console.error('[mail] Verification email failed:', e.message));
    delete req.session.registrationReferralCode;
    return res.redirect('/verification-pending');
  } catch (e) { next(e); }
});
app.get('/verification-pending', (req, res) => res.send(page('Verify your email', '<h1>Check your inbox</h1><p class="muted">We sent a verification link to the email address you used to register. Open it within 24 hours before logging in.</p><a class="btn" href="/resend-verification">Resend verification email</a><div class="links"><a href="/login">Back to login</a></div>')));
app.get('/resend-verification', (req, res) => res.send(page('Resend verification', '<h1>Resend verification email</h1><p class="muted">Enter the email address you used to register.</p><form method="post" action="/resend-verification">' + csrfField(req) + '<label for="email">Email address</label><input id="email" name="email" type="email" maxlength="254" required><button class="btn" type="submit">Send verification link</button></form><div class="links"><a href="/login">Back to login</a></div>')));
app.post('/resend-verification', resetNetworkLimiter, resetLimiter, csrfCheck, async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    let resultTitle = 'Check your inbox';
    let resultBody = 'If an unverified account exists for that email, a fresh verification link will be sent shortly. Check your inbox and spam folder.';
    if (validEmail(email)) {
      const [members] = await pool.execute('SELECT id, full_name, email, email_verified_at FROM members WHERE email = ? LIMIT 1', [email]);
      if (members.length && members[0].email_verified_at) {
        resultTitle = 'Your email is already verified';
        resultBody = 'Great news — this email address is already verified. You can sign in to Monarch Codex now.';
      } else if (members.length) {
        if (!mailConfigured()) {
          console.error('[mail] Cannot resend verification: SMTP_HOST, SMTP_USER or SMTP_PASSWORD is missing.');
          return res.status(503).send(page('Email service unavailable', '<h1>We could not send your link yet</h1><p class="muted">The email service is temporarily unavailable. Please try again later or contact support. Your account has not been removed.</p><a class="btn" href="/login">Back to login</a>'));
        }
        const member = members[0], token = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        await pool.execute('UPDATE email_verification_tokens SET verified_at = NOW() WHERE member_id = ? AND verified_at IS NULL', [member.id]);
        await pool.execute('INSERT INTO email_verification_tokens (member_id, token_hash, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 24 HOUR))', [member.id, tokenHash]);
        const verifyLink = (process.env.APP_BASE_URL || 'https://monarchcodex.online').replace(/\/+$/, '') + '/verify-email?token=' + token;
        const safeName = esc(member.full_name || 'Monarch');
        const html = '<div style="margin:0;padding:36px 16px;background:#08090b;color:#f8f5eb;font-family:Arial,Helvetica,sans-serif"><div style="max-width:560px;margin:0 auto;border:1px solid #5d4a17;border-radius:22px;overflow:hidden;background:#111216"><div style="padding:30px 28px;text-align:center;background:linear-gradient(135deg,#211b0b,#111216)"><img src="' + 'https://monarchcodex.online/assets/images/monarch-codex-logo.svg' + '" alt="Monarch Codex" width="180" style="display:block;width:180px;max-width:70%;height:auto;margin:0 auto 18px;border:0;outline:none;text-decoration:none"><div style="font-size:42px;margin:18px 0 8px">✉️</div><h1 style="margin:0;font-size:27px;line-height:1.25">Your kingdom is one step away</h1><p style="color:#d7d0bd;margin:14px 0 0">Confirm your email to activate your member access.</p></div><div style="padding:28px"><p style="font-size:16px">Hello ' + safeName + ',</p><p style="color:#d4d1c7;line-height:1.8">Here is your fresh verification link. For your security, it expires in <strong style="color:#f3cf3c">24 hours</strong> and can only be used once.</p><div style="text-align:center;margin:30px 0"><a href="' + esc(verifyLink) + '" style="display:inline-block;padding:15px 25px;border-radius:12px;background:#f3cf3c;color:#17130a;text-decoration:none;font-weight:bold">Verify my email →</a></div><p style="font-size:13px;color:#aaa7a0;line-height:1.7">If the button does not open, copy this link into your browser:<br><a style="color:#f3cf3c;word-break:break-all" href="' + esc(verifyLink) + '">' + esc(verifyLink) + '</a></p><p style="font-size:13px;color:#aaa7a0">If you did not create this account, you can safely ignore this message.</p></div><div style="padding:18px 28px;border-top:1px solid #302a1a;color:#888477;font-size:12px;text-align:center">BUILD WEALTH. BUILD A KINGDOM. · Monarch Codex</div></div></div>';
        const sent = await sendAppEmail({ to: member.email, subject: 'Your fresh Monarch Codex email verification link', text: 'Hello ' + member.full_name + ',\n\nUse this link to verify your Monarch Codex email within 24 hours: ' + verifyLink + '\n\nIf you did not create this account, ignore this email.', html });
        if (!sent) return res.status(503).send(page('Email service unavailable', '<h1>We could not send your link yet</h1><p class="muted">The email service is temporarily unavailable. Please try again later or contact support.</p><a class="btn" href="/login">Back to login</a>'));
        resultTitle = 'Verification link sent';
        resultBody = 'A fresh verification link is on its way. Check your inbox and spam folder. The link expires in 24 hours.';
      }
    }
    return res.send(page(resultTitle, '<h1>' + esc(resultTitle) + '</h1><p class="muted">' + esc(resultBody) + '</p><a class="btn" href="/login">Return to login</a>'));
  } catch (e) {
    if (e && e.code === 'ER_NO_SUCH_TABLE' && /email_verification_tokens/.test(String(e.message || ''))) {
      console.error('[mail] Verification token table is missing. Apply migrations/003_email_verification_tokens.sql.');
      return res.status(503).send(page('Verification setup required', '<h1>Email verification needs setup</h1><p class="muted">The verification service has not been fully configured yet. Please contact support while the site administrator completes the database setup.</p><a class="btn" href="/login">Back to login</a>'));
    }
    next(e);
  }
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
    // Remember this verified member in the current browser session so their first login greeting is generic.
    req.session.newlyVerifiedMemberId = Number(rows[0].member_id);
    return req.session.save(saveErr => {
      if (saveErr) return next(saveErr);
      return res.send(page('Email verified', '<h1>Email verified successfully</h1><p class="muted">Your Monarch Codex email address is now verified.</p><a class="btn" href="/login">Log in to your account</a>'));
    });
  } catch (e) { next(e); }
});
app.get('/login', (req, res) => res.send(loginForm(req)));
app.post('/login', loginLimiter, csrfCheck, async (req, res, next) => {
  try {
    const identity = String(req.body.identity || '').trim(), password = String(req.body.password || '');
    const [rows] = await pool.execute('SELECT id, password_hash, email_verified_at FROM members WHERE email = ? OR username = ? LIMIT 1', [identity.toLowerCase(), identity]);
    const member = rows[0];
    const match = member ? await bcrypt.compare(password, member.password_hash) : false;
    if (!member || !match) return res.status(401).send(loginForm(req, 'The email/username or password is incorrect.'));
    if (!member.email_verified_at) return res.status(403).send(loginForm(req, 'Please verify your email using the link we sent you before logging in. If you cannot find it, use the resend verification option below.'));
    const isFirstLoginAfterVerification = Number(req.session.newlyVerifiedMemberId) === Number(member.id);
    req.session.regenerate(err => {
      if (err) return next(err);
      req.session.memberId = member.id; req.session.csrf = crypto.randomBytes(32).toString('hex');
      if (isFirstLoginAfterVerification) req.session.showGenericMonarchWelcome = true;
      pool.execute('SELECT role FROM admin_users WHERE member_id = ? AND is_active = 1 LIMIT 1',[member.id])
        .then(([admins]) => {
          const destination = admins.length ? (admins[0].role === 'sovereign_desk_admin' ? '/sovereign-admin' : '/admin') : '/dashboard';
          req.session.save(saveErr => saveErr ? next(saveErr) : res.redirect('/login-intro?next=' + encodeURIComponent(destination)));
        })
        .catch(next);
    });
  } catch (e) { next(e); }
});


// Post-authentication welcome transition. Only allow known internal destinations.
app.get('/login-intro', async (req, res, next) => {
  if (!req.session.memberId) return res.redirect('/login');
  const requested = String(req.query.next || '/dashboard');
  const destination = ['/dashboard', '/admin', '/sovereign-admin'].includes(requested) ? requested : '/dashboard';
  try {
    const [rows] = await pool.execute('SELECT full_name FROM members WHERE id = ? LIMIT 1', [req.session.memberId]);
    if (!rows.length) {
      return req.session.destroy(() => res.redirect('/login'));
    }
    const showGenericWelcome = req.session.showGenericMonarchWelcome === true;
    delete req.session.showGenericMonarchWelcome;
    const firstName = String(rows[0].full_name || '').trim().split(/\s+/)[0] || 'Monarch';
    const welcomeText = showGenericWelcome ? 'Welcome Monarch' : 'Welcome back, ' + firstName + '.';
    const safeName = esc(showGenericWelcome ? 'Monarch' : firstName);
    const safeDestination = esc(destination);
    const letters = 'MONARCH CODEX'.split('').map((letter, index) =>
      '<span class="brand-letter" style="--letter-index:' + index + '">' + (letter === ' ' ? '&nbsp;' : letter) + '</span>'
    ).join('');
    const body = '<main class="brand-intro" aria-label="Monarch Codex welcome">' +
      '<section class="intro-lockup">' +
      '<div class="intro-topline"><img class="intro-logo" src="/assets/images/monarch-codex-logo.svg?v=2" alt="Monarch Codex company logo">' +
      '<div class="intro-divider" aria-hidden="true"></div>' +
      '<div class="intro-wordmark">' + letters + '</div></div>' +
      '<p class="intro-tagline" id="introTagline" aria-label="Build Wealth. Build a Kingdom."></p>' +
      '<div class="intro-welcome"><h1 id="introWelcome" aria-label="' + esc(welcomeText) + '"></h1></div>' +
      '</section></main>' +
      '<style>@import url("https://fonts.googleapis.com/css2?family=Baloo+2:wght@700;800&display=swap");.wrap{width:100%;max-width:none;margin:0;padding:0}.brand-intro{min-height:100svh;width:100%;display:grid;place-items:center;overflow:hidden;padding:24px;background:#050505;color:#f7f5ef}.intro-lockup{width:min(100%,900px);text-align:center}.intro-topline{display:flex;align-items:center;justify-content:center;gap:clamp(18px,4vw,42px);margin:0 auto}.intro-logo{display:block;height:auto;width:clamp(74px,17vw,142px);flex:0 0 auto;opacity:0;transform:translateX(130px);animation:logo-arrive 1.05s cubic-bezier(.16,1,.3,1) .18s forwards}.intro-logo{filter:drop-shadow(0 0 22px #d6a52a20)}.intro-divider{height:clamp(72px,15vw,126px);width:1px;flex:0 0 1px;background:linear-gradient(180deg,transparent,#e6bf51 20%,#e6bf51 80%,transparent);transform:scaleY(0);transform-origin:center;animation:line-reveal .45s ease 1.05s forwards}.intro-wordmark{display:flex;align-items:center;justify-content:flex-start;white-space:pre;font-family:"Baloo 2","Arial Rounded MT Bold",Arial,sans-serif;font-size:clamp(1.2rem,4.6vw,3.2rem);font-weight:800;letter-spacing:.025em;line-height:1.1}.brand-letter{display:inline-block;opacity:0;transform:translateY(12px);animation:letter-arrive .28s ease-out calc(1.12s + var(--letter-index)*.105s) forwards}.intro-tagline{min-height:1.5em;margin:clamp(25px,5vw,36px) 0 0;color:#c9a84a;font-size:clamp(.62rem,2vw,.9rem);font-weight:700;letter-spacing:clamp(.08em,.9vw,.22em);line-height:1.5;overflow-wrap:anywhere}.intro-welcome{min-height:1.5em;margin-top:clamp(18px,3.5vw,28px)}.intro-welcome h1{margin:0;font-size:clamp(1.25rem,4.8vw,2.2rem);font-weight:500;letter-spacing:-.025em;line-height:1.35;overflow-wrap:anywhere}.type-cursor:after{content:"";display:inline-block;height:.9em;border-right:1px solid #e6bf51;margin-left:3px;vertical-align:-.08em;animation:cursor-blink .7s steps(1,end) infinite}@keyframes logo-arrive{to{opacity:1;transform:translateX(0)}}@keyframes line-reveal{to{transform:scaleY(1)}}@keyframes letter-arrive{to{opacity:1;transform:translateY(0)}}@keyframes cursor-blink{50%{opacity:0}}@media(max-width:520px){.intro-topline{gap:12px}.intro-logo{width:clamp(52px,15vw,72px)}.intro-wordmark{font-size:clamp(.95rem,4vw,1.25rem);letter-spacing:0}.intro-divider{height:66px}.intro-tagline{letter-spacing:.08em}}@media(prefers-reduced-motion:reduce){.intro-logo,.intro-divider,.brand-letter{animation:none;opacity:1;transform:none}.type-cursor:after{animation:none}}</style>' +
      '<script>(function(){var target=' + JSON.stringify(destination) + ';var lines=[{id:"introTagline",text:"BUILD WEALTH. BUILD A KINGDOM."},{id:"introWelcome",text:' + JSON.stringify(welcomeText) + '}];function run(){var delay=24,start=1250;lines.forEach(function(line){var el=document.getElementById(line.id);if(!el)return;el.textContent="";el.classList.add("type-cursor");var i=0;function type(){if(i<line.text.length){el.textContent+=line.text.charAt(i++);window.setTimeout(type,delay);}else{el.classList.remove("type-cursor");}}window.setTimeout(type,start);start+=line.text.length*delay+180;});}if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",run,{once:true});}else{run();}window.setTimeout(function(){window.location.replace(target);},4500);window.setTimeout(function(){if(document.visibilityState==="visible"&&location.pathname==="/login-intro"){location.href=target;}},4900);})();</script>';
    res.set('Cache-Control', 'no-store');
    return res.send(page(showGenericWelcome ? 'Welcome Monarch' : 'Welcome back, Monarch', body));
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

app.get('/admin/profile', requireAdmin, async (req,res,next)=>{
  try {
    const [[admin]] = await pool.query(
      'SELECT m.id,m.full_name,m.username,m.email,m.monarch_uid,au.role,mp.avatar_key,mp.phone_number FROM admin_users au JOIN members m ON m.id=au.member_id LEFT JOIN member_profiles mp ON mp.member_id=m.id WHERE au.member_id=? AND au.is_active=1 LIMIT 1',
      [req.session.memberId]
    );
    if(!admin) return res.status(404).send(page('Admin profile unavailable','<h1>Admin profile unavailable</h1><p>Contact the system owner.</p>'));
    const photo=admin.avatar_key && /^[a-f0-9]{48}\.(jpg|png|webp)$/.test(String(admin.avatar_key))?'/member-avatar/'+encodeURIComponent(admin.avatar_key):'/assets/images/monarch-codex-logo.svg';
    const content='<section class="ac-panel"><style>.admin-profile-hero{display:flex;align-items:center;gap:18px;padding:clamp(16px,3vw,24px);margin:18px 0;border:1px solid #4b4026;border-radius:18px;background:radial-gradient(ellipse at top right,rgba(223,189,98,.13),transparent 60%),linear-gradient(145deg,#1a1917,#111113)}.admin-profile-photo{width:88px;height:88px;flex:0 0 88px;object-fit:cover;border-radius:50%;border:3px solid #dfbd62}.admin-profile-name{min-width:0}.admin-profile-name h3{margin:0 0 6px;font-size:clamp(18px,3vw,24px);line-height:1.25;overflow-wrap:anywhere}.admin-profile-name p{margin:0 0 10px}.admin-profile-details{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.4fr);gap:0;margin:20px 0;border:1px solid #302d26;border-radius:14px;overflow:hidden}.admin-profile-details dt,.admin-profile-details dd{margin:0;padding:13px 15px;border-bottom:1px solid #302d26;overflow-wrap:anywhere}.admin-profile-details dt{background:#171613;color:#bdb39b;font-size:12px}.admin-profile-details dd{color:#f0eadc;font-size:13px}.admin-profile-details dt:nth-last-of-type(1),.admin-profile-details dd:last-child{border-bottom:0}.admin-profile-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px}@media(max-width:520px){.admin-profile-hero{align-items:flex-start}.admin-profile-photo{width:72px;height:72px;flex-basis:72px}.admin-profile-details{grid-template-columns:1fr}.admin-profile-details dt{padding-bottom:5px;border-bottom:0}.admin-profile-details dd{padding-top:5px}}</style><div class="ac-page-head"><div><h2>Administrator profile</h2><p class="muted">Your secure administrator identity and account details.</p></div><span class="ac-pill">'+esc(String(admin.role||'admin').replace(/_/g,' '))+'</span></div><div class="admin-profile-hero"><img class="admin-profile-photo" src="'+photo+'" alt="Administrator profile photo"><div class="admin-profile-name"><h3>'+esc(admin.full_name||'Administrator')+'</h3><p class="muted">@'+esc(admin.username||'')+'</p><span class="ac-readiness-tag is-ready">Verified administrator role</span></div></div><dl class="admin-profile-details"><dt>Email address</dt><dd>'+esc(admin.email||'—')+'</dd><dt>Administrator role</dt><dd>'+esc(String(admin.role||'admin').replace(/_/g,' '))+'</dd><dt>Monarch account ID</dt><dd>'+esc(admin.monarch_uid||'—')+'</dd></dl><p class="muted">Keep your administrator sign-in details private. Update your profile picture through the secure profile editor.</p><div class="admin-profile-actions"><a class="btn" href="/admin/profile/photo">Update profile photo</a><a class="copy-btn" href="/profile" style="text-decoration:none">Open profile editor</a></div></section>';
    res.send(adminControlPage('My admin profile','/admin/profile',content+(req.query.photo==='success'?photoSuccessCelebration('/admin/profile'):''),req));
  } catch(e){next(e);}
});

function adminControlPage(title, active, content, req) {
  const deskOnly = req.adminRole === 'sovereign_desk_admin' || String(active || '').startsWith('/sovereign-admin');
  const groups = deskOnly ? [
    {label:'Workspace',links:[['/sovereign-admin','Desk overview','◫']]},
    {label:'Trading desk',links:[['/sovereign-admin/signals','Trading signals','↗'],['/sovereign-admin/guidance','Guidance & learning','✦'],['/sovereign-admin/roles/request','Founder Partner request','♜'],['/market-movers.html','Live Markets','⌁']]},
    {label:'Members & communication',links:[['/sovereign-admin/access','Access requests','♙'],['/sovereign-admin/signal-access','Subscriptions & signal access','◆'],['/sovereign-admin/chat','Member conversations','◉'],['/community','Community feed','◉'],['/sovereign-admin/announcements','Announcements','▤'],['/sovereign-admin/events','Homepage events','◷'],['/sovereign-admin/watchlist','Weekly trade watchlist','▦']]},
    {label:'Governance',links:[['/sovereign-admin/governance','Governance & concerns','⚖'],['/sovereign-admin/activity','Activity log','◷']]},
    {label:'Your account',links:[['/admin/profile','My admin profile','◎']]}
  ] : [
    {label:'Overview',links:[['/admin','Dashboard overview','◫']]},
    {label:'Financial operations',links:[['/admin/transactions','Transactions','◷'],['/admin/deposits','Deposits','↓'],['/admin/withdrawals','Withdrawals','↑']]},
    {label:'Investments & balances',links:[['/admin/investments','Investments','◆'],['/admin/earnings','Profits & bonuses','✦'],['/admin/balances','Balance management','＋']]},
    {label:'Trading workspace',links:[['/admin/sovereign-desk','Sovereign Desk','⌁'],['/market-movers.html','Live Markets','↗']]},
    {label:'Members & verification',links:[['/admin/members','Member management','♙'],['/admin/roles','Member roles','♧'],['/admin/kyc','KYC review','◇'],['/admin/cooperative-connections','Online Cooperative','♙'],['/admin/monarchs','Homepage profiles','✦']]},
    {label:'Community & platform links',links:[['/community','Community feed','◉'],['/admin/community-moderation','Community moderation','◉'],['/admin/feedback','Member feedback','✎'],['/admin/social-links','Official social links','↗']]},
    {label:'Growth & learning',links:[['/admin/referrals','Referrals','⇄'],['/admin/academy','Academy','▣'],['/admin/tools','Tools & resources','⚒']]},
    {label:'Notifications & security',links:[['/admin/notifications','Notifications','♧'],['/admin/audit','Audit & access','▤'],['/admin/settings','Platform settings','⚙']]},
    {label:'Account',links:[['/admin/profile','My admin profile','◎']]}
  ];
  const nav = groups.map(group => '<div class="ac-nav-group"><div class="ac-nav-group-label">'+esc(group.label)+'</div>'+group.links.map(([url,label,icon]) => '<a class="ac-nav '+((active===url || (url !== '/admin' && active.startsWith(url+'/')))?'is-active':'')+'" href="'+url+'"'+((active===url || (url !== '/admin' && active.startsWith(url+'/')))?' aria-current="page"':'')+'><span class="ac-nav-icon" aria-hidden="true">'+icon+'</span><b>'+label+'</b>'+(url==='/admin/deposits'?'<span class="ac-nav-badge" data-pending-deposit-count hidden aria-label="Pending deposits">0</span>':'')+'<span class="ac-nav-arrow" aria-hidden="true">↗</span></a>').join('')+'</div>').join('');
  const role = esc((req.adminRole || 'admin').replace(/_/g,' ').toUpperCase());
  const subtitle = deskOnly ? 'Signals, guidance, membership access and workspace activity.' : 'Platform operations, member access, compliance and financial oversight.';
  return page(title, `<style>
  .ac-layout{--ac-gold:#e5c46a;display:grid;grid-template-columns:252px minmax(0,1fr);gap:22px;align-items:start;width:100%;max-width:1600px;margin:0 auto;color:#eee9dc}
  .ac-side{position:sticky;top:14px;max-height:calc(100dvh - 28px);overflow-y:auto;overscroll-behavior:contain;padding:15px 12px;border:1px solid #373226;border-radius:22px;background:radial-gradient(ellipse at 0 0,rgba(223,189,98,.09),transparent 35%),linear-gradient(180deg,#171719,#0c0c0e 85%);box-shadow:0 18px 48px #0003;scrollbar-width:thin;scrollbar-color:#8a7135 #111113;-webkit-overflow-scrolling:touch}
  .ac-brand{display:flex;align-items:center;gap:11px;padding:8px 8px 19px;border-bottom:1px solid #302d25;color:#f4d77d;font-size:.78rem;font-weight:950;letter-spacing:.12em;line-height:1.45}
  .ac-brand-mark{display:grid;place-items:center;flex:0 0 39px;height:39px;border:1px solid #6c592b;border-radius:13px;background:linear-gradient(145deg,#302713,#17140d);color:#f3d47a;font-size:1.15rem}
  .ac-brand small{display:block;margin-top:4px;color:#8d897e;font-size:.59rem;letter-spacing:.14em;font-weight:800}
  .ac-side-desk{border-color:#5d4a24;background:radial-gradient(ellipse at 0 0,rgba(223,189,98,.16),transparent 42%),linear-gradient(180deg,#17150f,#0c0c0e 85%)}
  .ac-side-desk .ac-brand{border-bottom-color:#514322;color:#f8df91}
  .ac-desk-intro{display:flex;align-items:center;gap:11px;margin:15px 1px 12px;padding:13px 11px;border:1px solid #6d592d;border-radius:14px;background:linear-gradient(125deg,#3b2d12,#1b180f 78%);box-shadow:inset 0 1px #f4d77d12}
  .ac-desk-orbit{display:grid;place-items:center;flex:0 0 35px;height:35px;border:1px solid #8d7134;border-radius:11px;background:#e5c46a13;color:#f3d47a;font-size:1.25rem}
  .ac-desk-intro strong{display:block;color:#f4d77d;font-size:.69rem;letter-spacing:.12em}
  .ac-desk-intro small{display:block;margin-top:4px;color:#a7a08c;font-size:.63rem;line-height:1.45}
  .ac-side-desk .ac-nav-group{margin-top:10px}
  .ac-side-desk .ac-nav-group-label{color:#b19b5d}
  .ac-side-desk .ac-nav{min-height:43px}
  .ac-side-desk .ac-nav.is-active{border-color:#9a7936;background:linear-gradient(100deg,#e5c46a35,#e5c46a0d);box-shadow:inset 3px 0 0 #f0d078,0 4px 16px #0002}
  .ac-side-desk .ac-nav b{font-size:.8rem}
  .ac-side-search{position:relative;margin:15px 2px 9px}.ac-side-search:before{content:'⌕';position:absolute;left:12px;top:7px;color:#a89b70;font-size:1.2rem;pointer-events:none}
  .ac-side-search input{box-sizing:border-box;width:100%;min-height:39px;padding:10px 12px 10px 34px;border:1px solid #343127;border-radius:11px;background:#101012;color:#eee9dc;font:inherit;font-size:.76rem;outline:none}
  .ac-side-search input:focus-visible{border-color:#c8a84e;box-shadow:0 0 0 3px #e5c46a1a}.ac-side-search-note{margin:0 4px 12px;color:#6f6c63;font-size:.65rem;line-height:1.5}
  .ac-nav-group{margin:14px 0 0}.ac-nav-group-label{padding:5px 9px 7px;color:#77746b;font-size:.61rem;font-weight:900;letter-spacing:.14em;text-transform:uppercase}
  .ac-nav{display:flex;align-items:center;gap:10px;min-height:40px;margin:3px 0;padding:9px 10px;border:1px solid transparent;border-radius:11px;color:#b8b4a8;text-decoration:none;transition:background .16s ease,border-color .16s ease,color .16s ease}
  .ac-nav-icon{display:grid;place-items:center;flex:0 0 27px;height:27px;border:1px solid #302d25;border-radius:8px;background:#171719;color:#b8a66a;font-size:.95rem}
  .ac-nav b{flex:1;min-width:0;font-size:.78rem;font-weight:700;line-height:1.3}.ac-nav-badge{display:inline-flex;align-items:center;justify-content:center;min-width:23px;height:23px;padding:0 7px;border:1px solid #a9473d;border-radius:999px;background:#7d251f;color:#fff3ee;font-size:.68rem;font-weight:950;line-height:1;box-shadow:0 0 0 3px #7d251f18}.ac-nav-badge[hidden]{display:none!important}.ac-nav-arrow{opacity:0;color:#d7bb63;font-size:.8rem;transition:opacity .16s ease,transform .16s ease}
  .ac-nav:hover,.ac-nav:focus-visible{border-color:#4b4023;background:#211d13;color:#f0d783;outline:none}.ac-nav:hover .ac-nav-arrow,.ac-nav:focus-visible .ac-nav-arrow{opacity:1;transform:translate(1px,-1px)}
  .ac-nav.is-active{border-color:#6d592d;background:linear-gradient(100deg,#e5c46a26,#e5c46a0b);color:#f4d77d;box-shadow:inset 3px 0 0 #dfbd62}.ac-nav.is-active .ac-nav-icon{border-color:#6d592d;background:#282113;color:#f5dc8c}.ac-nav.is-active .ac-nav-arrow{opacity:1}
  .ac-nav-group[hidden],.ac-nav[hidden]{display:none!important}
  .ac-secure{margin-top:18px;padding:13px;border:1px solid #302d25;border-radius:13px;background:#e5c46a09;color:#9c988d;font-size:.69rem;line-height:1.65}
  .ac-secure-title{display:flex;align-items:center;gap:7px;margin-bottom:5px;color:#e5c46a;font-size:.72rem;font-weight:850}.ac-secure-dot{width:6px;height:6px;border-radius:50%;background:#78b88b;box-shadow:0 0 0 4px #78b88b17}
  .ac-logout{width:100%;min-height:42px;margin-top:12px!important;border:1px solid #48402d!important;border-radius:11px!important;background:#171614!important;color:#d7cba9!important;font-size:.77rem!important;font-weight:800!important}
  .ac-main{min-width:0;padding:0 2px 32px}.ac-top{display:flex;justify-content:space-between;align-items:flex-start;gap:18px;flex-wrap:wrap;margin:2px 0 22px;padding:7px 0 22px;border-bottom:1px solid #302d25}
  .ac-top-copy{min-width:0;flex:1}.ac-breadcrumb{display:flex;align-items:center;gap:8px;margin:0 0 10px;color:#817d72;font-size:.66rem;font-weight:800;letter-spacing:.12em;text-transform:uppercase}.ac-breadcrumb span:last-child{color:#d3b95f}
  .ac-kicker{display:inline-flex;align-items:center;gap:8px;color:#e5c46a;font-size:.67rem;font-weight:900;letter-spacing:.16em;text-transform:uppercase}.ac-kicker:before{content:'';width:20px;height:1px;background:#b99b47}
  .ac-top h1{margin:9px 0 7px;color:#fff7e5;font-size:clamp(1.8rem,3.2vw,2.65rem);font-weight:850;letter-spacing:-.045em;line-height:1.08;overflow-wrap:anywhere}.ac-top .muted{max-width:62ch;margin:0;color:#9d998d;font-size:.82rem;line-height:1.7}
  .ac-top-meta{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.ac-pill{display:inline-flex;align-items:center;gap:8px;max-width:100%;padding:10px 13px;border:1px solid #e5c46a40;border-radius:999px;background:#e5c46a10;color:#e8d18a;font-size:.65rem;font-weight:900;letter-spacing:.07em;line-height:1.4}.ac-pill-dot{width:6px;height:6px;flex:0 0 auto;border-radius:50%;background:#8bc79b;box-shadow:0 0 0 4px #8bc79b14}
  .ac-mobilebar,.ac-drawer-scrim{display:none}.ac-main .ac-page-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap}.ac-main .ac-page-head .ac-pill{white-space:nowrap}
  .ac-main .ac-panel p,.ac-main .ac-panel label,.ac-main .ac-panel small,.ac-main .ac-panel td,.ac-main .ac-panel dd{font-weight:400;line-height:1.65}.ac-main .ac-panel strong{font-weight:600}.ac-main .ac-panel label{color:#d7d0c0;font-weight:600}.ac-main .ac-panel h2,.ac-main .ac-panel h3{font-weight:750;letter-spacing:-.015em}.ac-main .ac-panel th{font-weight:650;color:#e8d8a5}.ac-main .ac-panel input,.ac-main .ac-panel textarea,.ac-main .ac-panel select{font-weight:400}.ac-main .ac-panel button,.ac-main .ac-panel .btn{font-weight:600}\n  .ac-main h2,.ac-main h3{color:#f4eddd;letter-spacing:-.025em}.ac-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
  .ac-stat,.ac-panel{min-width:0;border:1px solid #353126;border-radius:17px;background:linear-gradient(145deg,#19191a,#111113 78%);box-shadow:0 10px 30px #0002}
  .ac-stat{position:relative;overflow:hidden;padding:18px;min-height:128px}.ac-stat:after{content:'';position:absolute;right:-28px;top:-37px;width:88px;height:88px;border:1px solid #e5c46a17;border-radius:50%;box-shadow:0 0 0 12px #e5c46a05}
  .ac-stat span{display:flex;align-items:center;gap:8px;color:#b3aea1;font-size:.72rem;font-weight:750;line-height:1.4}.ac-stat span:before{content:'';width:6px;height:6px;flex:0 0 auto;border-radius:2px;background:#cbb05a}
  .ac-stat strong{position:relative;z-index:1;display:block;margin:14px 0 8px;color:#f3d984;font-size:clamp(1.55rem,2.6vw,2.15rem);font-weight:900;letter-spacing:-.045em;line-height:1.1;overflow-wrap:anywhere}.ac-stat small{display:block;color:#89857b;font-size:.69rem;line-height:1.5}
  .ac-panel{margin-top:17px;padding:clamp(17px,2.3vw,25px)}.ac-panel>h2,.ac-panel>h3{margin:0 0 12px;font-size:1.12rem}.ac-panel>p{max-width:76ch;color:#aaa69b;font-size:.8rem;line-height:1.75}.ac-panel p.muted{color:#9d998d}
  .ac-panel form label{display:block;margin:14px 0 7px;color:#d0c8b5;font-size:.77rem;font-weight:750;line-height:1.5}
  .ac-panel input:not([type=checkbox]):not([type=radio]):not([type=hidden]),.ac-panel select,.ac-panel textarea{display:block;box-sizing:border-box;width:100%;max-width:100%;min-height:44px;margin:0 0 10px;padding:11px 13px;border:1px solid #403a2d;border-radius:10px;background:#0d0d0f;color:#f4efe3;font:inherit;font-size:.8rem;outline:none}
  .ac-panel input:focus-visible,.ac-panel select:focus-visible,.ac-panel textarea:focus-visible{border-color:#d4b755;box-shadow:0 0 0 3px #e5c46a1c}.ac-panel textarea{min-height:100px;resize:vertical}.ac-panel input[type=checkbox],.ac-panel input[type=radio]{accent-color:#d7b957}
  .ac-panel details{margin-top:12px;padding:13px;border:1px solid #302d25;border-radius:11px;background:#111113}.ac-panel summary{cursor:pointer;color:#e3ca79;font-weight:750;line-height:1.5}.ac-panel form .copy-btn,.ac-panel form .btn{margin:7px 8px 0 0;min-height:40px}.ac-panel .btn,.ac-panel button.btn{border-radius:10px;font-weight:800}
  .ac-alert{margin:14px 0;padding:14px 16px;border:1px solid #655221;border-radius:12px;background:#241e0e;color:#e7ddb4;font-size:.79rem;line-height:1.7}
  .ac-coming{display:flex;align-items:flex-start;gap:12px;margin-top:12px;padding:16px;border:1px solid #373328;border-radius:14px;background:#151517}.ac-coming strong{display:block;color:#e5c46a}.ac-coming p{margin:5px 0 0;color:#aaa69b}
  .ac-table-wrap{max-width:100%;overflow:auto;border:1px solid #302d25;border-radius:13px;background:#111113;scrollbar-width:thin;scrollbar-color:#50452a transparent}.ac-table{width:100%;min-width:680px;border-collapse:separate;border-spacing:0}
  .ac-table th,.ac-table td{padding:13px 14px;border-bottom:1px solid #2d2a23;text-align:left;line-height:1.55;vertical-align:top;overflow-wrap:anywhere}.ac-table th{position:sticky;top:0;background:#19191a;color:#aaa598;font-size:.65rem;font-weight:900;letter-spacing:.09em;text-transform:uppercase;white-space:nowrap}.ac-table td{color:#ddd6c7;font-size:.77rem}.ac-table td small{color:#938f84;font-size:.7rem}.ac-table tbody tr:last-child td{border-bottom:0}.ac-table tbody tr:hover td{background:#e5c46a08}
  .ac-tiles{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.ac-tile{position:relative;display:flex;flex-direction:column;justify-content:space-between;gap:14px;min-width:0;min-height:132px;padding:18px;border:1px solid #373328;border-radius:15px;background:linear-gradient(145deg,#19191a,#111113);text-decoration:none;color:#f5f0e4;transition:transform .16s ease,border-color .16s ease,background .16s ease}
  .ac-tile:before{content:'↗';display:grid;place-items:center;align-self:flex-start;width:30px;height:30px;border:1px solid #e5c46a33;border-radius:9px;background:#e5c46a10;color:#e5c46a;font-size:.9rem}.ac-tile:focus-visible,.ac-nav:focus-visible{outline:2px solid #f3cf3c;outline-offset:3px}.ac-tile:hover{transform:translateY(-2px);border-color:#8e7534;background:linear-gradient(145deg,#211e16,#141416)}
  .ac-tile strong{display:block;color:#f0d47c;font-size:.86rem;line-height:1.45}.ac-tile small{display:block;margin-top:6px;color:#9e9a8e;font-size:.72rem;line-height:1.65}
  .ac-section-head{display:flex;justify-content:space-between;align-items:flex-end;gap:14px;flex-wrap:wrap;margin:24px 0 13px}.ac-section-head h2{margin:0;color:#f4eddd;font-size:1.1rem}.ac-section-head p{margin:5px 0 0;color:#969185;font-size:.76rem;line-height:1.6}
  .ac-overview-hero{position:relative;isolation:isolate;overflow:hidden;display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:20px;margin-bottom:15px;padding:clamp(20px,3vw,30px);border:1px solid #e5c46a45;border-radius:20px;background:radial-gradient(ellipse at 93% 0,#e5c46a29,transparent 38%),linear-gradient(125deg,#1b1a16,#111113 68%,#1b170e)}
  .ac-overview-hero:after{content:'';position:absolute;z-index:-1;right:-70px;bottom:-125px;width:200px;height:200px;border:1px solid #e5c46a21;border-radius:50%;box-shadow:0 0 0 22px #e5c46a06,0 0 0 44px #e5c46a05}.ac-overview-hero .ac-hero-kicker{margin:0 0 9px;color:#e5c46a;font-size:.66rem;font-weight:900;letter-spacing:.17em;text-transform:uppercase}
  .ac-overview-hero h2{margin:0;color:#fff5dc;font-size:clamp(1.35rem,2.7vw,2rem);letter-spacing:-.04em;line-height:1.15}.ac-overview-hero p{max-width:58ch;margin:10px 0 0;color:#b5b0a3;font-size:.78rem;line-height:1.75}
  .ac-hero-mark{display:grid;place-items:center;width:66px;height:66px;border:1px solid #e5c46a47;border-radius:20px;background:#e5c46a12;color:#f2d57c;font-size:1.8rem}
  .ac-readiness-list{display:grid;gap:0;margin-top:14px}.ac-readiness-row{display:flex;align-items:flex-start;gap:12px;padding:13px 0;border-bottom:1px solid #2b2923}.ac-readiness-row:last-child{border-bottom:0;padding-bottom:0}
  .ac-readiness-icon{display:grid;place-items:center;flex:0 0 32px;height:32px;border:1px solid #3c3524;border-radius:10px;background:#1b1811;color:#e5c46a}.ac-readiness-row strong{display:block;color:#e9e2d2;font-size:.79rem}.ac-readiness-row p{margin:4px 0 0;color:#999488;font-size:.72rem;line-height:1.6}
  .ac-readiness-tag{display:inline-flex;align-items:center;gap:6px;flex:0 0 auto;margin-left:auto;padding:6px 8px;border:1px solid #3d3728;border-radius:999px;color:#d9c786;background:#1a1812;font-size:.6rem;font-weight:850;white-space:nowrap}.ac-readiness-tag:before{content:'';width:5px;height:5px;border-radius:50%;background:#d0ae4d}.ac-readiness-tag.is-ready{border-color:#2d4938;background:#121e17;color:#a9d9b3}.ac-readiness-tag.is-ready:before{background:#65b87b}
  @media(max-width:1180px){.ac-layout{grid-template-columns:224px minmax(0,1fr);gap:16px}.ac-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.ac-tiles{grid-template-columns:repeat(2,minmax(0,1fr))}.ac-side{padding:13px 10px}}
  @media(max-width:820px){.ac-layout{display:block;width:100%}.ac-mobilebar{display:flex;align-items:center;gap:12px;margin:0 0 14px;padding:11px 13px;border:1px solid #373226;border-radius:15px;background:linear-gradient(110deg,#191815,#111113)}.ac-menu-toggle{display:inline-grid;place-items:center;flex:0 0 41px;width:41px;height:41px;border:1px solid #5b4c20;border-radius:11px;background:#292411;color:#f3cf3c;font-size:1.35rem;cursor:pointer}.ac-mobile-title{color:#f3d77e;font-size:.72rem;font-weight:900;letter-spacing:.09em}.ac-drawer-scrim{position:fixed;inset:0;z-index:1000;display:none;width:100%;height:100%;padding:0;border:0;background:#000b;backdrop-filter:blur(3px)}.ac-layout.ac-menu-open .ac-drawer-scrim{display:block}.ac-side{position:fixed;z-index:1001;left:0;top:0;bottom:0;width:min(86vw,320px);max-height:100dvh;overflow-y:auto;transform:translateX(-105%);transition:transform .22s ease;border-radius:0 20px 20px 0;padding:17px 13px;box-shadow:18px 0 45px #0006}.ac-layout.ac-menu-open .ac-side{transform:translateX(0)}.ac-main{padding:0 0 26px}.ac-top{margin:3px 0 18px;padding-bottom:17px}.ac-top h1{font-size:clamp(1.7rem,5vw,2.25rem)}.ac-stats{gap:10px}.ac-stat{min-height:114px;padding:15px}.ac-panel{margin-top:13px}.ac-tiles{gap:10px}.ac-tile{min-height:115px;padding:15px}.ac-overview-hero{padding:21px}.ac-hero-mark{width:54px;height:54px;border-radius:16px;font-size:1.45rem}}
  @media(max-width:520px){.ac-top{gap:12px}.ac-top-meta{width:100%}.ac-pill{font-size:.59rem}.ac-stats{gap:8px}.ac-stat{min-height:106px;padding:12px;border-radius:14px}.ac-stat span{font-size:.66rem}.ac-stat strong{margin:11px 0 7px;font-size:1.5rem}.ac-stat small{font-size:.64rem}.ac-panel{padding:15px;border-radius:15px}.ac-tiles{grid-template-columns:1fr}.ac-tile{min-height:0;padding:15px}.ac-overview-hero{grid-template-columns:minmax(0,1fr);gap:14px;padding:19px}.ac-hero-mark{display:none}.ac-section-head{margin-top:19px}.ac-readiness-row{gap:9px}.ac-readiness-icon{flex-basis:29px;height:29px}.ac-readiness-tag{font-size:.55rem;padding:5px 6px}.ac-table{min-width:640px}}
  /* Admin workspace polish: consistent spacing, clearer actions and more readable financial tables */
  .ac-main .ac-page-head{padding:clamp(17px,2.5vw,25px);margin:0 0 16px;border:1px solid #42391f;border-radius:17px;background:radial-gradient(ellipse at 100% 0,#e5c46a12,transparent 45%),linear-gradient(135deg,#191916,#111113)}
  .ac-main .ac-page-head h2{margin:0 0 8px;font-size:clamp(1.12rem,2vw,1.35rem);letter-spacing:-.025em}
  .ac-main .ac-page-head p{margin:0;max-width:75ch}
  .ac-main .ac-page-head>.ac-pill{align-self:flex-start;text-decoration:none;transition:background .16s ease,border-color .16s ease}
  .ac-main .ac-page-head>.ac-pill:hover{background:#e5c46a1d;border-color:#b99b47}
  .ac-main .ac-panel{padding:clamp(16px,2.1vw,25px);margin-top:17px;border-color:#393526;background:linear-gradient(145deg,#19191b 0%,#111113 75%);box-shadow:0 16px 38px #0003}
  .ac-main .ac-panel>h2{font-size:clamp(1.12rem,2vw,1.35rem);margin-bottom:8px}
  .ac-main .ac-panel>p{max-width:80ch;margin-top:7px;margin-bottom:16px}
  .ac-main .ac-alert{display:flex;align-items:flex-start;gap:11px;padding:15px 17px;border-color:#79632b;background:linear-gradient(110deg,#29210f,#1a180f);box-shadow:inset 3px 0 0 #d8b957}
  .ac-main .ac-alert:before{content:'◆';flex:0 0 auto;margin-top:1px;color:#f3cf3c;font-size:.7rem}
  .ac-main .ac-panel details{margin:14px 0;padding:0;overflow:hidden;border-color:#3b3525;background:#111113}
  .ac-main .ac-panel details>summary{display:flex;align-items:center;gap:10px;min-height:52px;padding:14px 16px;list-style:none;background:linear-gradient(100deg,#211d13,#151517);color:#f0d783}
  .ac-main .ac-panel details>summary::-webkit-details-marker{display:none}
  .ac-main .ac-panel details>summary:after{content:'＋';margin-left:auto;color:#e5c46a;font-size:1rem}
  .ac-main .ac-panel details[open]>summary{border-bottom:1px solid #383121}
  .ac-main .ac-panel details[open]>summary:after{content:'−'}
  .ac-main .ac-panel details>form{padding:16px}
  .ac-main .ac-panel form label{margin:12px 0 6px;font-size:.73rem;color:#d9d0bc}
  .ac-main .ac-panel form input:not([type=checkbox]):not([type=radio]):not([type=hidden]),.ac-main .ac-panel form select,.ac-main .ac-panel form textarea{border-color:#403a2d;background:#0c0c0e;border-radius:11px;transition:border-color .16s ease,box-shadow .16s ease}
  .ac-main .ac-panel form input::placeholder,.ac-main .ac-panel form textarea::placeholder{color:#77746d}
  .ac-main .ac-panel form .btn,.ac-main .ac-panel form .copy-btn{min-height:42px;padding:10px 15px;border-radius:10px;font-size:.76rem;font-weight:850;transition:transform .15s ease,filter .15s ease,background .15s ease}
  .ac-main .ac-panel form .btn:hover,.ac-main .ac-panel form .copy-btn:hover{filter:brightness(1.1);transform:translateY(-1px)}
  .ac-main .ac-panel form .btn:focus-visible,.ac-main .ac-panel form .copy-btn:focus-visible{outline:2px solid #f3cf3c;outline-offset:3px}
  .ac-main .ac-table-wrap{margin-top:15px;border-color:#3a3527;border-radius:15px;background:#101012;box-shadow:0 8px 24px #0002}
  .ac-main .ac-table{min-width:760px}
  .ac-main .ac-table th{padding:14px 15px;background:#1b1a17;color:#b9b09a;border-bottom:1px solid #4a4026}
  .ac-main .ac-table td{padding:15px;color:#e3ddcf;line-height:1.65}
  .ac-main .ac-table td strong{color:#f5edda;font-weight:800}
  .ac-main .ac-table td a{color:#e9ca68;text-decoration:none;text-underline-offset:3px}
  .ac-main .ac-table td a:hover{text-decoration:underline}
  .ac-main .ac-table td .ac-pill{padding:6px 9px;font-size:.61rem;white-space:normal}
  .ac-main .ac-table td form{min-width:150px}
  .ac-main .ac-table td form label{margin-top:0}
  .ac-main .ac-table td form .copy-btn[name=decision][value=approved]{border-color:#31553c;background:#14231a;color:#a8dfb3}
  .ac-main .ac-table td form .copy-btn[name=decision][value=rejected]{border-color:#633b36;background:#281716;color:#f0b0a5}
  .ac-main .ac-table td form .copy-btn[name=decision]{margin:7px 5px 0 0}
  .ac-main .ac-table tbody tr:nth-child(even) td{background:#ffffff03}
  .ac-main .ac-table tbody tr:hover td{background:#e5c46a0b}
  .ac-main .ac-table td small{display:inline-block;margin-top:3px;line-height:1.55}
  .ac-main .ac-table td details{min-width:185px}
  .ac-main .ac-table td details>summary{min-height:38px;padding:9px 10px;font-size:.72rem}
  .ac-main .ac-table td details>form{padding:12px}
  .ac-main .ac-table td details .copy-btn{width:100%;margin:8px 0 0}
  .ac-main .ac-table td details label{margin-top:10px}
  .ac-main .ac-table td details input,.ac-main .ac-table td details select,.ac-main .ac-table td details textarea{font-size:.75rem}
  .ac-main .ac-panel>h2+ .muted{margin-top:0}
  @media(max-width:820px){
    .admin-wrap .ac-main .ac-page-head{padding:17px;border-radius:15px}
    .admin-wrap .ac-main .ac-panel{padding:15px}
    .admin-wrap .ac-main .ac-table-wrap{margin-left:0;margin-right:0}
    .admin-wrap .ac-main .ac-table{min-width:720px}
  }
  @media(max-width:520px){
    .admin-wrap .ac-main .ac-page-head{gap:12px}
    .admin-wrap .ac-main .ac-page-head>.ac-pill{white-space:normal}
    .admin-wrap .ac-main .ac-panel{padding:13px}
    .admin-wrap .ac-main .ac-panel details>form{padding:12px}
    .admin-wrap .ac-main .ac-alert{padding:12px}
    .admin-wrap .ac-main .ac-table{min-width:690px}
  }
  @media(prefers-reduced-motion:reduce){.ac-layout *{scroll-behavior:auto!important;transition:none!important;animation:none!important}}
/* Compact hybrid admin navigation. */ @media(min-width:821px){.ac-layout{grid-template-columns:82px minmax(0,1fr);gap:16px}.ac-side{width:82px;padding:14px 8px;overflow-x:visible;z-index:30;transition:width .18s ease}.ac-brand{justify-content:center;padding-left:0;padding-right:0}.ac-brand>span:not(.ac-brand-mark),.ac-desk-intro,.ac-side-search,.ac-side-search-note,.ac-nav-group-label,.ac-secure{display:none}.ac-nav{justify-content:center;gap:0;padding:8px 5px;min-height:44px}.ac-nav b,.ac-nav-arrow,.ac-nav-badge{display:none}.ac-side:hover,.ac-side:focus-within{width:252px;padding:14px 12px;box-shadow:18px 18px 42px #000b}.ac-side:hover .ac-brand,.ac-side:focus-within .ac-brand{justify-content:flex-start;padding-left:10px;padding-right:10px}.ac-side:hover .ac-brand>span:not(.ac-brand-mark),.ac-side:focus-within .ac-brand>span:not(.ac-brand-mark){display:block}.ac-side:hover .ac-desk-intro,.ac-side:focus-within .ac-desk-intro,.ac-side:hover .ac-side-search,.ac-side:focus-within .ac-side-search,.ac-side:hover .ac-side-search-note,.ac-side:focus-within .ac-side-search-note,.ac-side:hover .ac-nav-group-label,.ac-side:focus-within .ac-nav-group-label,.ac-side:hover .ac-secure,.ac-side:focus-within .ac-secure{display:block}.ac-side:hover .ac-nav,.ac-side:focus-within .ac-nav{justify-content:flex-start;gap:10px;padding:9px 10px}.ac-side:hover .ac-nav b,.ac-side:focus-within .ac-nav b{display:block}.ac-side:hover .ac-nav-arrow,.ac-side:focus-within .ac-nav-arrow{display:inline}.ac-side:hover .ac-nav-badge,.ac-side:focus-within .ac-nav-badge{display:inline-flex}.ac-bottom-nav{display:none!important}}.ac-bottom-nav{display:none}@media(max-width:820px){body{padding-bottom:calc(78px + env(safe-area-inset-bottom))}.ac-mobilebar{display:none!important}.ac-bottom-nav{position:fixed;z-index:1100;left:0;right:0;bottom:0;display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:2px;padding:7px 8px calc(7px + env(safe-area-inset-bottom));border-top:1px solid #514322;background:rgba(13,13,15,.97);backdrop-filter:blur(18px);box-shadow:0 -10px 30px #0006}.ac-bottom-nav a,.ac-bottom-nav button{display:flex;min-width:0;min-height:52px;flex-direction:column;align-items:center;justify-content:center;gap:3px;padding:4px 2px;border:0;border-radius:10px;background:transparent;color:#bdb7a8;text-decoration:none;font:inherit;cursor:pointer}.ac-bottom-nav a[aria-current=page]{background:#302715;color:#f3cf3c}.ac-bottom-nav span{font-size:19px;line-height:1.1}.ac-bottom-nav small{font-size:10px;font-weight:800;line-height:1.2;color:inherit;white-space:nowrap}}  
  /* Admin content typography correction: keep page copy readable without changing the sidebar/navigation identity. */
  .ac-main .ac-panel p,.ac-main .ac-panel li,.ac-main .ac-panel td,.ac-main .ac-panel small,.ac-main .ac-panel .muted,.ac-main .ac-alert,.ac-main .ac-coming p{font-weight:400!important}
  .ac-main .ac-panel strong,.ac-main .ac-panel b,.ac-main .ac-tile strong,.ac-main .ac-coming strong{font-weight:600!important}
  .ac-main .ac-panel form label,.ac-main .ac-panel summary{font-weight:600!important}
  .ac-main .ac-table th{font-weight:650!important;letter-spacing:.055em}
  .ac-main .ac-panel .btn,.ac-main .ac-panel button,.ac-main .ac-panel input[type=submit],.ac-main .ac-panel input[type=button]{font-weight:600!important}
  .ac-main .ac-panel input,.ac-main .ac-panel select,.ac-main .ac-panel textarea{font-weight:400!important}

/* Monarch Codex admin design system: confident type, premium cards, and user-selectable light mode. */
.ac-main{font-family:Inter,Manrope,"Segoe UI",system-ui,sans-serif;letter-spacing:-.012em}
.ac-top{position:relative;overflow:hidden;background:radial-gradient(ellipse at 100% 0,rgba(229,196,106,.16),transparent 40%),linear-gradient(125deg,#1b1a16,#111113 70%,#19150d);border-color:#e5c46a45;box-shadow:0 14px 36px #0003}
.ac-top h1{font-weight:900;letter-spacing:-.045em}
.ac-top p{font-size:.82rem}
.ac-panel,.ac-section-card,.ac-card,.ac-stat,.ac-tile{transition:border-color .18s ease,transform .18s ease,box-shadow .18s ease}
.ac-main .ac-panel,.ac-main .ac-section-card{border-color:#e5c46a32;box-shadow:0 10px 28px #0002}
.ac-main .ac-panel:hover,.ac-main .ac-section-card:hover{border-color:#e5c46a65;box-shadow:0 15px 34px #0003}
.ac-main .ac-panel h2,.ac-main .ac-section-head h2{font-weight:850;letter-spacing:-.035em}
.ac-main .ac-stats .ac-stat{border-color:#e5c46a35;background:linear-gradient(145deg,#1b1a17,#121214);box-shadow:0 8px 24px #0002}
.ac-main .ac-stats .ac-stat:hover{transform:translateY(-2px);border-color:#e5c46a75}
.ac-main .ac-stats .ac-stat>strong{font-weight:900;letter-spacing:-.045em}
.ac-main .ac-panel a,.ac-main .ac-tile,.ac-main .ac-nav{font-weight:600}
.ac-main .ac-panel .btn,.ac-main .ac-panel button,.ac-main .ac-panel input[type=submit],.ac-main .ac-panel input[type=button]{font-weight:750!important}
.ac-main .ac-panel input:focus,.ac-main .ac-panel select:focus,.ac-main .ac-panel textarea:focus{outline:2px solid #e5c46a99;outline-offset:1px;border-color:#e5c46a}
.ac-main .ac-panel button,.ac-main .ac-panel .btn{transition:transform .15s ease,filter .15s ease}
.ac-main .ac-panel button:hover,.ac-main .ac-panel .btn:hover{filter:brightness(1.06);transform:translateY(-1px)}
.ac-theme-toggle{display:inline-flex;align-items:center;gap:7px;padding:9px 12px;border:1px solid #e5c46a44;border-radius:999px;background:#211d12;color:#f3cf3c;font:inherit;font-size:12px;font-weight:700;line-height:1.2;cursor:pointer}
.ac-top-meta{display:flex;align-items:center;justify-content:flex-end;gap:9px;flex-wrap:wrap}
:root[data-admin-theme="light"]{color-scheme:light}
:root[data-admin-theme="light"] body{background:radial-gradient(ellipse at top left,#fff0bd 0,transparent 48%),#f6f5f0;color:#1b1913}
:root[data-admin-theme="light"] .ac-side{background:linear-gradient(180deg,#fffdf7,#f0ead8);border-color:#e5d7ae;box-shadow:0 14px 34px #5e4b1714}
:root[data-admin-theme="light"] .ac-brand,:root[data-admin-theme="light"] .ac-brand small{color:#2a261b}
:root[data-admin-theme="light"] .ac-side nav a{color:#464031}
:root[data-admin-theme="light"] .ac-side nav a:hover,:root[data-admin-theme="light"] .ac-side nav a[aria-current="page"]{background:linear-gradient(90deg,#fff0b8,#f4e4aa);color:#4a3600}
:root[data-admin-theme="light"] .ac-side-search input{background:#fff;color:#1b1913;border-color:#ded2ae}
:root[data-admin-theme="light"] .ac-top{background:radial-gradient(ellipse at 100% 0,#fff0b8,transparent 45%),linear-gradient(125deg,#fff,#fff9e8);border-color:#e6d59a;box-shadow:0 12px 30px #5e4b170d}
:root[data-admin-theme="light"] .ac-top h1,:root[data-admin-theme="light"] .ac-top .ac-breadcrumb,:root[data-admin-theme="light"] .ac-top .ac-kicker{color:#1b1913}
:root[data-admin-theme="light"] .ac-top p,:root[data-admin-theme="light"] .ac-main .muted{color:#655e4e}
:root[data-admin-theme="light"] .ac-main .ac-panel,:root[data-admin-theme="light"] .ac-main .ac-section-card{background:linear-gradient(145deg,#fff,#fffaf0);border-color:#e5dbc0;box-shadow:0 10px 25px #5e4b170d;color:#242116}
:root[data-admin-theme="light"] .ac-main .ac-panel h2,:root[data-admin-theme="light"] .ac-main .ac-section-head h2{color:#262216}
:root[data-admin-theme="light"] .ac-main .ac-panel p,:root[data-admin-theme="light"] .ac-main .ac-panel label,:root[data-admin-theme="light"] .ac-main .ac-panel td{color:#494333}
:root[data-admin-theme="light"] .ac-main .ac-panel input,:root[data-admin-theme="light"] .ac-main .ac-panel select,:root[data-admin-theme="light"] .ac-main .ac-panel textarea{background:#fff;color:#211e16;border-color:#d9ceb0}
:root[data-admin-theme="light"] .ac-main .ac-stats .ac-stat,:root[data-admin-theme="light"] .ac-main .ac-tile{background:linear-gradient(145deg,#fff,#fbf4e2);border-color:#e5d8b3;color:#242116}
:root[data-admin-theme="light"] .ac-main .ac-stats .ac-stat>strong,:root[data-admin-theme="light"] .ac-main .ac-tile strong{color:#8a6500}
:root[data-admin-theme="light"] .ac-main .ac-table th,:root[data-admin-theme="light"] .ac-main .ac-table td{border-color:#e7dfca;color:#3a3426}
:root[data-admin-theme="light"] .ac-main .ac-alert{background:#fff2c5;color:#4d3a08;border-color:#e4d18f}
:root[data-admin-theme="light"] .ac-theme-toggle{background:#fff1bd;color:#604700;border-color:#dfc46c}
:root[data-admin-theme="light"] .ac-bottom-nav{background:rgba(255,253,246,.97);border-color:#e4d4a4;box-shadow:0 -8px 24px #5e4b1714}
:root[data-admin-theme="light"] .ac-bottom-nav a,:root[data-admin-theme="light"] .ac-bottom-nav button{color:#625a47}
:root[data-admin-theme="light"] .ac-bottom-nav a[aria-current="page"]{background:#fff0b7;color:#5c4300}

/* MONARCH CODEX ADMIN — full workspace visual redesign v2 */
.ac-layout{max-width:1720px;grid-template-columns:258px minmax(0,1fr);gap:24px;padding:22px;align-items:start}
.ac-side{width:auto;max-height:calc(100dvh - 44px);top:22px;padding:18px 14px;border-radius:24px;border-color:rgba(229,196,106,.28);background:radial-gradient(ellipse at 10% 0,rgba(229,196,106,.17),transparent 38%),linear-gradient(165deg,#1a1a1d 0%,#101012 72%);box-shadow:0 24px 60px rgba(0,0,0,.3)}
.ac-brand{padding:10px 8px 21px;font-size:.84rem;letter-spacing:.09em}
.ac-brand-mark{width:44px;height:44px;flex-basis:44px;border-radius:15px;background:linear-gradient(145deg,#3c3017,#17140d);box-shadow:inset 0 1px rgba(255,255,255,.1),0 7px 18px #0004}
.ac-brand>span:not(.ac-brand-mark){display:block}
.ac-desk-intro{padding:15px 12px;border-radius:16px}
.ac-side-search{margin-top:16px}
.ac-nav-group{margin-top:18px}
.ac-nav-group-label{font-size:.65rem;letter-spacing:.16em;padding:6px 10px 9px}
.ac-nav{min-height:43px;padding:9px 10px;border-radius:13px}
.ac-nav b{font-size:.8rem;font-weight:720}
.ac-nav-icon{flex-basis:30px;height:30px;border-radius:10px;background:linear-gradient(145deg,#22211d,#141416);font-size:1rem}
.ac-nav-arrow{display:inline;opacity:.38}
.ac-nav.is-active{background:linear-gradient(105deg,rgba(229,196,106,.2),rgba(229,196,106,.045));box-shadow:inset 3px 0 #f0d078,0 8px 18px #0002}
.ac-nav.is-active .ac-nav-icon{background:linear-gradient(145deg,#473719,#241d10);border-color:#8a7135}
.ac-secure{border-radius:15px;background:linear-gradient(135deg,rgba(229,196,106,.1),rgba(229,196,106,.025));border-color:#514323}
.ac-main{padding:0 2px 42px}
.ac-top{margin:0 0 24px;padding:24px 26px;border:1px solid rgba(229,196,106,.3);border-radius:24px;background:radial-gradient(ellipse at 100% 0,rgba(243,207,60,.22),transparent 38%),radial-gradient(ellipse at 0 100%,rgba(243,207,60,.07),transparent 40%),linear-gradient(130deg,#201e18,#111114 68%,#19150c);box-shadow:0 18px 46px #0003}
.ac-top:after{content:"";position:absolute;right:-42px;bottom:-82px;width:220px;height:220px;border:1px solid rgba(229,196,106,.15);border-radius:50%;box-shadow:0 0 0 22px rgba(229,196,106,.025),0 0 0 46px rgba(229,196,106,.02);pointer-events:none}
.ac-top-copy,.ac-top-meta{position:relative;z-index:1}
.ac-breadcrumb{font-size:.68rem;letter-spacing:.16em}
.ac-kicker{padding:7px 10px;border:1px solid rgba(229,196,106,.25);border-radius:999px;background:rgba(229,196,106,.07);font-size:.65rem}
.ac-kicker:before{width:7px;height:7px;border-radius:50%;box-shadow:0 0 0 4px rgba(229,196,106,.1)}
.ac-top h1{font-size:clamp(2rem,3.8vw,3.1rem);letter-spacing:-.055em;margin-top:13px}
.ac-top .muted{font-size:.9rem;max-width:68ch}
.ac-pill{padding:11px 15px;background:rgba(229,196,106,.12);border-color:rgba(229,196,106,.4)}
.ac-theme-toggle{padding:11px 15px;border-color:#8c7334;background:linear-gradient(135deg,#342a15,#19160f);box-shadow:0 7px 18px #0003}
.ac-main .ac-panel,.ac-main .ac-section-card{position:relative;overflow:hidden;padding:clamp(20px,2.2vw,30px);border-radius:22px;border-color:rgba(229,196,106,.23);background:radial-gradient(ellipse at 100% 0,rgba(229,196,106,.045),transparent 44%),linear-gradient(145deg,#1b1b1f,#121214 75%);box-shadow:0 14px 35px rgba(0,0,0,.2)}
.ac-main .ac-panel h2,.ac-main .ac-section-head h2{font-size:clamp(1.12rem,1.6vw,1.45rem);letter-spacing:-.035em}
.ac-main .ac-stats{gap:14px;margin:20px 0 24px}
.ac-main .ac-stats .ac-stat{position:relative;isolation:isolate;min-height:126px;padding:20px;border-radius:19px;border-color:rgba(229,196,106,.28);background:radial-gradient(ellipse at 100% 0,rgba(229,196,106,.13),transparent 52%),linear-gradient(145deg,#201f1b,#141416 80%);box-shadow:0 12px 28px #0002}
.ac-main .ac-stats .ac-stat:after{content:"";position:absolute;right:-16px;top:-26px;width:90px;height:90px;border:1px solid rgba(229,196,106,.15);border-radius:26px;transform:rotate(24deg);z-index:-1}
.ac-main .ac-stats .ac-stat>strong{font-size:clamp(1.7rem,2.7vw,2.25rem);line-height:1.1;color:#f4d77d}
.ac-main .ac-stats .ac-stat>small{display:block;margin-top:10px;font-size:.74rem;letter-spacing:.01em}
.ac-main .ac-tile{padding:18px;border-radius:17px;border-color:rgba(229,196,106,.22);background:linear-gradient(145deg,#1d1c18,#141416);box-shadow:0 9px 22px #0002}
.ac-main .ac-tile strong{font-size:.96rem}
.ac-main .ac-table-wrap{border:1px solid rgba(229,196,106,.16);border-radius:15px}
.ac-main .ac-table{border-collapse:separate;border-spacing:0}
.ac-main .ac-table th{padding:14px 13px;background:rgba(229,196,106,.07);font-size:.67rem;letter-spacing:.11em}
.ac-main .ac-table td{padding:14px 13px}
.ac-main .ac-table tr:last-child td{border-bottom:0}
.ac-main .ac-panel input,.ac-main .ac-panel select,.ac-main .ac-panel textarea{border-radius:12px;min-height:44px}
.ac-main .ac-panel .btn,.ac-main .ac-panel button,.ac-main .ac-panel input[type=submit],.ac-main .ac-panel input[type=button]{min-height:42px;border-radius:12px}
.ac-main .ac-alert{border-radius:16px;padding:15px 18px;box-shadow:0 10px 24px #0002}
:root[data-admin-theme="light"] .ac-side{background:radial-gradient(ellipse at 10% 0,#fff0b8,transparent 40%),linear-gradient(165deg,#fffdf7,#f0ead8);border-color:#e5d7ae}
:root[data-admin-theme="light"] .ac-brand-mark{background:linear-gradient(145deg,#fff0b7,#f4e2a6);color:#654b09;box-shadow:none}
:root[data-admin-theme="light"] .ac-nav-icon{background:linear-gradient(145deg,#fffdf7,#f1e7cb);border-color:#e4d7b5}
:root[data-admin-theme="light"] .ac-nav.is-active{background:linear-gradient(105deg,#ffefb4,#fff9e6);box-shadow:inset 3px 0 #b28a19,0 6px 16px #5e4b170d}
:root[data-admin-theme="light"] .ac-nav.is-active .ac-nav-icon{background:#ffefb4;border-color:#d8bc66}
:root[data-admin-theme="light"] .ac-desk-intro{background:linear-gradient(125deg,#fff0b7,#fffaf0);border-color:#e4d29a}
:root[data-admin-theme="light"] .ac-desk-intro strong,:root[data-admin-theme="light"] .ac-desk-orbit{color:#6b4c00}
:root[data-admin-theme="light"] .ac-top{background:radial-gradient(ellipse at 100% 0,#fff0b8,transparent 40%),linear-gradient(130deg,#fff,#fff9e8);border-color:#e4d39a}
:root[data-admin-theme="light"] .ac-main .ac-stats .ac-stat{background:radial-gradient(ellipse at 100% 0,#fff1c2,transparent 54%),linear-gradient(145deg,#fff,#faf3df);border-color:#e5d8b3}
:root[data-admin-theme="light"] .ac-main .ac-stats .ac-stat>strong{color:#8a6500}
:root[data-admin-theme="light"] .ac-main .ac-panel,:root[data-admin-theme="light"] .ac-main .ac-section-card{background:radial-gradient(ellipse at 100% 0,#fff8df,transparent 44%),linear-gradient(145deg,#fff,#fffaf0);border-color:#e5dbc0}
:root[data-admin-theme="light"] .ac-main .ac-tile{background:linear-gradient(145deg,#fff,#fbf4e2);border-color:#e5d8b3}
@media(min-width:821px){.ac-layout{grid-template-columns:258px minmax(0,1fr)}.ac-side{width:auto;padding:18px 14px}.ac-brand{justify-content:flex-start}.ac-brand>span:not(.ac-brand-mark),.ac-desk-intro,.ac-side-search,.ac-side-search-note,.ac-nav-group-label,.ac-secure{display:block}.ac-nav{justify-content:flex-start;gap:10px;padding:9px 10px}.ac-nav b,.ac-nav-arrow,.ac-nav-badge{display:inline-flex}.ac-side:hover,.ac-side:focus-within{width:auto;padding:18px 14px}.ac-side:hover .ac-nav,.ac-side:focus-within .ac-nav{justify-content:flex-start;gap:10px;padding:9px 10px}}
@media(max-width:820px){.ac-layout{display:block;padding:10px 10px 22px}.ac-side{position:fixed;left:0;top:0;bottom:0;width:min(88vw,340px);max-height:100dvh;height:100dvh;border-radius:0 22px 22px 0;z-index:1200}.ac-top{padding:20px 18px;border-radius:20px}.ac-main .ac-stats{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.ac-main .ac-stats .ac-stat{min-height:112px;padding:15px}.ac-main .ac-panel,.ac-main .ac-section-card{padding:18px;border-radius:18px}}
@media(max-width:420px){.ac-main .ac-stats{grid-template-columns:1fr 1fr}.ac-main .ac-stats .ac-stat>strong{font-size:1.55rem}.ac-top h1{font-size:1.9rem}.ac-pill{font-size:.58rem;padding:8px 10px}}

@media(prefers-reduced-motion:reduce){.ac-layout *{transition:none!important;animation:none!important}}


  /* MONARCH CODEX ADMIN REDESIGN — layered visual system; keeps existing routes and workflows intact. */
  .ac-layout{--mc-gold:#f2cf55;--mc-gold-soft:#ffe9a0;--mc-line:rgba(242,207,85,.24);max-width:1780px;gap:24px;padding:24px;align-items:start}
  .ac-main{padding:0 4px 42px}
  .ac-side{padding:19px 13px;border-radius:25px;border-color:rgba(242,207,85,.25);background:radial-gradient(ellipse at 10% 0,rgba(242,207,85,.16),transparent 36%),linear-gradient(165deg,#1a1916 0%,#101012 68%,#0b0b0d 100%);box-shadow:0 24px 65px #0005}
  .ac-brand{gap:12px;padding:10px 9px 21px;font-size:.8rem;letter-spacing:.13em}
  .ac-brand-mark{flex-basis:45px;height:45px;border-radius:15px;background:linear-gradient(145deg,#4b3a13,#211a0b);border-color:#a08231;box-shadow:inset 0 1px #fff2,0 8px 22px #0004}
  .ac-nav-group{margin-top:18px}
  .ac-nav-group-label{padding:6px 10px 8px;color:#a9975c;font-size:.6rem;letter-spacing:.16em}
  .ac-nav{min-height:43px;margin:4px 0;padding:9px 10px;border-radius:13px;font-size:.8rem}
  .ac-nav-icon{flex-basis:30px;height:30px;border-radius:10px;border-color:#4b3e20;background:linear-gradient(145deg,#292316,#151517);color:#f2cf55}
  .ac-nav.is-active{border-color:#94762c;background:linear-gradient(105deg,#f2cf5530,#f2cf5508);box-shadow:inset 3px 0 #f2cf55,0 8px 22px #0002}
  .ac-nav.is-active .ac-nav-icon{background:#3a2d11;border-color:#94762c;color:#ffe9a0}
  .ac-top{position:relative;isolation:isolate;overflow:hidden;align-items:center;gap:20px;margin:0 0 25px;padding:25px 27px 27px;border:1px solid rgba(242,207,85,.28);border-radius:25px;background:radial-gradient(ellipse at 95% 0,rgba(242,207,85,.2),transparent 36%),radial-gradient(ellipse at 0 100%,rgba(242,207,85,.08),transparent 40%),linear-gradient(130deg,#201e18,#111113 68%,#19150c);box-shadow:0 20px 48px #0004}
  .ac-top:after{content:"";position:absolute;z-index:-1;right:-58px;bottom:-105px;width:220px;height:220px;border:1px solid #f2cf5530;border-radius:50%;box-shadow:0 0 0 22px #f2cf5507,0 0 0 48px #f2cf5505;pointer-events:none}
  .ac-top h1{font-size:clamp(2rem,3.5vw,3.15rem);font-weight:950;letter-spacing:-.06em;line-height:1.02;color:#fff6dc}
  .ac-top .muted{font-size:.86rem;max-width:66ch}
  .ac-breadcrumb{letter-spacing:.15em}
  .ac-kicker{color:#f2cf55;font-size:.68rem;letter-spacing:.18em}
  .ac-pill{padding:10px 14px;border-color:#f2cf5550;background:linear-gradient(135deg,#f2cf5518,#f2cf5507);color:#ffe7a0;box-shadow:inset 0 1px #fff1}
  .ac-stats{gap:15px;margin:19px 0 25px}
  .ac-stat{min-height:145px;padding:22px;border-radius:22px;border-color:#f2cf5530;background:radial-gradient(ellipse at 100% 0,#f2cf551c,transparent 52%),linear-gradient(145deg,#201f1a,#121214 78%);box-shadow:0 15px 34px #0003;transition:transform .18s ease,border-color .18s ease,box-shadow .18s ease}
  .ac-stat:hover{transform:translateY(-3px);border-color:#f2cf5580;box-shadow:0 20px 42px #0004}
  .ac-stat:after{right:-15px;top:-26px;width:94px;height:94px;border-radius:28px;transform:rotate(24deg);border-color:#f2cf5530}
  .ac-stat span{font-size:.76rem;color:#c8c0ac}
  .ac-stat strong{margin:17px 0 9px;font-size:clamp(1.8rem,2.8vw,2.5rem);font-weight:950;letter-spacing:-.055em;color:#f5d96f}
  .ac-stat small{font-size:.72rem;color:#aaa393}
  .ac-panel,.ac-main .ac-panel{margin-top:19px;padding:clamp(20px,2.5vw,30px);border:1px solid rgba(242,207,85,.19);border-radius:23px;background:radial-gradient(ellipse at 100% 0,#f2cf5509,transparent 42%),linear-gradient(145deg,#1b1b1f,#111114 78%);box-shadow:0 16px 38px #0003}
  .ac-main .ac-panel:hover{border-color:rgba(242,207,85,.34)}
  .ac-panel>h2,.ac-panel>h3,.ac-main .ac-panel>h2{font-size:clamp(1.18rem,1.8vw,1.5rem);font-weight:900;letter-spacing:-.035em;color:#fff4d7}
  .ac-section-head{margin:30px 0 14px}
  .ac-section-head h2{font-size:1.22rem;font-weight:900;letter-spacing:-.035em}
  .ac-section-head p{font-size:.8rem}
  .ac-overview-hero{margin-bottom:18px;padding:clamp(24px,3vw,36px);border-radius:25px;border-color:#f2cf5555;background:radial-gradient(ellipse at 88% 0,#f2cf5530,transparent 40%),radial-gradient(ellipse at 0 100%,#f2cf550d,transparent 45%),linear-gradient(130deg,#252116,#121214 70%,#1d1709);box-shadow:0 20px 45px #0003}
  .ac-overview-hero h2{font-size:clamp(1.55rem,3vw,2.35rem);font-weight:950;letter-spacing:-.055em}
  .ac-overview-hero p{font-size:.84rem;max-width:64ch}
  .ac-hero-mark{width:78px;height:78px;border-radius:24px;border-color:#f2cf5566;background:linear-gradient(145deg,#f2cf5528,#f2cf5509);box-shadow:0 12px 30px #0003}
  .ac-tiles{gap:15px}
  .ac-tile{min-height:150px;padding:20px;border-radius:19px;border-color:#f2cf5528;background:radial-gradient(ellipse at 100% 0,#f2cf550c,transparent 45%),linear-gradient(145deg,#1d1c18,#121214);box-shadow:0 10px 28px #0002}
  .ac-tile:before{width:36px;height:36px;border-radius:12px;border-color:#f2cf5540;background:#f2cf5514;color:#f2cf55}
  .ac-tile strong{font-size:.9rem;font-weight:850;color:#ffe6a0}
  .ac-tile small{font-size:.75rem;line-height:1.7}
  .ac-table-wrap{border-radius:17px;border-color:#f2cf5525;background:#101012;box-shadow:0 12px 28px #0002}
  .ac-main .ac-table{min-width:720px}
  .ac-main .ac-table th{padding:15px 16px;background:#242116;color:#e8d48f;font-size:.66rem;letter-spacing:.12em;border-bottom-color:#66542a}
  .ac-main .ac-table td{padding:15px 16px;font-size:.8rem}
  .ac-main .ac-panel form label{font-size:.77rem;font-weight:750;color:#e8dfc9}
  .ac-main .ac-panel input:not([type=checkbox]):not([type=radio]):not([type=hidden]),.ac-main .ac-panel select,.ac-main .ac-panel textarea{min-height:47px;border-radius:13px;border-color:#51462d;background:#0c0c0f}
  .ac-main .ac-panel .btn,.ac-main .ac-panel button,.ac-main .ac-panel .copy-btn{min-height:43px;border-radius:12px;font-weight:850}
  .ac-main .ac-alert{border-radius:15px}
  .ac-secure{border-color:#f2cf5526;border-radius:15px;background:#f2cf5508}
  .ac-secure-title{color:#f2cf55}
  :root[data-admin-theme="light"] .ac-layout{color:#211e15}
  :root[data-admin-theme="light"] .ac-side{background:radial-gradient(ellipse at 10% 0,#fff0b9,transparent 36%),linear-gradient(165deg,#fffdf7,#f0ead8 78%);border-color:#e3d19a;box-shadow:0 20px 45px #66521b12}
  :root[data-admin-theme="light"] .ac-brand{color:#241e10;border-color:#e4d9ba}
  :root[data-admin-theme="light"] .ac-brand small{color:#7b6c44}
  :root[data-admin-theme="light"] .ac-brand-mark{background:linear-gradient(145deg,#fff0b7,#f0dfa0);border-color:#d8bd63;color:#604800;box-shadow:none}
  :root[data-admin-theme="light"] .ac-nav-group-label{color:#87713a}
  :root[data-admin-theme="light"] .ac-nav{color:#4c4535}
  :root[data-admin-theme="light"] .ac-nav-icon{background:linear-gradient(145deg,#fffdf7,#f2e8ca);border-color:#e4d5ac;color:#805f06}
  :root[data-admin-theme="light"] .ac-nav.is-active,:root[data-admin-theme="light"] .ac-nav:hover{background:linear-gradient(105deg,#fff0b8,#fff9e7);border-color:#e3cf8e;color:#4c3900;box-shadow:inset 3px 0 #b58b1b,0 7px 18px #8b6b1510}
  :root[data-admin-theme="light"] .ac-top{background:radial-gradient(ellipse at 95% 0,#fff0b9,transparent 38%),linear-gradient(130deg,#fff,#fff9e8);border-color:#e4d39a;box-shadow:0 16px 38px #8b6b1510}
  :root[data-admin-theme="light"] .ac-top h1{color:#211a0a}
  :root[data-admin-theme="light"] .ac-top .muted{color:#665d48}
  :root[data-admin-theme="light"] .ac-pill{background:linear-gradient(135deg,#fff0bb,#fff9e8);border-color:#e1cd8c;color:#624800}
  :root[data-admin-theme="light"] .ac-stat{background:radial-gradient(ellipse at 100% 0,#fff0b9,transparent 55%),linear-gradient(145deg,#fff,#fbf4e2);border-color:#e4d6ad;box-shadow:0 12px 28px #66521b0b}
  :root[data-admin-theme="light"] .ac-stat span,:root[data-admin-theme="light"] .ac-stat small{color:#6a614c}
  :root[data-admin-theme="light"] .ac-stat strong{color:#8a6500}
  :root[data-admin-theme="light"] .ac-main .ac-panel{background:radial-gradient(ellipse at 100% 0,#fff8df,transparent 44%),linear-gradient(145deg,#fff,#fffaf0);border-color:#e5d9b9;box-shadow:0 12px 28px #66521b0b}
  :root[data-admin-theme="light"] .ac-main .ac-panel>h2,:root[data-admin-theme="light"] .ac-main .ac-panel>h3,:root[data-admin-theme="light"] .ac-main h2,:root[data-admin-theme="light"] .ac-main h3{color:#272114}
  :root[data-admin-theme="light"] .ac-overview-hero{background:radial-gradient(ellipse at 88% 0,#fff0b9,transparent 40%),linear-gradient(130deg,#fff,#fff9e8);border-color:#e4d39a}
  :root[data-admin-theme="light"] .ac-overview-hero h2{color:#27200f}
  :root[data-admin-theme="light"] .ac-overview-hero p{color:#665d48}
  :root[data-admin-theme="light"] .ac-hero-mark{background:linear-gradient(145deg,#fff0b7,#f4e2a6);border-color:#ddc573;color:#6a4d00;box-shadow:none}
  :root[data-admin-theme="light"] .ac-tile{background:radial-gradient(ellipse at 100% 0,#fff0b9,transparent 55%),linear-gradient(145deg,#fff,#fbf4e2);border-color:#e4d6ad;color:#211e16;box-shadow:0 10px 24px #66521b0b}
  :root[data-admin-theme="light"] .ac-tile strong{color:#6b4d00}
  :root[data-admin-theme="light"] .ac-tile small,:root[data-admin-theme="light"] .ac-main .ac-panel p{color:#665e4e}
  :root[data-admin-theme="light"] .ac-main .ac-table-wrap{background:#fff;border-color:#e4d9bc}
  :root[data-admin-theme="light"] .ac-main .ac-table th{background:#f7edcc;color:#654d0a;border-bottom-color:#e1d09b}
  :root[data-admin-theme="light"] .ac-main .ac-table td{color:#3a3427;border-bottom-color:#e8e0cd}
  :root[data-admin-theme="light"] .ac-main .ac-table td strong{color:#211b0d}
  :root[data-admin-theme="light"] .ac-main .ac-panel input:not([type=checkbox]):not([type=radio]):not([type=hidden]),:root[data-admin-theme="light"] .ac-main .ac-panel select,:root[data-admin-theme="light"] .ac-main .ac-panel textarea{background:#fff;color:#211e15;border-color:#d9cda9}
  :root[data-admin-theme="light"] .ac-main .ac-panel form label{color:#51462f}
  :root[data-admin-theme="light"] .ac-main .ac-alert{background:linear-gradient(110deg,#fff4c9,#fffaf0);color:#55400a;border-color:#e5d08b}
  @media(max-width:1180px){.ac-layout{gap:16px;padding:17px}.ac-stat{padding:17px}.ac-tiles{gap:11px}}
  @media(max-width:820px){.ac-layout{padding:10px 10px 24px}.ac-top{padding:21px 19px;border-radius:21px}.ac-top h1{font-size:clamp(1.85rem,7vw,2.55rem)}.ac-stats{gap:10px}.ac-stat{min-height:118px;padding:14px}.ac-panel,.ac-main .ac-panel{padding:18px;border-radius:19px}.ac-tiles{gap:10px}.ac-tile{min-height:125px;padding:15px}}
  @media(max-width:520px){.ac-layout{padding:8px 8px 22px}.ac-top{padding:19px 16px}.ac-top-meta{gap:7px}.ac-stat{padding:12px;min-height:105px}.ac-stat strong{font-size:1.5rem}.ac-tile{min-height:0}.ac-main .ac-table{min-width:680px}}
  @media(prefers-reduced-motion:reduce){.ac-layout *{transition:none!important;animation:none!important}}
</style><div class="ac-layout" id="adminLayout">
  <div class="ac-mobilebar"><button class="ac-menu-toggle" type="button" id="adminMenuToggle" aria-label="Open admin navigation" aria-expanded="false">☰</button><span class="ac-mobile-title">MONARCH CODEX · ADMIN</span></div>
  <button class="ac-drawer-scrim" type="button" id="adminDrawerScrim" aria-label="Close admin navigation"></button>
  <aside class="ac-side ${deskOnly ? 'ac-side-desk' : ''}" id="adminSidebar"><div class="ac-brand"><span class="ac-brand-mark" aria-hidden="true">${deskOnly ? 'S' : 'M'}</span><span>${deskOnly ? 'SOVEREIGN DESK' : 'MONARCH CODEX'}<small>${deskOnly ? 'TRADING WORKSPACE' : 'ADMIN CONTROL CENTRE'}</small></span></div>
  ${deskOnly ? '<div class="ac-desk-intro"><span class="ac-desk-orbit">⌁</span><div><strong>SOVEREIGN DESK</strong><small>Signals · Guidance · Members</small></div></div>' : ''}
  <div class="ac-side-search"><input id="adminNavSearch" type="search" placeholder="Find a workspace…" autocomplete="off" aria-label="Filter admin navigation"></div><p class="ac-side-search-note">Search the tools available to your role.</p><nav aria-label="Admin workspace navigation">${nav}</nav>
  <div class="ac-secure"><div class="ac-secure-title"><span class="ac-secure-dot" aria-hidden="true"></span>Protected workspace</div>Access is checked on the server for each protected page. Your role determines which workspaces appear.</div>
  <form method="post" action="/logout">${csrfField(req)}<button class="btn ac-logout" type="submit">↗ &nbsp; Log out securely</button></form></aside>
  <main class="ac-main"><div id="adminPendingDepositNotice" class="ac-alert" role="status" hidden style="display:none;margin:0 0 16px;border-color:#8c3d30;background:linear-gradient(100deg,#351713,#1a1413);color:#ffe2d8"><strong id="adminPendingDepositHeading">Deposit review needed</strong><span id="adminPendingDepositCopy"> New deposit requests are waiting for verification.</span> <a href="/admin/deposits" style="color:#f3cf3c;font-weight:900;text-decoration:underline;margin-left:6px">Review deposits →</a></div><header class="ac-top"><div class="ac-top-copy"><div class="ac-breadcrumb"><span>MONARCH CODEX</span><span aria-hidden="true">/</span><span>CONTROL CENTRE</span></div><div class="ac-kicker">Administrator workspace</div><h1>${esc(title)}</h1><p class="muted">${subtitle}</p></div><div class="ac-top-meta"><button class="ac-theme-toggle" id="adminThemeToggle" type="button" aria-label="Switch to light mode">☼ <span>Light mode</span></button><span class="ac-pill"><span class="ac-pill-dot" aria-hidden="true"></span>${role}</span></div></header>${content}</main></div><nav class=\"ac-bottom-nav\" aria-label=\"Admin mobile navigation\"><a href=\"/admin\" aria-label=\"Overview\"><span>◫</span><small>Overview</small></a><a href=\"/sovereign-admin/signals\" aria-label=\"Signals\"><span>↗</span><small>Signals</small></a><a href=\"/sovereign-admin/mentorship\" aria-label=\"Guidance\"><span>✦</span><small>Guidance</small></a><a href=\"/sovereign-admin/chat\" aria-label=\"Member chat\"><span>◉</span><small>Chat</small></a><button type=\"button\" id=\"acBottomMore\" aria-label=\"More admin sections\"><span>☰</span><small>More</small></button></nav>
  <script>(function(){var root=document.documentElement,button=document.getElementById("adminThemeToggle");try{var saved=localStorage.getItem("monarch-admin-theme");if(saved==="light"||saved==="dark")root.dataset.adminTheme=saved}catch(e){}function sync(){if(!button)return;var light=root.dataset.adminTheme==="light";button.innerHTML=(light?"☾ <span>Dark mode</span>":"☼ <span>Light mode</span>");button.setAttribute("aria-label",light?"Switch to dark mode":"Switch to light mode")}if(button){sync();button.addEventListener("click",function(){root.dataset.adminTheme=root.dataset.adminTheme==="light"?"dark":"light";try{localStorage.setItem("monarch-admin-theme",root.dataset.adminTheme)}catch(e){}sync()})}})();</script>
  <script>(function(){var layout=document.getElementById('adminLayout'),toggle=document.getElementById('adminMenuToggle'),scrim=document.getElementById('adminDrawerScrim'),sidebar=document.getElementById('adminSidebar'),search=document.getElementById('adminNavSearch');if(layout&&toggle&&scrim&&sidebar){function close(){layout.classList.remove('ac-menu-open');toggle.setAttribute('aria-expanded','false');toggle.setAttribute('aria-label','Open admin navigation')}function open(){layout.classList.add('ac-menu-open');toggle.setAttribute('aria-expanded','true');toggle.setAttribute('aria-label','Close admin navigation')}toggle.addEventListener('click',function(){layout.classList.contains('ac-menu-open')?close():open()});var more=document.getElementById('acBottomMore');if(more){more.addEventListener('click',function(){layout.classList.contains('ac-menu-open')?close():open()})}scrim.addEventListener('click',close);sidebar.querySelectorAll('a').forEach(function(a){a.addEventListener('click',close)});document.addEventListener('keydown',function(e){if(e.key==='Escape')close()});window.addEventListener('resize',function(){if(window.innerWidth>820)close()})}if(search&&sidebar){search.addEventListener('input',function(){var q=search.value.trim().toLowerCase();sidebar.querySelectorAll('.ac-nav-group').forEach(function(group){var links=Array.from(group.querySelectorAll('.ac-nav'));var shown=0;links.forEach(function(link){var match=!q||link.textContent.toLowerCase().indexOf(q)!==-1;link.hidden=!match;if(match)shown++});group.hidden=shown===0})})}var badges=Array.from(document.querySelectorAll('[data-pending-deposit-count]')),notice=document.getElementById('adminPendingDepositNotice'),heading=document.getElementById('adminPendingDepositHeading'),copy=document.getElementById('adminPendingDepositCopy');function refreshPendingDeposits(){fetch('/api/admin/pending-deposit-count',{credentials:'same-origin',cache:'no-store'}).then(function(r){if(!r.ok)throw new Error('count unavailable');return r.json()}).then(function(data){var count=Math.max(0,Number(data.count)||0);badges.forEach(function(b){b.textContent=count>99?'99+':String(count);b.hidden=count===0;b.setAttribute('aria-label',count+' pending deposit'+(count===1?'':'s'))});if(notice){notice.hidden=count===0;notice.style.display=count===0?'none':'block';if(heading)heading.textContent=count===1?'1 deposit needs verification':count+' deposits need verification';if(copy)copy.textContent=' Review the payment proof and confirm the funds arrived before approving.'}}).catch(function(){/* Do not silently hide a broken alert: tell the admin to open the queue manually. */if(notice){notice.hidden=false;notice.style.display='block';notice.style.borderColor='#b96b2d';notice.style.background='linear-gradient(100deg,#35220f,#1a1413)';if(heading)heading.textContent='Deposit alert needs attention';if(copy)copy.textContent=' The live pending count could not load. Open Deposits to check requests and confirm the finance-admin role and database setup.'}badges.forEach(function(b){b.hidden=false;b.textContent='!';b.setAttribute('aria-label','Pending deposit count unavailable; open deposits to check manually')})})}if(badges.length||notice){refreshPendingDeposits();window.setInterval(refreshPendingDeposits,30000)}
function refreshAdminAlerts(){fetch('/api/admin/notifications/summary',{credentials:'same-origin',cache:'no-store'}).then(function(r){if(!r.ok)throw new Error('unavailable');return r.json()}).then(function(data){var count=Math.max(0,Number(data.count)||0);var links=Array.from(document.querySelectorAll('.ac-nav[href="/admin/notifications"],.ac-bottom-nav a[href="/admin/notifications"]'));links.forEach(function(link){var b=link.querySelector('[data-admin-alert-count]');if(!b){b=document.createElement('span');b.className='ac-nav-badge';b.setAttribute('data-admin-alert-count','');b.setAttribute('aria-label','Pending admin actions');link.insertBefore(b,link.querySelector('.ac-nav-arrow')||null)}b.textContent=count>99?'99+':String(count);b.hidden=count===0;b.setAttribute('aria-label',count+' pending admin action'+(count===1?'':'s'));});}).catch(function(){/* Preserve navigation if summary cannot load. */})}
refreshAdminAlerts();window.setInterval(refreshAdminAlerts,30000);
})();</script>`);
}
app.get('/admin', requireAdmin, async (req,res,next) => {
  try {
    const [[members]] = await pool.query('SELECT COUNT(*) AS total FROM members');
    let recentTotal = '—';
    try { const [[recent]] = await pool.query('SELECT COUNT(*) AS total FROM members WHERE created_at >= DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 7 DAY)'); recentTotal = Number(recent.total)||0; } catch (e) { if (!['ER_BAD_FIELD_ERROR','ER_BAD_TABLE_ERROR'].includes(e.code)) throw e; }
    const [[admins]] = await pool.query('SELECT COUNT(*) AS total FROM admin_users WHERE is_active = 1');
    let kycCount = null;
    try { const [[kyc]] = await pool.query("SELECT COUNT(*) AS total FROM kyc_submissions WHERE status = 'pending'"); kycCount = Number(kyc.total)||0; } catch(e) { if(!['ER_NO_SUCH_TABLE','ER_BAD_FIELD_ERROR'].includes(e.code)) throw e; }
    let packageCount = null, activePackageCount = null, activeInvestmentCount = null;
    let pendingDepositCount = null, pendingWithdrawalCount = null;
    let pendingCommunityCount = null, pendingCooperativeCount = null, unreadNotificationCount = null;
    try { const [[p]] = await pool.query("SELECT COUNT(*) AS total, COALESCE(SUM(status='active'),0) AS active FROM investment_packages"); packageCount = Number(p.total)||0; activePackageCount = Number(p.active)||0; } catch(e) { if(!['ER_NO_SUCH_TABLE','ER_BAD_FIELD_ERROR'].includes(e.code)) throw e; }
    try { const [[p]] = await pool.query("SELECT COUNT(*) AS total FROM member_investments WHERE status='active'"); activeInvestmentCount = Number(p.total)||0; } catch(e) { if(!['ER_NO_SUCH_TABLE','ER_BAD_FIELD_ERROR'].includes(e.code)) throw e; }
    try { const [[p]] = await pool.query("SELECT COUNT(*) AS total FROM deposit_requests WHERE status='pending'"); pendingDepositCount = Number(p.total)||0; } catch(e) { if(!['ER_NO_SUCH_TABLE','ER_BAD_FIELD_ERROR'].includes(e.code)) throw e; }
    try { const [[p]] = await pool.query("SELECT COUNT(*) AS total FROM withdrawal_requests WHERE status='pending'"); pendingWithdrawalCount = Number(p.total)||0; } catch(e) { if(!['ER_NO_SUCH_TABLE','ER_BAD_FIELD_ERROR'].includes(e.code)) throw e; }
    try { const [[p]] = await pool.query("SELECT COUNT(*) AS total FROM community_posts WHERE status='pending'"); pendingCommunityCount = Number(p.total)||0; } catch(e) { if(!['ER_NO_SUCH_TABLE','ER_BAD_FIELD_ERROR'].includes(e.code)) throw e; }
    try { const [[p]] = await pool.query("SELECT COUNT(*) AS total FROM online_cooperative_connections WHERE status='pending'"); pendingCooperativeCount = Number(p.total)||0; } catch(e) { if(!['ER_NO_SUCH_TABLE','ER_BAD_FIELD_ERROR'].includes(e.code)) throw e; }
    try { const [[p]] = await pool.query("SELECT COUNT(*) AS total FROM member_notifications WHERE read_at IS NULL"); unreadNotificationCount = Number(p.total)||0; } catch(e) { if(!['ER_NO_SUCH_TABLE','ER_BAD_FIELD_ERROR'].includes(e.code)) throw e; }
    const stat = (label,value,hint) => '<article class="ac-stat"><span>'+esc(label)+'</span><strong>'+esc(value)+'</strong><small>'+esc(hint)+'</small></article>';
    const tile = (url,title,description) => '<a class="ac-tile" href="'+url+'"><div><strong>'+esc(title)+'</strong><small>'+esc(description)+'</small></div></a>';
    const ready = (icon,title,description,status,ok) => '<div class="ac-readiness-row"><span class="ac-readiness-icon" aria-hidden="true">'+icon+'</span><div style="min-width:0;flex:1"><strong>'+esc(title)+'</strong><p>'+esc(description)+'</p></div><span class="ac-readiness-tag '+(ok?'is-ready':'')+'">'+esc(status)+'</span></div>';
    const content = '<section class="ac-overview-hero"><div><p class="ac-hero-kicker">Executive operations · Live account records</p><h2>Your platform, at a glance.</h2><p>Manage member access, identity verification and platform workspaces from one protected control centre. Counts below are read from your database; unavailable workflows are clearly identified rather than filled with estimates.</p></div><span class="ac-hero-mark" aria-hidden="true">✦</span></section>'+
      '<section class="ac-stats">'+stat('Total members',Number(members.total)||0,'All registered member accounts')+stat('New members · 7 days',recentTotal,'Recent registrations')+stat('Active administrators',Number(admins.total)||0,'Explicitly provisioned accounts')+stat('Pending KYC',kycCount===null?'—':kycCount,kycCount===null?'Verification table unavailable':'Applications awaiting review')+stat('Pending deposits',pendingDepositCount===null?'—':pendingDepositCount,pendingDepositCount===null?'Deposit queue unavailable':'Awaiting manual evidence review')+stat('Pending withdrawals',pendingWithdrawalCount===null?'—':pendingWithdrawalCount,pendingWithdrawalCount===null?'Withdrawal queue unavailable':'Awaiting eligibility review')+stat('Active packages',activePackageCount===null?'—':activePackageCount,packageCount===null?'Investment table unavailable':packageCount+' package(s) configured')+stat('Active investments',activeInvestmentCount===null?'—':activeInvestmentCount,activeInvestmentCount===null?'Investment records unavailable':'Member investment records marked active')+stat('Community review',pendingCommunityCount===null?'—':pendingCommunityCount,pendingCommunityCount===null?'Community queue unavailable':'Posts awaiting moderation')+stat('Cooperative review',pendingCooperativeCount===null?'—':pendingCooperativeCount,pendingCooperativeCount===null?'Connection queue unavailable':'Connections awaiting verification')+stat('Unread notifications',unreadNotificationCount===null?'—':unreadNotificationCount,unreadNotificationCount===null?'Notification records unavailable':'Member notifications not yet read')+'</section>'+
      '<div class="ac-section-head"><div><h2>Operational workspaces</h2><p>Jump directly to the area you need to manage.</p></div></div>'+
      '<section class="ac-tiles">'+tile('/admin/members','Member management','Review member accounts, usernames and access roles.')+tile('/admin/roles','Member roles','Review member role requests and assignments.')+tile('/admin/monarchs','Homepage Monarchs','Approve public member profiles and manage homepage visibility.')+tile('/admin/kyc','Identity verification','Review submitted identity details and documents.')+tile('/admin/deposits','Deposit operations','Review payment methods, evidence and deposit requests.')+tile('/admin/withdrawals','Withdrawal review','Review requests and record a completed transfer only after verification.')+tile('/admin/investments','Investment packages','Create, edit, activate and pause packages.')+tile('/admin/transactions','Transaction ledger','Inspect recorded financial transactions.')+tile('/admin/balances','Balance management','Open the current balance-management readiness page.')+tile('/admin/cooperative-connections','Online Cooperative','Confirm the member’s submitted registration name and email with the Cooperative administrator before approving the connection.')+tile('/admin/community-moderation','Community moderation','Review pending posts and member reports.')+tile('/admin/social-links','Official social links','Manage and test official HTTPS links shown to members. Inactive or blank platforms stay hidden.')+tile('/admin/notifications','Notifications','Review persisted member notification records.')+tile('/admin/referrals','Referral monitoring','Inspect referral attribution and eligible activity.')+tile('/admin/academy','Academy & learning','Manage lessons and publishing status.')+tile('/admin/sovereign-desk','Sovereign Desk','Open the separate signals, guidance and access workspace.')+tile('/admin/audit','Security & audit','Review provisioned administrators and recorded admin events.')+tile('/admin/settings','Platform settings','Review supported platform and pricing configuration.')+tile('/admin/profile','My admin profile','Update your administrator profile and profile picture.')+'</section>'+
      '<div class="ac-section-head"><div><h2>Workflow readiness</h2><p>Operational status is explicit so the dashboard never implies an unverified workflow is live.</p></div></div>'+
      '<section class="ac-panel"><div class="ac-readiness-list">'+
        ready('◇','Identity verification',kycCount===null?'The KYC queue could not be read; check the existing schema and review route.':kycCount+' application(s) currently await review.',kycCount===null?'Needs checking':(kycCount?'Review queue':'No pending cases'),kycCount!==null)+
        ready('↓','Deposits',pendingDepositCount===null?'The pending deposit queue could not be read; inspect the deposit workspace and schema.':pendingDepositCount+' request(s) await manual evidence and payment verification.','Deposit review '+(pendingDepositCount===null?'needs checking':'available'),pendingDepositCount!==null)+
        ready('↑','Withdrawals',pendingWithdrawalCount===null?'The pending withdrawal queue could not be read; inspect the withdrawal workspace and schema.':pendingWithdrawalCount+' request(s) await eligibility and maturity review. A real transfer must be verified before marking paid.','Withdrawal review '+(pendingWithdrawalCount===null?'needs checking':'available'),pendingWithdrawalCount!==null)+
        ready('◆','Investment packages',packageCount===null?'The package table could not be read; check its schema and the investment workspace.':activePackageCount+' active package(s) out of '+packageCount+' configured. Active member investment records: '+(activeInvestmentCount===null?'unavailable':activeInvestmentCount)+'.','Package manager '+(packageCount===null?'needs checking':'available'),packageCount!==null)+
        ready('◉','Community moderation',pendingCommunityCount===null?'The community review queue could not be read; check its schema and moderation workspace.':pendingCommunityCount+' post(s) awaiting review.','Moderation '+(pendingCommunityCount===null?'needs checking':'available'),pendingCommunityCount!==null)+
        ready('♙','Online Cooperative',pendingCooperativeCount===null?'The connection review queue could not be read; check its schema and admin review page.':pendingCooperativeCount+' member connection(s) awaiting verification.','Review '+(pendingCooperativeCount===null?'needs checking':'available'),pendingCooperativeCount!==null)+
        ready('♧','Notifications',unreadNotificationCount===null?'The notification table could not be read; check the current schema.':unreadNotificationCount+' unread member notification(s) are recorded.','Notification log '+(unreadNotificationCount===null?'needs checking':'available'),unreadNotificationCount!==null)+
        ready('▤','Administrator access','Protected pages check active administrator roles. Financial and platform permissions must remain separately scoped and audited.','Server checked',true)+
      '</div></section>'+
      (kycCount===null?'<div class="ac-alert" role="status"><strong>KYC setup needed.</strong> The KYC submission table is unavailable. Apply the required migration before expecting applications and review counts to appear.</div>':'');
    res.send(adminControlPage('Overview','/admin',content,req));
  } catch(e) { next(e); }
});
// Administrative sections are intentionally explicit: unsupported workflows are labelled as not connected,
// never filled with fake account or financial records. Main admin sections remain protected by requireAdmin.
const adminSectionInfo = {
  '/admin/deposits': ['Deposits','Review deposit requests and payment references.','A verified payment provider, deposit-request records, and an auditable ledger are not connected yet. No deposit can be approved or credited here.'],
  '/admin/withdrawals': ['Withdrawals','Review payout requests, fees, and processing status.','Withdrawal requests are stored and reviewed here. Administrators must verify maturity and the real transfer; payments are never automatic.'],
  '/admin/investments': ['Investments','Review investment packages and active investment records.','No verified investment records are connected to this control centre yet. No package returns or earnings are being fabricated.'],
  '/admin/transactions': ['Transactions','Inspect recorded financial transactions.','A unified transaction ledger is not connected yet. This page will not invent transactions or balances.'],
  '/admin/balances': ['Balance management','Record authorised credits, debits, bonuses, refunds, and adjustments.','Financial adjustments are unavailable until a transactional ledger and idempotent balance rules are implemented and verified.'],
  '/admin/earnings': ['Profits & bonuses','Review separately recorded profit and bonus operations.','No verified profit/bonus ledger is connected. Do not use this page to promise or fabricate earnings.'],
  '/admin/referrals': ['Referral monitoring','Review platform referral activity and eligible earnings.','Referral attribution exists in member registration, but platform-wide earnings and audit reporting are not yet connected here.'],
  '/admin/academy': ['Academy management','Manage learning content and eligible access.','The existing Academy management data source has not yet been connected to this control centre.'],
  '/admin/sovereign-desk': ['Sovereign Desk','Manage signals and guidance through the dedicated Desk workspace.','Signal records and publication workflows are not yet connected to this Main Admin section.'],  '/admin/notifications': ['Notifications','Review administrative alerts and delivery status.','A persisted notification centre is not yet connected. No alerts are being presented as delivered.'],  '/admin/settings': ['Platform settings','Review supported administrative configuration.','No safe platform-settings editor is connected. Sensitive configuration remains environment-managed.'],
  '/admin/audit': ['Audit & access','Review provisioned administrator access and audit readiness.','Administrator roles are read from the database. A complete immutable audit stream is not yet connected.']};
app.get('/admin/transactions', requireFinanceAdmin, requireWebCategoryAccess('financial_operations','view'), async (req,res,next) => {
  try {
    const [rows] = await pool.query('SELECT f.id,f.member_id,f.transaction_type,f.currency,f.amount,f.reference,f.admin_note,f.created_at,m.full_name,m.username,m.monarch_uid FROM financial_transactions f LEFT JOIN members m ON m.id=f.member_id ORDER BY f.created_at DESC LIMIT 500');
    const money = (currency, amount) => esc(String(currency || '') + ' ' + Number(amount || 0).toLocaleString('en-US',{maximumFractionDigits:8}));
    const tableRows = rows.map(t => '<tr><td>'+esc(t.created_at)+'</td><td><strong>'+esc(t.full_name || t.username || ('Member #'+t.member_id))+'</strong><br><small>'+esc(t.monarch_uid || '')+'</small></td><td>'+esc(String(t.transaction_type || 'transaction').replace(/[_-]+/g,' '))+'</td><td>'+money(t.currency,t.amount)+'</td><td>'+esc(t.reference || ('TX-'+t.id))+(t.admin_note?'<br><small>'+esc(t.admin_note)+'</small>':'')+'</td></tr>').join('');
    const content = '<section class="ac-panel"><div class="ac-page-head"><div><h2>Recorded transactions</h2><p class="muted">Financial ledger entries recorded by the platform.</p></div><span class="ac-pill">'+rows.length+' records</span></div>' +
      (rows.length ? '<div class="ac-table-wrap"><table class="ac-table"><thead><tr><th>Date</th><th>Member</th><th>Type</th><th>Amount</th><th>Reference</th></tr></thead><tbody>'+tableRows+'</tbody></table></div>' : '<div class="ac-coming"><strong>No ledger entries recorded yet</strong><p>Approved deposits should create ledger entries. Pending deposit and withdrawal requests are shown in their own review sections until they become completed financial transactions.</p></div>') +
      '</section>';
    res.send(adminControlPage('Transactions','/admin/transactions',content,req));
  } catch(e) { if(e.code==='ER_NO_SUCH_TABLE'||e.code==='ER_BAD_FIELD_ERROR') return res.status(503).send(adminControlPage('Transactions','/admin/transactions','<section class="ac-panel"><h2>Transaction ledger setup required</h2><p class="muted">Apply migrations/006_deposit_payment_workflow.sql, 011_investment_packages_and_purchases.sql and 016_financial_activity_and_earnings.sql in order after backing up the database.</p></section>',req)); next(e); }
});
for (const [route, info] of Object.entries(adminSectionInfo)) {
  if (['/admin/deposits','/admin/withdrawals','/admin/investments','/admin/referrals','/admin/academy','/admin/sovereign-desk','/admin/notifications','/admin/audit','/admin/settings','/admin/earnings'].includes(route)) continue;
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

app.get('/admin/earnings', requireFinanceAdmin, requireWebCategoryAccess('financial_operations','view'), async (req,res,next) => {
  try {
    const [members] = await pool.execute("SELECT id,full_name,username,monarch_uid FROM members ORDER BY full_name ASC,username ASC LIMIT 1000");
    const [rows] = await pool.execute("SELECT f.id,f.member_id,f.transaction_type,f.currency,f.amount,f.reference,f.admin_note,f.created_at,m.full_name,m.username,m.monarch_uid FROM financial_transactions f LEFT JOIN members m ON m.id=f.member_id WHERE f.transaction_type IN ('admin_bonus','investment_profit','loss_adjustment') ORDER BY f.created_at DESC LIMIT 300");
    const fmt=(c,a)=>esc(String(c||'')+' '+Number(a||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:8}));
    const records=rows.map(t=>'<tr><td>'+esc(t.created_at)+'</td><td><strong>'+esc(t.full_name||t.username||('Member #'+t.member_id))+'</strong><br><small>'+esc(t.monarch_uid||'')+'</small></td><td>'+esc(String(t.transaction_type).replace(/_/g,' '))+'</td><td class="'+(Number(t.amount)<0?'tx-negative':'tx-positive')+'">'+fmt(t.currency,t.amount)+'</td><td>'+esc(t.admin_note||'—')+'<br><small>'+esc(t.reference)+'</small></td></tr>').join('');
    const options=members.map(m=>'<option value="'+Number(m.id)+'">'+esc((m.full_name||m.username||'Member')+' · '+(m.monarch_uid||('ID '+m.id)))+'</option>').join('');
    const notice=req.query.saved==='1'?'<div class="ac-feedback is-success" role="status"><strong>Ledger entry recorded.</strong><span>The wallet and transaction history were updated.</span></div>':req.query.error==='1'?'<div class="ac-feedback is-error" role="alert"><strong>Could not record the adjustment.</strong><span>Check the wallet balance and try again.</span></div>':'';
    const content='<section class="ac-panel"><div class="ac-page-head"><div><h2>Profits &amp; bonuses</h2><p class="muted">Record authorised member credits or loss adjustments. Each entry updates the real wallet and creates a financial ledger record.</p></div><span class="ac-pill">'+rows.length+' records</span></div>'+notice+
      '<style>.earnings-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;padding:18px;border:1px solid #413821;border-radius:16px;background:linear-gradient(145deg,#1a1915,#111113);margin:18px 0}.earnings-form label{display:grid;gap:7px;color:#d8d0bd;font-size:12px;font-weight:700}.earnings-form input,.earnings-form select,.earnings-form textarea{width:100%;min-width:0;padding:12px;border:1px solid #413b2d;border-radius:10px;background:#0d0d10;color:#f4eedf;font:inherit}.earnings-form .wide{grid-column:1/-1}.earnings-form button{justify-self:start}.earnings-help{font-size:12px;line-height:1.65;color:#a8a193}.tx-positive{color:#9bd0a8}.tx-negative{color:#e7a59a}.ac-feedback{display:grid;gap:4px;padding:13px 15px;border-radius:12px;margin:14px 0;font-size:13px}.ac-feedback.is-success{border:1px solid #2d4938;background:#121e17;color:#a8dfb4}.ac-feedback.is-error{border:1px solid #523532;background:#211514;color:#f0b2a7}@media(max-width:620px){.earnings-form{grid-template-columns:1fr}.earnings-form .wide{grid-column:auto}}</style>'+
      '<h3>Record a wallet adjustment</h3><p class="earnings-help">Use a positive amount for a bonus or approved profit. A loss adjustment deducts the specified amount and is rejected if the wallet does not have enough funds. This form does not calculate or promise investment returns automatically.</p>'+
      '<form method="post" action="/admin/earnings" class="earnings-form">'+csrfField(req)+
      '<label class="wide">Member<select name="member_id" required><option value="">Choose a member</option>'+options+'</select></label>'+
      '<label>Adjustment type<select name="operation" required><option value="admin_bonus">Bonus credit</option><option value="investment_profit">Approved profit credit</option><option value="loss_adjustment">Loss adjustment (deduct)</option></select></label>'+
      '<label>Wallet currency<select name="currency" required><option value="USD">USD · US dollar</option><option value="NGN">NGN · Naira</option></select></label>'+
      '<label>Amount<input name="amount" inputmode="decimal" pattern="\\d{1,12}(\\.\\d{1,8})?" required placeholder="0.00"></label>'+
      '<label class="wide">Reason / note<textarea name="note" rows="2" maxlength="500" required placeholder="Explain the authorised adjustment"></textarea></label>'+
      '<div class="wide"><button class="copy-btn" type="submit">Record adjustment securely</button></div></form>'+
      '<h3>Recorded profit, bonus &amp; loss entries</h3>'+
      (rows.length?'<div class="ac-table-wrap"><table class="ac-table"><thead><tr><th>Date</th><th>Member</th><th>Entry</th><th>Amount</th><th>Reason / reference</th></tr></thead><tbody>'+records+'</tbody></table></div>':'<div class="ac-coming"><strong>No profit, bonus or loss entries yet</strong><p>Once an authorised adjustment is recorded, it will appear here and in the member transaction history.</p></div>')+
      '<p class="muted small">All adjustments are recorded in the financial ledger and audit log. Review the member and currency carefully before submitting.</p></section>';
    res.send(adminControlPage('Profits & bonuses','/admin/earnings',content,req));
  } catch(e) {
    if(e&&(e.code==='ER_NO_SUCH_TABLE'||e.code==='ER_BAD_FIELD_ERROR')) return res.status(503).send(dbSetupNotice('Financial activity setup required','migrations/016_financial_activity_and_earnings.sql'));
    next(e);
  }
});

app.post('/admin/earnings', requireFinanceAdmin, express.urlencoded({extended:false,limit:'10kb'}), csrfCheck, requireWebCategoryAccess('financial_operations','manage'), async (req,res,next) => {
  const memberId=Number(req.body.member_id),operation=String(req.body.operation||''),currency=String(req.body.currency||''),amountText=String(req.body.amount||'').trim(),note=String(req.body.note||'').trim().slice(0,500);
  if(!Number.isSafeInteger(memberId)||memberId<1||!['admin_bonus','investment_profit','loss_adjustment'].includes(operation)||!['NGN','USD'].includes(currency)||!/^\d{1,12}(?:\.\d{1,8})?$/.test(amountText)||!Number.isFinite(Number(amountText))||Number(amountText)<=0||!note) return res.status(400).send(formError('Check adjustment details','Choose a member, valid currency, positive amount and clear reason.','/admin/earnings'));
  let conn;
  try {
    conn=await pool.getConnection(); await conn.beginTransaction();
    const [[member]]=await conn.execute('SELECT id,username,full_name FROM members WHERE id=? LIMIT 1 FOR UPDATE',[memberId]);
    if(!member){await conn.rollback();return res.status(404).send(formError('Member not found','Refresh the member list and try again.','/admin/earnings'));}
    if(operation==='investment_profit'){
      const [[matured]]=await conn.execute("SELECT COUNT(*) AS total FROM member_investments WHERE member_id=? AND currency=? AND matures_at IS NOT NULL AND matures_at<=CURRENT_TIMESTAMP AND status IN ('active','matured')",[memberId,currency]);
      if(!Number(matured.total)){await conn.rollback();conn.release();conn=null;return res.status(409).send(formError('Investment not yet mature','Approved investment profit can only be credited after at least one matching-currency investment reaches its maturity date.','/admin/earnings'));}
    }
    await conn.execute('INSERT INTO member_wallets (member_id,currency,balance) VALUES (?,?,0) ON DUPLICATE KEY UPDATE member_id=VALUES(member_id)',[memberId,currency]);
    const [[wallet]]=await conn.execute('SELECT id,balance FROM member_wallets WHERE member_id=? AND currency=? LIMIT 1 FOR UPDATE',[memberId,currency]);
    const amount=Number(amountText);
    if(operation==='loss_adjustment'&&Number(wallet.balance)+1e-8<amount){await conn.rollback();conn.release();conn=null;return res.redirect('/admin/earnings?error=1');}
    const signedAmount=operation==='loss_adjustment'?-amount:amount;
    const [update]=await conn.execute('UPDATE member_wallets SET balance=balance+? WHERE id=? AND (? >= 0 OR balance+? >= 0)',[signedAmount,wallet.id,signedAmount,signedAmount]);
    if(update.affectedRows!==1){await conn.rollback();conn.release();conn=null;return res.redirect('/admin/earnings?error=1');}
    const reference='ADJ-'+crypto.randomUUID().replace(/-/g,'').toUpperCase();
    await conn.execute('INSERT INTO financial_transactions (member_id,investment_id,admin_member_id,transaction_type,currency,amount,reference,admin_note) VALUES (?,NULL,?,?,?,?,?,?)',[memberId,req.session.memberId,operation,currency,signedAmount,reference,note]);
    const title=operation==='admin_bonus'?'Bonus credited':operation==='investment_profit'?'Profit credited':'Wallet loss adjustment';
    const body=operation==='loss_adjustment'?'A wallet adjustment of '+amountText+' '+currency+' was recorded. Reason: '+note:'A '+(operation==='admin_bonus'?'bonus':'approved profit')+' of '+amountText+' '+currency+' was credited to your wallet. Reason: '+note;
    try{await conn.execute('INSERT INTO member_notifications (member_id,notification_type,title,body,target_url,dedupe_key) VALUES (?,?,?,?,?,?)',[memberId,'financial_adjustment',title,body.slice(0,1000),'/transactions','financial-adjustment:'+reference]);}catch(ne){if(ne.code!=='ER_NO_SUCH_TABLE')throw ne;}
    try{await conn.execute('INSERT INTO admin_audit_log (admin_member_id,action,target_type,target_id,details,ip_address) VALUES (?,?,?,?,?,?)',[req.session.memberId,'financial.'+operation,'member',String(memberId),JSON.stringify({currency,amount:amountText,reference,note}),req.ip||null]);}catch(ae){if(ae.code!=='ER_NO_SUCH_TABLE')throw ae;}
    await conn.commit(); conn.release(); conn=null;
    res.redirect('/admin/earnings?saved=1');
  } catch(e) {
    if(conn){try{await conn.rollback()}catch(_){}conn.release();}
    if(e&&(e.code==='ER_NO_SUCH_TABLE'||e.code==='ER_BAD_FIELD_ERROR'))return res.status(503).send(dbSetupNotice('Financial activity setup required','migrations/016_financial_activity_and_earnings.sql'));
    next(e);
  }
});

app.get('/admin/investments', requireFinanceAdmin, requireWebCategoryAccess('invest_market','view'), async (req,res,next) => {
  try {
    const [packages]=await pool.execute('SELECT id,name,description,currency,price,duration_days,terms,status,created_at,updated_at FROM investment_packages ORDER BY created_at DESC,id DESC');
    const rows=packages.map(p=>{
      const status=String(p.status||'draft');
      const cls=status==='active'?'ip-active':status==='inactive'?'ip-inactive':'ip-draft';
      return '<article class="ip-card" data-package-card data-search="'+esc([p.name,p.description,p.currency,p.status].join(' '))+'">'+
        '<div class="ip-card-head"><span class="ip-cube">◇</span><span class="ip-status '+cls+'">'+esc(status)+'</span></div>'+
        '<h3>'+esc(p.name)+'</h3><p class="ip-desc">'+esc(p.description||'No description added yet.')+'</p>'+
        '<small class="ip-muted">PACKAGE PRICE</small><div class="ip-price">'+esc(p.currency)+' <strong>'+Number(p.price).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:8})+'</strong></div>'+
        '<div class="ip-meta"><div><small>Duration</small><b>'+(p.duration_days?esc(p.duration_days)+' days':'Flexible')+'</b></div><div><small>Package ID</small><b>#'+Number(p.id)+'</b></div></div>'+
        '<div class="ip-actions"><button class="ip-btn ip-edit" type="button" data-edit-package data-id="'+p.id+'" data-name="'+esc(p.name)+'" data-description="'+esc(p.description||'')+'" data-currency="'+esc(p.currency)+'" data-price="'+esc(p.price)+'" data-duration="'+esc(p.duration_days||'')+'" data-terms="'+esc(p.terms||'')+'" data-status="'+esc(status)+'">✎ &nbsp; Edit package</button>'+
        '<form method="post" action="/admin/investments/packages">'+csrfField(req)+'<input type="hidden" name="id" value="'+p.id+'"><input type="hidden" name="name" value="'+esc(p.name)+'"><input type="hidden" name="description" value="'+esc(p.description||'')+'"><input type="hidden" name="currency" value="'+esc(p.currency)+'"><input type="hidden" name="price" value="'+esc(p.price)+'"><input type="hidden" name="duration_days" value="'+esc(p.duration_days||'')+'"><input type="hidden" name="terms" value="'+esc(p.terms||'')+'"><button class="ip-btn ip-toggle" name="status" value="'+(status==='active'?'inactive':'active')+'" type="submit">'+(status==='active'?'Ⅱ &nbsp; Pause package':'✓ &nbsp; Activate package')+'</button></form></div></article>';
    }).join('');
    const content='<section class="ip-shell"><header class="ip-hero"><div><small>✦ &nbsp; FINANCE CONTROL CENTER</small><h2>Investment packages</h2><p>Create, refine and publish your offerings from one workspace.</p></div><span class="ip-brand">MC<small>MONARCH<br>CODEX</small></span></header>'+
      '<div class="ip-stats"><div><small>Total packages</small><strong>'+packages.length+'</strong></div><div><small>Active packages</small><strong>'+packages.filter(p=>p.status==='active').length+'</strong></div><div><small>Draft / inactive</small><strong>'+packages.filter(p=>p.status!=='active').length+'</strong></div></div>'+
      '<section class="ip-panel" id="ip-editor"><div class="ip-panel-title"><div><small>PACKAGE WORKSPACE</small><h3 id="ip-form-title">Create a package</h3><p id="ip-form-subtitle">Enter the details and terms before publishing.</p></div><span id="ip-mode">NEW PACKAGE</span></div>'+
      '<form id="investment-package-form" method="post" action="/admin/investments/packages" class="ip-form">'+csrfField(req)+'<input type="hidden" name="id" value="">'+
      '<label>Package name<input name="name" required maxlength="120" placeholder="e.g. Monarch Growth Plan"></label><label>Currency<select name="currency" required><option value="NGN">NGN · Nigerian naira</option><option value="USD">USD · US dollar</option></select></label>'+
      '<label>Package price<input name="price" inputmode="decimal" required placeholder="0.00"></label><label>Duration in days <span class="ip-muted">Optional</span><input name="duration_days" inputmode="numeric" placeholder="e.g. 30"></label>'+
      '<label class="ip-wide">Description<textarea name="description" rows="3" maxlength="1000" placeholder="Describe this package clearly."></textarea></label><label class="ip-wide">Terms and conditions<textarea name="terms" rows="4" maxlength="2000" required placeholder="Explain maturity, risk, exit and withdrawal terms. Do not promise guaranteed returns."></textarea><small class="ip-muted">Be transparent about risks, eligibility and withdrawal conditions.</small></label>'+
      '<label>Publication status<select name="status"><option value="draft">Draft · not visible</option><option value="active">Active · visible to members</option><option value="inactive">Inactive · hidden</option></select></label>'+
      '<div class="ip-form-actions"><button class="ip-btn ip-save" id="investment-package-submit" type="submit">＋ &nbsp; Save package</button><button class="ip-btn ip-secondary" id="investment-package-cancel" type="button" hidden>Cancel editing</button><button class="ip-btn ip-secondary" id="investment-package-reset" type="reset">Clear form</button></div></form></section>'+
      '<section class="ip-catalog"><div class="ip-catalog-head"><div><small>YOUR CATALOG</small><h3>All packages <span>'+packages.length+'</span></h3><p>Search, edit, activate or pause your packages.</p></div><input id="ip-search" type="search" placeholder="⌕  Search packages…" aria-label="Search packages"></div>'+
      '<div class="ip-grid" id="ip-grid">'+(rows||'<div class="ip-empty">◇<h3>No packages yet</h3><p>Create your first package above.</p></div>')+'</div><p id="ip-no-results" hidden>No packages match your search.</p></section>'+
      '<p class="ip-note">ⓘ &nbsp; Package changes update the catalog. Existing member purchases and recorded terms should remain unchanged. Publish only reviewed terms.</p></section>'+
      '<style>.ip-shell{--gold:#e8c56d;--muted:#a5a4ae;color:#f7f6f2;display:grid;gap:20px;padding-bottom:24px}.ip-hero{display:flex;justify-content:space-between;align-items:center;gap:15px;padding:26px;border:1px solid #4c4027;border-radius:20px;background:radial-gradient(ellipse at 90% 0%,#49391b,transparent 45%),linear-gradient(120deg,#201d17,#111115)}.ip-hero small,.ip-panel-title small,.ip-catalog-head small{font-size:10px;letter-spacing:1.5px;font-weight:850;color:var(--gold)}.ip-hero h2{font-size:clamp(25px,4vw,35px);margin:12px 0 7px;font-weight:900;letter-spacing:-.8px}.ip-hero p,.ip-panel-title p,.ip-catalog-head p{font-size:12px;line-height:1.6;color:var(--muted);margin:0}.ip-brand{display:flex;align-items:center;gap:9px;color:#f7e4a6;font-weight:900;font-size:20px}.ip-brand:before{content:"";display:block;width:48px;height:48px;border:1px solid #8d7137;border-radius:14px;background:#292216}.ip-brand small{font-size:8px;line-height:1.5;color:#d8c99e;letter-spacing:1px}.ip-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.ip-stats>div{display:grid;gap:8px;padding:17px;border:1px solid #303039;border-radius:15px;background:linear-gradient(145deg,#1e1e24,#151519)}.ip-stats small,.ip-muted{font-size:10px;color:var(--muted)}.ip-stats strong{font-size:26px;font-weight:900}.ip-panel{padding:23px;border:1px solid #303039;border-radius:19px;background:#19191f}.ip-panel-title,.ip-catalog-head{display:flex;justify-content:space-between;align-items:center;gap:15px;margin-bottom:20px}.ip-panel-title h3,.ip-catalog-head h3{font-size:20px;margin:7px 0 5px;font-weight:850}.ip-panel-title>span{font-size:9px;letter-spacing:1px;color:#f4d989;background:#2a2418;border:1px solid #51442a;border-radius:99px;padding:7px 10px;white-space:nowrap}.ip-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:15px}.ip-form label{display:grid;gap:8px;min-width:0;font-size:12px;font-weight:750;color:#e7e5df}.ip-form input,.ip-form select,.ip-form textarea,.ip-catalog-head input{box-sizing:border-box;width:100%;min-width:0;padding:12px;border:1px solid #3a3943;border-radius:10px;background:#101014;color:#f7f6f2;font:inherit;font-size:13px;outline:none}.ip-form input:focus,.ip-form select:focus,.ip-form textarea:focus,.ip-catalog-head input:focus{border-color:#b99a4f;box-shadow:0 0 0 3px #e8c56d1a}.ip-form textarea{resize:vertical;line-height:1.6}.ip-form input::placeholder,.ip-form textarea::placeholder,.ip-catalog-head input::placeholder{color:#777681}.ip-wide,.ip-form-actions{grid-column:1/-1}.ip-form-actions{display:flex;gap:9px;flex-wrap:wrap;padding-top:4px}.ip-btn{display:inline-flex;align-items:center;justify-content:center;min-height:42px;padding:10px 13px;border:1px solid #42414b;border-radius:10px;background:#24232a;color:#f5f3ed;font:inherit;font-size:12px;font-weight:800;cursor:pointer;transition:transform .15s,border-color .15s}.ip-btn:hover{transform:translateY(-1px);border-color:#a88b48}.ip-btn:focus-visible{outline:2px solid var(--gold);outline-offset:3px}.ip-save{background:linear-gradient(135deg,#f5df9b,#d4ae51);border-color:#e5c46e;color:#20190b}.ip-secondary{background:transparent}.ip-catalog{display:grid;gap:15px}.ip-catalog-head{align-items:end;margin:0}.ip-catalog-head h3 span{font-size:12px;color:#f4d989;background:#2a2418;border-radius:99px;padding:3px 8px}.ip-catalog-head input{max-width:250px}.ip-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.ip-card{min-width:0;padding:18px;border:1px solid #33323b;border-radius:16px;background:linear-gradient(155deg,#202026,#151519);transition:border-color .15s}.ip-card:hover{border-color:#66542f}.ip-card-head{display:flex;justify-content:space-between;align-items:center}.ip-cube{display:grid;place-items:center;width:38px;height:38px;border:1px solid #51442a;border-radius:11px;background:#2a2418;color:var(--gold);font-size:24px}.ip-status{padding:6px 9px;border-radius:99px;text-transform:uppercase;font-size:9px;letter-spacing:.6px;font-weight:850}.ip-active{color:#9ee2b3;background:#183326}.ip-inactive{color:#c1bdcb;background:#2b2931}.ip-draft{color:#e8c56d;background:#342c1a}.ip-card h3{font-size:18px;margin:14px 0 6px;overflow-wrap:anywhere}.ip-desc{min-height:35px;margin:0 0 15px;color:var(--muted);font-size:12px;line-height:1.6;overflow-wrap:anywhere}.ip-price{font-size:12px;color:#f7e4a6;margin-top:5px;overflow-wrap:anywhere}.ip-price strong{font-size:23px;letter-spacing:-.5px}.ip-meta{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:15px;padding:13px 0;border-top:1px solid #323139;border-bottom:1px solid #323139}.ip-meta>div{display:grid;gap:5px;min-width:0}.ip-meta small{font-size:10px;color:var(--muted)}.ip-meta b{font-size:12px;overflow-wrap:anywhere}.ip-actions{display:grid;gap:8px;margin-top:13px}.ip-actions form{margin:0}.ip-actions .ip-btn{width:100%;box-sizing:border-box}.ip-edit{background:#2a2418;border-color:#62502b;color:#f4d989}.ip-toggle{background:#25242b}.ip-empty{grid-column:1/-1;padding:30px;text-align:center;border:1px dashed #4b4852;border-radius:15px;color:var(--gold);font-size:28px}.ip-empty h3{font-size:17px;color:#fff;margin:8px}.ip-empty p,#ip-no-results{font-size:12px;color:var(--muted)}.ip-note{margin:0;color:var(--muted);font-size:11px;line-height:1.7}.ip-shell [hidden]{display:none!important}@media(max-width:700px){.ip-shell{gap:14px}.ip-hero{padding:20px 17px;border-radius:16px}.ip-brand{display:none}.ip-stats{gap:7px}.ip-stats>div{padding:12px 9px;gap:7px}.ip-stats small{font-size:9px;line-height:1.4}.ip-stats strong{font-size:22px}.ip-panel{padding:17px 14px}.ip-panel-title{align-items:flex-start;gap:8px}.ip-panel-title h3,.ip-catalog-head h3{font-size:18px}.ip-form{grid-template-columns:1fr;gap:13px}.ip-wide,.ip-form-actions{grid-column:1}.ip-form-actions .ip-btn{flex:1}.ip-catalog-head{display:grid;align-items:stretch}.ip-catalog-head input{max-width:none}.ip-grid{grid-template-columns:1fr}.ip-desc{min-height:0}.ip-card{padding:16px}}}</style>'+
      '<script>(function(){var form=document.getElementById("investment-package-form");if(!form)return;var title=document.getElementById("ip-form-title"),subtitle=document.getElementById("ip-form-subtitle"),mode=document.getElementById("ip-mode"),submit=document.getElementById("investment-package-submit"),cancel=document.getElementById("investment-package-cancel"),reset=document.getElementById("investment-package-reset"),search=document.getElementById("ip-search"),cards=Array.prototype.slice.call(document.querySelectorAll("[data-package-card]")),empty=document.getElementById("ip-no-results");function createMode(){form.reset();form.elements.id.value="";title.textContent="Create a package";subtitle.textContent="Enter the details and terms before publishing.";mode.textContent="NEW PACKAGE";submit.textContent="＋ Save package";cancel.hidden=true;}document.querySelectorAll("[data-edit-package]").forEach(function(b){b.addEventListener("click",function(){form.elements.id.value=b.dataset.id||"";form.elements.name.value=b.dataset.name||"";form.elements.description.value=b.dataset.description||"";form.elements.currency.value=b.dataset.currency||"NGN";form.elements.price.value=b.dataset.price||"";form.elements.duration_days.value=b.dataset.duration||"";form.elements.terms.value=b.dataset.terms||"";form.elements.status.value=b.dataset.status||"draft";title.textContent="Edit package";subtitle.textContent="Make your changes, then save to update this package.";mode.textContent="EDITING #"+b.dataset.id;submit.textContent="✓ Update package";cancel.hidden=false;document.getElementById("ip-editor").scrollIntoView({behavior:"smooth",block:"start"});form.elements.name.focus({preventScroll:true});});});cancel.addEventListener("click",createMode);reset.addEventListener("click",function(){window.setTimeout(createMode,0);});search.addEventListener("input",function(){var q=search.value.trim().toLowerCase(),n=0;cards.forEach(function(c){var show=(c.dataset.search||"").toLowerCase().indexOf(q)!==-1;c.hidden=!show;if(show)n++;});empty.hidden=n!==0;});form.addEventListener("submit",function(){submit.disabled=true;submit.textContent="Saving…";});})();</script>';
    res.set('Cache-Control','no-store');
    res.send(adminControlPage('Investments','/admin/investments',content,req));
  } catch(e) {
    if(e&&e.code==='ER_NO_SUCH_TABLE') return res.status(503).send(dbSetupNotice('Investment setup required','migrations/011_investment_packages_and_purchases.sql'));
    next(e);
  }
});
app.post('/admin/investments/packages', requireFinanceAdmin, express.urlencoded({extended:false,limit:'10kb'}), csrfCheck, requireWebCategoryAccess('invest_market','manage'), async (req,res,next) => {
  const id=String(req.body.id||'').trim(),name=String(req.body.name||'').trim().slice(0,120),description=String(req.body.description||'').trim().slice(0,1000),currency=String(req.body.currency||''),priceText=String(req.body.price||'').trim(),durationText=String(req.body.duration_days||'').trim(),terms=String(req.body.terms||'').trim().slice(0,2000),status=String(req.body.status||'draft');
  if(!name||!['NGN','USD'].includes(currency)||!/^\d{1,12}(?:\.\d{1,8})?$/.test(priceText)||Number(priceText)<=0||!(durationText===''||/^\d{1,5}$/.test(durationText))||!['draft','active','inactive'].includes(status)||!terms) return res.status(400).send(formError('Check package details','Provide a name, valid positive price, currency, optional duration and clear terms.','/admin/investments'));
  try {
    if(id){
      if(!/^\d{1,20}$/.test(id)) return res.status(400).send(formError('Invalid package','Refresh the package list and try again.','/admin/investments'));
      await pool.execute('UPDATE investment_packages SET name=?,description=?,currency=?,price=?,duration_days=?,terms=?,status=? WHERE id=?',[name,description,currency,priceText,durationText||null,terms,status,id]);
    } else {
      await pool.execute('INSERT INTO investment_packages (name,description,currency,price,duration_days,terms,status,created_by) VALUES (?,?,?,?,?,?,?,?)',[name,description,currency,priceText,durationText||null,terms,status,req.session.memberId]);
    }
    try{await pool.execute('INSERT INTO admin_audit_log (admin_member_id,action,target_type,target_id,details,ip_address) VALUES (?,?,?,?,?,?)',[req.session.memberId,id?'investment_package.updated':'investment_package.created','investment_package',id||null,JSON.stringify({name,currency,price:priceText,duration_days:durationText||null,status}),req.ip||null]);}catch(auditError){if(auditError.code!=='ER_NO_SUCH_TABLE')throw auditError;}
    res.redirect('/admin/investments');
  } catch(e){if(e&&e.code==='ER_NO_SUCH_TABLE')return res.status(503).send(dbSetupNotice('Investment setup required','migrations/011_investment_packages_and_purchases.sql'));next(e);}
});
app.get('/admin/withdrawals', requireFinanceAdmin, requireWebCategoryAccess('financial_operations','view'), async (req,res,next)=>{
  try{
    const [requests]=await pool.query('SELECT w.*,m.username,m.full_name,m.email FROM withdrawal_requests w JOIN members m ON m.id=w.member_id ORDER BY CASE w.status WHEN \'pending\' THEN 0 WHEN \'approved\' THEN 1 ELSE 2 END,w.created_at DESC LIMIT 200');
    const rows=requests.map(w=>{
      let bank={};
      try{bank=JSON.parse(decryptProfileValue(w.bank_details_ciphertext));}catch(_){}
      const account='<strong>'+esc(bank.bankName||'Saved bank account')+'</strong><br>'+esc(bank.bankAccountName||'Account holder')+'<br><span class="withdraw-admin-account">'+esc(bank.bankAccountNumber||'Unavailable')+'</span>';
      const action=w.status==='pending'
        ? '<form method="post" action="/admin/withdrawals/'+Number(w.id)+'/review" class="withdraw-admin-form">'+csrfField(req)+'<label>Review note</label><textarea name="reviewer_note" rows="2" maxlength="1000" placeholder="Maturity/eligibility review notes"></textarea><button class="copy-btn" name="decision" value="approved" type="submit" onclick="return confirm(&quot;Approve only after independently confirming the funds are eligible and mature?&quot;)">Approve request</button><button class="copy-btn withdraw-reject-btn" name="decision" value="rejected" type="submit">Reject request</button></form>'
        : w.status==='approved'
          ? '<form method="post" action="/admin/withdrawals/'+Number(w.id)+'/review" class="withdraw-admin-form">'+csrfField(req)+'<label>Actual transfer reference (required)</label><input name="payment_reference" maxlength="190" required placeholder="Bank transfer reference"><label>Payment note</label><textarea name="reviewer_note" rows="2" maxlength="1000" placeholder="Verified transfer details"></textarea><button class="copy-btn" name="decision" value="paid" type="submit" onclick="return confirm(&quot;Confirm the real transfer has been completed before marking this request paid?&quot;)">Confirm transfer &amp; mark paid</button></form>'
          : '<span class="muted small">'+esc(w.payment_reference||'No payment reference')+'</span>';
      return '<tr><td>#'+Number(w.id)+'<br><small>'+esc(w.created_at)+'</small></td><td><strong>'+esc(w.full_name||w.username)+'</strong><br><small>'+esc(w.email)+'</small><br><span class="muted small">Member #'+Number(w.member_id)+'</span></td><td><strong>'+esc(w.currency+' '+Number(w.amount).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:8}))+'</strong><br><small>Wallet funds are reserved while pending/approved.</small></td><td>'+account+'</td><td><span class="ac-pill">'+esc(w.status.toUpperCase())+'</span>'+(w.member_note?'<p class="muted small">Member: '+esc(w.member_note)+'</p>':'')+(w.reviewer_note?'<p class="muted small">Review: '+esc(w.reviewer_note)+'</p>':'')+'</td><td>'+action+'</td></tr>';
    }).join('');
    const content='<section class="ac-panel"><h2>Withdrawal review queue</h2><p class="muted">Requests unlock after approved KYC, a saved bank account and an unreserved wallet balance. Before approval, independently confirm maturity/eligibility. Only mark a request paid after the transfer has actually been completed and verified. This screen does not send money automatically.</p><div class="ac-table-wrap"><table class="ac-table"><thead><tr><th>Request</th><th>Member</th><th>Amount</th><th>Saved payout destination</th><th>Status / notes</th><th>Action</th></tr></thead><tbody>'+(rows||'<tr><td colspan="6">No withdrawal requests yet.</td></tr>')+'</tbody></table></div></section><style>.withdraw-admin-account{display:inline-block;overflow-wrap:anywhere;margin-top:4px;color:#e9ce86}.withdraw-admin-form{display:grid;gap:8px;min-width:190px}.withdraw-admin-form label{display:grid;gap:5px;font-size:12px}.withdraw-admin-form textarea,.withdraw-admin-form input{width:100%;min-width:0;padding:9px;border:1px solid #45434c;border-radius:8px;background:#0d0d10;color:#fff;font:inherit}.withdraw-reject-btn{background:#352020;color:#ffb5b5;border-color:#744040}</style>';
    res.set('Cache-Control','no-store');
    res.send(adminControlPage('Withdrawals','/admin/withdrawals',content,req));
  }catch(e){if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).send(dbSetupNotice('Withdrawal workflow setup required','migrations/009_withdrawal_requests.sql'));next(e);}
});
app.post('/admin/withdrawals/:id/review', requireFinanceAdmin, express.urlencoded({extended:false,limit:'5kb'}), csrfCheck, requireWebCategoryAccess('financial_operations',req=>req.body.decision==='paid'?'manage':req.body.decision==='approved'?'approve':'reject'), async(req,res,next)=>{
  const id=String(req.params.id||''),decision=String(req.body.decision||''),note=String(req.body.reviewer_note||'').trim().slice(0,1000),paymentReference=String(req.body.payment_reference||'').trim().slice(0,190);
  if(!/^\d{1,20}$/.test(id)||!['approved','rejected','paid'].includes(decision))return res.status(400).send(formError('Invalid withdrawal review','Choose a valid request and review decision.','/admin/withdrawals'));
  if(decision==='paid'&&!paymentReference)return res.status(400).send(formError('Transfer reference required','Enter the reference for the actual completed transfer before marking a withdrawal paid.','/admin/withdrawals'));
  if(decision==='rejected'&&!note)return res.status(400).send(formError('Review note required','Provide a reason so the member knows why the request was rejected.','/admin/withdrawals'));
  try{
    const conn=await pool.getConnection();
    let memberId=null,finalStatus=decision;
    try{
      await conn.beginTransaction();
      const [[w]]=await conn.execute('SELECT id,member_id,currency,amount,status FROM withdrawal_requests WHERE id=? LIMIT 1 FOR UPDATE',[id]);
      if(!w){await conn.rollback();return res.status(404).send(formError('Request not found','This withdrawal request no longer exists.','/admin/withdrawals'));}
      memberId=w.member_id;
      if(decision==='approved'){
        if(w.status!=='pending'){await conn.rollback();return res.status(409).send(formError('Request already reviewed','Only pending withdrawal requests can be approved.','/admin/withdrawals'));}
        await conn.execute("UPDATE withdrawal_requests SET status='approved',reviewer_member_id=?,reviewer_note=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=?",[req.session.memberId,note||null,id]);
      }else if(decision==='rejected'){
        if(!['pending','approved'].includes(w.status)){await conn.rollback();return res.status(409).send(formError('Request cannot be rejected','Only pending or approved requests can be rejected.','/admin/withdrawals'));}
        await conn.execute("UPDATE withdrawal_requests SET status='rejected',reviewer_member_id=?,reviewer_note=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=?",[req.session.memberId,note,id]);
      }else{
        if(w.status!=='approved'){await conn.rollback();return res.status(409).send(formError('Approval required','A withdrawal must be approved before a verified transfer can be recorded.','/admin/withdrawals'));}
        const [[wallet]]=await conn.execute('SELECT id,balance FROM member_wallets WHERE member_id=? AND currency=? LIMIT 1 FOR UPDATE',[w.member_id,w.currency]);
        if(!wallet||Number(wallet.balance)+1e-8<Number(w.amount)){await conn.rollback();return res.status(409).send(formError('Wallet balance changed','The wallet no longer contains enough funds. Reconcile the balance before recording this transfer.','/admin/withdrawals'));}
        await conn.execute('UPDATE member_wallets SET balance=balance-? WHERE id=?',[w.amount,wallet.id]);
        await conn.execute('INSERT INTO withdrawal_ledger_entries (withdrawal_request_id,member_id,currency,amount,payment_reference) VALUES (?,?,?,?,?)',[w.id,w.member_id,w.currency,w.amount,paymentReference]);
        await conn.execute("UPDATE withdrawal_requests SET status='paid',payment_reference=?,reviewer_member_id=?,reviewer_note=?,reviewed_at=CURRENT_TIMESTAMP,paid_at=CURRENT_TIMESTAMP WHERE id=?",[paymentReference,req.session.memberId,note||null,id]);
      }
      await conn.execute('INSERT INTO admin_audit_log (admin_member_id,action,target_type,target_id,details,ip_address) VALUES (?,?,?,?,?,?)',[req.session.memberId,'withdrawal.'+finalStatus,'withdrawal_request',String(id),JSON.stringify({decision,amount:String(w.amount),currency:w.currency,payment_reference:decision==='paid'?paymentReference:null}),req.ip||null]);
      await conn.commit();
    }catch(e){await conn.rollback();throw e;}finally{conn.release();}
    const inAppTitle=decision==='approved'?'Withdrawal request approved':decision==='rejected'?'Withdrawal request rejected':'Withdrawal paid';
    const inAppBody=decision==='approved'?'Your withdrawal request has been approved for processing. It is not paid until a completed transfer is recorded.':decision==='rejected'?'Your withdrawal request was rejected. Review note: '+note:'Your withdrawal has been marked paid after the transfer was verified. Reference: '+paymentReference;
    await pool.execute('INSERT INTO member_notifications (member_id,notification_type,title,body,target_url,dedupe_key) VALUES (?,?,?,?,?,?)',[memberId,'withdrawal_review',inAppTitle,inAppBody.slice(0,1000),'/withdraw','withdrawal-review:'+id+':'+decision+':'+Date.now()]).catch(e=>console.error('[notification] withdrawal review notification failed:',e.message));
    res.redirect('/admin/withdrawals?review='+encodeURIComponent(decision));
  }catch(e){if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).send(dbSetupNotice('Withdrawal workflow setup required','migrations/009_withdrawal_requests.sql'));if(e.code==='ER_DUP_ENTRY')return res.status(409).send(formError('Duplicate transfer reference','This payment reference has already been used. Check the ledger and enter the correct reference.','/admin/withdrawals'));next(e);}
});

app.get('/api/admin/pending-deposit-count', requireFinanceAdmin, async (req,res,next) => {
  try {
    const [[row]] = await pool.query("SELECT COUNT(*) AS count FROM deposit_requests WHERE status='pending'");
    res.set('Cache-Control','no-store');
    res.json({count:Number(row.count)||0});
  } catch(e) {
    if(e.code==='ER_NO_SUCH_TABLE') return res.status(503).json({error:'deposit_workflow_not_configured'});
    next(e);
  }
});

app.get('/admin/deposits', requireFinanceAdmin, requireWebCategoryAccess('financial_operations','view'), async (req,res,next) => {
  try {
    const [[pricing]] = await pool.query('SELECT base_usd_ngn_rate,markup_percent,bank_fee_usd,wallet_fee_usd FROM deposit_pricing_settings WHERE id=1');
    const [methods] = await pool.query('SELECT * FROM deposit_payment_methods ORDER BY is_active DESC,currency,method_type,id DESC');
    const [requests] = await pool.query("SELECT d.*,m.username,m.full_name,m.email,p.label AS payment_label,p.method_type FROM deposit_requests d JOIN members m ON m.id=d.member_id JOIN deposit_payment_methods p ON p.id=d.payment_method_id ORDER BY (d.status='pending') DESC,d.created_at DESC LIMIT 150");
    const methodRows = methods.map(m => {
      const details = m.method_type === 'bank'
        ? '<strong>' + esc(m.bank_name || '') + '</strong><br>Account name: ' + esc(m.account_name || '') + '<br>Account number: ' + esc(m.account_number || '') + (m.bank_code ? '<br>Bank code: ' + esc(m.bank_code) : '')
        : '<strong>' + esc(m.wallet_network || '') + ' · ' + esc(m.wallet_asset || '') + '</strong><br><span style="overflow-wrap:anywhere">' + esc(m.wallet_address || '') + '</span>';
      return '<tr><td><strong>' + esc(m.label) + '</strong><br><small>' + esc(m.currency + ' · ' + m.method_type.toUpperCase()) + '</small></td><td>' + details + (m.instructions ? '<p class="muted small">' + esc(m.instructions) + '</p>' : '') + '</td><td>' + (Number(m.is_active) ? '<span class="ac-pill">Active</span>' : '<span class="ac-pill">Inactive</span>') + '</td><td><form method="post" action="/admin/deposits/methods/' + Number(m.id) + '/status">' + csrfField(req) + '<input type="hidden" name="is_active" value="' + (Number(m.is_active) ? '0' : '1') + '"><button class="copy-btn" type="submit">' + (Number(m.is_active) ? 'Deactivate' : 'Activate') + '</button></form><details style="margin-top:8px"><summary>Edit details</summary><form method="post" action="/admin/deposits/methods">' + csrfField(req) + '<input type="hidden" name="id" value="' + Number(m.id) + '"><label>Label</label><input name="label" maxlength="120" value="' + esc(m.label) + '" required><label>Currency</label><select name="currency"><option value="NGN"' + (m.currency==='NGN'?' selected':'') + '>NGN</option><option value="USD"' + (m.currency==='USD'?' selected':'') + '>USD</option></select><label>Method type</label><select name="method_type"><option value="bank"' + (m.method_type==='bank'?' selected':'') + '>Bank account</option><option value="wallet"' + (m.method_type==='wallet'?' selected':'') + '>Wallet address</option></select><label>Bank name</label><input name="bank_name" maxlength="120" value="' + esc(m.bank_name || '') + '"><label>Account name</label><input name="account_name" maxlength="160" value="' + esc(m.account_name || '') + '"><label>Account number</label><input name="account_number" maxlength="80" value="' + esc(m.account_number || '') + '"><label>Bank code (optional)</label><input name="bank_code" maxlength="80" value="' + esc(m.bank_code || '') + '"><label>Wallet network</label><input name="wallet_network" maxlength="80" value="' + esc(m.wallet_network || '') + '"><label>Wallet asset</label><input name="wallet_asset" maxlength="40" value="' + esc(m.wallet_asset || '') + '"><label>Wallet address</label><input name="wallet_address" maxlength="255" value="' + esc(m.wallet_address || '') + '"><label>Member instructions</label><textarea name="instructions" maxlength="1000" rows="3">' + esc(m.instructions || '') + '</textarea><button class="copy-btn" type="submit">Save changes</button></form></details></td></tr>';
    }).join('');
    const requestRows = requests.map(d => '<tr><td>#' + Number(d.id) + '<br><small>' + esc(d.created_at) + '</small></td><td><strong>' + esc(d.full_name || d.username) + '</strong><br><small>' + esc(d.email) + '</small></td><td>' + esc(d.currency + ' ' + Number(d.amount).toLocaleString('en-US',{maximumFractionDigits:8})) + '<br><small>Fee: ' + esc(d.currency + ' ' + Number(d.fee_amount).toLocaleString('en-US',{maximumFractionDigits:8})) + ' · Total: ' + esc(d.currency + ' ' + Number(d.total_due).toLocaleString('en-US',{maximumFractionDigits:8})) + '</small></td><td>' + esc(d.payment_label) + '<br><small>' + esc(d.payment_reference) + '</small><br><a href="/admin/deposits/' + Number(d.id) + '/proof">Download proof</a></td><td><span class="ac-pill">' + esc(d.status.toUpperCase()) + '</span>' + (d.reviewer_note ? '<p class="muted small">' + esc(d.reviewer_note) + '</p>' : '') + '</td><td>' + (d.status === 'pending' ? '<form method="post" action="/admin/deposits/' + Number(d.id) + '/review">' + csrfField(req) + '<label>Review note</label><input name="reviewer_note" maxlength="1000" placeholder="Verification notes"><button class="copy-btn" name="decision" value="approved" formaction="/admin/deposits/' + Number(d.id) + '/review?decision=approved" type="submit">Approve & credit</button> <button class="copy-btn" name="decision" value="rejected" formaction="/admin/deposits/' + Number(d.id) + '/review?decision=rejected" type="submit">Reject</button></form>' : esc(d.reviewed_at || '—')) + '</td></tr>').join('');
    const effective = pricing && pricing.base_usd_ngn_rate !== null ? Number(pricing.base_usd_ngn_rate) * (1 + Number(pricing.markup_percent)/100) : null;
    const pricingSummary = effective === null ? 'Exchange rate not configured yet. Configure it in Platform settings before members can submit deposits.' : 'Final member conversion rate: ₦' + effective.toLocaleString('en-NG',{maximumFractionDigits:6}) + ' per $1. Bank fee: $' + Number(pricing.bank_fee_usd).toFixed(2) + '; wallet fee: $' + Number(pricing.wallet_fee_usd).toFixed(2) + '.';
    const content = '<section class="ac-panel"><div class="ac-page-head"><div><h2>Payment destinations</h2><p class="muted">Create and edit official bank accounts and wallet addresses. Inactive destinations are hidden from members. Existing methods are deactivated rather than deleted so deposit history remains intact.</p></div><a class="ac-pill" href="/admin/settings">Edit pricing →</a></div><p class="ac-alert">' + esc(pricingSummary) + '</p><details open><summary><strong>Add payment destination</strong></summary><form method="post" action="/admin/deposits/methods">' + csrfField(req) + '<label>Display label</label><input name="label" maxlength="120" placeholder="e.g. Monarch NGN Bank Transfer" required><label>Currency</label><select name="currency" required><option value="NGN">Naira (NGN)</option><option value="USD">US Dollars (USD)</option></select><label>Method type</label><select name="method_type" required><option value="bank">Bank account</option><option value="wallet">Wallet address</option></select><label>Bank name</label><input name="bank_name" maxlength="120"><label>Account name</label><input name="account_name" maxlength="160"><label>Account number</label><input name="account_number" maxlength="80"><label>Bank code (optional)</label><input name="bank_code" maxlength="80"><label>Wallet network</label><input name="wallet_network" maxlength="80" placeholder="e.g. TRC20"><label>Wallet asset</label><input name="wallet_asset" maxlength="40" placeholder="e.g. USDT"><label>Wallet address</label><input name="wallet_address" maxlength="255"><label>Instructions for members (optional)</label><textarea name="instructions" maxlength="1000" rows="3"></textarea><button class="btn" type="submit">Save payment destination</button></form></details><div class="ac-table-wrap"><table class="ac-table"><thead><tr><th>Destination</th><th>Payment details</th><th>Status</th><th>Manage</th></tr></thead><tbody>' + (methodRows || '<tr><td colspan="4">No payment destinations configured. Add a verified bank account or wallet address above.</td></tr>') + '</tbody></table></div></section><section class="ac-panel"><h2>Deposit requests</h2><p class="muted">Requests stay pending until an administrator independently verifies the incoming payment. Approval credits the selected currency wallet exactly once.</p><div class="ac-table-wrap"><table class="ac-table"><thead><tr><th>Request</th><th>Member</th><th>Amount & fee</th><th>Destination / reference</th><th>Status</th><th>Review</th></tr></thead><tbody>' + (requestRows || '<tr><td colspan="6">No deposit requests yet.</td></tr>') + '</tbody></table></div></section>';
    res.send(adminControlPage('Deposits','/admin/deposits',content,req));
  } catch(e) { if(e.code === 'ER_NO_SUCH_TABLE') return res.status(503).send(dbSetupNotice('Deposit workflow setup required','migrations/006_deposit_payment_workflow.sql')); next(e); }
});
app.post('/admin/deposits/methods', requireFinanceAdmin, express.urlencoded({extended:false,limit:'10kb'}), csrfCheck, requireWebCategoryAccess('financial_operations','manage'), async (req,res,next) => {
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
app.post('/admin/deposits/methods/:id/status', requireFinanceAdmin, express.urlencoded({extended:false,limit:'5kb'}), csrfCheck, requireWebCategoryAccess('financial_operations','manage'), async (req,res,next) => {
  const id=String(req.params.id||''), active=String(req.body.is_active||'');
  if (!/^\d{1,20}$/.test(id) || !['0','1'].includes(active)) return res.status(400).send(page('Invalid destination status','<h1>Invalid destination status</h1><a class="btn" href="/admin/deposits">Return to deposits</a>'));
  try {
    const [result]=await pool.execute('UPDATE deposit_payment_methods SET is_active=? WHERE id=?',[Number(active),id]);
    if (!result.affectedRows) return res.status(404).send(page('Destination not found','<h1>Payment destination not found</h1><a class="btn" href="/admin/deposits">Return to deposits</a>'));
    await pool.execute('INSERT INTO admin_audit_log (admin_member_id,action,target_type,target_id,details,ip_address) VALUES (?,?,?,?,?,?)',[req.session.memberId,Number(active)?'deposit.method.activated':'deposit.method.deactivated','deposit_payment_method',id,JSON.stringify({is_active:Number(active)}),req.ip||null]);
    res.redirect('/admin/deposits');
  } catch(e) { if(e.code === 'ER_NO_SUCH_TABLE') return res.status(503).send(dbSetupNotice('Deposit workflow setup required','migrations/006_deposit_payment_workflow.sql')); next(e); }
});
app.get('/admin/deposits/:id/proof', requireFinanceAdmin, requireWebCategoryAccess('financial_operations','view'), async (req,res,next) => {
  try {
    const id=String(req.params.id||'');
    if (!/^\d{1,20}$/.test(id)) return res.status(400).send(page('Invalid proof','<h1>Invalid payment proof</h1>'));
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
app.post('/admin/deposits/:id/review', requireFinanceAdmin, express.urlencoded({extended:false,limit:'5kb'}), csrfCheck, requireWebCategoryAccess('financial_operations',req=>req.body.decision==='approved'?'approve':'reject'), async (req,res,next) => {
  const id=String(req.params.id||''), decision=String(req.body.decision||req.query.decision||''), note=String(req.body.reviewer_note||'').trim().slice(0,1000);
  if (!/^\d{1,20}$/.test(id) || !['approved','rejected'].includes(decision)) return res.status(400).send(page('Invalid deposit review','<h1>Invalid deposit review</h1><a class="btn" href="/admin/deposits">Return to deposits</a>'));
  let conn;
  try {
    conn=await pool.getConnection();
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
    const notificationTitle=decision==='approved'?'Deposit approved':'Deposit needs attention';
    const notificationBody=decision==='approved'
      ? 'Your deposit request #'+d.id+' has been approved and '+Number(d.amount).toLocaleString('en-US',{maximumFractionDigits:8})+' '+d.currency+' has been credited to your wallet.'
      : 'Your deposit request #'+d.id+' was not approved. '+(note||'Please review your payment details and contact support if you need help.');
    await conn.execute('INSERT INTO member_notifications (member_id,notification_type,title,body,target_url,dedupe_key) VALUES (?,?,?,?,?,?)',[d.member_id,'deposit_review',notificationTitle,notificationBody.slice(0,1000),decision==='approved'?'/transactions':'/deposit','deposit-review:'+d.id+':'+decision]);
    await conn.execute('INSERT INTO admin_audit_log (admin_member_id,action,target_type,target_id,details,ip_address) VALUES (?,?,?,?,?,?)',[req.session.memberId,'deposit.'+decision,'deposit_request',String(id),JSON.stringify({currency:d.currency,amount:d.amount,fee_amount:d.fee_amount,note}),req.ip||null]);
    await conn.commit();
    res.redirect('/admin/deposits');
  } catch(e) {
    if(conn) { try { await conn.rollback(); } catch(_) {} }
    console.error('[deposit-review] review failed', { depositId:id, decision, code:e && e.code, message:e && e.message });
    if(e && e.code === 'ER_NO_SUCH_TABLE') {
      const missing=String(e.sqlMessage||e.message||'');
      if(/member_notifications|admin_audit_log/i.test(missing)) return res.status(503).send(dbSetupNotice('Deposit review support tables are missing','migrations/008_deposit_review_notifications.sql'));
      return res.status(503).send(dbSetupNotice('Deposit workflow setup required','migrations/006_deposit_payment_workflow.sql'));
    }
    if(e && e.code === 'ER_BAD_FIELD_ERROR') return res.status(503).send(dbSetupNotice('Deposit database schema is out of date','migrations/006_deposit_payment_workflow.sql'));
    next(e);
  } finally { if(conn) conn.release(); }
});

app.get('/admin/referrals', requireAdmin, requireWebCategoryAccess('members_roles','view'), async (req,res,next) => {
  try {
    const [rows] = await pool.query('SELECT c.id,c.full_name,c.username,c.email,c.monarch_uid,c.created_at,r.full_name AS referrer_name,r.username AS referrer_username,r.monarch_uid AS referrer_uid FROM members c JOIN members r ON r.id=c.referred_by ORDER BY c.created_at DESC LIMIT 300');
    const items = rows.map(r => '<tr><td><strong>' + esc(r.full_name || r.username) + '</strong><br><small>' + esc(r.email) + '</small><br>' + esc(r.monarch_uid || '—') + '</td><td><strong>' + esc(r.referrer_name || r.referrer_username) + '</strong><br><small>' + esc(r.referrer_username) + ' · ' + esc(r.referrer_uid || '—') + '</small></td><td>' + esc(r.created_at || '—') + '</td></tr>').join('');
    const content = '<section class="ac-panel"><h2>Referral attribution</h2><p class="muted">These rows come from the members.referred_by relationship. Referral commissions and earnings are not displayed because no verified commission ledger is connected.</p><div class="ac-table-wrap"><table class="ac-table"><thead><tr><th>Referred member</th><th>Referrer</th><th>Registered</th></tr></thead><tbody>' + (items || '<tr><td colspan="3">No referred members found.</td></tr>') + '</tbody></table></div></section>';
    res.send(adminControlPage('Referral monitoring','/admin/referrals',content,req));
  } catch(e) { next(e); }
});
app.get('/admin/academy', requireAdmin, requireWebCategoryAccess('invest_market','view'), async (req,res,next) => {
  try {
    const [rows] = await pool.query('SELECT l.id,l.title,l.description,l.access_level,l.status,l.sort_order,l.created_at,m.username AS creator FROM academy_lessons l LEFT JOIN members m ON m.id=l.created_by ORDER BY l.sort_order ASC,l.created_at DESC LIMIT 200');
    const items = rows.map(l => '<tr><td><strong>' + esc(l.title) + '</strong><br><small>' + esc(l.description || '') + '</small></td><td>' + esc(l.access_level) + '</td><td>' + esc(l.status) + '</td><td>' + esc(l.creator || '—') + '</td><td><form method="post" action="/admin/academy/lessons/' + encodeURIComponent(l.id) + '/status">' + csrfField(req) + '<select name="status" aria-label="Lesson status"><option value="draft"' + (l.status === 'draft' ? ' selected' : '') + '>Draft</option><option value="published"' + (l.status === 'published' ? ' selected' : '') + '>Published</option><option value="archived"' + (l.status === 'archived' ? ' selected' : '') + '>Archived</option></select><button class="btn" type="submit">Save status</button></form></td></tr>').join('');
    const content = '<section class="ac-panel"><h2>Create a lesson</h2><p class="muted">Create educational content. Premium access remains controlled by an explicit access grant; publishing a lesson does not grant premium access.</p><form method="post" action="/admin/academy/lessons" class="ac-form">' + csrfField(req) + '<label>Lesson title<input name="title" required maxlength="180"></label><label>Description<textarea name="description" rows="2" maxlength="1000"></textarea></label><label>Lesson content<textarea name="content" rows="8" required maxlength="50000"></textarea></label><label>Optional video URL<input name="video_url" type="url" maxlength="1000" placeholder="https://…"></label><label>Access level<select name="access_level"><option value="free">Free</option><option value="premium">Premium</option></select></label><label>Initial status<select name="status"><option value="draft">Draft</option><option value="published">Published</option></select></label><button class="btn" type="submit">Create lesson</button></form></section><section class="ac-panel"><h2>Lessons</h2><div class="ac-table-wrap"><table class="ac-table"><thead><tr><th>Lesson</th><th>Access</th><th>Status</th><th>Created by</th><th>Update</th></tr></thead><tbody>' + (items || '<tr><td colspan="5">No lessons created yet.</td></tr>') + '</tbody></table></div></section><style>.ac-form{display:grid;gap:12px;max-width:820px}.ac-form label{display:grid;gap:6px}.ac-form input,.ac-form textarea,.ac-form select,td select{width:100%;min-width:0;padding:10px;border-radius:8px;background:#0d0d10;color:#fff;border:1px solid #45434c;font:inherit}.ac-form textarea{resize:vertical}</style>';
    res.send(adminControlPage('Academy management','/admin/academy',content,req));
  } catch(e) { if(e.code === 'ER_NO_SUCH_TABLE') return res.status(503).send(dbSetupNotice('Academy setup required','migrations/005_member_dashboard_and_sovereign_desk.sql')); next(e); }
});
app.post('/admin/academy/lessons', requireAdmin, express.urlencoded({extended:false,limit:'60kb'}), csrfCheck, requireWebCategoryAccess('invest_market','manage'), async (req,res,next) => {
  try {
    const title = String(req.body.title || '').trim().slice(0,180);
    const description = String(req.body.description || '').trim().slice(0,1000);
    const content = String(req.body.content || '').trim().slice(0,50000);
    const accessLevel = ['free','premium'].includes(req.body.access_level) ? req.body.access_level : 'free';
    const status = ['draft','published'].includes(req.body.status) ? req.body.status : 'draft';
    const rawVideoUrl = String(req.body.video_url || '').trim().slice(0,1000);
    let videoUrl = null;
    if (rawVideoUrl) {      try { const parsed = new URL(rawVideoUrl); if (!['http:','https:'].includes(parsed.protocol)) throw new Error('Unsupported URL protocol'); videoUrl = parsed.toString(); }
      catch (_) { return res.status(400).send(page('Invalid video URL','<h1>Enter a valid HTTPS or HTTP video URL</h1><a class="btn" href="/admin/academy">Return to Academy</a>')); }    }
    if (!title || !content) return res.status(400).send(page('Lesson details required','<h1>Enter a lesson title and content</h1><a class="btn" href="/admin/academy">Return to Academy</a>'));
    await pool.execute('INSERT INTO academy_lessons (title,description,content,video_url,access_level,status,created_by) VALUES (?,?,?,?,?,?,?)',[title,description,content,videoUrl,accessLevel,status,req.session.memberId]);    res.redirect('/admin/academy');
  } catch(e) { if(e.code === 'ER_NO_SUCH_TABLE') return res.status(503).send(dbSetupNotice('Academy setup required','migrations/005_member_dashboard_and_sovereign_desk.sql')); next(e); }
});
app.post('/admin/academy/lessons/:id/status', requireAdmin, express.urlencoded({extended:false,limit:'5kb'}), csrfCheck, requireWebCategoryAccess('invest_market','manage'), async (req,res,next) => {
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
app.get('/admin/notifications', requireAdmin, requireWebCategoryAccess('notifications','view'), async (req,res,next) => {
  try {
    const [rows] = await pool.query('SELECT n.id,n.notification_type,n.title,n.body,n.target_url,n.read_at,n.created_at,m.full_name,m.username,m.email FROM member_notifications n JOIN members m ON m.id=n.member_id ORDER BY n.created_at DESC LIMIT 200');
    const items = rows.map(n => '<tr><td><strong>' + esc(n.title) + '</strong><br><small>' + esc(n.notification_type) + '</small><p>' + esc(n.body) + '</p></td><td>' + esc(n.full_name || n.username) + '<br><small>' + esc(n.email) + '</small></td><td>' + esc(n.read_at ? 'Read' : 'Unread') + '</td><td>' + esc(n.created_at) + '</td></tr>').join('');
    const content = '<section class="ac-panel"><h2>Member notification log</h2><p class="muted">This is the persisted in-app notification log for members. Email send attempts are logged separately by the application and are not represented as confirmed delivery here.</p><div class="ac-table-wrap"><table class="ac-table"><thead><tr><th>Notification</th><th>Member</th><th>Read status</th><th>Created</th></tr></thead><tbody>' + (items || '<tr><td colspan="4">No member notifications recorded yet.</td></tr>') + '</tbody></table></div></section>';
    res.send(adminControlPage('Notifications','/admin/notifications',content,req));
  } catch(e) { if(e.code === 'ER_NO_SUCH_TABLE') return res.status(503).send(dbSetupNotice('Notification setup required','migrations/005_member_dashboard_and_sovereign_desk.sql')); next(e); }
});
app.get('/admin/audit', requireAdmin, requireWebCategoryAccess('security_audit','view'), async (req,res,next) => {
  try {
    const [admins] = await pool.query('SELECT a.member_id,a.role,a.is_active,a.created_at,m.username,m.full_name,m.email FROM admin_users a JOIN members m ON m.id=a.member_id ORDER BY a.created_at DESC LIMIT 100');
    const [events] = await pool.query('SELECT l.action,l.target_type,l.target_id,l.details,l.ip_address,l.created_at,m.username FROM admin_audit_log l JOIN members m ON m.id=l.admin_member_id ORDER BY l.created_at DESC LIMIT 100');
    const adminRows = admins.map(a => '<tr><td>' + esc(a.full_name || a.username) + '<br><small>' + esc(a.email) + '</small></td><td>' + esc(String(a.role).replace(/_/g,' ')) + '</td><td>' + esc(Number(a.is_active) ? 'Active' : 'Inactive') + '</td><td>' + esc(a.created_at) + '</td></tr>').join('');
    const eventRows = events.map(e => '<tr><td>' + esc(e.action) + '</td><td>' + esc(e.target_type || '—') + ' ' + esc(e.target_id || '') + '</td><td>' + esc(e.username) + '</td><td>' + esc(typeof e.details === 'string' ? e.details : JSON.stringify(e.details || {})) + '</td><td>' + esc(e.created_at) + '</td></tr>').join('');
    const content = '<section class="ac-panel"><h2>Provisioned administrators</h2><div class="ac-table-wrap"><table class="ac-table"><thead><tr><th>Account</th><th>Role</th><th>Status</th><th>Added</th></tr></thead><tbody>' + (adminRows || '<tr><td colspan="4">No administrator rows found.</td></tr>') + '</tbody></table></div></section><section class="ac-panel"><h2>Recent audit events</h2><div class="ac-table-wrap"><table class="ac-table"><thead><tr><th>Action</th><th>Target</th><th>Actor</th><th>Details</th><th>Date</th></tr></thead><tbody>' + (eventRows || '<tr><td colspan="5">No audit events recorded yet.</td></tr>') + '</tbody></table></div></section>';
    res.send(adminControlPage('Audit & access','/admin/audit',content,req));
  } catch(e) { if(e.code === 'ER_NO_SUCH_TABLE') return res.status(503).send(dbSetupNotice('Audit setup required','migrations/002_admin_access.sql')); next(e); }
});
app.get('/admin/settings', requireAdmin, requireWebCategoryAccess('security_audit','manage'), async (req,res,next) => {
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
app.post('/admin/settings/deposit-pricing', requireFinanceAdmin, express.urlencoded({extended:false,limit:'5kb'}), csrfCheck, requireWebCategoryAccess('financial_operations','manage'), async (req,res,next) => {
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


app.get('/admin/roles', requireAdmin, (req,res)=>{
  const content = `<section class="ac-panel">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap"><div><h2>Member role management</h2><p class="muted">Create and maintain roles, review member or company requests, and assign roles yourself. A role is not granted until an authorised Monarch Codex administrator approves or assigns it.</p></div><button class="btn" id="roleRefresh" type="button">Refresh</button></div>
    <div id="roleNotice" class="notice" hidden></div>
    <div class="ac-panel" style="margin:18px 0"><h3>Add a role</h3><form id="roleCreate" style="display:grid;gap:12px;max-width:680px"><label>Role name<input name="roleName" required maxlength="100" placeholder="e.g. Community Lead"></label><label>Description<textarea name="description" maxlength="500" rows="2" placeholder="What this role means"></textarea></label><button class="btn" type="submit">Add role</button></form></div>
    <div class="ac-panel" style="margin:18px 0"><h3>Role catalogue</h3><div id="roleCatalog" aria-live="polite">Loading roles…</div></div>
    <div class="ac-panel" style="margin:18px 0"><h3>Pending requests</h3><div id="roleRequests" aria-live="polite">Loading requests…</div></div>
    <div class="ac-panel" style="margin:18px 0"><h3>Assign roles manually</h3><p class="muted">Choose a member and role. Duplicate assignments are prevented by the database.</p><form id="roleAssign" style="display:grid;gap:12px;max-width:680px"><label>Member<select name="memberId" id="roleMember" required></select></label><label>Role<select name="roleId" id="roleToAssign" required></select></label><button class="btn" type="submit">Assign role</button></form><div id="existingAssignments"></div></div>
    </section>
    <script>
    (function(){'use strict';const notice=document.getElementById('roleNotice'),catalog=document.getElementById('roleCatalog'),requests=document.getElementById('roleRequests'),members=document.getElementById('roleMember'),rolesSelect=document.getElementById('roleToAssign'),assignments=document.getElementById('existingAssignments');let state={roles:[],requests:[],members:[],assignments:[]};
    const esc=function(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})};
    function msg(t,bad){notice.hidden=!t;notice.textContent=t||'';notice.style.borderColor=bad?'#b45b51':'#7d6a35';}
    async function api(path,body){const r=await fetch('/api/mobile'+path,{method:body?'POST':'GET',credentials:'same-origin',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});const d=await r.json().catch(()=>({message:'Unexpected server response'}));if(!r.ok)throw new Error(d.message||d.error||'Request failed ('+r.status+')');return d}
    function draw(){catalog.innerHTML=state.roles.length?state.roles.map(r=>'<form class="roleEdit" data-id="'+Number(r.id)+'" style="display:grid;gap:8px;padding:14px;margin:10px 0;border:1px solid #39342a;border-radius:14px"><label>Role name<input name="roleName" maxlength="100" required value="'+esc(r.role_name)+'"></label><label>Description<textarea name="description" rows="2" maxlength="500">'+esc(r.description||'')+'</textarea></label><label style="display:flex;align-items:center;gap:8px"><input type="checkbox" name="isActive" '+(Number(r.is_active)?'checked':'')+'> Available for new requests</label><small class="muted">Assigned to '+Number(r.assigned_count||0)+' member(s)</small><button class="btn" type="submit">Save role changes</button></form>').join(''):'<p class="muted">No roles yet. Add one above.</p>';
    requests.innerHTML=state.requests.length?state.requests.map(r=>'<article style="padding:14px;margin:10px 0;border:1px solid #39342a;border-radius:14px"><strong>'+esc(r.full_name||r.company_name||'Member')+'</strong><p class="muted">'+esc(r.email||'Company request')+' · '+esc(r.request_source||'member')+'</p><p><b>'+esc(r.role_name)+'</b></p><p>'+esc(r.message||'No message supplied')+'</p>'+(r.company_name?'<p>Company: '+esc(r.company_name)+'</p>':'')+'<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" data-review="'+Number(r.id)+'" data-decision="approve">Approve & assign</button><button class="btn" data-review="'+Number(r.id)+'" data-decision="reject">Reject</button></div></article>').join(''):'<p class="muted">No pending requests.</p>';
    members.innerHTML=state.members.map(m=>'<option value="'+Number(m.id)+'">'+esc(m.full_name||m.email)+' · '+esc(m.email)+'</option>').join('');rolesSelect.innerHTML=state.roles.filter(r=>Number(r.is_active)===1).map(r=>'<option value="'+Number(r.id)+'">'+esc(r.role_name)+'</option>').join('');
    assignments.innerHTML=state.assignments.length?'<h4>Current assignments</h4>'+state.assignments.map(a=>'<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid #39342a"><span>'+esc((state.members.find(m=>Number(m.id)===Number(a.member_id))||{}).full_name||('Member #'+a.member_id))+' — '+esc(a.role_name)+'</span><button class="btn" data-remove-member="'+Number(a.member_id)+'" data-remove-role="'+Number(a.role_id)+'" type="button">Remove</button></div>').join(''):'<p class="muted">No current assignments yet.</p>';}
    async function load(){try{msg('');state=await api('/admin/roles');draw()}catch(e){msg(e.message+' If role tables are not set up yet, apply migrations/018_member_role_management.sql once in phpMyAdmin, then refresh.',true);catalog.textContent='Role data could not be loaded.'}}
    document.getElementById('roleRefresh').addEventListener('click',load);
    document.getElementById('roleCreate').addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.currentTarget);try{await api('/admin/roles/catalog',{roleName:f.get('roleName'),description:f.get('description'),isActive:true});e.currentTarget.reset();msg('Role added.');await load()}catch(x){msg(x.message,true)}});
    catalog.addEventListener('submit',async e=>{if(!e.target.matches('.roleEdit'))return;e.preventDefault();const f=new FormData(e.target);try{await api('/admin/roles/catalog',{roleId:Number(e.target.dataset.id),roleName:f.get('roleName'),description:f.get('description'),isActive:f.get('isActive')==='on'});msg('Role updated.');await load()}catch(x){msg(x.message,true)}});
    requests.addEventListener('click',async e=>{const b=e.target.closest('[data-review]');if(!b)return;try{await api('/admin/roles/requests/'+Number(b.dataset.review),{decision:b.dataset.decision});msg('Request '+b.dataset.decision+'d.');await load()}catch(x){msg(x.message,true)}});
    document.getElementById('roleAssign').addEventListener('submit',async e=>{e.preventDefault();try{await api('/admin/roles/assign',{memberId:Number(members.value),roleId:Number(rolesSelect.value),action:'assign'});msg('Role assigned.');await load()}catch(x){msg(x.message,true)}});
    assignments.addEventListener('click',async e=>{const b=e.target.closest('[data-remove-member]');if(!b)return;if(!confirm('Remove this role from the member?'))return;try{await api('/admin/roles/assign',{memberId:Number(b.dataset.removeMember),roleId:Number(b.dataset.removeRole),action:'remove'});msg('Role removed.');await load()}catch(x){msg(x.message,true)}});
    load();})();
    </script>`;
  res.send(adminControlPage('Member roles','/admin/roles',content,req));
});

app.get('/admin/members', requireAdmin, requireWebCategoryAccess('members_roles','view'), async (req,res,next)=>{
  try {
    // Build the member-management view from the live schema instead of assuming
    // every optional profile/account-control column has already been installed.
    const [memberColumnRows] = await pool.query('SHOW COLUMNS FROM members');
    const memberColumns = new Set(memberColumnRows.map(row => String(row.Field)));
    const required = ['id','username','email'];
    const missing = required.filter(name => !memberColumns.has(name));
    if (missing.length) {
      return res.status(503).send(adminControlPage('Member management','/admin/members',
        '<section class="ac-panel ac-empty-state"><h2>Member data setup required</h2><p>The member list cannot be loaded because the database is missing required columns: '+esc(missing.join(', '))+'.</p><p>Check the production database schema before applying any migration. No member data has been changed.</p></section>',req));
    }
    const [adminTables] = await pool.query("SHOW TABLES LIKE 'admin_users'");
    const hasAdminTable = adminTables.length > 0;
    let adminColumns = new Set();
    if (hasAdminTable) {
      const [cols] = await pool.query('SHOW COLUMNS FROM admin_users');
      adminColumns = new Set(cols.map(row => String(row.Field)));
    }
    const adminJoin = hasAdminTable && adminColumns.has('member_id');
    const roleExpr = adminJoin && adminColumns.has('role') ? 'au.role' : 'NULL';
    const activeExpr = adminJoin && adminColumns.has('is_active') ? 'au.is_active' : '1';
    const [profileTables] = await pool.query("SHOW TABLES LIKE 'member_profiles'");
    let profileJoin = false, avatarExpr = 'NULL';
    if (profileTables.length) {
      const [cols] = await pool.query('SHOW COLUMNS FROM member_profiles');
      const profileColumns = new Set(cols.map(row => String(row.Field)));
      profileJoin = profileColumns.has('member_id');
      if (profileJoin && profileColumns.has('avatar_key')) avatarExpr = 'mp.avatar_key';
      else profileJoin = false;
    }
    const q = String(req.query.q || '').trim().slice(0,120);
    const searchFields = ['m.username','m.email'];
    if (memberColumns.has('full_name')) searchFields.push('m.full_name');
    if (memberColumns.has('monarch_uid')) searchFields.push('m.monarch_uid');
    const where = q ? ' WHERE ('+searchFields.map(field => field+' LIKE ?').join(' OR ')+')' : '';
    const params = q ? searchFields.map(() => '%'+q+'%') : [];
    const fullNameExpr = memberColumns.has('full_name') ? 'm.full_name' : "''";
    const uidExpr = memberColumns.has('monarch_uid') ? 'm.monarch_uid' : 'NULL';
    const blockedExpr = memberColumns.has('is_blocked') ? 'COALESCE(m.is_blocked,0)' : '0';
    const createdExpr = memberColumns.has('created_at') ? 'm.created_at' : 'NULL';
    const sql = 'SELECT m.id,m.username,m.email,'+fullNameExpr+' AS full_name,'+uidExpr+' AS monarch_uid,'+createdExpr+' AS created_at,'+blockedExpr+' AS is_blocked,'+roleExpr+' AS admin_role,'+activeExpr+' AS admin_active,'+avatarExpr+' AS avatar_key FROM members m'+(adminJoin?' LEFT JOIN admin_users au ON au.member_id=m.id':'')+(profileJoin?' LEFT JOIN member_profiles mp ON mp.member_id=m.id':'')+where+' ORDER BY m.id DESC LIMIT 200';
    const [rows] = await pool.execute(sql, params);
    const cards = rows.map(m => {
      const id = Number(m.id);
      const username = String(m.username || '');
      const isAdmin = Boolean(m.admin_role);
      const isSelf = id === Number(req.session.memberId);
      const photo = m.avatar_key && /^[a-f0-9]{48}\.(jpg|png|webp)$/.test(String(m.avatar_key))
        ? '/member-avatar/'+encodeURIComponent(m.avatar_key)
        : '/assets/images/monarch-codex-logo.svg';
      let actions = '<a class="btn ac-action-view" href="/admin/members/'+id+'">View details</a>';
      if (isAdmin) {
        actions += '<span class="ac-status-note">Administrator account protected</span>';
      } else {
        if (isSelf) actions += '<span class="ac-status-note">Your account is protected</span>';
        else {
          if (memberColumns.has('is_blocked')) {
            actions += '<form method="post" action="/admin/members/'+id+'/block" class="ac-inline-action">'+csrfField(req)+'<input type="hidden" name="reason" value=""><button class="btn ac-action-block" type="submit">'+(Number(m.is_blocked)===1?'Unblock member':'Block member')+'</button></form>';
          } else {
            actions += '<span class="ac-status-note">Blocking requires account-controls database setup</span>';
          }
          actions += '<form method="post" action="/admin/members/'+id+'/delete" class="ac-inline-action" data-delete-member data-username="'+esc(username)+'">'+csrfField(req)+'<input type="hidden" name="confirmUsername" value=""><button class="btn ac-action-delete" type="submit">Delete account</button></form>';
        }
      }
      const status = isAdmin ? (Number(m.admin_active)===1?'Administrator · Active':'Administrator · Inactive') : (Number(m.is_blocked)===1?'Blocked':'Active');
      return '<article class="ac-member-card"><div class="ac-member-identity"><img src="'+photo+'" alt="" loading="lazy"><div class="ac-member-name"><strong>'+esc(username)+'</strong><span>'+esc(m.full_name||'Name not provided')+'</span><small>Member #'+id+'</small></div><span class="ac-member-status '+(Number(m.is_blocked)===1?'is-blocked':isAdmin?'is-admin':'')+'">'+esc(status)+'</span></div><dl class="ac-member-fields"><div><dt>Email</dt><dd>'+esc(m.email||'—')+'</dd></div><div><dt>Monarch ID</dt><dd>'+esc(m.monarch_uid||'Not assigned')+'</dd></div><div><dt>Joined</dt><dd>'+esc(m.created_at||'—')+'</dd></div></dl><div class="ac-member-actions">'+actions+'</div></article>';
    }).join('');
    const notice = req.query.notice === 'deleted' ? '<div class="ac-inline-notice" role="status">The member account was deleted successfully.</div>' : '';
    const content = '<style>'+
      '.ac-members{display:grid;gap:16px}.ac-members-toolbar{display:flex;align-items:flex-end;justify-content:space-between;gap:14px;flex-wrap:wrap;margin:0 0 18px}.ac-members-search{display:flex;gap:8px;flex:1;min-width:min(100%,260px);max-width:620px}.ac-members-search input{flex:1;min-width:0}.ac-members-summary{color:#aaa392;font-size:.82rem}.ac-member-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.ac-member-card{min-width:0;padding:18px;border:1px solid #393326;border-radius:17px;background:linear-gradient(145deg,#1a1a1c,#111113);display:grid;gap:16px}.ac-member-identity{display:flex;align-items:center;gap:12px;min-width:0}.ac-member-identity img{width:48px;height:48px;flex:0 0 48px;object-fit:cover;border:1px solid #806b35;border-radius:15px;background:#0d0d0e}.ac-member-name{display:grid;gap:4px;min-width:0;flex:1}.ac-member-name strong{color:#f4e9c8;font-size:.95rem;font-weight:700;overflow-wrap:anywhere}.ac-member-name span,.ac-member-name small{color:#aaa392;font-size:.78rem;overflow-wrap:anywhere}.ac-member-name small{font-size:.7rem}.ac-member-status{flex:0 0 auto;padding:6px 9px;border:1px solid #31543d;border-radius:999px;background:#102519;color:#a8e3b8;font-size:.68rem;font-weight:650}.ac-member-status.is-blocked{border-color:#783e39;background:#2c1716;color:#ffb9ae}.ac-member-status.is-admin{border-color:#6b592d;background:#27200f;color:#f1d580}.ac-member-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:0}.ac-member-fields div{min-width:0;padding:10px;border-radius:10px;background:#ffffff04}.ac-member-fields dt{margin:0 0 5px;color:#8f897b;font-size:.67rem;text-transform:uppercase;letter-spacing:.08em}.ac-member-fields dd{margin:0;color:#e7e1d2;font-size:.8rem;overflow-wrap:anywhere}.ac-member-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-top:12px;border-top:1px solid #302d25}.ac-inline-action{display:inline-flex;margin:0}.ac-action-view,.ac-action-block,.ac-action-delete{min-height:38px;padding:9px 12px;font-size:.76rem;font-weight:600}.ac-action-view{background:#f3cf3c;color:#17130a!important}.ac-action-block{background:#5d4614;color:#fff}.ac-action-delete{background:#642725;color:#fff}.ac-status-note{color:#aaa392;font-size:.72rem}.ac-inline-notice{padding:12px 15px;border:1px solid #426e4b;border-radius:12px;background:#102519;color:#b9edc5;font-size:.84rem}@media(max-width:900px){.ac-member-grid{grid-template-columns:1fr}}@media(max-width:520px){.ac-member-card{padding:14px}.ac-member-fields{grid-template-columns:1fr}.ac-member-identity{align-items:flex-start;flex-wrap:wrap}.ac-member-status{margin-left:60px}.ac-members-search{max-width:none}}'+
      '</style><section class="ac-members"><div class="ac-page-head"><div><p class="ac-kicker">MEMBER OPERATIONS</p><h2>Manage member accounts</h2><p class="muted">Search accounts, review member details, and manage access. Administrator accounts and your own account are protected. Permanent deletion requires an exact username confirmation.</p></div><span class="ac-pill">'+rows.length+' shown · maximum 200</span></div>'+notice+'<div class="ac-members-toolbar"><form class="ac-members-search" method="get" action="/admin/members"><input type="search" name="q" value="'+esc(q)+'" placeholder="Search name, username, email or Monarch ID" aria-label="Search members"><button class="btn" type="submit">Search</button>'+(q?'<a class="btn" href="/admin/members">Clear</a>':'')+'</form><span class="ac-members-summary">'+(q?'Results matching “'+esc(q)+'”':'Most recently created member accounts')+'</span></div><div class="ac-member-grid">'+(cards||'<div class="ac-panel" style="padding:22px"><h3>No members found</h3><p class="muted">'+(q?'Try another name, username, email or Monarch ID.':'New member accounts will appear here.')+'</p></div>')+'</div></section><script>(function(){document.addEventListener("submit",function(event){const form=event.target.closest("form[data-delete-member]");if(!form)return;const username=form.dataset.username||"";const typed=window.prompt("Permanently delete @"+username+"? Type the exact username to continue.");if(typed===null){event.preventDefault();return;}if(typed!==username){event.preventDefault();window.alert("Username did not match. No account was deleted.");return;}if(!window.confirm("Final confirmation: permanently delete @"+username+" and associated member records?")){event.preventDefault();return;}form.querySelector("[name=confirmUsername]").value=typed;});})();</script>';
    return res.send(adminControlPage('Manage members','/admin/members',content,req));
  } catch (error) {
    console.error('[admin member management]', error.code || error.name, error.message);
    if (error && error.code === 'ER_NO_SUCH_TABLE') {
      return res.status(503).send(adminControlPage('Manage members','/admin/members','<section class="ac-panel"><h2>Member database setup required</h2><p>The member-management database is not ready. Verify the configured production database and its required tables before retrying.</p></section>',req));
    }
    return next(error);
  }
});

app.post('/admin/members/:memberId/block', requireAdmin, requireWebCategoryAccess('members_roles','edit'), (req,res,next)=>{
  csrfCheck(req,res,async csrfErr=>{
    if(csrfErr)return;
    try{
      if(!['super_admin','main_admin'].includes(String(req.adminRole||'')))return res.status(403).send(page('Permission required','<h1>Permission required</h1><p class="muted">Only authorised senior administrators can change account access.</p><a class="btn" href="/admin/members">Back to members</a>'));
      const id=Number(req.params.memberId); if(!Number.isSafeInteger(id)||id<1)return res.sendStatus(400);
      if(id===Number(req.session.memberId))return res.status(400).send(page('Action not allowed','<h1>You cannot block your own account</h1><a class="btn" href="/admin/members">Back</a>'));
      const [[targetAdmin]] = await pool.execute('SELECT member_id FROM admin_users WHERE member_id=? AND is_active=1 LIMIT 1',[id]);
      if(targetAdmin)return res.status(403).send(page('Protected account','<h1>Administrator accounts are protected</h1><p class="muted">This action is available for member accounts only.</p><a class="btn" href="/admin/members">Back to members</a>'));
      const [[state]]=await pool.execute('SELECT is_blocked FROM members WHERE id=? LIMIT 1',[id]);
      if(!state)return res.status(404).send(page('Member not found','<h1>Member not found</h1><a class="btn" href="/admin/members">Back</a>'));
      const block=Number(state.is_blocked)!==1;
      await pool.execute('UPDATE members SET is_blocked=?,blocked_at=?,blocked_by=?,block_reason=? WHERE id=?',[block?1:0,block?new Date():null,block?Number(req.session.memberId):null,block?String(req.body.reason||'').trim().slice(0,500)||null:null,id]);
      res.redirect('/admin/members/'+id+'?notice='+(block?'blocked':'unblocked'));
    }catch(e){if(e.code==='ER_BAD_FIELD_ERROR')return res.status(503).send(dbSetupNotice('Account controls migration required','migrations/015_member_account_controls.sql'));next(e);}
  });
});

app.post('/admin/members/:memberId/delete', requireAdmin, requireWebCategoryAccess('members_roles','delete'), (req,res,next)=>{
  csrfCheck(req,res,async csrfErr=>{
    if(csrfErr)return;
    let conn;
    try{
      if(!['super_admin','main_admin'].includes(String(req.adminRole||'')))return res.status(403).send(page('Permission required','<h1>Permission required</h1><p class="muted">Only authorised senior administrators can permanently delete accounts.</p><a class="btn" href="/admin/members">Back to members</a>'));
      const id=Number(req.params.memberId);if(!Number.isSafeInteger(id)||id<1)return res.sendStatus(400);
      if(id===Number(req.session.memberId))return res.status(400).send(page('Action not allowed','<h1>You cannot delete your own account</h1><a class="btn" href="/admin/members">Back</a>'));
      const [[target]]=await pool.execute('SELECT id,username FROM members WHERE id=? LIMIT 1',[id]);
      if(!target)return res.status(404).send(page('Member not found','<h1>Member not found</h1><a class="btn" href="/admin/members">Back</a>'));
      if(String(req.body.confirmUsername||'')!==String(target.username))return res.status(400).send(page('Confirmation did not match','<h1>Account not deleted</h1><p class="muted">Type the member username exactly to confirm permanent deletion.</p><a class="btn" href="/admin/members/'+id+'">Return to member</a>'));
      const [[targetAdmin]]=await pool.execute('SELECT member_id FROM admin_users WHERE member_id=? LIMIT 1',[id]);
      if(targetAdmin)return res.status(403).send(page('Protected account','<h1>Administrator accounts cannot be deleted here</h1><a class="btn" href="/admin/members">Back to members</a>'));
      conn=await pool.getConnection();await conn.beginTransaction();
      const [tables]=await conn.query("SELECT DISTINCT TABLE_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND COLUMN_NAME='member_id' AND TABLE_NAME<> 'members' AND TABLE_NAME<> 'admin_users'");
      for(const row of tables){const table=String(row.TABLE_NAME).replace(/[`]/g,'');await conn.execute('DELETE FROM `'+table+'` WHERE member_id=?',[id]);}
      await conn.execute('DELETE FROM members WHERE id=?',[id]);
      await conn.commit();conn.release();conn=null;
      res.redirect('/admin/members?notice=deleted');
    }catch(e){if(conn){try{await conn.rollback()}catch(_){}conn.release()}if(e.code==='ER_BAD_FIELD_ERROR')return res.status(503).send(dbSetupNotice('Account controls migration required','migrations/015_member_account_controls.sql'));console.error('[admin member deletion]',e.message);return res.status(409).send(page('Account could not be deleted','<h1>Account was not deleted</h1><p class="muted">The database prevented deletion because some related records still depend on this account. No partial deletion was committed. Review the related records and database relationships before retrying.</p><a class="btn" href="/admin/members/'+Number(req.params.memberId)+'">Back to member</a>'));}
  });
});

app.get('/admin/members/:memberId', requireAdmin, requireWebCategoryAccess('members_roles','view'), async (req,res,next)=>{
  try {
    const memberId=Number(req.params.memberId);
    if(!Number.isSafeInteger(memberId)||memberId<1)return res.sendStatus(400);
    const [rows]=await pool.execute('SELECT m.id,m.username,m.full_name,m.email,m.monarch_uid,m.created_at,mp.phone_number,mp.avatar_key,p.nickname,p.requested,p.approved,p.visible'+(await pool.execute("SHOW COLUMNS FROM members LIKE 'is_blocked'").then(x=>x[0].length?' ,m.is_blocked,m.block_reason':' ,0 AS is_blocked,NULL AS block_reason'))+' FROM members m LEFT JOIN member_profiles mp ON mp.member_id=m.id LEFT JOIN monarch_public_profiles p ON p.member_id=m.id WHERE m.id=? LIMIT 1',[memberId]);
    if(!rows.length)return res.status(404).send(page('Member not found','<h1>Member account not found</h1><a class="btn" href="/admin/members">Back to members</a>'));
    const m=rows[0];
    const photo=m.avatar_key&&/^[a-f0-9]{48}\.(jpg|png|webp)$/.test(String(m.avatar_key))?'/member-avatar/'+encodeURIComponent(m.avatar_key):'/assets/images/monarch-codex-logo.svg';
    let kycStatus='Not submitted';
    try { const [k]=await pool.execute('SELECT status,submitted_at,reviewed_at FROM kyc_submissions WHERE member_id=? ORDER BY submitted_at DESC,id DESC LIMIT 1',[memberId]); if(k.length)kycStatus=String(k[0].status||'Submitted').replace(/_/g,' '); } catch(e){if(e.code!=='ER_NO_SUCH_TABLE')throw e;}
    const statusNotice=req.query.notice==='blocked'?'Account blocked successfully.':req.query.notice==='unblocked'?'Account unblocked successfully.':req.query.notice==='deleted'?'Member account and associated member records deleted.':'';
    const accountControls='<section class="ac-panel"><h2>Account access controls</h2><p class="muted">Blocking prevents the member from using the account. Permanent deletion is irreversible and removes associated member records.</p><form method="post" action="/admin/members/'+Number(m.id)+'/block">'+csrfField(req)+'<label for="blockReason">Reason (optional)</label><input id="blockReason" name="reason" maxlength="500" placeholder="Reason for blocking this account"><button class="btn" type="submit">'+(Number(m.is_blocked)?'Unblock account':'Block account')+'</button></form><form method="post" action="/admin/members/'+Number(m.id)+'/delete" onsubmit="return confirm(\'Permanently delete this account and associated member records? This cannot be undone.\')">'+csrfField(req)+'<label>Permanent deletion</label><input name="confirmUsername" required placeholder="Type '+esc(m.username)+' to confirm"><button class="btn" type="submit" style="background:#7f1d1d;color:#fff">Delete full account permanently</button></form></section>';
    const content=(statusNotice?'<section class="ac-panel"><p class="notice">'+esc(statusNotice)+'</p></section>':'')+'<section class="ac-panel"><div style="display:flex;align-items:center;gap:18px;flex-wrap:wrap"><img src="'+photo+'" alt="Profile photo of '+esc(m.full_name||m.username)+'" style="width:124px;height:124px;object-fit:cover;border-radius:50%;border:3px solid #dfbd62"><div><h2>'+esc(m.full_name||m.username)+'</h2><p class="muted">@'+esc(m.username)+'</p><p>'+esc(m.nickname||'No public nickname set')+'</p><span class="badge">'+esc(kycStatus)+'</span></div></div></section>'+accountControls+'<section class="ac-panel"><h2>Registered account details</h2><dl class="ac-detail-list"><dt>Member ID</dt><dd>'+esc(m.id)+'</dd><dt>Monarch ID</dt><dd>'+esc(m.monarch_uid||'—')+'</dd><dt>Full name</dt><dd>'+esc(m.full_name||'—')+'</dd><dt>Username</dt><dd>'+esc(m.username||'—')+'</dd><dt>Email</dt><dd>'+esc(m.email||'—')+'</dd><dt>Phone</dt><dd>'+esc(m.phone_number||'—')+'</dd><dt>Homepage listing</dt><dd>'+((m.approved&&m.visible)?'Approved and visible':m.requested?'Awaiting review':'Not requested')+'</dd><dt>Registered</dt><dd>'+esc(m.created_at||'—')+'</dd></dl><p><a class="btn" style="background:#f3cf3c;color:#17130a!important;font-weight:900" href="/admin/monarchs">Manage homepage profiles</a> <a class="btn" style="background:#f3cf3c;color:#17130a!important;font-weight:900" href="/admin/members">Back to members</a></p></section><style>.ac-detail-list{display:grid;grid-template-columns:minmax(110px,180px) minmax(0,1fr);gap:10px 16px}.ac-detail-list dt{color:#cbb46a;font-weight:700}.ac-detail-list dd{margin:0;overflow-wrap:anywhere}@media(max-width:480px){.ac-detail-list{grid-template-columns:1fr;gap:4px}.ac-detail-list dd{margin-bottom:12px}}</style>';
    res.send(adminControlPage('Member profile','/admin/members',content,req));
  } catch(e){if(e.code==='ER_NO_SUCH_TABLE'&&String(e.sqlMessage||'').includes('monarch_public_profiles'))return res.status(503).send(dbSetupNotice('Monarchs profiles setup required','migrations/013_monarchs_directory.sql'));next(e);}
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

app.get('/admin/kyc/:id', requireAdmin, requireWebCategoryAccess('members_roles','view'), async (req,res,next) => {
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
app.get('/admin/kyc/:id/document/:kind', requireAdmin, requireWebCategoryAccess('members_roles','view'), async(req,res,next)=>{
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
app.get('/admin/kyc', requireAdmin, requireWebCategoryAccess('members_roles','view'), async (req,res,next) => {
  try {
    const [rows] = await pool.query("SELECT k.id,k.member_id,k.legal_full_name,k.contact_email,k.document_type,k.document_issuer_country,k.document_number_last4,k.status,k.submitted_at FROM kyc_submissions k WHERE NOT EXISTS (SELECT 1 FROM kyc_submissions newer WHERE newer.member_id=k.member_id AND (newer.submitted_at>k.submitted_at OR (newer.submitted_at=k.submitted_at AND newer.id>k.id))) ORDER BY k.submitted_at DESC,k.id DESC LIMIT 200");
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
app.post('/admin/kyc/:id/review', requireAdmin, express.urlencoded({extended:false,limit:'5kb'}), csrfCheck, requireWebCategoryAccess('members_roles',req=>req.body.status==='approved'?'approve':'reject'), async (req,res,next) => {
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
      const approvedHtml = '<div style="margin:0;padding:36px 16px;background:#08090b;color:#f8f5eb;font-family:Arial,Helvetica,sans-serif"><div style="max-width:580px;margin:0 auto;border:1px solid #6a561b;border-radius:24px;overflow:hidden;background:#111216"><div style="padding:34px 28px 30px;text-align:center;background:radial-gradient(circle at top,#3b3012,#111216 72%)"><img src="' + esc(baseUrl + '/assets/images/monarch-codex-logo.svg') + '" alt="Monarch Codex" width="180" style="display:block;width:180px;max-width:70%;height:auto;margin:0 auto 18px;border:0;outline:none;text-decoration:none"><div style="font-size:12px;font-weight:bold;letter-spacing:4px;color:#e8c34d">BUILD WEALTH. BUILD A KINGDOM.</div><div style="font-size:52px;line-height:1.2;margin:18px 0 8px">👑</div><div style="display:inline-block;padding:6px 12px;border:1px solid #77611d;border-radius:999px;color:#f3cf3c;font-size:11px;font-weight:bold;letter-spacing:1.5px">IDENTITY VERIFIED</div><h1 style="font-size:30px;line-height:1.2;margin:18px 0 10px">Congratulations, ' + esc(kycApplicant.full_name) + '!</h1><p style="font-size:16px;line-height:1.7;color:#e2d9c3;margin:0">Your identity verification has been approved.</p></div><div style="padding:28px"><p style="font-size:16px;line-height:1.8">You did it! 🎉 Your verification has been reviewed and approved by our team. This is an important milestone in your Monarch Codex journey.</p><div style="margin:22px 0;padding:18px;border-radius:14px;background:#1a1914;border:1px solid #3e351c"><div style="color:#f3cf3c;font-size:12px;font-weight:bold;letter-spacing:1px;margin-bottom:7px">WHAT HAPPENS NEXT?</div><p style="margin:0;color:#d8d3c7;line-height:1.8">Head to your dashboard to view your updated verification status and continue with the account features available to you.</p></div><div style="text-align:center;margin:28px 0 24px"><a href="' + esc(baseUrl + '/dashboard') + '" style="display:inline-block;padding:15px 25px;border-radius:12px;background:#f3cf3c;color:#17130a;text-decoration:none;font-weight:bold;font-size:15px">Open my dashboard →</a></div><p style="font-size:14px;line-height:1.8;color:#c5c0b5">Thank you for being part of Monarch Codex. We’re glad to have you with us — keep building with confidence. ✨</p></div><div style="padding:18px 28px;border-top:1px solid #302a1a;color:#a49d8b;font-size:12px;text-align:center">BUILD WEALTH. BUILD A KINGDOM.<br>Monarch Codex · This is an automated account notification.</div></div></div>';
      const messages = {
        approved: { subject: '👑 You’re verified, ' + String(kycApplicant.full_name || 'Monarch').split(/\s+/)[0] + '! Welcome to your next chapter', text: 'Congratulations, ' + kycApplicant.full_name + '! 🎉\n\nYour identity verification has been approved by the Monarch Codex team. This is an important milestone in your journey.\n\nWhat happens next? Visit your dashboard to view your updated verification status and continue with the account features available to you: ' + baseUrl + '/dashboard\n\nThank you for being part of Monarch Codex. Keep building with confidence! 👑✨\n\nBUILD WEALTH. BUILD A KINGDOM.\nMonarch Codex', html: approvedHtml },
        rejected: { subject: 'An update on your Monarch Codex identity verification', text: 'Hello ' + kycApplicant.full_name + ',\n\nWe’re unable to approve your identity verification at this time.\n\nREASON FOR THE DECISION\n' + (reason ? reason.label : 'Please review the reviewer feedback below.') + '\n\nREVIEW TEAM FEEDBACK\n' + (submittedNote || (reason ? reason.message : 'Please review your details and identity images carefully.')) + '\n\nWHAT TO DO NEXT\nPlease check that your full name, date of birth, and NIN or other document details match your identity document exactly. Correct any inaccurate information and submit an updated verification. If you need assistance, contact our support team.\n\nContinue to identity verification: ' + baseUrl + '/kyc\n\nMonarch Codex | BUILD WEALTH. BUILD A KINGDOM.' },
        needs_resubmission: { subject: 'Action required: update your Monarch Codex identity verification', text: 'Hello ' + kycApplicant.full_name + ',\n\nOur review team needs you to update your identity verification before it can be approved.\n\nREVIEW TEAM FEEDBACK\n' + (note || 'Please check your personal details and identity images carefully.') + '\n\nWHAT TO DO NEXT\nOpen the identity verification page, correct the requested information, and submit your updated application. If you need assistance, contact our support team.\n\nContinue to identity verification: ' + baseUrl + '/kyc\n\nMonarch Codex | BUILD WEALTH. BUILD A KINGDOM.' }
      };
      // Select the notification for this decision before attempting email delivery.
      // Without this assignment the route throws ReferenceError after committing the review.
      const notification = messages[status];
      const inAppMessages = {
        approved: { title: 'Identity verification approved', body: 'Congratulations ' + kycApplicant.full_name + '! Your identity verification has been approved. No further KYC action is required at this time. You can view your verification status on the verification page.', target: '/kyc' },
        rejected: { title: 'Identity verification needs attention', body: 'We’re unable to approve your identity verification at this time.\n\nReason for the decision: ' + (reason ? reason.label : 'Please review the reviewer feedback below.') + '\n\nReview team feedback: ' + (submittedNote || (reason ? reason.message : 'Please review your details and documents.')) + '\n\nNext steps: Check that your full name, date of birth and NIN or other document details match your identity document exactly. Correct any inaccurate information and submit an updated verification. If you need assistance, contact our support team.', target: '/kyc' },
        needs_resubmission: { title: 'Action required: update your identity verification', body: 'Our review team needs you to update your identity verification before it can be approved.\n\nReview team feedback: ' + (note || 'Please check your details and identity images carefully.') + '\n\nNext steps: Open the verification page, correct the requested information, and submit your updated application. If you need assistance, contact our support team.', target: '/kyc' }
      };
      const inApp = inAppMessages[status];
      if (inApp) {
        await pool.execute(
          'INSERT INTO member_notifications (member_id, notification_type, title, body, target_url, dedupe_key) VALUES (?, ?, ?, ?, ?, ?)',
          [kycApplicant.member_id, 'kyc_review', inApp.title, inApp.body.slice(0, 1000), inApp.target, 'kyc-review:' + id + ':' + status + ':' + Date.now()]
        ).catch(e => console.error('[notification] KYC in-app notification failed:', e.message));
      }
      if (notification && kycApplicant.email) {        try {
          const sent = await sendAppEmail({ to: kycApplicant.email, ...notification });
          emailStatus = sent ? 'sent' : 'skipped';        } catch(e) {
          emailStatus = 'failed';
          console.error('[mail] KYC notification failed:', e.message);
        }      } else if (notification) {
        emailStatus = 'no_address';
      }
    }
    return res.redirect('/admin/kyc?review=' + encodeURIComponent(status) + '&email=' + encodeURIComponent(emailStatus));
  } catch(e) { next(e); }
});

app.get('/api/deposit-status/:id', requireAuth, async (req,res,next) => {
  const id=String(req.params.id||'');
  if(!/^\d{1,20}$/.test(id))return res.status(400).json({error:'invalid_request'});
  try {
    const [[row]]=await pool.execute('SELECT status FROM deposit_requests WHERE id=? AND member_id=?',[id,req.session.memberId]);
    if(!row)return res.status(404).json({error:'request_not_found'});
    res.set('Cache-Control','no-store');
    res.json({status:row.status});
  } catch(e) { if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).json({error:'status_unavailable'}); next(e); }
});
app.get('/api/admin/notifications/summary', requireAdmin, async (req,res,next) => {
  const count = async (sql) => { try { const [[row]] = await pool.query(sql); return Number(row.total)||0; } catch(e) { if(['ER_NO_SUCH_TABLE','ER_BAD_FIELD_ERROR'].includes(e.code)) return 0; throw e; } };
  try {
    const [kyc,deposits,withdrawals,community,cooperative] = await Promise.all([
      count("SELECT COUNT(*) AS total FROM kyc_submissions WHERE status='pending'"),
      count("SELECT COUNT(*) AS total FROM deposit_requests WHERE status='pending'"),
      count("SELECT COUNT(*) AS total FROM withdrawal_requests WHERE status='pending'"),
      count("SELECT COUNT(*) AS total FROM community_posts WHERE status='pending'"),
      count("SELECT COUNT(*) AS total FROM online_cooperative_connections WHERE status='pending'")
    ]);
    res.set('Cache-Control','no-store');
    res.json({count:kyc+deposits+withdrawals+community+cooperative, queues:{kyc,deposits,withdrawals,community,cooperative}});
  } catch(e) { next(e); }
});
app.get('/api/notifications/unread-count', requireAuth, async (req,res,next) => {
  try {
    const [[row]]=await pool.execute('SELECT COUNT(*) AS total FROM member_notifications WHERE member_id=? AND read_at IS NULL',[req.session.memberId]);
    res.set('Cache-Control','no-store');
    res.json({count:Number(row.total)||0});
  } catch(e) { if(e.code==='ER_NO_SUCH_TABLE')return res.status(200).json({count:0}); next(e); }
});
app.get('/notifications', requireAuth, async (req,res,next) => {
  try {
    const m = await getMemberForPage(req,res);
    if (!m) return;
    const [rows] = await pool.execute('SELECT id,notification_type,title,body,target_url,read_at,created_at FROM member_notifications WHERE member_id=? ORDER BY created_at DESC LIMIT 100',[m.id]);
    const unread = rows.filter(n => !n.read_at).length;
    const items = rows.map(n => {
      const type = String(n.notification_type || 'account_update').toLowerCase();
      const title = String(n.title || 'Account update');
      const rawBody = String(n.body || '');
      const titleLower = title.toLowerCase();
      const meta = ({
        kyc_review: { label: 'Identity verification', icon: '✓', tone: 'gold' },
        deposit_review: { label: 'Deposit update', icon: '↗', tone: 'green' },
        withdrawal_review: { label: 'Withdrawal update', icon: '↙', tone: 'blue' },
        investment_purchase: { label: 'Investment activity', icon: '◇', tone: 'gold' },
        cooperative_review: { label: 'Online Cooperative', icon: '♙', tone: 'gold' },
        community_comment: { label: 'Community reply', icon: '◉', tone: 'blue' },
        community_review: { label: 'Community review', icon: '◉', tone: 'gold' },
        community_report: { label: 'Community moderation', icon: '⚑', tone: 'gold' }
      })[type] || { label: 'Account update', icon: '•', tone: 'gold' };
      let safeTarget = null;
      if (type === 'kyc_review') safeTarget = '/kyc';
      else if (type === 'deposit_review') safeTarget = titleLower.includes('approved') ? '/transactions' : '/deposit';
      else if (type === 'withdrawal_review') safeTarget = titleLower.includes('paid') ? '/transactions' : '/withdraw';
      else if (type === 'investment_purchase') safeTarget = '/investments';
      else if (type === 'cooperative_review') safeTarget = '/online-cooperative';
      else if (type === 'community_comment') safeTarget = '/community';
      else if (['/dashboard','/profile','/kyc','/deposit','/withdraw','/transactions','/investments','/notifications','/community','/social-links','/online-cooperative'].includes(n.target_url)) safeTarget = n.target_url;
      let messageHtml = '';
      const isKycApproved = type === 'kyc_review' && /\bapproved\b|\bverified\b/i.test(title);
      const isKycRejected = type === 'kyc_review' && !isKycApproved && /not approved|unable to approve|needs attention|rejected/i.test(rawBody + ' ' + title);
      const isKycResubmission = type === 'kyc_review' && !isKycApproved && !isKycRejected && /needs attention|resubmission|required|action required|update your identity/i.test(rawBody + ' ' + title);
      if (isKycApproved) {
        messageHtml = '<p class="notification-lead">Congratulations! Your identity verification has been approved.</p>' +
          '<div class="notification-next" style="border-color:#285c3a;background:#101d15"><strong style="color:#8be0a4">You’re verified</strong><p>No further KYC action is required at this time. You can view your verification status on the identity verification page.</p></div>';
      } else if (isKycRejected || isKycResubmission) {
        const reasonMatch = rawBody.match(/Reason(?: for the decision)?:\s*([\s\S]*?)(?=\n\nReview team feedback:|\n\nAdditional details:|\s+Additional details:|\s+Please review the feedback|$)/i);
        const feedbackMatch = rawBody.match(/(?:Review team feedback:|Additional details:)\s*([\s\S]*?)(?=\n\nNext steps:|\s+Please review the feedback|$)/i);
        const nextStepsMatch = rawBody.match(/Next steps:\s*([\s\S]*?)$/i);
        const reasonText = reasonMatch ? reasonMatch[1].trim() : '';
        let feedbackText = feedbackMatch ? feedbackMatch[1].trim() : '';
        const nextStepsText = nextStepsMatch ? nextStepsMatch[1].trim() : '';
        feedbackText = feedbackText.replace(/Thank for your cooperation\.?/gi, 'Thank you for your cooperation.');
        const lead = isKycResubmission
          ? 'Our review team needs you to update your identity verification before it can be approved.'
          : 'We’re unable to approve your identity verification at this time.';
        messageHtml = '<p class="notification-lead">' + esc(lead) + '</p>' +
          (reasonText ? '<div class="notification-detail"><span>Reason for decision</span><p>' + esc(reasonText) + '</p></div>' : '') +
          (feedbackText ? '<div class="notification-detail"><span>Review team feedback</span><p>' + esc(feedbackText) + '</p></div>' : '') +
          (nextStepsText ? '<div class="notification-next"><strong>What to do next</strong><p>' + esc(nextStepsText) + '</p></div>' : '<div class="notification-next"><strong>What to do next</strong><p>Open the identity verification page, review the requested corrections, and submit your updated application. Contact support if you need assistance.</p></div>');
      } else {
        messageHtml = rawBody.split(/\n{2,}/).map(part => part.trim()).filter(Boolean).map(part => '<p>' + esc(part).replace(/\n/g, '<br>') + '</p>').join('');
      }
      const dateLabel = n.created_at ? esc(n.created_at) : 'Recent';
      return '<article class="member-card notification-card ' + (n.read_at ? 'is-read' : 'is-unread') + ' notification-tone-' + meta.tone + '"><div class="notification-card-top"><div class="notification-icon" aria-hidden="true">' + meta.icon + '</div><div class="notification-title-group"><span class="notification-category">' + esc(meta.label) + '</span><h3>' + esc(title) + '</h3><time class="notification-time">' + dateLabel + '</time></div><span class="notification-state ' + (n.read_at ? 'is-read' : 'is-new') + '">' + (n.read_at ? 'Read' : 'New') + '</span></div><div class="notification-message">' + messageHtml + '</div><div class="notification-actions">' + (safeTarget ? '<a class="notification-open" href="' + esc(safeTarget) + '">View details <span aria-hidden="true">→</span></a>' : '') + (!n.read_at ? '<form method="post" action="/notifications/' + encodeURIComponent(n.id) + '/read">' + csrfField(req) + '<button class="notification-mark-read" type="submit">Mark as read</button></form>' : '') + '</div></article>';
    }).join('');
    const content = '<section class="member-card notification-intro"><div><span class="notification-category">YOUR ACCOUNT</span><h2>Notifications</h2><p class="muted">Important updates about verification, deposits, withdrawals and account activity.</p></div><div class="notification-unread-count"><strong>' + unread + '</strong><span>unread</span></div>' + (unread ? '<form method="post" action="/notifications/read-all">' + csrfField(req) + '<button class="notification-mark-read" type="submit">Mark all as read</button></form>' : '') + '</section><div class="notification-list">' + (items || '<section class="member-card notification-empty"><div class="notification-empty-icon" aria-hidden="true">✓</div><h3>You’re all caught up</h3><p class="muted">When there is an important update to your account, it will appear here.</p></section>') + '</div><style>.notification-intro{display:flex;align-items:center;justify-content:space-between;gap:18px;flex-wrap:wrap;padding:clamp(18px,4vw,28px);margin-bottom:18px;background:radial-gradient(ellipse at top right,#2b2512 0,transparent 58%),var(--member-card-bg,#111115);border:1px solid #5b4b20;border-radius:18px}.notification-intro h2{margin:5px 0 7px;font-size:clamp(1.35rem,4vw,1.8rem);letter-spacing:-.03em}.notification-intro p{margin:0;max-width:520px;line-height:1.6}.notification-category{display:block;color:#d9bb4a;font-size:.72rem;font-weight:800;letter-spacing:.12em;text-transform:uppercase}.notification-unread-count{display:grid;justify-items:center;min-width:70px;padding:10px 14px;border:1px solid #5b4b20;border-radius:12px;background:#19170f}.notification-unread-count strong{font-size:1.4rem;color:#f6d43c}.notification-unread-count span{font-size:.72rem;color:#c4bdab}.notification-list{display:grid;gap:14px}.notification-card{padding:clamp(16px,3vw,24px);border:1px solid #35313a;border-radius:16px;background:linear-gradient(145deg,#17161c,#101014);box-shadow:0 10px 26px #0002;min-width:0}.notification-card.is-unread{border-color:#766021;box-shadow:inset 3px 0 0 #d9b735,0 10px 26px #0002}.notification-card.notification-tone-green{--notice-accent:#7cdda0}.notification-card.notification-tone-blue{--notice-accent:#86c9ff}.notification-card.notification-tone-gold{--notice-accent:#f1d04a}.notification-card-top{display:flex;align-items:flex-start;gap:12px;min-width:0}.notification-icon{display:grid;place-items:center;flex:0 0 42px;width:42px;height:42px;border-radius:13px;background:#272212;border:1px solid #62501b;color:var(--notice-accent,#f1d04a);font-size:1.2rem;font-weight:850}.notification-title-group{flex:1;min-width:0}.notification-title-group h3{margin:4px 0 5px;color:#f6f3e9;font-size:1.04rem;line-height:1.35;overflow-wrap:anywhere}.notification-time{font-size:.78rem;color:#a9a5b1}.notification-state{flex:0 0 auto;padding:5px 9px;border-radius:999px;font-size:.72rem;font-weight:800}.notification-state.is-new{background:#332a10;border:1px solid #796221;color:#ffe47a}.notification-state.is-read{background:#25242a;border:1px solid #44414b;color:#c3bfca}.notification-message{margin:18px 0 0;padding-left:54px;color:#d5d1dc;font-size:.94rem;line-height:1.75;overflow-wrap:anywhere}.notification-message>p{margin:0 0 12px}.notification-message>p:last-child{margin-bottom:0}.notification-lead{color:#f0edf5;font-weight:600}.notification-detail,.notification-next{margin-top:12px;padding:12px 14px;border:1px solid #3e3946;border-radius:11px;background:#0d0d11}.notification-detail>span{display:block;margin-bottom:5px;color:#c9b76c;font-size:.72rem;font-weight:800;letter-spacing:.07em;text-transform:uppercase}.notification-detail p,.notification-next p{margin:0;white-space:pre-line}.notification-next{border-color:#57491d;background:#19160d}.notification-next strong{display:block;margin-bottom:5px;color:#f2d35b;font-size:.83rem}.notification-actions{display:flex;align-items:center;flex-wrap:wrap;gap:9px;margin-top:18px;padding-left:54px}.notification-actions form{margin:0}.notification-open,.notification-mark-read{display:inline-flex;align-items:center;justify-content:center;gap:9px;min-height:42px;padding:10px 14px;border-radius:10px;font:inherit;font-size:.85rem;font-weight:800;text-decoration:none;cursor:pointer}.notification-open{background:#f2d34f;border:1px solid #f2d34f;color:#17140a}.notification-open:hover,.notification-open:focus-visible{background:#ffe779;border-color:#ffe779;outline:2px solid #f2d34f;outline-offset:2px;text-decoration:none}.notification-mark-read{background:#222127;border:1px solid #494550;color:#e9e5ef}.notification-mark-read:hover,.notification-mark-read:focus-visible{border-color:#b8a24a;outline:2px solid #b8a24a;outline-offset:2px}.notification-empty{text-align:center;padding:36px 18px}.notification-empty-icon{display:grid;place-items:center;width:54px;height:54px;margin:0 auto 12px;border-radius:50%;background:#1b241c;border:1px solid #365b3e;color:#91e4a5;font-size:1.4rem}.notification-empty h3{margin:0 0 8px}.notification-empty p{margin:0}@media(max-width:520px){.notification-card-top{gap:9px}.notification-icon{flex-basis:36px;width:36px;height:36px;border-radius:11px}.notification-title-group h3{font-size:.98rem}.notification-state{padding:4px 7px}.notification-message,.notification-actions{padding-left:0}.notification-message{font-size:.91rem}.notification-intro{align-items:flex-start}.notification-unread-count{margin-left:auto}}</style>';
    res.send(memberPage('Notifications','/notifications',m,content,req));
  } catch(e) { if(e.code === 'ER_NO_SUCH_TABLE') return res.status(503).send(page('Notifications unavailable','<h1>Notifications temporarily unavailable</h1><p class="muted">Please try again later.</p>')); next(e); }
});
app.post('/notifications/read-all', requireAuth, express.urlencoded({extended:false,limit:'5kb'}), csrfCheck, async (req,res,next) => {
  try {
    await pool.execute('UPDATE member_notifications SET read_at=COALESCE(read_at,CURRENT_TIMESTAMP) WHERE member_id=? AND read_at IS NULL',[req.session.memberId]);
    res.redirect('/notifications');
  } catch(e) { if(e.code === 'ER_NO_SUCH_TABLE') return res.status(503).send(page('Notifications unavailable','<h1>Notifications temporarily unavailable</h1><p class="muted">Please try again later.</p>')); next(e); }
});
app.post('/notifications/:id/read', requireAuth, express.urlencoded({extended:false,limit:'5kb'}), csrfCheck, async (req,res,next) => {
  const id = String(req.params.id || '');
  if (!/^\d{1,20}$/.test(id)) return res.sendStatus(400);
  try {
    await pool.execute('UPDATE member_notifications SET read_at=COALESCE(read_at,CURRENT_TIMESTAMP) WHERE id=? AND member_id=?',[id,req.session.memberId]);
    res.redirect('/notifications');
  } catch(e) { if(e.code === 'ER_NO_SUCH_TABLE') return res.status(503).send(page('Notifications unavailable','<h1>Notifications are not configured yet</h1>')); next(e); }
});

app.get('/api/kyc/access-status', requireAuth, async (req,res,next) => {
  try {
    // Approval is persistent: once any KYC application is approved, do not
    // show KYC locks again because of a stale/duplicate older submission row.
    const [[approval]] = await pool.execute(
      "SELECT EXISTS(SELECT 1 FROM kyc_submissions WHERE member_id=? AND LOWER(TRIM(status))='approved') AS approved",
      [req.session.memberId]
    );
    const approved = Number(approval && approval.approved) === 1;
    res.set('Cache-Control','no-store, private');
    return res.json({approved,status:approved ? 'approved' : 'not_approved'});
  } catch (error) {
    if (error && error.code === 'ER_NO_SUCH_TABLE') return res.status(200).json({approved:false,status:'not_submitted'});
    return next(error);
  }
});

app.get('/dashboard', requireAuth, async (req, res, next) => {
  try {
    const [rows] = await pool.execute('SELECT id, monarch_uid, full_name, email, username FROM members WHERE id = ? LIMIT 1', [req.session.memberId]);
    const member = rows[0];
    if (!member) { req.session.destroy(() => res.redirect('/login')); return; }
    const [counts] = await pool.execute('SELECT COUNT(*) AS total FROM members WHERE referred_by = ?', [member.id]);
    let unreadNotificationCount = 0;
    try {
      const [[notificationCount]] = await pool.execute('SELECT COUNT(*) AS total FROM member_notifications WHERE member_id=? AND read_at IS NULL', [member.id]);
      unreadNotificationCount = Number(notificationCount && notificationCount.total) || 0;
    } catch (e) {
      if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
    }
    let verificationStatus = 'Not submitted', verificationHint = 'Verify account';
    try { const [kycRows] = await pool.execute('SELECT status FROM kyc_submissions WHERE member_id = ? ORDER BY submitted_at DESC, id DESC LIMIT 1', [member.id]); if (kycRows.length) { const labels = {pending:'Pending review',approved:'Approved',rejected:'Rejected',needs_resubmission:'Resubmission required'}; verificationStatus = labels[kycRows[0].status] || 'Submitted'; verificationHint = ['rejected','needs_resubmission'].includes(kycRows[0].status) ? 'Review verification' : 'View verification'; } } catch (e) { if (e.code !== 'ER_NO_SUCH_TABLE') throw e; }
    const baseUrl = (process.env.APP_BASE_URL || 'https://monarchcodex.online').replace(/\/+$/, '');
    const referralLink = baseUrl + '/register?ref=' + encodeURIComponent(member.monarch_uid);
    let recentTransactions=[]; let ledgerReady=true;
    try { const [txRows]=await pool.execute('SELECT transaction_type,currency,amount,reference,created_at FROM financial_transactions WHERE member_id=? ORDER BY created_at DESC LIMIT 5',[member.id]); recentTransactions=txRows; }
    catch(e){ if(e.code==='ER_NO_SUCH_TABLE') ledgerReady=false; else throw e; }
    let investmentTotals=[]; let earningsTotals=[]; let investmentDataReady=true; let earningsDataReady=true;
    try { const [investmentRows]=await pool.execute("SELECT currency,SUM(principal_amount) AS total FROM member_investments WHERE member_id=? AND status IN ('active','matured') GROUP BY currency",[member.id]); investmentTotals=investmentRows; } catch(e){ if(e.code==='ER_NO_SUCH_TABLE') investmentDataReady=false; else throw e; }
    try { const [earningRows]=await pool.execute("SELECT currency,SUM(amount) AS total FROM financial_transactions WHERE member_id=? AND transaction_type IN ('investment_profit','admin_bonus') GROUP BY currency",[member.id]); earningsTotals=earningRows; } catch(e){ if(e.code==='ER_NO_SUCH_TABLE') earningsDataReady=false; else throw e; }
    let dashboardConversionRate=null;
    try {
      const [[fx]]=await pool.query('SELECT base_usd_ngn_rate,markup_percent FROM deposit_pricing_settings WHERE id=1');
      const rate=fx && Number(fx.base_usd_ngn_rate)>0 ? Number(fx.base_usd_ngn_rate)*(1+Number(fx.markup_percent||0)/100) : null;
      if(Number.isFinite(rate) && rate>0) dashboardConversionRate=rate;
    } catch(e) { if(e.code!=='ER_NO_SUCH_TABLE') throw e; }
    const moneyPair=rows=>{
      const v={USD:0,NGN:0};
      for(const r of rows){
        if(Object.prototype.hasOwnProperty.call(v,r.currency)) v[r.currency]=Number(r.total)||0;
      }
      if(dashboardConversionRate){
        const totalNgn=v.NGN+(v.USD*dashboardConversionRate);
        const totalUsd=v.USD+(v.NGN/dashboardConversionRate);
        return 'USD $'+totalUsd.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})+' · NGN ₦'+totalNgn.toLocaleString('en-NG',{minimumFractionDigits:2,maximumFractionDigits:2});
      }
      const parts=[];
      if(v.USD!==0) parts.push('USD $'+v.USD.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}));
      if(v.NGN!==0) parts.push('NGN ₦'+v.NGN.toLocaleString('en-NG',{minimumFractionDigits:2,maximumFractionDigits:2}));
      return parts.length?parts.join(' · '):'USD $0.00 · NGN ₦0.00 (FX rate unavailable)';
    };
    const investmentDisplay=investmentDataReady?moneyPair(investmentTotals):'Not available';
    const earningsDisplay=earningsDataReady?moneyPair(earningsTotals):'Not available';
    const recentActivityHtml=recentTransactions.length?'<div class="dashboard-recent-list">'+recentTransactions.map(t=>'<a class="dashboard-recent-item" href="/transactions"><span class="dashboard-recent-icon">'+(Number(t.amount)<0?'↗':'✓')+'</span><span class="dashboard-recent-main"><strong>'+esc(String(t.transaction_type||'transaction').replace(/[_-]+/g,' ').replace(/\\b\\w/g,c=>c.toUpperCase()))+'</strong><small>'+esc(t.reference||'Recorded transaction')+' · '+esc(t.created_at)+'</small></span><strong class="dashboard-recent-amount '+(Number(t.amount)<0?'is-debit':'is-credit')+'">'+(Number(t.amount)<0?'−':'＋')+esc(String(t.currency||''))+' '+esc(Math.abs(Number(t.amount)||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:8}))+'</strong></a>').join('')+'</div>':'<div class="section-card"><strong>'+(ledgerReady?'Your activity starts here':'Activity history is being prepared')+'</strong><p class="muted small">'+(ledgerReady?'Completed deposits and investment purchases will appear here as soon as they are recorded. You can view submitted deposit and withdrawal requests in transaction history.':'The financial activity table is not installed yet. Contact support or your administrator to complete the database setup.')+'</p></div>';
    const body = '<link rel="stylesheet" href="/member-dashboard.css?v=20261019-light-contrast1"><div class="dashboard-layout">'+
      '<button class="sidebar-scrim" type="button" data-sidebar-close aria-label="Close navigation"></button><aside class="dashboard-sidebar" id="memberSidebar"><div class="sidebar-brand-row"><div class="side-title">MEMBER MENU</div><button class="icon-btn sidebar-close sidebar-desktop-toggle" type="button" data-sidebar-collapse aria-label="Collapse sidebar" title="Collapse sidebar" aria-expanded="true"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6M4 4v16"/></svg></button><button class="icon-btn sidebar-close" type="button" data-sidebar-close aria-label="Close menu"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></div><div class="dashboard-sidebar-scroll-controls" aria-label="Scroll member sidebar"><button type="button" data-dashboard-rail-scroll="up" aria-label="Scroll sidebar up" title="Scroll up">↑</button><span>SCROLL</span><button type="button" data-dashboard-rail-scroll="down" aria-label="Scroll sidebar down" title="Scroll down">↓</button></div><nav aria-label="Member dashboard navigation">' +
      renderMemberNavigation('/dashboard') +'</nav><div class="sidebar-uid"><span class="muted small">YOUR MONARCH ID</span><div class="sidebar-uid-value"><strong id="memberUid">' + esc(member.monarch_uid) + '</strong><button class="copy-btn" type="button" data-copy-target="memberUid" aria-label="Copy Monarch ID">Copy</button></div></div><div class="sidebar-logout"><form method="post" action="/logout">' + csrfField(req) + '<button class="sidebar-logout-btn" type="submit"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 17l5-5-5-5M15 12H3M21 4v16"/></svg><span class="nav-text">Log out</span></button></form></div></aside><button class="sidebar-scrim" type="button" data-sidebar-close aria-label="Close navigation"></button><div class="dashboard-content"><div class="mobile-dashboard-bar"><button class="icon-btn sidebar-open" type="button" data-sidebar-open aria-label="Open navigation" aria-controls="memberSidebar"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg></button><span>MEMBER AREA</span><span class="mobile-current-tab">Overview</span></div><section class="panel">' +
      '<div class="dashboard-topline"><div><div class="muted small">MONARCH MEMBER AREA</div><h1>Welcome, ' + esc(member.full_name.split(' ')[0]) + '</h1><p class="muted">Your membership overview and account tools.</p></div><a href="/notifications" class="member-notification-bell dashboard-notification-bell dashboard-overview-bell" aria-label="Notifications' + (unreadNotificationCount ? ', ' + unreadNotificationCount + ' unread' : '') + '" title="Notifications"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></svg>' + (unreadNotificationCount ? '<span class="dashboard-notification-bell-count">' + (unreadNotificationCount > 99 ? '99+' : unreadNotificationCount) + '</span>' : '') + '</a></div>' +
      '<section id="overview" class="dashboard-section overview-intro"><div class="overview-title-row"><div><span class="muted small">YOUR ACCOUNT</span><h2>Overview</h2></div><span class="account-live"><i></i> Account active</span></div>' +
      '<div class="grid dashboard-metrics"><div class="stat balance-primary"><span class="muted small balance-display-label">Wallet balance</span><div class="currency-toggle" role="group" aria-label="Choose wallet display currency"><button type="button" class="currency-toggle-option is-active" data-currency-toggle="NGN" aria-pressed="true"><span>₦</span> NGN</button><button type="button" class="currency-toggle-option" data-currency-toggle="USD" aria-pressed="false"><span>$</span> USD</button></div><select id="balanceCurrency" class="currency-select-accessible" aria-label="Wallet display currency"><option value="NGN" selected>Naira (NGN)</option><option value="USD">US Dollars (USD)</option></select><strong id="totalBalance">—</strong><p class="muted small" id="balanceConversionNote">Loading your wallet balances…</p></div><div class="stat"><span class="muted small">Investment balance</span><strong style="font-size:clamp(12px,1.8vw,17px);line-height:1.6">' + esc(investmentDisplay) + '</strong><p class="muted small">' + (investmentDataReady?'Recorded principal across active and matured investments':'Investment records unavailable until setup is complete') + '</p></div><div class="stat"><span class="muted small">Earnings &amp; bonuses</span><strong style="font-size:clamp(12px,1.8vw,17px);line-height:1.6">' + esc(earningsDisplay) + '</strong><p class="muted small">' + (earningsDataReady?'Recorded profit and bonus credits only':'Earnings records unavailable until setup is complete') + '</p></div><div class="stat"><span class="muted small">Verification</span><strong>' + esc(verificationStatus) + '</strong><a class="metric-link" href="/kyc">' + esc(verificationHint) + ' <span aria-hidden="true">→</span></a></div></div>' +
      '<div class="dashboard-section referral-summary"><div><span class="muted small">SUCCESSFUL REFERRALS</span><strong>' + (Number(counts[0].total) || 0) + '</strong></div><a href="/referrals">View referrals <span aria-hidden="true">→</span></a></div></section>' +
      '<section class="dashboard-section action-section"><div class="section-heading-row"><div><h2>Quick actions</h2><p class="muted">Everything you need, one tap away.</p></div><a href="/transactions" class="muted small">Activity <span aria-hidden="true">↗</span></a></div><div class="quick-action-grid" id="quickActions"><a href="/deposit"><span>＋</span><strong>Deposit</strong><small>Add funds</small></a><a href="/withdraw"><span>↗</span><strong>Withdraw</strong><small>Cash out</small></a><a href="/kyc"><span>◇</span><strong>Verify</strong><small>Identity check</small></a><a href="/transactions"><span>↻</span><strong>History</strong><small>Transactions</small></a><a href="/investments"><span>◆</span><strong>Buy package</strong><small>View investment plans</small></a><a href="/referrals"><span>♧</span><strong>Referrals</strong><small>Invite friends</small></a><a href="/profile"><span>◉</span><strong>Profile</strong><small>Account details</small></a><a href="/online-cooperative"><span>♙</span><strong>Online Cooperative</strong><small>Packages & benefits</small></a></div><button class="show-more-actions" type="button" id="toggleActions" aria-expanded="false" hidden>More actions</button></section>' +
      '<section class="dashboard-section"><div class="dashboard-topline"><div><h2>Recent activity</h2><p class="muted">Your latest recorded wallet transactions and account activity.</p></div><a href="/transactions" class="copy-btn" style="text-decoration:none">View all activity</a></div><style>.dashboard-recent-list{display:grid;gap:8px}.dashboard-recent-item{display:flex;align-items:center;gap:12px;min-width:0;padding:13px;border:1px solid #34312a;border-radius:13px;background:linear-gradient(145deg,#171719,#111113);color:inherit;text-decoration:none}.dashboard-recent-icon{display:grid;place-items:center;flex:0 0 34px;width:34px;height:34px;border-radius:11px;background:#252012;color:#e4c86d}.dashboard-recent-main{display:grid;gap:4px;min-width:0;flex:1}.dashboard-recent-main strong{font-size:12px;color:#f2ecdf;text-transform:capitalize}.dashboard-recent-main small{font-size:10px;color:#a6a093;overflow-wrap:anywhere}.dashboard-recent-amount{font-size:11px;white-space:nowrap}.dashboard-recent-amount.is-credit{color:#9bd0a8}.dashboard-recent-amount.is-debit{color:#e7a59a}@media(max-width:480px){.dashboard-recent-item{gap:8px;padding:10px}.dashboard-recent-amount{font-size:10px}.dashboard-recent-main small{max-width:140px}}</style>'+recentActivityHtml+'</section>' +
      '</section></div></div>';
    res.send(page('Member dashboard', body + '<script src="/wallet-balances.js?v=20261016-2" defer></script>' + '<script src="/member-dashboard.js?v=20261018-navigation-scroll3" defer></script>' + '<script src="/member-nav.js?v=20261023-community-badges2" defer></script>'));
  } catch (e) { next(e); }
});

function memberPage(title, active, member, content, req) {
  const nav = renderMemberNavigation(active);
  const firstName = esc((member.full_name || 'Member').split(' ')[0]);
  const uid = esc(member.monarch_uid || 'Pending');
  const avatarVersion = Date.now();
  const body = '<link rel="stylesheet" href="/member-dashboard.css?v=20261019-light-contrast1"><link rel="stylesheet" href="/assets/css/deposit-polish.css?v=20261017-nav-rebuild1"><div class="member-experience"><aside class="member-rail" id="memberRail"><a class="member-brand" href="/dashboard"><span class="member-brand-mark" style="display:block;flex:0 0 48px;width:48px;height:48px;aspect-ratio:1/1;overflow:hidden;border-radius:50%;border:2px solid #dfbd62;background:#17171c"><img src="/member-avatar-current?v=' + avatarVersion + '" data-member-avatar" alt="Your profile photo" style="display:block;width:100%;height:100%;aspect-ratio:1/1;object-fit:cover;object-position:center center;border-radius:50%"></span><span><strong>MONARCH</strong><small>CODEX</small></span></a><div class="member-rail-label">YOUR ACCOUNT</div><nav aria-label="Member navigation">' + nav + '</nav><div class="member-rail-scroll-controls" aria-label="Scroll member sidebar"><button type="button" data-rail-scroll="up" aria-label="Scroll sidebar up" title="Scroll up">↑</button><span>SCROLL</span><button type="button" data-rail-scroll="down" aria-label="Scroll sidebar down" title="Scroll down">↓</button></div><div class="member-rail-account"><span class="member-rail-label">MEMBER ID</span><div class="member-rail-uid"><strong id="memberUid">' + uid + '</strong><button type="button" class="member-copy-uid" data-copy-uid aria-label="Copy member ID">Copy</button></div><small>Keep your account details private.</small></div><div class="member-rail-logout"><form method="post" action="/logout">' + csrfField(req) + '<button type="submit">↪ <span>Log out</span></button></form></div></aside><div class="member-workspace"><header class="member-mobile-head"><button type="button" class="member-menu-toggle" aria-label="Open navigation" aria-expanded="false" data-member-menu>☰</button><a class="member-brand" href="/dashboard"><span class="member-brand-mark"><img src="/member-avatar-current?v=' + avatarVersion + '" data-member-avatar" alt="Your profile photo" style="width:100%;height:100%;aspect-ratio:1/1;object-fit:cover;object-position:center center;border-radius:50%"></span><span><strong>MONARCH</strong><small>CODEX</small></span></a><span class="member-live-dot" aria-label="Secure account"></span></header><div class="member-page-heading"><div><p class="member-overline">MONARCH CODEX / MEMBER AREA</p><h1>' + firstName + ', welcome back.</h1><p>Manage your account, verification and funds in one place.</p></div><div class="member-heading-actions"><a class="member-notification-bell" data-member-notification-bell href="/notifications" aria-label="Notifications" title="Notifications"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></svg><span data-member-notification-count hidden></span></a><div class="member-heading-status"><span></span> Account workspace</div></div></div><main class="member-main"><div class="member-content-heading"><div><span class="member-overline">ACCOUNT MANAGEMENT</span><h2>' + esc(title) + '</h2></div><span class="member-secure-label">⌑ Secure session</span></div>' + content + '</main><footer class="member-footer"><span>MONARCH CODEX</span><span>Move with clarity. Build with purpose.</span></footer></div></div><div class="member-mobile-scrim" data-member-close></div><div class="page-loading" id="pageLoading" aria-live="polite"><span class="page-spinner"></span><strong>Opening page…</strong></div><script>(function(){var rail=document.getElementById("memberRail"),toggle=document.querySelector("[data-member-menu]"),scrim=document.querySelector("[data-member-close]");document.querySelectorAll("[data-member-avatar]").forEach(function(img){img.addEventListener("error",function(){if(img.dataset.avatarFallback)return;img.dataset.avatarFallback="1";img.src="/assets/images/monarch-codex-logo.svg"})});function close(){rail.classList.remove("is-open");scrim.classList.remove("is-visible");if(toggle)toggle.setAttribute("aria-expanded","false")}if(toggle)toggle.addEventListener("click",function(){rail.classList.toggle("is-open");scrim.classList.toggle("is-visible");toggle.setAttribute("aria-expanded",rail.classList.contains("is-open")?"true":"false")});if(scrim)scrim.addEventListener("click",close);document.querySelectorAll(".member-experience nav a").forEach(function(a){a.addEventListener("click",function(){var loader=document.getElementById("pageLoading");if(loader)loader.classList.add("show")})});var railScrollButtons=document.querySelectorAll("[data-rail-scroll]");railScrollButtons.forEach(function(btn){btn.addEventListener("click",function(){if(!rail)return;var direction=btn.getAttribute("data-rail-scroll")==="up"?-1:1;rail.scrollBy({top:direction*Math.max(220,Math.round(rail.clientHeight*.65)),behavior:"smooth"})})});var copy=document.querySelector("[data-copy-uid]");if(copy)copy.addEventListener("click",async function(){try{await navigator.clipboard.writeText(document.getElementById("memberUid").textContent);copy.textContent="Copied";setTimeout(function(){copy.textContent="Copy"},1400)}catch(e){copy.textContent="Select ID"}})})();</script>' + '<script>(function(){var bell=document.querySelector("[data-member-notification-bell]"),badge=document.querySelector("[data-member-notification-count]");if(!bell||!badge)return;fetch("/api/notifications/unread-count",{credentials:"same-origin",cache:"no-store"}).then(function(r){if(!r.ok)throw new Error("unavailable");return r.json()}).then(function(d){var n=Number(d.count)||0;if(n>0){badge.hidden=false;badge.textContent=n>99?"99+":String(n);bell.setAttribute("aria-label","Notifications, "+n+" unread")}}).catch(function(){});})();</script>';
  return page('Member dashboard', body);
}
function wizardPage(title, content, req) {
  if (title === 'KYC Verification') {
    const body = '<link rel="stylesheet" href="/kyc-wizard.css?v=20261016-rebuild2"><div class="kyc-page"><header class="kyc-page-head"><a class="kyc-cancel" href="/dashboard">Cancel</a><div><p class="kyc-eyebrow">ACCOUNT VERIFICATION</p><h1>KYC Verification</h1></div><span class="kyc-head-spacer" aria-hidden="true"></span></header>' + content + '</div><script src="/kyc-wizard.js" defer></script>';
    return page(title, body);
  }
  const body = '<style>.wizard-shell{max-width:680px;margin:24px auto;padding:clamp(18px,4vw,34px);min-height:70vh}.wizard-head{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:30px}.wizard-head h1{font-size:1.2rem;margin:0}.wizard-cancel{color:#d7d4cb;text-decoration:none;border:1px solid #403a27;border-radius:10px;padding:10px 14px}.wizard-progress{display:flex;align-items:flex-start;gap:0;margin:0 0 32px}.wizard-progress .wizard-node{display:flex;flex-direction:column;align-items:center;gap:8px;flex:1;min-width:0;color:#8d897e;font-size:.78rem;text-align:center}.wizard-progress .wizard-dot{display:grid;place-items:center;width:32px;height:32px;border-radius:50%;border:1px solid #514721;background:#111115;color:#aaa}.wizard-progress .wizard-node.active .wizard-dot,.wizard-progress .wizard-node.done .wizard-dot{background:#f3cf3c;border-color:#f3cf3c;color:#17140a}.wizard-progress .wizard-node.active,.wizard-progress .wizard-node.done{color:#f3cf3c}.wizard-track{height:2px;background:#403a27;flex:1;margin:15px -2px 0;position:relative}.wizard-track span{display:block;height:100%;width:0;background:#f3cf3c;transition:width .3s ease}.wizard-panel{padding:clamp(18px,4vw,30px);border:1px solid #403a27;border-radius:18px;background:#111115}.wizard-panel h2{margin-top:0}.wizard-actions{display:flex;justify-content:space-between;gap:12px;margin-top:28px}.wizard-actions button{min-width:120px}.wizard-actions .wizard-continue{margin-left:auto}.wizard-foot{color:#8d897e;font-size:.85rem;margin-top:16px}.wizard-panel .member-card{padding:0;border:0;background:transparent}.wizard-panel .member-steps{display:none}@media(max-width:520px){.wizard-shell{margin:8px auto;padding:14px}.wizard-progress .wizard-node{font-size:.68rem}.wizard-progress .wizard-dot{width:28px;height:28px}.wizard-track{margin-top:13px}}</style><div class="wizard-shell"><header class="wizard-head"><a class="wizard-cancel" href="/dashboard">Cancel</a><h1>' + esc(title) + '</h1><span style="width:60px"></span></header><main class="wizard-panel">' + content + '</main></div><script>(function(){var k=document.getElementById("kycWizard"),d=document.getElementById("depositWizard");var form=k||d;if(!form)return;var isKyc=!!k;var progress=document.createElement("div");progress.className="wizard-progress";var count=isKyc?4:3;var names=isKyc?["Details","Address","Identity","Review"]:["Amount","Payment","Review"];for(var i=0;i<count;i++){if(i){var track=document.createElement("div");track.className="wizard-track";track.innerHTML="<span></span>";progress.appendChild(track)}var node=document.createElement("div");node.className="wizard-node";node.innerHTML="<span class=wizard-dot>"+(i+1)+"</span><span>"+names[i]+"</span>";progress.appendChild(node)}form.parentNode.insertBefore(progress,form);var steps=[].slice.call(form.querySelectorAll(isKyc?".kyc-step":".deposit-step"));var next=document.getElementById(isKyc?"kycNext":"depositNext"),back=document.getElementById(isKyc?"kycBack":"depositBack");function sync(){var idx=steps.findIndex(function(x){return !x.hidden});if(idx<0)idx=0;var nodes=progress.querySelectorAll(".wizard-node"),tracks=progress.querySelectorAll(".wizard-track span");nodes.forEach(function(n,i){n.classList.toggle("active",i===idx);n.classList.toggle("done",i<idx)});tracks.forEach(function(t,i){t.style.width=idx>i?"100%":"0"});if(back)back.textContent="Back";if(next)next.classList.add("wizard-continue")}var observer=new MutationObserver(sync);steps.forEach(function(x){observer.observe(x,{attributes:true,attributeFilter:["hidden"]})});if(next)next.addEventListener("click",function(){setTimeout(sync,0)});if(back)back.addEventListener("click",function(){setTimeout(sync,0)});sync()})();</script>' + '<script src="/member-nav.js?v=20261023-community-badges2" defer></script>';
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
function investmentSuccessCelebration(returnUrl='/investments'){return '<div class="photo-success-overlay investment-success-overlay" role="status" aria-live="polite"><div class="photo-success-card"><div class="photo-success-burst" aria-hidden="true"><span>🎉</span><span>✨</span><span>👑</span><span>✨</span><span>🎉</span></div><div class="photo-success-avatar-stage"><div class="photo-success-ribbon photo-success-ribbon-one">✦ MONARCH CODEX ✦ SUCCESS ✦</div><div class="photo-success-ribbon photo-success-ribbon-two">BUILD WEALTH · BUILD A KINGDOM</div><div class="photo-success-avatar"><img src="/assets/images/monarch-success-avatar.jpg" alt="Monarch Codex success avatar"></div><span class="photo-success-spark photo-success-spark-one">✦</span><span class="photo-success-spark photo-success-spark-two">✧</span><span class="photo-success-spark photo-success-spark-three">✨</span></div><div class="photo-success-check">✓</div><p class="photo-success-kicker">MONARCH CODEX · INVESTMENTS</p><h2>Investment Package Purchased!</h2><a class="photo-success-close" href="'+returnUrl+'" style="display:flex;align-items:center;justify-content:center;text-decoration:none;box-sizing:border-box">Continue to Investments</a></div></div><style>.photo-success-overlay{position:fixed;inset:0;z-index:99999;display:grid;place-items:center;overflow:hidden;padding:clamp(12px,3vw,24px);background:#fff;backdrop-filter:none;animation:psFade .25s ease-out}.photo-success-overlay:before{content:"";position:absolute;inset:0;background:#fff;z-index:0}.photo-success-overlay:after{content:"";position:absolute;inset:0;background:radial-gradient(ellipse at 50% 35%,#fff9df 0%,#fff 68%);pointer-events:none;z-index:0}.photo-success-card{z-index:2}.photo-success-card:after{content:none!important}.photo-success-card{position:relative;isolation:isolate;overflow:hidden;width:min(100%,520px);max-height:96dvh;overflow-y:auto;padding:clamp(20px,4vh,34px) clamp(16px,5vw,30px);text-align:center;color:#171717;border:1px solid #d5b747;border-radius:30px;background:#fff;box-shadow:0 20px 70px #a78b2a22}.photo-success-card:before{content:"";position:absolute;inset:0;z-index:-1;background:radial-gradient(circle at 50% 35%,#fff9d8 0,transparent 48%);pointer-events:none}.photo-success-avatar-stage{height:clamp(240px,38vh,340px);margin:0 auto 4px}.photo-success-avatar{width:clamp(170px,52vw,240px);height:clamp(170px,52vw,240px);border-width:5px;box-shadow:0 0 0 10px #f1d46b35,0 16px 42px #9c7c2630;animation:psAvatarSlide 2.8s cubic-bezier(.45,0,.25,1) infinite}.photo-success-avatar img{object-position:center 14%;transform:scale(1.28)}.photo-success-avatar-stage:before{width:clamp(205px,62vw,276px);height:clamp(205px,62vw,276px);border:2px solid #e5c34c;animation:psOrbit 7s linear infinite}.photo-success-avatar-stage:after{width:clamp(225px,68vw,300px);height:clamp(225px,68vw,300px);border:2px dashed #d9b53d;animation:psOrbit 11s linear infinite reverse}.photo-success-ribbon{font-size:clamp(8px,2.1vw,11px);padding:9px 16px;max-width:94%;overflow:hidden;text-overflow:ellipsis}.photo-success-ribbon-one{top:12px;animation:psRibbonSlideOne 3.2s ease-in-out infinite}.photo-success-ribbon-two{bottom:10px;animation:psRibbonSlideTwo 3.6s ease-in-out infinite}.photo-success-spark{color:#c49b1d;text-shadow:0 0 12px #f5d34d80}.photo-success-check{width:62px;height:62px;margin:8px auto 12px;border-color:#e0bd3e;background:#f4d65e;color:#17130a}.photo-success-kicker{color:#99771a}.photo-success-card h2{color:#171717;margin:8px 0 12px}.photo-success-card p:not(.photo-success-kicker){color:#555}.photo-success-burst{display:flex;justify-content:center;align-items:center;gap:clamp(8px,3vw,17px);font-size:clamp(19px,5vw,27px);letter-spacing:0;min-height:38px}.photo-success-burst span{display:inline-block;animation:psRibbonBounce 1s ease-in-out infinite;animation-delay:calc(var(--i,0)*.11s)}.photo-success-burst span:nth-child(1){--i:0}.photo-success-burst span:nth-child(2){--i:1}.photo-success-burst span:nth-child(3){--i:2}.photo-success-burst span:nth-child(4){--i:3}.photo-success-burst span:nth-child(5){--i:4}.photo-success-avatar-stage{position:relative;width:100%;height:208px;margin:10px auto 8px;display:grid;place-items:center;isolation:isolate}.photo-success-avatar-stage:before,.photo-success-avatar-stage:after{content:"";position:absolute;left:50%;top:50%;width:132px;height:132px;border:1px solid #f0cf6370;border-radius:50%;transform:translate(-50%,-50%);animation:psOrbit 5s linear infinite;z-index:-1}.photo-success-avatar-stage:after{width:156px;height:156px;border-style:dashed;opacity:.55;animation-duration:8s;animation-direction:reverse}.photo-success-avatar{position:relative;z-index:2;width:116px;height:116px;margin:0;border-radius:50%;overflow:hidden;border:3px solid #f0cf63;background:#fff;box-shadow:0 0 0 7px #e8c65219,0 10px 28px #0008;animation:psAvatarBounce 1.8s ease-in-out infinite}.photo-success-avatar img{display:block;width:100%;height:100%;object-fit:cover;object-position:center 16%;transform:scale(1.22)}.photo-success-ribbon{position:absolute;left:50%;z-index:3;white-space:nowrap;padding:8px 13px;border:1px solid #f7df83;border-radius:8px;background:linear-gradient(100deg,#9b7624,#f7df83 48%,#c49a2f);color:#1a1508;font-size:clamp(8px,2.2vw,10px);font-weight:950;letter-spacing:.1em;box-shadow:0 5px 14px #0003;pointer-events:none;max-width:94%;box-sizing:border-box}.photo-success-ribbon-one{top:13px;transform:translateX(-50%) rotate(-7deg);animation:psBannerOne 3.4s ease-in-out infinite}.photo-success-ribbon-two{bottom:9px;transform:translateX(-50%) rotate(5deg);animation:psBannerTwo 3.8s ease-in-out infinite}.photo-success-spark{position:absolute;color:#f6d85d;text-shadow:0 0 12px #f5d34d80;font-size:23px;z-index:4;animation:psSparkOrbit 2.2s ease-in-out infinite}.photo-success-spark-one{left:calc(50% - 91px);top:40px}.photo-success-spark-two{right:calc(50% - 94px);top:72px;animation-delay:.4s}.photo-success-spark-three{left:calc(50% + 65px);bottom:28px;font-size:17px}.photo-success-check{display:grid;place-items:center;width:76px;height:76px;margin:20px auto 16px;border:2px solid #f0cf63;border-radius:50%;background:#e8c652;color:#17130a;font-size:42px;font-weight:950;box-shadow:0 0 0 9px #e8c65219;animation:psPop .55s cubic-bezier(.2,1.5,.5,1)}.photo-success-kicker{font-size:11px;letter-spacing:.2em;color:#dfbd62;font-weight:900}.photo-success-card h2{font-size:clamp(23px,6vw,30px);line-height:1.15;margin:9px 0 12px}.photo-success-card p:not(.photo-success-kicker){color:#b8b2a5;line-height:1.55}.photo-success-close{width:100%;min-height:50px;margin-top:14px;border:0;border-radius:14px;background:linear-gradient(110deg,#f4dc82,#d8ad3d);color:#17130a;font-weight:900;font-size:15px}@keyframes psFade{from{opacity:0}to{opacity:1}}@keyframes psPop{from{transform:scale(.3) rotate(-18deg);opacity:0}to{transform:scale(1);opacity:1}}@keyframes psSparkle{to{transform:translateY(-4px) scale(1.06);filter:brightness(1.4)}}@keyframes psRibbonBounce{0%,100%{transform:translateY(0) rotate(-3deg) scale(1)}50%{transform:translateY(-8px) rotate(3deg) scale(1.12)}}@keyframes psAvatarBounce{0%,100%{transform:translateY(2px) rotate(-2deg)}50%{transform:translateY(-9px) rotate(2deg)}}@keyframes psOrbit{from{transform:translate(-50%,-50%) rotate(0)}to{transform:translate(-50%,-50%) rotate(360deg)}}@keyframes psBannerOne{0%,100%{translate:0 0;rotate:-7deg}50%{translate:0 -9px;rotate:4deg}}@keyframes psBannerTwo{0%,100%{translate:0 0;rotate:5deg}50%{translate:0 8px;rotate:-4deg}}@keyframes psSparkOrbit{0%,100%{transform:translateY(0) scale(.8);opacity:.65}50%{transform:translateY(-10px) scale(1.3);opacity:1}}.photo-success-close{position:relative;overflow:hidden;box-shadow:0 0 0 0 #f4dc8266;animation:psButtonPulse 2s ease-in-out infinite;transition:transform .2s,filter .2s}.photo-success-close:before{content:"";position:absolute;inset:-40% auto -40% -35%;width:25%;transform:skewX(-22deg);background:linear-gradient(90deg,transparent,#fff9,transparent);animation:psButtonShine 3.2s ease-in-out infinite}.photo-success-close:active{transform:scale(.97)}@keyframes psButtonPulse{0%,100%{box-shadow:0 0 0 0 #f4dc8233;filter:brightness(1)}50%{box-shadow:0 0 0 7px #f4dc8212;filter:brightness(1.08)}}@keyframes psButtonShine{0%,58%,100%{left:-35%}78%{left:120%}}@keyframes psAvatarSlide{0%,100%{transform:translateX(-9px) scale(.98) rotate(-2deg)}50%{transform:translateX(9px) scale(1.02) rotate(2deg)}}@keyframes psRibbonSlideOne{0%,100%{translate:-18px -3px;rotate:-7deg}50%{translate:18px -10px;rotate:5deg}}@keyframes psRibbonSlideTwo{0%,100%{translate:16px 2px;rotate:5deg}50%{translate:-16px 9px;rotate:-5deg}}@media(max-width:380px){.photo-success-card{padding:24px 16px}.photo-success-avatar-stage{height:160px}.photo-success-ribbon{font-size:8px;padding:6px 10px}}@media(prefers-reduced-motion:reduce){.photo-success-overlay,.photo-success-check,.photo-success-burst,.photo-success-burst span,.photo-success-avatar,.photo-success-avatar-stage:before,.photo-success-avatar-stage:after,.photo-success-ribbon,.photo-success-spark,.photo-success-close,.photo-success-close:before{animation:none!important;transition:none!important}}.investment-success-overlay .photo-success-card{border-color:#d9b84f}.investment-success-overlay .photo-success-close{display:flex;align-items:center;justify-content:center;cursor:pointer}</style><script>(function(){const o=document.querySelector(".photo-success-overlay");if(!o)return;const c=o.querySelector("[data-photo-success-continue]");if(c)c.addEventListener("click",function(){window.location.assign(window.location.pathname.startsWith("/admin/")?"/admin/profile":(window.location.pathname==="/investments"?"/investments":"/profile"))});for(let i=0;i<26;i++){const s=document.createElement("span");s.textContent=["✨","✦","🎉","✧","🎊"][i%5];s.style.cssText="position:absolute;left:"+(4+Math.random()*92)+"%;top:"+(5+Math.random()*85)+"%;font-size:"+(12+Math.random()*18)+"px;pointer-events:none;animation:psConfetti "+(1+Math.random()*1.8)+"s ease-out both";o.appendChild(s)}const st=document.createElement("style");st.textContent="@keyframes psConfetti{0%{transform:translateY(-10px) rotate(0);opacity:0}20%{opacity:1}100%{transform:translateY(70px) rotate(200deg);opacity:0}}";document.head.appendChild(st)})();</script>'}
function photoSuccessCelebration(returnUrl='/profile'){return '<div class="photo-success-overlay" role="status" aria-live="polite"><div class="photo-success-card"><div class="photo-success-burst" aria-hidden="true"><span>🎉</span><span>✨</span><span>👑</span><span>✨</span><span>🎉</span></div><div class="photo-success-avatar-stage"><div class="photo-success-ribbon photo-success-ribbon-one">✦ MONARCH CODEX ✦ SUCCESS ✦</div><div class="photo-success-ribbon photo-success-ribbon-two">BUILD WEALTH · BUILD A KINGDOM</div><div class="photo-success-avatar"><img src="/assets/images/monarch-success-avatar.jpg" alt="Monarch Codex success avatar"></div><span class="photo-success-spark photo-success-spark-one">✦</span><span class="photo-success-spark photo-success-spark-two">✧</span><span class="photo-success-spark photo-success-spark-three">✨</span></div><div class="photo-success-check">✓</div><p class="photo-success-kicker">MONARCH CODEX</p><h2>Image Uploaded Successfully!</h2><a class="photo-success-close" href="'+returnUrl+'" style="display:block;text-decoration:none;box-sizing:border-box">Continue</a></div></div><style>.photo-success-overlay{position:fixed;inset:0;z-index:99999;display:grid;place-items:center;overflow:hidden;padding:clamp(12px,3vw,24px);background:#fff;backdrop-filter:none;animation:psFade .25s ease-out}.photo-success-overlay:before{content:"";position:absolute;inset:0;background:#fff;z-index:0}.photo-success-overlay:after{content:"";position:absolute;inset:0;background:radial-gradient(ellipse at 50% 35%,#fff9df 0%,#fff 68%);pointer-events:none;z-index:0}.photo-success-card{z-index:2}.photo-success-card:after{content:none!important}.photo-success-card{position:relative;isolation:isolate;overflow:hidden;width:min(100%,520px);max-height:96dvh;overflow-y:auto;padding:clamp(20px,4vh,34px) clamp(16px,5vw,30px);text-align:center;color:#171717;border:1px solid #d5b747;border-radius:30px;background:#fff;box-shadow:0 20px 70px #a78b2a22}.photo-success-card:before{content:"";position:absolute;inset:0;z-index:-1;background:radial-gradient(circle at 50% 35%,#fff9d8 0,transparent 48%);pointer-events:none}.photo-success-avatar-stage{height:clamp(240px,38vh,340px);margin:0 auto 4px}.photo-success-avatar{width:clamp(170px,52vw,240px);height:clamp(170px,52vw,240px);border-width:5px;box-shadow:0 0 0 10px #f1d46b35,0 16px 42px #9c7c2630;animation:psAvatarSlide 2.8s cubic-bezier(.45,0,.25,1) infinite}.photo-success-avatar img{object-position:center 14%;transform:scale(1.28)}.photo-success-avatar-stage:before{width:clamp(205px,62vw,276px);height:clamp(205px,62vw,276px);border:2px solid #e5c34c;animation:psOrbit 7s linear infinite}.photo-success-avatar-stage:after{width:clamp(225px,68vw,300px);height:clamp(225px,68vw,300px);border:2px dashed #d9b53d;animation:psOrbit 11s linear infinite reverse}.photo-success-ribbon{font-size:clamp(8px,2.1vw,11px);padding:9px 16px;max-width:94%;overflow:hidden;text-overflow:ellipsis}.photo-success-ribbon-one{top:12px;animation:psRibbonSlideOne 3.2s ease-in-out infinite}.photo-success-ribbon-two{bottom:10px;animation:psRibbonSlideTwo 3.6s ease-in-out infinite}.photo-success-spark{color:#c49b1d;text-shadow:0 0 12px #f5d34d80}.photo-success-check{width:62px;height:62px;margin:8px auto 12px;border-color:#e0bd3e;background:#f4d65e;color:#17130a}.photo-success-kicker{color:#99771a}.photo-success-card h2{color:#171717;margin:8px 0 12px}.photo-success-card p:not(.photo-success-kicker){color:#555}.photo-success-burst{display:flex;justify-content:center;align-items:center;gap:clamp(8px,3vw,17px);font-size:clamp(19px,5vw,27px);letter-spacing:0;min-height:38px}.photo-success-burst span{display:inline-block;animation:psRibbonBounce 1s ease-in-out infinite;animation-delay:calc(var(--i,0)*.11s)}.photo-success-burst span:nth-child(1){--i:0}.photo-success-burst span:nth-child(2){--i:1}.photo-success-burst span:nth-child(3){--i:2}.photo-success-burst span:nth-child(4){--i:3}.photo-success-burst span:nth-child(5){--i:4}.photo-success-avatar-stage{position:relative;width:100%;height:208px;margin:10px auto 8px;display:grid;place-items:center;isolation:isolate}.photo-success-avatar-stage:before,.photo-success-avatar-stage:after{content:"";position:absolute;left:50%;top:50%;width:132px;height:132px;border:1px solid #f0cf6370;border-radius:50%;transform:translate(-50%,-50%);animation:psOrbit 5s linear infinite;z-index:-1}.photo-success-avatar-stage:after{width:156px;height:156px;border-style:dashed;opacity:.55;animation-duration:8s;animation-direction:reverse}.photo-success-avatar{position:relative;z-index:2;width:116px;height:116px;margin:0;border-radius:50%;overflow:hidden;border:3px solid #f0cf63;background:#fff;box-shadow:0 0 0 7px #e8c65219,0 10px 28px #0008;animation:psAvatarBounce 1.8s ease-in-out infinite}.photo-success-avatar img{display:block;width:100%;height:100%;object-fit:cover;object-position:center 16%;transform:scale(1.22)}.photo-success-ribbon{position:absolute;left:50%;z-index:3;white-space:nowrap;padding:8px 13px;border:1px solid #f7df83;border-radius:8px;background:linear-gradient(100deg,#9b7624,#f7df83 48%,#c49a2f);color:#1a1508;font-size:clamp(8px,2.2vw,10px);font-weight:950;letter-spacing:.1em;box-shadow:0 5px 14px #0003;pointer-events:none;max-width:94%;box-sizing:border-box}.photo-success-ribbon-one{top:13px;transform:translateX(-50%) rotate(-7deg);animation:psBannerOne 3.4s ease-in-out infinite}.photo-success-ribbon-two{bottom:9px;transform:translateX(-50%) rotate(5deg);animation:psBannerTwo 3.8s ease-in-out infinite}.photo-success-spark{position:absolute;color:#f6d85d;text-shadow:0 0 12px #f5d34d80;font-size:23px;z-index:4;animation:psSparkOrbit 2.2s ease-in-out infinite}.photo-success-spark-one{left:calc(50% - 91px);top:40px}.photo-success-spark-two{right:calc(50% - 94px);top:72px;animation-delay:.4s}.photo-success-spark-three{left:calc(50% + 65px);bottom:28px;font-size:17px}.photo-success-check{display:grid;place-items:center;width:76px;height:76px;margin:20px auto 16px;border:2px solid #f0cf63;border-radius:50%;background:#e8c652;color:#17130a;font-size:42px;font-weight:950;box-shadow:0 0 0 9px #e8c65219;animation:psPop .55s cubic-bezier(.2,1.5,.5,1)}.photo-success-kicker{font-size:11px;letter-spacing:.2em;color:#dfbd62;font-weight:900}.photo-success-card h2{font-size:clamp(23px,6vw,30px);line-height:1.15;margin:9px 0 12px}.photo-success-card p:not(.photo-success-kicker){color:#b8b2a5;line-height:1.55}.photo-success-close{width:100%;min-height:50px;margin-top:14px;border:0;border-radius:14px;background:linear-gradient(110deg,#f4dc82,#d8ad3d);color:#17130a;font-weight:900;font-size:15px}@keyframes psFade{from{opacity:0}to{opacity:1}}@keyframes psPop{from{transform:scale(.3) rotate(-18deg);opacity:0}to{transform:scale(1);opacity:1}}@keyframes psSparkle{to{transform:translateY(-4px) scale(1.06);filter:brightness(1.4)}}@keyframes psRibbonBounce{0%,100%{transform:translateY(0) rotate(-3deg) scale(1)}50%{transform:translateY(-8px) rotate(3deg) scale(1.12)}}@keyframes psAvatarBounce{0%,100%{transform:translateY(2px) rotate(-2deg)}50%{transform:translateY(-9px) rotate(2deg)}}@keyframes psOrbit{from{transform:translate(-50%,-50%) rotate(0)}to{transform:translate(-50%,-50%) rotate(360deg)}}@keyframes psBannerOne{0%,100%{translate:0 0;rotate:-7deg}50%{translate:0 -9px;rotate:4deg}}@keyframes psBannerTwo{0%,100%{translate:0 0;rotate:5deg}50%{translate:0 8px;rotate:-4deg}}@keyframes psSparkOrbit{0%,100%{transform:translateY(0) scale(.8);opacity:.65}50%{transform:translateY(-10px) scale(1.3);opacity:1}}.photo-success-close{position:relative;overflow:hidden;box-shadow:0 0 0 0 #f4dc8266;animation:psButtonPulse 2s ease-in-out infinite;transition:transform .2s,filter .2s}.photo-success-close:before{content:"";position:absolute;inset:-40% auto -40% -35%;width:25%;transform:skewX(-22deg);background:linear-gradient(90deg,transparent,#fff9,transparent);animation:psButtonShine 3.2s ease-in-out infinite}.photo-success-close:active{transform:scale(.97)}@keyframes psButtonPulse{0%,100%{box-shadow:0 0 0 0 #f4dc8233;filter:brightness(1)}50%{box-shadow:0 0 0 7px #f4dc8212;filter:brightness(1.08)}}@keyframes psButtonShine{0%,58%,100%{left:-35%}78%{left:120%}}@media(max-width:380px){.photo-success-card{padding:24px 16px}.photo-success-avatar-stage{height:160px}.photo-success-ribbon{font-size:8px;padding:6px 10px}}@media(prefers-reduced-motion:reduce){.photo-success-overlay,.photo-success-check,.photo-success-burst,.photo-success-burst span,.photo-success-avatar,.photo-success-avatar-stage:before,.photo-success-avatar-stage:after,.photo-success-ribbon,.photo-success-spark,.photo-success-close,.photo-success-close:before{animation:none!important;transition:none!important}}</style><script>(function(){const o=document.querySelector(".photo-success-overlay");if(!o)return;const c=o.querySelector("[data-photo-success-continue]");if(c)c.addEventListener("click",function(){window.location.assign(window.location.pathname.startsWith("/admin/")?"/admin/profile":(window.location.pathname==="/investments"?"/investments":"/profile"))});for(let i=0;i<26;i++){const s=document.createElement("span");s.textContent=["✨","✦","🎉","✧","🎊"][i%5];s.style.cssText="position:absolute;left:"+(4+Math.random()*92)+"%;top:"+(5+Math.random()*85)+"%;font-size:"+(12+Math.random()*18)+"px;pointer-events:none;animation:psConfetti "+(1+Math.random()*1.8)+"s ease-out both";o.appendChild(s)}const st=document.createElement("style");st.textContent="@keyframes psConfetti{0%{transform:translateY(-10px) rotate(0);opacity:0}20%{opacity:1}100%{transform:translateY(70px) rotate(200deg);opacity:0}}";document.head.appendChild(st)})();</script>'}
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
    const rolesCard = `<div class="profile-card" id="memberRolesCard"><div class="profile-card-top"><span class="profile-card-icon">♧</span><div><h4>My roles</h4><p class="profile-card-intro">Request Investor, Instructor, Student, Founder Partner, or another available role. Monarch Codex administrators review requests before a role is assigned.</p></div></div><div id="memberRoleNotice" class="profile-hint" role="status">Loading available roles…</div><div id="memberAssignedRoles"></div><div id="memberRoleOptions"></div><div id="memberRoleRequests"></div></div><script>(function(){const notice=document.getElementById('memberRoleNotice'),assigned=document.getElementById('memberAssignedRoles'),options=document.getElementById('memberRoleOptions'),requests=document.getElementById('memberRoleRequests');const esc=v=>String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));async function api(path,body){const r=await fetch('/api/mobile'+path,{method:body?'POST':'GET',credentials:'same-origin',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});const d=await r.json().catch(()=>({message:'Unexpected response'}));if(!r.ok)throw new Error(d.message||d.error||'Request failed');return d}async function load(){try{const d=await api('/roles');notice.textContent='Roles are granted only after administrator approval.';const roles=d.roles||[],mine=roles.filter(r=>r.assigned),available=roles.filter(r=>!r.assigned);assigned.innerHTML=mine.length?'<p><strong>Assigned roles</strong></p>'+mine.map(r=>'<span class="profile-hint" style="display:inline-block;margin:4px">'+esc(r.role_name)+'</span>').join(''):'<p class="profile-hint">No roles assigned yet.</p>';options.innerHTML=available.length?'<p><strong>Available roles</strong></p>'+available.map(r=>'<article style="padding:12px 0;border-top:1px solid #39342a"><strong>'+esc(r.role_name)+'</strong><p class="profile-hint">'+esc(r.description||'Request administrator approval for this role.')+'</p><button type="button" class="btn" data-role-request="'+Number(r.id)+'">Request role</button></article>').join(''):'<p class="profile-hint">There are no other active roles available right now.</p>';requests.innerHTML=(d.requests||[]).length?'<p><strong>Recent requests</strong></p>'+(d.requests||[]).map(r=>'<p class="profile-hint">'+esc(r.role_name)+' — '+esc(r.status)+'</p>').join(''):'';}catch(e){notice.textContent=e.message+' If role setup is pending, the website administrator must apply migration 018.';}}options.addEventListener('click',async e=>{const b=e.target.closest('[data-role-request]');if(!b)return;b.disabled=true;try{await api('/roles/request',{roleId:Number(b.dataset.roleRequest),message:''});notice.textContent='Role request submitted for review.';await load()}catch(err){notice.textContent=err.message;b.disabled=false}});load()})();</script>`;
    const content='<style>'+
      '.profile-experience{display:grid;gap:18px;min-width:0;color:#eee9dc}'+
      '.profile-hero{position:relative;isolation:isolate;overflow:hidden;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:20px;align-items:center;padding:clamp(20px,3.5vw,32px);border:1px solid rgba(223,189,98,.28);border-radius:22px;background:radial-gradient(ellipse at 95% 0%,rgba(223,189,98,.17),transparent 35%),linear-gradient(135deg,#1c1a15,#111113 62%,#19160f)}'+
      '.profile-hero:after{content:"";position:absolute;z-index:-1;right:-72px;bottom:-115px;width:190px;height:190px;border:1px solid rgba(223,189,98,.14);border-radius:50%;box-shadow:0 0 0 20px rgba(223,189,98,.025),0 0 0 42px rgba(223,189,98,.02)}'+
      '.profile-hero-main{display:flex;align-items:center;gap:18px;min-width:0}'+
      '.profile-avatar{display:block;flex:0 0 auto;width:88px;height:88px;min-width:88px;aspect-ratio:1/1;object-fit:cover;object-position:center center;border-radius:50%;border:2px solid #dfbd62;background:#17171c;box-shadow:0 8px 24px rgba(0,0,0,.25)}'+
      '.profile-eyebrow{margin:0 0 8px;color:#dfbd62;font-size:10px;font-weight:850;letter-spacing:.16em;text-transform:uppercase}'+
      '.profile-hero h3{margin:0;color:#fff8e8;font-size:clamp(22px,3.3vw,32px);line-height:1.15;letter-spacing:-.04em;overflow-wrap:anywhere}'+
      '.profile-username{margin:7px 0 12px;color:#aaa69a;font-size:13px}'+
      '.profile-public{display:inline-flex;align-items:center;gap:7px;color:#f0d681;font-size:12px;font-weight:800;text-decoration:none}'+
      '.profile-public:hover{text-decoration:underline}'+
      '.profile-state{display:inline-flex;align-items:center;gap:7px;max-width:220px;padding:10px 12px;border:1px solid rgba(223,189,98,.24);border-radius:999px;background:rgba(223,189,98,.07);color:#e8d69e;font-size:10px;font-weight:800;line-height:1.4}'+
      '.profile-state:before{content:"";width:6px;height:6px;flex:0 0 auto;border-radius:50%;background:#dfbd62}'+
      '.profile-section-heading{display:flex;align-items:flex-end;justify-content:space-between;gap:14px;margin:2px 0 0}'+
      '.profile-section-heading h3{margin:0;color:#f8f1df;font-size:18px;letter-spacing:-.025em}'+
      '.profile-section-heading p{margin:6px 0 0;color:#9e9a8e;font-size:12px;line-height:1.6}'+
      '.profile-card{min-width:0;padding:clamp(17px,2.7vw,24px);border:1px solid #383328;border-radius:18px;background:linear-gradient(145deg,#18181b,#111113);margin:0}'+
      '.profile-card-top{display:flex;align-items:flex-start;gap:12px;margin-bottom:19px}'+
      '.profile-card-icon{display:grid;place-items:center;width:38px;height:38px;flex:0 0 auto;border:1px solid rgba(223,189,98,.24);border-radius:12px;background:rgba(223,189,98,.08);color:#e5c66f;font-size:16px}'+
      '.profile-card h4{margin:0;color:#f5efdf;font-size:15px;letter-spacing:-.015em}'+
      '.profile-card-intro{margin:5px 0 0;color:#a7a295;font-size:12px;line-height:1.65}'+
      '.profile-form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:15px 16px}'+
      '.profile-form-grid .full{grid-column:1/-1}'+
      '.profile-experience label{display:block;margin:0 0 7px;color:#c9c2b1;font-size:11px;font-weight:750;letter-spacing:.025em}'+
      '.profile-experience input[type=text],.profile-experience input[type=email],.profile-experience input[type=tel],.profile-experience input[type=file],.profile-experience input:not([type]){width:100%;min-width:0;box-sizing:border-box;padding:12px 13px;border:1px solid #403a2d;border-radius:11px;background:#0c0c0e;color:#f2ecdf;font:inherit;font-size:13px;outline:none}'+
      '.profile-experience input:focus-visible{border-color:#dfbd62;box-shadow:0 0 0 3px rgba(223,189,98,.12)}'+
      '.profile-experience input[readonly]{color:#aaa69a;background:#141416}'+
      '.profile-hint{margin:14px 0;color:#9e9a8e;font-size:11px;line-height:1.7}'+
      '.profile-hint strong{color:#d8c98f}'+
      '.profile-save{display:inline-flex;align-items:center;justify-content:center;width:auto;min-height:42px;margin-top:5px;padding:11px 17px;border:1px solid #dfbd62;border-radius:11px;background:linear-gradient(135deg,#f1d98d,#d5ae4d);color:#17140b;font:inherit;font-size:12px;font-weight:900;cursor:pointer}'+
      '.profile-save:hover{filter:brightness(1.06)}'+
      '.profile-upload-row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:end;gap:14px}'+
      '.profile-bank-list{display:grid;gap:10px}'+
      '.saved-bank-row{display:flex;justify-content:space-between;align-items:center;gap:12px;min-width:0;padding:14px;border:1px solid #353126;border-radius:13px;background:#101012}'+
      '.saved-bank-main{display:flex;align-items:center;gap:12px;min-width:0}'+
      '.saved-bank-icon{display:grid;place-items:center;width:38px;height:38px;flex:0 0 auto;border-radius:12px;background:#211e16;color:#e6ca7c;font-size:17px}'+
      '.saved-bank-row strong{display:block;color:#f0eadb;font-size:12px;overflow-wrap:anywhere}'+
      '.saved-bank-row .profile-hint{margin:5px 0 0;font-size:11px}'+
      '.saved-bank-row form{margin:0;flex:0 0 auto}'+
      '.profile-remove{padding:8px 11px;border:1px solid #514035;border-radius:9px;background:#201716;color:#e7b5a5;font:inherit;font-size:11px;font-weight:800;cursor:pointer}'+
      '.profile-empty{padding:18px;border:1px dashed #403a2d;border-radius:13px;color:#9e9a8e;font-size:12px;line-height:1.7;text-align:center}'+
      '.profile-private-note{display:flex;align-items:flex-start;gap:10px;padding:13px 15px;border:1px solid #302d25;border-radius:13px;background:rgba(223,189,98,.035);color:#a7a295;font-size:11px;line-height:1.7}'+
      '@media(max-width:620px){.profile-hero{grid-template-columns:1fr;gap:16px}.profile-hero-main{align-items:flex-start}.profile-state{justify-self:start}.profile-avatar{width:72px;height:72px;border-radius:50%}.profile-form-grid{grid-template-columns:1fr}.profile-form-grid .full{grid-column:auto}.profile-upload-row{grid-template-columns:1fr}.profile-section-heading{align-items:flex-start;flex-direction:column}}'+
      '@media(max-width:380px){.profile-hero-main{gap:12px}.profile-avatar{width:60px;height:60px;border-radius:50%}.profile-save{width:100%}.saved-bank-row{align-items:flex-start}.saved-bank-main{gap:9px}}'+
      '@media(prefers-reduced-motion:reduce){.profile-experience *{scroll-behavior:auto!important;transition:none!important;animation:none!important}}'+
      '</style>'+
      '<div class="profile-experience">'+
        '<section class="profile-hero"><div class="profile-hero-main"><img class="profile-avatar" src="'+avatar+'" alt="Profile picture" id="profileAvatar"><div><p class="profile-eyebrow">Member account</p><h3>'+esc(m.full_name)+'</h3><p class="profile-username">@'+esc(m.username)+'</p><a class="profile-public" href="/members/'+encodeURIComponent(m.username)+'">View public profile <span aria-hidden="true">↗</span></a></div></div><span class="profile-state">'+(lock?'Identity details locked for KYC':'Personal details editable')+'</span></section>'+
        '<div class="profile-section-heading"><div><h3>Your account details</h3><p>Keep your contact information accurate and up to date.</p></div></div>'+
        '<form method="post" action="/profile" class="profile-card">'+csrfField(req)+'<div class="profile-card-top"><span class="profile-card-icon" aria-hidden="true">✦</span><div><h4>Personal information</h4><p class="profile-card-intro">These details identify your member account.</p></div></div><div class="profile-form-grid"><div><label for="fullName">Full name</label><input id="fullName" name="fullName" value="'+esc(m.full_name)+'" maxlength="160" required '+(lock?'readonly':'')+'></div><div><label for="username">Username</label><input id="username" name="username" value="'+esc(m.username)+'" pattern="[A-Za-z0-9_]{3,30}" maxlength="30" required></div><div><label for="email">Email address</label><input id="email" type="email" name="email" value="'+esc(m.email)+'" maxlength="254" autocomplete="email" required></div><div><label for="phone">Phone number</label><input id="phone" type="tel" name="phone" value="'+esc(profile.phone)+'" maxlength="32" autocomplete="tel"></div></div><p class="profile-hint">'+(lock?'Your legal name is locked while KYC is pending or approved. If your application was rejected, correct your details and resubmit.':'Your name can be updated before KYC starts. Once verification is pending or approved, the legal name is locked to protect verification integrity.')+'</p><button class="btn profile-save" type="submit">Save personal details</button></form>'+
        '<section class="profile-card"><div class="profile-card-top"><span class="profile-card-icon" aria-hidden="true">◉</span><div><h4>Profile picture</h4><p class="profile-card-intro">Make your member profile easy to recognise.</p></div></div><a class="btn profile-save" href="/profile/photo">Update profile picture</a><p class="profile-hint">Choose a photo from your device or capture one with your camera.</p></section>'+
        '<section class="profile-card"><div class="profile-card-top"><span class="profile-card-icon" aria-hidden="true">▤</span><div><h4>Saved bank accounts</h4><p class="profile-card-intro">Private account details are encrypted and shown only in masked form.</p></div></div><div class="profile-bank-list">'+(savedBanks.length?savedBanks.map(b=>'<div class="saved-bank-row"><div class="saved-bank-main"><span class="saved-bank-icon" aria-hidden="true">▤</span><div><strong>'+esc(b.bankName)+'</strong><p class="profile-hint">'+esc(b.bankAccountName)+' · ending '+esc(String(b.bankAccountNumber||'').slice(-4))+'</p></div></div><form method="post" action="/profile/bank/'+encodeURIComponent(b.id)+'/delete">'+csrfField(req)+'<button class="profile-remove" type="submit" aria-label="Remove bank account">Remove</button></form></div>').join(''):'<div class="profile-empty">No saved bank accounts yet.<br>Add an account below to keep your withdrawal details ready.</div>')+'</div></section>'+
        '<form method="post" action="/profile/bank" class="profile-card">'+csrfField(req)+'<div class="profile-card-top"><span class="profile-card-icon" aria-hidden="true">＋</span><div><h4>Add a bank account</h4><p class="profile-card-intro">Enter the details exactly as registered with your bank.</p></div></div><div class="profile-form-grid"><div><label for="bankName">Bank name</label><input id="bankName" name="bankName" maxlength="120" required></div><div><label for="bankAccountName">Account name</label><input id="bankAccountName" name="bankAccountName" maxlength="160" required></div><div class="full"><label for="bankAccountNumber">Account number</label><input id="bankAccountNumber" name="bankAccountNumber" inputmode="numeric" maxlength="34" autocomplete="off" required></div></div><p class="profile-hint">Saving bank details does not initiate a payment. You can remove a saved account at any time.</p><button class="btn profile-save" type="submit">Save bank account</button></form>'+
        '<div class="profile-private-note"><span aria-hidden="true">◆</span><span><strong>Privacy note:</strong> Your bank account is never displayed in full here. Only the final four digits are shown for recognition.</span></div>'+
      '<div class="profile-card"><div class="profile-card-top"><span class="profile-card-icon">♙</span><div><h4>Homepage Monarchs</h4><p class="profile-card-intro">Choose your public nickname and request to be featured. Approved KYC and admin approval are required.</p></div></div><a class="btn profile-save" href="/profile/monarchs">Manage my Monarchs profile</a></div>' + rolesCard +
      '</div>';    res.send(memberPage('Profile','/profile',m,content+(req.query.photo==='success'?photoSuccessCelebration('/profile'):''),req));
  } catch(e){next(e);}
});
app.post('/profile', requireAuth, csrfCheck, async(req,res,next)=>{
  try{    const fullName=String(req.body.fullName||'').trim(),username=String(req.body.username||'').trim(),email=String(req.body.email||'').trim().toLowerCase(),phone=String(req.body.phone||'').trim();
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
  }catch(e){if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).send(page('Profile temporarily unavailable','<h1>Profile updates are temporarily unavailable</h1><p class="muted">Please try again later.</p>'));next(e);}
});
app.post('/profile/bank', requireAuth, csrfCheck, async(req,res,next)=>{
  try{
    const bankName=String(req.body.bankName||'').trim(),bankAccountName=String(req.body.bankAccountName||'').trim(),bankAccountNumber=String(req.body.bankAccountNumber||'').trim();
    if(!bankName||!bankAccountName||!/^\d{6,34}$/.test(bankAccountNumber)||bankName.length>120||bankAccountName.length>160||(/[<>]/.test(bankName+bankAccountName)))return res.status(400).send(page('Invalid bank details','<h1>Check your bank details</h1><p class="muted">Enter a bank name, account name, and account number containing 6–34 digits.</p><a class="btn" href="/profile">Back to profile</a>'));
    const ciphertext=encryptProfileValue(JSON.stringify({bankName,bankAccountName,bankAccountNumber}));
    await pool.execute('INSERT INTO member_bank_accounts (member_id,details_ciphertext) VALUES (?,?)',[req.session.memberId,ciphertext]);
    res.redirect('/profile');
  }catch(e){if(e.code==='ER_NO_SUCH_TABLE'||e.status===503)return res.status(503).send(page('Profile temporarily unavailable','<h1>Bank account updates are temporarily unavailable</h1><p class="muted">Please try again later.</p><a class="btn" href="/profile">Back to profile</a>'));next(e);}
});
app.post('/profile/bank/:id/delete', requireAuth, csrfCheck, async(req,res,next)=>{
  try{
    const id=Number(req.params.id);
    if(!Number.isSafeInteger(id)||id<1)return res.status(400).send(page('Invalid bank account','<h1>Invalid bank account</h1><a class="btn" href="/profile">Back to profile</a>'));
    await pool.execute('UPDATE member_bank_accounts SET deleted_at=CURRENT_TIMESTAMP WHERE id=? AND member_id=? AND deleted_at IS NULL',[id,req.session.memberId]);
    res.redirect('/profile');
  }catch(e){if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).send(page('Bank accounts temporarily unavailable','<h1>Bank account updates are temporarily unavailable</h1><a class="btn" href="/profile">Back to profile</a>'));next(e);}
});
function profilePhotoChooserPage(req, action, backUrl, title, currentPhoto) {
  const html = '<main class="photo-chooser"><a class="back" href="'+backUrl+'">← Back</a><p class="eyebrow">MONARCH CODEX / PROFILE</p><h1>'+title+'</h1><p class="sub">Choose an image or take a new photo. Preview it, then confirm to upload.</p><form id="photoForm" method="post" action="'+action+'" enctype="multipart/form-data">'+csrfField(req)+
  '<div class="preview-wrap"><img id="photoPreview" src="'+currentPhoto+'" alt="Selected profile photo preview"><div id="photoSpinner" class="photo-spinner" aria-hidden="true"></div></div>'+
  '<div class="photo-options"><label class="option"><span class="option-icon">▧</span><strong>Upload a picture</strong><small>Choose JPG, PNG or WebP</small><input id="galleryPhoto" type="file" name="profilePhoto" accept="image/jpeg,image/png,image/webp" hidden></label>'+
  '<label class="option"><span class="option-icon">◎</span><strong>Capture a photo</strong><small>Open your camera</small><input id="cameraPhoto" type="file" accept="image/jpeg,image/png,image/webp" capture="user" hidden></label></div>'+
  '<p id="photoHint" class="hint">Maximum file size: 3 MB.</p><button id="confirmPhoto" class="confirm" type="submit" disabled>Confirm and upload photo</button><p class="privacy">Your new photo replaces the previous one after it is saved successfully.</p></form></main>'+
  '<style>*{box-sizing:border-box}.photo-chooser{max-width:620px;margin:0 auto;padding:24px 18px 48px;color:#f7f0df;font-family:inherit}.photo-chooser .back{display:inline-block;color:#e5c75f;text-decoration:none;margin:0 0 30px}.photo-chooser .eyebrow{letter-spacing:.18em;color:#dfbd62;font-weight:800;font-size:12px}.photo-chooser h1{font-size:clamp(28px,7vw,42px);margin:8px 0}.photo-chooser .sub,.photo-chooser .hint,.photo-chooser .privacy{color:#aaa59a;line-height:1.55}.preview-wrap{position:relative;width:190px;height:190px;margin:28px auto 24px;border-radius:50%;padding:5px;border:2px solid #dfbd62;background:#171615;box-shadow:0 0 0 8px #dfbd6217}.preview-wrap img{width:100%;height:100%;object-fit:cover;object-position:center;border-radius:50%}.photo-spinner{display:none;position:absolute;inset:0;border-radius:50%;border:5px solid #dfbd6230;border-top-color:#f5d45e;animation:photoSpin .8s linear infinite}.photo-chooser.is-uploading .photo-spinner{display:block}.photo-chooser.is-uploading .preview-wrap img{opacity:.35}.photo-options{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:22px 0}.option{display:flex;min-height:138px;flex-direction:column;align-items:flex-start;justify-content:center;gap:7px;padding:18px;border:1px solid #5e5129;border-radius:18px;background:linear-gradient(145deg,#211f18,#121214);cursor:pointer}.option:focus-within,.option:active{border-color:#f3d15b}.option-icon{font-size:26px;color:#e6c85e}.option small{color:#aaa59a}.confirm{width:100%;min-height:52px;border:0;border-radius:14px;background:#e9c957;color:#17130a;font-weight:900;font-size:15px}.confirm:disabled{opacity:.4}.privacy{font-size:12px;text-align:center;margin-top:15px}@keyframes photoSpin{to{transform:rotate(360deg)}}@media(max-width:390px){.preview-wrap{width:160px;height:160px}.option{padding:13px}}</style>'+
  '<script>(function(){const root=document.querySelector(".photo-chooser"),form=document.getElementById("photoForm"),gallery=document.getElementById("galleryPhoto"),camera=document.getElementById("cameraPhoto"),preview=document.getElementById("photoPreview"),confirm=document.getElementById("confirmPhoto"),hint=document.getElementById("photoHint");let selected=null,objectUrl=null;function choose(input){const f=input.files&&input.files[0];if(!f)return;if(!["image/jpeg","image/png","image/webp"].includes(f.type)||f.size>3*1024*1024){input.value="";hint.textContent="Please choose a JPG, PNG or WebP image under 3 MB.";confirm.disabled=true;selected=null;return}selected=f;if(objectUrl)URL.revokeObjectURL(objectUrl);objectUrl=URL.createObjectURL(f);preview.src=objectUrl;confirm.disabled=false;hint.textContent=f.name+" · "+(f.size/1024).toFixed(0)+" KB · Ready to upload"}gallery.addEventListener("change",()=>choose(gallery));camera.addEventListener("change",()=>choose(camera));form.addEventListener("submit",e=>{if(!selected){e.preventDefault();hint.textContent="Choose or capture a photo first.";return}if(selected===camera.files[0]){const transfer=new DataTransfer();transfer.items.add(selected);gallery.files=transfer.files}root.classList.add("is-uploading");confirm.disabled=true;confirm.textContent="Uploading your photo…";hint.textContent="Saving securely. Please keep this page open.";setTimeout(()=>HTMLFormElement.prototype.submit.call(form),1800)});})();</script>';
  return page(title, html);
}
app.get('/profile/photo', requireAuth, async(req,res,next)=>{try{const [rows]=await pool.execute('SELECT avatar_key FROM member_profiles WHERE member_id=? LIMIT 1',[req.session.memberId]);const key=rows[0]?.avatar_key;const photo=key&&/^[a-f0-9]{48}\.(jpg|png|webp)$/.test(String(key))?'/member-avatar/'+encodeURIComponent(key):'/assets/images/monarch-codex-logo.svg';res.send(profilePhotoChooserPage(req,'/profile/photo','/profile','Update profile picture',photo));}catch(e){next(e);}});
app.get('/admin/profile/photo', requireAdmin, async(req,res,next)=>{try{const [rows]=await pool.execute('SELECT avatar_key FROM member_profiles WHERE member_id=? LIMIT 1',[req.session.memberId]);const key=rows[0]?.avatar_key;const photo=key&&/^[a-f0-9]{48}\.(jpg|png|webp)$/.test(String(key))?'/member-avatar/'+encodeURIComponent(key):'/assets/images/monarch-codex-logo.svg';res.send(profilePhotoChooserPage(req,'/admin/profile/photo','/admin/profile','Update administrator photo',photo));}catch(e){next(e);}});
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
      const newPath=path.join(dir,key);
      fs.writeFileSync(newPath,buf,{mode:0o600,flag:'wx'});
      let previousKey=null;
      try {
        const [oldRows]=await pool.execute('SELECT avatar_key FROM member_profiles WHERE member_id=? LIMIT 1',[req.session.memberId]);
        previousKey=oldRows[0] && String(oldRows[0].avatar_key||'');
      } catch(e) { if(e.code!=='ER_NO_SUCH_TABLE') { try{fs.unlinkSync(newPath);}catch(_){} throw e; } }
      try {
        await pool.execute('INSERT INTO member_profiles (member_id,avatar_key) VALUES (?,?) ON DUPLICATE KEY UPDATE avatar_key=VALUES(avatar_key)',[req.session.memberId,key]);
      } catch(e) { try{fs.unlinkSync(newPath);}catch(_){} throw e; }
      // Remove the previous private image only after the database points to the new one.
      if(previousKey && previousKey!==key && /^[a-f0-9]{48}\.(jpg|png|webp)$/.test(previousKey)) {
        try { fs.unlinkSync(path.join(dir,previousKey)); } catch(e) { if(e.code!=='ENOENT') console.error('[profile photo cleanup] Unable to remove previous image'); }
      }
      res.redirect('/profile?photo=success');
    });
  }catch(e){next(e);}
}));
app.post('/admin/profile/photo', requireAdmin, (req,res,next)=>profilePhotoUpload(req,res,async err=>{
  if(err)return res.status(400).send(page('Photo upload failed','<h1>Choose a JPG, PNG or WebP image under 3 MB.</h1><a class="btn" href="/admin/profile/photo">Back</a>'));
  try { csrfCheck(req,res,async csrfErr=>{
    if(csrfErr)return;
    if(!req.file)return res.status(400).send(page('Photo required','<h1>Choose a profile picture</h1><a class="btn" href="/admin/profile/photo">Back</a>'));
    const mime=req.file.mimetype,buf=req.file.buffer;
    const valid=(mime==='image/jpeg'&&buf[0]===255&&buf[1]===216&&buf[2]===255)||(mime==='image/png'&&buf.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))||(mime==='image/webp'&&buf.toString('ascii',0,4)==='RIFF'&&buf.toString('ascii',8,12)==='WEBP');
    if(!valid)return res.status(400).send(page('Invalid image','<h1>That file is not a valid supported image.</h1><a class="btn" href="/admin/profile/photo">Back</a>'));
    const dir=process.env.PROFILE_UPLOAD_DIR;
    if(!dir||!path.isAbsolute(dir)||dir===path.resolve(__dirname)||dir.startsWith(path.resolve(__dirname)+path.sep))return res.status(503).send(page('Uploads unavailable','<h1>Private profile photo storage is not configured.</h1>'));
    fs.mkdirSync(dir,{recursive:true,mode:0o700});
    const key=crypto.randomBytes(24).toString('hex')+({'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp'}[mime]),newPath=path.join(dir,key);
    fs.writeFileSync(newPath,buf,{mode:0o600,flag:'wx'});
    let previousKey=null;
    try{const [old]=await pool.execute('SELECT avatar_key FROM member_profiles WHERE member_id=? LIMIT 1',[req.session.memberId]);previousKey=old[0]&&String(old[0].avatar_key||'');}
    catch(e){if(e.code!=='ER_NO_SUCH_TABLE'){try{fs.unlinkSync(newPath)}catch(_){}throw e;}}
    try{await pool.execute('INSERT INTO member_profiles (member_id,avatar_key) VALUES (?,?) ON DUPLICATE KEY UPDATE avatar_key=VALUES(avatar_key)',[req.session.memberId,key]);}
    catch(e){try{fs.unlinkSync(newPath)}catch(_){}throw e;}
    if(previousKey&&previousKey!==key&&/^[a-f0-9]{48}\.(jpg|png|webp)$/.test(previousKey)){try{fs.unlinkSync(path.join(dir,previousKey))}catch(e){if(e.code!=='ENOENT')console.error('[admin profile photo cleanup] Unable to remove previous image');}}
    res.redirect('/admin/profile?photo=success');
  }); } catch(e){next(e);}
}));
app.get('/member-avatar-current', requireAuth, async (req,res,next)=>{
  try {
    res.set('Cache-Control','no-store, no-cache, must-revalidate, private');
    const [rows] = await pool.execute('SELECT avatar_key FROM member_profiles WHERE member_id=? LIMIT 1',[req.session.memberId]);
    const key = rows[0] && String(rows[0].avatar_key || '');
    if (!key || !/^[a-f0-9]{48}\.(jpg|png|webp)$/.test(key)) return res.sendFile(path.join(__dirname,'assets','images','monarch-codex-logo.svg'));
    const [owned] = await pool.execute('SELECT member_id FROM member_profiles WHERE member_id=? AND avatar_key=? LIMIT 1',[req.session.memberId,key]);
    const dir = process.env.PROFILE_UPLOAD_DIR;
    if (!owned.length || !dir || !path.isAbsolute(dir) || dir===path.resolve(__dirname) || dir.startsWith(path.resolve(__dirname)+path.sep)) return res.sendFile(path.join(__dirname,'assets','images','monarch-codex-logo.svg'));
    const file = path.join(dir,key);
    return res.sendFile(file,{headers:{'Cache-Control':'no-store, no-cache, must-revalidate, private','X-Content-Type-Options':'nosniff'}},err=>{if(err && !res.headersSent) next(err);});
  } catch(e) { if(e.code==='ER_NO_SUCH_TABLE') return res.sendFile(path.join(__dirname,'assets','images','monarch-codex-logo.svg')); next(e); }
});
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
    const body='<style>.public-profile{max-width:560px;margin:0 auto;text-align:center}.public-avatar{display:block;width:130px;height:130px;aspect-ratio:1/1;object-fit:cover;object-position:50% 50%;border-radius:50%;border:3px solid #dfbd62;margin:10px auto 20px}</style><div class="public-profile"><img class="public-avatar" src="'+avatar+'" alt="Profile picture"><h1>'+esc(rows[0].full_name)+'</h1><p class="muted">@'+esc(rows[0].username)+'</p><p class="muted">Monarch Codex member</p><a class="btn" href="/">Return to Monarch Codex</a></div>';
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
app.get('/kyc/draft', requireAuth, async (req,res,next) => {
  try {
    const config = getKycStorageConfig();
    const [rows] = await pool.execute('SELECT encrypted_payload,current_step,updated_at FROM kyc_drafts WHERE member_id=? LIMIT 1',[req.session.memberId]);
    res.set('Cache-Control','no-store');
    if (!rows.length) return res.json({draft:null});
    const raw = decryptKycBuffer(Buffer.from(rows[0].encrypted_payload,'base64'),config.key).toString('utf8');
    return res.json({draft:JSON.parse(raw),currentStep:Number(rows[0].current_step)||0,updatedAt:rows[0].updated_at});
  } catch(e) {
    if (e && e.code === 'ER_NO_SUCH_TABLE') return res.status(503).json({error:'Draft saving is not configured yet.'});
    if (e && e.status === 503) return res.status(503).json({error:'Secure draft storage is not configured yet.'});
    return next(e);
  }
});
app.post('/kyc/draft', requireAuth, async (req,res,next) => {
  try {
    csrfCheck(req,res,async csrfErr => {
      if (csrfErr) return;
      try {
        const config = getKycStorageConfig();
        const body = req.body || {}, source = body.fields && typeof body.fields === 'object' ? body.fields : {};
        const allowed = ['legalFullName','dateOfBirth','phoneNumber','contactEmail','countryCode','stateRegion','localityLga','streetAddress','documentType','documentIssuerCountry','documentNumber'];
        const draft = {};
        for (const key of allowed) if (typeof source[key] === 'string') draft[key] = source[key].slice(0, key === 'streetAddress' ? 240 : key === 'documentNumber' ? 80 : 254);
        const encrypted = encryptKycBuffer(Buffer.from(JSON.stringify(draft),'utf8'),config.key).toString('base64');
        const step = Math.max(0,Math.min(3,Number.parseInt(body.currentStep,10)||0));
        await pool.execute('INSERT INTO kyc_drafts (member_id,encrypted_payload,current_step) VALUES (?,?,?) ON DUPLICATE KEY UPDATE encrypted_payload=VALUES(encrypted_payload),current_step=VALUES(current_step),updated_at=CURRENT_TIMESTAMP',[req.session.memberId,encrypted,step]);
        return res.json({ok:true,savedAt:new Date().toISOString()});
      } catch(e) {
        if (e && e.code === 'ER_NO_SUCH_TABLE') return res.status(503).json({error:'Draft saving is not configured yet.'});
        if (e && e.status === 503) return res.status(503).json({error:'Secure draft storage is not configured yet.'});
        return next(e);
      }
    });
  } catch(e) { next(e); }
});
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
          const alreadyApproved = String(existingKycRows[0].status || '').toLowerCase() === 'approved';
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
            !front || (!back && b.documentType !== 'passport') || !selfie || b.confirmOwnership !== 'yes') {
          return res.status(400).json({ error: 'Check all required fields, the NIN length, consent, and required document images. A passport back image is optional.' });
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
          let previousPrivateKeys = [];
          try {
            await conn.beginTransaction();
            await conn.execute('SELECT id FROM members WHERE id=? FOR UPDATE',[req.session.memberId]);
            const [latestRows] = await conn.execute('SELECT id,status,document_front_private_key,document_back_private_key,selfie_private_key FROM kyc_submissions WHERE member_id=? ORDER BY submitted_at DESC,id DESC LIMIT 1 FOR UPDATE',[req.session.memberId]);
            const latest = latestRows[0] || null;
            const latestStatus = String(latest && latest.status || '').toLowerCase();
            if (latest && ['pending','approved'].includes(latestStatus)) {
              await conn.rollback();
              for (const id of stored.filter(Boolean)) { try { fs.unlinkSync(path.join(config.directory,id)); } catch (_) {} }
              return res.status(409).json({error:latestStatus === 'approved' ? 'Your KYC is already approved. You do not need to submit it again.' : 'Your KYC is already under review. Please wait for the review result.',status:latestStatus});
            }
            const values = [b.legalFullName.trim(),b.dateOfBirth,b.countryCode,b.stateRegion.trim(),b.localityLga.trim(),b.streetAddress.trim(),b.phoneNumber.trim(),b.contactEmail.trim(),b.documentType,b.documentIssuerCountry,numberCipher,docNumber.slice(-4),stored[0],stored[1],stored[2]];
            if (latest && ['rejected','needs_resubmission'].includes(latestStatus)) {
              submissionId = latest.id;
              previousPrivateKeys = [latest.document_front_private_key,latest.document_back_private_key,latest.selfie_private_key].filter(Boolean);
              await conn.execute("UPDATE kyc_submissions SET legal_full_name=?,date_of_birth=?,country_code=?,state_region=?,locality_lga=?,street_address=?,phone_number=?,contact_email=?,document_type=?,document_issuer_country=?,document_number_ciphertext=?,document_number_last4=?,document_front_private_key=?,document_back_private_key=?,selfie_private_key=?,status='pending',reviewer_member_id=NULL,reviewer_note=NULL,reviewed_at=NULL,submitted_at=CURRENT_TIMESTAMP WHERE id=? AND member_id=?",[...values,submissionId,req.session.memberId]);
              await conn.execute("INSERT INTO kyc_review_events (submission_id,actor_member_id,event_type,note) VALUES (?,?,'submitted','Member resubmitted corrected information; existing application record updated')",[submissionId,req.session.memberId]);
            } else {
              const [result] = await conn.execute("INSERT INTO kyc_submissions (member_id,legal_full_name,date_of_birth,country_code,state_region,locality_lga,street_address,phone_number,contact_email,document_type,document_issuer_country,document_number_ciphertext,document_number_last4,document_front_private_key,document_back_private_key,selfie_private_key,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending')",[req.session.memberId,...values]);
              submissionId = result.insertId;
              await conn.execute("INSERT INTO kyc_review_events (submission_id,actor_member_id,event_type) VALUES (?,?,'submitted')",[submissionId,req.session.memberId]);
            }
            await conn.commit();
          } catch (dbErr) { await conn.rollback(); throw dbErr; } finally { conn.release(); }
          for (const id of previousPrivateKeys) { try { fs.unlinkSync(path.join(config.directory,id)); } catch (_) {} }
          try { await pool.execute('DELETE FROM kyc_drafts WHERE member_id=?',[req.session.memberId]); } catch (draftErr) { if (!draftErr || draftErr.code !== 'ER_NO_SUCH_TABLE') console.error('[kyc draft cleanup]',draftErr.code||'cleanup_failed'); }
          return res.status(201).json({ ok:true, submissionId, status:'pending', message:'Your verification has been submitted for review.' });
        } catch (e) {
          for (const id of stored.filter(Boolean)) { try { fs.unlinkSync(path.join(config.directory,id)); } catch (_) {} }
          if (e && e.code === 'ER_NO_SUCH_TABLE') return res.status(503).json({ error:'Secure verification is temporarily unavailable. Please try again later.' });
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
        existingKycStatus = String(existingKycRows[0].status || '').trim().toLowerCase();
        existingKycNote = existingKycRows[0].reviewer_note || '';
      }
    } catch (e) { if (e.code !== 'ER_NO_SUCH_TABLE') throw e; }
    let kycReady = false;
    let kycReadinessMessage = 'Secure verification is temporarily unavailable. Your information and documents will not be submitted.';
    try {
      const storage = getKycStorageConfig();      fs.accessSync(storage.directory, fs.constants.W_OK);
      await pool.execute('SELECT 1 FROM kyc_submissions LIMIT 0');
      await pool.execute('SELECT 1 FROM kyc_review_events LIMIT 0');
      kycReady = true;
      kycReadinessMessage = 'Your identity documents are encrypted before private storage. The server will re-check readiness when you submit.';    } catch (readinessError) {
      if (readinessError && readinessError.code === 'ER_NO_SUCH_TABLE') {
        kycReadinessMessage = 'Secure verification is temporarily unavailable. Your information and documents will not be submitted. Please try again later.';
      } else if (readinessError && ['ER_ACCESS_DENIED_ERROR','ECONNREFUSED','ETIMEDOUT','ENOTFOUND'].includes(readinessError.code)) {
        kycReadinessMessage = 'Secure verification cannot connect to its database right now. Your information and documents will not be submitted.';
      } else if (readinessError && readinessError.status === 503) {        kycReadinessMessage = 'Secure document storage is not configured yet. Your information and documents will not be submitted.';
      } else {
        console.error('[kyc readiness]', readinessError && readinessError.code ? readinessError.code : 'readiness_check_failed');
        kycReadinessMessage = 'Secure verification could not confirm that storage and database services are ready. Your information and documents will not be submitted.';
      }
    }
    res.set('Cache-Control','no-store');
    if (existingKycStatus === 'approved') {
      const approvedContent = '<main class="kyc-status-card kyc-status-approved" aria-labelledby="kycStatusTitle"><div class="kyc-status-icon" aria-hidden="true">✓</div><p class="kyc-status-overline">IDENTITY CHECK COMPLETE</p><p class="kyc-status-chip"><span aria-hidden="true"></span> VERIFIED MEMBER</p><h2 id="kycStatusTitle">Your identity is verified.</h2><p class="kyc-status-lead">Your identity review is complete. Your verification remains on file, so you do not need to submit these documents again unless our review team requests an update.</p><div class="kyc-status-facts"><div><span>Verification status</span><strong>Approved · No action needed</strong></div><div><span>Account access</span><strong>Your member workspace is ready</strong></div></div><section class="kyc-member-next" aria-labelledby="kycMemberNextTitle"><p class="kyc-member-next-kicker">YOUR MEMBER SPACE</p><h3 id="kycMemberNextTitle">Where would you like to go?</h3><div class="kyc-member-links"><a href="/dashboard"><span class="kyc-member-link-icon" aria-hidden="true">⌂</span><span><strong>Dashboard</strong><small>Return to your account overview</small></span><span class="kyc-member-arrow" aria-hidden="true">↗</span></a><a href="/profile"><span class="kyc-member-link-icon" aria-hidden="true">◎</span><span><strong>Profile &amp; payout details</strong><small>Review your personal and bank details</small></span><span class="kyc-member-arrow" aria-hidden="true">↗</span></a><a href="/transactions"><span class="kyc-member-link-icon" aria-hidden="true">↔</span><span><strong>Account activity</strong><small>Review your financial activity and records</small></span><span class="kyc-member-arrow" aria-hidden="true">↗</span></a></div></section><p class="kyc-status-foot">Your KYC approval is a verification result, not a promise of financial eligibility. Any financial request is subject to its own account requirements and review.</p></main>';
      return res.send(wizardPage('KYC Verification',approvedContent,req));
    }
    if (existingKycStatus === 'pending') {
      const pendingContent = '<main class="kyc-status-card kyc-status-pending" aria-labelledby="kycStatusTitle"><div class="kyc-status-icon" aria-hidden="true">◷</div><p class="kyc-status-overline">APPLICATION RECEIVED</p><p class="kyc-status-chip">UNDER REVIEW</p><h2 id="kycStatusTitle">Your verification is in review.</h2><p class="kyc-status-lead">Your documents have been submitted for review. There is nothing else you need to submit right now.</p><div class="kyc-review-timeline"><span class="kyc-review-check" aria-hidden="true">✓</span><div><strong>Submission received</strong><small>Your application is saved securely.</small></div><span class="kyc-review-current" aria-hidden="true"></span><div><strong>Review in progress</strong><small>We will update your account when a decision is made.</small></div></div><div class="kyc-status-actions"><a class="kyc-btn kyc-btn-primary" href="/dashboard">Return to dashboard</a></div><p class="kyc-status-foot">Please avoid submitting a duplicate application while this review is in progress.</p></main>';
      return res.send(wizardPage('KYC Verification',pendingContent,req));
    }
    const statusNotice = existingKycStatus === 'rejected'
      ? '<section class="kyc-review-notice is-rejected" role="status"><span class="kyc-notice-icon" aria-hidden="true">!</span><div><strong>Updates needed before approval</strong><p>' + esc(existingKycNote || 'Your previous submission was not approved. Review the note and update your details before resubmitting.') + '</p></div></section>'
      : existingKycStatus === 'needs_resubmission'
        ? '<section class="kyc-review-notice is-resubmit" role="status"><span class="kyc-notice-icon" aria-hidden="true">↻</span><div><strong>Please update your verification</strong><p>' + esc(existingKycNote || 'The review team has requested an updated submission. Review your details and documents before resubmitting.') + '</p></div></section>'
        : '';
    const content = `
      ${statusNotice}
      <div class="kyc-intro"><span class="kyc-intro-badge" aria-hidden="true">01 — 04</span><div><strong>Your identity. Protected.</strong><p>Complete four short steps using accurate details that match your identity document. You can review each step before submitting.</p></div></div>
      <div class="kyc-security-note ${kycReady ? 'is-ready' : 'is-unavailable'}" role="status" aria-live="polite"><span class="kyc-lock" aria-hidden="true">⌑</span><span><strong>${kycReady ? 'Secure verification ready' : 'Secure verification unavailable'}</strong><small>${esc(kycReadinessMessage)}</small></span></div>
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
            <label class="kyc-upload-card" for="kycBackImage"><span class="kyc-upload-icon">＋</span><strong>Back of ID / document</strong><small>Required for cards and licences; optional for passports</small><input id="kycBackImage" name="documentBack" type="file" accept="image/jpeg,image/png" data-preview="kycBackPreview"><img id="kycBackPreview" alt="Back of ID preview" hidden></label>
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
app.get('/api/deposit-quote', requireAuth, async (req,res,next) => {
  try {
    const currency=String(req.query.currency||''), amount=Number(req.query.amount), methodId=String(req.query.payment_method_id||'');
    if (!['NGN','USD'].includes(currency) || !Number.isFinite(amount) || amount<=0 || amount>1000000000) return res.status(400).json({error:'invalid_quote'});
    const [[pricing]]=await pool.query('SELECT base_usd_ngn_rate,markup_percent,bank_fee_usd,wallet_fee_usd FROM deposit_pricing_settings WHERE id=1');
    const base=pricing && Number(pricing.base_usd_ngn_rate);
    if (!base || !Number.isFinite(base) || base<=0) return res.status(503).json({error:'quote_unavailable'});
    const rate=base*(1+Number(pricing.markup_percent||0)/100);
    let feeUsd=null;
    if(methodId){
      if(!/^\d{1,20}$/.test(methodId))return res.status(400).json({error:'invalid_destination'});
      const [[method]]=await pool.execute('SELECT method_type,currency,is_active FROM deposit_payment_methods WHERE id=?',[methodId]);
      if(!method || !Number(method.is_active) || method.currency!==currency || (method.method_type==='wallet' && currency!=='USD'))return res.status(400).json({error:'destination_unavailable'});
      feeUsd=method.method_type==='wallet'?Number(pricing.wallet_fee_usd):Number(pricing.bank_fee_usd);
    }
    const amountUsd=currency==='USD'?amount:amount/rate, amountNgn=currency==='NGN'?amount:amount*rate;
    const feeNgn=feeUsd===null?null:feeUsd*rate, totalUsd=feeUsd===null?null:amountUsd+feeUsd, totalNgn=feeUsd===null?null:amountNgn+feeNgn;
    res.set('Cache-Control','no-store');
    res.json({currency,amountUsd,amountNgn,feeUsd,feeNgn,totalUsd,totalNgn,hasMethod:feeUsd!==null});
  } catch(e) { if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).json({error:'quote_unavailable'}); next(e); }
});
app.get('/deposit', requireAuth, requireApprovedKyc, async (req,res,next) => {
  try {
    const m=await getMemberForPage(req,res); if(!m)return;
    const [[pricing]] = await pool.query('SELECT base_usd_ngn_rate,markup_percent,bank_fee_usd,wallet_fee_usd FROM deposit_pricing_settings WHERE id=1');
    const [methods] = await pool.query('SELECT id,method_type,currency,label,bank_name,account_name,account_number,bank_code,wallet_network,wallet_asset,wallet_address,instructions FROM deposit_payment_methods WHERE is_active=1 ORDER BY currency,method_type,label');
    const [history] = await pool.query('SELECT d.id,d.currency,d.amount,d.fee_amount,d.total_due,d.payment_reference,d.status,d.created_at,d.reviewer_note,p.label AS payment_label FROM deposit_requests d JOIN deposit_payment_methods p ON p.id=d.payment_method_id WHERE d.member_id=? ORDER BY d.created_at DESC LIMIT 30',[m.id]);
    const baseRate=pricing && pricing.base_usd_ngn_rate!==null ? Number(pricing.base_usd_ngn_rate) : null;
    const effectiveRate=baseRate!==null ? baseRate*(1+Number(pricing.markup_percent)/100) : null;
    const methodsJson=JSON.stringify(methods.map(x=>({id:Number(x.id),method_type:x.method_type,currency:x.currency,label:x.label,bank_name:x.bank_name,account_name:x.account_name,account_number:x.account_number,bank_code:x.bank_code,wallet_network:x.wallet_network,wallet_asset:x.wallet_asset,wallet_address:x.wallet_address,instructions:x.instructions}))).replace(/</g,'\\u003c');
    const pricingJson=JSON.stringify({configured:effectiveRate!==null,bankFeeUsd:Number(pricing && pricing.bank_fee_usd || 0),walletFeeUsd:Number(pricing && pricing.wallet_fee_usd || 0)}).replace(/</g,'\\u003c');
    const requestedDepositId=String(req.query.request||'');
    let submittedDeposit=null;
    if(req.query.submitted==='1' && /^\d{1,20}$/.test(requestedDepositId)){
      const [[submittedRow]]=await pool.execute('SELECT id,status,currency,amount,reviewer_note FROM deposit_requests WHERE id=? AND member_id=?',[requestedDepositId,m.id]);
      submittedDeposit=submittedRow||null;
    }
    const historyRows=history.map(d=>'<tr><td>#'+Number(d.id)+'<br><small>'+esc(d.created_at)+'</small></td><td>'+esc(d.currency+' '+Number(d.amount).toLocaleString('en-US',{maximumFractionDigits:8}))+'<br><small>Fee '+esc(d.currency+' '+Number(d.fee_amount).toLocaleString('en-US',{maximumFractionDigits:8}))+'</small></td><td>'+esc(d.payment_label)+'<br><small>'+esc(d.payment_reference)+'</small></td><td><span class="ac-pill">'+esc(d.status.toUpperCase())+'</span>'+(d.reviewer_note?'<p class="muted small">'+esc(d.reviewer_note)+'</p>':'')+'</td></tr>').join('');
    const notice='';
    const notReady=effectiveRate===null?'<div class="deposit-inline-notice">Deposits are temporarily unavailable. Please try again later.</div>':(methods.length===0?'<div class="deposit-inline-notice">No payment destinations are available right now. Please check back later.</div>':'');
    const workflow=req.query.submitted==='1'
       ? (submittedDeposit && submittedDeposit.status==='approved' ? '<section class="deposit-success-panel is-approved"><span class="deposit-success-icon" aria-hidden="true">✓</span><p class="deposit-eyebrow">PAYMENT CONFIRMED</p><h2>Your deposit was successful</h2><p>'+esc(Number(submittedDeposit.amount).toLocaleString('en-US',{maximumFractionDigits:8})+' '+submittedDeposit.currency)+' has been credited to your wallet.</p><div class="deposit-success-actions"><a class="btn" href="/dashboard">Back to dashboard</a><a class="deposit-secondary-link" href="/notifications">View notification</a></div></section>' : submittedDeposit && submittedDeposit.status==='rejected' ? '<section class="deposit-success-panel is-rejected"><span class="deposit-success-icon" aria-hidden="true">!</span><p class="deposit-eyebrow">PAYMENT NEEDS ATTENTION</p><h2>Your deposit was not approved</h2><p>'+esc(submittedDeposit.reviewer_note||'Please review your notification for next steps.')+'</p><div class="deposit-success-actions"><a class="btn" href="/deposit">Submit another deposit</a><a class="deposit-secondary-link" href="/notifications">View notification</a></div></section>' : '<section class="deposit-success-panel"><span class="deposit-success-icon" aria-hidden="true">✓</span><p class="deposit-eyebrow">REQUEST RECEIVED</p><h2>Your deposit is under review</h2><p>We have received your payment details and receipt. We will notify you when the review is complete. Your wallet will only be credited after approval.</p><div class="deposit-success-actions"><a class="btn" href="/dashboard">Back to dashboard</a><a class="deposit-secondary-link" href="/notifications">View notifications</a></div></section>')
      : '<form id="depositForm" method="post" action="/deposit" enctype="multipart/form-data" class="deposit-workflow">'+csrfField(req)+
        '<ol class="deposit-progress" aria-label="Deposit progress"><li class="is-active" data-step-indicator="0"><span>01</span><div><b>Amount</b><small>Set your deposit</small></div></li><li data-step-indicator="1"><span>02</span><div><b>Payment</b><small>Choose how to pay</small></div></li><li data-step-indicator="2"><span>03</span><div><b>Receipt</b><small>Upload proof securely</small></div></li></ol>'+
        '<div class="deposit-step" data-deposit-step="0"><div class="deposit-step-heading"><span class="deposit-step-kicker">STEP 1 OF 3</span><h3>How much would you like to fund?</h3><p>Enter the amount you want credited to your wallet. You can review the fee and full payment total before sending.</p></div><div class="deposit-input-grid"><div class="deposit-field"><label for="depositCurrency">Wallet currency</label><select id="depositCurrency" name="currency" required><option value="NGN">Naira (NGN)</option><option value="USD">US Dollars (USD)</option></select><small class="deposit-field-hint">Crypto wallet deposits are processed in USD.</small></div><div class="deposit-field"><label for="depositAmount">Amount to fund</label><input id="depositAmount" name="amount" type="number" min="1" max="1000000000" step="0.01" inputmode="decimal" required placeholder="e.g. 50000"><small class="deposit-field-hint">Enter the amount in the currency selected.</small></div></div><div class="deposit-step-actions"><a class="deposit-cancel-link" href="/dashboard">Cancel</a><button class="btn deposit-next" type="button" id="depositNextAmount">Continue to payment <span aria-hidden="true">→</span></button></div></div>'+
        '<div class="deposit-step" data-deposit-step="1" hidden><div class="deposit-step-heading"><span class="deposit-step-kicker">STEP 2 OF 3</span><h3>Choose how you want to pay</h3><p>Confirm the destination and amount carefully. Use the copy buttons to avoid transfer mistakes.</p></div><div class="deposit-summary-strip"><span>Amount to fund</span><strong id="depositStepAmount">—</strong><button type="button" class="deposit-text-button" id="depositEditAmount">Edit amount</button></div><div class="deposit-method-switch" role="group" aria-label="Choose payment method"><button type="button" class="deposit-method-tab is-active" data-payment-mode="bank" aria-pressed="true"><span aria-hidden="true">▤</span><strong>Bank transfer</strong><small>Pay from your bank</small></button><button type="button" class="deposit-method-tab" data-payment-mode="wallet" aria-pressed="false"><span aria-hidden="true">◇</span><strong>Wallet address</strong><small>Crypto transfer</small></button></div><div id="depositMethodNotice" class="deposit-inline-notice" hidden></div><div class="deposit-destination-picker"><label for="depositMethod">Select payment destination</label><select id="depositMethod" name="payment_method_id" required><option value="">Choose an active destination</option></select></div><div id="depositPaymentDetails" class="deposit-payment-details" hidden></div>'+
        '<section class="section-card deposit-calculator" aria-live="polite"><div class="deposit-calculator-heading"><div><span class="deposit-eyebrow">PAYMENT SUMMARY</span><h3>Amount, fee &amp; total</h3></div><span class="deposit-live-pill"><i></i> Live estimate</span></div><p class="deposit-rate-line"></p><div class="deposit-calculator-grid"><div class="deposit-calc-item"><span>Amount to fund</span><strong id="calcAmount">—</strong><small id="calcAmountOther">USD / NGN equivalent: —</small></div><div class="deposit-calc-item"><span>Transaction fee</span><strong id="calcFee">—</strong><small id="calcFeeOther">USD / NGN equivalent: —</small></div><div class="deposit-calc-item deposit-calc-total"><span>Total amount to pay</span><strong id="calcTotal">—</strong><small id="calcTotalOther">USD / NGN equivalent: —</small></div></div><p class="muted small deposit-calculator-note">The summary always includes the USD amount and its Naira equivalent. Pay the total shown for your selected destination. Crypto transfers must use the exact asset and network displayed.</p></section><div class="deposit-step-actions"><button class="deposit-back" type="button" id="depositBackAmount">← Back</button><button class="btn deposit-next" type="button" id="depositNextPayment">I have completed payment <span aria-hidden="true">→</span></button></div></div>'+
        '<div class="deposit-step" data-deposit-step="2" hidden><div class="deposit-step-heading"><span class="deposit-step-kicker">STEP 3 OF 3</span><h3>Upload your payment receipt</h3><p>After sending the exact total shown in the previous step, provide your transfer reference and proof so the team can verify it.</p></div><div class="deposit-final-summary"><div><span>Payment destination</span><strong id="depositFinalMethod">—</strong></div><div><span>Total to pay</span><strong id="depositFinalTotal">—</strong></div></div><label for="paymentReference">Transfer reference / transaction ID</label><input id="paymentReference" name="payment_reference" maxlength="190" autocomplete="off" required placeholder="Bank reference or blockchain transaction ID"><label for="paymentProof">Payment receipt / proof (JPG, PNG, WEBP or PDF · max 5 MB)</label><input id="paymentProof" name="payment_proof" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" required><p class="muted small">Your receipt is stored privately for the admin review. Accepted formats: JPG, PNG, WEBP or PDF, up to 5 MB.</p><label for="memberNote">Additional note (optional)</label><textarea id="memberNote" name="member_note" maxlength="1000" rows="3" placeholder="Optional details to help verify your payment"></textarea><label class="deposit-confirm-check"><input type="checkbox" id="depositPaymentAttestation" required><span>I confirm that I have sent the payment and the details above are accurate.</span></label><div class="deposit-step-actions"><button class="deposit-back" type="button" id="depositBackPayment">← Back to payment</button><button class="btn deposit-next" type="submit" id="depositConfirmSubmit">Confirm deposit</button></div><p class="muted small deposit-final-note">Your deposit remains pending until an administrator verifies the payment. Never upload a receipt for a payment you have not made.</p></div></form>';
    const statusPollScript=submittedDeposit && submittedDeposit.status==='pending' ? '<script>(function(){var id='+Number(submittedDeposit.id)+',timer=setInterval(function(){fetch("/api/deposit-status/"+id,{credentials:"same-origin",cache:"no-store"}).then(function(r){if(!r.ok)throw new Error("status unavailable");return r.json()}).then(function(d){if(d.status==="approved"||d.status==="rejected"){clearInterval(timer);window.location.assign("/deposit?submitted=1&request="+id)}}).catch(function(){})},15000)})();</script>' : '';
    const content='<div class="member-card deposit-page-card"><div class="deposit-page-intro"><span class="deposit-eyebrow">FUND YOUR ACCOUNT</span><h2>Make a deposit</h2><p class="muted">Complete the three secure steps to fund your Monarch Codex wallet.</p></div>'+notice+notReady+workflow+statusPollScript+'</div>'+
      '<div class="member-card deposit-history-card"><div class="deposit-history-heading"><div><span class="deposit-eyebrow">YOUR ACTIVITY</span><h2>Deposit history</h2></div><span class="deposit-history-count">'+history.length+' recent '+(history.length===1?'request':'requests')+'</span></div><div class="ac-table-wrap"><table class="ac-table"><thead><tr><th>Request</th><th>Amount / fee</th><th>Payment details</th><th>Status</th></tr></thead><tbody>'+(historyRows||'<tr><td colspan="4">No deposit requests yet.</td></tr>')+'</tbody></table></div></div>'+
      '<script>window.monarchDepositMethods='+methodsJson+';window.monarchDepositPricing='+pricingJson+';</script><script src="/assets/js/deposit-wizard.js?v=20261016-layout2" defer></script>';
    res.send(memberPage('Deposit','/deposit',m,content,req));
  } catch(e) { if(e.code==='ER_NO_SUCH_TABLE') return res.status(503).send(memberPage('Deposit','/deposit',await getMemberForPage(req,res),'<div class="member-card"><h2>Deposits temporarily unavailable</h2><p>Please try again later.</p></div>',req)); next(e); }
});
app.post('/deposit', requireAuth, requireApprovedKyc, parseDepositProof, csrfCheck, async (req,res,next) => {
  const currency=String(req.body.currency||''), methodId=String(req.body.payment_method_id||''), reference=String(req.body.payment_reference||'').trim().slice(0,190), note=String(req.body.member_note||'').trim().slice(0,1000);
  const amount=Number(req.body.amount);
  if (!['NGN','USD'].includes(currency) || !/^\d{1,20}$/.test(methodId) || !Number.isFinite(amount) || amount<=0 || amount>1000000000 || !reference || !req.file) return res.status(400).send(formError('Check your deposit details','Enter a valid currency and amount, choose an active payment destination, and provide your transfer reference and receipt.','/deposit'));
  try {
    const m=await getMemberForPage(req,res); if(!m)return;
    const [[pricing]]=await pool.query('SELECT base_usd_ngn_rate,markup_percent,bank_fee_usd,wallet_fee_usd FROM deposit_pricing_settings WHERE id=1');
    if(!pricing || pricing.base_usd_ngn_rate===null || Number(pricing.base_usd_ngn_rate)<=0) return res.status(503).send(formError('Deposits temporarily unavailable','Please try again later.','/deposit'));
    const [[method]]=await pool.execute('SELECT id,method_type,currency,is_active FROM deposit_payment_methods WHERE id=?',[methodId]);
    if(!method || !Number(method.is_active) || method.currency!==currency || (method.method_type==='wallet' && currency!=='USD')) return res.status(400).send(formError('Payment destination unavailable','Choose an active payment destination for the selected currency.','/deposit'));
    const base=Number(pricing.base_usd_ngn_rate), rate=base*(1+Number(pricing.markup_percent)/100), feeUsd=method.method_type==='wallet'?Number(pricing.wallet_fee_usd):Number(pricing.bank_fee_usd), fee=currency==='NGN'?feeUsd*rate:feeUsd, total=amount+fee;
    const [insertResult]=await pool.execute('INSERT INTO deposit_requests (member_id,currency,amount,fee_usd,fee_amount,base_usd_ngn_rate,effective_usd_ngn_rate,total_due,payment_method_id,payment_reference,proof_storage_key,proof_mime_type,proof_original_name,member_note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',[m.id,currency,amount,feeUsd,fee,base,rate,total,methodId,reference,req.file.filename,req.file.mimetype,path.basename(req.file.originalname).slice(0,255),note||null]);
    res.redirect('/deposit?submitted=1&request='+encodeURIComponent(insertResult.insertId));
  } catch(e) { if(req.file) fs.unlink(req.file.path,()=>{}); if(e.code==='ER_DUP_ENTRY') return res.status(409).send(formError('Reference already submitted','This payment reference has already been submitted for your account. Check your deposit history or contact support.','/deposit')); if(e.code==='ER_NO_SUCH_TABLE') return res.status(503).send(formError('Deposits temporarily unavailable','Please try again later.','/deposit')); next(e); }
});
app.get('/withdraw', requireAuth, requireApprovedKyc, async (req,res,next)=>{
  try{
    const m=await getMemberForPage(req,res); if(!m)return;
    const [bankRows]=await pool.execute('SELECT id,details_ciphertext FROM member_bank_accounts WHERE member_id=? AND deleted_at IS NULL ORDER BY id DESC',[m.id]);
    const banks=bankRows.map(r=>({id:r.id,...JSON.parse(decryptProfileValue(r.details_ciphertext))}));
    const [[latestKyc]]=await pool.execute("SELECT status FROM kyc_submissions WHERE member_id=? ORDER BY submitted_at DESC,id DESC LIMIT 1",[m.id]);
    const kycStatus=latestKyc?String(latestKyc.status||'').trim().toLowerCase():'not_submitted', kycApproved=kycStatus==='approved';
    const [walletRows]=await pool.execute('SELECT currency,balance FROM member_wallets WHERE member_id=?',[m.id]);
    const [reservedRows]=await pool.execute("SELECT currency,COALESCE(SUM(amount),0) AS reserved FROM withdrawal_requests WHERE member_id=? AND status IN ('pending','approved') GROUP BY currency",[m.id]);
    const wallet={NGN:0,USD:0},reserved={NGN:0,USD:0};
    walletRows.forEach(r=>{if(Object.prototype.hasOwnProperty.call(wallet,r.currency))wallet[r.currency]=Number(r.balance)||0;});
    reservedRows.forEach(r=>{if(Object.prototype.hasOwnProperty.call(reserved,r.currency))reserved[r.currency]=Number(r.reserved)||0;});
    const available={NGN:Math.max(0,wallet.NGN-reserved.NGN),USD:Math.max(0,wallet.USD-reserved.USD)};
    const hasFunds=available.NGN>0||available.USD>0, canRequest=kycApproved&&banks.length>0&&hasFunds;
    const heroStatus=!kycApproved?(kycStatus==='pending'?'KYC under review':'KYC approval required'):!banks.length?'Add a payout account':!hasFunds?'No available wallet balance':'Ready to request';
    const bankOptions=banks.map(b=>'<option value="'+esc(b.id)+'">'+esc((b.bankName||'Saved bank')+' · '+(b.bankAccountName||'Account holder')+' · •••• '+String(b.bankAccountNumber||'').slice(-4))+'</option>').join('');
    const currencyOptions=(available.NGN>0?'<option value="NGN">Nigerian naira (NGN)</option>':'')+(available.USD>0?'<option value="USD"'+(available.NGN>0?'':' selected')+'>US dollars (USD)</option>':'');
    const requestPanel=canRequest
      ? '<aside class="withdraw-panel"><p class="withdraw-kicker">WITHDRAWAL REQUEST</p><h3>Your verification is approved</h3><p class="withdraw-sub">Choose a saved payout account and request an amount within your available wallet balance. An administrator must independently confirm maturity and eligibility before approval. No transfer happens automatically.</p><form method="post" action="/withdraw" class="withdraw-form">'+csrfField(req)+'<label for="withdrawBank">Payout account</label><select id="withdrawBank" name="bank_account_id" required>'+bankOptions+'</select><label for="withdrawCurrency">Wallet currency</label><select id="withdrawCurrency" name="currency" data-max-ngn="'+available.NGN.toFixed(8)+'" data-max-usd="'+available.USD.toFixed(8)+'" required>'+currencyOptions+'</select><div class="withdraw-available"><span>Available NGN</span><strong>₦'+available.NGN.toLocaleString('en-NG',{minimumFractionDigits:2,maximumFractionDigits:2})+'</strong><span>Available USD</span><strong>$'+available.USD.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})+'</strong></div><label for="withdrawAmount">Amount to request</label><input id="withdrawAmount" name="amount" type="number" min="0.01" max="'+(available.NGN>0?available.NGN:available.USD).toFixed(8)+'" step="0.01" inputmode="decimal" required><label for="withdrawNote">Note for the review team (optional)</label><textarea id="withdrawNote" name="member_note" rows="2" maxlength="500" placeholder="Add context for your request"></textarea><button class="btn withdraw-submit" type="submit">Submit withdrawal request →</button></form><p class="withdraw-sub">Requests remain pending until reviewed. A request is not a payment confirmation.</p><script>(function(){var c=document.getElementById("withdrawCurrency"),a=document.getElementById("withdrawAmount");if(!c||!a)return;function sync(){var max=Number(c.value==="NGN"?c.dataset.maxNgn:c.dataset.maxUsd)||0;a.max=String(max);if(Number(a.value)>max)a.value=max>0?String(max):""}c.addEventListener("change",sync);sync()})();</script></aside>'
      : '<aside class="withdraw-panel"><p class="withdraw-kicker">WITHDRAWAL READINESS</p><h3>'+(!kycApproved?'Identity approval required':!banks.length?'Add a payout destination':'No available wallet balance')+'</h3><p class="withdraw-sub">'+(!kycApproved?(kycStatus==='pending'?'Your KYC submission is awaiting administrator review. Withdrawal requests unlock after approval.':'Complete KYC and wait for an administrator to approve it before requesting a withdrawal.') : !banks.length?'Save a bank account in your profile before requesting a withdrawal.':'Your available balance is zero or currently reserved by pending or approved requests.')+'</p><ul class="withdraw-checks"><li><strong>'+(kycApproved?'✓':'01')+' · Identity verification</strong><span>'+(kycApproved?'Approved':'Must be approved by the review team')+'</span></li><li><strong>'+(banks.length?'✓':'02')+' · Payout account</strong><span>'+(banks.length?'Saved account available':'Add a bank account to your profile')+'</span></li><li><strong>'+(hasFunds?'✓':'03')+' · Available wallet balance</strong><span>'+(hasFunds?'Funds available for a request':'A positive unreserved balance is required')+'</span></li></ul><a class="withdraw-link" href="'+(!kycApproved?'/kyc':!banks.length?'/profile':'/transactions')+'">'+(!kycApproved?'Review verification status':!banks.length?'Manage bank account':'View wallet activity')+' ↗</a></aside>';
    const [history]=await pool.execute('SELECT id,currency,amount,status,created_at,reviewer_note FROM withdrawal_requests WHERE member_id=? ORDER BY created_at DESC LIMIT 10',[m.id]);
    const historyRows=history.map(w=>'<tr><td>#'+Number(w.id)+'<br><small>'+esc(w.created_at)+'</small></td><td>'+esc(w.currency+' '+Number(w.amount).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:8}))+'</td><td><span class="withdraw-status-label status-'+esc(w.status)+'">'+esc(w.status.toUpperCase())+'</span>'+(w.reviewer_note?'<p class="withdraw-sub">'+esc(w.reviewer_note)+'</p>':'')+'</td></tr>').join('');
    let requestNotice='';
    const requestedId=String(req.query.request||'');
    if(/^\d{1,20}$/.test(requestedId)){
      const [[requested]]=await pool.execute('SELECT id,status FROM withdrawal_requests WHERE id=? AND member_id=?',[requestedId,m.id]);
      if(requested)requestNotice='<div class="withdraw-notice" role="status"><strong>Request #'+Number(requested.id)+' received.</strong> Current status: '+esc(requested.status.toUpperCase())+'. This is a review request, not a payment confirmation.</div>';
    }
    const bankCards=banks.length?banks.map((b,i)=>'<div class="withdraw-bank-row"><span class="withdraw-bank-icon">'+esc(String(b.bankName||'B').trim().slice(0,1).toUpperCase())+'</span><span class="withdraw-bank-copy"><strong>'+esc(b.bankName||'Saved bank')+'</strong><small>'+esc(b.bankAccountName||'Account holder')+'</small></span><span class="withdraw-mask">•••• '+esc(String(b.bankAccountNumber||'').slice(-4))+'</span>'+(i===0?'<span class="withdraw-recent">RECENT</span>':'')+'</div>').join(''):'<div class="withdraw-empty"><strong>No payout account yet</strong><p>Add a bank account to your profile so your payout details are ready.</p><a class="withdraw-link" href="/profile">Add bank account ↗</a></div>';
    const body = `<style>
.withdraw-page{--wd-gold:#dfbd62;--wd-gold-bright:#f7e4a0;--wd-border:rgba(223,189,98,.2);--wd-muted:#aaa79e;display:grid;gap:18px;width:100%;max-width:1120px;margin:0 auto;color:#f5f1e8;min-width:0}
.withdraw-page *{box-sizing:border-box}
.withdraw-page .withdraw-hero{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:clamp(22px,4vw,38px);border:1px solid var(--wd-border);border-radius:24px;background:radial-gradient(ellipse at 90% 0%,rgba(216,180,90,.16),transparent 42%),linear-gradient(135deg,#191916,#10100f 70%,#1b1810);min-width:0}
.withdraw-page .withdraw-hero-copy{min-width:0;max-width:680px}
.withdraw-page .withdraw-eyebrow,.withdraw-page .withdraw-kicker{display:block;color:var(--wd-gold);font-size:10px;font-weight:850;letter-spacing:.16em;text-transform:uppercase;margin:0 0 10px}
.withdraw-page .withdraw-hero h2{font-size:clamp(27px,4vw,39px);line-height:1.12;letter-spacing:-.04em;margin:0 0 10px;color:#fff}
.withdraw-page .withdraw-hero p,.withdraw-page .withdraw-sub{color:#bdb8aa;font-size:13px;line-height:1.7;margin:8px 0}
.withdraw-page .withdraw-hero-side{display:grid;justify-items:end;gap:12px;flex:0 0 auto}
.withdraw-page .withdraw-status-label{display:inline-flex;align-items:center;gap:7px;padding:8px 11px;border:1px solid var(--wd-border);border-radius:999px;background:rgba(216,180,90,.1);color:#f0d994;font-size:10px;font-weight:850;letter-spacing:.035em;white-space:normal}
.withdraw-page .withdraw-status-label:before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;flex:0 0 6px}
.withdraw-page .withdraw-hero-nav{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px}
.withdraw-page .withdraw-hero-nav a,.withdraw-page .withdraw-link{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:38px;padding:9px 12px;border:1px solid var(--wd-border);border-radius:10px;color:var(--wd-gold-bright);text-decoration:none;font-size:11px;font-weight:800;transition:background .18s,border-color .18s}
.withdraw-page .withdraw-hero-nav a:hover,.withdraw-page .withdraw-link:hover{background:rgba(216,180,90,.09);border-color:rgba(223,189,98,.48)}
.withdraw-page .withdraw-overview{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.withdraw-page .withdraw-metric{display:grid;gap:8px;min-width:0;padding:16px;border:1px solid rgba(255,255,255,.075);border-radius:16px;background:linear-gradient(145deg,rgba(255,255,255,.035),rgba(255,255,255,.012))}
.withdraw-page .withdraw-metric-top{display:flex;align-items:center;justify-content:space-between;gap:8px;color:#a9a397;font-size:11px}
.withdraw-page .withdraw-metric-icon{display:grid;place-items:center;width:30px;height:30px;border-radius:10px;background:rgba(216,180,90,.1);color:var(--wd-gold-bright);font-size:15px}
.withdraw-page .withdraw-metric strong{font-size:clamp(15px,2vw,19px);color:#f5edcf;overflow-wrap:anywhere}
.withdraw-page .withdraw-metric small{font-size:11px;color:#a9a397;line-height:1.5}
.withdraw-page .withdraw-layout{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px;align-items:start;min-width:0}
.withdraw-page .withdraw-panel{min-width:0;padding:clamp(17px,2.5vw,25px);border:1px solid var(--wd-border);border-radius:19px;background:linear-gradient(155deg,rgba(255,255,255,.035),rgba(255,255,255,.012));overflow:hidden}
.withdraw-page .withdraw-panel h3{margin:6px 0;color:#fff;font-size:19px;letter-spacing:-.02em}.withdraw-page .withdraw-bank-list{display:grid;gap:10px;margin-top:16px}
.withdraw-page .withdraw-bank-row{display:flex;align-items:center;gap:10px;min-width:0;padding:12px;border:1px solid rgba(255,255,255,.08);border-radius:13px;background:rgba(0,0,0,.15)}
.withdraw-page .withdraw-bank-icon{display:grid;place-items:center;flex:0 0 38px;height:38px;border:1px solid var(--wd-border);border-radius:11px;background:rgba(216,180,90,.12);color:var(--wd-gold);font-weight:850}
.withdraw-page .withdraw-bank-copy{display:grid;gap:4px;flex:1;min-width:0}
.withdraw-page .withdraw-bank-copy strong,.withdraw-page .withdraw-bank-copy small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.withdraw-page .withdraw-bank-copy strong{font-size:12px;color:#f4f0e7}.withdraw-page .withdraw-bank-copy small,.withdraw-page .withdraw-mask{font-size:11px;color:#bdb8aa}
.withdraw-page .withdraw-mask{white-space:nowrap}
.withdraw-page .withdraw-recent{font-size:9px;color:var(--wd-gold);font-weight:850}
.withdraw-page .withdraw-empty{padding:24px 16px;text-align:center;border:1px dashed var(--wd-border);border-radius:14px;background:rgba(0,0,0,.12)}
.withdraw-page .withdraw-empty strong{color:#f4edda}
.withdraw-page .withdraw-empty p{color:var(--wd-muted);font-size:12px;line-height:1.6}
.withdraw-page .withdraw-form{display:grid;gap:10px;margin-top:16px}.withdraw-page .withdraw-form label{display:block;margin-top:5px;font-size:12px;font-weight:750;color:#e9e2d0}
.withdraw-page .withdraw-form input,.withdraw-page .withdraw-form select,.withdraw-page .withdraw-form textarea{display:block;width:100%;min-width:0;min-height:44px;padding:12px;border:1px solid #514b3a;border-radius:10px;background:#0d0d10;color:#f8f5ec;font:inherit;font-size:13px;line-height:1.45}
.withdraw-page .withdraw-form textarea{resize:vertical;min-height:72px}
.withdraw-page .withdraw-form input:focus,.withdraw-page .withdraw-form select:focus,.withdraw-page .withdraw-form textarea:focus{outline:2px solid var(--wd-gold);outline-offset:2px}
.withdraw-page .withdraw-available{display:grid;grid-template-columns:1fr auto;gap:7px 10px;padding:13px;border:1px solid rgba(216,180,90,.16);border-radius:12px;background:rgba(0,0,0,.13);font-size:11px;color:#bdb8aa}
.withdraw-page .withdraw-available strong{text-align:right;color:#f4e3a4;font-variant-numeric:tabular-nums}
.withdraw-page .withdraw-submit{width:100%;min-height:48px;display:flex;align-items:center;justify-content:center;gap:8px;margin-top:8px;cursor:pointer;border:1px solid #f1d575!important;border-radius:11px!important;background:linear-gradient(120deg,#d3ad4a,#f5df8c)!important;color:#18150c!important;font-size:12px;font-weight:900;box-shadow:0 9px 24px rgba(213,173,56,.1)}
.withdraw-page .withdraw-submit:hover{filter:brightness(1.05)}
.withdraw-page .withdraw-checks{display:grid;gap:10px;padding:0;margin:18px 0;list-style:none}
.withdraw-page .withdraw-checks li{display:grid;gap:5px;min-width:0;padding:13px;border:1px solid rgba(255,255,255,.07);border-radius:12px;background:rgba(0,0,0,.12)}
.withdraw-page .withdraw-checks strong{font-size:12px;color:#eee8d8}
.withdraw-page .withdraw-checks span{font-size:11px;color:#bdb8aa;line-height:1.5}
.withdraw-page .withdraw-notice{padding:14px 16px;border:1px solid var(--wd-border);border-radius:12px;background:rgba(216,180,90,.07);color:#e9ce86;font-size:13px;line-height:1.6}
.withdraw-page .withdraw-status-label.status-paid{background:rgba(55,145,89,.14);color:#94e3b0}
.withdraw-page .withdraw-status-label.status-rejected{background:rgba(190,75,75,.13);color:#f0aaaa}
.withdraw-page .withdraw-history{grid-column:1/-1}
.withdraw-page .withdraw-table-wrap{width:100%;overflow-x:auto;border:1px solid rgba(255,255,255,.06);border-radius:12px}
.withdraw-page .withdraw-table{width:100%;border-collapse:collapse;min-width:420px}
.withdraw-page .withdraw-table th,.withdraw-page .withdraw-table td{padding:13px 12px;text-align:left;vertical-align:top;border-bottom:1px solid rgba(255,255,255,.07);font-size:12px;overflow-wrap:anywhere}
.withdraw-page .withdraw-table th{color:#aaa18a;font-size:10px;text-transform:uppercase;letter-spacing:.1em;background:rgba(0,0,0,.12)}
.withdraw-page .withdraw-table tr:last-child td{border-bottom:0}
.withdraw-page .withdraw-table small{color:#aaa18a}
.withdraw-page .withdraw-history-empty{padding:24px;text-align:center;color:#aaa79e;font-size:12px}
.withdraw-page .withdraw-page-foot{margin:0;padding:0 2px;color:#98958c;font-size:11px;line-height:1.7}
@media(max-width:820px){.withdraw-page .withdraw-hero{align-items:flex-start;flex-direction:column}.withdraw-page .withdraw-hero-side{justify-items:start;width:100%}.withdraw-page .withdraw-hero-nav{justify-content:flex-start}.withdraw-page .withdraw-layout{grid-template-columns:1fr}.withdraw-page .withdraw-history{grid-column:auto}}
@media(max-width:560px){.withdraw-page{gap:13px}.withdraw-page .withdraw-hero{padding:21px 17px;border-radius:18px}.withdraw-page .withdraw-overview{grid-template-columns:1fr;gap:9px}.withdraw-page .withdraw-metric{grid-template-columns:36px minmax(0,1fr);align-items:center;column-gap:10px;padding:12px}.withdraw-page .withdraw-metric-icon{grid-row:span 2}.withdraw-page .withdraw-metric-top{align-self:end}.withdraw-page .withdraw-metric strong{font-size:16px}.withdraw-page .withdraw-panel{padding:16px 13px;border-radius:16px}.withdraw-page .withdraw-bank-row{gap:8px;padding:10px}.withdraw-page .withdraw-recent{display:none}.withdraw-page .withdraw-table th,.withdraw-page .withdraw-table td{padding:11px 9px}.withdraw-page .withdraw-hero-nav a{flex:1 1 auto}}
@media(prefers-reduced-motion:reduce){.withdraw-page *{scroll-behavior:auto!important;transition:none!important}}

</style>
<div class="withdraw-page">
  ${requestNotice}
  <section class="withdraw-hero">
    <div class="withdraw-hero-copy">
      <span class="withdraw-eyebrow">MEMBER FINANCE · PAYOUT CENTRE</span>
      <h2>Withdrawals, with clarity.</h2>
      <p>Review your withdrawal readiness, saved payout details and request history in one place. Every request is reviewed before a transfer is marked complete.</p>
    </div>
    <div class="withdraw-hero-side">
      <span class="withdraw-status-label">${esc(heroStatus)}</span>
      <nav class="withdraw-hero-nav" aria-label="Account shortcuts">
        <a href="/dashboard">Dashboard ↗</a>
        <a href="/profile">Profile ↗</a>
        <a href="/transactions">Activity ↗</a>
      </nav>
    </div>
  </section>
  <section class="withdraw-overview" aria-label="Withdrawal readiness summary">
    <div class="withdraw-metric">
      <span class="withdraw-metric-icon" aria-hidden="true">✓</span>
      <span class="withdraw-metric-top">Identity verification</span>
      <strong>${kycApproved ? 'Approved' : kycStatus === 'pending' ? 'In review' : 'Action needed'}</strong>
      <small>${kycApproved ? 'KYC is complete' : kycStatus === 'pending' ? 'Waiting for review' : 'Review your verification status'}</small>
    </div>
    <div class="withdraw-metric">
      <span class="withdraw-metric-icon" aria-hidden="true">◎</span>
      <span class="withdraw-metric-top">Payout destination</span>
      <strong>${banks.length ? banks.length + ' saved account' + (banks.length === 1 ? '' : 's') : 'Not added'}</strong>
      <small>${banks.length ? 'Bank details are saved securely' : 'Add an account in your profile'}</small>
    </div>
    <div class="withdraw-metric">
      <span class="withdraw-metric-icon" aria-hidden="true">◈</span>
      <span class="withdraw-metric-top">Available funds</span>
      <strong>${available.NGN > 0 ? '₦' + available.NGN.toLocaleString('en-NG',{maximumFractionDigits:2}) : available.USD > 0 ? '$' + available.USD.toLocaleString('en-US',{maximumFractionDigits:2}) : 'No available funds'}</strong>
      <small>Unreserved wallet balance</small>
    </div>
  </section>
  <div class="withdraw-layout">
    <section class="withdraw-panel">
      <p class="withdraw-kicker">PAYOUT DESTINATION</p>
      <h3>Your bank accounts</h3>
      <p class="withdraw-sub">Account numbers remain masked for privacy.</p>
      <div class="withdraw-bank-list">${bankCards}</div>
      ${banks.length ? '<a class="withdraw-link" href="/profile">Manage payout details ↗</a>' : ''}
    </section>
    ${requestPanel}
    <section class="withdraw-panel withdraw-history">
      <p class="withdraw-kicker">YOUR ACTIVITY</p>
      <h3>Withdrawal requests</h3>
      <p class="withdraw-sub">Track each request through review and verified payment.</p>
      <div class="withdraw-table-wrap">
        <table class="withdraw-table">
          <thead><tr><th>Request</th><th>Amount</th><th>Status / update</th></tr></thead>
          <tbody>${historyRows || '<tr><td colspan="3" class="withdraw-history-empty">No withdrawal requests yet. Your submitted requests will appear here.</td></tr>'}</tbody>
        </table>
      </div>
    </section>
  </div>
  <p class="withdraw-page-foot">Security note: a request is not a payout. Administrators must confirm eligibility and maturity, then verify the real transfer before marking it paid. No payment is sent automatically.</p>
</div>`;
    res.set('Cache-Control','no-store');
    res.send(memberPage('Withdraw','/withdraw',m,body,req));
  }catch(e){
    if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).send(memberPage('Withdraw','/withdraw',await getMemberForPage(req,res),'<div class="member-card"><h2>Withdrawal setup needs one final step</h2><p>Apply <code>migrations/009_withdrawal_requests.sql</code> after the KYC, bank-account and deposit-ledger migrations. No request has been created.</p><a class="btn" href="/profile">Manage bank accounts</a></div>',req));
    next(e);
  }
});
app.post('/withdraw', requireAuth, requireApprovedKyc, express.urlencoded({extended:false,limit:'5kb'}), csrfCheck, async(req,res,next)=>{
  const currency=String(req.body.currency||''), bankId=String(req.body.bank_account_id||''), amountText=String(req.body.amount||'').trim(), memberNote=String(req.body.member_note||'').trim().slice(0,500);
  if(!['NGN','USD'].includes(currency)||!/^\d{1,20}$/.test(bankId)||!/^\d{1,12}(?:\.\d{1,8})?$/.test(amountText))return res.status(400).send(formError('Check withdrawal details','Choose a saved payout account, a supported currency and a valid amount.','/withdraw'));
  const amount=Number(amountText);
  if(!Number.isFinite(amount)||amount<=0||amount>1000000000000)return res.status(400).send(formError('Invalid amount','Enter a positive amount within your available balance.','/withdraw'));
  try{
    const [[kyc]]=await pool.execute("SELECT status FROM kyc_submissions WHERE member_id=? ORDER BY submitted_at DESC,id DESC LIMIT 1",[req.session.memberId]);
    if(!kyc||String(kyc.status||'').trim().toLowerCase()!=='approved')return res.status(403).send(formError('KYC approval required','Withdrawal requests unlock only after your identity verification is approved by an administrator.','/kyc'));
    const conn=await pool.getConnection();
    try{
      await conn.beginTransaction();
      const [[bank]]=await conn.execute('SELECT id,details_ciphertext FROM member_bank_accounts WHERE id=? AND member_id=? AND deleted_at IS NULL LIMIT 1 FOR UPDATE',[bankId,req.session.memberId]);
      if(!bank){await conn.rollback();return res.status(400).send(formError('Payout account unavailable','Choose one of your active saved bank accounts.','/profile'));}
      const [[walletRow]]=await conn.execute('SELECT id,balance FROM member_wallets WHERE member_id=? AND currency=? LIMIT 1 FOR UPDATE',[req.session.memberId,currency]);
      const [[reservedRow]]=await conn.execute("SELECT COALESCE(SUM(amount),0) AS total FROM withdrawal_requests WHERE member_id=? AND currency=? AND status IN ('pending','approved')",[req.session.memberId,currency]);
      const available=Math.max(0,(walletRow?Number(walletRow.balance):0)-(reservedRow?Number(reservedRow.total):0));
      if(amount>available+1e-8){await conn.rollback();return res.status(400).send(formError('Amount exceeds available balance','Your request must not exceed the unreserved wallet balance shown on the withdrawal page.','/withdraw'));}
      const [result]=await conn.execute("INSERT INTO withdrawal_requests (member_id,bank_account_id,bank_details_ciphertext,currency,amount,member_note,status) VALUES (?,?,?,?,?,?,'pending')",[req.session.memberId,bank.id,bank.details_ciphertext,currency,amount,memberNote||null]);
      await conn.commit();
      return res.redirect('/withdraw?request='+encodeURIComponent(result.insertId));
    }catch(e){await conn.rollback();throw e;}finally{conn.release();}
  }catch(e){
    if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).send(formError('Withdrawal setup incomplete','The withdrawal database migration has not been applied yet. No request was created.','/withdraw'));
    next(e);
  }
});
app.get('/transactions', requireAuth, async (req,res,next) => {
  try {
    const m=await getMemberForPage(req,res); if(!m)return;
    let transactions=[]; try { const [txRows]=await pool.execute('SELECT id,transaction_type,currency,amount,reference,admin_note,created_at FROM financial_transactions WHERE member_id=? ORDER BY created_at DESC LIMIT 100',[m.id]); transactions=txRows; } catch(e) { if(e.code!=='ER_BAD_FIELD_ERROR') throw e; const [txRows]=await pool.execute('SELECT id,transaction_type,currency,amount,reference,created_at FROM financial_transactions WHERE member_id=? ORDER BY created_at DESC LIMIT 100',[m.id]); transactions=txRows; }
    const [requests]=await pool.execute('SELECT d.id,d.currency,d.amount,d.fee_amount,d.total_due,d.payment_reference,d.status,d.created_at,d.reviewer_note,p.label AS payment_label FROM deposit_requests d JOIN deposit_payment_methods p ON p.id=d.payment_method_id WHERE d.member_id=? ORDER BY d.created_at DESC LIMIT 100',[m.id]);
    const [withdrawals]=await pool.execute('SELECT id,currency,amount,status,created_at,reviewer_note FROM withdrawal_requests WHERE member_id=? ORDER BY created_at DESC LIMIT 100',[m.id]);
    const money=(currency,amount)=>esc(String(currency)+' '+Number(amount||0).toLocaleString('en-US',{maximumFractionDigits:8}));
    const completedCount=transactions.length;
    const requestCount=requests.length;
    const withdrawalCount=withdrawals.length;
    const pendingCount=requests.filter(d=>['pending','submitted','under_review','processing'].includes(String(d.status||'').toLowerCase())).length + withdrawals.filter(w=>['pending','submitted','under_review','processing','approved'].includes(String(w.status||'').toLowerCase())).length;
    const statusClass=status=>String(status||'pending').toLowerCase().replace(/[^a-z0-9_-]/g,'-');
    const txRows=transactions.map(t=>'<tr><td data-label="Date"><span class="tx-date">'+esc(t.created_at)+'</span></td><td data-label="Type"><span class="tx-type"><span class="tx-type-icon" aria-hidden="true">↗</span>'+esc(String(t.transaction_type||'transaction').replace(/[_-]+/g,' ').replace(/\\b\\w/g,c=>c.toUpperCase()))+'</span></td><td data-label="Amount"><strong class="tx-amount">'+money(t.currency,t.amount)+'</strong></td><td data-label="Reference"><span class="tx-reference">'+esc(t.reference)+(t.admin_note?'<br>'+esc(t.admin_note):'')+'</span></td><td data-label="Status"><span class="tx-status tx-status-completed"><span></span>Completed</span></td></tr>').join('');
    const reqRows=requests.map(d=>'<tr><td data-label="Date"><span class="tx-date">'+esc(d.created_at)+'</span></td><td data-label="Payment"><div class="tx-payment-name">'+esc(d.payment_label)+'</div><span class="tx-reference">'+esc(d.payment_reference)+'</span></td><td data-label="Amount"><strong class="tx-amount">'+money(d.currency,d.amount)+'</strong><span class="tx-fee">Fee '+money(d.currency,d.fee_amount)+' · Total '+money(d.currency,d.total_due)+'</span></td><td data-label="Status"><span class="tx-status tx-status-'+statusClass(d.status)+'"><span></span>'+esc(String(d.status||'pending').replace(/[_-]+/g,' ').replace(/\b\w/g,c=>c.toUpperCase()))+'</span>'+(d.reviewer_note?'<p class="tx-review-note">'+esc(d.reviewer_note)+'</p>':'')+'</td></tr>').join('');
    const body='<style>'+
      '.tx-experience{display:grid;gap:18px;min-width:0;color:#eee9dc}'+
      '.tx-hero{position:relative;isolation:isolate;overflow:hidden;display:flex;justify-content:space-between;align-items:center;gap:18px;padding:clamp(20px,3.5vw,30px);border:1px solid rgba(223,189,98,.25);border-radius:21px;background:radial-gradient(ellipse at 92% 0%,rgba(223,189,98,.16),transparent 36%),linear-gradient(135deg,#1b1a16,#111113 66%,#19160e)}'+
      '.tx-hero:after{content:"";position:absolute;z-index:-1;right:-60px;bottom:-110px;width:180px;height:180px;border:1px solid rgba(223,189,98,.13);border-radius:50%;box-shadow:0 0 0 22px rgba(223,189,98,.025),0 0 0 44px rgba(223,189,98,.02)}'+
      '.tx-eyebrow{margin:0 0 9px;color:#dfbd62;font-size:10px;font-weight:850;letter-spacing:.16em;text-transform:uppercase}'+
      '.tx-hero h3{margin:0;color:#fff8e8;font-size:clamp(23px,3.4vw,33px);letter-spacing:-.04em;line-height:1.12}'+
      '.tx-hero p{max-width:560px;margin:10px 0 0;color:#b3aea2;font-size:12px;line-height:1.7}'+
      '.tx-hero-mark{display:grid;place-items:center;flex:0 0 auto;width:68px;height:68px;border:1px solid rgba(223,189,98,.28);border-radius:20px;background:rgba(223,189,98,.07);color:#f0d681;font-size:29px;box-shadow:inset 0 1px 0 rgba(255,255,255,.04)}'+
      '.tx-summary-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}'+
      '.tx-summary{min-width:0;padding:17px;border:1px solid #383328;border-radius:16px;background:linear-gradient(145deg,#18181b,#111113)}'+
      '.tx-summary-label{display:flex;align-items:center;gap:8px;color:#aaa69a;font-size:10px;font-weight:800;letter-spacing:.08em;text-transform:uppercase}'+
      '.tx-summary-icon{display:grid;place-items:center;width:27px;height:27px;border-radius:9px;background:rgba(223,189,98,.08);color:#e5c66f;font-size:14px}'+
      '.tx-summary-value{display:block;margin:13px 0 5px;color:#f3e4ad;font-size:clamp(24px,3vw,32px);font-weight:850;letter-spacing:-.04em;line-height:1.1}'+
      '.tx-summary-note{margin:0;color:#969186;font-size:10px;line-height:1.6}'+
      '.tx-panel{min-width:0;overflow:hidden;border:1px solid #373227;border-radius:18px;background:linear-gradient(145deg,#171719,#111113)}'+
      '.tx-panel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:21px 22px 17px;border-bottom:1px solid #302d25}'+
      '.tx-panel-head h4{margin:0;color:#f6efdf;font-size:16px;letter-spacing:-.02em}'+
      '.tx-panel-head p{margin:6px 0 0;color:#a09b8f;font-size:11px;line-height:1.65}'+
      '.tx-count{flex:0 0 auto;padding:7px 10px;border:1px solid rgba(223,189,98,.19);border-radius:999px;background:rgba(223,189,98,.06);color:#e5ce85;font-size:10px;font-weight:850}'+
      '.tx-table-wrap{width:100%;overflow-x:auto}'+
      '.tx-table{width:100%;border-collapse:collapse;min-width:600px}'+
      '.tx-table th{padding:12px 15px;background:#141416;color:#928d82;font-size:9px;font-weight:850;letter-spacing:.11em;text-align:left;text-transform:uppercase;white-space:nowrap}'+
      '.tx-table td{padding:15px;border-bottom:1px solid #2d2a24;color:#ded8c9;font-size:11px;vertical-align:middle}'+
      '.tx-table tbody tr:last-child td{border-bottom:0}'+
      '.tx-table tbody tr:hover{background:rgba(223,189,98,.025)}'+
      '.tx-date{color:#b8b2a5;white-space:nowrap;font-size:10px}'+
      '.tx-type{display:inline-flex;align-items:center;gap:8px;font-weight:750;white-space:nowrap}'+
      '.tx-type-icon{display:grid;place-items:center;width:27px;height:27px;border:1px solid #383328;border-radius:9px;color:#e3c875;background:#1d1a13;font-size:14px}'+
      '.tx-amount{display:block;color:#f2e5b6;font-size:12px;white-space:nowrap}'+
      '.tx-reference{display:inline-block;max-width:190px;margin-top:4px;color:#8f8a7f;font-size:10px;overflow-wrap:anywhere}'+
      '.tx-payment-name{color:#e9e2d3;font-size:11px;font-weight:750}'+
      '.tx-fee{display:block;margin-top:6px;color:#999387;font-size:10px;line-height:1.7}'+
      '.tx-status{display:inline-flex;align-items:center;gap:7px;padding:7px 9px;border:1px solid #45402f;border-radius:999px;background:#1a1914;color:#e1d4a0;font-size:9px;font-weight:850;white-space:nowrap}'+
      '.tx-status>span{width:5px;height:5px;border-radius:50%;background:#d7b958}'+
      '.tx-status-completed,.tx-status-approved,.tx-status-credited{border-color:#2d4938;background:#121e17;color:#9bd0a8}'+
      '.tx-status-completed>span,.tx-status-approved>span,.tx-status-credited>span{background:#65b87b}'+
      '.tx-status-rejected,.tx-status-failed,.tx-status-cancelled{border-color:#523532;background:#211514;color:#e7a59a}'+
      '.tx-status-rejected>span,.tx-status-failed>span,.tx-status-cancelled>span{background:#d87869}'+
      '.tx-status-pending,.tx-status-submitted,.tx-status-under_review,.tx-status-processing{border-color:#4a4029;background:#201b11;color:#e5cb7e}'+
      '.tx-review-note{max-width:240px;margin:8px 0 0;color:#b4a99a;font-size:10px;line-height:1.6;overflow-wrap:anywhere}'+
      '.tx-empty{display:grid;place-items:center;gap:8px;padding:30px 18px;text-align:center}'+
      '.tx-empty-icon{display:grid;place-items:center;width:42px;height:42px;border:1px solid #383328;border-radius:14px;background:#1c1a14;color:#e5c66f;font-size:20px}'+
      '.tx-empty strong{color:#e8e1d2;font-size:12px}'+
      '.tx-empty p{max-width:350px;margin:0;color:#9c978b;font-size:11px;line-height:1.7}'+
      '.tx-note{padding:13px 15px;border:1px solid #302d25;border-radius:13px;background:rgba(223,189,98,.035);color:#9f9a8e;font-size:11px;line-height:1.7}'+
      '@media(max-width:680px){.tx-summary-grid{grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.tx-summary{padding:12px}.tx-summary-label{align-items:flex-start;flex-direction:column;gap:6px;font-size:9px}.tx-summary-value{font-size:23px}.tx-hero-mark{width:52px;height:52px;border-radius:15px;font-size:23px}.tx-panel-head{padding:17px 16px 14px}.tx-table-wrap{overflow:visible}.tx-table{display:block;min-width:0}.tx-table thead{display:none}.tx-table tbody{display:grid;gap:10px;padding:10px}.tx-table tr{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 12px;padding:10px 12px;border:1px solid #332f26;border-radius:13px;background:#121214}.tx-table td{display:flex;flex-direction:column;align-items:flex-start;gap:5px;min-width:0;padding:9px 0;border:0;overflow-wrap:anywhere}.tx-table td:before{content:attr(data-label);color:#888377;font-size:9px;font-weight:850;letter-spacing:.08em;text-transform:uppercase}.tx-table td[data-label=Date],.tx-table td[data-label=Type],.tx-table td[data-label=Payment]{grid-column:1/-1}.tx-table td[data-label=Type],.tx-table td[data-label=Payment]{padding-top:4px;padding-bottom:10px;border-bottom:1px solid #2d2a24;margin-bottom:2px}.tx-table td[data-label=Reference]{grid-column:1/-1}.tx-table td[data-label=Status]{align-self:start}.tx-reference{max-width:100%}.tx-fee{overflow-wrap:anywhere}.tx-panel-head p{max-width:260px}}'+
      '@media(max-width:390px){.tx-hero{align-items:flex-start}.tx-hero-mark{display:none}.tx-summary-grid{grid-template-columns:1fr}.tx-summary{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;column-gap:11px}.tx-summary-icon{grid-row:span 2}.tx-summary-label{flex-direction:row;align-items:center}.tx-summary-value{margin:5px 0 2px;font-size:24px}.tx-summary-note{grid-column:2}.tx-table tr{grid-template-columns:minmax(0,1fr)}}'+
      '@media(prefers-reduced-motion:reduce){.tx-experience *{scroll-behavior:auto!important;transition:none!important;animation:none!important}}'+
      '</style>'+
      '<div class="tx-experience">'+
        '<section class="tx-hero"><div><p class="tx-eyebrow">Account activity</p><h3>Transaction history</h3><p>A clear record of completed wallet credits and deposit requests, with their latest review status and payment details.</p></div><span class="tx-hero-mark" aria-hidden="true">↗</span></section>'+
        '<div class="tx-summary-grid"><article class="tx-summary"><div class="tx-summary-label"><span class="tx-summary-icon" aria-hidden="true">✓</span>Completed credits</div><strong class="tx-summary-value">'+completedCount+'</strong><p class="tx-summary-note">Deposits credited to your wallet</p></article><article class="tx-summary"><div class="tx-summary-label"><span class="tx-summary-icon" aria-hidden="true">▤</span>Deposit requests</div><strong class="tx-summary-value">'+requestCount+'</strong><p class="tx-summary-note">Requests recorded on your account</p></article><article class="tx-summary"><div class="tx-summary-label"><span class="tx-summary-icon" aria-hidden="true">◷</span>Awaiting review</div><strong class="tx-summary-value">'+pendingCount+'</strong><p class="tx-summary-note">Requests not yet decided</p></article></div>'+
        '<section class="tx-panel"><div class="tx-panel-head"><div><h4>Completed transactions</h4><p>Only ledger entries that were credited to your wallet are listed here.</p></div><span class="tx-count">'+completedCount+' records</span></div>'+(txRows?'<div class="tx-table-wrap"><table class="tx-table"><thead><tr><th>Date</th><th>Type</th><th>Amount</th><th>Reference</th><th>Status</th></tr></thead><tbody>'+txRows+'</tbody></table></div>':'<div class="tx-empty"><span class="tx-empty-icon" aria-hidden="true">↗</span><strong>No completed transactions yet</strong><p>When a deposit is approved and credited to your wallet, its record will appear here.</p></div>')+'</section>'+        '<section class="tx-panel"><div class="tx-panel-head"><div><h4>Deposit requests</h4><p>Track submitted deposits, fees, payment references and any review notes.</p></div><span class="tx-count">'+requestCount+' requests</span></div>'+(reqRows?'<div class="tx-table-wrap"><table class="tx-table"><thead><tr><th>Date</th><th>Payment destination / reference</th><th>Amount / fee</th><th>Status</th></tr></thead><tbody>'+reqRows+'</tbody></table></div>':'<div class="tx-empty"><span class="tx-empty-icon" aria-hidden="true">▤</span><strong>No deposit requests yet</strong><p>Deposit requests you submit will be listed here with their review status.</p></div>')+'</section>'+
        '<section class="tx-panel"><div class="tx-panel-head"><div><h4>Withdrawal requests</h4><p>Track payout requests and their review status.</p></div><span class="tx-count">'+withdrawalCount+' requests</span></div>'+(withdrawals.length?'<div class="tx-table-wrap"><table class="tx-table"><thead><tr><th>Date</th><th>Request</th><th>Amount</th><th>Status</th></tr></thead><tbody>'+withdrawals.map(w=>'<tr><td data-label="Date"><span class="tx-date">'+esc(w.created_at)+'</span></td><td data-label="Request"><div class="tx-payment-name">Withdrawal request #'+Number(w.id)+'</div><span class="tx-reference">Payout request</span></td><td data-label="Amount"><strong class="tx-amount">'+money(w.currency,w.amount)+'</strong></td><td data-label="Status"><span class="tx-status tx-status-'+statusClass(w.status)+'"><span></span>'+esc(String(w.status||'pending').replace(/[_-]+/g,' '))+'</span>'+(w.reviewer_note?'<p class="tx-review-note">'+esc(w.reviewer_note)+'</p>':'')+'</td></tr>').join('')+'</tbody></table></div>':'<div class="tx-empty"><strong>No withdrawal requests yet</strong><p>Withdrawal requests you submit will be listed here with their current status.</p></div>')+'</section>'+
        '<div class="tx-note">Deposit requests remain separate until credited to the wallet ledger. Withdrawal requests are listed separately until processed. Values shown here come from your account records.</div>'+
      '</div>';
    res.send(memberPage('Transaction history','/transactions',m,body,req));
  } catch(e) { if(e.code==='ER_NO_SUCH_TABLE') return res.status(503).send(memberPage('Transaction history','/transactions',await getMemberForPage(req,res),'Deposit ledger setup is not complete. Please check back later.',req)); next(e); }
});


app.get('/social-links', requireAuth, async(req,res,next)=>{
  try{
    const m=await getMemberForPage(req,res);if(!m)return;
    const [items]=await pool.query('SELECT label,url FROM platform_social_links WHERE is_active=1 AND url IS NOT NULL ORDER BY id');
    const links=items.filter(x=>{try{const u=new URL(x.url);return u.protocol==='https:'&&!u.username&&!u.password;}catch(_){return false;}});
    const content='<section style="max-width:800px;margin:auto"><p class="muted">OFFICIAL CHANNELS</p><h2>Connect with Monarch Codex</h2><p>These are the official channels published by the platform. Links open in a new tab.</p>'+(links.length?links.map(x=>'<a href="'+esc(x.url)+'" target="_blank" rel="noopener noreferrer" style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px;margin:10px 0;border:1px solid #6b5927;border-radius:13px;background:#111216;color:#f3cf3c;text-decoration:none"><strong>'+esc(x.label)+'</strong><span>Open securely ↗</span></a>').join(''):'<p>No official social links have been published yet.</p>')+'</section>';
    res.send(memberPage('Social links','/social-links',m,content,req));
  }catch(e){if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).send(memberPage('Social links','/social-links',await getMemberForPage(req,res),'<p>Social links are being configured. Please check back later.</p>',req));next(e);}
});


app.get('/admin/feedback', requireAdmin, requireWebCategoryAccess('community_moderation','view'), async(req,res,next)=>{
  try{
    await ensurePresenceFeedbackTables();
    const [items]=await pool.query("SELECT f.id,f.member_id,f.category,f.title,f.description,f.status,f.admin_note,f.image_mime IS NOT NULL AS has_image,f.created_at,m.full_name,m.username FROM member_feedback f JOIN members m ON m.id=f.member_id ORDER BY (f.status='received') DESC,f.created_at DESC LIMIT 300");
    const cards=items.map(x=>'<article class="ac-panel" style="margin:12px 0;padding:16px"><p class="muted">#'+Number(x.id)+' · '+esc(x.full_name||x.username||'Member')+' · '+esc(x.category.replace(/_/g,' '))+' · '+esc(x.created_at)+'</p><h3>'+esc(x.title)+'</h3><p style="white-space:pre-wrap;overflow-wrap:anywhere">'+esc(x.description)+'</p>'+(Number(x.has_image)===1?'<p><a href="/api/mobile/feedback/'+Number(x.id)+'/image" target="_blank" rel="noopener">View attached image</a></p>':'')+'<p>Status: <strong>'+esc(x.status.replace(/_/g,' '))+'</strong></p><form method="post" action="/admin/feedback/'+Number(x.id)+'/review" style="display:grid;gap:10px">'+csrfField(req)+'<label>Status<select name="status" required><option value="under_review">Under review</option><option value="planned">Planned</option><option value="in_progress">In progress</option><option value="implemented">Implemented</option><option value="declined">Declined</option></select></label><label>Update for member<textarea name="note" maxlength="2000" rows="2">'+esc(x.admin_note||'')+'</textarea></label><button class="btn" type="submit">Save status & notify member</button></form></article>').join('');
    const content='<section style="max-width:1000px;margin:auto"><p class="muted">MEMBER VOICE</p><h2>Feedback &amp; feature requests</h2><p>Review member suggestions, bug reports and improvement requests in one queue. Choose a clear status and leave a useful note; the member is notified and can track the outcome in their feedback history.</p>'+(cards||'<p class="ac-panel" style="padding:20px">No feedback has been submitted yet.</p>')+'</section>';
    res.send(adminControlPage('Member feedback','/admin/feedback',content,req));
  }catch(e){next(e);}
});
app.post('/admin/feedback/:id/review', requireAdmin, express.urlencoded({extended:false,limit:'5kb'}), csrfCheck, requireWebCategoryAccess('community_moderation',req=>req.body.status==='implemented'?'approve':req.body.status==='declined'?'reject':'moderate'), async(req,res,next)=>{
  const id=Number(req.params.id),status=String(req.body.status||''),note=String(req.body.note||'').trim().slice(0,2000);
  if(!Number.isSafeInteger(id)||id<1||!['under_review','planned','in_progress','implemented','declined'].includes(status))return res.status(400).send(page('Invalid feedback review','<main><h1>Choose a valid feedback status.</h1></main>'));
  if(status==='declined'&&!note)return res.status(400).send(page('Reason required','<main><h1>Add a reason when declining a suggestion.</h1><a href="/admin/feedback">Return to feedback</a></main>'));
  try{
    await ensurePresenceFeedbackTables();
    const [[item]]=await pool.execute('SELECT member_id,title FROM member_feedback WHERE id=?',[id]);
    if(!item)return res.status(404).send(page('Feedback not found','<main><h1>This feedback item no longer exists.</h1></main>'));
    await pool.execute('UPDATE member_feedback SET status=?,admin_note=?,reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=?',[status,note||null,req.session.memberId,id]);
    await pool.execute('INSERT INTO member_notifications (member_id,notification_type,title,body,target_url,dedupe_key) VALUES (?,?,?,?,?,?)',[item.member_id,'feedback_update','Feedback status updated','Your feedback "'+String(item.title).slice(0,120)+'" is now '+status.replace(/_/g,' ')+(note?' — '+note:''),'/feedback.html','web_feedback_'+id+'_'+status+'_'+Date.now()]);
    await pool.execute('INSERT INTO platform_action_audit (actor_member_id,action_key,target_type,target_id,details) VALUES (?,?,?,?,?)',[req.session.memberId,'feedback.status_updated','member_feedback',String(id),JSON.stringify({status,note})]);
    res.redirect('/admin/feedback?updated=1');
  }catch(e){next(e);}
});

app.get('/community', requireAuth, async(req,res,next)=>{
  try{
    const m=await getMemberForPage(req,res);if(!m)return;
    await ensurePresenceFeedbackTables();
    await pool.execute("INSERT INTO member_presence (member_id,last_seen_at,online_until) VALUES (?,CURRENT_TIMESTAMP,DATE_ADD(CURRENT_TIMESTAMP,INTERVAL 2 MINUTE)) ON DUPLICATE KEY UPDATE last_seen_at=CURRENT_TIMESTAMP,online_until=DATE_ADD(CURRENT_TIMESTAMP,INTERVAL 2 MINUTE)",[req.session.memberId]);
    const [posts]=await pool.query("SELECT p.id,p.member_id,p.body,p.post_type,p.created_at,m.full_name,m.username,IF(pr.online_until>CURRENT_TIMESTAMP,1,0) AS author_online,pr.last_seen_at AS author_last_seen,pr.show_status,EXISTS(SELECT 1 FROM community_post_media pm WHERE pm.post_id=p.id) AS has_image FROM community_posts p JOIN members m ON m.id=p.member_id LEFT JOIN member_presence pr ON pr.member_id=m.id AND pr.show_status=1 WHERE p.status='published' ORDER BY p.created_at DESC LIMIT 100");
    const postHtml=await Promise.all(posts.map(async p=>{
      const [comments]=await pool.execute("SELECT c.id,c.member_id,c.body,c.created_at,m.full_name,m.username FROM community_comments c JOIN members m ON m.id=c.member_id WHERE c.post_id=? AND c.status='published' ORDER BY c.created_at ASC LIMIT 50",[p.id]);
      const commentHtml=comments.map(x=>'<div style="margin:8px 0 0 18px;padding:10px;border-left:2px solid #6b5927"><strong>'+esc(x.full_name||x.username||'Member')+'</strong><p>'+esc(x.body)+'</p><small>'+esc(x.created_at)+'</small>'+(Number(x.member_id)===Number(req.session.memberId)?'<form method="post" action="/community/posts/'+Number(p.id)+'/comments/'+Number(x.id)+'/delete" style="margin-top:6px">'+csrfField(req)+'<button class="btn" type="submit" onclick="return confirm(\'Delete your comment?\')">Delete comment</button></form>':'')+'</div>').join('');
      const presenceLabel=Number(p.show_status)!==1?'':Number(p.author_online)===1?'🟢 Online now':p.author_last_seen?'Last seen '+esc(String(p.author_last_seen)):'Status unavailable';
      const imageHtml=Number(p.has_image)===1?'<img src="/community/posts/'+Number(p.id)+'/image" alt="Community post image" loading="lazy" style="display:block;max-width:100%;max-height:520px;object-fit:contain;border-radius:12px;margin-top:12px">':'';
      return '<article id="post-'+Number(p.id)+'" style="padding:18px;margin:14px 0;border:1px solid #40371f;border-radius:16px;background:#111216"><p style="color:#f3cf3c;font-size:12px"><strong>'+esc(p.full_name||p.username||'Member')+'</strong> · '+esc(String(p.post_type).replace(/_/g,' '))+' '+presenceLabel+'</p><p style="white-space:pre-wrap;overflow-wrap:anywhere">'+esc(p.body)+'</p>'+imageHtml+'<small>'+esc(p.created_at)+'</small>'+(Number(p.member_id)===Number(req.session.memberId)?'<form method="post" action="/community/posts/'+Number(p.id)+'/delete" style="margin-top:8px">'+csrfField(req)+'<button class="btn" type="submit" onclick="return confirm(\'Delete this post and hide it from the community?\')">Delete post</button></form>':'')+commentHtml+'<form method="post" action="/community/posts/'+Number(p.id)+'/comments" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">'+csrfField(req)+'<input name="body" required maxlength="2000" placeholder="Write a reply" style="flex:1;min-width:180px"><button class="btn" type="submit">Reply</button></form><form method="post" action="/community/posts/'+Number(p.id)+'/report" style="margin-top:8px">'+csrfField(req)+'<input name="reason" required minlength="3" maxlength="1000" placeholder="Report reason" aria-label="Report reason"><button type="submit" class="btn">Report</button></form></article>';
    }));
    const content='<section style="max-width:900px;margin:auto"><p class="muted">MEMBER NETWORK</p><h2>Community feed</h2><p>Share updates, ask questions and connect with members. Partner campaigns and Sovereign Desk signals are reviewed before publication.</p><form method="post" enctype="multipart/form-data" action="/community/posts" style="display:grid;gap:10px;padding:18px;border:1px solid #6b5927;border-radius:16px;background:#111216">'+csrfField(req)+'<label>Post type<select name="post_type"><option value="post">Community post</option><option value="partner_campaign">Partner campaign (approval required)</option><option value="sovereign_signal">Sovereign Desk signal (approval required)</option></select></label><label>Message<textarea name="body" required minlength="1" maxlength="5000" rows="4" placeholder="Share with the community"></textarea></label><label>Image (optional)<input type="file" name="image" accept="image/jpeg,image/png,image/webp"></label><p class="muted">Optional JPG, PNG or WebP image, maximum 5 MB. Posts with images are still subject to community rules.</p><button class="btn" type="submit">Publish / submit for review</button></form><p><a class="btn" href="/feedback.html">Feedback &amp; Suggestions</a></p>'+(postHtml.length?postHtml.join(''):'<p style="padding:24px;text-align:center;border:1px solid #40371f;border-radius:16px">No community posts yet. Start the conversation.</p>')+'</section>';
    res.send(memberPage('Community','/community',m,content,req));
  }catch(e){if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).send(memberPage('Community','/community',await getMemberForPage(req,res),'<p>Community setup is not complete. Apply the platform migration after a verified backup.</p>',req));next(e);}
});

app.post('/community/posts', requireAuth, communityImageUpload.single('image'), express.urlencoded({extended:false,limit:'10kb'}), csrfCheck, async(req,res,next)=>{
  const body=String(req.body.body||'').trim(),type=String(req.body.post_type||'post');
  if(!body||body.length>5000||!['post','partner_campaign','sovereign_signal'].includes(type))return res.status(400).send(page('Invalid post','<main><h1>Check your post</h1><p>Use a supported post type and keep the message under 5,000 characters.</p><a href="/community">Return to community</a></main>'));
  if(req.file&&!validCommunityImage(req.file))return res.status(400).send(page('Invalid image','<main><h1>Choose a valid image</h1><p>Use a real JPG, PNG or WebP image under 5 MB.</p><a href="/community">Return to community</a></main>'));
  try{
    await ensurePresenceFeedbackTables();
    if(type==='partner_campaign'){
      const [[role]]=await pool.execute("SELECT r.id FROM member_role_assignments a JOIN member_role_catalog r ON r.id=a.role_id WHERE a.member_id=? AND r.role_key='partner' LIMIT 1",[req.session.memberId]);
      if(!role)return res.status(403).send(page('Partner access required','<main><h1>Partner access required</h1><p>Apply for Partner status before submitting a campaign.</p><a href="/community">Return to community</a></main>'));
    }
    if(type==='sovereign_signal'){
      const [[role]]=await pool.execute("SELECT r.id FROM member_role_assignments a JOIN member_role_catalog r ON r.id=a.role_id WHERE a.member_id=? AND r.role_key IN ('sovereign_desk','mega_partner') LIMIT 1",[req.session.memberId]);
      if(!role)return res.status(403).send(page('Sovereign Desk access required','<main><h1>Sovereign Desk access required</h1><p>Only authorized Sovereign Desk members can submit signals.</p><a href="/community">Return to community</a></main>'));
    }
    const status=type==='post'?'published':'pending';
    const [result]=await pool.execute('INSERT INTO community_posts (member_id,body,post_type,status) VALUES (?,?,?,?)',[req.session.memberId,body,type,status]);
    if(req.file&&type==='post')await pool.execute('INSERT INTO community_post_media (post_id,image_mime,image_data) VALUES (?,?,?)',[result.insertId,req.file.mimetype,req.file.buffer]);
    await pool.execute('INSERT INTO platform_action_audit (actor_member_id,action_key,target_type,target_id,details) VALUES (?,?,?,?,?)',[req.session.memberId,'community.post_created','community_post',String(result.insertId),JSON.stringify({type,status,hasImage:Boolean(req.file&&type==='post')})]);
    if(status==='pending'){
      const [admins]=await pool.query("SELECT member_id FROM admin_users WHERE is_active=1");
      for(const a of admins)await pool.execute('INSERT IGNORE INTO member_notifications (member_id,notification_type,title,body,target_url,dedupe_key) VALUES (?,?,?,?,?,?)',[a.member_id,'community_review','Community item awaiting approval','A partner campaign or Sovereign Desk signal is awaiting review.','/admin/community-moderation','web_community_review_'+result.insertId+'_'+a.member_id]);
    }
    res.redirect('/community?post='+status);
  }catch(e){if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).send(page('Community setup required','<main><h1>Apply migrations/021_platform_completion_foundation.sql</h1></main>'));next(e);}
});


app.get('/community/posts/:id/image', requireAuth, async(req,res,next)=>{
  const id=Number(req.params.id);if(!Number.isSafeInteger(id)||id<1)return res.status(400).end();
  try{await ensurePresenceFeedbackTables();const [[row]]=await pool.execute("SELECT pm.image_mime AS mime,pm.image_data AS data FROM community_post_media pm JOIN community_posts p ON p.id=pm.post_id WHERE p.id=? AND p.status='published'",[id]);if(!row)return res.status(404).end();res.set('Content-Type',row.mime);res.set('Cache-Control','private, no-store');res.set('X-Content-Type-Options','nosniff');res.send(row.data);}catch(e){next(e);}
});

app.post('/community/posts/:id/comments', requireAuth, express.urlencoded({extended:false,limit:'5kb'}), csrfCheck, async(req,res,next)=>{
  const id=Number(req.params.id),body=String(req.body.body||'').trim();
  if(!Number.isSafeInteger(id)||id<1||!body||body.length>2000)return res.status(400).send(page('Invalid comment','<main><h1>Check your reply</h1><a href="/community">Return to community</a></main>'));
  try{
    const [[post]]=await pool.execute("SELECT id,member_id FROM community_posts WHERE id=? AND status='published'",[id]);
    if(!post)return res.status(404).send(page('Post unavailable','<main><h1>This post is no longer available.</h1><a href="/community">Return to community</a></main>'));
    await pool.execute('INSERT INTO community_comments (post_id,member_id,body) VALUES (?,?,?)',[id,req.session.memberId,body]);
    if(Number(post.member_id)!==Number(req.session.memberId))await pool.execute('INSERT IGNORE INTO member_notifications (member_id,notification_type,title,body,target_url,dedupe_key) VALUES (?,?,?,?,?,?)',[post.member_id,'community_comment','New community reply','A member replied to your community post.','/community','web_community_comment_'+id+'_'+req.session.memberId+'_'+Date.now()]);
    res.redirect('/community#post-'+id);
  }catch(e){next(e);}
});

app.post('/community/posts/:id/delete', requireAuth, express.urlencoded({extended:false,limit:'5kb'}), csrfCheck, async(req,res,next)=>{
  const id=Number(req.params.id);
  if(!Number.isSafeInteger(id)||id<1)return res.status(400).send(page('Invalid post','<main><h1>Invalid post</h1><a href="/community">Return to community</a></main>'));
  try{
    const [result]=await pool.execute("UPDATE community_posts SET status='hidden' WHERE id=? AND member_id=? AND status='published'",[id,req.session.memberId]);
    if(!result.affectedRows)return res.status(404).send(memberPage('Community','/community',await getMemberForPage(req,res),'<p>This post is unavailable or you do not have permission to delete it.</p><a href="/community">Return to community</a>',req));
    await pool.execute('INSERT INTO platform_action_audit (actor_member_id,action_key,target_type,target_id,details) VALUES (?,?,?,?,?)',[req.session.memberId,'community.post_deleted','community_post',String(id),JSON.stringify({method:'member_request'})]);
    res.redirect('/community?post=deleted');
  }catch(e){next(e);}
});

app.post('/community/posts/:postId/comments/:commentId/delete', requireAuth, express.urlencoded({extended:false,limit:'5kb'}), csrfCheck, async(req,res,next)=>{
  const postId=Number(req.params.postId),commentId=Number(req.params.commentId);
  if(!Number.isSafeInteger(postId)||postId<1||!Number.isSafeInteger(commentId)||commentId<1)return res.status(400).send(page('Invalid comment','<main><h1>Invalid comment</h1><a href="/community">Return to community</a></main>'));
  try{
    const [result]=await pool.execute("UPDATE community_comments SET status='hidden' WHERE id=? AND post_id=? AND member_id=? AND status='published'",[commentId,postId,req.session.memberId]);
    if(!result.affectedRows)return res.status(404).send(memberPage('Community','/community',await getMemberForPage(req,res),'<p>This comment is unavailable or you do not have permission to delete it.</p><a href="/community">Return to community</a>',req));
    await pool.execute('INSERT INTO platform_action_audit (actor_member_id,action_key,target_type,target_id,details) VALUES (?,?,?,?,?)',[req.session.memberId,'community.comment_deleted','community_comment',String(commentId),JSON.stringify({postId})]);
    res.redirect('/community#post-'+postId);
  }catch(e){next(e);}
});

app.post('/community/posts/:id/report', requireAuth, express.urlencoded({extended:false,limit:'5kb'}), csrfCheck, async(req,res,next)=>{
  const id=Number(req.params.id),reason=String(req.body.reason||'').trim().slice(0,1000);
  if(!Number.isSafeInteger(id)||id<1||reason.length<3)return res.status(400).send(page('Invalid report','<main><h1>Provide a clear report reason.</h1><a href="/community">Return to community</a></main>'));
  try{
    const [[post]]=await pool.execute("SELECT id FROM community_posts WHERE id=? AND status='published'",[id]);
    if(!post)return res.status(404).send(page('Post unavailable','<main><h1>This post is no longer available.</h1></main>'));
    await pool.execute('INSERT INTO community_reports (post_id,reporter_member_id,reason) VALUES (?,?,?)',[id,req.session.memberId,reason]);
    const [admins]=await pool.query("SELECT member_id FROM admin_users WHERE is_active=1");
    for(const a of admins)await pool.execute('INSERT IGNORE INTO member_notifications (member_id,notification_type,title,body,target_url,dedupe_key) VALUES (?,?,?,?,?,?)',[a.member_id,'community_report','Community post reported','A member submitted a content report for moderation.','/admin/community-moderation','web_community_report_'+id+'_'+req.session.memberId+'_'+a.member_id]);
    res.redirect('/community?report=submitted');
  }catch(e){next(e);}
});

app.post('/online-cooperative/connection', requireAuth, requireApprovedKyc, express.urlencoded({extended:false,limit:'5kb'}), csrfCheck, async(req,res,next)=>{
  const registeredName=String(req.body.registered_name||'').trim().replace(/\s+/g,' ').slice(0,160);
  const registeredEmail=String(req.body.registered_email||'').trim().toLowerCase();
  if(registeredName.length<2||registeredName.length>160||registeredEmail.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(registeredEmail))return res.status(400).send(memberPage('Online Cooperative','/online-cooperative',await getMemberForPage(req,res),'<p class="error">Enter the name and valid email used for your Cooperative registration.</p><a href="/online-cooperative">Return</a>',req));
  try{
    const [[existing]]=await pool.execute("SELECT id,status FROM online_cooperative_connections WHERE member_id=? AND status IN ('pending','approved') ORDER BY created_at DESC LIMIT 1",[req.session.memberId]);
    if(existing)return res.redirect('/online-cooperative?connection='+encodeURIComponent(existing.status));
    const [result]=await pool.execute("INSERT INTO online_cooperative_connections (member_id,registered_name,registered_email,status) VALUES (?,?,?,'pending')",[req.session.memberId,registeredName,registeredEmail]);
    await pool.execute('INSERT INTO platform_action_audit (actor_member_id,action_key,target_type,target_id,details) VALUES (?,?,?,?,?)',[req.session.memberId,'cooperative.connection_submitted','cooperative_connection',String(result.insertId),JSON.stringify({status:'pending'})]);
    const [admins]=await pool.query("SELECT member_id FROM admin_users WHERE is_active=1");
    for(const admin of admins)await pool.execute('INSERT IGNORE INTO member_notifications (member_id,notification_type,title,body,target_url,dedupe_key) VALUES (?,?,?,?,?,?)',[admin.member_id,'cooperative_review','Online Cooperative verification required','A member submitted registration details for manual verification.','/admin/cooperative-connections','web_cooperative_review_'+result.insertId+'_'+admin.member_id]);
    res.redirect('/online-cooperative?connection=pending');
  }catch(e){if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).send(memberPage('Online Cooperative','/online-cooperative',await getMemberForPage(req,res),'<p>Connection verification setup is not complete yet. Please try again later.</p>',req));next(e);}
});


function requireWebCategoryAccess(category, action) {
  return async(req,res,next)=>{
    try{
      if(req.adminRole==='super_admin')return next();
      const [[permission]]=await pool.execute('SELECT access_level,allowed_actions FROM platform_admin_permissions WHERE admin_member_id=? AND category_key=? LIMIT 1',[req.session.memberId,category]);
      if(!permission||permission.access_level==='red')return res.status(403).send(page('Access denied','<main><h1>Access denied</h1><p>Your administrator permission does not allow this category.</p><a href="/admin">Return to Admin</a></main>'));
      if(permission.access_level==='green')return next();
      let actions=[];try{actions=Array.isArray(permission.allowed_actions)?permission.allowed_actions:JSON.parse(permission.allowed_actions||'[]');}catch(_){}
      if(!actions.includes(typeof action==='function'?action(req):action))return res.status(403).send(page('Action not permitted','<main><h1>Action not permitted</h1><p>This action is not included in your partial-access permissions.</p><a href="/admin">Return to Admin</a></main>'));
      return next();
    }catch(e){if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).send(page('Permission setup required','<main><h1>Permission setup required</h1><p>Apply migrations/021_platform_completion_foundation.sql after a verified backup.</p></main>'));next(e);}
  };
}

app.get('/admin/community-moderation', requireAdmin, requireWebCategoryAccess('community_moderation','view'), async(req,res,next)=>{
  try{
    const [posts]=await pool.query("SELECT p.id,p.member_id,p.body,p.post_type,p.created_at,m.full_name,m.username FROM community_posts p JOIN members m ON m.id=p.member_id WHERE p.status='pending' ORDER BY p.created_at ASC LIMIT 200");
    const [reports]=await pool.query("SELECT r.id,r.post_id,r.reporter_member_id,r.reason,r.created_at,m.full_name FROM community_reports r JOIN members m ON m.id=r.reporter_member_id WHERE r.status='pending' ORDER BY r.created_at ASC LIMIT 200");
    const postCards=posts.map(p=>'<article class="ac-panel" style="margin:12px 0;padding:16px"><p class="muted">'+esc(p.full_name||p.username||'Member')+' · '+esc(p.post_type)+' · '+esc(p.created_at)+'</p><p style="white-space:pre-wrap;overflow-wrap:anywhere">'+esc(p.body)+'</p><form method="post" action="/admin/community-moderation/'+Number(p.id)+'/review" style="display:grid;gap:10px">'+csrfField(req)+'<label>Review note <textarea name="note" maxlength="1000" rows="2"></textarea></label><div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" name="decision" value="approve">Approve & publish</button><button class="btn" name="decision" value="reject">Reject</button><button class="btn" name="decision" value="hide">Hide post</button></div></form></article>').join('');
    const reportCards=reports.map(r=>'<article class="ac-panel" style="margin:12px 0;padding:16px"><p>Report #'+Number(r.id)+' on post #'+Number(r.post_id)+' · '+esc(r.full_name||'Member')+'</p><p>'+esc(r.reason)+'</p><form method="post" action="/admin/community-moderation/reports/'+Number(r.id)+'/review">'+csrfField(req)+'<button class="btn" name="decision" value="reviewed">Mark reviewed</button> <button class="btn" name="decision" value="dismissed">Dismiss report</button></form></article>').join('');
    res.send(adminControlPage('Community moderation','/admin/community-moderation','<section class="ac-panel"><h2>Pending posts and campaigns</h2><p class="muted">Partner campaigns and Sovereign Desk signals remain hidden until approved. Every review is audited.</p>'+(postCards||'<p>No pending posts.</p>')+'</section><section class="ac-panel" style="margin-top:18px"><h2>Community reports</h2>'+(reportCards||'<p>No pending reports.</p>')+'</section>',req));
  }catch(e){if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).send(adminControlPage('Community moderation','/admin/community-moderation','<p>Apply migrations/021_platform_completion_foundation.sql after a verified database backup.</p>',req));next(e);}
});
app.post('/admin/community-moderation/:id/review', requireAdmin, express.urlencoded({extended:false,limit:'5kb'}), csrfCheck, requireWebCategoryAccess('community_moderation',req=>req.body.decision==='approve'?'approve':req.body.decision==='hide'?'moderate':'reject'), async(req,res,next)=>{
  const id=Number(req.params.id),decision=String(req.body.decision||''),note=String(req.body.note||'').trim().slice(0,1000);
  if(!Number.isSafeInteger(id)||id<1||!['approve','reject','hide'].includes(decision))return res.status(400).send(page('Invalid review','<main><h1>Invalid review</h1></main>'));
  if(decision!=='approve'&&!note)return res.status(400).send(page('Review note required','<main><h1>Add a review note before rejecting or hiding content.</h1><a href="/admin/community-moderation">Return to moderation</a></main>'));
  try{
    const status=decision==='approve'?'published':decision==='hide'?'hidden':'rejected';
    const [result]=await pool.execute("UPDATE community_posts SET status=?,reviewed_by_member_id=?,review_note=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('pending','published')",[status,req.session.memberId,note||null,id]);
    if(!result.affectedRows)return res.status(404).send(page('Post unavailable','<main><h1>Post not found or already reviewed.</h1></main>'));
    await pool.execute('INSERT INTO platform_action_audit (actor_member_id,action_key,target_type,target_id,details) VALUES (?,?,?,?,?)',[req.session.memberId,'community.post_'+status,'community_post',String(id),JSON.stringify({note})]);
    res.redirect('/admin/community-moderation?review='+status);
  }catch(e){next(e);}
});
app.post('/admin/community-moderation/reports/:id/review', requireAdmin, requireWebCategoryAccess('community_moderation','moderate'), express.urlencoded({extended:false,limit:'5kb'}), csrfCheck, async(req,res,next)=>{
  const id=Number(req.params.id),decision=String(req.body.decision||'');
  if(!Number.isSafeInteger(id)||id<1||!['reviewed','dismissed'].includes(decision))return res.status(400).send(page('Invalid report','<main><h1>Invalid report action.</h1></main>'));
  try{
    const [result]=await pool.execute('UPDATE community_reports SET status=?,reviewed_by_member_id=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=? AND status=\'pending\'',[decision,req.session.memberId,id]);
    if(!result.affectedRows)return res.status(404).send(page('Report unavailable','<main><h1>Report not found or already reviewed.</h1></main>'));
    await pool.execute('INSERT INTO platform_action_audit (actor_member_id,action_key,target_type,target_id,details) VALUES (?,?,?,?,?)',[req.session.memberId,'community.report_'+decision,'community_report',String(id),JSON.stringify({decision})]);
    res.redirect('/admin/community-moderation?report='+decision);
  }catch(e){next(e);}
});

app.get('/admin/social-links', requireAdmin, requireWebCategoryAccess('social_links','view'), async(req,res,next)=>{
  try{
    const [items]=await pool.query('SELECT link_key,label,url,is_active FROM platform_social_links ORDER BY id');
    const forms=items.map(x=>'<form method="post" action="/admin/social-links" class="ac-panel" style="padding:16px;margin:12px 0;display:grid;gap:10px">'+csrfField(req)+'<input type="hidden" name="key" value="'+esc(x.link_key)+'"><label>Platform<input name="label" value="'+esc(x.label)+'" maxlength="80" required></label><label>HTTPS URL<input name="url" type="url" value="'+esc(x.url||'')+'" maxlength="1000" placeholder="https://…"></label><label><input type="checkbox" name="active" value="1" '+(Number(x.is_active)?'checked':'')+'> Visible to members</label><button class="btn" type="submit">Save '+esc(x.label)+'</button></form>').join('');
    res.send(adminControlPage('Official social links','/admin/social-links','<section class="ac-panel"><h2>Official social links</h2><p class="muted">Manage the official links members can open from Monarch Codex. Use a valid HTTPS URL, test it before enabling it, and leave empty or inactive platforms hidden. Keep the Founder’s personal contact links separate unless they are deliberately being published as official contacts.</p>'+forms+'</section>',req));
  }catch(e){if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).send(adminControlPage('Official social links','/admin/social-links','<p>Apply migrations/021_platform_completion_foundation.sql after a verified database backup.</p>',req));next(e);}
});
app.post('/admin/social-links', requireAdmin, requireWebCategoryAccess('social_links','manage'), express.urlencoded({extended:false,limit:'5kb'}), csrfCheck, async(req,res,next)=>{
  const key=String(req.body.key||''),label=String(req.body.label||'').trim().slice(0,80),raw=String(req.body.url||'').trim(),active=req.body.active==='1';
  if(!/^(whatsapp|telegram|facebook|instagram|youtube|tiktok|x|other)$/.test(key)||!label)return res.status(400).send(page('Invalid social link','<main><h1>Invalid platform or label.</h1></main>'));
  let url=null;if(raw){try{const u=new URL(raw);if(u.protocol!=='https:'||!u.hostname||u.username||u.password)throw new Error();url=u.toString();}catch(_){return res.status(400).send(page('Unsafe social link','<main><h1>Use a valid HTTPS URL without embedded credentials.</h1><a href="/admin/social-links">Return to social links</a></main>'));}}
  if(active&&!url)return res.status(400).send(page('URL required','<main><h1>An active link must have a URL.</h1><a href="/admin/social-links">Return to social links</a></main>'));
  try{
    await pool.execute('INSERT INTO platform_social_links (link_key,label,url,is_active,updated_by_member_id) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE label=VALUES(label),url=VALUES(url),is_active=VALUES(is_active),updated_by_member_id=VALUES(updated_by_member_id)',[key,label,url,active?1:0,req.session.memberId]);
    await pool.execute('INSERT INTO platform_action_audit (actor_member_id,action_key,target_type,target_id,details) VALUES (?,?,?,?,?)',[req.session.memberId,'social_link.updated','social_link',key,JSON.stringify({active,urlPresent:Boolean(url)})]);
    res.redirect('/admin/social-links?saved=1');
  }catch(e){next(e);}
});

app.get('/admin/cooperative-connections', requireAdmin, requireWebCategoryAccess('members_roles','view'), async(req,res,next)=>{
  try{
    const [[admin]]=await pool.execute('SELECT role FROM admin_users WHERE member_id=? AND is_active=1 LIMIT 1',[req.session.memberId]);
    if(!admin||admin.role!=='super_admin')return res.status(403).send(adminControlPage('Online Cooperative','/admin/cooperative-connections','<section class="ac-panel"><h2>Super Admin access required</h2><p class="muted">Only the Monarch Codex Super Admin can approve or reject Cooperative connection requests.</p><a class="btn" href="/admin">Return to dashboard</a></section>',req));
    const [items]=await pool.query("SELECT c.id,c.member_id,c.registered_name,c.registered_email,c.created_at,m.full_name,m.email AS member_email,m.username FROM online_cooperative_connections c JOIN members m ON m.id=c.member_id WHERE c.status='pending' ORDER BY c.created_at ASC LIMIT 200");
    const cards=items.map(x=>'<article class="ac-panel ac-coop-card"><div class="ac-coop-heading"><div><p class="ac-kicker">VERIFICATION REQUEST #'+Number(x.id)+'</p><h3>'+esc(x.full_name||x.username||'Member')+'</h3><p class="muted">@'+esc(x.username||'unknown member')+' · Submitted '+esc(x.created_at)+'</p></div><span class="ac-coop-status">Pending review</span></div><dl class="ac-coop-fields"><div><dt>Member email</dt><dd>'+esc(x.member_email||'—')+'</dd></div><div><dt>Registered name</dt><dd>'+esc(x.registered_name||'—')+'</dd></div><div><dt>Registered email</dt><dd>'+esc(x.registered_email||'—')+'</dd></div></dl><p class="muted">Verify the exact name and email with the Cooperative administrator before approving. Never request passwords or one-time codes.</p><form method="post" action="/admin/cooperative-connections/'+Number(x.id)+'/review" class="ac-coop-review">'+csrfField(req)+'<label>Review note <span class="muted">(required for rejection)</span><textarea name="note" maxlength="1000" rows="3" placeholder="Record the verification result or rejection reason"></textarea></label><div class="ac-coop-actions"><button class="btn ac-coop-approve" name="decision" value="approve" type="submit">Approve verified connection</button><button class="btn ac-coop-reject" name="decision" value="reject" type="submit">Reject request</button></div></form></article>').join('');
    const content='<style>.ac-coop-list{display:grid;gap:16px;max-width:1100px}.ac-coop-card{padding:clamp(16px,3vw,24px)}.ac-coop-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;flex-wrap:wrap}.ac-coop-heading h3{margin:7px 0;font-size:1.15rem;font-weight:700}.ac-coop-status{padding:6px 10px;border:1px solid #80652c;border-radius:999px;background:#29200e;color:#f1d580;font-size:.72rem;font-weight:600}.ac-coop-fields{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:18px 0}.ac-coop-fields div{min-width:0;padding:12px;border-radius:10px;background:#ffffff05}.ac-coop-fields dt{margin-bottom:6px;color:#8f897b;font-size:.68rem;text-transform:uppercase;letter-spacing:.08em}.ac-coop-fields dd{margin:0;color:#e7e1d2;font-size:.84rem;overflow-wrap:anywhere;font-weight:400}.ac-coop-review{display:grid;gap:12px;padding-top:14px;border-top:1px solid #302d25}.ac-coop-review label{display:grid;gap:8px}.ac-coop-actions{display:flex;gap:9px;flex-wrap:wrap}.ac-coop-approve{background:#31583a;color:#e7ffeb}.ac-coop-reject{background:#642725;color:#fff}@media(max-width:650px){.ac-coop-fields{grid-template-columns:1fr}.ac-coop-actions .btn{flex:1 1 100%}}</style><section class="ac-coop-list"><div class="ac-page-head"><div><p class="ac-kicker">MEMBER VERIFICATION</p><h2>Online Cooperative connections</h2><p class="muted">Review member-submitted registration details and record a decision. Approve only after the Cooperative administrator confirms the registration.</p></div><span class="ac-pill">'+items.length+' pending</span></div>'+(cards||'<div class="ac-panel" style="padding:24px"><h3>No pending requests</h3><p class="muted">New member connection requests will appear here when submitted.</p></div>')+'</section>';
    return res.send(adminControlPage('Online Cooperative','/admin/cooperative-connections',content,req));
  }catch(e){
    if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).send(adminControlPage('Online Cooperative','/admin/cooperative-connections','<section class="ac-panel"><h2>Verification setup required</h2><p class="muted">The Cooperative review tables are not installed in the configured database. Back up the production database, review migration 021, and apply it only after confirming the target schema.</p></section>',req));
    next(e);
  }
});

app.post('/admin/cooperative-connections/:id/review', requireAdmin, express.urlencoded({extended:false,limit:'5kb'}), csrfCheck, async(req,res,next)=>{
  const id=Number(req.params.id),decision=String(req.body.decision||''),note=String(req.body.note||'').trim().slice(0,1000);
  if(!Number.isSafeInteger(id)||id<1||!['approve','reject'].includes(decision))return res.status(400).send(page('Invalid review','<main><h1>Invalid review request</h1><a href="/admin/cooperative-connections">Return to queue</a></main>'));
  if(decision==='reject'&&!note)return res.status(400).send(page('Reason required','<main><h1>Add a rejection reason</h1><p>Provide a reason before rejecting a connection.</p><a href="/admin/cooperative-connections">Return to queue</a></main>'));
  const conn=await pool.getConnection();
  try{
    const [[admin]]=await conn.execute('SELECT role FROM admin_users WHERE member_id=? AND is_active=1 LIMIT 1',[req.session.memberId]);
    if(!admin||admin.role!=='super_admin'){await conn.rollback();return res.status(403).send(page('Access denied','<main><h1>Super Admin access required</h1></main>'));}
    await conn.beginTransaction();
    const [[item]]=await conn.execute("SELECT id,member_id,status FROM online_cooperative_connections WHERE id=? FOR UPDATE",[id]);
    if(!item||item.status!=='pending'){await conn.rollback();return res.status(409).send(page('Already reviewed','<main><h1>This request is no longer pending.</h1><a href="/admin/cooperative-connections">Return to queue</a></main>'));}
    const status=decision==='approve'?'approved':'rejected';
    await conn.execute('UPDATE online_cooperative_connections SET status=?,reviewer_member_id=?,review_note=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=?',[status,req.session.memberId,note||null,id]);
    await conn.execute('INSERT INTO member_notifications (member_id,notification_type,title,body,target_url,dedupe_key) VALUES (?,?,?,?,?,?)',[item.member_id,'cooperative_review',status==='approved'?'Online Cooperative connected':'Online Cooperative connection rejected',status==='approved'?'Your registration was manually verified and connected to Monarch Codex.':'Your connection request was rejected. Reason: '+note,'/online-cooperative','web_cooperative_result_'+id+'_'+status]);
    await conn.execute('INSERT INTO platform_action_audit (actor_member_id,action_key,target_type,target_id,details) VALUES (?,?,?,?,?)',[req.session.memberId,'cooperative.connection_'+status,'cooperative_connection',String(id),JSON.stringify({memberId:item.member_id,note})]);
    await conn.commit();
    res.redirect('/admin/cooperative-connections?review='+status);
  }catch(e){try{await conn.rollback();}catch(_){}if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).send(page('Verification setup required','<main><h1>Apply migrations/021_platform_completion_foundation.sql</h1></main>'));next(e);}
  finally{conn.release();}
});

app.get('/online-cooperative', requireAuth, requireApprovedKyc, async (req,res,next)=>{
  try {
    const m = await getMemberForPage(req,res);
    if (!m) return;
    let connection=null, connectionSetup=true;
    try { const [rows]=await pool.execute('SELECT id,status,review_note,created_at,reviewed_at FROM online_cooperative_connections WHERE member_id=? ORDER BY created_at DESC LIMIT 1',[m.id]); connection=rows[0]||null; }
    catch(e){if(e.code==='ER_NO_SUCH_TABLE')connectionSetup=false;else throw e;}
    const connectionStatus = connection ? String(connection.status) : 'not_connected';
    const connectionPanel = !connectionSetup ? '<section class="coop-member-section"><h4>05 / Connect your Cooperative account</h4><p>Manual verification is being configured. You can still register with Online Cooperative using the referral link above. Return here later to submit your registration name and email for verification.</p></section>' : '<section class="coop-member-section"><h4>05 / Connect your Cooperative account</h4><p>Register using our referral link, then submit the exact name and email used there. The Super Admin will check with the Cooperative administrator and approve only after confirmation. Do not send passwords or OTPs.</p><p><strong>Status: '+esc(connectionStatus.replace(/_/g,' '))+'</strong>'+(connection&&connection.review_note?'<br>Review note: '+esc(connection.review_note):'')+'</p>'+(connectionStatus==='not_connected'||connectionStatus==='rejected'?'<form method="post" action="/online-cooperative/connection" style="display:grid;gap:12px;max-width:520px">'+csrfField(req)+'<label>Registered name<input name="registered_name" required maxlength="160" autocomplete="name"></label><label>Registered email<input name="registered_email" type="email" required maxlength="254" autocomplete="email"></label><button class="btn" type="submit">Submit for manual verification</button></form>':'<p>'+(connectionStatus==='pending'?'Your details are waiting for manual verification.':'Your account is connected to Monarch Codex.')+'</p>')+'</section>';
    const content = `<style>
    .coop-member{display:grid;gap:20px;min-width:0;color:#f5f0e3}
    .coop-member-hero{padding:clamp(24px,4vw,42px);border:1px solid rgba(223,189,98,.3);border-radius:22px;background:radial-gradient(ellipse at 90% 0%,rgba(223,189,98,.2),transparent 38%),linear-gradient(135deg,#1d1a13,#101114 72%)}
    .coop-member-kicker{color:#e6c66e;font-size:10px;font-weight:800;letter-spacing:.18em;text-transform:uppercase}
    .coop-member h3{font-size:clamp(25px,4vw,38px);line-height:1.15;margin:12px 0;color:#fff6df;letter-spacing:-.035em}
    .coop-member p{color:#bdb8aa;font-size:13px;line-height:1.85}
    .coop-member-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}
    .coop-member-card,.coop-member-section{padding:22px;border:1px solid rgba(223,189,98,.2);border-radius:16px;background:linear-gradient(145deg,#181814,#111216)}
    .coop-member-card small{font-size:10px;letter-spacing:.13em;color:#e6c66e;font-weight:800}
    .coop-member-card h4,.coop-member-section h4{margin:10px 0;font-size:18px;color:#fff4d5}
    .coop-member-price{font-size:30px!important;font-weight:800;color:#ffe6a3!important;margin:4px 0}
    .coop-member-card ul{padding-left:18px;color:#bdb8aa;font-size:12px;line-height:1.9}
    .coop-member-bonuses{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
    .coop-member-bonus{padding:17px;border-radius:12px;background:#1a1914;border:1px solid rgba(223,189,98,.14)}
    .coop-member-bonus strong{display:block;color:#ffe6a3;font-size:25px;margin-bottom:5px}
    .coop-member-bonus span{font-size:12px;color:#d6cebd}
    .coop-member-cta{display:flex;flex-wrap:wrap;align-items:center;gap:14px;margin-top:22px}
    .coop-member-cta a{display:inline-flex;align-items:center;justify-content:center;padding:13px 18px;border-radius:10px;font-size:12px;font-weight:800}
    .coop-member-cta .primary{background:linear-gradient(120deg,#c49a47,#ffe6a3);color:#17130b}
    .coop-member-cta .secondary{border:1px solid rgba(223,189,98,.35);color:#ffe6a3}
    @media(max-width:760px){.coop-member-grid,.coop-member-bonuses{grid-template-columns:1fr}.coop-member-card,.coop-member-section{padding:19px}.coop-member-cta{flex-direction:column;align-items:stretch}.coop-member-cta a{width:100%}}
    </style>
    <div class="coop-member">
      <section class="coop-member-hero"><div class="coop-member-kicker">Partner opportunity · separate platform</div><h3>The Online Cooperative</h3><p>Explore the package levels, referral network and member benefits offered by The Online Cooperative, a separate opportunity with its own registration website.</p><div class="coop-member-cta"><a class="primary" href="https://airdrop.myturntech.com/register?ref=53" target="_blank" rel="noopener noreferrer">Visit cooperative registration ↗</a><a class="secondary" href="#coop-packages">Explore packages ↓</a></div></section>
      <section id="coop-packages"><div class="coop-member-kicker">01 / Packages</div><h3>Explore the three levels</h3><p>Explore the package levels, member benefits and earning structure available through The Online Cooperative.</p><div class="coop-member-grid">
      <article class="coop-member-card"><small>STARTER</small><h4>Starter Package</h4><p class="coop-member-price">$10</p><p>Described target: $150 (15× contribution)</p><ul><li>Maximum 10 direct referrals</li><li>Automatic placement and dashboard access</li><li>Upgrade prompt at stated target</li><li>Described 10% monthly earning feature, even without referrals</li></ul></article>
      <article class="coop-member-card"><small>PROFESSIONAL</small><h4>Professional Package</h4><p class="coop-member-price">$100</p><p>Described target: $1,500 (15× contribution)</p><ul><li>Maximum 10 direct referrals</li><li>Automatic placement and priority support</li><li>Higher earning potential, as described</li><li>Described 10% monthly earning feature, even without referrals</li></ul></article>
      <article class="coop-member-card"><small>ELITE</small><h4>Elite Package</h4><p class="coop-member-price">$1,000</p><p>Described target: $15,000 (15× contribution)</p><ul><li>Maximum 10 direct referrals</li><li>Automatic placement and VIP support</li><li>Advertised unlimited earning potential</li><li>Described 10% monthly earning feature, even without referrals</li></ul></article>
      </div></section>
      <section class="coop-member-section"><h4>02 / How the system is described</h4><p><strong>1. Contribute:</strong> choose a stated $10, $100 or $1,000 package. <strong>2. Placement:</strong> referred members are described as automatically placed, with up to 10 direct members per person. <strong>3. Earn:</strong> the description lists referral and network bonuses. <strong>4. Reach the target:</strong> an upgrade prompt is described when the target is reached. <strong>5. Upgrade:</strong> review the next tier and its conditions. <strong>6. Elite:</strong> the final level is described as offering VIP benefits.</p></section>
      <section class="coop-member-section"><h4>03 / Earning structure described</h4><div class="coop-member-bonuses"><div class="coop-member-bonus"><strong>10%</strong><span>Direct referral bonus on eligible contributions, as described</span></div><div class="coop-member-bonus"><strong>$1.00</strong><span>System placement bonus for qualifying placements, up to 10</span></div><div class="coop-member-bonus"><strong>$0.50</strong><span>Network depth bonus for qualifying wider-network members</span></div></div><p>Members can also benefit from the 10% monthly earning feature described by The Online Cooperative, even without direct referrals.</p></section>
      <section class="coop-member-section"><h4>04 / Features highlighted</h4><p>Members can track activity through the dashboard, build a direct network of up to 10 referrals, benefit from automatic placement, and work toward package milestones.</p></section>
      ${connectionPanel}
      <div class="coop-member-cta"><a class="primary" href="https://airdrop.myturntech.com/register?ref=53" target="_blank" rel="noopener noreferrer">Continue to Online Cooperative ↗</a><a class="secondary" href="/dashboard">Return to member overview</a></div>
    </div>`;
    res.send(memberPage('The Online Cooperative','/online-cooperative',m,content,req));
  } catch(e) { next(e); }
});

app.get('/investments', requireAuth, requireApprovedKyc, async (req,res,next) => {
  try {
    const m = await getMemberForPage(req,res); if (!m) return;
    const [packages] = await pool.execute("SELECT id,name,description,currency,price,duration_days,terms FROM investment_packages WHERE status='active' ORDER BY price,id");
    const [walletRows] = await pool.execute('SELECT currency,balance FROM member_wallets WHERE member_id=?',[m.id]);
    const balances = {NGN:0,USD:0};
    for (const w of walletRows) if (balances[w.currency] !== undefined) balances[w.currency] = Number(w.balance || 0);
    const [[fx]] = await pool.query('SELECT base_usd_ngn_rate,markup_percent FROM deposit_pricing_settings WHERE id=1');
    const conversionRate = fx && Number(fx.base_usd_ngn_rate)>0 ? Number(fx.base_usd_ngn_rate)*(1+Number(fx.markup_percent||0)/100) : null;
    if(conversionRate){
      // The dashboard presents one wallet in either currency. Mirror that behaviour here for package affordability.
      balances.USD = balances.USD + balances.NGN/conversionRate;
      balances.NGN = balances.NGN + (Number(walletRows.find(w=>w.currency==='USD')?.balance||0)*conversionRate);
    }
    const [investments] = await pool.execute('SELECT id,package_name_snapshot,currency,principal_amount,fee_amount,total_charged,duration_days,status,purchase_reference,created_at,matures_at FROM member_investments WHERE member_id=? ORDER BY created_at DESC,id DESC LIMIT 100',[m.id]);
    const [ledger] = await pool.execute("SELECT currency,amount,reference,created_at FROM financial_transactions WHERE member_id=? AND transaction_type='investment_purchase' ORDER BY created_at DESC LIMIT 50",[m.id]);
    const fmt=(c,n)=>(c==='NGN'?'₦':'$')+Number(n||0).toLocaleString(c==='NGN'?'en-NG':'en-US',{minimumFractionDigits:2,maximumFractionDigits:8});
    const active=investments.filter(x=>x.status==='active');
    const notice=req.query.purchase==='success'?investmentSuccessCelebration('/investments'):req.query.purchase==='already'?'<div class="inv-alert" role="status">This purchase was already processed. Your wallet was not charged again.</div>':req.query.error==='insufficient'?'<div class="inv-alert" role="alert">Your available balance is not enough for the package price plus the 1% fee. No funds were deducted.</div>':'';
    const cards=packages.map(p=>{
      const price=Number(p.price),fee=Math.round(price*1e6)/1e8,total=Math.round((price+fee)*1e8)/1e8;
      const enough=Number(balances[p.currency]||0)+1e-8>=total;
      return '<article class="inv-card"><div class="inv-pills"><span>'+esc(p.currency)+'</span><span>1% purchase fee</span></div><h3>'+esc(p.name)+'</h3><p>'+esc(p.description||'Review the package terms before purchasing.')+'</p><strong class="inv-price">'+fmt(p.currency,price)+'</strong><div class="inv-rate-note"><span>Stated monthly profit rate</span><strong>10% · '+fmt(p.currency,price*0.10)+' per full month</strong><small>Illustrative amount based on the stated rate; actual earnings must be recorded through the authorised earnings process.</small></div><div class="inv-breakdown"><div><span>Package price</span><b>'+fmt(p.currency,price)+'</b></div><div><span>1% fee</span><b>'+fmt(p.currency,fee)+'</b></div><div class="inv-total"><span>Total wallet deduction</span><b>'+fmt(p.currency,total)+'</b></div><div><span>Available balance</span><b>'+fmt(p.currency,balances[p.currency])+'</b></div></div><p class="inv-duration">'+(p.duration_days?esc(p.duration_days)+' day term':'Term as described in package terms')+'</p>'+(p.terms?'<details><summary>Read package terms</summary><p class="inv-terms">'+esc(p.terms)+'</p></details>':'')+(enough?'':'<p class="inv-insufficient" id="inv-insufficient-'+esc(p.id)+'" role="status">Insufficient '+esc(p.currency)+' balance. You need '+fmt(p.currency,total)+' including the 1% fee; your available converted balance is '+fmt(p.currency,balances[p.currency])+'.</p>')+'<form method="post" action="/investments/'+encodeURIComponent(p.id)+'/purchase">'+csrfField(req)+'<input type="hidden" name="idempotency_key" value="'+esc(crypto.randomUUID())+'"><button class="inv-buy" type="submit" '+(enough?'':'disabled aria-describedby="inv-insufficient-'+esc(p.id)+'"')+'>'+(enough?'Buy package now':'Insufficient '+esc(p.currency)+' balance')+' →</button></form></article>';
    }).join('');
    const invRows=investments.map(x=>'<tr><td><b>'+esc(x.package_name_snapshot)+'</b><br><small>'+esc(x.purchase_reference)+'</small></td><td>'+fmt(x.currency,x.principal_amount)+'</td><td>'+fmt(x.currency,x.fee_amount)+'</td><td>'+fmt(x.currency,x.total_charged)+'</td><td>'+esc(x.status)+'</td><td>'+esc(x.matures_at||'—')+'</td></tr>').join('');
    const ledgerRows=ledger.map(x=>'<tr><td>'+esc(x.created_at)+'</td><td>'+esc(x.reference)+'</td><td>'+esc(x.currency)+'</td><td class="inv-debit">−'+fmt(x.currency,Math.abs(Number(x.amount||0)))+'</td></tr>').join('');
    const content=`<style>
      .inv-page{display:grid;gap:20px;color:var(--mc-text,#f5f2ea);min-width:0}.inv-hero{padding:clamp(22px,4vw,36px);border:1px solid #655326;border-radius:22px;background:radial-gradient(ellipse at 90% 5%,#4a3b1738,transparent 38%),linear-gradient(135deg,#211d10,#121216 68%);color:#f8f5eb}.inv-kicker{color:#e5c66f;font-size:.72rem;letter-spacing:.15em;font-weight:900}.inv-hero h2{font-size:clamp(1.7rem,4vw,2.5rem);line-height:1.15;margin:12px 0;color:#fff;font-weight:850}.inv-hero p{max-width:70ch;line-height:1.7;color:#e5e0d2;font-weight:650}.inv-alert{padding:13px 15px;border:1px solid #806b2b;border-radius:12px;background:#28210f;color:#ffe9a1;font-weight:750}.inv-alert.success{border-color:#287b58;background:#10271e;color:#b6f1d3}.inv-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.inv-stat,.inv-card,.inv-table-wrap,.inv-empty{min-width:0;border:1px solid var(--mc-line,#393326);border-radius:16px;background:var(--mc-surface,#151518);padding:18px}.inv-stat span{display:block;color:var(--mc-muted,#aaa7af);font-size:.8rem}.inv-stat strong{display:block;margin-top:8px;font-size:1.2rem;overflow-wrap:anywhere}.inv-section h2{margin:8px 0;font-size:1.35rem}.inv-section>p{color:var(--mc-muted,#aaa7af);line-height:1.6}.inv-cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.inv-card{padding:22px;display:flex;flex-direction:column;gap:12px}.inv-pills{display:flex;gap:8px;flex-wrap:wrap}.inv-pills span{padding:6px 9px;border:1px solid #655326;border-radius:99px;background:#30250d;color:#e5c66f;font-size:.72rem;font-weight:850}.inv-card h3{margin:0;font-size:1.25rem}.inv-card>p{margin:0;color:var(--mc-muted,#aaa7af);line-height:1.6}.inv-price{font-size:clamp(1.6rem,3vw,2.1rem);color:#f2d77b;overflow-wrap:anywhere}.inv-rate-note{display:grid;gap:5px;padding:12px 13px;border:1px solid #655326;border-radius:12px;background:linear-gradient(120deg,#2b230f,#171714)}.inv-rate-note span,.inv-rate-note small{color:var(--mc-muted,#aaa7af);font-size:.78rem;line-height:1.5}.inv-rate-note strong{color:#f2d77b;font-size:.98rem}.inv-breakdown{display:grid;gap:9px;padding:13px;border-radius:12px;background:#0002}.inv-breakdown>div{display:flex;justify-content:space-between;gap:12px;font-size:.85rem}.inv-breakdown span{color:var(--mc-muted,#aaa7af)}.inv-breakdown b{text-align:right}.inv-breakdown .inv-total{border-top:1px solid #655326;padding-top:10px}.inv-duration{font-size:.82rem;font-weight:750}.inv-terms{white-space:pre-wrap;line-height:1.6}.inv-buy{width:100%;padding:13px 15px;border:0;border-radius:12px;background:linear-gradient(110deg,#f3d76b,#d6ad38);color:#16140d;font:inherit;font-weight:900;cursor:pointer}.inv-buy:disabled{cursor:not-allowed;background:#3a3935;color:#e0ded8;opacity:1}.inv-insufficient{margin:0;padding:11px 12px;border:1px solid #a34d43;border-radius:10px;background:#321b1a;color:#ffd0c9;font-size:.84rem;font-weight:750;line-height:1.55;overflow-wrap:anywhere}.inv-table-wrap{overflow-x:auto;padding:0}.inv-table{width:100%;min-width:690px;border-collapse:collapse;font-size:.85rem}.inv-table th,.inv-table td{text-align:left;padding:13px 15px;border-bottom:1px solid var(--mc-line,#393326);white-space:nowrap}.inv-table th{font-size:.72rem;text-transform:uppercase;color:var(--mc-muted,#aaa7af)}.inv-table small{color:var(--mc-muted,#aaa7af)}.inv-debit{color:#ffb4a8;font-weight:850}.inv-empty{color:var(--mc-muted,#aaa7af);line-height:1.7;border-style:dashed}.inv-terms{white-space:pre-wrap}html[data-theme="light"] .inv-page{color:#17191f!important}html[data-theme="light"] .inv-hero{background:linear-gradient(135deg,#fff9e8,#fff)!important;border-color:#e1d3a6}html[data-theme="light"] .inv-hero h2{color:#111318!important}html[data-theme="light"] .inv-hero p{color:#252832!important;font-weight:750}html[data-theme="light"] .inv-stat,html[data-theme="light"] .inv-card,html[data-theme="light"] .inv-table-wrap,html[data-theme="light"] .inv-empty{background:#fff!important;color:#17191f!important;border-color:#d9dce2!important}html[data-theme="light"] .inv-card h3,html[data-theme="light"] .inv-breakdown b,html[data-theme="light"] .inv-stat strong{color:#111318!important}html[data-theme="light"] .inv-card>p,html[data-theme="light"] .inv-breakdown span,html[data-theme="light"] .inv-duration{color:#343944!important;font-weight:700}html[data-theme="light"] .inv-table th,html[data-theme="light"] .inv-table td{border-color:#e0e2e6!important;color:#17191f!important}@media(max-width:760px){.inv-cards,.inv-stats{grid-template-columns:minmax(0,1fr)}.inv-card{padding:17px}}.inv-page,.inv-page *{box-sizing:border-box}.inv-page{width:100%;max-width:100%;min-width:0;overflow-wrap:anywhere}.inv-hero,.inv-section,.inv-card,.inv-stat,.inv-empty{min-width:0;max-width:100%}.inv-hero h2,.inv-hero p,.inv-section h2,.inv-section>p,.inv-card h3,.inv-card>p,.inv-terms,.inv-alert,.inv-insufficient{max-width:100%;overflow-wrap:anywhere;word-break:normal}.inv-cards{grid-template-columns:repeat(2,minmax(0,1fr));min-width:0}.inv-breakdown>div{min-width:0;flex-wrap:wrap}.inv-breakdown span,.inv-breakdown b{min-width:0;max-width:100%;overflow-wrap:anywhere}.inv-table-wrap{width:100%;max-width:100%;min-width:0;overflow-x:auto;-webkit-overflow-scrolling:touch}@media(max-width:560px){.inv-page{gap:16px}.inv-hero{padding:20px 16px}.inv-hero h2{font-size:clamp(1.45rem,7vw,2rem);line-height:1.2}.inv-hero p{font-size:.94rem;line-height:1.65}.inv-cards,.inv-stats{grid-template-columns:minmax(0,1fr)}.inv-card{padding:16px;gap:11px}.inv-breakdown{padding:11px}.inv-breakdown>div{gap:6px}.inv-breakdown b{text-align:left}.inv-table{min-width:650px}}
    .inv-hero{position:relative;isolation:isolate;overflow:hidden;box-shadow:0 18px 50px #0003}.inv-hero:after{content:"M";position:absolute;z-index:-1;right:clamp(10px,4vw,42px);top:50%;transform:translateY(-50%);font-size:clamp(120px,24vw,230px);line-height:1;font-weight:950;letter-spacing:-.12em;color:#f2d77b0b;pointer-events:none}.inv-kicker{display:inline-flex;align-items:center;gap:8px}.inv-kicker:before{content:"";width:7px;height:7px;border-radius:50%;background:#f2d77b;box-shadow:0 0 14px #f2d77b}.inv-hero h2{max-width:680px;letter-spacing:-.045em}.inv-hero p{max-width:620px}.inv-hero-chips{display:flex;flex-wrap:wrap;gap:9px;margin-top:20px}.inv-hero-chips span{display:inline-flex;align-items:center;gap:7px;padding:8px 11px;border:1px solid #e5c66f35;border-radius:999px;background:#ffffff08;color:#f5e8bc;font-size:.75rem;font-weight:800}.inv-stat{position:relative;overflow:hidden;transition:transform .18s ease,border-color .18s ease,background .18s ease}.inv-stat:before{content:"";position:absolute;inset:0 auto 0 0;width:3px;background:linear-gradient(#ffe8a0,#b58a28)}.inv-stat:hover{transform:translateY(-2px);border-color:#b99a4d}.inv-stat span{font-weight:750;letter-spacing:.015em}.inv-stat strong{font-size:clamp(1.1rem,2vw,1.4rem);letter-spacing:-.025em}.inv-section{min-width:0}.inv-section h2{display:flex;align-items:center;gap:10px;letter-spacing:-.025em}.inv-section h2:before{content:"";display:inline-block;width:5px;height:22px;border-radius:8px;background:linear-gradient(#ffe8a0,#b58a28);flex:0 0 auto}.inv-section>p{margin-top:0}.inv-card{position:relative;overflow:hidden;transition:transform .2s ease,border-color .2s ease,box-shadow .2s ease;background:radial-gradient(ellipse at 100% 0%,#d4ad3710,transparent 40%),var(--mc-surface,#151518)}.inv-card:before{content:"";position:absolute;left:0;top:0;right:0;height:2px;background:linear-gradient(90deg,#7b6024,#ffe6a3,#7b6024);opacity:.7}.inv-card:hover{transform:translateY(-3px);border-color:#9b7c35;box-shadow:0 18px 35px #0002}.inv-pills span:first-child{background:linear-gradient(120deg,#35280e,#201b10)}.inv-rate-note{box-shadow:inset 0 1px #ffffff05}.inv-buy{box-shadow:0 6px 18px #c49a3026;transition:transform .16s ease,filter .16s ease,box-shadow .16s ease}.inv-buy:not(:disabled):hover{transform:translateY(-1px);filter:brightness(1.07);box-shadow:0 9px 24px #c49a3040}.inv-buy:focus-visible{outline:3px solid #fff0a8;outline-offset:3px}.inv-table-wrap{box-shadow:0 10px 30px #0002}.inv-table th{background:#ffffff04}.inv-table tbody tr:hover{background:#d7b54d09}.inv-empty{padding:26px;background:linear-gradient(135deg,#1b1914,#141416)}.inv-alert{box-shadow:0 8px 22px #0002}.inv-alert.success{display:flex;align-items:center;gap:10px}.inv-alert.success:before{content:"✓";display:grid;place-items:center;width:28px;height:28px;border-radius:50%;background:#1e5b40;color:#d1ffe7;flex:0 0 auto}html[data-theme="light"] .inv-hero-chips span{color:#5d4716;border-color:#c8aa5d;background:#fff9e8}html[data-theme="light"] .inv-card{background:radial-gradient(ellipse at 100% 0%,#d4ad3710,transparent 40%),#fff!important}html[data-theme="light"] .inv-card:before{opacity:1}html[data-theme="light"] .inv-stat:before{background:linear-gradient(#c7a34b,#94701f)}@media(prefers-reduced-motion:reduce){.inv-stat,.inv-card,.inv-buy{transition:none!important}.inv-stat:hover,.inv-card:hover,.inv-buy:not(:disabled):hover{transform:none!important}}@media(max-width:560px){.inv-hero:after{right:-8px;top:15%;transform:none;font-size:112px}.inv-hero-chips{gap:7px}.inv-hero-chips span{font-size:.7rem;padding:7px 9px}.inv-section h2:before{height:19px}.inv-card:hover,.inv-stat:hover{transform:none}}</style><div class="inv-page">${notice}<section class="inv-hero"><span class="inv-kicker">MONARCH CODEX · WEALTH PATHWAYS</span><h2>Make your next move count.</h2><p>Explore the packages currently available to you, review the full cost and terms, and purchase directly from your wallet. The 1% purchase fee is shown before confirmation. Investment returns are not guaranteed.</p><div class="inv-hero-chips"><span>✦ Transparent pricing</span><span>◈ Secure wallet checkout</span><span>✓ Clear purchase records</span></div></section>
    <div class="inv-stats"><div class="inv-stat"><span>Active investments</span><strong>${active.length}</strong></div><div class="inv-stat"><span>NGN wallet</span><strong>${fmt('NGN',balances.NGN)}</strong></div><div class="inv-stat"><span>USD wallet</span><strong>${fmt('USD',balances.USD)}</strong></div></div>
    <section class="inv-section"><h2>Available packages</h2><p>Price, fee and total wallet deduction are shown before purchase. Packages only appear after the team publishes them.</p><div class="inv-cards">${cards||'<div class="inv-empty">No investment packages are published yet. The team must configure and activate packages before members can purchase them.</div>'}</div></section>
    <section class="inv-section"><h2>My investments</h2><p>Confirmed package purchases, recorded fees and maturity dates.</p>${investments.length?'<div class="inv-table-wrap"><table class="inv-table"><thead><tr><th>Package / reference</th><th>Principal</th><th>Fee</th><th>Total charged</th><th>Status</th><th>Maturity</th></tr></thead><tbody>'+invRows+'</tbody></table></div>':'<div class="inv-empty">You have not purchased an investment package yet.</div>'}</section>
    <section class="inv-section"><h2>Purchase ledger</h2><p>Each purchase creates one wallet debit for the package price plus the fee.</p>${ledger.length?'<div class="inv-table-wrap"><table class="inv-table"><thead><tr><th>Date</th><th>Reference</th><th>Currency</th><th>Wallet debit</th></tr></thead><tbody>'+ledgerRows+'</tbody></table></div>':'<div class="inv-empty">No investment purchases have been recorded.</div>'}</section>
    <p>Purchasing does not guarantee profit. Maturity and later withdrawal remain subject to the published package terms and platform review.</p></div>`;
    res.send(memberPage('Investments','/investments',m,content,req));
  } catch(e) {
    if (e && e.code === 'ER_NO_SUCH_TABLE') return res.status(503).send(dbSetupNotice('Investment setup required','migrations/011_investment_packages_and_purchases.sql'));
    next(e);
  }
});

app.post('/investments/:packageId/purchase', requireAuth, requireApprovedKyc, csrfCheck, async (req,res,next) => {
  const packageId=String(req.params.packageId||''), key=String(req.body.idempotency_key||'').trim();
  if (!/^\d{1,20}$/.test(packageId) || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)) return res.status(400).send(formError('Purchase could not be processed','Refresh the investment page and try again.','/investments'));
  const conn=await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[prior]]=await conn.execute('SELECT id FROM member_investments WHERE member_id=? AND idempotency_key=? LIMIT 1 FOR UPDATE',[req.session.memberId,key]);
    if(prior){await conn.commit();return res.redirect('/investments?purchase=already');}
    const [[pkg]]=await conn.execute("SELECT id,name,currency,price,duration_days,terms FROM investment_packages WHERE id=? AND status='active' LIMIT 1 FOR UPDATE",[packageId]);
    if(!pkg){await conn.rollback();return res.status(404).send(formError('Package unavailable','This package is no longer active. Refresh to see available offers.','/investments'));}
    const [[amounts]]=await conn.execute('SELECT CAST(? AS DECIMAL(20,8)) AS principal,ROUND(CAST(? AS DECIMAL(20,8))*0.01,8) AS fee,ROUND(CAST(? AS DECIMAL(20,8))+ROUND(CAST(? AS DECIMAL(20,8))*0.01,8),8) AS total',[pkg.price,pkg.price,pkg.price,pkg.price]);
    const principal=String(amounts.principal),fee=String(amounts.fee),total=String(amounts.total);
    let walletCurrency=pkg.currency, wallet=null, debitAmount=Number(total), conversionRate=1;
    const [[nativeWallet]]=await conn.execute('SELECT id,balance FROM member_wallets WHERE member_id=? AND currency=? LIMIT 1 FOR UPDATE',[req.session.memberId,pkg.currency]);
    if(nativeWallet && Number(nativeWallet.balance)+1e-8>=Number(total)) wallet=nativeWallet;
    else {
      const [[pricing]]=await conn.query('SELECT base_usd_ngn_rate,markup_percent FROM deposit_pricing_settings WHERE id=1');
      conversionRate=Number(pricing&&pricing.base_usd_ngn_rate)*(1+Number(pricing&&pricing.markup_percent||0)/100);
      if(!Number.isFinite(conversionRate)||conversionRate<=0){await conn.rollback();return res.status(503).send(formError('Currency conversion unavailable','The configured exchange rate is unavailable. No funds were deducted.','/investments'));}
      if(pkg.currency==='USD'){
        walletCurrency='NGN'; debitAmount=Math.round(Number(total)*conversionRate*100)/100;
        const [[otherWallet]]=await conn.execute('SELECT id,balance FROM member_wallets WHERE member_id=? AND currency=\'NGN\' LIMIT 1 FOR UPDATE',[req.session.memberId]);
        if(otherWallet && Number(otherWallet.balance)+1e-8>=debitAmount) wallet=otherWallet;
      } else if(pkg.currency==='NGN') {
        walletCurrency='USD'; debitAmount=Math.round((Number(total)/conversionRate)*100)/100;
        const [[otherWallet]]=await conn.execute('SELECT id,balance FROM member_wallets WHERE member_id=? AND currency=\'USD\' LIMIT 1 FOR UPDATE',[req.session.memberId]);
        if(otherWallet && Number(otherWallet.balance)+1e-8>=debitAmount) wallet=otherWallet;
      }
    }
    if(!wallet){await conn.rollback();return res.redirect('/investments?error=insufficient');}
    const [debit]=await conn.execute('UPDATE member_wallets SET balance=balance-? WHERE id=? AND balance>=?',[debitAmount,wallet.id,debitAmount]);
    if(debit.affectedRows!==1){await conn.rollback();return res.redirect('/investments?error=insufficient');}
    const reference='INV-'+crypto.randomUUID().replace(/-/g,'').toUpperCase();
    const [created]=await conn.execute("INSERT INTO member_investments (member_id,package_id,package_name_snapshot,currency,principal_amount,fee_percent,fee_amount,total_charged,duration_days,terms_snapshot,status,purchase_reference,idempotency_key,starts_at,matures_at) VALUES (?,?,?,?,?,1.00,?,?,?,?, 'active',?,?,CURRENT_TIMESTAMP,IF(? IS NULL,NULL,DATE_ADD(CURRENT_TIMESTAMP, INTERVAL ? DAY)))",[req.session.memberId,pkg.id,pkg.name,pkg.currency,principal,fee,total,pkg.duration_days,pkg.terms||'',reference,key,pkg.duration_days,pkg.duration_days]);
    const walletDebitReference=walletCurrency===pkg.currency?reference:reference+'-FX';
    await conn.execute("INSERT INTO financial_transactions (member_id,deposit_request_id,investment_id,transaction_type,currency,amount,reference,admin_note) VALUES (?,NULL,?,'investment_purchase',?,?,?,?)",[req.session.memberId,created.insertId,walletCurrency,(-debitAmount).toFixed(8),walletDebitReference,walletCurrency===pkg.currency?null:(pkg.currency==='USD'?'USD package converted to NGN at '+conversionRate.toFixed(6)+' NGN per USD; package total '+total+' USD':'NGN package converted to USD at '+conversionRate.toFixed(6)+' NGN per USD; package total '+total+' NGN')]);
    await conn.execute('INSERT INTO member_notifications (member_id,notification_type,title,body,target_url,dedupe_key) VALUES (?,?,?,?,?,?)',[req.session.memberId,'investment_purchase','Investment package purchased','Your '+pkg.name+' package purchase was recorded. Package price: '+principal+' '+pkg.currency+'; 1% fee: '+fee+' '+pkg.currency+'; total wallet deduction: '+total+' '+pkg.currency+'.','/investments','investment-purchase:'+created.insertId]);
    await conn.commit();
    return res.redirect('/investments?purchase=success');
  } catch(e) {
    try{await conn.rollback();}catch(_){}
    if(e&&e.code==='ER_DUP_ENTRY'){try{const [[prior]]=await pool.execute('SELECT id FROM member_investments WHERE member_id=? AND idempotency_key=? LIMIT 1',[req.session.memberId,key]);if(prior)return res.redirect('/investments?purchase=already');}catch(_){}}
    if(e&&e.code==='ER_NO_SUCH_TABLE')return res.status(503).send(dbSetupNotice('Investment setup required','migrations/011_investment_packages_and_purchases.sql'));
    next(e);
  } finally {conn.release();}
});

app.get('/referrals', requireAuth, requireApprovedKyc, async (req,res,next)=>{  try {
    const m = await getMemberForPage(req,res);
    if (!m) return;
    const [counts] = await pool.execute('SELECT COUNT(*) AS total FROM members WHERE referred_by = ?', [m.id]);
    const base = String(process.env.APP_BASE_URL || 'https://monarchcodex.online').replace(/[/]+$/, '');
    const link = base + '/register?ref=' + encodeURIComponent(m.monarch_uid);
    const total = Number(counts[0].total || 0);
    const content = `<style>.referral-experience{display:grid;gap:18px;min-width:0}
.referral-hero{position:relative;isolation:isolate;overflow:hidden;display:grid;grid-template-columns:minmax(0,1fr) 112px;align-items:center;gap:22px;padding:clamp(22px,4vw,36px);border:1px solid rgba(223,189,98,.25);border-radius:22px;background:radial-gradient(ellipse at 88% 12%,rgba(223,189,98,.19),transparent 36%),linear-gradient(135deg,#1b1a16 0%,#111113 58%,#19160e 100%)}
.referral-hero:after{content:"";position:absolute;z-index:-1;width:210px;height:210px;right:-82px;bottom:-125px;border:1px solid rgba(223,189,98,.14);border-radius:50%;box-shadow:0 0 0 22px rgba(223,189,98,.025),0 0 0 44px rgba(223,189,98,.02)}
.referral-kicker{display:flex;align-items:center;gap:8px;margin:0 0 12px;color:#e5c66f;font-size:10px;font-weight:850;letter-spacing:.17em;text-transform:uppercase}
.referral-kicker:before{content:"";width:20px;height:1px;background:#dfbd62}
.referral-hero h3{max-width:620px;margin:0;color:#fff8e8;font-size:clamp(25px,3.6vw,37px);line-height:1.12;letter-spacing:-.045em}
.referral-hero p{max-width:590px;margin:12px 0 0;color:#bdb8aa;font-size:13px;line-height:1.75}
.referral-hero-art{display:grid;place-items:center;width:100px;height:100px;justify-self:center;border:1px solid rgba(223,189,98,.32);border-radius:28px;background:linear-gradient(145deg,rgba(223,189,98,.16),rgba(223,189,98,.025));box-shadow:inset 0 1px 0 rgba(255,255,255,.05),0 18px 35px rgba(0,0,0,.18);transform:rotate(3deg)}
.referral-hero-art svg{width:48px;height:48px;fill:none;stroke:#f1d98d;stroke-width:1.4;stroke-linecap:round;stroke-linejoin:round}
.referral-stat-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
.referral-stat-card{position:relative;min-width:0;overflow:hidden;padding:21px;border:1px solid #383328;border-radius:17px;background:linear-gradient(145deg,#18181b,#111113)}
.referral-stat-card:after{content:"";position:absolute;width:90px;height:90px;right:-42px;top:-44px;border:1px solid rgba(223,189,98,.14);border-radius:50%;box-shadow:0 0 0 12px rgba(223,189,98,.025)}
.referral-stat-label{display:flex;align-items:center;gap:8px;color:#aaa79e;font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase}
.referral-stat-label svg{width:16px;height:16px;stroke:#dfbd62;fill:none;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.referral-stat-number{display:block;margin:14px 0 6px;color:#f6e7b3;font-size:clamp(28px,4vw,38px);font-weight:850;letter-spacing:-.045em;line-height:1.1;overflow-wrap:anywhere}
.referral-stat-note{margin:0;color:#99958b;font-size:11px;line-height:1.6}
.referral-share-card{min-width:0;padding:clamp(18px,3vw,26px);border:1px solid rgba(223,189,98,.23);border-radius:19px;background:linear-gradient(150deg,rgba(28,27,23,.98),rgba(16,16,18,.98))}
.referral-card-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;margin-bottom:20px}
.referral-card-heading h3{margin:0;color:#f8f2e3;font-size:18px;letter-spacing:-.025em}
.referral-card-heading p{margin:6px 0 0;color:#a8a397;font-size:12px;line-height:1.65}
.referral-secure-pill{display:inline-flex;align-items:center;gap:6px;flex:0 0 auto;padding:7px 9px;border:1px solid rgba(223,189,98,.19);border-radius:999px;background:rgba(223,189,98,.07);color:#e4ca7c;font-size:9px;font-weight:800;letter-spacing:.06em}
.referral-secure-pill:before{content:"";width:5px;height:5px;border-radius:50%;background:#dfbd62}
.referral-field{display:grid;gap:8px;margin-top:17px;min-width:0}
.referral-field:first-of-type{margin-top:0}
.referral-field label{color:#c7c1b3;font-size:10px;font-weight:850;letter-spacing:.11em;text-transform:uppercase}
.referral-field-row{display:flex;align-items:stretch;gap:9px;min-width:0}
.referral-value{display:flex;align-items:center;min-width:0;flex:1;padding:12px 14px;border:1px solid #3d382a;border-radius:12px;background:#0c0c0e;color:#f2e6be;font-size:14px;font-weight:800;letter-spacing:.035em;overflow-wrap:anywhere}
.referral-value input{width:100%;min-width:0;padding:0;border:0;outline:none;background:transparent;color:#f2e6be;font:inherit;font-size:12px;letter-spacing:0}
.referral-copy-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;flex:0 0 auto;min-width:112px;padding:11px 14px;border:1px solid #dfbd62;border-radius:12px;background:linear-gradient(135deg,#f1d98d,#d5ae4d);color:#17140b;font:inherit;font-size:11px;font-weight:900;cursor:pointer;transition:transform .18s,filter .18s}
.referral-copy-btn:hover{transform:translateY(-1px);filter:brightness(1.06)}
.referral-copy-btn:focus-visible{outline:2px solid #f5e6b5;outline-offset:3px}
.referral-copy-btn svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.referral-field-help{margin:0;color:#8f8b82;font-size:11px;line-height:1.65}
.referral-steps{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.referral-step{min-width:0;padding:17px;border:1px solid #302d25;border-radius:15px;background:rgba(19,19,21,.76)}
.referral-step-num{display:grid;place-items:center;width:30px;height:30px;margin-bottom:12px;border:1px solid rgba(223,189,98,.28);border-radius:10px;background:rgba(223,189,98,.08);color:#e5c66f;font-size:11px;font-weight:900}
.referral-step h4{margin:0 0 6px;color:#e9e2d2;font-size:12px}
.referral-step p{margin:0;color:#99958b;font-size:11px;line-height:1.65}
.referral-footnote{display:flex;align-items:flex-start;gap:10px;padding:13px 15px;border:1px solid #302d25;border-radius:13px;background:rgba(255,255,255,.018);color:#99958b;font-size:11px;line-height:1.7}
.referral-footnote svg{flex:0 0 17px;width:17px;height:17px;margin-top:1px;fill:none;stroke:#dfbd62;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
@media(max-width:650px){.referral-hero{grid-template-columns:minmax(0,1fr) 68px;gap:12px;padding:22px 18px}.referral-hero-art{width:64px;height:64px;border-radius:19px}.referral-hero-art svg{width:34px;height:34px}.referral-stat-grid{gap:10px}.referral-stat-card{padding:16px}.referral-card-heading{display:grid}.referral-secure-pill{justify-self:start}.referral-steps{grid-template-columns:1fr}.referral-step{display:grid;grid-template-columns:32px minmax(0,1fr);column-gap:11px;padding:14px}.referral-step-num{grid-row:span 2;margin:0}.referral-step h4{align-self:end}.referral-step p{align-self:start}}
@media(max-width:420px){.referral-hero{grid-template-columns:1fr}.referral-hero-art{display:none}.referral-stat-grid{grid-template-columns:1fr}.referral-field-row{flex-direction:column}.referral-copy-btn{width:100%;min-height:44px}.referral-value{min-height:45px}.referral-share-card{padding:17px 14px}}
@media(prefers-reduced-motion:reduce){.referral-copy-btn{transition:none}.referral-copy-btn:hover{transform:none}}
</style>
<div class="referral-experience">
  <section class="referral-hero">
    <div><p class="referral-kicker">Grow your circle</p><h3>Good things are better when shared.</h3><p>Invite people into Monarch Codex with your personal referral link. Your account keeps track of members who register with your code.</p></div>
    <div class="referral-hero-art" aria-hidden="true"><svg viewBox="0 0 48 48"><circle cx="18" cy="15" r="6"/><path d="M6 36v-3a9 9 0 0 1 9-9h6a9 9 0 0 1 9 9v3"/><circle cx="34" cy="17" r="4"/><path d="M33 25h2a7 7 0 0 1 7 7v4M29 9l3-3 3 3M32 6v7"/></svg></div>
  </section>
  <section class="referral-stat-grid" aria-label="Referral summary">
    <article class="referral-stat-card"><span class="referral-stat-label"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2"/><circle cx="9.5" cy="7" r="4"/><path d="M20 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg> Registered referrals</span><strong class="referral-stat-number">${total.toLocaleString('en-US')}</strong><p class="referral-stat-note">Members linked to your referral code.</p></article>
    <article class="referral-stat-card"><span class="referral-stat-label"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 9h4M7 13h10M16 9h1"/></svg> Your member code</span><strong class="referral-stat-number" style="font-size:clamp(20px,3vw,28px)">${esc(m.monarch_uid)}</strong><p class="referral-stat-note">Your unique identity across Monarch Codex.</p></article>
  </section>
  <section class="referral-share-card">
    <div class="referral-card-heading"><div><h3>Your personal invite link</h3><p>Copy your link or code and share it with someone you trust.</p></div><span class="referral-secure-pill">Personal invite</span></div>
    <div class="referral-field"><label for="pageReferralLink">Referral link</label><div class="referral-field-row"><div class="referral-value"><input id="pageReferralLink" value="${esc(link)}" readonly aria-label="Your personal referral link"></div><button class="referral-copy-btn" type="button" data-copy-target="pageReferralLink"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></svg>Copy invite link</button></div><p class="referral-field-help">The link opens registration with your referral code attached.</p></div>
    <div class="referral-field"><label for="pageUid">Member referral code</label><div class="referral-field-row"><div class="referral-value" id="pageUid">${esc(m.monarch_uid)}</div><button class="referral-copy-btn" type="button" data-copy-target="pageUid"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></svg>Copy code</button></div><p class="referral-field-help">Friends can enter this code during registration if they don't use your link.</p></div>
  </section>
  <section class="referral-steps" aria-label="How referrals work"><article class="referral-step"><span class="referral-step-num">01</span><h4>Share your link</h4><p>Send your personal invite link or referral code to a friend.</p></article><article class="referral-step"><span class="referral-step-num">02</span><h4>They register</h4><p>Your code is attached when they successfully create their account.</p></article><article class="referral-step"><span class="referral-step-num">03</span><h4>Track your circle</h4><p>See the number of registered members linked to your account above.</p></article></section>
  <p class="referral-footnote"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg><span>Referral attribution is recorded when a new account successfully registers using your code. This page reports registered referrals; it does not promise rewards or commissions.</span></p>
</div>`;
    res.send(memberPage('Referrals','/referrals',m,content,req));
  } catch(e) { next(e); }
});
app.post('/logout', csrfCheck, (req, res, next) => req.session.destroy(err => {
  if (err) return next(err);
  res.clearCookie('monarch.sid', { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
  res.redirect('/');
}));
app.get('/forgot-password', (req, res) => res.send(page('Reset password', '<h1>Reset your password</h1><p class="muted">Enter your account email. If it exists, we will send reset instructions.</p><form method="post" action="/forgot-password">' + csrfField(req) + '<label for="email">Email address</label><input id="email" type="email" name="email" autocomplete="email" required maxlength="254"><button class="btn" type="submit">Send reset link</button></form><div class="links"><a href="/login">Back to login</a></div>')));
app.post('/forgot-password', resetNetworkLimiter, resetLimiter, csrfCheck, async (req, res, next) => {
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
// Sovereign Desk routes share the existing session, database, CSRF, and role enforcement.
app.use(createSovereignDeskRouter({ pool, requireAuth, requireApprovedKyc, requireAdmin, csrfCheck, csrfField, adminControlPage, memberPage, getMemberForPage, esc }));
app.use(createMonarchsDirectoryRouter({ pool, requireAuth, requireAdmin, csrfCheck, csrfField, memberPage, adminControlPage, esc }));
app.use(createToolsRouter({ pool, requireAuth, requireAdmin, csrfCheck, csrfField, memberPage, adminControlPage, getMemberForPage, esc }));

// Serve only explicitly public website files. Never expose the application directory (server.js, migrations, package files, or private data) through static hosting.
app.get('/', async (_req, res, next) => {
  try {
    let html = await fs.promises.readFile(path.join(__dirname, 'index.html'), 'utf8');
    const monarchsSection = `
<section id="monarchs" class="monarchs-directory" aria-labelledby="monarchs-title">
  <div class="monarchs-directory-inner">
    <p class="monarchs-kicker">THE PEOPLE BEHIND THE KINGDOM</p>
    <h2 id="monarchs-title">MONARCHS</h2>
    <p class="monarchs-intro">Meet the members building with Monarch Codex.</p>
    <div class="monarchs-grid" id="monarchsGrid"><p class="monarchs-empty">Our featured Monarchs will appear here soon.</p></div>
  </div>
</section>
<style>
.monarchs-directory{padding:clamp(52px,8vw,100px) 20px;background:radial-gradient(ellipse at 50% 0,rgba(221,184,75,.12),transparent 55%),#0a0a0c;color:#f8f3e6}
.monarchs-directory-inner{max-width:1180px;margin:auto;text-align:center}
.monarchs-kicker{font-size:11px;letter-spacing:.2em;font-weight:800;color:#dfbd62}
.monarchs-directory h2{font-size:clamp(34px,6vw,62px);line-height:1;margin:12px 0;color:#f6d56b;letter-spacing:.06em}
.monarchs-intro{color:#aaa69b;margin:0 auto 22px;max-width:540px}
.monarchs-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,168px));justify-content:center;gap:16px;max-width:900px;margin:28px auto 0}
.monarch-card{padding:16px 12px 14px;border:1px solid rgba(223,189,98,.2);border-radius:16px;background:linear-gradient(145deg,#191817,#101012);min-width:0;max-width:168px;width:100%;margin:auto;box-sizing:border-box}
.monarch-card-photo{display:block;flex:0 0 auto;width:76px;height:76px;aspect-ratio:1/1;margin:0 auto 12px;border-radius:50%;object-fit:cover;object-position:50% 50%;border:2px solid #dfbd62;box-shadow:0 0 0 4px rgba(223,189,98,.07);background:#191919}
.monarch-card-name{font-size:15px;line-height:1.35;font-weight:800;margin:0 0 9px;overflow-wrap:anywhere;color:#f8f3e6}
.monarch-card-id{display:inline-block;max-width:100%;padding:4px 7px;border:1px solid rgba(223,189,98,.22);border-radius:7px;color:#cbb46a;font-size:10px;line-height:1.35;font-weight:750;overflow-wrap:anywhere}
.monarch-card-title{display:block;margin-top:9px;color:#aaa69b;font-size:10px;font-weight:750;letter-spacing:.06em;text-transform:uppercase}
.monarchs-empty{grid-column:1/-1;color:#aaa69b;padding:25px}
@media(max-width:380px){.monarchs-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.monarch-card{padding:13px 8px}.monarch-card-photo{width:68px;height:68px}.monarch-card-name{font-size:14px}}
</style>
<script>
(async()=>{const grid=document.getElementById('monarchsGrid');if(!grid)return;try{const response=await fetch('/api/public-monarchs',{credentials:'same-origin'});if(!response.ok)return;const people=await response.json();if(!people.length)return;grid.innerHTML='';for(const p of people){const card=document.createElement('article');card.className='monarch-card';const img=document.createElement('img');img.className='monarch-card-photo';img.src=p.photo;img.alt='Approved profile picture';img.loading='lazy';const name=document.createElement('div');name.className='monarch-card-name';name.textContent=p.nickname||'Monarch';const uid=document.createElement('span');uid.className='monarch-card-id';uid.textContent=p.monarchId||'Monarch';const title=document.createElement('span');title.className='monarch-card-title';title.textContent=p.title;card.append(img,name,uid,title);grid.append(card)}}catch(_){}})();
</script>`;
    if (html.includes('<footer class="footer">')) html = html.replace('<footer class="footer">', monarchsSection + '<footer class="footer">');
    else if (html.includes('</main>')) html = html.replace('</main>', monarchsSection + '</main>');
    else if (html.includes('</body>')) html = html.replace('</body>', monarchsSection + '</body>');
    else html += monarchsSection;
    res.type('html').send(html);
  } catch (e) { next(e); }
});
app.get(['/manifest.webmanifest', '/service-worker.js', '/app-icon.svg'], (req, res) => {
  const file = path.join(__dirname, path.basename(req.path));
  if (req.path === '/manifest.webmanifest') return res.sendFile(file, { headers: { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'no-cache' } });
  if (req.path === '/service-worker.js') return res.sendFile(file, { headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' } });
  return res.sendFile(file, { headers: { 'Cache-Control': 'public, max-age=3600' } });
});
app.get(['/privacy.html', '/terms.html', '/market-news.html', '/market-movers.html', '/online-cooperative.html', '/sovereign-desk.html', '/help-support.html'], (req, res) => {
  res.sendFile(path.join(__dirname, path.basename(req.path)));
});
app.get(['/style.css', '/member-dashboard.css', '/kyc-wizard.css', '/kyc-wizard.js', '/wallet-balances.js', '/member-nav.js', '/member-dashboard.js'], (req, res) => {
  res.sendFile(path.join(__dirname, path.basename(req.path)));
});
app.use('/assets', express.static(path.join(__dirname, 'assets'), { dotfiles: 'ignore', maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));
app.use('/api/mobile', createMobileApiRouter({ pool, bcrypt, sendAppEmail, appBaseUrl: (process.env.APP_BASE_URL || 'https://monarchcodex.online').replace(/\/+$/, ''), depositProofUpload, decryptProfileValue, loginLimiter, registrationLimiter }));
app.use(createRoleManagementRouter({ pool, requireWebCategoryAccess }));
app.use((req, res) => res.status(404).send(page('Not found', '<h1>Page not found</h1><a class="btn" href="/">Return to Monarch Codex</a>')));
app.use((err, req, res, _next) => {
  const incidentId = crypto.randomBytes(5).toString('hex').toUpperCase();
  console.error('[app error][' + incidentId + ']', {
    message: err && err.message ? err.message : 'Unknown error',
    path: req && req.path,
    method: req && req.method,
    code: err && err.code
  });
  if (res.headersSent) return;
  const incident = esc(incidentId);
  const html = '<main class="mc-feedback-page"><section class="mc-feedback-card"><div class="mc-feedback-mark" aria-hidden="true">!</div><h1>We hit a temporary problem</h1><p>We couldn’t complete that request. Your action may not have been saved. Please try again, and if this keeps happening, share the support reference below with Monarch Codex support.</p><p style="margin-top:18px;color:#f3cf3c;font-weight:800">Support reference: ' + incident + '</p><a class="mc-feedback-link" href="/">Return home</a></section></main>';
  const fallback = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#09090b"><title>Temporary problem · Monarch Codex</title><style>body{margin:0;background:#09090b;color:#f7f4e9;font:16px/1.65 system-ui,sans-serif}.mc-feedback-page{min-height:100vh;box-sizing:border-box;display:grid;place-items:center;padding:22px;background:radial-gradient(ellipse at 50% 0%,rgba(243,207,60,.13),transparent 50%),#09090b}.mc-feedback-card{width:min(520px,100%);box-sizing:border-box;padding:clamp(24px,6vw,38px);border:1px solid rgba(243,207,60,.38);border-radius:26px;background:linear-gradient(145deg,#1b1a16,#101012);box-shadow:0 24px 80px #0008;text-align:center}.mc-feedback-card h1{color:#f3cf3c;margin:0 0 12px;font-size:clamp(1.5rem,6vw,2rem)}.mc-feedback-card p{color:#d5d0c3;overflow-wrap:anywhere}.mc-feedback-mark{width:60px;height:60px;display:grid;place-items:center;border-radius:20px;margin:0 auto 18px;background:rgba(243,207,60,.13);border:1px solid rgba(243,207,60,.45);color:#f3cf3c;font-size:28px}.mc-feedback-link{display:inline-block;margin-top:24px;padding:12px 24px;border-radius:999px;background:#f3cf3c;color:#17140a;text-decoration:none;font-weight:850}</style></head><body>' + html + '</body></html>';
  res.status(500).type('html').send(fallback);
});
app.listen(port, () => console.log('Monarch Codex server listening on port', port));