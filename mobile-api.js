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
      await pool.execute('UPDATE members SET full_name=?,username=?,email=? WHERE id=?',[fullName,username,email,req.session.memberId]);
      await pool.execute('INSERT INTO member_profiles (member_id,phone_number) VALUES (?,?) ON DUPLICATE KEY UPDATE phone_number=VALUES(phone_number)',[req.session.memberId,phone||null]);
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
      const [roles]=await pool.query('SELECT r.id,r.role_key,r.role_name,r.description,a.id AS assignment_id FROM member_role_catalog r LEFT JOIN member_role_assignments a ON a.role_id=r.id AND a.member_id=? WHERE r.is_active=1 ORDER BY r.role_name',[req.session.memberId]);
      const [requests]=await pool.execute('SELECT q.id,q.role_id,q.status,q.message,q.created_at,r.role_name FROM member_role_requests q JOIN member_role_catalog r ON r.id=q.role_id WHERE q.member_id=? ORDER BY q.created_at DESC LIMIT 30',[req.session.memberId]);
      res.json({roles:roles.map(r=>({...r,assigned:Boolean(r.assignment_id)})),requests});
    } catch(e) { if(e.code==='ROLE_MIGRATION_REQUIRED')return res.status(503).json({error:'role_setup_required',message:e.message}); next(e); }
  });
  router.post('/roles/request', noStore, apiAuth, async (req,res,next) => {
    try {
      await requireRoleTables();
      const roleId=Number(req.body.roleId), message=String(req.body.message||'').trim().slice(0,1000);
      if(!Number.isSafeInteger(roleId)||roleId<1)return res.status(400).json({error:'invalid_role'});
      const [[role]]=await pool.execute('SELECT id FROM member_role_catalog WHERE id=? AND is_active=1 LIMIT 1',[roleId]);
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
      res.json({roles,requests,members});
    } catch(e) { if(e.code==='ROLE_MIGRATION_REQUIRED')return res.status(503).json({error:'role_setup_required',message:e.message}); next(e); }
  });
  router.post('/admin/roles/catalog', noStore, apiAuth, roleAdmin, async (req,res,next) => {
    try {
      await requireRoleTables();
      const id=Number(req.body.roleId||0), name=String(req.body.roleName||'').trim(), description=String(req.body.description||'').trim().slice(0,500), key=roleKey(name), active=req.body.isActive===false?0:1;
      if(!name||name.length>100||!key)return res.status(400).json({error:'invalid_role_name'});
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
      if(!admin||admin.role!=='sovereign_desk_admin')return res.status(403).json({error:'forbidden',message:'Only the Sovereign Desk administrator can submit a company Founder Partner request.'});
      await requireRoleTables();
      const [[role]]=await pool.execute("SELECT id FROM member_role_catalog WHERE role_key='founder_partner' AND is_active=1 LIMIT 1");
      if(!role)return res.status(409).json({error:'founder_partner_unavailable'});
      const companyName=String(req.body.companyName||'Sovereign Desk').trim().slice(0,160), message=String(req.body.message||'Company role request').trim().slice(0,1000);
      const [[pending]]=await pool.execute("SELECT id FROM member_role_requests WHERE member_id=? AND role_id=? AND status='pending' AND request_source='sovereign_desk' LIMIT 1",[req.session.memberId,role.id]);
      if(!pending)await pool.execute("INSERT INTO member_role_requests (member_id,role_id,request_source,company_name,message,status) VALUES (?,?, 'sovereign_desk',?,?,'pending')",[req.session.memberId,role.id,companyName,message]);
      res.status(201).json({ok:true,status:'pending'});
    } catch(e) { if(e.code==='ROLE_MIGRATION_REQUIRED')return res.status(503).json({error:'role_setup_required',message:e.message}); next(e); }
  });

  return router;
}

module.exports = createMobileApiRouter;
