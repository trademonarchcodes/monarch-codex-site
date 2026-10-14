# KYC production enablement checklist

KYC uploads must remain disabled until every gate below is complete. The member-facing `/kyc` page is currently informational only.

## Required gates

1. **Database access:** Fix Hostinger MySQL credentials and verify the application can connect using its configured DB user. Never put credentials in source control or share them in chat.
2. **Schema:** Back up the production database, inspect the existing `members` table and key types, then review and apply `migrations/001_kyc_submissions.sql`. The migration is a proposal, not an automatic deployment.
3. **Private storage:** Configure an authenticated private object store or a directory outside the app's static/public root. Do not store documents under the repository or a public uploads folder. Require TLS, least-privilege access, encryption at rest, retention/deletion controls, size limits, content-type/signature checks and random object keys.
4. **Document-number protection:** Set a dedicated random encryption key through the hosting environment/secrets manager. Use authenticated encryption (for example AES-256-GCM) with a unique nonce; never log raw document numbers or file URLs. Do not enable document-number collection until key rotation and recovery procedures are documented.
5. **Submission security:** Add authenticated, CSRF-protected POST handlers, strict server-side validation, rate limiting, duplicate/pending-submission rules and transactional writes. Store only private object keys in MySQL. Clean up orphaned uploads after failed submissions.
6. **Review authorisation:** Add an explicit server-side reviewer role/permission model; do not infer admin access from an email address or a hidden button. Require MFA for reviewers where supported, audit submission access and all decisions, and restrict document retrieval to authorised reviewers.
7. **Privacy and testing:** Publish the privacy notice and retention period, test with dummy documents, verify access denial for other members and unauthorised admins, and confirm backups/restore and deletion before enabling production uploads.

## Go-live rule

Do not expose an upload form or accept identity files until gates 1–7 have been verified. The existing migration alone does not make KYC operational, and a successful page load is not proof that storage or review controls work.
