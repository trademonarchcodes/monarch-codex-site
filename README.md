# Monarch Codex — information-only website starter

A responsive static website starter for Monarch Codex, designed for HTML/CSS/JavaScript hosting on Hostinger.

## Important launch status
This site is intentionally informational. It does **not** accept deposits, register investment accounts, promise returns, or offer a referral programme. The six dollar amounts are marked as planning concepts only because the business is still planning and not yet authorised.

Before publishing, have a qualified Nigerian securities-law professional review the proposed business model and website copy. Do not change the status notices or turn the placeholder tiers into active offers until the relevant legal and regulatory requirements have been confirmed.

## Contact details included
- Email: trademonarchofficial@gmail.com
- WhatsApp: +234 913 542 4851

## Files
- `index.html` — main landing page
- `privacy.html` — starter privacy notice; review before launch
- `terms.html` — website and planning-stage notice
- `assets/css/style.css` — responsive black-and-gold styling
- `assets/js/main.js` — navigation and email-draft form

## Logo and founder photo
The initial design uses an “MC” text monogram so the site works immediately. Replace it with your approved logo artwork and add a founder portrait only after copying the files into `assets/images/` and updating `index.html`. Avoid publishing images that you do not have rights to use.

## Test locally
Open `index.html` in a browser. The contact form opens a draft email; it does not submit form data to a server.

## Publish through GitHub and Hostinger
1. Unzip the package.
2. Create a new GitHub repository, for example `monarch-codex-site`.
3. Upload the contents of this folder to the repository root (so `index.html` is at the root, not nested in another folder).
4. In Hostinger hPanel, open the relevant website and look for **Advanced → Git** (menu names may vary by plan/interface).
5. Connect the repository and choose the branch you want to deploy, usually `main`.
6. Set the deployment directory to the website's public web root, typically `public_html`, if that is the target you intend to publish to.
7. Confirm the target directory before deploying, especially if it already contains a live website.
8. Test the site on the Hostinger preview/domain, including mobile layout, email link, WhatsApp link, privacy page and website notice.
9. Configure HTTPS/SSL in hPanel once the domain is connected.

## Domain
No domain is included. Choose and register a domain after checking availability and trademark considerations. A domain usually has a registration fee; hosting and domain registration are separate services.

## Secure KYC deployment requirements

The KYC submission route is implemented, but it remains unavailable until the following are configured on the server. Never put these values in source control or send them in chat.

- Apply `migrations/001_kyc_submissions.sql`, then `migrations/003_kyc_submission_storage.sql` to the same production database after taking a backup.
- Set `KYC_STORAGE_DIR` to an absolute directory **outside** the public web root and application folder, writable only by the Node.js process (for example, a private directory provided by your hosting plan).
- Set `KYC_ENCRYPTION_KEY` to a securely generated 32-byte key encoded as Base64. Keep a protected backup; losing it makes encrypted identity files unrecoverable. Rotate only with a planned re-encryption process.
- Deploy the updated `package.json` and run the hosting platform's dependency installation/rebuild so `multer` is installed; restart the Node.js app.
- Test with synthetic documents only first. Confirm upload rejection, session/CSRF protection, encrypted files outside the public directory, database transaction, and admin review queue at `/admin/kyc` before collecting real identity data.
- Restrict server and database backups, set a documented retention/deletion policy, publish a reviewed privacy notice, and confirm applicable privacy/legal requirements before production KYC collection.

Uploaded files are encrypted at rest with AES-256-GCM. The admin queue currently exposes submission metadata and status review only; a separately authenticated, audited document-view/download workflow and deletion/retention tooling must be completed before staff can inspect submitted images. Do not treat the KYC system as production-ready until those controls and live tests are complete.

## Android in-app updates

The Android APK is published from the private `trademonarchcodes/monarch-codex-android` repository. The public mobile API exposes a version manifest and streams the APK/checksum without exposing the GitHub credential. Configure the Hostinger environment variable `MONARCH_ANDROID_RELEASE_TOKEN` with a GitHub fine-grained token scoped to the Android repository and **Contents: read-only** (plus repository metadata read). Never put this token in source code or in the Android app. Until the variable is configured, the update endpoint returns a clear service-unavailable response and existing sign-in/dashboard functions continue to work.
