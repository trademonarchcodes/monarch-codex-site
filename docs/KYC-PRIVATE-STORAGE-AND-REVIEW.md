# KYC private storage and admin review deployment

## Current status
The KYC schema in `migrations/001_kyc_submissions.sql` is a proposal and is not automatically applied. KYC collection and reviewer routes must remain disabled until the database, private storage, encryption key, and reviewer authorization are configured and tested.

## Private storage requirements
- Set `KYC_STORAGE_DIR` to a persistent directory outside the website/repository directory served by Express (for example, a dedicated private directory in the Node app's writable persistent storage).
- The deployment operator must verify the directory persists across app restarts/redeploys and is not served by Hostinger's web server, a public URL, or `express.static`.
- Restrict directory permissions to the Node application account (target mode 0700 for the directory and 0600 for files where supported).
- Do not commit uploads, store them in the Git repository, or use public URLs.
- Set `KYC_ENCRYPTION_KEY` to a randomly generated 32-byte key stored only in the hosting environment's secret configuration. Never commit or send it in chat. Back it up securely; losing it makes encrypted document numbers unreadable.
- Configure a written retention/deletion policy and privacy notice/consent before collecting ID documents and selfies.
- Enforce upload size limits, allowlisted file types, content inspection, random server-generated filenames, authenticated download routes, role-based review authorization, CSRF protection, rate limits, and audit events. Never log full ID numbers or image contents.

## Admin review requirements
The reviewer dashboard must only be accessible to explicitly authorized administrator accounts, with authorization checked on every server request (not only by hiding links). Admins should see pending submissions, minimal identity details, and private document previews served through authenticated routes. Approve/reject actions must require CSRF protection, a reviewer note, and append-only audit events. Never grant admin rights solely because a user email matches a string.

## Go-live checklist
1. Verify Hostinger's Node.js app filesystem is persistent and writable at the configured private path, and confirm that path cannot be reached over HTTP.
2. Back up the production database and review the proposed schema against the actual `members` table and SQL permissions.
3. Apply the migration manually only after review.
4. Configure storage directory, encryption key, and explicit reviewer account IDs/roles in hosting environment variables.
5. Install and lock the selected multipart-upload dependency; test file signature validation and oversized uploads.
6. Test member submission, private preview authorization, approval/rejection, audit events, retention/deletion, and restore from backup in staging.
7. Obtain a Nigeria NDPA/privacy review before collecting government IDs and selfies.

## Important limitations
A selfie photo alone does not prove liveness or prevent spoofing. If reliable liveness checks are required, integrate a dedicated identity-verification provider. Do not collect BVN as if it were a photo ID; handle it as a separate high-sensitivity verification identifier only if there is a documented need and lawful basis.
