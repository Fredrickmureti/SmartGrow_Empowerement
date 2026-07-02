-- Tests for the Barcode Enrollment Workspace RPCs:
--   public.enroll_product_barcode(business, product, code, kind)
--   public.revoke_product_barcode(business, product, code)
--   public.flag_product_for_review(business, product, reason)
--
-- Run manually against a non-production database (mirrors the style of
-- supabase/tests/multi_entity_triggers_test.sql):
--   psql "$DATABASE_URL" -f supabase/tests/enroll_product_barcode_test.sql
--
-- Wrapped in BEGIN/ROLLBACK so it leaves no residue. The SECURITY DEFINER
-- functions resolve auth.uid()/user_can_access_business at call time, so
-- we stub both inside the transaction (CREATE OR REPLACE is rolled back
-- with the rest).

BEGIN;

-- ---------- fixtures ----------------------------------------------------
-- Use fixed UUIDs so we can reference them across DO blocks via constants.
-- All NOT NULL / NO-default columns on organizations / businesses /
-- products are supplied (name, slug, country, etc.).

INSERT INTO organizations (id, name, slug)
VALUES ('e1100000-0000-0000-0000-000000000001', 'enroll-test-org', 'enroll-test-org')
ON CONFLICT (id) DO NOTHING;

INSERT INTO businesses (id, organization_id, name, country, base_currency, is_active)
VALUES
  ('e1100000-0000-0000-0000-0000000000a1', 'e1100000-0000-0000-0000-000000000001', 'Biz 1', 'US', 'USD', true),
  ('e1100000-0000-0000-0000-0000000000a2', 'e1100000-0000-0000-0000-000000000001', 'Biz 2', 'US', 'USD', true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO products (id, organization_id, business_id, name, is_active)
VALUES
  ('e1100000-0000-0000-0000-0000000000b1',
   'e1100000-0000-0000-0000-000000000001',
   'e1100000-0000-0000-0000-0000000000a1', 'Product One', true),
  ('e1100000-0000-0000-0000-0000000000b2',
   'e1100000-0000-0000-0000-000000000001',
   'e1100000-0000-0000-0000-0000000000a1', 'Product Two', true)
ON CONFLICT (id) DO NOTHING;

-- Stub auth.uid() and user_can_access_business so the SECURITY DEFINER
-- functions act for a known user that can only access biz 1.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT 'e1100000-0000-0000-0000-0000000000c1'::uuid
$$;

CREATE OR REPLACE FUNCTION public.user_can_access_business(_u uuid, _b uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT _b = 'e1100000-0000-0000-0000-0000000000a1'::uuid
$$;

-- ---------- 1. happy path ------------------------------------------------
DO $$
DECLARE r jsonb;
BEGIN
  r := public.enroll_product_barcode(
    'e1100000-0000-0000-0000-0000000000a1',
    'e1100000-0000-0000-0000-0000000000b1',
    '1234567890123', 'gtin');
  IF (r->>'status') <> 'ok' THEN
    RAISE EXCEPTION 'Test 1 FAILED — first enroll did not return ok: %', r;
  END IF;
  RAISE NOTICE 'Test 1 PASSED — first enroll returns ok';
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM product_identifiers
     WHERE product_id = 'e1100000-0000-0000-0000-0000000000b1'::uuid
       AND code_norm  = '1234567890123'
       AND is_primary = true
  ) THEN
    RAISE EXCEPTION 'Test 2 FAILED — first identifier was not promoted to primary';
  END IF;
  RAISE NOTICE 'Test 2 PASSED — first identifier promoted to primary';
END$$;

-- ---------- 2. idempotent re-call ---------------------------------------
DO $$
DECLARE r jsonb;
BEGIN
  r := public.enroll_product_barcode(
    'e1100000-0000-0000-0000-0000000000a1',
    'e1100000-0000-0000-0000-0000000000b1',
    '1234567890123', 'gtin');
  IF (r->>'idempotent') <> 'true' THEN
    RAISE EXCEPTION 'Test 3 FAILED — second enroll of same code not idempotent: %', r;
  END IF;
  RAISE NOTICE 'Test 3 PASSED — idempotent re-call';
END$$;

-- ---------- 3. duplicate against a DIFFERENT product --------------------
DO $$
DECLARE r jsonb;
BEGIN
  r := public.enroll_product_barcode(
    'e1100000-0000-0000-0000-0000000000a1',
    'e1100000-0000-0000-0000-0000000000b2',
    '1234567890123', 'gtin');
  IF (r->>'status') <> 'duplicate' THEN
    RAISE EXCEPTION 'Test 4 FAILED — same code on different product not flagged duplicate: %', r;
  END IF;
  IF (r->>'conflict_product_name') <> 'Product One' THEN
    RAISE EXCEPTION 'Test 5 FAILED — duplicate envelope missing conflict_product_name: %', r;
  END IF;
  RAISE NOTICE 'Test 4+5 PASSED — duplicate detection with conflict name';
END$$;

-- ---------- 4. forbidden cross-business ---------------------------------
DO $$
DECLARE r jsonb;
BEGIN
  r := public.enroll_product_barcode(
    'e1100000-0000-0000-0000-0000000000a2', -- biz 2 (user lacks access)
    'e1100000-0000-0000-0000-0000000000b1',
    '9999999999999', 'gtin');
  IF (r->>'reason') <> 'forbidden' THEN
    RAISE EXCEPTION 'Test 6 FAILED — cross-business not rejected: %', r;
  END IF;
  RAISE NOTICE 'Test 6 PASSED — cross-business forbidden';
END$$;

-- ---------- 5. empty / oversize code ------------------------------------
DO $$
DECLARE r jsonb;
BEGIN
  r := public.enroll_product_barcode(
    'e1100000-0000-0000-0000-0000000000a1',
    'e1100000-0000-0000-0000-0000000000b1',
    '   ', 'gtin');
  IF (r->>'reason') <> 'empty_code' THEN
    RAISE EXCEPTION 'Test 7 FAILED — empty code not rejected: %', r;
  END IF;
  RAISE NOTICE 'Test 7 PASSED — empty code rejected';
END$$;

DO $$
DECLARE r jsonb;
BEGIN
  r := public.enroll_product_barcode(
    'e1100000-0000-0000-0000-0000000000a1',
    'e1100000-0000-0000-0000-0000000000b1',
    repeat('X', 65), 'gtin');
  IF (r->>'reason') <> 'code_too_long' THEN
    RAISE EXCEPTION 'Test 8 FAILED — oversize code not rejected: %', r;
  END IF;
  RAISE NOTICE 'Test 8 PASSED — oversize code rejected';
END$$;

-- ---------- 6. revoke + promote-next ------------------------------------
DO $$
DECLARE r jsonb;
BEGIN
  -- Add a second identifier (will be non-primary because there is already one).
  PERFORM public.enroll_product_barcode(
    'e1100000-0000-0000-0000-0000000000a1',
    'e1100000-0000-0000-0000-0000000000b1',
    'SECOND-CODE', 'gtin');
  -- Revoke the original primary.
  r := public.revoke_product_barcode(
    'e1100000-0000-0000-0000-0000000000a1',
    'e1100000-0000-0000-0000-0000000000b1',
    '1234567890123');
  IF (r->>'status') <> 'ok' THEN
    RAISE EXCEPTION 'Test 9 FAILED — revoke primary did not return ok: %', r;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM product_identifiers
     WHERE product_id = 'e1100000-0000-0000-0000-0000000000b1'::uuid
       AND code_norm  = 'SECOND-CODE'
       AND is_primary = true
  ) THEN
    RAISE EXCEPTION 'Test 9 FAILED — remaining identifier was not promoted to primary';
  END IF;
  RAISE NOTICE 'Test 9 PASSED — revoke + promote-next';
END$$;

-- ---------- 7. flag_product_for_review ----------------------------------
DO $$
DECLARE r jsonb;
BEGIN
  r := public.flag_product_for_review(
    'e1100000-0000-0000-0000-0000000000a1',
    'e1100000-0000-0000-0000-0000000000b2',
    'needs label printing');
  IF (r->>'status') <> 'ok' THEN
    RAISE EXCEPTION 'Test 10 FAILED — flag did not return ok: %', r;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM products
     WHERE id = 'e1100000-0000-0000-0000-0000000000b2'::uuid
       AND review_reason = 'needs label printing'
  ) THEN
    RAISE EXCEPTION 'Test 10 FAILED — review_reason not persisted';
  END IF;
  RAISE NOTICE 'Test 10 PASSED — flag_product_for_review';
END$$;

-- ---------- 8. flag forbidden cross-business ----------------------------
DO $$
DECLARE r jsonb;
BEGIN
  r := public.flag_product_for_review(
    'e1100000-0000-0000-0000-0000000000a2',
    'e1100000-0000-0000-0000-0000000000b2',
    'should be rejected');
  IF (r->>'status') <> 'forbidden' THEN
    RAISE EXCEPTION 'Test 11 FAILED — flag cross-business not rejected: %', r;
  END IF;
  RAISE NOTICE 'Test 11 PASSED — flag cross-business forbidden';
END$$;

ROLLBACK;
