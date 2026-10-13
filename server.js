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
':root{color-scheme:dark;--gold:#f3cf3c;--bg:#0b0b0c;--panel:#17171c;--muted:#b8b6c0}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top,#252111 0,#0b0b0c 45%);color:#f7f5ef;font:16px/1.6 system-ui,-apple-system,Segoe UI,sans-serif;min-height:100vh}.wrap{width:min(100% - 32px,540px);margin:48px auto}.brand{font-weight:900;letter-spacing:.08em;color:var(--gold);text-decoration:none}.panel{margin-top:20px;padding:28px;background:rgba(23,23,28,.96);border:1px solid #55491e;border-radius:22px;box-shadow:0 18px 55px #0007}h1{line-height:1.2;font-size:clamp(1.7rem,5vw,2.3rem);margin:.25em 0}.muted{color:var(--muted)}label{display:block;font-weight:700;margin:15px 0 6px}input{width:100%;padding:13px 14px;border:1px solid #484650;border-radius:10px;background:#0d0d10;color:#fff;font:inherit}input:focus{outline:2px solid var(--gold);outline-offset:1px}.password-wrap{position:relative}.password-wrap input{padding-right:54px}.password-toggle{position:absolute;right:8px;top:50%;transform:translateY(-50%);width:40px;height:40px;display:grid;place-items:center;border:0;border-radius:8px;background:transparent;color:var(--muted);cursor:pointer}.password-toggle:hover,.password-toggle:focus-visible{color:var(--gold);outline:2px solid var(--gold)}.password-toggle svg{width:21px;height:21px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.btn{display:inline-block;width:100%;margin-top:20px;padding:13px 16px;border:0;border-radius:999px;background:var(--gold);color:#121212;font:inherit;font-weight:900;text-align:center;text-decoration:none;cursor:pointer}.links{display:flex;gap:14px;flex-wrap:wrap;margin-top:18px}.links a{color:var(--gold)}.notice{padding:12px 14px;border:1px solid #625222;border-radius:10px;background:#27220f;margin:14px 0}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.stat{padding:15px;border:1px solid #48412a;border-radius:12px}.stat strong{display:block;color:var(--gold);font-size:1.2rem;overflow-wrap:anywhere}.small{font-size:.88rem}footer{margin-top:24px;color:var(--muted);font-size:.85rem}@media(max-width:420px){.panel{padding:20px}.grid{grid-template-columns:1fr}}.wrap.dashboard-wrap{width:min(calc(100% - 32px),1100px);margin:32px auto}.dashboard-wrap .panel{padding:clamp(22px,3.5vw,40px)}.dashboard-wrap .grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.dashboard-wrap .stat{min-width:0}.dashboard-wrap #refLink{font-size:clamp(.85rem,1.5vw,1rem)}.dashboard-wrap .notice{overflow-wrap:anywhere}@media(max-width:560px){.wrap.dashboard-wrap{width:calc(100% - 24px);margin:18px auto}.dashboard-wrap .panel{padding:18px}.dashboard-wrap .grid{grid-template-columns:1fr}.dashboard-wrap .btn{min-height:48px}}' +
'</style></head><body><main class="wrap' + (title === 'Member dashboard' ? ' dashboard-wrap' : '') + '"><a class="brand" href="/">MONARCH CODEX</a><section class="panel">' + body + '</section><footer>Knowledge. Strategy. Empowerment. · Keep your password private.</footer></main><script>function togglePassword(id,button){var input=document.getElementById(id);if(!input)return;var show=input.type==="password";input.type=show?"text":"password";button.setAttribute("aria-label",show?"Hide password":"Show password");button.setAttribute("title",show?"Hide password":"Show password");}</script></body></html>';
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
    const body = '<div class="muted small">MEMBER DASHBOARD</div><h1>Welcome, ' + esc(member.full_name.split(' ')[0]) + '</h1><p class="muted">Your Monarch Codex membership is active.</p>' +
      '<div class="grid"><div class="stat"><span class="muted small">Your Monarch ID</span><strong>' + esc(member.monarch_uid) + '</strong></div><div class="stat"><span class="muted small">Successful referrals</span><strong>' + (Number(counts[0].total) || 0) + '</strong></div></div>' +
      '<label for="refLink">Your personal referral link</label><input id="refLink" value="' + esc(referralLink) + '" readonly onclick="this.select()"><p class="muted small">Share this link to track registrations. No earnings or rewards are guaranteed.</p>' +
      '<div class="notice"><strong>Account details</strong><br>' + esc(member.full_name) + '<br>' + esc(member.email) + '<br>@' + esc(member.username) + '</div>' +
      '<form method="post" action="/logout">' + csrfField(req) + '<button class="btn" type="submit">Log out</button></form>';
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
