'use strict';

/**
 * Credit a fee to the active Super Admin's combined wallet and write a distinct,
 * idempotent audit row plus a normal financial transaction. Call inside the
 * caller's existing SQL transaction so fee revenue cannot separate from the
 * transaction that generated it.
 */
async function creditAdminFee(executor, { payerMemberId, feeType, currency, amount, sourceReference, description }) {
  const fee = Number(amount);
  const code = String(currency || '').toUpperCase();
  if (!Number.isFinite(fee) || fee <= 0) return { credited: false, reason: 'zero_fee' };
  if (!['NGN', 'USD'].includes(code)) throw new Error('Unsupported admin fee currency');
  if (!/^[a-z0-9_-]{1,40}$/i.test(String(feeType || ''))) throw new Error('Invalid admin fee type');
  const ref = String(sourceReference || '').trim();
  if (!ref || ref.length > 120) throw new Error('Invalid admin fee source reference');

  const [[admin]] = await executor.execute(
    "SELECT member_id FROM admin_users WHERE role='super_admin' AND is_active=1 ORDER BY member_id ASC LIMIT 1 FOR UPDATE"
  );
  if (!admin) throw new Error('No active Super Admin is configured to receive platform fees');
  const adminId = Number(admin.member_id);
  await executor.execute(
    'INSERT IGNORE INTO member_wallets (member_id,currency,balance) VALUES (?,?,0)',
    [adminId, code]
  );
  const [ledger] = await executor.execute(
    'INSERT IGNORE INTO admin_fee_ledger (admin_member_id,payer_member_id,fee_type,currency,amount,source_reference,description) VALUES (?,?,?,?,?,?,?)',
    [adminId, Number(payerMemberId), String(feeType), code, fee.toFixed(8), ref, String(description || feeType).slice(0, 500)]
  );
  if (ledger.affectedRows !== 1) return { credited: false, duplicate: true, adminMemberId: adminId };
  const [walletRows] = await executor.execute(
    'SELECT id FROM member_wallets WHERE member_id=? AND currency=? LIMIT 1 FOR UPDATE',
    [adminId, code]
  );
  if (!walletRows.length) throw new Error('Super Admin wallet could not be initialized');
  await executor.execute('UPDATE member_wallets SET balance=balance+? WHERE id=?', [fee.toFixed(8), walletRows[0].id]);
  const [tx] = await executor.execute(
    "INSERT INTO financial_transactions (member_id,deposit_request_id,transaction_type,currency,amount,reference,admin_note) VALUES (?,NULL,'admin_fee_revenue',?,?,?,?)",
    [adminId, code, fee.toFixed(8), 'FEE-' + ref + '-' + String(feeType).toUpperCase(), 'Admin fee revenue: ' + String(description || feeType).slice(0, 430)]
  );
  await executor.execute('UPDATE admin_fee_ledger SET admin_transaction_id=? WHERE source_reference=? AND fee_type=?', [tx.insertId, ref, String(feeType)]);
  return { credited: true, adminMemberId: adminId, transactionId: tx.insertId, amount: fee, currency: code };
}

module.exports = { creditAdminFee };
