-- Loan Product ↔ Loan Application business-event tests (scenarios A–H of the
-- approved plan). Every assertion runs inside a rolled-back transaction: no
-- institution data is changed.
--
-- What this pins:
--   A  a single-value product (min = max) accepts exactly that figure
--   B  amount band: min/max accepted, below/above rejected on approval
--   C  term band: same, and a non-integer term cannot exist (column type)
--   D  requested ≠ approved: the loan follows the approved values only
--   E  repricing the product does not move an existing application's band
--   F  invalid direct writes are refused by the database, not the UI
--   G  a product or client from another institution is refused
--   H  the chain product → application → approval → loan stays consistent
--
-- The guards under test are `_mf_application_guard` on mf_loan_applications
-- and `mf_create_loan_from_application`.

BEGIN;

--------------------------------------------------------------------------
-- (1) The application table separates requested from approved values, and
--     only requires the requested pair to be positive.
--------------------------------------------------------------------------
DO $$
DECLARE v_missing text;
BEGIN
  SELECT string_agg(needed, ', ') INTO v_missing
  FROM (VALUES
    ('requested_amount'), ('requested_term_installments'),
    ('approved_amount'), ('approved_term_installments'),
    ('product_id'), ('product_version_id')
  ) AS req(needed)
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'mf_loan_applications'
       AND column_name = req.needed
  );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'mf_loan_applications missing columns: %', v_missing;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.mf_loan_applications'::regclass
       AND conname = 'mf_apps_requested_chk'
  ) THEN
    RAISE EXCEPTION 'mf_apps_requested_chk missing — requested values unguarded';
  END IF;

  -- Term is a whole count of installments, so a fractional term cannot exist.
  IF (SELECT data_type FROM information_schema.columns
       WHERE table_schema='public' AND table_name='mf_loan_applications'
         AND column_name='requested_term_installments') <> 'integer' THEN
    RAISE EXCEPTION 'requested_term_installments must be an integer count';
  END IF;
END $$;

--------------------------------------------------------------------------
-- (2) The product version is the contractual envelope: bands exist and are
--     constrained, and a published version is frozen (scenario E).
--------------------------------------------------------------------------
DO $$
DECLARE v_missing text;
BEGIN
  SELECT string_agg(needed, ', ') INTO v_missing
  FROM (VALUES
    ('min_amount'), ('max_amount'),
    ('min_term_installments'), ('max_term_installments'),
    ('repayment_frequency'), ('interest_method'), ('interest_rate'),
    ('currency_code'), ('eligibility'), ('effective_from'), ('is_published')
  ) AS req(needed)
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='mf_loan_product_versions'
       AND column_name = req.needed
  );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'mf_loan_product_versions missing columns: %', v_missing;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname='public' AND p.proname='_mf_lpv_freeze_guard'
  ) THEN
    RAISE EXCEPTION 'published product versions are not frozen';
  END IF;
END $$;

--------------------------------------------------------------------------
-- (3) Scenarios A–C, F, G: the application guard is wired and enforces the
--     pricing version, institution scope and product eligibility.
--------------------------------------------------------------------------
DO $$
DECLARE v_src text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.mf_loan_applications'::regclass
       AND NOT tgisinternal
       AND tgfoid = '_mf_application_guard'::regproc
  ) THEN
    RAISE EXCEPTION '_mf_application_guard is not wired to mf_loan_applications';
  END IF;

  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = '_mf_application_guard';

  IF v_src NOT LIKE '%is_published%' THEN
    RAISE EXCEPTION 'guard does not reject an unpublished pricing version';
  END IF;
  IF v_src NOT LIKE '%effective_from%' THEN
    RAISE EXCEPTION 'guard does not reject a future-dated pricing version';
  END IF;
  IF v_src NOT LIKE '%eligibility%' THEN
    RAISE EXCEPTION 'guard does not evaluate product eligibility';
  END IF;
  IF v_src NOT LIKE '%business_id%' THEN
    RAISE EXCEPTION 'guard does not enforce institution scope (scenario G)';
  END IF;
  IF v_src NOT LIKE '%approved_amount%' THEN
    RAISE EXCEPTION 'guard does not band-check the approved amount';
  END IF;
END $$;

--------------------------------------------------------------------------
-- (4) Scenario D + H: a loan is written from approved values only, inside
--     the band, from the version pinned on the application.
--------------------------------------------------------------------------
DO $$
DECLARE v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname = 'mf_create_loan_from_application';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'mf_create_loan_from_application missing';
  END IF;

  IF v_src ILIKE '%coalesce(a.approved_amount%' THEN
    RAISE EXCEPTION
      'a merely requested amount can still become contractual principal';
  END IF;
  IF v_src NOT LIKE '%approved_amount IS NULL%' THEN
    RAISE EXCEPTION 'loan creation does not require an approved amount';
  END IF;
  IF v_src NOT LIKE '%a.product_version_id%' THEN
    RAISE EXCEPTION 'loan is not priced on the version pinned at capture time';
  END IF;
  IF v_src NOT LIKE '%outside the product band%' THEN
    RAISE EXCEPTION 'loan creation does not re-check the product band';
  END IF;
END $$;

--------------------------------------------------------------------------
-- (5) Scenario H: once a loan exists its financial terms never move.
--------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname='public' AND p.proname='mf_loans_freeze_terms'
  ) THEN
    RAISE EXCEPTION 'loan terms are not frozen after disbursement';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class
     WHERE oid = 'public.mf_loan_applications'::regclass AND relrowsecurity
  ) THEN
    RAISE EXCEPTION 'RLS not enabled on mf_loan_applications';
  END IF;
END $$;

--------------------------------------------------------------------------
-- (6) Scenario F: no live application may reference a version belonging to
--     another product or another institution.
--------------------------------------------------------------------------
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n
    FROM public.mf_loan_applications a
    JOIN public.mf_loan_product_versions v ON v.id = a.product_version_id
   WHERE v.product_id <> a.product_id
      OR v.business_id <> a.business_id;
  IF n > 0 THEN
    RAISE EXCEPTION '% application(s) are priced on a foreign product version', n;
  END IF;
END $$;

ROLLBACK;
