-- Monarch Codex KYC schema proposal.
-- Review the existing production schema and take a verified backup before applying.
-- This migration is intentionally not auto-run by server.js.
CREATE TABLE IF NOT EXISTS kyc_submissions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  member_id BIGINT UNSIGNED NOT NULL,
  legal_full_name VARCHAR(160) NOT NULL,
  date_of_birth DATE NOT NULL,
  country_code CHAR(2) NOT NULL,
  state_region VARCHAR(120) NOT NULL,
  locality_lga VARCHAR(120) NOT NULL,
  phone_number VARCHAR(32) NOT NULL,
  contact_email VARCHAR(254) NOT NULL,
  document_type VARCHAR(48) NOT NULL,
  document_issuer_country CHAR(2) NOT NULL,
  document_number_ciphertext TEXT NOT NULL,
  document_number_last4 VARCHAR(4) NOT NULL,
  document_front_private_key VARCHAR(255) NOT NULL,
  document_back_private_key VARCHAR(255) NULL,
  selfie_private_key VARCHAR(255) NOT NULL,
  status ENUM('pending','approved','rejected','needs_resubmission') NOT NULL DEFAULT 'pending',
  reviewer_member_id BIGINT UNSIGNED NULL,
  reviewer_note VARCHAR(1000) NULL,
  submitted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at TIMESTAMP NULL DEFAULT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_kyc_member_status (member_id, status),
  KEY idx_kyc_status_submitted (status, submitted_at),
  KEY idx_kyc_reviewer (reviewer_member_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Keep a separate append-only review/audit trail; never log full document numbers or image URLs.
CREATE TABLE IF NOT EXISTS kyc_review_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  submission_id BIGINT UNSIGNED NOT NULL,
  actor_member_id BIGINT UNSIGNED NOT NULL,
  event_type ENUM('submitted','approved','rejected','needs_resubmission','resubmitted','document_viewed') NOT NULL,
  note VARCHAR(1000) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_kyc_events_submission (submission_id, created_at),
  KEY idx_kyc_events_actor (actor_member_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
