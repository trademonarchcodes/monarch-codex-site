-- Monarch Codex: assign the two requested administrator access levels.
-- Apply only after confirming both email addresses belong to the intended member accounts.
-- Requires migration 005 (admin_users.role includes main_admin and sovereign_desk_admin).
-- The dedicated Sovereign Desk HTML workspace is still subject to requireAdmin + role checks.
START TRANSACTION;

-- Main administrator: full main admin dashboard and Sovereign Desk access.
INSERT INTO admin_users (member_id, role, is_active)
SELECT id, 'main_admin', 1
FROM members
WHERE LOWER(TRIM(email)) = LOWER('trademonarchofficial@gmail.com')
LIMIT 1
ON DUPLICATE KEY UPDATE role = 'main_admin', is_active = 1;

-- Sovereign Desk administrator: Sovereign Desk only, no main admin permissions.
INSERT INTO admin_users (member_id, role, is_active)
SELECT id, 'sovereign_desk_admin', 1
FROM members
WHERE LOWER(TRIM(email)) = LOWER('handsomeprovidence38@gmail.com')
LIMIT 1
ON DUPLICATE KEY UPDATE role = 'sovereign_desk_admin', is_active = 1;

COMMIT;

-- Verification (run separately after applying):
-- SELECT m.email, au.role, au.is_active
-- FROM members m JOIN admin_users au ON au.member_id = m.id
-- WHERE LOWER(TRIM(m.email)) IN (
--   LOWER('trademonarchofficial@gmail.com'),
--   LOWER('handsomeprovidence38@gmail.com')
-- );
