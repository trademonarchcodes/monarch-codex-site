# Admin backend rollout

This is a staged security foundation, not a live admin login yet.

## Roles
- super_admin: intended for the verified owner; full administrative capabilities once those features are implemented.
- limited_admin: restricted operational access; must not be able to change admin roles, security settings, or payout/payment configuration.

**Email addresses are identifiers, not proof of authority.** The two intended inboxes are tradem onarchofficial@gmail.com and handsomeprovidence38@gmail.com (remove the space in the first address if copying from this document). This migration creates no accounts and grants no privileges. Do not insert active users manually based only on an email address.

## Before enabling admin routes
1. Back up the production database.
2. Fix and verify Hostinger's DB connection privately in its environment-variable panel. Never commit DB credentials.
3. Apply migrations/002_admin_access_control.sql to the correct database.
4. Implement a one-time invitation/activation flow with random, single-use, expiring tokens sent to the intended inbox. Store only token hashes; do not log tokens.
5. Require a strong password (bcrypt hash), rotate the session on login, use CSRF protection and rate limiting, and record security-sensitive actions in admin_audit_events.
6. Enforce permissions server-side on every route/action. Hiding buttons in HTML is not access control.
7. Verify both inboxes by completing their separate invitation links before activating the accounts. Add MFA before enabling sensitive financial actions.
8. Test access denial for unauthenticated users, ordinary members, limited admins, suspended admins, and expired/reused invitation tokens.

## Current limitations
- This migration is schema only; it does not create admin accounts or expose /admin.
- KYC document uploads and deposit/withdrawal approval must remain disabled until private storage, permission checks, audit events, and a tested transaction ledger are in place.
- Do not paste passwords, one-time links, tokens, or database secrets into chat or GitHub.
