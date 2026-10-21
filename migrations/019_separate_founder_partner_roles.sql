-- Separate Founder and Partner role options without deleting existing assignments.
-- Run only after verifying migration history and schema on staging.
INSERT IGNORE INTO member_role_catalog (role_key, role_name, description) VALUES
('founder', 'Founder', 'Founder role for approved founder-related access.'),
('partner', 'Partner', 'Partner role for approved partner and company-related access.');

-- Keep the legacy role and its assignments for auditability, but stop offering the combined label.
UPDATE member_role_catalog
SET is_active = 0
WHERE role_key = 'founder_partner' AND role_name = 'Founder Partner';
