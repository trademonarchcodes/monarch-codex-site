# Monarch Codex Network deployment runbook

This feature uses the existing Hostinger Node.js application and MySQL database. It does not use Supabase.

## Before deployment

1. Confirm the Hostinger site is connected to the intended Git branch and that the app's production environment variables are preserved.
2. Take a full backup of the production MySQL database and verify that the backup can be restored.
3. Confirm the existing migrations for the public Monarchs profile and member roles have been applied:
   - `migrations/013_monarchs_directory.sql`
   - `migrations/018_member_role_management.sql`
4. Confirm the MySQL server supports recursive CTEs (MySQL 8.0+ or a compatible MariaDB release).
5. Confirm `PROFILE_UPLOAD_DIR` is configured as an absolute private directory outside the deployed application directory. The existing profile-photo workflow and new admin photo upload use this directory.

## Database migration

After the backup, apply `migrations/022_monarch_network_leaderboards.sql` once using the Hostinger MySQL database tooling.

The migration:
- Adds profile biography and publication state fields.
- Backfills immutable original sponsor relationships from `members.referred_by`.
- Creates profile revision and network audit tables.
- Creates monthly leaderboard archive storage.
- Does not update wallet balances, transactions, investments, withdrawals, KYC decisions, or admin permission records.

Do not deploy the updated registration handler before this migration is complete. New registrations write their original sponsor to `monarch_referral_relationships`; if that write fails, the new account insert is rolled back.

## Website rollout

Deploy the website branch only after the migration succeeds. Verify:

- `/` displays the Network preview and leaderboard links.
- `/network` is public and shows the Founder at the root.
- `/leaderboard?period=monthly` resets by calendar month.
- `/leaderboard?period=all_time` is cumulative.
- `/network/profile` accepts member profile revisions.
- `/admin/network` is restricted to Super Admin / Main Admin.
- `/admin/network/leaderboard` is restricted to Super Admin / Main Admin.
- `/sovereign-admin/leaderboard` is read-only for authorized Sovereign Desk admins.
- `/api/public-network` and `/api/public-leaderboard` return public fields only.
- A test registration with a referral code creates the matching immutable sponsor record.

## Android rollout

After the website API is live, merge/build the Android branch and publish the signed APK through the existing release workflow. Do not publish the app update before the website endpoints are live; the new native Network and Leaderboard screens depend on them.

Verify the signed APK checksum and install on a test device before making it the member-facing update.

## Rollback

If the website deployment fails, revert the application code to the previous release. Keep the additive tables and referral history intact; do not drop the migration tables as part of a routine rollback. Restore the database backup only if the migration itself damaged existing data and after reviewing the failure.
