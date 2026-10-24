'use strict';

const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const { Readable } = require('node:stream');

function createMobileApiRouter({ pool, bcrypt, sendAppEmail, appBaseUrl, depositProofUpload, decryptProfileValue, loginLimiter: sharedLoginLimiter, registrationLimiter: sharedRegistrationLimiter }) {
  const router = express.Router();

  const requireSuperAdmin = async (req,res,next) => {
    try {
      const [[admin]]=await pool.execute('SELECT role FROM admin_users WHERE member_id=? AND is_active=1 LIMIT 1',[req.session.memberId]);
      if(!admin||String(admin.role)!=='super_admin')return res.status(403).json({error:'super_admin_required',message:'Only the Monarch Codex Super Admin can perform this action.'});
      req.platformSuperAdmin=true; next();
    } catch(e) { next(e); }
  };
  const apiLoginLimiter = sharedLoginLimiter || rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
  const apiRegisterLimiter = sharedRegistrationLimiter || rateLimit({ windowMs: 60 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
  const noStore = (_req, res, next) => { res.set('Cache-Control', 'no-store, private'); next(); };
  const apiAuth = async (req, res, next) => {
    if (!req.session || !req.session.memberId) return res.status(401).json({ error: 'authentication_required', message: 'Please sign in to continue.' });
    try {
      const [rows] = await pool.execute('SELECT is_blocked FROM members WHERE id=? LIMIT 1', [req.session.memberId]);
      if (!rows.length || Number(rows[0].is_blocked) === 1) {
        return req.session.destroy(() => {
          res.clearCookie('monarch.sid', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' });
          res.status(403).json({ error: 'account_restricted', message: 'This account is blocked or unavailable. Please contact Monarch Codex support.' });
        });
      }
      return next();
    } catch (error) {
      // Older production databases may not have migration 015 yet. Keep normal
      // signed-in API routes available; the member list detects the missing column
      // and defaults block status safely. Block enforcement becomes active once
      // the account-controls migration is applied.
      if (error && error.code === 'ER_BAD_FIELD_ERROR' && /is_blocked/.test(String(error.message || ''))) {
        return next();
      }
      return next(error);
    }
  };
  const validEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
  const validUsername = value => /^[a-zA-Z0-9_]{6,30}$/.test(value);
  const memberById = async id => {
    const [rows] = await pool.execute(
      'SELECT m.id, m.monarch_uid, m.full_name, m.email, m.phone, m.username, m.email_verified_at, au.role AS adminRole FROM members m LEFT JOIN admin_users au ON au.member_id=m.id AND au.is_active=1 WHERE m.id = ? LIMIT 1',
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
    profilePhotoUrl: '/member-avatar-current',
    adminRole: member.adminRole || null,
    isAdmin: Boolean(member.adminRole)
  });

  const memberAccess = async id => {
    try {
      const [[admin]] = await pool.execute('SELECT role FROM admin_users WHERE member_id=? AND is_active=1 LIMIT 1', [id]);
      const role = admin ? String(admin.role) : null;
      return { adminRole: role, isAdmin: Boolean(role && role !== 'sovereign_desk_admin'), isSovereignAdmin: role === 'sovereign_desk_admin' };
    } catch (e) { if (e.code === 'ER_NO_SUCH_TABLE') return { adminRole:null, isAdmin:false, isSovereignAdmin:false }; throw e; }
  };

  router.get('/health', noStore, (_req, res) => res.json({ ok: true, service: 'monarch-codex-mobile-api', version: 1 }));

  // Public Android update manifest and asset proxy. The private GitHub release token stays on the server.
  const loadAndroidRelease = async () => {
    const token = process.env.MONARCH_ANDROID_RELEASE_TOKEN || process.env.GITHUB_RELEASE_TOKEN;
    if (!token) {
      const error = new Error('The Android update service has not been configured by the site administrator.');
      error.statusCode = 503;
      throw error;
    }
    const response = await fetch('https://api.github.com/repos/trademonarchcodes/monarch-codex-android/releases/tags/latest-apk', {
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Monarch-Codex-App-Updater'
      },
      signal: AbortSignal.timeout(12000)
    });
    if (!response.ok) {
      // GitHub commonly returns 404 for a private repository when the token
      // is valid but does not have access to that repository.
      const status = Number(response.status);
      const message = status === 401
        ? 'Android updates are not authorized. Replace MONARCH_ANDROID_RELEASE_TOKEN in Hostinger with a valid GitHub token.'
        : status === 403
          ? 'Android update access is forbidden. Give the Hostinger token Contents: Read-only access to trademmonarchcodes/monarch-codex-android.'
          : status === 404
            ? 'GitHub could not find the release for the configured token. Confirm the Hostinger token can access trademmonarchcodes/monarch-codex-android and that the latest-apk release exists.'
            : 'The official Android release could not be reached. Please try again later.';
      const error = new Error(message);
      error.statusCode = [401, 403, 404].includes(status) ? 503 : 502;
      throw error;
    }
    const release = await response.json();
    const body = String(release.body || '');
    const match = body.match(/Version:\s*([0-9]+\.[0-9]+\.[0-9]+\+[0-9]+)/i);
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const apk = assets.find(asset => asset.name === 'app-release.apk');
    const checksum = assets.find(asset => asset.name === 'app-release.apk.sha256');
    if (!match || !apk || !checksum) {
      const error = new Error('The latest Android release is missing its version, APK, or checksum.');
      error.statusCode = 503;
      throw error;
    }
    return { token, release, version: match[1], body, apk, checksum };
  };

  router.get('/app-update/latest', noStore, async (_req, res) => {
    try {
      const { release, version, body } = await loadAndroidRelease();
      const mandatory = /Mandatory:\s*(true|yes|1)/i.test(body);
      return res.set('Cache-Control', 'no-store').json({
        version,
        mandatory,
        releaseNotes: body
          .replace(/Version:\s*[0-9]+\.[0-9]+\.[0-9]+\+[0-9]+/i, '')
          .replace(/Mandatory:\s*(true|yes|1)/i, '')
          .trim(),
        apkUrl: new URL('/api/mobile/app-update/apk', appBaseUrl).toString(),
        checksumUrl: new URL('/api/mobile/app-update/checksum', appBaseUrl).toString(),
        publishedAt: release.published_at || null
      });
    } catch (error) {
      return res.status(error.statusCode || 502).json({
        error: 'android_update_unavailable',
        message: error.statusCode === 503
          ? error.message
          : 'The official Android update service is temporarily unavailable. Please try again later.'
      });
    }
  });

  const streamAndroidReleaseAsset = async (assetName, res) => {
    const { token, apk, checksum } = await loadAndroidRelease();
    const asset = assetName === 'app-release.apk' ? apk : checksum;
    const response = await fetch(asset.url, {
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/octet-stream',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Monarch-Codex-App-Updater'
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(90000)
    });
    if (!response.ok || !response.body) {
      const error = new Error('The official update file could not be downloaded.');
      error.statusCode = 502;
      throw error;
    }
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Disposition', 'attachment; filename="' + assetName + '"');
    res.set('Content-Type', assetName.endsWith('.sha256') ? 'text/plain; charset=utf-8' : 'application/vnd.android.package-archive');
    if (asset.size) res.set('Content-Length', String(asset.size));
    Readable.fromWeb(response.body).pipe(res);
  };

  router.get('/app-update/apk', noStore, async (_req, res) => {
    try { await streamAndroidReleaseAsset('app-release.apk', res); }
    catch (error) { if (!res.headersSent) res.status(error.statusCode || 502).json({ error: 'android_apk_download_failed', message: 'The official APK could not be downloaded. Please try again later.' }); }
  });

  router.get('/app-update/checksum', noStore, async (_req, res) => {
    try { await streamAndroidReleaseAsset('app-release.apk.sha256', res); }
    catch (error) { if (!res.headersSent) res.status(error.statusCode || 502).json({ error: 'android_checksum_download_failed', message: 'The APK verification file could not be downloaded. Please try again later.' }); }
  });

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
          return res.json({ member: { ...publicMember(current), ...(await memberAccess(current.id)) } });
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
      res.json({ member: { ...publicMember(member), ...(await memberAccess(member.id)) } });
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
      let actualNgn = 0, actualUsd = 0;
      for (const row of walletRows) {
        if (row.currency === 'NGN') actualNgn = Number(row.balance) || 0;
        if (row.currency === 'USD') actualUsd = Number(row.balance) || 0;
      }
      const fx = fxRows[0];
      const rate = fx && Number(fx.base_usd_ngn_rate) > 0 ? Number(fx.base_usd_ngn_rate) * (1 + Number(fx.markup_percent || 0) / 100) : null;
      const ngn = actualNgn + (rate ? actualUsd * rate : 0);
      const usd = actualUsd + (rate ? actualNgn / rate : 0);
      const kycRaw = kycRows[0] ? String(kycRows[0].status || 'pending') : 'not_submitted';
      const kycLabels = { pending: 'pending', approved: 'approved', rejected: 'rejected', needs_resubmission: 'needs_resubmission' };
      res.json({
        member: { ...publicMember(member), ...(await memberAccess(member.id)) },
        wallet: { ngn, usd, actualNgn, actualUsd, rate },
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

  // Investment opportunities and a member's own portfolio are read-only here; purchase/ledger changes remain on the separately verified financial workflow.
  router.get('/investments', noStore, apiAuth, async (req, res, next) => {
    try {
      const [packages] = await pool.execute(
        "SELECT id,name,description,currency,price,duration_days,terms,status FROM investment_packages WHERE status='active' ORDER BY id ASC"
      );
      const [portfolio] = await pool.execute(
        'SELECT id,package_id,package_name_snapshot AS packageName,currency,principal_amount AS principalAmount,fee_percent AS feePercent,fee_amount AS feeAmount,total_charged AS totalCharged,duration_days AS durationDays,status,starts_at AS startsAt,matures_at AS maturesAt,created_at AS createdAt FROM member_investments WHERE member_id=? ORDER BY created_at DESC,id DESC LIMIT 200',
        [req.session.memberId]
      );
      res.set('Cache-Control', 'no-store, private').json({
        packages: packages.map(p => ({
          id: Number(p.id), name: p.name, description: p.description || '',
          currency: p.currency, price: String(p.price), durationDays: p.duration_days,
          terms: p.terms || '', status: p.status
        })),
        portfolio: portfolio.map(p => ({
          ...p, id: Number(p.id), packageId: p.package_id == null ? null : Number(p.package_id),
          principalAmount: String(p.principalAmount), feePercent: String(p.feePercent),
          feeAmount: String(p.feeAmount), totalCharged: String(p.totalCharged)
        }))
      });
    } catch (error) {
      if (error && (error.code === 'ER_NO_SUCH_TABLE' || error.code === 'ER_BAD_FIELD_ERROR')) {
        return res.status(503).json({ error: 'investment_setup_required', message: 'Investment records are not available right now. No financial action was taken.' });
      }
      next(error);
    }
  });


  const requireApprovedKycApi = async (req, res, next) => {
    try {
      const [rows] = await pool.execute(
        "SELECT status FROM kyc_submissions WHERE member_id=? ORDER BY submitted_at DESC,id DESC LIMIT 1",
        [req.session.memberId]
      );
      if (rows.length && String(rows[0].status || '').trim().toLowerCase() === 'approved') return next();
      return res.status(403).json({ error: 'kyc_required', message: 'Identity verification must be approved before this financial action.' });
    } catch (error) {
      if (error && error.code === 'ER_NO_SUCH_TABLE') return res.status(503).json({ error: 'kyc_setup_required', message: 'Identity verification is temporarily unavailable. No financial action was taken.' });
      return next(error);
    }
  };


  // Native investment purchase: same wallet, fee, ledger, idempotency and notification rules as the website.
  router.post('/investments/:packageId/purchase', noStore, apiAuth, requireApprovedKycApi, async (req, res, next) => {
    const packageId = String(req.params.packageId || '');
    const key = String(req.body.idempotencyKey || '').trim();
    if (!/^\d{1,20}$/.test(packageId) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)) {
      return res.status(400).json({ error: 'invalid_purchase', message: 'Refresh the investment page and try again. No funds were deducted.' });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [[prior]] = await conn.execute(
        'SELECT id,purchase_reference,package_name_snapshot,currency,principal_amount,fee_amount,total_charged,status FROM member_investments WHERE member_id=? AND idempotency_key=? LIMIT 1 FOR UPDATE',
        [req.session.memberId, key]
      );
      if (prior) {
        await conn.commit();
        return res.json({
          ok: true, alreadyProcessed: true,
          investment: {
            id: Number(prior.id), reference: prior.purchase_reference, packageName: prior.package_name_snapshot,
            currency: prior.currency, principalAmount: String(prior.principal_amount),
            feeAmount: String(prior.fee_amount), totalCharged: String(prior.total_charged), status: prior.status
          },
          message: 'This purchase was already processed. Your wallet was not charged again.'
        });
      }

      const [[pkg]] = await conn.execute(
        "SELECT id,name,currency,price,duration_days,terms FROM investment_packages WHERE id=? AND status='active' LIMIT 1 FOR UPDATE",
        [packageId]
      );
      if (!pkg) {
        await conn.rollback();
        return res.status(404).json({ error: 'package_unavailable', message: 'This package is no longer active. Refresh to see available offers.' });
      }

      const [[amounts]] = await conn.execute(
        'SELECT CAST(? AS DECIMAL(20,8)) AS principal,ROUND(CAST(? AS DECIMAL(20,8))*0.01,8) AS fee,ROUND(CAST(? AS DECIMAL(20,8))+ROUND(CAST(? AS DECIMAL(20,8))*0.01,8),8) AS total',
        [pkg.price, pkg.price, pkg.price, pkg.price]
      );
      const principal = String(amounts.principal);
      const fee = String(amounts.fee);
      const total = String(amounts.total);
      let walletCurrency = pkg.currency;
      let wallet = null;
      let debitAmount = Number(total);
      let conversionRate = 1;

      const [[nativeWallet]] = await conn.execute(
        'SELECT id,balance FROM member_wallets WHERE member_id=? AND currency=? LIMIT 1 FOR UPDATE',
        [req.session.memberId, pkg.currency]
      );
      if (nativeWallet && Number(nativeWallet.balance) + 1e-8 >= Number(total)) {
        wallet = nativeWallet;
      } else {
        const [[pricing]] = await conn.query('SELECT base_usd_ngn_rate,markup_percent FROM deposit_pricing_settings WHERE id=1');
        conversionRate = Number(pricing && pricing.base_usd_ngn_rate) * (1 + Number(pricing && pricing.markup_percent || 0) / 100);
        if (!Number.isFinite(conversionRate) || conversionRate <= 0) {
          await conn.rollback();
          return res.status(503).json({ error: 'exchange_rate_unavailable', message: 'The configured exchange rate is unavailable. No funds were deducted.' });
        }
        if (pkg.currency === 'USD') {
          walletCurrency = 'NGN';
          debitAmount = Math.round(Number(total) * conversionRate * 100) / 100;
          const [[otherWallet]] = await conn.execute(
            "SELECT id,balance FROM member_wallets WHERE member_id=? AND currency='NGN' LIMIT 1 FOR UPDATE",
            [req.session.memberId]
          );
          if (otherWallet && Number(otherWallet.balance) + 1e-8 >= debitAmount) wallet = otherWallet;
        } else if (pkg.currency === 'NGN') {
          walletCurrency = 'USD';
          debitAmount = Math.round((Number(total) / conversionRate) * 100) / 100;
          const [[otherWallet]] = await conn.execute(
            "SELECT id,balance FROM member_wallets WHERE member_id=? AND currency='USD' LIMIT 1 FOR UPDATE",
            [req.session.memberId]
          );
          if (otherWallet && Number(otherWallet.balance) + 1e-8 >= debitAmount) wallet = otherWallet;
        }
      }
      if (!wallet) {
        await conn.rollback();
        return res.status(409).json({ error: 'insufficient_balance', message: 'Your available balance is not enough for the package price plus the 1% fee. No funds were deducted.' });
      }

      const [debit] = await conn.execute(
        'UPDATE member_wallets SET balance=balance-? WHERE id=? AND balance>=?',
        [debitAmount, wallet.id, debitAmount]
      );
      if (debit.affectedRows !== 1) {
        await conn.rollback();
        return res.status(409).json({ error: 'insufficient_balance', message: 'Your available balance changed. Refresh your wallet and try again. No funds were deducted.' });
      }

      const reference = 'INV-' + crypto.randomUUID().replace(/-/g, '').toUpperCase();
      const [created] = await conn.execute(
        "INSERT INTO member_investments (member_id,package_id,package_name_snapshot,currency,principal_amount,fee_percent,fee_amount,total_charged,duration_days,terms_snapshot,status,purchase_reference,idempotency_key,starts_at,matures_at) VALUES (?,?,?,?,?,1.00,?,?,?,?, 'active',?,?,CURRENT_TIMESTAMP,IF(? IS NULL,NULL,DATE_ADD(CURRENT_TIMESTAMP, INTERVAL ? DAY)))",
        [req.session.memberId, pkg.id, pkg.name, pkg.currency, principal, fee, total, pkg.duration_days, pkg.terms || '', reference, key, pkg.duration_days, pkg.duration_days]
      );
      const walletDebitReference = walletCurrency === pkg.currency ? reference : reference + '-FX';
      const adminNote = walletCurrency === pkg.currency ? null :
        (pkg.currency === 'USD'
          ? 'USD package converted to NGN at ' + conversionRate.toFixed(6) + ' NGN per USD; package total ' + total + ' USD'
          : 'NGN package converted to USD at ' + conversionRate.toFixed(6) + ' NGN per USD; package total ' + total + ' NGN');
      await conn.execute(
        "INSERT INTO financial_transactions (member_id,deposit_request_id,investment_id,transaction_type,currency,amount,reference,admin_note) VALUES (?,NULL,?,'investment_purchase',?,?,?,?)",
        [req.session.memberId, created.insertId, walletCurrency, (-debitAmount).toFixed(8), walletDebitReference, adminNote]
      );
      await conn.execute(
        'INSERT INTO member_notifications (member_id,notification_type,title,body,target_url,dedupe_key) VALUES (?,?,?,?,?,?)',
        [req.session.memberId, 'investment_purchase', 'Investment package purchased',
          'Your ' + pkg.name + ' package purchase was recorded. Package price: ' + principal + ' ' + pkg.currency +
          '; 1% fee: ' + fee + ' ' + pkg.currency + '; total wallet deduction: ' + total + ' ' + pkg.currency + '.',
          '/investments', 'investment-purchase:' + created.insertId]
      );
      await conn.commit();
      return res.status(201).json({
        ok: true, alreadyProcessed: false,
        investment: {
          id: Number(created.insertId), reference, packageName: pkg.name, currency: pkg.currency,
          principalAmount: principal, feeAmount: fee, totalCharged: total, status: 'active',
          durationDays: pkg.duration_days
        },
        walletDebit: { currency: walletCurrency, amount: debitAmount.toFixed(8) },
        message: 'Investment purchase recorded successfully.'
      });
    } catch (error) {
      try { await conn.rollback(); } catch (_) {}
      if (error && error.code === 'ER_DUP_ENTRY') {
        try {
          const [[prior]] = await pool.execute(
            'SELECT id,purchase_reference,package_name_snapshot,currency,principal_amount,fee_amount,total_charged,status FROM member_investments WHERE member_id=? AND idempotency_key=? LIMIT 1',
            [req.session.memberId, key]
          );
          if (prior) return res.json({
            ok: true, alreadyProcessed: true,
            investment: {
              id: Number(prior.id), reference: prior.purchase_reference, packageName: prior.package_name_snapshot,
              currency: prior.currency, principalAmount: String(prior.principal_amount),
              feeAmount: String(prior.fee_amount), totalCharged: String(prior.total_charged), status: prior.status
            },
            message: 'This purchase was already processed. Your wallet was not charged again.'
          });
        } catch (_) {}
      }
      if (error && (error.code === 'ER_NO_SUCH_TABLE' || error.code === 'ER_BAD_FIELD_ERROR')) {
        return res.status(503).json({ error: 'investment_setup_required', message: 'Investment records are not configured yet. No financial action was completed.' });
      }
      return next(error);
    } finally {
      conn.release();
    }
  });

  // Native KYC status and referral history use the signed-in mobile session.
  router.get('/kyc/status', noStore, apiAuth, async (req, res, next) => {
    try {
      const [rows] = await pool.execute(
        'SELECT status, reviewer_note, submitted_at FROM kyc_submissions WHERE member_id=? ORDER BY submitted_at DESC,id DESC LIMIT 1',
        [req.session.memberId]
      );
      const row = rows[0] || null;
      return res.set('Cache-Control', 'no-store, private').json({
        status: row ? String(row.status || 'pending').trim().toLowerCase() : 'not_submitted',
        reviewerNote: row && row.reviewer_note ? String(row.reviewer_note) : '',
        submittedAt: row && row.submitted_at ? row.submitted_at : null,
        canResubmit: Boolean(row && ['rejected', 'needs_resubmission'].includes(String(row.status || '').trim().toLowerCase()))
      });
    } catch (error) {
      if (error && error.code === 'ER_NO_SUCH_TABLE') return res.status(503).json({ error: 'kyc_setup_required', message: 'Identity verification records are not available yet.' });
      return next(error);
    }
  });

  router.get('/referrals', noStore, apiAuth, async (req, res, next) => {
    try {
      const [[member]] = await pool.execute('SELECT monarch_uid FROM members WHERE id=? LIMIT 1', [req.session.memberId]);
      if (!member) return res.status(401).json({ error: 'account_not_found', message: 'Please sign in again.' });
      const [[count]] = await pool.execute('SELECT COUNT(*) AS total FROM members WHERE referred_by=?', [req.session.memberId]);
      const [rows] = await pool.execute(
        'SELECT full_name, username, monarch_uid, created_at FROM members WHERE referred_by=? ORDER BY created_at DESC LIMIT 100',
        [req.session.memberId]
      );
      const base = String(appBaseUrl || 'https://monarchcodex.online').replace(/\/+$/, '');
      return res.set('Cache-Control', 'no-store, private').json({
        referralCount: Number(count && count.total) || 0,
        referralLink: base + '/register?ref=' + encodeURIComponent(member.monarch_uid),
        referrals: rows.map(row => ({
          fullName: row.full_name || row.username || 'Monarch member',
          username: row.username || '',
          monarchId: row.monarch_uid || '',
          joinedAt: row.created_at || null
        }))
      });
    } catch (error) {
      if (error && error.code === 'ER_NO_SUCH_TABLE') return res.status(503).json({ error: 'referrals_setup_required', message: 'Referral records are not available yet.' });
      return next(error);
    }
  });

  router.get('/wallet/balances', noStore, apiAuth, async (req, res, next) => {
    try {
      const [rows] = await pool.execute('SELECT currency,balance FROM member_wallets WHERE member_id=?', [req.session.memberId]);
      let actualNgn = 0, actualUsd = 0;
      for (const row of rows) { if (row.currency === 'NGN') actualNgn = Number(row.balance) || 0; if (row.currency === 'USD') actualUsd = Number(row.balance) || 0; }
      const [[fx]] = await pool.query('SELECT base_usd_ngn_rate,markup_percent FROM deposit_pricing_settings WHERE id=1');
      const rate = fx && Number(fx.base_usd_ngn_rate) > 0 ? Number(fx.base_usd_ngn_rate) * (1 + Number(fx.markup_percent || 0) / 100) : null;
      const ngn = actualNgn + (rate ? actualUsd * rate : 0);
      const usd = actualUsd + (rate ? actualNgn / rate : 0);
      return res.json({ ngn, usd, actualNgn, actualUsd, rate });
    } catch (error) {
      if (error && error.code === 'ER_NO_SUCH_TABLE') return res.status(503).json({ error: 'database_setup_required', message: 'Wallet data is not configured yet.' });
      next(error);
    }
  });
  router.get('/wallet/recipient/:uid', noStore, apiAuth, async (req, res, next) => {
    try {
      const uid = String(req.params.uid || '').trim().toUpperCase();
      if (!/^MONARCH\d{6}$/.test(uid)) return res.status(400).json({ error: 'invalid_uid', message: 'Enter a valid Monarch UID.' });
      const [[recipient]] = await pool.execute('SELECT monarch_uid,full_name,is_blocked,email_verified_at FROM members WHERE monarch_uid=? LIMIT 1', [uid]);
      if (!recipient || Number(recipient.is_blocked) === 1 || !recipient.email_verified_at) return res.status(404).json({ error: 'recipient_unavailable', message: 'No eligible verified member was found for that UID.' });
      const [[kyc]] = await pool.execute("SELECT id FROM kyc_submissions WHERE member_id=(SELECT id FROM members WHERE monarch_uid=? LIMIT 1) AND status='approved' ORDER BY submitted_at DESC,id DESC LIMIT 1", [uid]);
      if (!kyc) return res.status(403).json({ error: 'recipient_verification_required', message: 'The recipient must complete account verification before receiving wallet transfers.' });
      const current = await memberById(req.session.memberId);
      if (current && String(uid) === String(current.uid || '').toUpperCase()) return res.status(400).json({ error: 'self_transfer', message: 'That is your own UID.' });
      return res.set('Cache-Control','no-store').json({ uid: recipient.monarch_uid, name: recipient.full_name });
    } catch (error) { next(error); }
  });

  router.post('/wallet/transfer', noStore, apiAuth, requireApprovedKycApi, async (req, res, next) => {
    const contentType = String(req.get('content-type') || '').toLowerCase();
    if (!contentType.includes('application/json')) return res.status(415).json({ error: 'json_required', message: 'Send the transfer request as JSON.' });
    const recipientUid = String(req.body.recipientUid || req.body.monarchUid || '').trim().toUpperCase();
    const currency = String(req.body.currency || '').trim().toUpperCase();
    const amountText = String(req.body.amount || '').trim();
    const idempotencyKey = String(req.body.idempotencyKey || '').trim();
    if (!/^MONARCH\\d{6}$/.test(recipientUid) || !['NGN','USD'].includes(currency) ||
        !/^(?:0|[1-9]\\d{0,11})(?:\\.\\d{1,8})?$/.test(amountText) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey)) {
      return res.status(400).json({ error: 'invalid_transfer', message: 'Enter a valid recipient UID, currency, amount and transfer request key.' });
    }
    const amount = Number(amountText);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000000000) return res.status(400).json({ error: 'invalid_amount', message: 'Enter a valid transfer amount greater than zero.' });
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [[prior]] = await connection.execute('SELECT reference,recipient_member_id,currency,amount FROM member_wallet_transfers WHERE sender_member_id=? AND idempotency_key=? LIMIT 1 FOR UPDATE', [req.session.memberId,idempotencyKey]);
      if (prior) {
        const [[priorRecipient]] = await connection.execute('SELECT id FROM members WHERE monarch_uid=? LIMIT 1', [recipientUid]);
        if (Number(prior.recipient_member_id) !== Number(priorRecipient && priorRecipient.id) || String(prior.currency) !== currency || Math.abs(Number(prior.amount)-amount)>0.00000001) {
          await connection.rollback();
          return res.status(409).json({ error: 'idempotency_conflict', message: 'This transfer key was already used for a different request. Refresh and try again.' });
        }
        await connection.commit();
        return res.json({ ok: true, alreadyProcessed: true, reference: prior.reference, currency: prior.currency, amount: String(prior.amount), message: 'This transfer was already completed. Your wallet was not charged again.' });
      }
      const [[recipient]] = await connection.execute('SELECT id,monarch_uid,full_name,is_blocked,email_verified_at FROM members WHERE monarch_uid=? LIMIT 1 FOR UPDATE', [recipientUid]);
      if (!recipient || Number(recipient.is_blocked) === 1 || !recipient.email_verified_at) {
        await connection.rollback();
        return res.status(404).json({ error: 'recipient_unavailable', message: 'No eligible recipient was found for that Monarch UID.' });
      }
      if (Number(recipient.id) === Number(req.session.memberId)) {
        await connection.rollback();
        return res.status(400).json({ error: 'self_transfer', message: 'Choose another member. You cannot transfer funds to your own UID.' });
      }
      const [[recipientKyc]] = await connection.execute("SELECT id FROM kyc_submissions WHERE member_id=? AND status='approved' ORDER BY submitted_at DESC,id DESC LIMIT 1", [recipient.id]);
      if (!recipientKyc) {
        await connection.rollback();
        return res.status(403).json({ error: 'recipient_verification_required', message: 'The recipient must complete account verification before receiving wallet transfers.' });
      }
      const [[fx]] = await connection.execute('SELECT base_usd_ngn_rate,markup_percent FROM deposit_pricing_settings WHERE id=1');
      const rate = fx && Number(fx.base_usd_ngn_rate) > 0 ? Number(fx.base_usd_ngn_rate) * (1 + Number(fx.markup_percent || 0) / 100) : 0;
      await connection.execute('INSERT IGNORE INTO member_wallets (member_id,currency,balance) VALUES (?,?,0),(?,?,0),(?,?,0)', [req.session.memberId,'NGN',req.session.memberId,'USD',recipient.id,currency]);
      const [walletRows] = await connection.execute('SELECT id,member_id,currency,balance FROM member_wallets WHERE (member_id=? OR member_id=?) AND (currency=? OR currency=?) ORDER BY member_id,currency FOR UPDATE', [req.session.memberId,recipient.id,'NGN','USD']);
      const senderWallets = new Map(walletRows.filter(row => Number(row.member_id) === Number(req.session.memberId)).map(row => [String(row.currency),row]));
      const recipientWallet = walletRows.find(row => Number(row.member_id) === Number(recipient.id) && String(row.currency) === currency);
      if (!senderWallets.has('NGN') || !senderWallets.has('USD') || !recipientWallet) {
        await connection.rollback();
        return res.status(503).json({ error: 'wallet_unavailable', message: 'A required wallet is not available. No funds were moved.' });
      }
      const native = senderWallets.get(currency);
      const otherCurrency = currency === 'NGN' ? 'USD' : 'NGN';
      const other = senderWallets.get(otherCurrency);
      const nativeBalance = Math.max(0, Number(native.balance) || 0);
      const nativeDebit = Math.min(nativeBalance, amount);
      const shortage = Math.max(0, amount - nativeDebit);
      let otherDebit = 0;
      if (shortage > 0) {
        if (!(rate > 0)) {
          await connection.rollback();
          return res.status(503).json({ error: 'fx_rate_unavailable', message: 'Currency conversion is temporarily unavailable. No funds were moved.' });
        }
        const rawOther = currency === 'NGN' ? shortage / rate : shortage * rate;
        otherDebit = Math.ceil((rawOther - 1e-10) * 1e8) / 1e8;
      }
      if (otherDebit > (Number(other.balance) || 0) + 1e-8) {
        await connection.rollback();
        return res.status(409).json({ error: 'insufficient_balance', message: 'Your combined wallet balance is not enough for this transfer at the current conversion rate.' });
      }
      const debits = [];
      for (const [wallet, debitAmount] of [[native,nativeDebit],[other,otherDebit]]) {
        if (debitAmount <= 0) continue;
        const [debit] = await connection.execute('UPDATE member_wallets SET balance=balance-? WHERE id=? AND balance>=?', [debitAmount,wallet.id,debitAmount]);
        if (debit.affectedRows !== 1) {
          await connection.rollback();
          return res.status(409).json({ error: 'insufficient_balance', message: 'Your available balance changed. Refresh and try again.' });
        }
        const [tx] = await connection.execute('INSERT INTO financial_transactions (member_id,deposit_request_id,transaction_type,currency,amount,reference) VALUES (?,NULL,?,?,?,?)', [req.session.memberId,'wallet_transfer_sent',wallet.currency,-debitAmount,'MCT-'+crypto.randomUUID().replace(/-/g,'').toUpperCase()+'-S']);
        debits.push({ wallet, amount: debitAmount, transactionId: tx.insertId });
      }
      await connection.execute('UPDATE member_wallets SET balance=balance+? WHERE id=?', [amount,recipientWallet.id]);
      const reference = 'MCT-' + crypto.randomUUID().replace(/-/g,'').toUpperCase();
      const [recipientTx] = await connection.execute('INSERT INTO financial_transactions (member_id,deposit_request_id,transaction_type,currency,amount,reference) VALUES (?,NULL,?,?,?,?)', [recipient.id,'wallet_transfer_received',currency,amount,reference+'-R']);
      const [transfer] = await connection.execute('INSERT INTO member_wallet_transfers (sender_member_id,recipient_member_id,currency,amount,reference,idempotency_key,sender_transaction_id,recipient_transaction_id) VALUES (?,?,?,?,?,?,?,?)', [req.session.memberId,recipient.id,currency,amount,reference,idempotencyKey,debits[0].transactionId,recipientTx.insertId]);
      for (const debit of debits) {
        await connection.execute('INSERT INTO member_wallet_transfer_debits (transfer_id,sender_transaction_id,source_currency,source_amount,target_currency,target_amount,rate_used) VALUES (?,?,?,?,?,?,?)', [transfer.insertId,debit.transactionId,debit.wallet.currency,debit.amount,currency,debit.wallet.currency===currency?debit.amount:(currency==='NGN'?debit.amount*rate:debit.amount/rate),rate || null]);
      }
      try {
        await connection.execute('INSERT INTO member_notifications (member_id,notification_type,title,body,target_url,dedupe_key) VALUES (?,?,?,?,?,?),(?,?,?,?,?,?)', [
          req.session.memberId,'wallet_transfer','Transfer sent','You sent '+currency+' '+amount.toFixed(2)+' to '+recipient.full_name+' ('+recipient.monarch_uid+'). The debit may use both wallets at the configured conversion rate.','/transactions','wallet-transfer-sent:'+reference,
          recipient.id,'wallet_transfer','Wallet transfer received','You received '+currency+' '+amount.toFixed(2)+' from a Monarch Codex member.','/transactions','wallet-transfer-received:'+reference
        ]);
      } catch (notificationError) { if (notificationError.code !== 'ER_NO_SUCH_TABLE') throw notificationError; }
      const [remainingRows] = await connection.execute('SELECT currency,balance FROM member_wallets WHERE member_id=?', [req.session.memberId]);
      const remaining = Object.fromEntries(remainingRows.map(row => [String(row.currency), Number(row.balance) || 0]));
      await connection.commit();
      return res.status(201).json({ ok: true, reference, recipient: { uid: recipient.monarch_uid, name: recipient.full_name }, currency, amount: amount.toFixed(8), balances: remaining, rate: rate || null, message: 'Transfer completed successfully.' });
    } catch (error) {
      try { await connection.rollback(); } catch (_) {}
      if (error && error.code === 'ER_NO_SUCH_TABLE') return res.status(503).json({ error: 'transfer_setup_required', message: 'Member transfers are not configured yet. Apply migrations/024_member_wallet_transfers.sql and migrations/025_combined_wallet_transfers.sql after the existing wallet migrations.' });
      if (error && error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'duplicate_transfer', message: 'This transfer request has already been processed. Refresh your transaction history.' });
      return next(error);
    } finally { connection.release(); }
  });


  // Native transaction APIs reuse the same database ledger and review queues as the website.
  // They never credit a wallet merely because a member submits a request.

  const requireMobileAdmin = async (req, res, next) => {
    try {
      const [rows] = await pool.execute('SELECT role FROM admin_users WHERE member_id=? AND is_active=1 LIMIT 1', [req.session.memberId]);
      if (!rows.length) return res.status(403).json({ error: 'admin_required', message: 'Administrator access is required.' });
      req.mobileAdminRole = rows[0].role;
      return next();
    } catch (error) {
      if (error && error.code === 'ER_NO_SUCH_TABLE') return res.status(503).json({ error: 'admin_setup_required', message: 'Administrator access is not configured.' });
      return next(error);
    }
  };


  const requireCategoryAccess = (categoryValue, actionValue) => async (req,res,next) => {
    try {
      const [[admin]]=await pool.execute('SELECT role FROM admin_users WHERE member_id=? AND is_active=1 LIMIT 1',[req.session.memberId]);
      if(!admin)return res.status(403).json({error:'admin_required',message:'Administrator access is required.'});
      req.mobileAdminRole=admin.role;
      if(String(admin.role)==='super_admin')return next();
      const category=typeof categoryValue==='function'?categoryValue(req):categoryValue;
      const action=typeof actionValue==='function'?actionValue(req):actionValue;
      const [[permission]]=await pool.execute('SELECT access_level,allowed_actions FROM platform_admin_permissions WHERE admin_member_id=? AND category_key=? LIMIT 1',[req.session.memberId,category]);
      if(!permission)return res.status(403).json({error:'category_access_denied',category,action,message:'The Super Admin has not granted access to this category.'});
      if(permission.access_level==='green')return next();
      if(permission.access_level==='red')return res.status(403).json({error:'category_access_denied',category,action,message:'Your permission level does not allow this action.'});
      let allowed=[];
      try{allowed=Array.isArray(permission.allowed_actions)?permission.allowed_actions:JSON.parse(permission.allowed_actions||'[]');}catch(_){}
      if(!allowed.includes(action))return res.status(403).json({error:'action_access_denied',category,action,message:'This action is not included in your partial-access permissions.'});
      return next();
    }catch(error){
      if(error&&error.code==='ER_NO_SUCH_TABLE')return res.status(503).json({error:'permission_setup_required',message:'Administrator permissions are not configured yet.'});
      return next(error);
    }
  };

  router.get('/transactions', noStore, apiAuth, async (req, res, next) => {
    try {
      const [transactions] = await pool.execute(
        'SELECT id,transaction_type,currency,amount,reference,created_at FROM financial_transactions WHERE member_id=? ORDER BY created_at DESC LIMIT 100',
        [req.session.memberId]
      );
      const [deposits] = await pool.execute(
        'SELECT d.id,d.currency,d.amount,d.fee_amount,d.total_due,d.payment_reference AS reference,d.status,d.created_at,d.reviewer_note,p.label AS payment_label FROM deposit_requests d JOIN deposit_payment_methods p ON p.id=d.payment_method_id WHERE d.member_id=? ORDER BY d.created_at DESC LIMIT 100',
        [req.session.memberId]
      );
      let withdrawals = [];
      try {
        const [rows] = await pool.execute(
          'SELECT id,currency,amount,status,created_at,reviewer_note FROM withdrawal_requests WHERE member_id=? ORDER BY created_at DESC LIMIT 100',
          [req.session.memberId]
        );
        withdrawals = rows;
      } catch (error) { if (error.code !== 'ER_NO_SUCH_TABLE') throw error; }
      return res.json({ transactions, deposits, withdrawals });
    } catch (error) {
      if (error && error.code === 'ER_NO_SUCH_TABLE') return res.status(503).json({ error: 'transactions_setup_required', message: 'Transaction history is temporarily unavailable. No records were changed.' });
      return next(error);
    }
  });

  router.get('/deposit/options', noStore, apiAuth, async (req, res, next) => {
    try {
      const [[pricing]] = await pool.query('SELECT base_usd_ngn_rate,markup_percent,bank_fee_usd,wallet_fee_usd FROM deposit_pricing_settings WHERE id=1');
      const [methods] = await pool.execute(
        "SELECT id,method_type,currency,label,bank_name,account_name,account_number,bank_code,wallet_network,wallet_asset,wallet_address,instructions FROM deposit_payment_methods WHERE is_active=1 ORDER BY currency,method_type,id"
      );
      return res.json({
        methods,
        pricing: pricing ? {
          baseRate: Number(pricing.base_usd_ngn_rate) || null,
          markupPercent: Number(pricing.markup_percent) || 0,
          bankFeeUsd: Number(pricing.bank_fee_usd) || 0,
          walletFeeUsd: Number(pricing.wallet_fee_usd) || 0
        } : null
      });
    } catch (error) {
      if (error && error.code === 'ER_NO_SUCH_TABLE') return res.status(503).json({ error: 'deposit_setup_required', message: 'Deposit options are not configured yet.' });
      return next(error);
    }
  });

  router.post('/deposit/requests', noStore, apiAuth, requireApprovedKycApi, (req, res, next) => {
    if (!depositProofUpload || typeof depositProofUpload.single !== 'function') {
      return res.status(503).json({ error: 'deposit_upload_unavailable', message: 'Receipt upload is temporarily unavailable. No request was created.' });
    }
    return depositProofUpload.single('payment_proof')(req, res, error => {
      if (error) return res.status(400).json({ error: 'invalid_payment_proof', message: error.message || 'Choose a supported receipt under 5 MB.' });
      next();
    });
  }, async (req, res, next) => {
    const currency = String(req.body.currency || '').toUpperCase();
    const methodId = String(req.body.payment_method_id || '');
    const reference = String(req.body.payment_reference || '').trim().slice(0, 190);
    const note = String(req.body.member_note || '').trim().slice(0, 1000);
    const amount = Number(req.body.amount);
    if (!['NGN', 'USD'].includes(currency) || !/^\d{1,20}$/.test(methodId) || !Number.isFinite(amount) || amount <= 0 || amount > 1000000000 || !reference || !req.file) {
      if (req.file && req.file.path) require('node:fs').unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'invalid_deposit', message: 'Enter a valid amount, select a payment destination, provide the transfer reference and attach the payment receipt.' });
    }
    try {
      const [[pricing]] = await pool.query('SELECT base_usd_ngn_rate,markup_percent,bank_fee_usd,wallet_fee_usd FROM deposit_pricing_settings WHERE id=1');
      if (!pricing || Number(pricing.base_usd_ngn_rate) <= 0) {
        if (req.file.path) require('node:fs').unlink(req.file.path, () => {});
        return res.status(503).json({ error: 'deposit_pricing_unavailable', message: 'Deposits are temporarily unavailable because the exchange rate is not configured.' });
      }
      const [[method]] = await pool.execute('SELECT id,method_type,currency,is_active FROM deposit_payment_methods WHERE id=? LIMIT 1', [methodId]);
      if (!method || !Number(method.is_active) || method.currency !== currency || (method.method_type === 'wallet' && currency !== 'USD')) {
        if (req.file.path) require('node:fs').unlink(req.file.path, () => {});
        return res.status(400).json({ error: 'payment_method_unavailable', message: 'Choose an active payment destination for the selected currency.' });
      }
      const base = Number(pricing.base_usd_ngn_rate);
      const rate = base * (1 + Number(pricing.markup_percent || 0) / 100);
      const feeUsd = method.method_type === 'wallet' ? Number(pricing.wallet_fee_usd) : Number(pricing.bank_fee_usd);
      const fee = currency === 'NGN' ? feeUsd * rate : feeUsd;
      const total = amount + fee;
      const [result] = await pool.execute(
        'INSERT INTO deposit_requests (member_id,currency,amount,fee_usd,fee_amount,base_usd_ngn_rate,effective_usd_ngn_rate,total_due,payment_method_id,payment_reference,proof_storage_key,proof_mime_type,proof_original_name,member_note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [req.session.memberId,currency,amount,feeUsd,fee,base,rate,total,methodId,reference,req.file.filename,req.file.mimetype,require('node:path').basename(req.file.originalname).slice(0,255),note || null]
      );
      await notifyActiveAdmins({type:'deposit_pending',title:'Deposit awaiting review',body:'A member submitted a deposit receipt for administrator review.',targetUrl:'/admin/deposits',dedupePrefix:'deposit_pending_'+result.insertId});
      return res.status(201).json({ ok: true, requestId: result.insertId, status: 'pending', message: 'Deposit receipt submitted. Your balance will change only after an administrator verifies the payment.' });
    } catch (error) {
      if (req.file && req.file.path) require('node:fs').unlink(req.file.path, () => {});
      if (error && error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'duplicate_reference', message: 'This payment reference has already been submitted for your account.' });
      if (error && error.code === 'ER_NO_SUCH_TABLE') return res.status(503).json({ error: 'deposit_setup_required', message: 'Deposits are temporarily unavailable. No wallet balance was changed.' });
      return next(error);
    }
  });

  router.get('/withdrawal/options', noStore, apiAuth, requireApprovedKycApi, async (req, res, next) => {
    try {
      const [bankRows] = await pool.execute('SELECT id,details_ciphertext FROM member_bank_accounts WHERE member_id=? AND deleted_at IS NULL ORDER BY id DESC', [req.session.memberId]);
      if (typeof decryptProfileValue !== 'function') return res.status(503).json({ error: 'payout_details_unavailable', message: 'Saved payout account details are temporarily unavailable.' });
      const accounts = bankRows.map(row => {
        try { return { id: row.id, ...JSON.parse(decryptProfileValue(row.details_ciphertext)) }; }
        catch (_) { return { id: row.id, label: 'Saved payout account' }; }
      });
      const [walletRows] = await pool.execute('SELECT currency,balance FROM member_wallets WHERE member_id=?', [req.session.memberId]);
      const [reservedRows] = await pool.execute("SELECT currency,COALESCE(SUM(amount),0) AS reserved FROM withdrawal_requests WHERE member_id=? AND status IN ('pending','approved') GROUP BY currency", [req.session.memberId]);
      const balances = { NGN: 0, USD: 0 }, reserved = { NGN: 0, USD: 0 };
      for (const row of walletRows) if (Object.prototype.hasOwnProperty.call(balances, row.currency)) balances[row.currency] = Number(row.balance) || 0;
      for (const row of reservedRows) if (Object.prototype.hasOwnProperty.call(reserved, row.currency)) reserved[row.currency] = Number(row.reserved) || 0;
      return res.json({ accounts, balances, reserved, available: { NGN: Math.max(0, balances.NGN-reserved.NGN), USD: Math.max(0, balances.USD-reserved.USD) } });
    } catch (error) {
      if (error && error.code === 'ER_NO_SUCH_TABLE') return res.status(503).json({ error: 'withdrawal_setup_required', message: 'Withdrawal requests are not configured yet.' });
      return next(error);
    }
  });

  router.post('/withdrawal/requests', noStore, apiAuth, requireApprovedKycApi, async (req, res, next) => {
    const currency = String(req.body.currency || '').toUpperCase();
    const bankId = String(req.body.bank_account_id || '');
    const amountText = String(req.body.amount || '').trim();
    const note = String(req.body.member_note || '').trim().slice(0, 500);
    if (!['NGN','USD'].includes(currency) || !/^\d{1,20}$/.test(bankId) || !/^\d{1,12}(?:\.\d{1,8})?$/.test(amountText)) return res.status(400).json({ error: 'invalid_withdrawal', message: 'Choose a saved payout account, currency and valid amount.' });
    const amount = Number(amountText);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000000000) return res.status(400).json({ error: 'invalid_amount', message: 'Enter a positive amount within your available balance.' });
    let connection;
    try {
      const [[kyc]] = await pool.execute("SELECT status FROM kyc_submissions WHERE member_id=? ORDER BY submitted_at DESC,id DESC LIMIT 1", [req.session.memberId]);
      if (!kyc || String(kyc.status || '').trim().toLowerCase() !== 'approved') return res.status(403).json({ error: 'kyc_required', message: 'Withdrawal requests unlock only after your identity verification is approved.' });
      connection = await pool.getConnection();
      await connection.beginTransaction();
      const [[bank]] = await connection.execute('SELECT id,details_ciphertext FROM member_bank_accounts WHERE id=? AND member_id=? AND deleted_at IS NULL LIMIT 1 FOR UPDATE', [bankId,req.session.memberId]);
      if (!bank) { await connection.rollback(); return res.status(400).json({ error: 'payout_account_unavailable', message: 'Choose one of your active saved payout accounts.' }); }
      const [[wallet]] = await connection.execute('SELECT id,balance FROM member_wallets WHERE member_id=? AND currency=? LIMIT 1 FOR UPDATE', [req.session.memberId,currency]);
      const [[reserved]] = await connection.execute("SELECT COALESCE(SUM(amount),0) AS total FROM withdrawal_requests WHERE member_id=? AND currency=? AND status IN ('pending','approved')", [req.session.memberId,currency]);
      const available = Math.max(0,(wallet ? Number(wallet.balance) : 0)-(reserved ? Number(reserved.total) : 0));
      if (amount > available + 1e-8) { await connection.rollback(); return res.status(400).json({ error: 'insufficient_available_balance', message: 'The amount exceeds your available balance after pending withdrawal reservations.' }); }
      const [created] = await connection.execute("INSERT INTO withdrawal_requests (member_id,bank_account_id,bank_details_ciphertext,currency,amount,member_note,status) VALUES (?,?,?,?,?,?,'pending')", [req.session.memberId,bank.id,bank.details_ciphertext,currency,amount,note || null]);
      await connection.commit();
      await notifyActiveAdmins({type:'withdrawal_pending',title:'Withdrawal awaiting review',body:'A member submitted a withdrawal request for review.',targetUrl:'/admin/withdrawals',dedupePrefix:'withdrawal_pending_'+created.insertId});
      return res.status(201).json({ ok: true, requestId: created.insertId, status: 'pending', message: 'Withdrawal request submitted for review. This is not an automatic payout.' });
    } catch (error) {
      if (connection) { try { await connection.rollback(); } catch (_) {} }
      if (error && error.code === 'ER_NO_SUCH_TABLE') return res.status(503).json({ error: 'withdrawal_setup_required', message: 'Withdrawals are temporarily unavailable. No request was created.' });
      return next(error);
    } finally { if (connection) connection.release(); }
  });


  const requireMobileFinanceAdmin = async (req,res,next) => {
    try {
      const [[admin]]=await pool.execute('SELECT role FROM admin_users WHERE member_id=? AND is_active=1 LIMIT 1',[req.session.memberId]);
      if(!admin || !['super_admin','main_admin'].includes(String(admin.role))) return res.status(403).json({error:'finance_admin_required',message:'Only Super Admin or Main Admin can review financial requests.'});
      req.mobileAdminRole=admin.role; next();
    } catch(e) { if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).json({error:'admin_setup_required',message:'Administrator access is not configured.'}); next(e); }
  };
  const adminAudit = async (executor,actor,action,targetType,targetId,details,ip) => executor.execute(
    'INSERT INTO admin_audit_log (admin_member_id,action,target_type,target_id,details,ip_address) VALUES (?,?,?,?,?,?)',
    [actor,action,targetType,String(targetId),JSON.stringify(details||{}),ip||null]
  );

  router.get('/admin/reviews/:type', noStore, apiAuth, requireCategoryAccess(req=>req.params.type==='kyc'?'members_roles':'financial_operations','view'), async (req,res,next) => {
    const type=String(req.params.type||'');
    if(!['kyc','deposits','withdrawals'].includes(type))return res.status(400).json({error:'invalid_review_queue'});
    if(type!=='kyc' && !['super_admin','main_admin'].includes(String(req.mobileAdminRole)))return res.status(403).json({error:'finance_admin_required',message:'Only Super Admin or Main Admin can review financial requests.'});
    try {
      let rows=[];
      if(type==='kyc') {
        [rows]=await pool.query("SELECT k.id,k.member_id,k.legal_full_name,k.contact_email,k.document_type,k.document_issuer_country,k.document_number_last4,k.status,k.submitted_at,k.reviewer_note,m.username,m.monarch_uid FROM kyc_submissions k JOIN members m ON m.id=k.member_id WHERE NOT EXISTS (SELECT 1 FROM kyc_submissions newer WHERE newer.member_id=k.member_id AND (newer.submitted_at>k.submitted_at OR (newer.submitted_at=k.submitted_at AND newer.id>k.id))) ORDER BY (k.status='pending') DESC,k.submitted_at DESC,k.id DESC LIMIT 200");
      } else if(type==='deposits') {
        [rows]=await pool.query("SELECT d.id,d.member_id,d.currency,d.amount,d.fee_amount,d.total_due,d.payment_reference,d.status,d.created_at,d.reviewer_note,m.full_name,m.username,m.email,p.label AS payment_label,p.method_type FROM deposit_requests d JOIN members m ON m.id=d.member_id JOIN deposit_payment_methods p ON p.id=d.payment_method_id ORDER BY (d.status='pending') DESC,d.created_at DESC LIMIT 200");
      } else {
        [rows]=await pool.query("SELECT w.id,w.member_id,w.currency,w.amount,w.status,w.created_at,w.reviewer_note,w.payment_reference,w.bank_details_ciphertext,m.full_name,m.username,m.email FROM withdrawal_requests w JOIN members m ON m.id=w.member_id ORDER BY CASE w.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,w.created_at DESC LIMIT 200");
        rows=rows.map(row=>{let bank={};try{bank=JSON.parse(decryptProfileValue(row.bank_details_ciphertext));}catch(_){} const {bank_details_ciphertext,...safe}=row;return {...safe,payoutDestination:{bankName:String(bank.bankName||'Saved bank account'),accountName:String(bank.bankAccountName||bank.accountName||'Account holder'),accountNumber:String(bank.bankAccountNumber||bank.accountNumber||'Unavailable')}};});
      }
      res.json({type,items:rows});
    } catch(e) { if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).json({error:'review_setup_required',message:'The review queue database is not configured.'}); next(e); }
  });

  router.post('/admin/reviews/kyc/:id', noStore, apiAuth, requireCategoryAccess('members_roles',req=>req.body.status==='approved'?'approve':'reject'), async (req,res,next) => {
    const id=String(req.params.id||''), status=String(req.body.status||''), note=String(req.body.note||'').trim().slice(0,1000);
    if(!/^\d{1,20}$/.test(id)||!['approved','rejected','needs_resubmission'].includes(status))return res.status(400).json({error:'invalid_review',message:'Choose a valid KYC decision.'});
    if(status!=='approved'&&!note)return res.status(400).json({error:'review_note_required',message:'Add a reason or instructions for this decision.'});
    const conn=await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [[row]]=await conn.execute('SELECT id,member_id,status FROM kyc_submissions WHERE id=? FOR UPDATE',[id]);
      if(!row){await conn.rollback();return res.status(404).json({error:'not_found',message:'KYC submission not found.'});}
      if(row.status==='approved' || row.status===status){await conn.rollback();return res.status(409).json({error:'already_reviewed',message:'This KYC submission is already approved or has this status.'});}
      await conn.execute('UPDATE kyc_submissions SET status=?,reviewer_member_id=?,reviewer_note=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=?',[status,req.session.memberId,note||null,id]);
      await conn.execute('INSERT INTO kyc_review_events (submission_id,actor_member_id,event_type,note) VALUES (?,?,?,?)',[id,req.session.memberId,status,note||null]);
      await conn.execute('INSERT INTO member_notifications (member_id,notification_type,title,body,target_url,dedupe_key) VALUES (?,?,?,?,?,?)',[row.member_id,'kyc_review','Identity verification '+status.replace('_',' '),'Your KYC submission was '+status.replace('_',' ')+(note?' — '+note:''),'/kyc','kyc_'+id+'_'+status]);
      await adminAudit(conn,req.session.memberId,'kyc.'+status,'kyc_submission',id,{status,note},req.ip);
      await conn.commit();
      return res.json({ok:true,id:Number(id),status,message:'KYC review saved.'});
    } catch(e) { try{await conn.rollback();}catch(_){} if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).json({error:'kyc_setup_required',message:'KYC review tables are not configured.'}); return next(e); }
    finally {conn.release();}
  });

  router.post('/admin/reviews/deposits/:id', noStore, apiAuth, requireCategoryAccess('financial_operations',req=>req.body.decision==='approved'?'approve':'reject'), async (req,res,next) => {
    const id=String(req.params.id||''), decision=String(req.body.decision||''), note=String(req.body.note||'').trim().slice(0,1000);
    if(!/^\d{1,20}$/.test(id)||!['approved','rejected'].includes(decision))return res.status(400).json({error:'invalid_review',message:'Choose approve or reject.'});
    if(req.body.confirmed!==true)return res.status(400).json({error:'confirmation_required',message:'A second confirmation is required for financial actions.'});
    if(decision==='rejected'&&!note)return res.status(400).json({error:'review_note_required',message:'Add a reason before rejecting a deposit.'});
    const conn=await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [[d]]=await conn.execute('SELECT id,member_id,currency,amount,fee_amount,status FROM deposit_requests WHERE id=? FOR UPDATE',[id]);
      if(!d){await conn.rollback();return res.status(404).json({error:'not_found',message:'Deposit request not found.'});}
      if(d.status!=='pending'){await conn.rollback();return res.status(409).json({error:'already_reviewed',message:'This deposit has already been reviewed.'});}
      if(decision==='approved') {
        await conn.execute('INSERT INTO member_wallets (member_id,currency,balance) VALUES (?,?,?) ON DUPLICATE KEY UPDATE balance=balance+VALUES(balance)',[d.member_id,d.currency,d.amount]);
        await conn.execute('INSERT INTO financial_transactions (member_id,deposit_request_id,transaction_type,currency,amount,reference) VALUES (?,?,?,?,?,?)',[d.member_id,d.id,'deposit_credit',d.currency,d.amount,'DEP-'+d.id]);
      }
      await conn.execute('UPDATE deposit_requests SET status=?,reviewer_member_id=?,reviewer_note=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=?',[decision,req.session.memberId,note||null,id]);
      await adminAudit(conn,req.session.memberId,'deposit.'+decision,'deposit_request',id,{currency:d.currency,amount:String(d.amount),note,confirmed:true},req.ip);
      await conn.execute('INSERT INTO member_notifications (member_id,notification_type,title,body,target_url,dedupe_key) VALUES (?,?,?,?,?,?)',[d.member_id,'deposit_review','Deposit '+decision,'Your '+d.currency+' deposit request for '+String(d.amount)+' was '+decision+(note?' — '+note:''),'/transactions','deposit_'+id+'_'+decision]);
      await conn.commit();
      return res.json({ok:true,id:Number(id),status:decision,message:decision==='approved'?'Deposit approved and credited.':'Deposit rejected.'});
    } catch(e) {try{await conn.rollback();}catch(_){} if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).json({error:'deposit_setup_required',message:'Deposit workflow tables are not configured.'}); return next(e);}
    finally{conn.release();}
  });

  router.post('/admin/reviews/withdrawals/:id', noStore, apiAuth, requireCategoryAccess('financial_operations',req=>req.body.decision==='paid'?'manage':req.body.decision==='approved'?'approve':'reject'), async (req,res,next) => {
    const id=String(req.params.id||''),decision=String(req.body.decision||''),note=String(req.body.note||'').trim().slice(0,1000),reference=String(req.body.paymentReference||'').trim().slice(0,190);
    if(!/^\d{1,20}$/.test(id)||!['approved','rejected','paid'].includes(decision))return res.status(400).json({error:'invalid_review',message:'Choose a valid withdrawal decision.'});
    if(req.body.confirmed!==true)return res.status(400).json({error:'confirmation_required',message:'A second confirmation is required for financial actions.'});
    if(decision==='rejected'&&!note)return res.status(400).json({error:'review_note_required',message:'Add a reason before rejecting a withdrawal.'});
    if(decision==='paid'&&!reference)return res.status(400).json({error:'payment_reference_required',message:'Enter the actual completed transfer reference.'});
    const conn=await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [[w]]=await conn.execute('SELECT id,member_id,currency,amount,status FROM withdrawal_requests WHERE id=? FOR UPDATE',[id]);
      if(!w){await conn.rollback();return res.status(404).json({error:'not_found',message:'Withdrawal request not found.'});}
      if(decision==='approved') {
        if(w.status!=='pending'){await conn.rollback();return res.status(409).json({error:'already_reviewed',message:'Only pending withdrawals can be approved.'});}
        await conn.execute("UPDATE withdrawal_requests SET status='approved',reviewer_member_id=?,reviewer_note=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=?",[req.session.memberId,note||null,id]);
      } else if(decision==='rejected') {
        if(!['pending','approved'].includes(w.status)){await conn.rollback();return res.status(409).json({error:'invalid_status',message:'This withdrawal can no longer be rejected.'});}
        await conn.execute("UPDATE withdrawal_requests SET status='rejected',reviewer_member_id=?,reviewer_note=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=?",[req.session.memberId,note,id]);
      } else {
        if(w.status!=='approved'){await conn.rollback();return res.status(409).json({error:'approval_required',message:'Approve the withdrawal before recording payment.'});}
        const [[wallet]]=await conn.execute('SELECT id,balance FROM member_wallets WHERE member_id=? AND currency=? LIMIT 1 FOR UPDATE',[w.member_id,w.currency]);
        if(!wallet||Number(wallet.balance)+1e-8<Number(w.amount)){await conn.rollback();return res.status(409).json({error:'insufficient_balance',message:'The wallet no longer contains enough funds.'});}
        await conn.execute('UPDATE member_wallets SET balance=balance-? WHERE id=?',[w.amount,wallet.id]);
        await conn.execute('INSERT INTO withdrawal_ledger_entries (withdrawal_request_id,member_id,currency,amount,payment_reference) VALUES (?,?,?,?,?)',[w.id,w.member_id,w.currency,w.amount,reference]);
        await conn.execute("UPDATE withdrawal_requests SET status='paid',payment_reference=?,reviewer_member_id=?,reviewer_note=?,reviewed_at=CURRENT_TIMESTAMP,paid_at=CURRENT_TIMESTAMP WHERE id=?",[reference,req.session.memberId,note||null,id]);
      }
      await adminAudit(conn,req.session.memberId,'withdrawal.'+decision,'withdrawal_request',id,{decision,amount:String(w.amount),currency:w.currency,paymentReference:decision==='paid'?reference:null,confirmed:true},req.ip);
      await conn.execute('INSERT INTO member_notifications (member_id,notification_type,title,body,target_url,dedupe_key) VALUES (?,?,?,?,?,?)',[w.member_id,'withdrawal_review','Withdrawal '+decision,'Your '+w.currency+' withdrawal request for '+String(w.amount)+' is now '+decision+(note?' — '+note:''),'/transactions','withdrawal_'+id+'_'+decision]);
      await conn.commit();
      return res.json({ok:true,id:Number(id),status:decision,message:decision==='paid'?'Withdrawal marked paid after transfer confirmation.':'Withdrawal review saved.'});
    } catch(e) {try{await conn.rollback();}catch(_){} if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).json({error:'withdrawal_setup_required',message:'Withdrawal workflow tables are not configured.'}); if(e.code==='ER_DUP_ENTRY')return res.status(409).json({error:'duplicate_payment_reference',message:'That transfer reference has already been used.'}); return next(e);}
    finally{conn.release();}
  });

  router.get('/admin/audit-events', noStore, apiAuth, requireCategoryAccess('security_audit','view'), async (req,res,next) => {
    try {
      const [rows]=await pool.query('SELECT l.action,l.target_type,l.target_id,l.details,l.ip_address,l.created_at,m.username FROM admin_audit_log l JOIN members m ON m.id=l.admin_member_id ORDER BY l.created_at DESC LIMIT 200');
      return res.json({events:rows});
    } catch(e) {if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).json({error:'audit_setup_required',message:'Audit logging is not configured.'});next(e);}
  });
  router.get('/admin/analytics', noStore, apiAuth, requireCategoryAccess('invest_market','view'), async (req,res,next) => {
    try {
      const [[members]]=await pool.query('SELECT COUNT(*) AS total FROM members');
      const [[kyc]]=await pool.query("SELECT COUNT(*) AS total,SUM(status='pending') AS pending,SUM(status='approved') AS approved,SUM(status='rejected') AS rejected FROM kyc_submissions");
      const [[deposits]]=await pool.query("SELECT COUNT(*) AS total,SUM(status='pending') AS pending,COALESCE(SUM(CASE WHEN status='approved' THEN amount ELSE 0 END),0) AS approvedAmount FROM deposit_requests");
      const [[withdrawals]]=await pool.query("SELECT COUNT(*) AS total,SUM(status='pending') AS pending,SUM(status='approved') AS approved,COALESCE(SUM(CASE WHEN status='paid' THEN amount ELSE 0 END),0) AS paidAmount FROM withdrawal_requests");
      return res.json({members:Number(members.total)||0,kyc:{total:Number(kyc.total)||0,pending:Number(kyc.pending)||0,approved:Number(kyc.approved)||0,rejected:Number(kyc.rejected)||0},deposits:{total:Number(deposits.total)||0,pending:Number(deposits.pending)||0,approvedAmount:String(deposits.approvedAmount||0)},withdrawals:{total:Number(withdrawals.total)||0,pending:Number(withdrawals.pending)||0,approved:Number(withdrawals.approved)||0,paidAmount:String(withdrawals.paidAmount||0)}});
    } catch(e) {if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).json({error:'analytics_setup_required',message:'Analytics data tables are not configured.'});next(e);}
  });
  router.get('/admin/security', noStore, apiAuth, requireCategoryAccess('security_audit','view'), async (req,res,next) => {
    try {
      const [admins]=await pool.query('SELECT a.member_id,a.role,a.is_active,a.created_at,m.username,m.full_name FROM admin_users a JOIN members m ON m.id=a.member_id ORDER BY a.created_at DESC LIMIT 100');
      const [events]=await pool.query("SELECT action,target_type,target_id,ip_address,created_at FROM admin_audit_log WHERE action LIKE '%login%' OR action LIKE '%security%' OR action LIKE '%session%' ORDER BY created_at DESC LIMIT 100");
      return res.json({admins,securityEvents:events,session:{authenticated:true,reauthenticationAvailable:false,secondConfirmationRequired:true}});
    } catch(e) {if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).json({error:'security_setup_required',message:'Security records are not configured.'});next(e);}
  });

  // Member management: category permissions gate viewing; destructive actions require Super Admin.
  router.get('/admin/members', noStore, apiAuth, requireCategoryAccess('members_roles','view'), async (req,res,next) => {
    try {
      const q=String(req.query.q||'').trim().slice(0,120);
      // Older production databases may not yet have every optional member-management column.
      // Detect the actual schema so the list remains usable while optional controls default safely.
      const [columnRows]=await pool.query('SHOW COLUMNS FROM members');
      const columns=new Set(columnRows.map(c=>String(c.Field)));
      const requiredColumns=['id','username','email'];
      const missing=requiredColumns.filter(c=>!columns.has(c));
      if(missing.length) return res.status(503).json({error:'member_management_schema_required',message:'Member listing cannot run because required members columns are missing: '+missing.join(', ')+'.'});
      // Older production schemas may not have optional profile and timestamp fields.
      // Use only columns confirmed above so the admin screen can still load safely.
      const uidExpr=columns.has('monarch_uid')?'m.monarch_uid':'NULL';
      const fullNameExpr=columns.has('full_name')?'m.full_name':'m.username';
      const phoneExpr=columns.has('phone')?'m.phone':'NULL';
      const createdExpr=columns.has('created_at')?'m.created_at':'NULL';
      const verifiedExpr=columns.has('email_verified_at')?'m.email_verified_at':'NULL';
      const blockedExpr=columns.has('is_blocked')?'COALESCE(m.is_blocked,0)':'0';
      const searchFields=[];
      if(columns.has('full_name')) searchFields.push('m.full_name');
      searchFields.push('m.username','m.email');
      if(columns.has('monarch_uid')) searchFields.push('m.monarch_uid');
      // Build the filter only when a search term exists. This avoids an unnecessary
      // empty-string placeholder and supports partial matches across all available fields.
      const searchClause=searchFields.map(field=>field+' LIKE ?').join(' OR ');
      const whereClause=q?' WHERE ('+searchClause+')':'';
      const params=q?searchFields.map(()=>'%'+q+'%'):[];
      const [rows]=await pool.execute(
        'SELECT m.id,'+uidExpr+' AS uid,'+fullNameExpr+' AS fullName,m.username,m.email,'+phoneExpr+' AS phone,'+createdExpr+' AS createdAt,'+verifiedExpr+' AS emailVerifiedAt,'+blockedExpr+' AS isBlocked FROM members m'+whereClause+' ORDER BY m.id DESC LIMIT 200',
        params
      );
      return res.json({items:rows});
    } catch(e) { return next(e); }
  });
  router.get('/admin/members/:id', noStore, apiAuth, requireCategoryAccess('members_roles','view'), async (req,res,next) => {
    const id=Number(req.params.id);
    if(!Number.isSafeInteger(id)||id<1)return res.status(400).json({error:'invalid_member_id',message:'Choose a valid member account.'});
    try {
      const [columnRows]=await pool.query('SHOW COLUMNS FROM members');
      const columns=new Set(columnRows.map(c=>String(c.Field)));
      const required=['id','username','email'];
      const missing=required.filter(c=>!columns.has(c));
      if(missing.length)return res.status(503).json({error:'member_management_schema_required',message:'Member details are unavailable because required columns are missing: '+missing.join(', ')+'.'});
      const fullName=columns.has('full_name')?'full_name':'NULL';
      const uid=columns.has('monarch_uid')?'monarch_uid':'NULL';
      const phone=columns.has('phone')?'phone':'NULL';
      const created=columns.has('created_at')?'created_at':'NULL';
      const verified=columns.has('email_verified_at')?'email_verified_at':'NULL';
      const blocked=columns.has('is_blocked')?'COALESCE(is_blocked,0)':'0';
      const [members]=await pool.execute('SELECT id,'+uid+' AS uid,'+fullName+' AS fullName,username,email,'+phone+' AS phone,'+created+' AS createdAt,'+verified+' AS emailVerifiedAt,'+blocked+' AS isBlocked FROM members WHERE id=? LIMIT 1',[id]);
      const member=members[0];
      if(!member)return res.status(404).json({error:'member_not_found',message:'This member account no longer exists.'});
      let wallets=[],kyc=[];
      const [walletTables]=await pool.query("SHOW TABLES LIKE 'member_wallets'");
      if(walletTables.length) {
        const [walletRows]=await pool.execute('SELECT currency,balance FROM member_wallets WHERE member_id=?',[id]);
        wallets=walletRows;
      }
      const [kycTables]=await pool.query("SHOW TABLES LIKE 'kyc_submissions'");
      if(kycTables.length) {
        const [kycRows]=await pool.execute('SELECT status,submitted_at AS submittedAt FROM kyc_submissions WHERE member_id=? ORDER BY id DESC LIMIT 5',[id]);
        kyc=kycRows;
      }
      return res.json({member,wallets,kyc});
    } catch(e) {
      if(e&&e.code==='ER_NO_SUCH_TABLE')return res.status(503).json({error:'member_management_schema_required',message:'Member details are temporarily unavailable because a required database table is not configured.'});
      return next(e);
    }
  });
  router.post('/admin/members/:id/status', noStore, apiAuth, requireSuperAdmin, async (req,res,next) => {
    const id=Number(req.params.id), blocked=req.body.blocked===true || String(req.body.blocked)==='true' || String(req.body.blocked)==='1';
    if(!Number.isSafeInteger(id)||id<1)return res.status(400).json({error:'invalid_member_id',message:'Choose a valid member account.'});
    if(id===Number(req.session.memberId))return res.status(400).json({error:'cannot_block_self',message:'You cannot block or unblock your own account.'});
    try {
      const [[targetAdmin]]=await pool.execute('SELECT member_id FROM admin_users WHERE member_id=? LIMIT 1',[id]);
      if(targetAdmin)return res.status(403).json({error:'protected_admin_account',message:'Administrator accounts cannot be blocked from member management.'});
      const [cols]=await pool.query('SHOW COLUMNS FROM members');
      const columns=new Set(cols.map(c=>String(c.Field)));
      if(!columns.has('is_blocked'))return res.status(503).json({error:'member_management_schema_required',message:'Account blocking is not configured in the production database. Apply and verify migrations/015_member_account_controls.sql after a database backup.'});
      const updates=['is_blocked=?'],params=[blocked?1:0];
      if(columns.has('blocked_at')){updates.push('blocked_at=?');params.push(blocked?new Date():null);}
      if(columns.has('blocked_by')){updates.push('blocked_by=?');params.push(blocked?Number(req.session.memberId):null);}
      if(columns.has('block_reason')){updates.push('block_reason=?');params.push(blocked?String(req.body.reason||'').trim().slice(0,500)||null:null);}
      params.push(id);
      const [result]=await pool.execute('UPDATE members SET '+updates.join(',')+' WHERE id=?',params);
      if(!result.affectedRows)return res.status(404).json({error:'member_not_found',message:'This member account no longer exists.'});
      await adminAudit(pool,req.session.memberId,blocked?'member.blocked':'member.unblocked','member',id,{blocked},req.ip);
      return res.json({ok:true,blocked,message:blocked?'Member access has been blocked.':'Member access has been restored.'});
    } catch(e) { if(e&&e.code==='ER_NO_SUCH_TABLE')return res.status(503).json({error:'member_management_schema_required',message:'Administrator or account-control tables are not configured.'}); return next(e); }
  });
  router.delete('/admin/members/:id', noStore, apiAuth, requireSuperAdmin, async (req,res,next) => {
    const id=Number(req.params.id);
    if(!Number.isSafeInteger(id)||id<1)return res.status(400).json({error:'invalid_member_id',message:'Choose a valid member account.'});
    if(id===Number(req.session.memberId))return res.status(400).json({error:'cannot_delete_self',message:'You cannot delete your own account.'});
    let conn;
    try {
      conn=await pool.getConnection();
      await conn.beginTransaction();
      const [[member]]=await conn.execute('SELECT id,username,email FROM members WHERE id=? LIMIT 1 FOR UPDATE',[id]);
      if(!member){await conn.rollback();return res.status(404).json({error:'member_not_found',message:'This member account no longer exists.'});}
      const [[targetAdmin]]=await conn.execute('SELECT member_id FROM admin_users WHERE member_id=? LIMIT 1',[id]);
      if(targetAdmin){await conn.rollback();return res.status(403).json({error:'protected_admin_account',message:'Administrator accounts cannot be deleted through member management.'});}
      // Remove only records owned by this member (member_id), not records they
      // authored or reviewed for other members. Keep the operation transactional.
      const [ownedTables]=await conn.query("SELECT DISTINCT TABLE_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND COLUMN_NAME='member_id' AND TABLE_NAME NOT IN ('members','admin_users')");
      for(const row of ownedTables){
        const table=String(row.TABLE_NAME||'');
        if(!/^[a-zA-Z0-9_]+$/.test(table))continue;
        await conn.execute('DELETE FROM `'+table+'` WHERE member_id=?',[id]);
      }
      await conn.execute('INSERT INTO admin_audit_log (admin_member_id,action,target_type,target_id,details,ip_address) VALUES (?,?,?,?,?,?)',[req.session.memberId,'member.deleted','member',String(id),JSON.stringify({username:member.username,email:member.email}),req.ip||null]);
      await conn.execute('DELETE FROM members WHERE id=?',[id]);
      await conn.commit();
      return res.json({ok:true,message:'Member account and member-owned records were deleted.'});
    } catch(e) {
      if(conn)try{await conn.rollback();}catch(_){}
      if(e&&e.code==='ER_NO_SUCH_TABLE')return res.status(503).json({error:'member_management_schema_required',message:'The account-deletion audit or database schema is not configured. No account deletion was committed.'});
      if(e&&e.code==='ER_ROW_IS_REFERENCED_2')return res.status(409).json({error:'member_has_protected_records',message:'The database has protected records linked to this account. No deletion was committed; review those relationships before retrying.'});
      return next(e);
    } finally { if(conn)conn.release(); }
  });

  router.get('/admin/overview', noStore, apiAuth, requireCategoryAccess('members_roles','view'), async (req, res, next) => {
    try {
      const [[members]] = await pool.query('SELECT COUNT(*) AS total FROM members');
      const [[pendingKyc]] = await pool.query("SELECT COUNT(*) AS total FROM kyc_submissions WHERE status='pending'");
      const [[pendingDeposits]] = await pool.query("SELECT COUNT(*) AS total FROM deposit_requests WHERE status='pending'");
      let pendingWithdrawals = 0;
      try { const [[w]] = await pool.query("SELECT COUNT(*) AS total FROM withdrawal_requests WHERE status IN ('pending','approved')"); pendingWithdrawals = Number(w.total) || 0; }
      catch (error) { if (error.code !== 'ER_NO_SUCH_TABLE') throw error; }
      return res.json({ role: req.mobileAdminRole, members: Number(members.total)||0, pendingKyc: Number(pendingKyc.total)||0, pendingDeposits: Number(pendingDeposits.total)||0, pendingWithdrawals });
    } catch (error) {
      if (error && error.code === 'ER_NO_SUCH_TABLE') return res.status(503).json({ error: 'admin_dashboard_setup_required', message: 'An administrator dashboard data source is not configured.' });
      return next(error);
    }
  });


  const requireRoleTables = async () => {
    const [tables] = await pool.query("SHOW TABLES LIKE 'member_role_catalog'");
    if (!tables.length) { const e = new Error('Apply migrations/018_member_role_management.sql before using role management.'); e.code = 'ROLE_MIGRATION_REQUIRED'; throw e; }
  };
  const roleAdmin = async (req, res, next) => {
    try {
      const [[admin]] = await pool.execute('SELECT role FROM admin_users WHERE member_id=? AND is_active=1 LIMIT 1', [req.session.memberId]);
      if (!admin || !['super_admin','main_admin'].includes(String(admin.role))) return res.status(403).json({ error:'forbidden', message:'Only authorised Monarch Codex administrators can manage member roles.' });
      req.adminRole = admin.role; next();
    } catch (e) { next(e); }
  };
  const roleKey = value => String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0,80);

  router.get('/profile', noStore, apiAuth, async (req,res,next) => {
    try {
      const [rows] = await pool.execute('SELECT id,monarch_uid,full_name,email,phone,username,email_verified_at FROM members WHERE id=? LIMIT 1',[req.session.memberId]);
      if (!rows.length) return res.status(404).json({error:'member_not_found'});
      let profile = {};
      try { const [p] = await pool.execute('SELECT phone_number,avatar_key FROM member_profiles WHERE member_id=? LIMIT 1',[req.session.memberId]); profile = p[0] || {}; }
      catch (e) { if (e.code !== 'ER_NO_SUCH_TABLE') throw e; }
      res.json({ member: { ...publicMember(rows[0]), phone: profile.phone_number || rows[0].phone || '', profilePhotoUrl:'/member-avatar-current' } });
    } catch (e) { next(e); }
  });

  router.put('/profile', noStore, apiAuth, async (req,res,next) => {
    try {
      const fullName=String(req.body.fullName||'').trim(), username=String(req.body.username||'').trim(), email=String(req.body.email||'').trim().toLowerCase(), phone=String(req.body.phone||'').trim();
      if (!fullName || fullName.length>160 || !/^[A-Za-z0-9_]{3,30}$/.test(username) || !validEmail(email) || phone.length>32) return res.status(400).json({error:'invalid_profile',message:'Check your name, username, email and phone number.'});
      const [[kyc]] = await pool.execute("SELECT EXISTS(SELECT 1 FROM kyc_submissions WHERE member_id=? AND status IN ('pending','approved')) AS locked",[req.session.memberId]).catch(e=>{if(e.code==='ER_NO_SUCH_TABLE')return [[{locked:0}]];throw e;});
      const [[current]] = await pool.execute('SELECT full_name FROM members WHERE id=? LIMIT 1',[req.session.memberId]);
      if (Number(kyc.locked)>0 && current.full_name!==fullName) return res.status(400).json({error:'name_locked',message:'Your legal name is locked while KYC is pending or approved.'});
      const [[dupe]] = await pool.execute('SELECT SUM(LOWER(username)=LOWER(?)) AS username_used,SUM(LOWER(email)=LOWER(?)) AS email_used FROM members WHERE id<>?',[username,email,req.session.memberId]);
      if (Number(dupe.username_used)>0 || Number(dupe.email_used)>0) return res.status(409).json({error:'profile_conflict',message:'That username or email is already in use.'});
      await pool.execute('UPDATE members SET full_name=?,username=?,email=?,phone=? WHERE id=?',[fullName,username,email,phone,req.session.memberId]);
      try { await pool.execute('INSERT INTO member_profiles (member_id,phone_number) VALUES (?,?) ON DUPLICATE KEY UPDATE phone_number=VALUES(phone_number)',[req.session.memberId,phone||null]); } catch (profileError) { if (profileError.code !== 'ER_NO_SUCH_TABLE') throw profileError; }
      const [[updated]] = await pool.execute('SELECT id,monarch_uid,full_name,email,phone,username,email_verified_at FROM members WHERE id=? LIMIT 1',[req.session.memberId]);
      res.json({ok:true,member:{...publicMember(updated),phone:phone,profilePhotoUrl:'/member-avatar-current'}});
    } catch (e) { if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).json({error:'database_setup_required',message:'Profile storage is not configured yet.'}); next(e); }
  });

  router.post('/profile/photo', noStore, apiAuth, async (req,res,next) => {
    let newPath = null;
    try {
      const mime=String(req.body.mimeType||''), encoded=String(req.body.imageBase64||'');
      if (!['image/jpeg','image/png','image/webp'].includes(mime) || !encoded || encoded.length>4*1024*1024) return res.status(400).json({error:'invalid_image',message:'Choose a JPG, PNG or WebP image under 3 MB.'});
      const buf=Buffer.from(encoded.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/,''),'base64');
      if (!buf.length || buf.length>3*1024*1024) return res.status(400).json({error:'invalid_image',message:'Choose a JPG, PNG or WebP image under 3 MB.'});
      const valid=(mime==='image/jpeg'&&buf[0]===255&&buf[1]===216&&buf[2]===255)||(mime==='image/png'&&buf.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))||(mime==='image/webp'&&buf.toString('ascii',0,4)==='RIFF'&&buf.toString('ascii',8,12)==='WEBP');
      if (!valid) return res.status(400).json({error:'invalid_image',message:'That file is not a valid supported image.'});
      const dir=process.env.PROFILE_UPLOAD_DIR;
      if(!dir||!path.isAbsolute(dir)||dir===path.resolve(__dirname)||dir.startsWith(path.resolve(__dirname)+path.sep))return res.status(503).json({error:'uploads_unavailable',message:'Private profile photo storage is not configured.'});
      fs.mkdirSync(dir,{recursive:true,mode:0o700});
      const ext={'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp'}[mime], key=crypto.randomBytes(24).toString('hex')+ext;
      newPath=path.join(dir,key); fs.writeFileSync(newPath,buf,{mode:0o600,flag:'wx'});
      const [oldRows]=await pool.execute('SELECT avatar_key FROM member_profiles WHERE member_id=? LIMIT 1',[req.session.memberId]);
      const old=oldRows[0]&&String(oldRows[0].avatar_key||'');
      await pool.execute('INSERT INTO member_profiles (member_id,avatar_key) VALUES (?,?) ON DUPLICATE KEY UPDATE avatar_key=VALUES(avatar_key)',[req.session.memberId,key]);
      if(old&&old!==key&&/^[a-f0-9]{48}\.(jpg|png|webp)$/.test(old)){try{fs.unlinkSync(path.join(dir,old));}catch(e){if(e.code!=='ENOENT')console.error('[mobile profile photo cleanup] failed');}}
      res.set('Cache-Control','no-store, private').json({ok:true,profilePhotoUrl:'/member-avatar-current',version:Date.now()});
    } catch(e) { if(newPath){try{fs.unlinkSync(newPath);}catch(_){}} if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).json({error:'database_setup_required',message:'Profile photo storage is not configured yet.'}); next(e); }
  });

  router.get('/roles', noStore, apiAuth, async (req,res,next) => {
    try {
      await requireRoleTables();
      const [roles]=await pool.query("SELECT r.id,r.role_key,r.role_name,r.description,a.id AS assignment_id FROM member_role_catalog r LEFT JOIN member_role_assignments a ON a.role_id=r.id AND a.member_id=? WHERE r.is_active=1 AND LOWER(r.role_key)<>'founder' AND LOWER(r.role_name)<>'founder' ORDER BY r.role_name",[req.session.memberId]);
      const [requests]=await pool.execute('SELECT q.id,q.role_id,q.status,q.message,q.created_at,r.role_name FROM member_role_requests q JOIN member_role_catalog r ON r.id=q.role_id WHERE q.member_id=? ORDER BY q.created_at DESC LIMIT 30',[req.session.memberId]);
      res.json({roles:roles.map(r=>({...r,assigned:Boolean(r.assignment_id)})),requests});
    } catch(e) { if(e.code==='ROLE_MIGRATION_REQUIRED')return res.status(503).json({error:'role_setup_required',message:e.message}); next(e); }
  });
  router.post('/roles/request', noStore, apiAuth, async (req,res,next) => {
    try {
      await requireRoleTables();
      const roleId=Number(req.body.roleId), message=String(req.body.message||'').trim().slice(0,1000);
      if(!Number.isSafeInteger(roleId)||roleId<1)return res.status(400).json({error:'invalid_role'});
      const [[role]]=await pool.execute("SELECT id FROM member_role_catalog WHERE id=? AND is_active=1 AND LOWER(role_key)<>'founder' AND LOWER(role_name)<>'founder' LIMIT 1",[roleId]);
      if(!role)return res.status(404).json({error:'role_unavailable'});
      const [[assigned]]=await pool.execute('SELECT id FROM member_role_assignments WHERE member_id=? AND role_id=? LIMIT 1',[req.session.memberId,roleId]);
      if(assigned)return res.status(409).json({error:'already_assigned',message:'This role is already assigned.'});
      const [[pending]]=await pool.execute("SELECT id FROM member_role_requests WHERE member_id=? AND role_id=? AND status='pending' LIMIT 1",[req.session.memberId,roleId]);
      if(pending)return res.status(409).json({error:'request_pending',message:'A request for this role is already pending.'});
      const [result]=await pool.execute("INSERT INTO member_role_requests (member_id,role_id,request_source,message,status) VALUES (?,?,'member',?,'pending')",[req.session.memberId,roleId,message||null]);
      res.status(201).json({ok:true,requestId:result.insertId,status:'pending'});
    } catch(e) { if(e.code==='ROLE_MIGRATION_REQUIRED')return res.status(503).json({error:'role_setup_required',message:e.message}); next(e); }
  });

  router.get('/admin/roles', noStore, apiAuth, roleAdmin, requireCategoryAccess('members_roles','view'), async (req,res,next) => {
    try {
      await requireRoleTables();
      const [roles]=await pool.query('SELECT r.id,r.role_key,r.role_name,r.description,r.is_active,COUNT(a.id) AS assigned_count FROM member_role_catalog r LEFT JOIN member_role_assignments a ON a.role_id=r.id GROUP BY r.id ORDER BY r.role_name');
      const [requests]=await pool.query("SELECT q.id,q.member_id,q.request_source,q.company_name,q.message,q.created_at,r.role_name,m.full_name,m.email,m.monarch_uid FROM member_role_requests q JOIN member_role_catalog r ON r.id=q.role_id JOIN members m ON m.id=q.member_id WHERE q.status='pending' ORDER BY q.created_at ASC LIMIT 200");
      const [members]=await pool.query('SELECT id,full_name,email,monarch_uid FROM members ORDER BY id DESC LIMIT 200');
      const [assignments]=await pool.query('SELECT a.member_id,a.role_id,r.role_name FROM member_role_assignments a JOIN member_role_catalog r ON r.id=a.role_id ORDER BY a.member_id DESC,r.role_name');
      res.json({roles,requests,members,assignments});
    } catch(e) { if(e.code==='ROLE_MIGRATION_REQUIRED')return res.status(503).json({error:'role_setup_required',message:e.message}); next(e); }
  });
  router.post('/admin/roles/catalog', noStore, apiAuth, roleAdmin, requireCategoryAccess('members_roles','manage'), async (req,res,next) => {
    try {
      await requireRoleTables();
      const id=Number(req.body.roleId||0), name=String(req.body.roleName||'').trim(), description=String(req.body.description||'').trim().slice(0,500), key=roleKey(name), active=req.body.isActive===false?0:1;
      if(!name||name.length>100||!key)return res.status(400).json({error:'invalid_role_name'});
      if(key==='founder')return res.status(403).json({error:'founder_reserved',message:'Founder is reserved exclusively for the Monarch Codex Super Admin and cannot be created as a member role.'});
      if(id) await pool.execute('UPDATE member_role_catalog SET role_key=?,role_name=?,description=?,is_active=? WHERE id=?',[key,name,description||null,active,id]);
      else await pool.execute('INSERT INTO member_role_catalog (role_key,role_name,description,is_active,created_by_member_id) VALUES (?,?,?,1,?)',[key,name,description||null,req.session.memberId]);
      res.json({ok:true});
    } catch(e) { if(e.code==='ER_DUP_ENTRY')return res.status(409).json({error:'duplicate_role',message:'Role names and keys must be unique.'}); if(e.code==='ROLE_MIGRATION_REQUIRED')return res.status(503).json({error:'role_setup_required',message:e.message}); next(e); }
  });
  router.post('/admin/roles/requests/:requestId', noStore, apiAuth, roleAdmin, requireCategoryAccess('members_roles',req=>req.body.decision==='approve'?'approve':'reject'), async (req,res,next) => {
    try {
      await requireRoleTables();
      const id=Number(req.params.requestId), decision=String(req.body.decision||'');
      if(!Number.isSafeInteger(id)||id<1||!['approve','reject'].includes(decision))return res.status(400).json({error:'invalid_decision'});
      const connection=await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [[request]]=await connection.execute("SELECT q.id,q.member_id,q.role_id,q.status,r.role_key,r.role_name FROM member_role_requests q JOIN member_role_catalog r ON r.id=q.role_id WHERE q.id=? FOR UPDATE",[id]);
        if(!request||request.status!=='pending'){await connection.rollback();return res.status(409).json({error:'already_reviewed'});}
        if(decision==='approve'&&(String(request.role_key).toLowerCase()==='founder'||String(request.role_name).toLowerCase()==='founder')){await connection.rollback();return res.status(403).json({error:'founder_reserved',message:'Founder is reserved exclusively for the Monarch Codex Super Admin.'});}
        if(decision==='approve')await connection.execute('INSERT IGNORE INTO member_role_assignments (member_id,role_id,assigned_by_member_id) VALUES (?,?,?)',[request.member_id,request.role_id,req.session.memberId]);
        await connection.execute('UPDATE member_role_requests SET status=?,reviewed_by_member_id=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=?',[decision==='approve'?'approved':'rejected',req.session.memberId,id]);
        await connection.commit();
      } catch(e) { await connection.rollback(); throw e; } finally { connection.release(); }
      res.json({ok:true,status:decision==='approve'?'approved':'rejected'});
    } catch(e) { if(e.code==='ROLE_MIGRATION_REQUIRED')return res.status(503).json({error:'role_setup_required',message:e.message}); next(e); }
  });
  router.post('/admin/roles/assign', noStore, apiAuth, roleAdmin, requireCategoryAccess('members_roles','manage'), async (req,res,next) => {
    try {
      await requireRoleTables();
      const memberId=Number(req.body.memberId), roleId=Number(req.body.roleId), action=String(req.body.action||'assign');
      if(!Number.isSafeInteger(memberId)||memberId<1||!Number.isSafeInteger(roleId)||roleId<1||!['assign','remove'].includes(action))return res.status(400).json({error:'invalid_assignment'});
      const [[targetRole]]=await pool.execute('SELECT role_key,role_name FROM member_role_catalog WHERE id=? LIMIT 1',[roleId]);
      if(!targetRole)return res.status(404).json({error:'role_not_found'});
      if(String(targetRole.role_key).toLowerCase()==='founder'||String(targetRole.role_name).toLowerCase()==='founder')return res.status(403).json({error:'founder_reserved',message:'Founder cannot be assigned to members.'});
      if(action==='assign')await pool.execute('INSERT IGNORE INTO member_role_assignments (member_id,role_id,assigned_by_member_id) VALUES (?,?,?)',[memberId,roleId,req.session.memberId]);
      else await pool.execute('DELETE FROM member_role_assignments WHERE member_id=? AND role_id=?',[memberId,roleId]);
      res.json({ok:true});
    } catch(e) { if(e.code==='ROLE_MIGRATION_REQUIRED')return res.status(503).json({error:'role_setup_required',message:e.message}); next(e); }
  });
  router.post('/sovereign/roles/partner-request', noStore, apiAuth, async (req,res,next) => {
    try {
      const [[admin]]=await pool.execute('SELECT role FROM admin_users WHERE member_id=? AND is_active=1 LIMIT 1',[req.session.memberId]);
      if(!admin||admin.role!=='sovereign_desk_admin')return res.status(403).json({error:'forbidden',message:'Only the Sovereign Desk administrator can submit a company Partner request.'});
      await requireRoleTables();
      const [[role]]=await pool.execute("SELECT id FROM member_role_catalog WHERE role_key='partner' AND is_active=1 LIMIT 1");
      if(!role)return res.status(409).json({error:'partner_role_unavailable',message:'The Partner role is not active yet. Apply the separate Founder and Partner role catalogue migration first.'});
      const companyName=String(req.body.companyName||'Sovereign Desk').trim().slice(0,160), message=String(req.body.message||'Company role request').trim().slice(0,1000);
      const [[pending]]=await pool.execute("SELECT id FROM member_role_requests WHERE member_id=? AND role_id=? AND status='pending' AND request_source='sovereign_desk' LIMIT 1",[req.session.memberId,role.id]);
      if(!pending)await pool.execute("INSERT INTO member_role_requests (member_id,role_id,request_source,company_name,message,status) VALUES (?,?, 'sovereign_desk',?,?,'pending')",[req.session.memberId,role.id,companyName,message]);
      res.status(201).json({ok:true,status:'pending'});
    } catch(e) { if(e.code==='ROLE_MIGRATION_REQUIRED')return res.status(503).json({error:'role_setup_required',message:e.message}); next(e); }
  });


  // Persistent notification centre shared by the Android app and website.
  router.get('/notifications', noStore, apiAuth, async (req,res,next) => {
    try {
      const [items] = await pool.execute(
        'SELECT id,notification_type AS type,title,body,target_url AS targetUrl,read_at AS readAt,created_at AS createdAt FROM member_notifications WHERE member_id=? ORDER BY created_at DESC LIMIT 100',
        [req.session.memberId]
      );
      res.json({items, unreadCount:items.filter(item=>!item.readAt).length});
    } catch(e) { if(e.code==='ER_NO_SUCH_TABLE') return res.status(503).json({error:'notification_setup_required',message:'Apply migrations/021_platform_completion_foundation.sql first.'}); next(e); }
  });
  router.post('/notifications/read-all', noStore, apiAuth, async (req,res,next) => {
    try {
      await pool.execute('UPDATE member_notifications SET read_at=COALESCE(read_at,CURRENT_TIMESTAMP) WHERE member_id=? AND read_at IS NULL',[req.session.memberId]);
      res.json({ok:true});
    } catch(e) { if(e.code==='ER_NO_SUCH_TABLE') return res.status(503).json({error:'notification_setup_required'}); next(e); }
  });
  router.post('/notifications/:id/read', noStore, apiAuth, async (req,res,next) => {
    const id=Number(req.params.id);
    if(!Number.isSafeInteger(id)||id<1)return res.status(400).json({error:'invalid_notification_id'});
    try {
      const [result]=await pool.execute('UPDATE member_notifications SET read_at=COALESCE(read_at,CURRENT_TIMESTAMP) WHERE id=? AND member_id=?',[id,req.session.memberId]);
      if(!result.affectedRows)return res.status(404).json({error:'notification_not_found'});
      res.json({ok:true});
    } catch(e) { if(e.code==='ER_NO_SUCH_TABLE') return res.status(503).json({error:'notification_setup_required'}); next(e); }
  });

  const notifyActiveAdmins = async ({type,title,body,targetUrl,dedupePrefix}) => {
    const [admins]=await pool.query("SELECT member_id FROM admin_users WHERE is_active=1");
    for(const admin of admins){
      await pool.execute('INSERT IGNORE INTO member_notifications (member_id,notification_type,title,body,target_url,dedupe_key) VALUES (?,?,?,?,?,?)',
        [admin.member_id,type,title,body,targetUrl||'/admin',dedupePrefix+'_'+admin.member_id]);
    }
  };
  const auditPlatformAction = async (actor,action,targetType,targetId,details={}) => {
    await pool.execute('INSERT INTO platform_action_audit (actor_member_id,action_key,target_type,target_id,details) VALUES (?,?,?,?,?)',
      [actor,action,targetType||null,targetId==null?null:String(targetId),JSON.stringify(details)]);
  };

  // Online Cooperative is manually verified with the cooperative administrator; no external account credentials are requested.
  router.get('/cooperative/status', noStore, apiAuth, async (req,res,next) => {
    try {
      const [items]=await pool.execute('SELECT id,registered_name AS registeredName,registered_email AS registeredEmail,status,review_note AS reviewNote,created_at AS createdAt,reviewed_at AS reviewedAt FROM online_cooperative_connections WHERE member_id=? ORDER BY created_at DESC LIMIT 10',[req.session.memberId]);
      const connection = items.find(x=>x.status==='approved') || null;
      res.json({
        registrationUrl: connection ? null : 'https://airdrop.myturntech.com/register?ref=53',
        loginUrl: 'https://airdrop.myturntech.com/login',
        items,
        connection,
        connected: Boolean(connection)
      });
    } catch(e) { if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).json({error:'cooperative_setup_required',message:'Apply migrations/021_platform_completion_foundation.sql first.'}); next(e); }
  });
  router.post('/cooperative/connections', noStore, apiAuth, async (req,res,next) => {
    const registeredName=String(req.body.registeredName||'').trim().replace(/\\s+/g,' ').slice(0,160);
    const registeredEmail=String(req.body.registeredEmail||'').trim().toLowerCase();
    if(registeredName.length<2||registeredEmail.length>254||!validEmail(registeredEmail))return res.status(400).json({error:'invalid_registration_details',message:'Enter the name and valid email used for Online Cooperative registration.'});
    try {
      const [[existing]]=await pool.execute("SELECT id,status FROM online_cooperative_connections WHERE member_id=? AND status IN ('pending','approved') ORDER BY created_at DESC LIMIT 1",[req.session.memberId]);
      if(existing&&existing.status==='approved')return res.status(409).json({error:'already_connected',message:'Your Online Cooperative connection is already approved.'});
      if(existing&&existing.status==='pending')return res.status(409).json({error:'request_pending',message:'Your registration details are already waiting for verification.'});
      const [result]=await pool.execute("INSERT INTO online_cooperative_connections (member_id,registered_name,registered_email,status) VALUES (?,?,?,'pending')",[req.session.memberId,registeredName,registeredEmail]);
      await auditPlatformAction(req.session.memberId,'cooperative.connection_submitted','cooperative_connection',result.insertId,{status:'pending'});
      await notifyActiveAdmins({type:'cooperative_review',title:'Online Cooperative verification required',body:'A member submitted registration details for manual verification.',targetUrl:'/admin/cooperative',dedupePrefix:'cooperative_review_needed_'+result.insertId});
      res.status(201).json({ok:true,id:result.insertId,status:'pending',message:'Submitted for manual verification. Do not send your Online Cooperative password or OTP.'});
    } catch(e) { if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).json({error:'cooperative_setup_required'}); next(e); }
  });
  router.get('/admin/cooperative/connections', noStore, apiAuth, requireSuperAdmin, async (req,res,next) => {
    try {
      const [items]=await pool.query("SELECT c.id,c.member_id AS memberId,c.registered_name AS registeredName,c.registered_email AS registeredEmail,c.status,c.review_note AS reviewNote,c.created_at AS createdAt,m.full_name AS memberName,m.username,m.email AS memberEmail,m.monarch_uid AS uid FROM online_cooperative_connections c JOIN members m ON m.id=c.member_id WHERE c.status='pending' ORDER BY c.created_at ASC LIMIT 200");
      res.json({items});
    } catch(e) { if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).json({error:'cooperative_setup_required'}); next(e); }
  });
  router.post('/admin/cooperative/connections/:id/review', noStore, apiAuth, requireSuperAdmin, async (req,res,next) => {
    const id=Number(req.params.id), decision=String(req.body.decision||'');
    const note=String(req.body.note||'').trim().slice(0,1000);
    if(!Number.isSafeInteger(id)||id<1||!['approve','reject'].includes(decision))return res.status(400).json({error:'invalid_review'});
    if(decision==='reject'&&!note)return res.status(400).json({error:'rejection_reason_required',message:'Provide a reason before rejecting the connection.'});
    const conn=await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [[item]]=await conn.execute("SELECT id,member_id,status FROM online_cooperative_connections WHERE id=? FOR UPDATE",[id]);
      if(!item||item.status!=='pending'){await conn.rollback();return res.status(409).json({error:'request_not_pending'});}
      const status=decision==='approve'?'approved':'rejected';
      await conn.execute('UPDATE online_cooperative_connections SET status=?,reviewer_member_id=?,review_note=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=?',[status,req.session.memberId,note||null,id]);
      const title=status==='approved'?'Online Cooperative connected':'Online Cooperative connection rejected';
      const body=status==='approved'?'Your Online Cooperative registration has been manually verified and connected to Monarch Codex.':'Your Online Cooperative connection request was rejected. Reason: '+note;
      await conn.execute('INSERT INTO member_notifications (member_id,notification_type,title,body,target_url,dedupe_key) VALUES (?,?,?,?,?,?)',[item.member_id,'cooperative_review',title,body,'/online-cooperative','cooperative_review_'+id+'_'+status]);
      await conn.execute('INSERT INTO platform_action_audit (actor_member_id,action_key,target_type,target_id,details) VALUES (?,?,?,?,?)',[req.session.memberId,'cooperative.connection_'+status,'cooperative_connection',String(id),JSON.stringify({memberId:item.member_id,note})]);
      await conn.commit();
      res.json({ok:true,status});
    } catch(e) { await conn.rollback(); if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).json({error:'cooperative_setup_required'}); next(e); }
    finally { conn.release(); }
  });

  // Text-first community feed. Partner campaigns and Sovereign Desk signals require review before publication.
  router.get('/community/posts', noStore, apiAuth, async (req,res,next) => {
    try {
      await ensureFeatureTables();
      const [items]=await pool.execute("SELECT p.id,p.member_id AS memberId,(p.member_id=? ) AS isMine,p.body,p.post_type AS type,p.created_at AS createdAt,m.full_name AS authorName,m.username AS authorUsername,(SELECT COUNT(*) FROM community_comments c WHERE c.post_id=p.id AND c.status='published') AS commentCount,EXISTS(SELECT 1 FROM community_post_media pm WHERE pm.post_id=p.id) AS hasImage,IF(pr.online_until>CURRENT_TIMESTAMP,1,0) AS authorOnline,pr.last_seen_at AS authorLastSeen FROM community_posts p JOIN members m ON m.id=p.member_id LEFT JOIN member_presence pr ON pr.member_id=m.id AND pr.show_status=1 WHERE p.status='published' ORDER BY p.created_at DESC LIMIT 100",[req.session.memberId]);
      res.json({items});
    } catch(e) { if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).json({error:'community_setup_required',message:'Apply migrations/021_platform_completion_foundation.sql first.'}); next(e); }
  });
  router.post('/community/posts', noStore, apiAuth, async (req,res,next) => {
    const body=String(req.body.body||'').trim();
    const type=String(req.body.type||'post');
    if(body.length<1||body.length>5000)return res.status(400).json({error:'invalid_post',message:'Posts must contain 1 to 5000 characters.'});
    if(!['post','partner_campaign','sovereign_signal'].includes(type))return res.status(400).json({error:'invalid_post_type'});
    try {
      if(type==='partner_campaign'){
        const [[partner]]=await pool.execute("SELECT id FROM member_role_assignments a JOIN member_role_catalog r ON r.id=a.role_id WHERE a.member_id=? AND r.role_key='partner' LIMIT 1",[req.session.memberId]);
        if(!partner)return res.status(403).json({error:'partner_role_required'});
      }
      const status=type==='post'?'published':'pending';
      const [result]=await pool.execute('INSERT INTO community_posts (member_id,body,post_type,status) VALUES (?,?,?,?)',[req.session.memberId,body,type,status]);
      await auditPlatformAction(req.session.memberId,'community.post_created','community_post',result.insertId,{type,status});
      if(status==='pending')await notifyActiveAdmins({type:'community_review',title:'Community item awaiting approval',body:'A partner campaign or Sovereign Desk signal is awaiting review.',targetUrl:'/admin/community',dedupePrefix:'community_review_needed_'+result.insertId});
      res.status(201).json({ok:true,id:result.insertId,status,message:status==='pending'?'Submitted for admin approval before publication.':'Your post is now published.'});
    } catch(e) { if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).json({error:'community_setup_required'}); next(e); }
  });
  router.get('/community/posts/:id/comments', noStore, apiAuth, async (req,res,next) => {
    const id=Number(req.params.id); if(!Number.isSafeInteger(id)||id<1)return res.status(400).json({error:'invalid_post_id'});
    try {
      const [[post]]=await pool.execute("SELECT id FROM community_posts WHERE id=? AND status='published'",[id]);
      if(!post)return res.status(404).json({error:'post_not_found'});
      const [items]=await pool.execute("SELECT c.id,c.member_id AS memberId,(c.member_id=? ) AS isMine,c.body,c.created_at AS createdAt,m.full_name AS authorName,m.username AS authorUsername,IF(pr.online_until>CURRENT_TIMESTAMP,1,0) AS authorOnline,IF(pr.show_status=1,pr.last_seen_at,NULL) AS authorLastSeen FROM community_comments c JOIN members m ON m.id=c.member_id LEFT JOIN member_presence pr ON pr.member_id=m.id AND pr.show_status=1 WHERE c.post_id=? AND c.status='published' ORDER BY c.created_at ASC LIMIT 200",[req.session.memberId,id]);
      res.json({items});
    } catch(e) { if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).json({error:'community_setup_required'}); next(e); }
  });
  router.post('/community/posts/:id/comments', noStore, apiAuth, async (req,res,next) => {
    const id=Number(req.params.id), body=String(req.body.body||'').trim();
    if(!Number.isSafeInteger(id)||id<1||body.length<1||body.length>2000)return res.status(400).json({error:'invalid_comment'});
    try {
      const [[post]]=await pool.execute("SELECT id FROM community_posts WHERE id=? AND status='published'",[id]);
      if(!post)return res.status(404).json({error:'post_not_found'});
      const [result]=await pool.execute("INSERT INTO community_comments (post_id,member_id,body) VALUES (?,?,?)",[id,req.session.memberId,body]);
      res.status(201).json({ok:true,id:result.insertId});
    } catch(e) { if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).json({error:'community_setup_required'}); next(e); }
  });
  router.delete('/community/posts/:id', noStore, apiAuth, async (req,res,next) => {
    const id=Number(req.params.id);
    if(!Number.isSafeInteger(id)||id<1)return res.status(400).json({error:'invalid_post_id'});
    try {
      const [result]=await pool.execute("UPDATE community_posts SET status='hidden' WHERE id=? AND member_id=? AND status='published'",[id,req.session.memberId]);
      if(!result.affectedRows)return res.status(404).json({error:'post_not_found_or_not_owned'});
      await auditPlatformAction(req.session.memberId,'community.post_deleted','community_post',id,{method:'member_request'});
      res.json({ok:true,id});
    } catch(e) { if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).json({error:'community_setup_required'}); next(e); }
  });
  router.delete('/community/posts/:postId/comments/:commentId', noStore, apiAuth, async (req,res,next) => {
    const postId=Number(req.params.postId),commentId=Number(req.params.commentId);
    if(!Number.isSafeInteger(postId)||postId<1||!Number.isSafeInteger(commentId)||commentId<1)return res.status(400).json({error:'invalid_comment_id'});
    try {
      const [result]=await pool.execute("UPDATE community_comments SET status='hidden' WHERE id=? AND post_id=? AND member_id=? AND status='published'",[commentId,postId,req.session.memberId]);
      if(!result.affectedRows)return res.status(404).json({error:'comment_not_found_or_not_owned'});
      await auditPlatformAction(req.session.memberId,'community.comment_deleted','community_comment',commentId,{postId});
      res.json({ok:true,id:commentId,postId});
    } catch(e) { if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).json({error:'community_setup_required'}); next(e); }
  });
  router.post('/community/posts/:id/report', noStore, apiAuth, async (req,res,next) => {
    const id=Number(req.params.id), reason=String(req.body.reason||'').trim().slice(0,1000);
    if(!Number.isSafeInteger(id)||id<1||reason.length<3)return res.status(400).json({error:'invalid_report'});
    try {
      const [[post]]=await pool.execute("SELECT id FROM community_posts WHERE id=? AND status='published'",[id]);
      if(!post)return res.status(404).json({error:'post_not_found'});
      await pool.execute('INSERT INTO community_reports (post_id,reporter_member_id,reason) VALUES (?,?,?)',[id,req.session.memberId,reason]);
      await notifyActiveAdmins({type:'community_report',title:'Community post reported',body:'A member submitted a community content report for moderation.',targetUrl:'/admin/community',dedupePrefix:'community_report_needed_'+id+'_'+req.session.memberId});
      res.status(201).json({ok:true});
    } catch(e) { if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).json({error:'community_setup_required'}); next(e); }
  });
  router.get('/admin/community/review-queue', noStore, apiAuth, requireCategoryAccess('community_moderation','view'), async (req,res,next) => {
    try {
      const [items]=await pool.query("SELECT p.id,p.member_id AS memberId,p.body,p.post_type AS type,p.status,p.created_at AS createdAt,m.full_name AS authorName,m.email FROM community_posts p JOIN members m ON m.id=p.member_id WHERE p.status='pending' ORDER BY p.created_at ASC LIMIT 200");
      const [reports]=await pool.query("SELECT r.id,r.post_id AS postId,r.reason,r.created_at AS createdAt,m.full_name AS reporterName FROM community_reports r JOIN members m ON m.id=r.reporter_member_id WHERE r.status='pending' ORDER BY r.created_at ASC LIMIT 200");
      res.json({items,reports});
    } catch(e) { if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).json({error:'community_setup_required'}); next(e); }
  });
  router.post('/admin/community/posts/:id/review', noStore, apiAuth, requireCategoryAccess('community_moderation',req=>req.body.decision==='approve'?'approve':req.body.decision==='hide'?'moderate':'reject'), async (req,res,next) => {
    const id=Number(req.params.id), decision=String(req.body.decision||''), note=String(req.body.note||'').trim().slice(0,1000);
    if(!Number.isSafeInteger(id)||id<1||!['approve','reject','hide'].includes(decision))return res.status(400).json({error:'invalid_review'});
    if(decision!=='approve'&&!note)return res.status(400).json({error:'review_reason_required'});
    try {
      const status=decision==='approve'?'published':decision==='hide'?'hidden':'rejected';
      const [result]=await pool.execute("UPDATE community_posts SET status=?,reviewed_by_member_id=?,review_note=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('pending','published')",[status,req.session.memberId,note||null,id]);
      if(!result.affectedRows)return res.status(404).json({error:'post_not_found_or_already_reviewed'});
      await auditPlatformAction(req.session.memberId,'community.post_'+status,'community_post',id,{note});
      res.json({ok:true,status});
    } catch(e) { if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).json({error:'community_setup_required'}); next(e); }
  });

  const socialLinkDefaults = [
    ['whatsapp','WhatsApp','https://chat.whatsapp.com/FA3x382Snhf6o68YYbsPdm',1],
    ['telegram','Telegram','https://t.me/TheMonarchCodex',1],
    ['facebook','Facebook',null,0],['instagram','Instagram',null,0],
    ['youtube','YouTube','https://youtube.com/@monarchcodexonline?si=AqczxpbI9KgzMmQdQ',1],
    ['tiktok','TikTok',null,0],['x','X',null,0],['other','Other',null,0]
  ];
  router.get('/social-links', noStore, async (_req,res,next) => {
    try {
      const [items]=await pool.query('SELECT link_key AS key_name,label,url,is_active AS active FROM platform_social_links ORDER BY id');
      res.json({items:items.filter(x=>x.active&&x.url&&/^https:\/\//i.test(x.url))});
    } catch(e) { if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).json({error:'social_links_setup_required'}); next(e); }
  });
  router.get('/admin/social-links', noStore, apiAuth, requireSuperAdmin, async (_req,res,next) => {
    try {
      const [items]=await pool.query('SELECT link_key AS key_name,label,url,is_active AS active FROM platform_social_links ORDER BY id');
      res.json({items});
    } catch(e) { if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).json({error:'social_links_setup_required'}); next(e); }
  });
  router.post('/admin/social-links', noStore, apiAuth, requireSuperAdmin, async (req,res,next) => {
    const key=String(req.body.key||''), label=String(req.body.label||'').trim().slice(0,80);
    const rawUrl=String(req.body.url||'').trim(), active=Boolean(req.body.active);
    if(!/^(whatsapp|telegram|facebook|instagram|youtube|tiktok|x|other)$/.test(key)||!label)return res.status(400).json({error:'invalid_social_link'});
    let url=null;
    if(rawUrl){try{const parsed=new URL(rawUrl);if(parsed.protocol!=='https:'||!parsed.hostname||parsed.username||parsed.password)return res.status(400).json({error:'unsafe_social_url',message:'Use a valid HTTPS link without embedded credentials.'});url=parsed.toString();}catch(_){return res.status(400).json({error:'invalid_social_url'});}}
    if(active&&!url)return res.status(400).json({error:'active_link_requires_url'});
    try {
      await pool.execute('INSERT INTO platform_social_links (link_key,label,url,is_active,updated_by_member_id) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE label=VALUES(label),url=VALUES(url),is_active=VALUES(is_active),updated_by_member_id=VALUES(updated_by_member_id)',[key,label,url,active?1:0,req.session.memberId]);
      await auditPlatformAction(req.session.memberId,'social_link.updated','social_link',key,{active,urlPresent:Boolean(url)});
      res.json({ok:true});
    } catch(e) { if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).json({error:'social_links_setup_required'}); next(e); }
  });

  const permissionCategories = ['members_roles','online_cooperative','partner_campaigns','community_moderation','invest_market','sovereign_desk','financial_operations','notifications','social_links','security_audit'];
  router.get('/admin/permissions', noStore, apiAuth, requireSuperAdmin, async (_req,res,next) => {
    try {
      const [admins]=await pool.query("SELECT a.member_id AS memberId,a.role,m.full_name AS fullName,m.email FROM admin_users a JOIN members m ON m.id=a.member_id WHERE a.is_active=1 ORDER BY a.role,m.full_name");
      const [permissions]=await pool.query('SELECT admin_member_id AS adminMemberId,category_key AS category,access_level AS level,allowed_actions AS allowedActions,updated_at AS updatedAt FROM platform_admin_permissions');
      res.json({categories:permissionCategories,levels:['green','gold','red'],admins,permissions});
    } catch(e) { if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).json({error:'permission_setup_required'}); next(e); }
  });
  router.post('/admin/permissions', noStore, apiAuth, requireSuperAdmin, async (req,res,next) => {
    const adminMemberId=Number(req.body.adminMemberId), category=String(req.body.category||''), level=String(req.body.level||''), actions=req.body.allowedActions;
    if(!Number.isSafeInteger(adminMemberId)||adminMemberId<1||!permissionCategories.includes(category)||!['green','gold','red'].includes(level))return res.status(400).json({error:'invalid_permission'});
    if(level==='gold'&&(!Array.isArray(actions)||actions.length<1||actions.some(x=>typeof x!=='string'||x.length>80)))return res.status(400).json({error:'partial_actions_required',message:'Gold access must name each allowed action.'});
    if(level!=='gold'&&actions!==undefined&&actions!==null&&!Array.isArray(actions))return res.status(400).json({error:'invalid_actions'});
    try {
      const [[target]]=await pool.execute('SELECT role FROM admin_users WHERE member_id=? AND is_active=1 LIMIT 1',[adminMemberId]);
      if(!target)return res.status(404).json({error:'active_admin_not_found'});
      if(adminMemberId===req.session.memberId)return res.status(403).json({error:'cannot_change_own_permissions'});
      await pool.execute('INSERT INTO platform_admin_permissions (admin_member_id,category_key,access_level,allowed_actions,updated_by_member_id) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE access_level=VALUES(access_level),allowed_actions=VALUES(allowed_actions),updated_by_member_id=VALUES(updated_by_member_id)',[adminMemberId,category,level,level==='gold'?JSON.stringify([...new Set(actions)]):null,req.session.memberId]);
      await auditPlatformAction(req.session.memberId,'admin.permission_updated','admin_permission',adminMemberId,{category,level,allowedActions:level==='gold'?[...new Set(actions)]:[]});
      res.json({ok:true});
    } catch(e) { if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).json({error:'permission_setup_required'}); next(e); }
  });


  // Member presence, feedback centre and optional community image attachments.
  const featureUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    fileFilter(_req,file,cb) { if (!['image/jpeg','image/png','image/webp'].includes(file.mimetype)) return cb(new Error('Choose a JPG, PNG or WebP image under 5 MB.')); cb(null,true); }
  });
  const imageSignatureOk = file => {
    const b=file?.buffer;
    if(!b||b.length<12)return false;
    return (b[0]===0xff&&b[1]===0xd8&&b[2]===0xff) ||
      (b[0]===0x89&&b[1]===0x50&&b[2]===0x4e&&b[3]===0x47) ||
      (b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP');
  };
  const featureTables = `CREATE TABLE IF NOT EXISTS member_presence (
    member_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
    last_seen_at TIMESTAMP NULL DEFAULT NULL,
    online_until TIMESTAMP NULL DEFAULT NULL,
    show_status TINYINT(1) NOT NULL DEFAULT 1,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  CREATE TABLE IF NOT EXISTS member_feedback (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    member_id BIGINT UNSIGNED NOT NULL,
    category ENUM('feature_request','bug_report','improvement','other') NOT NULL,
    title VARCHAR(160) NOT NULL,
    description TEXT NOT NULL,
    status ENUM('received','under_review','planned','in_progress','implemented','declined') NOT NULL DEFAULT 'received',
    admin_note VARCHAR(2000) NULL,
    image_mime VARCHAR(40) NULL,
    image_data MEDIUMBLOB NULL,
    reviewed_by BIGINT UNSIGNED NULL,
    reviewed_at TIMESTAMP NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_member_feedback_member (member_id, created_at),
    KEY idx_member_feedback_status (status, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  CREATE TABLE IF NOT EXISTS community_post_media (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    post_id BIGINT UNSIGNED NOT NULL,
    image_mime VARCHAR(40) NOT NULL,
    image_data MEDIUMBLOB NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_community_post_media_post (post_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`;
  let featureTablesReady = null;
  const ensureFeatureTables = async () => {
    if (!featureTablesReady) featureTablesReady = (async () => {
      const statements = featureTables.split(/;\s*(?=CREATE TABLE|$)/).map(s=>s.trim()).filter(Boolean);
      for (const sql of statements) await pool.query(sql);
    })().catch(e => { featureTablesReady=null; throw e; });
    return featureTablesReady;
  };
  const onlineFlag = row => Boolean(row && Number(row.show_status)===1 && row.online_until && new Date(row.online_until).getTime()>Date.now());

  router.post('/presence/heartbeat', noStore, apiAuth, async (req,res,next) => {
    try {
      await ensureFeatureTables();
      await pool.execute('INSERT INTO member_presence (member_id,last_seen_at,online_until) VALUES (?,CURRENT_TIMESTAMP,DATE_ADD(CURRENT_TIMESTAMP,INTERVAL 2 MINUTE)) ON DUPLICATE KEY UPDATE last_seen_at=CURRENT_TIMESTAMP,online_until=DATE_ADD(CURRENT_TIMESTAMP,INTERVAL 2 MINUTE)',[req.session.memberId]);
      res.json({ok:true,online:true,heartbeatSeconds:45});
    } catch(e){ next(e); }
  });
  router.get('/presence/members', noStore, apiAuth, async (req,res,next) => {
    try {
      await ensureFeatureTables();
      const ids=String(req.query.ids||'').split(',').map(x=>Number(x)).filter(x=>Number.isSafeInteger(x)&&x>0).slice(0,100);
      if(!ids.length)return res.json({items:[]});
      const [rows]=await pool.query('SELECT p.member_id AS memberId,p.last_seen_at AS lastSeenAt,p.online_until AS onlineUntil,p.show_status AS showStatus FROM member_presence p WHERE p.member_id IN ('+ids.map(()=>'?').join(',')+')',ids);
      res.json({items:rows.map(x=>({memberId:x.memberId,showStatus:Boolean(x.showStatus),online:onlineFlag(x),lastSeenAt:x.showStatus?x.lastSeenAt:null}))});
    } catch(e){ next(e); }
  });
  router.get('/presence/settings', noStore, apiAuth, async (req,res,next) => {
    try {
      await ensureFeatureTables();
      const [[row]]=await pool.execute('SELECT show_status AS showStatus FROM member_presence WHERE member_id=?',[req.session.memberId]);
      res.json({showStatus:row?Boolean(row.showStatus):true});
    } catch(e){ next(e); }
  });
  router.put('/presence/settings', noStore, apiAuth, async (req,res,next) => {
    const showStatus=req.body.showStatus===true;
    try {
      await ensureFeatureTables();
      await pool.execute('INSERT INTO member_presence (member_id,last_seen_at,online_until,show_status) VALUES (?,CURRENT_TIMESTAMP,DATE_ADD(CURRENT_TIMESTAMP,INTERVAL 2 MINUTE),?) ON DUPLICATE KEY UPDATE show_status=VALUES(show_status),last_seen_at=CURRENT_TIMESTAMP,online_until=IF(VALUES(show_status)=1,DATE_ADD(CURRENT_TIMESTAMP,INTERVAL 2 MINUTE),NULL)',[req.session.memberId,showStatus?1:0]);
      res.json({ok:true,showStatus});
    } catch(e){ next(e); }
  });

  router.post('/feedback', noStore, apiAuth, (req,res,next)=>featureUpload.single('image')(req,res,err=>err?res.status(400).json({error:'invalid_image',message:err.message||'Invalid image upload.'}):next()), async (req,res,next) => {
    const category=String(req.body.category||'other'),title=String(req.body.title||'').trim(),description=String(req.body.description||'').trim();
    if(!['feature_request','bug_report','improvement','other'].includes(category)||title.length<3||title.length>160||description.length<5||description.length>5000)return res.status(400).json({error:'invalid_feedback',message:'Enter a title and description. Titles must be 3–160 characters and descriptions 5–5000 characters.'});
    if(req.file&&!imageSignatureOk(req.file))return res.status(400).json({error:'invalid_image_signature',message:'The selected file is not a valid JPG, PNG or WebP image.'});
    try {
      await ensureFeatureTables();
      const [result]=await pool.execute('INSERT INTO member_feedback (member_id,category,title,description,image_mime,image_data) VALUES (?,?,?,?,?,?)',[req.session.memberId,category,title,description,req.file?.mimetype||null,req.file?.buffer||null]);
      res.status(201).json({ok:true,id:result.insertId,status:'received',message:'Feedback received. You can track its progress in Feedback & Suggestions.'});
    } catch(e){ next(e); }
  });
  router.get('/feedback', noStore, apiAuth, async (req,res,next) => {
    try {
      await ensureFeatureTables();
      const [items]=await pool.execute('SELECT id,category,title,description,status,admin_note AS adminNote, image_mime IS NOT NULL AS hasImage,created_at AS createdAt,updated_at AS updatedAt FROM member_feedback WHERE member_id=? ORDER BY created_at DESC LIMIT 100',[req.session.memberId]);
      res.json({items});
    } catch(e){ next(e); }
  });
  router.get('/admin/feedback', noStore, apiAuth, async (req,res,next) => {
    try {
      await ensureFeatureTables();
      const [[admin]]=await pool.execute('SELECT role FROM admin_users WHERE member_id=? AND is_active=1 LIMIT 1',[req.session.memberId]);
      if(!admin||!['super_admin','main_admin'].includes(String(admin.role)))return res.status(403).json({error:'admin_required'});
      const [items]=await pool.query('SELECT f.id,f.member_id AS memberId,m.full_name AS memberName,m.username,f.category,f.title,f.description,f.status,f.admin_note AS adminNote,f.image_mime IS NOT NULL AS hasImage,f.created_at AS createdAt FROM member_feedback f JOIN members m ON m.id=f.member_id ORDER BY (f.status="received") DESC,f.created_at DESC LIMIT 300');
      res.json({items});
    } catch(e){ next(e); }
  });
  router.post('/admin/feedback/:id/review', noStore, apiAuth, async (req,res,next) => {
    const id=Number(req.params.id),status=String(req.body.status||''),note=String(req.body.note||'').trim().slice(0,2000);
    if(!Number.isSafeInteger(id)||id<1||!['under_review','planned','in_progress','implemented','declined'].includes(status))return res.status(400).json({error:'invalid_feedback_review'});
    try {
      await ensureFeatureTables();
      const [[admin]]=await pool.execute('SELECT role FROM admin_users WHERE member_id=? AND is_active=1 LIMIT 1',[req.session.memberId]);
      if(!admin||!['super_admin','main_admin'].includes(String(admin.role)))return res.status(403).json({error:'admin_required'});
      const [result]=await pool.execute('UPDATE member_feedback SET status=?,admin_note=?,reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=?',[status,note||null,req.session.memberId,id]);
      if(!result.affectedRows)return res.status(404).json({error:'feedback_not_found'});
      try { await pool.execute('INSERT INTO member_notifications (member_id,notification_type,title,body,target_url,dedupe_key) SELECT member_id,?,?,?,?,? FROM member_feedback WHERE id=?',[ 'feedback_update','Feedback status updated','Your feedback is now '+status.replaceAll('_',' ')+(note?' — '+note:''),'/feedback','feedback_'+id+'_'+status,id]); } catch(_){}
      res.json({ok:true,status});
    } catch(e){ next(e); }
  });

  router.post('/community/posts/media', noStore, apiAuth, (req,res,next)=>featureUpload.single('image')(req,res,err=>err?res.status(400).json({error:'invalid_image',message:err.message||'Invalid image upload.'}):next()), async (req,res,next) => {
    const body=String(req.body.body||'').trim(),type=String(req.body.type||'post');
    if(body.length<1||body.length>5000||type!=='post')return res.status(400).json({error:'invalid_post',message:'Enter a post between 1 and 5000 characters. Image attachments are for ordinary community posts.'});
    if(req.file&&!imageSignatureOk(req.file))return res.status(400).json({error:'invalid_image_signature',message:'The selected file is not a valid JPG, PNG or WebP image.'});
    try {
      await ensureFeatureTables();
      const [result]=await pool.execute('INSERT INTO community_posts (member_id,body,post_type,status) VALUES (?,?,?,?)',[req.session.memberId,body,'post','published']);
      if(req.file)await pool.execute('INSERT INTO community_post_media (post_id,image_mime,image_data) VALUES (?,?,?)',[result.insertId,req.file.mimetype,req.file.buffer]);
      await auditPlatformAction(req.session.memberId,'community.post_created','community_post',result.insertId,{type:'post',hasImage:Boolean(req.file)});
      res.status(201).json({ok:true,id:result.insertId,status:'published',hasImage:Boolean(req.file),message:'Your post is now published.'});
    } catch(e){ next(e); }
  });
  router.get('/community/posts/:id/image', noStore, apiAuth, async (req,res,next) => {
    const id=Number(req.params.id);if(!Number.isSafeInteger(id)||id<1)return res.status(400).end();
    try {
      await ensureFeatureTables();
      const [[row]]=await pool.execute("SELECT pm.image_mime AS mime,pm.image_data AS data FROM community_post_media pm JOIN community_posts p ON p.id=pm.post_id WHERE p.id=? AND p.status='published'",[id]);
      if(!row)return res.status(404).json({error:'image_not_found'});
      res.set('Content-Type',row.mime);res.set('Cache-Control','private, no-store');res.set('X-Content-Type-Options','nosniff');res.send(row.data);
    } catch(e){ next(e); }
  });
  router.get('/feedback/:id/image', noStore, apiAuth, async (req,res,next) => {
    const id=Number(req.params.id);if(!Number.isSafeInteger(id)||id<1)return res.status(400).end();
    try {
      await ensureFeatureTables();
      const [[row]]=await pool.execute('SELECT image_mime AS mime,image_data AS data,member_id AS memberId FROM member_feedback WHERE id=?',[id]);
      if(!row|| (Number(row.memberId)!==Number(req.session.memberId))) {
        const [[admin]]=await pool.execute('SELECT role FROM admin_users WHERE member_id=? AND is_active=1 LIMIT 1',[req.session.memberId]);
        if(!row||!admin||!['super_admin','main_admin'].includes(String(admin.role)))return res.status(404).json({error:'image_not_found'});
      }
      if(!row.data)return res.status(404).json({error:'image_not_found'});
      res.set('Content-Type',row.mime);res.set('Cache-Control','private, no-store');res.set('X-Content-Type-Options','nosniff');res.send(row.data);
    } catch(e){ next(e); }
  });


  // Native Sovereign Desk API. The Android app uses the same authenticated session
  // and the same production database as the website; no database credentials leave the server.
  const sovereignAdminApi = async (req,res,next) => {
    try {
      const [[admin]] = await pool.execute('SELECT role FROM admin_users WHERE member_id=? AND is_active=1 LIMIT 1',[req.session.memberId]);
      if (!admin || !['sovereign_desk_admin','super_admin','main_admin'].includes(String(admin.role))) {
        return res.status(403).json({error:'sovereign_admin_required',message:'Authorised Sovereign Desk administrator access is required.'});
      }
      req.sovereignAdminRole = String(admin.role);
      next();
    } catch (e) { next(e); }
  };
  const desk = express.Router();
  desk.use(noStore, apiAuth, sovereignAdminApi);
  const deskClean = (v,max) => String(v == null ? '' : v).trim().slice(0,max);
  const deskId = v => /^\d{1,20}$/.test(String(v || ''));
  const deskFail = (res,e) => {
    if (e && ['ER_NO_SUCH_TABLE','ER_BAD_FIELD_ERROR','ER_NO_SUCH_COLUMN'].includes(e.code)) {
      return res.status(503).json({error:'sovereign_setup_required',message:'The Sovereign Desk database schema is incomplete. No change was made.'});
    }
    throw e;
  };
  desk.get('/overview', async (req,res,next) => {
    try {
      const [[signals]] = await pool.execute("SELECT COUNT(*) total, SUM(status='published') published FROM sovereign_signals");
      const [[guidance]] = await pool.execute("SELECT COUNT(*) total, SUM(status='published') published FROM sovereign_guidance");
      const [[access]] = await pool.execute("SELECT COUNT(*) total, SUM(status='approved' AND (expires_at IS NULL OR expires_at>NOW())) active FROM sovereign_desk_access");
      const [[requests]] = await pool.execute("SELECT COUNT(*) total, SUM(status='pending') pending FROM sovereign_access_requests");
      const [[announcements]] = await pool.execute("SELECT COUNT(*) total, SUM(status='published') published FROM sovereign_announcements");
      res.json({role:req.sovereignAdminRole,signals:{total:Number(signals.total)||0,published:Number(signals.published)||0},guidance:{total:Number(guidance.total)||0,published:Number(guidance.published)||0},access:{total:Number(access.total)||0,active:Number(access.active)||0},requests:{total:Number(requests.total)||0,pending:Number(requests.pending)||0},announcements:{total:Number(announcements.total)||0,published:Number(announcements.published)||0}});
    } catch(e) { try { deskFail(res,e); } catch(err) { next(err); } }
  });
  desk.get('/signals', async (req,res,next) => {
    try { const [items]=await pool.execute('SELECT id,title,asset_pair,direction,price,entry_zone,stop_loss,take_profit_1,take_profit_2,timeframe,explanation,status,validation_status,published_at,expires_at,created_at,updated_at FROM sovereign_signals ORDER BY created_at DESC LIMIT 100'); res.json({items}); }
    catch(e) { try { deskFail(res,e); } catch(err) { next(err); } }
  });
  desk.post('/signals', async (req,res,next) => {
    const asset=deskClean(req.body.asset_pair,40),direction=deskClean(req.body.direction,10),price=deskClean(req.body.price,100),explanation=deskClean(req.body.explanation,12000),validation=deskClean(req.body.validation_status||'pending',12);
    if(!asset||!['buy','sell'].includes(direction)||!price||!['pending','valid','invalid'].includes(validation))return res.status(400).json({error:'invalid_signal',message:'Instrument, BUY/SELL direction and entry price are required.'});
    try {
      const title=(asset+' '+direction.toUpperCase()).slice(0,180),publish=validation==='valid';
      const [result]=await pool.execute('INSERT INTO sovereign_signals (title,asset_pair,direction,price,entry_zone,stop_loss,take_profit_1,explanation,status,validation_status,published_at,created_by,updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',[title,asset,direction,price,price,deskClean(req.body.stop_loss,100)||null,deskClean(req.body.take_profit_1,100)||null,explanation,publish?'published':'draft',validation,publish?new Date():null,req.session.memberId,req.session.memberId]);
      res.status(201).json({ok:true,id:result.insertId});
    } catch(e) { try { deskFail(res,e); } catch(err) { next(err); } }
  });
  desk.post('/signals/:id/validation', async (req,res,next) => {
    const id=String(req.params.id),validation=deskClean(req.body.validation_status,12);
    if(!deskId(id)||!['pending','valid','invalid'].includes(validation))return res.status(400).json({error:'invalid_signal_validation'});
    try {
      const [r]=await pool.execute("UPDATE sovereign_signals SET validation_status=?,status=CASE WHEN ?='valid' AND status='published' THEN status WHEN ?='valid' THEN 'draft' ELSE 'draft' END,published_at=CASE WHEN ?='valid' AND status='published' THEN published_at ELSE NULL END,updated_by=? WHERE id=?",[validation,validation,validation,validation,req.session.memberId,id]);
      if(!r.affectedRows)return res.status(404).json({error:'signal_not_found'});
      res.json({ok:true});
    } catch(e) { try { deskFail(res,e); } catch(err) { next(err); } }
  });
  desk.post('/signals/:id/status', async (req,res,next) => {
    const id=String(req.params.id),status=deskClean(req.body.status,20);
    if(!deskId(id)||!['draft','published','closed','archived'].includes(status))return res.status(400).json({error:'invalid_signal_status'});
    try {
      const [[signal]]=await pool.execute('SELECT id,validation_status FROM sovereign_signals WHERE id=? LIMIT 1',[id]);
      if(!signal)return res.status(404).json({error:'signal_not_found'});
      if(status==='published'&&signal.validation_status!=='valid')return res.status(409).json({error:'signal_not_validated',message:'Mark the signal VALID before publishing.'});
      await pool.execute('UPDATE sovereign_signals SET status=?,published_at=CASE WHEN ?=\'published\' THEN COALESCE(published_at,CURRENT_TIMESTAMP) ELSE published_at END,updated_by=? WHERE id=?',[status,status,req.session.memberId,id]);
      res.json({ok:true});
    } catch(e) { try { deskFail(res,e); } catch(err) { next(err); } }
  });
  desk.get('/guidance', async (req,res,next) => {
    try { const [items]=await pool.execute('SELECT id,title,body,status,published_at,created_at,updated_at FROM sovereign_guidance ORDER BY created_at DESC LIMIT 100'); res.json({items}); }
    catch(e) { try { deskFail(res,e); } catch(err) { next(err); } }
  });
  desk.post('/guidance', async (req,res,next) => {
    const title=deskClean(req.body.title,180),body=deskClean(req.body.body,20000);
    if(!title||!body)return res.status(400).json({error:'guidance_required',message:'Title and content are required.'});
    try { const [r]=await pool.execute("INSERT INTO sovereign_guidance (title,body,status,created_by,updated_by) VALUES (?,?,'draft',?,?)",[title,body,req.session.memberId,req.session.memberId]);res.status(201).json({ok:true,id:r.insertId}); }
    catch(e) { try { deskFail(res,e); } catch(err) { next(err); } }
  });
  desk.post('/guidance/:id/status', async (req,res,next) => {
    const id=String(req.params.id),status=deskClean(req.body.status,20);
    if(!deskId(id)||!['draft','published','archived'].includes(status))return res.status(400).json({error:'invalid_guidance_status'});
    try { const [r]=await pool.execute('UPDATE sovereign_guidance SET status=?,published_at=CASE WHEN ?=\'published\' THEN COALESCE(published_at,CURRENT_TIMESTAMP) ELSE published_at END,updated_by=? WHERE id=?',[status,status,req.session.memberId,id]);if(!r.affectedRows)return res.status(404).json({error:'guidance_not_found'});res.json({ok:true}); }
    catch(e) { try { deskFail(res,e); } catch(err) { next(err); } }
  });
  desk.get('/access', async (req,res,next) => {
    try {
      const [members]=await pool.execute('SELECT m.id,m.monarch_uid,m.full_name,m.email,m.username,a.status,a.reason,a.granted_at,a.expires_at FROM members m LEFT JOIN sovereign_desk_access a ON a.member_id=m.id ORDER BY a.updated_at DESC,m.id DESC LIMIT 200');
      const [requests]=await pool.execute("SELECT r.id,r.member_id,r.reason,r.status,r.created_at,m.full_name,m.email,m.monarch_uid FROM sovereign_access_requests r JOIN members m ON m.id=r.member_id ORDER BY (r.status='pending') DESC,r.created_at DESC LIMIT 150");
      res.json({members,requests});
    } catch(e) { try { deskFail(res,e); } catch(err) { next(err); } }
  });
  desk.post('/access-requests/:id/review', async (req,res,next) => {
    const id=String(req.params.id),decision=deskClean(req.body.decision,20),reason=deskClean(req.body.reason,1000);
    if(!deskId(id)||!['approved','rejected'].includes(decision))return res.status(400).json({error:'invalid_access_decision'});
    const conn=await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [[r]]=await conn.execute('SELECT id,member_id,status FROM sovereign_access_requests WHERE id=? FOR UPDATE',[id]);
      if(!r){await conn.rollback();return res.status(404).json({error:'request_not_found'});}
      if(r.status!=='pending'){await conn.rollback();return res.status(409).json({error:'request_already_reviewed'});}
      await conn.execute('UPDATE sovereign_access_requests SET status=?,reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP,review_reason=? WHERE id=?',[decision,req.session.memberId,reason||null,id]);
      if(decision==='approved')await conn.execute("INSERT INTO sovereign_desk_access (member_id,status,reason,granted_at) VALUES (?,'approved',?,CURRENT_TIMESTAMP) ON DUPLICATE KEY UPDATE status='approved',reason=VALUES(reason),granted_at=CURRENT_TIMESTAMP",[r.member_id,reason||'Approved by Sovereign Desk administrator']);
      await conn.commit();res.json({ok:true});
    } catch(e) { await conn.rollback().catch(()=>{});try { deskFail(res,e); } catch(err) { next(err); } }
    finally { conn.release(); }
  });
  desk.post('/access/:memberId', async (req,res,next) => {
    const memberId=String(req.params.memberId),decision=deskClean(req.body.decision,20),reason=deskClean(req.body.reason,1000),expiry=deskClean(req.body.expires_at,30);
    if(!deskId(memberId)||!['approved','revoked'].includes(decision))return res.status(400).json({error:'invalid_access_change'});
    try {
      const [[member]]=await pool.execute('SELECT id FROM members WHERE id=? LIMIT 1',[memberId]);
      if(!member)return res.status(404).json({error:'member_not_found'});
      await pool.execute("INSERT INTO sovereign_desk_access (member_id,status,reason,granted_by,expires_at) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE status=VALUES(status),reason=VALUES(reason),granted_by=VALUES(granted_by),granted_at=CASE WHEN VALUES(status)='approved' THEN CURRENT_TIMESTAMP ELSE granted_at END,expires_at=VALUES(expires_at)",[memberId,decision,reason||null,req.session.memberId,decision==='approved'&&expiry?expiry.replace('T',' ')+':00':null]);
      res.json({ok:true});
    } catch(e) { try { deskFail(res,e); } catch(err) { next(err); } }
  });
  desk.get('/signal-access', async (req,res,next) => {
    try { const [items]=await pool.execute("SELECT a.id,a.member_id,a.access_type,a.status,a.payment_reference,a.requested_at,a.expires_at,a.review_reason,m.full_name,m.username,m.email,m.monarch_uid FROM sovereign_signal_access a JOIN members m ON m.id=a.member_id ORDER BY a.status,a.requested_at DESC LIMIT 250");res.json({items}); }
    catch(e) { try { deskFail(res,e); } catch(err) { next(err); } }
  });
  desk.post('/signal-access/:id/review', async (req,res,next) => {
    const id=String(req.params.id),decision=deskClean(req.body.decision,20),note=deskClean(req.body.note,1000);
    if(!deskId(id)||!['approved','rejected','revoked'].includes(decision))return res.status(400).json({error:'invalid_signal_access_decision'});
    const conn=await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [[a]]=await conn.execute('SELECT id,member_id,status,access_type FROM sovereign_signal_access WHERE id=? FOR UPDATE',[id]);
      if(!a){await conn.rollback();return res.status(404).json({error:'request_not_found'});}
      if(['approved','rejected'].includes(decision)&&a.status!=='pending'){await conn.rollback();return res.status(409).json({error:'request_already_reviewed'});}
      if(decision==='approved'){
        await conn.execute("UPDATE sovereign_signal_access SET status='approved',reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP,review_reason=?,starts_at=CURRENT_TIMESTAMP,expires_at=DATE_ADD(CURRENT_TIMESTAMP,INTERVAL 14 DAY) WHERE id=?",[req.session.memberId,note||'Payment verified by administrator',id]);
        if(a.access_type==='paid')await conn.execute("INSERT INTO sovereign_desk_access (member_id,status,reason,granted_at,expires_at) VALUES (?,'approved','Paid Sovereign Desk service',CURRENT_TIMESTAMP,DATE_ADD(CURRENT_TIMESTAMP,INTERVAL 14 DAY)) ON DUPLICATE KEY UPDATE status='approved',reason=VALUES(reason),granted_at=CURRENT_TIMESTAMP,expires_at=VALUES(expires_at)",[a.member_id]);
      } else {
        await conn.execute('UPDATE sovereign_signal_access SET status=?,reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP,review_reason=? WHERE id=?',[decision,req.session.memberId,note||null,id]);
        if(decision==='revoked')await conn.execute("UPDATE sovereign_desk_access SET status='revoked',reason=? WHERE member_id=?",[note||'Access revoked by administrator',a.member_id]);
      }
      await conn.commit();res.json({ok:true});
    } catch(e) { await conn.rollback().catch(()=>{});try { deskFail(res,e); } catch(err) { next(err); } }
    finally { conn.release(); }
  });
  desk.get('/announcements', async (req,res,next) => {
    try { const [items]=await pool.execute('SELECT id,title,body,status,published_at,created_at FROM sovereign_announcements ORDER BY created_at DESC LIMIT 100');res.json({items}); }
    catch(e) { try { deskFail(res,e); } catch(err) { next(err); } }
  });
  desk.post('/announcements', async (req,res,next) => {
    const title=deskClean(req.body.title,180),body=deskClean(req.body.body,6000);
    if(!title||!body)return res.status(400).json({error:'announcement_required',message:'Title and message are required.'});
    try { const [r]=await pool.execute("INSERT INTO sovereign_announcements (title,body,status,created_by,updated_by) VALUES (?,?,'draft',?,?)",[title,body,req.session.memberId,req.session.memberId]);res.status(201).json({ok:true,id:r.insertId}); }
    catch(e) { try { deskFail(res,e); } catch(err) { next(err); } }
  });
  desk.post('/announcements/:id/status', async (req,res,next) => {
    const id=String(req.params.id),status=deskClean(req.body.status,20);
    if(!deskId(id)||!['draft','published','archived'].includes(status))return res.status(400).json({error:'invalid_announcement_status'});
    const conn=await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [[a]]=await conn.execute('SELECT id,title,body,status FROM sovereign_announcements WHERE id=? FOR UPDATE',[id]);
      if(!a){await conn.rollback();return res.status(404).json({error:'announcement_not_found'});}
      await conn.execute("UPDATE sovereign_announcements SET status=?,published_at=CASE WHEN ?='published' THEN COALESCE(published_at,CURRENT_TIMESTAMP) ELSE published_at END,updated_by=? WHERE id=?",[status,status,req.session.memberId,id]);
      if(status==='published'&&a.status!=='published'){
        await conn.execute("INSERT INTO member_notifications (member_id,notification_type,title,body,target_url,dedupe_key) SELECT a.member_id,'sovereign_announcement',?,?,'/sovereign-desk/announcements',CONCAT('sovereign-announcement:',? ,':',a.member_id) FROM sovereign_desk_access a WHERE a.status='approved' AND (a.expires_at IS NULL OR a.expires_at>NOW())",[a.title,a.body,id]);
      }
      await conn.commit();res.json({ok:true});
    } catch(e) { await conn.rollback().catch(()=>{});try { deskFail(res,e); } catch(err) { next(err); } }
    finally { conn.release(); }
  });
  desk.get('/events', async (req,res,next) => {
    try { const [items]=await pool.execute('SELECT id,title,summary,event_label,starts_at,ends_at,status FROM monarch_site_events ORDER BY starts_at DESC,id DESC LIMIT 100');res.json({items}); }
    catch(e) { try { deskFail(res,e); } catch(err) { next(err); } }
  });
  desk.post('/events', async (req,res,next) => {
    const title=deskClean(req.body.title,180),summary=deskClean(req.body.summary,1200),label=deskClean(req.body.event_label,100)||'MONARCH CODEX EVENT';
    const starts=deskClean(req.body.starts_at,30).replace('T',' '),ends=deskClean(req.body.ends_at,30).replace('T',' ');
    if(!title||!summary||!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(starts)||!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(ends)||new Date(ends.replace(' ','T')).getTime()<=new Date(starts.replace(' ','T')).getTime())return res.status(400).json({error:'invalid_event',message:'Enter valid event details and an end time after the start.'});
    try { const [r]=await pool.execute("INSERT INTO monarch_site_events (title,summary,event_label,starts_at,ends_at,status,created_by,updated_by) VALUES (?,?,?,?,?,'published',?,?)",[title,summary,label,starts,ends,req.session.memberId,req.session.memberId]);res.status(201).json({ok:true,id:r.insertId}); }
    catch(e) { try { deskFail(res,e); } catch(err) { next(err); } }
  });
  desk.post('/events/:id/status', async (req,res,next) => {
    const id=String(req.params.id),status=deskClean(req.body.status,12);
    if(!deskId(id)||!['published','draft','archived'].includes(status))return res.status(400).json({error:'invalid_event_status'});
    try { const [r]=await pool.execute('UPDATE monarch_site_events SET status=?,updated_by=? WHERE id=?',[status,req.session.memberId,id]);if(!r.affectedRows)return res.status(404).json({error:'event_not_found'});res.json({ok:true}); }
    catch(e) { try { deskFail(res,e); } catch(err) { next(err); } }
  });
  desk.post('/governance', async (req,res,next) => {
    const type=deskClean(req.body.item_type||'concern',20),subject=deskClean(req.body.subject,180),details=deskClean(req.body.details,5000),targetRaw=deskClean(req.body.target_member_id,20),targetId=targetRaw&&deskId(targetRaw)?targetRaw:null;
    if(!['concern','access_review'].includes(type)||!subject||!details||(targetRaw&&!targetId)||(type==='access_review'&&!targetId))return res.status(400).json({error:'invalid_governance_item',message:'Complete the required governance details.'});
    try {
      if(targetId){const [[m]]=await pool.execute('SELECT id FROM members WHERE id=? LIMIT 1',[targetId]);if(!m)return res.status(404).json({error:'member_not_found'});}
      const [cols]=await pool.query('SHOW COLUMNS FROM sovereign_governance_items');
      const names=new Set(cols.map(c=>String(c.Field)));
      let r;
      if(['subject','target_member_id','submitted_by'].every(c=>names.has(c))){
        [r]=await pool.execute("INSERT INTO sovereign_governance_items (item_type,subject,details,target_member_id,submitted_by,status) VALUES (?,?,?,?,?,'open')",[type,subject,details,targetId,req.session.memberId]);
      } else if(['title','subject_member_id','created_by'].every(c=>names.has(c))){
        [r]=await pool.execute("INSERT INTO sovereign_governance_items (item_type,title,details,subject_member_id,created_by,status) VALUES (?,?,?,?,?,'open')",[type,subject,details,targetId,req.session.memberId]);
      } else {
        return res.status(503).json({error:'governance_schema_required',message:'The governance table does not contain a supported column layout.'});
      }
      res.status(201).json({ok:true,id:r.insertId});
    } catch(e) { try { deskFail(res,e); } catch(err) { next(err); } }
  });
  desk.post('/governance/:id/status', async (req,res,next) => {
    const id=String(req.params.id),requestedStatus=deskClean(req.body.status,20),note=deskClean(req.body.resolution_note,2000);
    if(!deskId(id)||!['open','under_review','resolved','closed'].includes(requestedStatus))return res.status(400).json({error:'invalid_governance_status'});
    try {
      const [cols]=await pool.query('SHOW COLUMNS FROM sovereign_governance_items');
      const fields=new Set(cols.map(c=>String(c.Field)));
      if(fields.has('resolution_note')&&fields.has('reviewed_by')&&fields.has('reviewed_at')){
        const [r]=await pool.execute('UPDATE sovereign_governance_items SET status=?,resolution_note=?,reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=?',[requestedStatus,note||null,req.session.memberId,id]);
        if(!r.affectedRows)return res.status(404).json({error:'governance_item_not_found'});
      } else if(fields.has('decision_text')&&fields.has('decided_by')&&fields.has('decided_at')){
        const [statusRows]=await pool.query("SHOW COLUMNS FROM sovereign_governance_items LIKE 'status'");
        const statusType=String(statusRows[0]?.Type||'');
        const supports=status=>statusType.includes("'"+status+"'");
        let status=requestedStatus;
        if(status==='under_review'&&!supports(status)&&supports('in_review'))status='in_review';
        if(status==='closed'&&!supports(status)&&supports('rejected'))status='rejected';
        if(statusType.toLowerCase().startsWith('enum(')&&!supports(status))return res.status(400).json({error:'unsupported_governance_status',message:'This database does not support the requested status.'});
        const [r]=await pool.execute('UPDATE sovereign_governance_items SET status=?,decision_text=?,decided_by=?,decided_at=CURRENT_TIMESTAMP WHERE id=?',[status,note||null,req.session.memberId,id]);
        if(!r.affectedRows)return res.status(404).json({error:'governance_item_not_found'});
      } else {
        return res.status(503).json({error:'governance_schema_required',message:'The governance table does not contain supported review columns.'});
      }
      res.json({ok:true});
    } catch(e) { try { deskFail(res,e); } catch(err) { next(err); } }
  });
  desk.get('/watchlist', async (req,res,next) => {
    try { const [items]=await pool.execute("SELECT id,instrument,direction,outcome,trade_date,notes,updated_at FROM sovereign_weekly_trades ORDER BY trade_date DESC,id DESC LIMIT 100");res.json({items}); }
    catch(e) { try { deskFail(res,e); } catch(err) { next(err); } }
  });
  desk.post('/watchlist', async (req,res,next) => {
    const instrument=deskClean(req.body.instrument,80),direction=deskClean(req.body.direction,10),outcome=deskClean(req.body.outcome,12),date=deskClean(req.body.trade_date,10),notes=deskClean(req.body.notes,1000);
    if(!instrument||!['buy','sell'].includes(direction)||!['profit','loss','breakeven'].includes(outcome)||!/^\d{4}-\d{2}-\d{2}$/.test(date))return res.status(400).json({error:'invalid_trade',message:'Enter instrument, direction, result and trade date.'});
    try { const [r]=await pool.execute('INSERT INTO sovereign_weekly_trades (instrument,direction,outcome,trade_date,notes,created_by,updated_by) VALUES (?,?,?,?,?,?,?)',[instrument,direction,outcome,date,notes||null,req.session.memberId,req.session.memberId]);res.status(201).json({ok:true,id:r.insertId}); }
    catch(e) { try { deskFail(res,e); } catch(err) { next(err); } }
  });
  desk.get('/governance', async (req,res,next) => {
    try {
      const [cols]=await pool.query('SHOW COLUMNS FROM sovereign_governance_items');
      const fields=new Set(cols.map(c=>String(c.Field)));
      let items, decisions;
      if(['subject','submitted_by','target_member_id','resolution_note','reviewed_at'].every(c=>fields.has(c))){
        [items]=await pool.execute("SELECT g.id,g.item_type,g.subject,g.details,g.status,g.created_at,g.reviewed_at,g.resolution_note,m.full_name,m.username,m.monarch_uid,t.full_name target_name FROM sovereign_governance_items g JOIN members m ON m.id=g.submitted_by LEFT JOIN members t ON t.id=g.target_member_id WHERE g.item_type<>'decision' ORDER BY (g.status='open') DESC,g.created_at DESC LIMIT 200");
        const [decisionTable]=await pool.query("SHOW TABLES LIKE 'sovereign_governance_decisions'");
        if(decisionTable.length){
          [decisions]=await pool.execute('SELECT d.id,d.decision_title,d.decision_details,d.created_at,m.full_name,m.username FROM sovereign_governance_decisions d JOIN members m ON m.id=d.recorded_by ORDER BY d.created_at DESC LIMIT 100');
        } else {
          decisions=[];
        }
      } else if(['title','created_by','subject_member_id','decision_text','decided_by','decided_at'].every(c=>fields.has(c))){
        [items]=await pool.execute("SELECT g.id,g.item_type,g.title AS subject,g.details,CASE WHEN g.status='in_review' THEN 'under_review' WHEN g.status='rejected' THEN 'closed' ELSE g.status END AS status,g.created_at,g.decided_at AS reviewed_at,g.decision_text AS resolution_note,m.full_name,m.username,m.monarch_uid,t.full_name AS target_name FROM sovereign_governance_items g JOIN members m ON m.id=g.created_by LEFT JOIN members t ON t.id=g.subject_member_id WHERE g.item_type<>'decision' ORDER BY (g.status='open') DESC,g.created_at DESC LIMIT 200");
        [decisions]=await pool.execute("SELECT g.id,g.title AS decision_title,COALESCE(g.decision_text,g.details) AS decision_details,g.created_at,m.full_name,m.username FROM sovereign_governance_items g JOIN members m ON m.id=COALESCE(g.decided_by,g.created_by) WHERE g.item_type='decision' ORDER BY g.created_at DESC LIMIT 100");
      } else {
        return res.status(503).json({error:'governance_schema_required',message:'The governance table does not contain a supported column layout.'});
      }
      res.json({items,decisions});
    } catch(e) { try { deskFail(res,e); } catch(err) { next(err); } }
  });
  desk.get('/activity', async (req,res,next) => {
    try {
      const [signals]=await pool.execute('SELECT id,title,status,updated_at FROM sovereign_signals ORDER BY updated_at DESC LIMIT 20');
      const [guidance]=await pool.execute('SELECT id,title,status,updated_at FROM sovereign_guidance ORDER BY updated_at DESC LIMIT 20');
      const [access]=await pool.execute('SELECT a.member_id,a.status,a.updated_at,m.full_name,m.monarch_uid FROM sovereign_desk_access a JOIN members m ON m.id=a.member_id ORDER BY a.updated_at DESC LIMIT 30');
      res.json({items:[...signals.map(x=>({...x,kind:'Signal',name:x.title})),...guidance.map(x=>({...x,kind:'Guidance',name:x.title})),...access.map(x=>({...x,kind:'Member access',name:(x.full_name||x.monarch_uid)+' · '+x.monarch_uid}))].sort((a,b)=>new Date(b.updated_at)-new Date(a.updated_at)).slice(0,60)});
    } catch(e) { try { deskFail(res,e); } catch(err) { next(err); } }
  });
  desk.get('/chat', async (req,res,next) => {
    try {
      const [items]=await pool.execute("SELECT m.member_id,mem.full_name,mem.username,MAX(m.created_at) last_message,SUM(CASE WHEN m.sender_role='member' AND m.seen_at IS NULL THEN 1 ELSE 0 END) unread,SUBSTRING_INDEX(GROUP_CONCAT(m.body ORDER BY m.id DESC SEPARATOR '\\n'),'\\n',1) preview FROM sovereign_chat_messages m JOIN members mem ON mem.id=m.member_id GROUP BY m.member_id,mem.full_name,mem.username ORDER BY MAX(m.created_at) DESC LIMIT 200");
      res.json({items});
    } catch(e) { try { deskFail(res,e); } catch(err) { next(err); } }
  });
  desk.get('/chat/:memberId', async (req,res,next) => {
    if(!deskId(req.params.memberId))return res.status(400).json({error:'invalid_member_id'});
    try {
      const [[member]]=await pool.execute('SELECT id,full_name,username,monarch_uid FROM members WHERE id=? LIMIT 1',[req.params.memberId]);
      if(!member)return res.status(404).json({error:'member_not_found'});
      await pool.execute("UPDATE sovereign_chat_messages SET seen_at=CURRENT_TIMESTAMP WHERE member_id=? AND sender_role='member' AND seen_at IS NULL",[member.id]);
      const [messages]=await pool.execute('SELECT id,sender_role,body,created_at,seen_at FROM sovereign_chat_messages WHERE member_id=? ORDER BY id ASC LIMIT 500',[member.id]);
      res.json({member,messages});
    } catch(e) { try { deskFail(res,e); } catch(err) { next(err); } }
  });
  desk.post('/chat/:memberId', async (req,res,next) => {
    if(!deskId(req.params.memberId))return res.status(400).json({error:'invalid_member_id'});
    const body=deskClean(req.body.body,4000);
    if(!body)return res.status(400).json({error:'message_required'});
    try {
      const [[member]]=await pool.execute('SELECT id FROM members WHERE id=? LIMIT 1',[req.params.memberId]);
      if(!member)return res.status(404).json({error:'member_not_found'});
      await pool.execute("INSERT INTO sovereign_chat_messages (member_id,sender_role,sender_member_id,body) VALUES (?,'desk',?,?)",[member.id,req.session.memberId,body]);
      res.status(201).json({ok:true});
    } catch(e) { try { deskFail(res,e); } catch(err) { next(err); } }
  });
  router.use('/sovereign', desk);

  return router;
}

module.exports = createMobileApiRouter;
