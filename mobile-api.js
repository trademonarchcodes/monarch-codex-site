'use strict';

const express = require('express');
const crypto = require('node:crypto');
const rateLimit = require('express-rate-limit');

function createMobileApiRouter({ pool, bcrypt, sendAppEmail, appBaseUrl, loginLimiter: sharedLoginLimiter, registrationLimiter: sharedRegistrationLimiter }) {
  const router = express.Router();
  const apiLoginLimiter = sharedLoginLimiter || rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
  const apiRegisterLimiter = sharedRegistrationLimiter || rateLimit({ windowMs: 60 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
  const noStore = (_req, res, next) => { res.set('Cache-Control', 'no-store, private'); next(); };
  const apiAuth = (req, res, next) => {
    if (!req.session || !req.session.memberId) return res.status(401).json({ error: 'authentication_required', message: 'Please sign in to continue.' });
    next();
  };
  const validEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
  const validUsername = value => /^[a-zA-Z0-9_]{6,30}$/.test(value);
  const memberById = async id => {
    const [rows] = await pool.execute(
      'SELECT id, monarch_uid, full_name, email, phone, username, email_verified_at FROM members WHERE id = ? LIMIT 1',
      [id]
    );
    return rows[0] || null;
  };
  const publicMember = member => ({
    uid: member.monarch_uid,
    fullName: member.full_name,
    email: member.email,
    phone: member.phone || '',
    username: member.username,
    emailVerified: Boolean(member.email_verified_at),
    profilePhotoUrl: '/member-avatar-current'
  });

  router.get('/health', noStore, (_req, res) => res.json({ ok: true, service: 'monarch-codex-mobile-api', version: 1 }));

  router.post('/auth/login', apiLoginLimiter, noStore, async (req, res, next) => {
    try {
      const identity = String(req.body.identity || req.body.email || req.body.username || '').trim();
      const password = String(req.body.password || '');
      if (!identity || !password || identity.length > 254 || password.length > 128) {
        return res.status(400).json({ error: 'invalid_input', message: 'Enter your email or username and password.' });
      }
      const [rows] = await pool.execute(
        'SELECT id, password_hash, email_verified_at, is_blocked FROM members WHERE LOWER(email) = LOWER(?) OR LOWER(username) = LOWER(?) LIMIT 1',
        [identity, identity]
      );
      const member = rows[0];
      const matches = member ? await bcrypt.compare(password, member.password_hash) : false;
      if (!member || !matches) return res.status(401).json({ error: 'invalid_credentials', message: 'The email/username or password is incorrect.' });
      if (Number(member.is_blocked) === 1) return res.status(403).json({ error: 'account_restricted', message: 'Account access is restricted. Please contact Monarch Codex support.' });
      if (!member.email_verified_at) return res.status(403).json({ error: 'email_not_verified', message: 'Verify your email using the link we sent before signing in.' });
      req.session.regenerate(async err => {
        if (err) return next(err);
        req.session.memberId = member.id;
        req.session.csrf = crypto.randomBytes(32).toString('hex');
        try {
          const current = await memberById(member.id);
          await new Promise((resolve, reject) => req.session.save(e => e ? reject(e) : resolve()));
          res.set('Cache-Control', 'no-store, private');
          return res.json({ member: publicMember(current) });
        } catch (e) { return next(e); }
      });
    } catch (error) { next(error); }
  });

  router.post('/auth/register', apiRegisterLimiter, noStore, async (req, res, next) => {
    try {
      const fullName = String(req.body.fullName || '').trim();
      const email = String(req.body.email || '').trim().toLowerCase();
      const username = String(req.body.username || '').trim();
      const password = String(req.body.password || '');
      const confirmPassword = String(req.body.confirmPassword || '');
      const countryCode = String(req.body.phoneCountryCode || '+234').trim();
      const phoneDigits = String(req.body.phone || '').replace(/\D/g, '');
      const phone = countryCode + phoneDigits;
      const referralCode = String(req.body.referralCode || '').trim().toUpperCase();
      if (fullName.length < 2 || fullName.length > 120) return res.status(400).json({ error: 'invalid_name', message: 'Enter your full name (2–120 characters).' });
      if (!validEmail(email)) return res.status(400).json({ error: 'invalid_email', message: 'Enter a valid email address.' });
      if (!/^\+\d{1,4}$/.test(countryCode) || phoneDigits.length < (countryCode === '+234' ? 10 : 7) || phoneDigits.length > (countryCode === '+234' ? 11 : 12)) return res.status(400).json({ error: 'invalid_phone', message: 'Check your country code and phone number.' });
      if (!validUsername(username)) return res.status(400).json({ error: 'invalid_username', message: 'Username must be 6–30 letters, numbers or underscores.' });
      if (password.length < 12 || password.length > 128 || !/[A-Z]/.test(password) || !/[0-9]/.test(password) || !/[^A-Za-z0-9\s]/.test(password)) return res.status(400).json({ error: 'weak_password', message: 'Use at least 12 characters with a capital letter, a number and a special symbol.' });
      if (password !== confirmPassword) return res.status(400).json({ error: 'password_mismatch', message: 'Your passwords do not match.' });
      if (req.body.acceptPolicies !== true) return res.status(400).json({ error: 'policies_required', message: 'Accept the Terms & Conditions and Privacy Policy to continue.' });

      const [existing] = await pool.execute('SELECT id, email, username FROM members WHERE LOWER(email)=LOWER(?) OR LOWER(username)=LOWER(?) LIMIT 1', [email, username]);
      if (existing.length) {
        const sameUsername = String(existing[0].username || '').toLowerCase() === username.toLowerCase();
        return res.status(409).json({ error: sameUsername ? 'username_taken' : 'email_exists', message: sameUsername ? 'That username is already in use.' : 'An account with that email already exists.' });
      }
      let referrerId = null;
      if (referralCode) {
        if (!/^MONARCH\d{6}$/.test(referralCode)) return res.status(400).json({ error: 'invalid_referral', message: 'That referral code is not valid.' });
        const [referrers] = await pool.execute('SELECT id FROM members WHERE monarch_uid=? LIMIT 1', [referralCode]);
        if (!referrers.length) return res.status(400).json({ error: 'referral_not_found', message: 'That referral code does not exist.' });
        referrerId = referrers[0].id;
      }
      const passwordHash = await bcrypt.hash(password, 12);
      let insertedId = null;
      for (let attempt = 0; attempt < 12; attempt++) {
        const uid = 'MONARCH' + crypto.randomInt(0, 1000000).toString().padStart(6, '0');
        try {
          const [created] = await pool.execute('INSERT INTO members (monarch_uid, full_name, email, phone, username, password_hash, referred_by) VALUES (?, ?, ?, ?, ?, ?, ?)', [uid, fullName, email, phone, username, passwordHash, referrerId]);
          insertedId = created.insertId;
          break;
        } catch (e) {
          if (e && e.code === 'ER_DUP_ENTRY') {
            const [dupes] = await pool.execute('SELECT id FROM members WHERE LOWER(email)=LOWER(?) OR LOWER(username)=LOWER(?) LIMIT 1', [email, username]);
            if (dupes.length) return res.status(409).json({ error: 'account_exists', message: 'That email or username is already in use.' });
            continue;
          }
          throw e;
        }
      }
      if (!insertedId) return res.status(503).json({ error: 'uid_generation_failed', message: 'We could not create your member ID. Please try again.' });
      const member = await memberById(insertedId);
      const token = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      await pool.execute('INSERT INTO email_verification_tokens (member_id, token_hash, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 24 HOUR))', [insertedId, tokenHash]);
      const verifyLink = appBaseUrl.replace(/\/+$/, '') + '/verify-email?token=' + token;
      if (typeof sendAppEmail === 'function') {
        try {
          const sent = await sendAppEmail({
            to: email,
            subject: 'Verify your Monarch Codex email',
            text: 'Hello ' + fullName + ',\n\nYour Monarch ID is ' + member.monarch_uid + '. Verify your email within 24 hours using this link:\n' + verifyLink + '\n\nIf you did not create this account, ignore this email.'
          });
          if (sent === false) return res.status(503).json({ error: 'verification_email_unavailable', message: 'Your account was created, but email delivery is not configured. Contact support before trying to register again.', uid: member.monarch_uid });
        } catch (mailError) {
          console.error('[mobile-api] Verification email could not be sent:', mailError && mailError.message);
          return res.status(503).json({ error: 'verification_email_failed', message: 'Your account was created, but we could not send the verification email. Contact support before trying to register again.', uid: member.monarch_uid });
        }
      }
      return res.status(201).json({ message: 'Account created. Check your email to verify it before signing in.', uid: member.monarch_uid, verificationRequired: true });
    } catch (error) {
      if (error && error.code === 'ER_NO_SUCH_TABLE' && /email_verification_tokens/.test(String(error.message || ''))) {
        return res.status(503).json({ error: 'verification_setup_required', message: 'Email verification is temporarily unavailable. Please contact support.' });
      }
      next(error);
    }
  });

  router.get('/auth/me', noStore, apiAuth, async (req, res, next) => {
    try {
      const member = await memberById(req.session.memberId);
      if (!member) {
        return req.session.destroy(() => res.status(401).json({ error: 'account_not_found', message: 'Please sign in again.' }));
      }
      res.json({ member: publicMember(member) });
    } catch (error) { next(error); }
  });

  router.post('/auth/logout', noStore, apiAuth, (req, res, next) => {
    req.session.destroy(error => {
      if (error) return next(error);
      res.clearCookie('monarch.sid', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' });
      return res.json({ ok: true });
    });
  });

  router.get('/overview', noStore, apiAuth, async (req, res, next) => {
    try {
      const member = await memberById(req.session.memberId);
      if (!member) return res.status(401).json({ error: 'account_not_found', message: 'Please sign in again.' });
      const [walletResult, fxResult, referralResult, notificationResult, kycResult] = await Promise.all([
        pool.execute('SELECT currency,balance FROM member_wallets WHERE member_id=?', [member.id]),
        pool.query('SELECT base_usd_ngn_rate,markup_percent FROM deposit_pricing_settings WHERE id=1'),
        pool.execute('SELECT COUNT(*) AS total FROM members WHERE referred_by=?', [member.id]),
        pool.execute('SELECT COUNT(*) AS total FROM member_notifications WHERE member_id=? AND read_at IS NULL', [member.id]),
        pool.execute('SELECT status FROM kyc_submissions WHERE member_id=? ORDER BY submitted_at DESC,id DESC LIMIT 1', [member.id])
      ]);
      const walletRows = walletResult[0], fxRows = fxResult[0], referralRows = referralResult[0], notificationRows = notificationResult[0], kycRows = kycResult[0];
      let ngn = 0, usd = 0;
      for (const row of walletRows) {
        if (row.currency === 'NGN') ngn = Number(row.balance) || 0;
        if (row.currency === 'USD') usd = Number(row.balance) || 0;
      }
      const fx = fxRows[0];
      const rate = fx && Number(fx.base_usd_ngn_rate) > 0 ? Number(fx.base_usd_ngn_rate) * (1 + Number(fx.markup_percent || 0) / 100) : null;
      const kycRaw = kycRows[0] ? String(kycRows[0].status || 'pending') : 'not_submitted';
      const kycLabels = { pending: 'pending', approved: 'approved', rejected: 'rejected', needs_resubmission: 'needs_resubmission' };
      res.json({
        member: publicMember(member),
        wallet: { ngn, usd, rate },
        kycStatus: kycLabels[kycRaw] || 'pending',
        referralCount: Number(referralRows[0] && referralRows[0].total) || 0,
        unreadNotifications: Number(notificationRows[0] && notificationRows[0].total) || 0,
        referralLink: appBaseUrl.replace(/\/+$/, '') + '/register?ref=' + encodeURIComponent(member.monarch_uid)
      });
    } catch (error) {
      if (error && error.code === 'ER_NO_SUCH_TABLE') return res.status(503).json({ error: 'database_setup_required', message: 'A required account feature is not configured yet. No financial action was taken.' });
      next(error);
    }
  });

  router.get('/wallet/balances', noStore, apiAuth, async (req, res, next) => {
    try {
      const [rows] = await pool.execute('SELECT currency,balance FROM member_wallets WHERE member_id=?', [req.session.memberId]);
      let ngn = 0, usd = 0;
      for (const row of rows) { if (row.currency === 'NGN') ngn = Number(row.balance) || 0; if (row.currency === 'USD') usd = Number(row.balance) || 0; }
      const [[fx]] = await pool.query('SELECT base_usd_ngn_rate,markup_percent FROM deposit_pricing_settings WHERE id=1');
      const rate = fx && Number(fx.base_usd_ngn_rate) > 0 ? Number(fx.base_usd_ngn_rate) * (1 + Number(fx.markup_percent || 0) / 100) : null;
      return res.json({ ngn, usd, rate });
    } catch (error) {
      if (error && error.code === 'ER_NO_SUCH_TABLE') return res.status(503).json({ error: 'database_setup_required', message: 'Wallet data is not configured yet.' });
      next(error);
    }
  });

  return router;
}

module.exports = createMobileApiRouter;
