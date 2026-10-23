-- Monarch Codex: switch the Sovereign Desk administrator to hananny.provy@gmail.com.
-- Run once against the production database after taking a verified backup.
-- This does not create a member account. The target email must already belong to a registered member.
-- The login handler redirects active sovereign_desk_admin accounts to /sovereign-admin.
START TRANSACTION;

-- Revoke the previous Sovereign Desk account's admin access, if it exists.
UPDATE admin_users au
JOIN members m ON m.id = au.member_id
SET au.is_active = 0
WHERE LOWER(TRIM(m.email)) = LOWER('handsomeprovidence38@gmail.com')
  AND LOWER(TRIM(m.email)) <> LOWER('hananny.provy@gmail.com');

-- Grant the restricted Sovereign Desk role to the specified existing member account.
INSERT INTO admin_users (member_id, role, is_active)
SELECT id, 'sovereign_desk_admin', 1
FROM members
WHERE LOWER(TRIM(email)) = LOWER('hananny.provy@gmail.com')
LIMIT 1
ON DUPLICATE KEY UPDATE role = 'sovereign_desk_admin', is_active = 1;

COMMIT;

-- Run separately to verify the assignment and confirm the target account exists:
-- SELECT m.email, au.role, au.is_active
-- FROM members m
-- LEFT JOIN admin_users au ON au.member_id = m.id
-- WHERE LOWER(TRIM(m.email)) IN (
--   LOWER('hananny.provy@gmail.com'),
--   LOWER('handsomeprovidence38@gmail.com')
-- );
