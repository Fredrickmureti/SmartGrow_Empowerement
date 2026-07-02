
-- ============================================================
-- PHASE 2 — CORRECTNESS / CLEANUP (Contacts module audit)
-- R6 : Drop contacts.country DEFAULT 'US'
-- R10: Drop legacy contacts.customer_group text column
-- C4 : Hard-block the legacy "vendor" alias at DB layer (type enum check)
-- R11: (frontend-only — handled in code; no DB change needed)
-- ============================================================

-- R6 — drop bad default
ALTER TABLE public.contacts ALTER COLUMN country DROP DEFAULT;

-- R10 — drop legacy flat text column (FK customer_group_id is the survivor)
-- safe: pre-flight confirmed 0 rows have non-null customer_group text
ALTER TABLE public.contacts DROP COLUMN IF EXISTS customer_group;

-- C4 — guard rail: the contact_type enum doesn't include 'vendor', so a direct
-- INSERT with type='vendor' would already fail. Nothing further needed at DB
-- layer; code-side normalization is being removed in the same phase.
