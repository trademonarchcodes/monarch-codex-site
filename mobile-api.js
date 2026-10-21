'use strict';

const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const rateLimit = require('express-rate-limit');

function createMobileApiRouter({ pool, bcrypt, sendAppEmail, appBaseUrl, depositProofUpload, decryptProfileValue, loginLimiter: sharedLoginLimiter, registrationLimiter: sharedRegistrationLimiter }) {
  const router = express.Router();
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
    } catch (error) { return next(error); }
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
        member: { ...publicMember(member), ...(await memberAccess(member.id)) },
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


  // Native transaction APIs reuse the same database ledger and review queues as the website.
  // They never credit a wallet merely because a member submits a request.
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

  router.get('/admin/reviews/:type', noStore, apiAuth, requireMobileAdmin, async (req,res,next) => {
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

  router.post('/admin/reviews/kyc/:id', noStore, apiAuth, requireMobileAdmin, async (req,res,next) => {
    const id=String(req.params.id||''), status=String(req.body.status||''), note=String(req.body.note||'').trim().slice(0,1000);
    if(!/^\d{1,20}$/.test(id)||!['approved','rejected','needs_resubmission'].includes(status))return res.status(400).json({error:'invalid_review',message:'Choose a valid KYC decision.'});
    if(status!=='approved'&&!note)return res.status(400).json({error:'review_note_required',message:'Add a reason or instructions for this decision.'});
    const conn=await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [[row]]=await conn.execute('SELECT id,status FROM kyc_submissions WHERE id=? FOR UPDATE',[id]);
      if(!row){await conn.rollback();return res.status(404).json({error:'not_found',message:'KYC submission not found.'});}
      if(row.status==='approved' || row.status===status){await conn.rollback();return res.status(409).json({error:'already_reviewed',message:'This KYC submission is already approved or has this status.'});}
      await conn.execute('UPDATE kyc_submissions SET status=?,reviewer_member_id=?,reviewer_note=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=?',[status,req.session.memberId,note||null,id]);
      await conn.execute('INSERT INTO kyc_review_events (submission_id,actor_member_id,event_type,note) VALUES (?,?,?,?)',[id,req.session.memberId,status,note||null]);
      await adminAudit(conn,req.session.memberId,'kyc.'+status,'kyc_submission',id,{status,note},req.ip);
      await conn.commit();
      return res.json({ok:true,id:Number(id),status,message:'KYC review saved.'});
    } catch(e) { try{await conn.rollback();}catch(_){} if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).json({error:'kyc_setup_required',message:'KYC review tables are not configured.'}); return next(e); }
    finally {conn.release();}
  });

  router.post('/admin/reviews/deposits/:id', noStore, apiAuth, requireMobileFinanceAdmin, async (req,res,next) => {
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
      await conn.commit();
      return res.json({ok:true,id:Number(id),status:decision,message:decision==='approved'?'Deposit approved and credited.':'Deposit rejected.'});
    } catch(e) {try{await conn.rollback();}catch(_){} if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).json({error:'deposit_setup_required',message:'Deposit workflow tables are not configured.'}); return next(e);}
    finally{conn.release();}
  });

  router.post('/admin/reviews/withdrawals/:id', noStore, apiAuth, requireMobileFinanceAdmin, async (req,res,next) => {
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
      await conn.commit();
      return res.json({ok:true,id:Number(id),status:decision,message:decision==='paid'?'Withdrawal marked paid after transfer confirmation.':'Withdrawal review saved.'});
    } catch(e) {try{await conn.rollback();}catch(_){} if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).json({error:'withdrawal_setup_required',message:'Withdrawal workflow tables are not configured.'}); if(e.code==='ER_DUP_ENTRY')return res.status(409).json({error:'duplicate_payment_reference',message:'That transfer reference has already been used.'}); return next(e);}
    finally{conn.release();}
  });

  router.get('/admin/audit-events', noStore, apiAuth, requireMobileAdmin, async (req,res,next) => {
    try {
      const [rows]=await pool.query('SELECT l.action,l.target_type,l.target_id,l.details,l.ip_address,l.created_at,m.username FROM admin_audit_log l JOIN members m ON m.id=l.admin_member_id ORDER BY l.created_at DESC LIMIT 200');
      return res.json({events:rows});
    } catch(e) {if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).json({error:'audit_setup_required',message:'Audit logging is not configured.'});next(e);}
  });
  router.get('/admin/analytics', noStore, apiAuth, requireMobileAdmin, async (req,res,next) => {
    try {
      const [[members]]=await pool.query('SELECT COUNT(*) AS total FROM members');
      const [[kyc]]=await pool.query("SELECT COUNT(*) AS total,SUM(status='pending') AS pending,SUM(status='approved') AS approved,SUM(status='rejected') AS rejected FROM kyc_submissions");
      const [[deposits]]=await pool.query("SELECT COUNT(*) AS total,SUM(status='pending') AS pending,COALESCE(SUM(CASE WHEN status='approved' THEN amount ELSE 0 END),0) AS approvedAmount FROM deposit_requests");
      const [[withdrawals]]=await pool.query("SELECT COUNT(*) AS total,SUM(status='pending') AS pending,SUM(status='approved') AS approved,COALESCE(SUM(CASE WHEN status='paid' THEN amount ELSE 0 END),0) AS paidAmount FROM withdrawal_requests");
      return res.json({members:Number(members.total)||0,kyc:{total:Number(kyc.total)||0,pending:Number(kyc.pending)||0,approved:Number(kyc.approved)||0,rejected:Number(kyc.rejected)||0},deposits:{total:Number(deposits.total)||0,pending:Number(deposits.pending)||0,approvedAmount:String(deposits.approvedAmount||0)},withdrawals:{total:Number(withdrawals.total)||0,pending:Number(withdrawals.pending)||0,approved:Number(withdrawals.approved)||0,paidAmount:String(withdrawals.paidAmount||0)}});
    } catch(e) {if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).json({error:'analytics_setup_required',message:'Analytics data tables are not configured.'});next(e);}
  });
  router.get('/admin/security', noStore, apiAuth, requireMobileAdmin, async (req,res,next) => {
    try {
      const [admins]=await pool.query('SELECT a.member_id,a.role,a.is_active,a.created_at,m.username,m.full_name FROM admin_users a JOIN members m ON m.id=a.member_id ORDER BY a.created_at DESC LIMIT 100');
      const [events]=await pool.query("SELECT action,target_type,target_id,ip_address,created_at FROM admin_audit_log WHERE action LIKE '%login%' OR action LIKE '%security%' OR action LIKE '%session%' ORDER BY created_at DESC LIMIT 100");
      return res.json({admins,securityEvents:events,session:{authenticated:true,reauthenticationAvailable:false,secondConfirmationRequired:true}});
    } catch(e) {if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).json({error:'security_setup_required',message:'Security records are not configured.'});next(e);}
  });

  router.get('/admin/overview', noStore, apiAuth, requireMobileAdmin, async (req, res, next) => {
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
      const [roles]=await pool.query('SELECT r.id,r.role_key,r.role_name,r.description,a.id AS assignment_id FROM member_role_catalog r LEFT JOIN member_role_assignments a ON a.role_id=r.id AND a.member_id=? WHERE r.is_active=1 AND LOWER(r.role_key)<>'founder' AND LOWER(r.role_name)<>'founder' ORDER BY r.role_name',[req.session.memberId]);
      const [requests]=await pool.execute('SELECT q.id,q.role_id,q.status,q.message,q.created_at,r.role_name FROM member_role_requests q JOIN member_role_catalog r ON r.id=q.role_id WHERE q.member_id=? ORDER BY q.created_at DESC LIMIT 30',[req.session.memberId]);
      res.json({roles:roles.map(r=>({...r,assigned:Boolean(r.assignment_id)})),requests});
    } catch(e) { if(e.code==='ROLE_MIGRATION_REQUIRED')return res.status(503).json({error:'role_setup_required',message:e.message}); next(e); }
  });
  router.post('/roles/request', noStore, apiAuth, async (req,res,next) => {
    try {
      await requireRoleTables();
      const roleId=Number(req.body.roleId), message=String(req.body.message||'').trim().slice(0,1000);
      if(!Number.isSafeInteger(roleId)||roleId<1)return res.status(400).json({error:'invalid_role'});
      const [[role]]=await pool.execute('SELECT id FROM member_role_catalog WHERE id=? AND is_active=1 AND LOWER(role_key)<>'founder' AND LOWER(role_name)<>'founder' LIMIT 1',[roleId]);
      if(!role)return res.status(404).json({error:'role_unavailable'});
      const [[assigned]]=await pool.execute('SELECT id FROM member_role_assignments WHERE member_id=? AND role_id=? LIMIT 1',[req.session.memberId,roleId]);
      if(assigned)return res.status(409).json({error:'already_assigned',message:'This role is already assigned.'});
      const [[pending]]=await pool.execute("SELECT id FROM member_role_requests WHERE member_id=? AND role_id=? AND status='pending' LIMIT 1",[req.session.memberId,roleId]);
      if(pending)return res.status(409).json({error:'request_pending',message:'A request for this role is already pending.'});
      const [result]=await pool.execute("INSERT INTO member_role_requests (member_id,role_id,request_source,message,status) VALUES (?,?,'member',?,'pending')",[req.session.memberId,roleId,message||null]);
      res.status(201).json({ok:true,requestId:result.insertId,status:'pending'});
    } catch(e) { if(e.code==='ROLE_MIGRATION_REQUIRED')return res.status(503).json({error:'role_setup_required',message:e.message}); next(e); }
  });

  router.get('/admin/roles', noStore, apiAuth, roleAdmin, async (req,res,next) => {
    try {
      await requireRoleTables();
      const [roles]=await pool.query('SELECT r.id,r.role_key,r.role_name,r.description,r.is_active,COUNT(a.id) AS assigned_count FROM member_role_catalog r LEFT JOIN member_role_assignments a ON a.role_id=r.id GROUP BY r.id ORDER BY r.role_name');
      const [requests]=await pool.query("SELECT q.id,q.member_id,q.request_source,q.company_name,q.message,q.created_at,r.role_name,m.full_name,m.email,m.monarch_uid FROM member_role_requests q JOIN member_role_catalog r ON r.id=q.role_id JOIN members m ON m.id=q.member_id WHERE q.status='pending' ORDER BY q.created_at ASC LIMIT 200");
      const [members]=await pool.query('SELECT id,full_name,email,monarch_uid FROM members ORDER BY id DESC LIMIT 200');
      const [assignments]=await pool.query('SELECT a.member_id,a.role_id,r.role_name FROM member_role_assignments a JOIN member_role_catalog r ON r.id=a.role_id ORDER BY a.member_id DESC,r.role_name');
      res.json({roles,requests,members,assignments});
    } catch(e) { if(e.code==='ROLE_MIGRATION_REQUIRED')return res.status(503).json({error:'role_setup_required',message:e.message}); next(e); }
  });
  router.post('/admin/roles/catalog', noStore, apiAuth, roleAdmin, async (req,res,next) => {
    try {
      await requireRoleTables();
      const id=Number(req.body.roleId||0), name=String(req.body.roleName||'').trim(), description=String(req.body.description||'').trim().slice(0,500), key=roleKey(name), active=req.body.isActive===false?0:1;
      if(!name||name.length>100||!key)return res.status(400).json({error:'invalid_role_name'});\n      if(key==='founder')return res.status(403).json({error:'founder_reserved',message:'Founder is reserved exclusively for the Monarch Codex Super Admin and cannot be created as a member role.'});
      if(id) await pool.execute('UPDATE member_role_catalog SET role_key=?,role_name=?,description=?,is_active=? WHERE id=?',[key,name,description||null,active,id]);
      else await pool.execute('INSERT INTO member_role_catalog (role_key,role_name,description,is_active,created_by_member_id) VALUES (?,?,?,1,?)',[key,name,description||null,req.session.memberId]);
      res.json({ok:true});
    } catch(e) { if(e.code==='ER_DUP_ENTRY')return res.status(409).json({error:'duplicate_role',message:'Role names and keys must be unique.'}); if(e.code==='ROLE_MIGRATION_REQUIRED')return res.status(503).json({error:'role_setup_required',message:e.message}); next(e); }
  });
  router.post('/admin/roles/requests/:requestId', noStore, apiAuth, roleAdmin, async (req,res,next) => {
    try {
      await requireRoleTables();
      const id=Number(req.params.requestId), decision=String(req.body.decision||'');
      if(!Number.isSafeInteger(id)||id<1||!['approve','reject'].includes(decision))return res.status(400).json({error:'invalid_decision'});
      const connection=await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [[request]]=await connection.execute("SELECT id,member_id,role_id,status FROM member_role_requests WHERE id=? FOR UPDATE",[id]);
        if(!request||request.status!=='pending'){await connection.rollback();return res.status(409).json({error:'already_reviewed'});}
        if(decision==='approve')await connection.execute('INSERT IGNORE INTO member_role_assignments (member_id,role_id,assigned_by_member_id) VALUES (?,?,?)',[request.member_id,request.role_id,req.session.memberId]);
        await connection.execute('UPDATE member_role_requests SET status=?,reviewed_by_member_id=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=?',[decision==='approve'?'approved':'rejected',req.session.memberId,id]);
        await connection.commit();
      } catch(e) { await connection.rollback(); throw e; } finally { connection.release(); }
      res.json({ok:true,status:decision==='approve'?'approved':'rejected'});
    } catch(e) { if(e.code==='ROLE_MIGRATION_REQUIRED')return res.status(503).json({error:'role_setup_required',message:e.message}); next(e); }
  });
  router.post('/admin/roles/assign', noStore, apiAuth, roleAdmin, async (req,res,next) => {
    try {
      await requireRoleTables();
      const memberId=Number(req.body.memberId), roleId=Number(req.body.roleId), action=String(req.body.action||'assign');
      if(!Number.isSafeInteger(memberId)||memberId<1||!Number.isSafeInteger(roleId)||roleId<1||!['assign','remove'].includes(action))return res.status(400).json({error:'invalid_assignment'});
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
    } catch(e) { if(e.code==='ER_NO_SUCH_TABLE') return res.status(503).json({error:'notification_setup_required',message:'Apply migrations/005_member_dashboard_and_sovereign_desk.sql first.'}); next(e); }
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

  const requireSuperAdmin = async (req,res,next) => {
    try {
      const [[admin]]=await pool.execute('SELECT role FROM admin_users WHERE member_id=? AND is_active=1 LIMIT 1',[req.session.memberId]);
      if(!admin||String(admin.role)!=='super_admin')return res.status(403).json({error:'super_admin_required',message:'Only the Monarch Codex Super Admin can perform this action.'});
      req.platformSuperAdmin=true; next();
    } catch(e) { next(e); }
  };
  const auditPlatformAction = async (actor,action,targetType,targetId,details={}) => {
    await pool.execute('INSERT INTO platform_action_audit (actor_member_id,action_key,target_type,target_id,details) VALUES (?,?,?,?,?)',
      [actor,action,targetType||null,targetId==null?null:String(targetId),JSON.stringify(details)]);
  };

  // Online Cooperative is manually verified with the cooperative administrator; no external account credentials are requested.
  router.get('/cooperative/status', noStore, apiAuth, async (req,res,next) => {
    try {
      const [items]=await pool.execute('SELECT id,registered_name AS registeredName,registered_email AS registeredEmail,status,review_note AS reviewNote,created_at AS createdAt,reviewed_at AS reviewedAt FROM online_cooperative_connections WHERE member_id=? ORDER BY created_at DESC LIMIT 10',[req.session.memberId]);
      res.json({registrationUrl:'https://airdrop.myturntech.com/register?ref=53',items,connection:items.find(x=>x.status==='approved')||null});
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
      const [items]=await pool.query("SELECT p.id,p.member_id AS memberId,p.body,p.post_type AS type,p.created_at AS createdAt,m.full_name AS authorName,m.username AS authorUsername,(SELECT COUNT(*) FROM community_comments c WHERE c.post_id=p.id AND c.status='published') AS commentCount FROM community_posts p JOIN members m ON m.id=p.member_id WHERE p.status='published' ORDER BY p.created_at DESC LIMIT 100");
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
      res.status(201).json({ok:true,id:result.insertId,status,message:status==='pending'?'Submitted for admin approval before publication.':'Your post is now published.'});
    } catch(e) { if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).json({error:'community_setup_required'}); next(e); }
  });
  router.get('/community/posts/:id/comments', noStore, apiAuth, async (req,res,next) => {
    const id=Number(req.params.id); if(!Number.isSafeInteger(id)||id<1)return res.status(400).json({error:'invalid_post_id'});
    try {
      const [[post]]=await pool.execute("SELECT id FROM community_posts WHERE id=? AND status='published'",[id]);
      if(!post)return res.status(404).json({error:'post_not_found'});
      const [items]=await pool.execute("SELECT c.id,c.body,c.created_at AS createdAt,m.full_name AS authorName,m.username AS authorUsername FROM community_comments c JOIN members m ON m.id=c.member_id WHERE c.post_id=? AND c.status='published' ORDER BY c.created_at ASC LIMIT 200",[id]);
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
  router.post('/community/posts/:id/report', noStore, apiAuth, async (req,res,next) => {
    const id=Number(req.params.id), reason=String(req.body.reason||'').trim().slice(0,1000);
    if(!Number.isSafeInteger(id)||id<1||reason.length<3)return res.status(400).json({error:'invalid_report'});
    try {
      const [[post]]=await pool.execute("SELECT id FROM community_posts WHERE id=? AND status='published'",[id]);
      if(!post)return res.status(404).json({error:'post_not_found'});
      await pool.execute('INSERT INTO community_reports (post_id,reporter_member_id,reason) VALUES (?,?,?)',[id,req.session.memberId,reason]);
      res.status(201).json({ok:true});
    } catch(e) { if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).json({error:'community_setup_required'}); next(e); }
  });
  router.get('/admin/community/review-queue', noStore, apiAuth, requireMobileAdmin, async (req,res,next) => {
    try {
      const [items]=await pool.query("SELECT p.id,p.member_id AS memberId,p.body,p.post_type AS type,p.status,p.created_at AS createdAt,m.full_name AS authorName,m.email FROM community_posts p JOIN members m ON m.id=p.member_id WHERE p.status='pending' ORDER BY p.created_at ASC LIMIT 200");
      const [reports]=await pool.query("SELECT r.id,r.post_id AS postId,r.reason,r.created_at AS createdAt,m.full_name AS reporterName FROM community_reports r JOIN members m ON m.id=r.reporter_member_id WHERE r.status='pending' ORDER BY r.created_at ASC LIMIT 200");
      res.json({items,reports});
    } catch(e) { if(e.code==='ER_NO_SUCH_TABLE')return res.status(503).json({error:'community_setup_required'}); next(e); }
  });
  router.post('/admin/community/posts/:id/review', noStore, apiAuth, requireMobileAdmin, async (req,res,next) => {
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

  return router;
}

module.exports = createMobileApiRouter;
