-- Allow the same member to hold one free-event request and one paid signal-access record.
-- Run during a maintenance window after checking for duplicate (member_id, access_type) pairs.
ALTER TABLE sovereign_signal_access DROP INDEX uq_sovereign_signal_access_member;
ALTER TABLE sovereign_signal_access ADD UNIQUE KEY uq_sovereign_signal_access_member_type (member_id, access_type);
