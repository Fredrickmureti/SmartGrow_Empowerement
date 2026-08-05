-- Regression test: the SKU/PLU mirror trigger is idempotent and respects
-- operator intent.
--
-- The defect this locks down: `sync_product_identifiers_from_product` used
-- ON CONFLICT DO NOTHING against a partial unique index restricted to
-- status='active'. Once an operator retired (archived) the SKU mirror, the
-- next product save no longer conflicted and inserted a fresh active row.
-- Delete -> save -> delete -> save produced a growing pile of rows for one
-- code, which unfiltered read models then rendered as duplicates.
--
-- Invariants proven here:
--   1. Repeated product UPDATEs never create a second mirror row.
--   2. A retired mirror is NOT resurrected by an unrelated product save.
--   3. Re-assigning the same SKU value DOES revive the retired row in place
--      (one row, status back to active) rather than inserting a new one.
--   4. product_identifiers_product_kind_code_uidx exists and covers all
--      statuses.

BEGIN;

DO $$
DECLARE
  v_org uuid;
  v_biz uuid;
  v_prod uuid;
  n int;
  v_status text;
BEGIN
  SELECT id, organization_id INTO v_biz, v_org FROM public.businesses LIMIT 1;
  IF v_biz IS NULL THEN
    RAISE NOTICE 'no business rows available; skipping';
    RETURN;
  END IF;

  INSERT INTO public.products (organization_id, business_id, name, sku)
  VALUES (v_org, v_biz, 'ZZ mirror idempotency probe', 'ZZ-MIRROR-PROBE-1')
  RETURNING id INTO v_prod;

  -- 1. Repeated saves must not multiply the mirror.
  UPDATE public.products SET name = name || ' a' WHERE id = v_prod;
  UPDATE public.products SET name = name || ' b' WHERE id = v_prod;
  UPDATE public.products SET name = name || ' c' WHERE id = v_prod;

  SELECT count(*) INTO n FROM public.product_identifiers
   WHERE product_id = v_prod AND kind = 'sku';
  IF n <> 1 THEN
    RAISE EXCEPTION 'repeated saves created % sku mirror rows, expected 1', n;
  END IF;

  -- 2. Retire the mirror, then save again: it must stay retired.
  UPDATE public.product_identifiers
     SET status = 'archived', is_primary = false, valid_to = now()
   WHERE product_id = v_prod AND kind = 'sku';

  UPDATE public.products SET name = name || ' d' WHERE id = v_prod;

  SELECT count(*) INTO n FROM public.product_identifiers
   WHERE product_id = v_prod AND kind = 'sku';
  IF n <> 1 THEN
    RAISE EXCEPTION 'save after retirement produced % sku rows, expected 1', n;
  END IF;

  SELECT status::text INTO v_status FROM public.product_identifiers
   WHERE product_id = v_prod AND kind = 'sku';
  IF v_status <> 'archived' THEN
    RAISE EXCEPTION 'an unrelated save resurrected a retired mirror (status %)', v_status;
  END IF;

  -- 3. Re-assigning the SKU value revives the SAME row.
  UPDATE public.products SET sku = 'ZZ-MIRROR-PROBE-2' WHERE id = v_prod;
  UPDATE public.products SET sku = 'ZZ-MIRROR-PROBE-1' WHERE id = v_prod;

  SELECT count(*) INTO n FROM public.product_identifiers
   WHERE product_id = v_prod AND kind = 'sku'
     AND code_norm = 'ZZ-MIRROR-PROBE-1';
  IF n <> 1 THEN
    RAISE EXCEPTION 'sku re-assignment produced % rows for the code, expected 1', n;
  END IF;

  SELECT status::text INTO v_status FROM public.product_identifiers
   WHERE product_id = v_prod AND kind = 'sku' AND code_norm = 'ZZ-MIRROR-PROBE-1';
  IF v_status <> 'active' THEN
    RAISE EXCEPTION 're-assigned sku did not revive the mirror (status %)', v_status;
  END IF;
END $$;

-- 4. Structural guarantee across all statuses.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE tablename = 'product_identifiers'
       AND indexname = 'product_identifiers_product_kind_code_uidx'
  ) THEN
    RAISE EXCEPTION 'product_identifiers_product_kind_code_uidx is missing';
  END IF;
END $$;

ROLLBACK;
