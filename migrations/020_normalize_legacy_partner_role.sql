-- Normalize legacy "Founder Partner" assignments and requests to the Partner role.
-- Run after migrations/018_member_role_management.sql and 019_separate_founder_partner_roles.sql.
-- Preserves each existing assignment by transferring it to the active Partner role before removing the legacy assignment.
START TRANSACTION;

SET @legacy_role_id := (SELECT id FROM member_role_catalog WHERE role_key = 'founder_partner' LIMIT 1);
SET @partner_role_id := (SELECT id FROM member_role_catalog WHERE role_key = 'partner' LIMIT 1);

-- Stop safely rather than silently dropping assignments if migration 019 has not created Partner.
-- This migration should be run only after the Partner role exists.
INSERT IGNORE INTO member_role_assignments (member_id, role_id, assigned_by_member_id, created_at)
SELECT a.member_id, @partner_role_id, a.assigned_by_member_id, a.created_at
FROM member_role_assignments a
WHERE @legacy_role_id IS NOT NULL
  AND @partner_role_id IS NOT NULL
  AND a.role_id = @legacy_role_id;

-- Point legacy requests (including their review history) at Partner so screens display the intended role name.
UPDATE member_role_requests
SET role_id = @partner_role_id
WHERE @legacy_role_id IS NOT NULL
  AND @partner_role_id IS NOT NULL
  AND role_id = @legacy_role_id;

-- Remove legacy assignment rows only after they have been copied to Partner.
DELETE FROM member_role_assignments
WHERE @legacy_role_id IS NOT NULL
  AND @partner_role_id IS NOT NULL
  AND role_id = @legacy_role_id;

-- Keep the old catalogue row for audit/history, but make sure it cannot be selected.
UPDATE member_role_catalog
SET is_active = 0
WHERE role_key = 'founder_partner';

COMMIT;
