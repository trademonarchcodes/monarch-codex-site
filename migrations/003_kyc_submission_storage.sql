-- Apply after migrations/001_kyc_submissions.sql. Back up the database first.
ALTER TABLE kyc_submissions
  ADD COLUMN street_address VARCHAR(240) NOT NULL DEFAULT '' AFTER locality_lga;
