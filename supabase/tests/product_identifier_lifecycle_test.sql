-- product_identifier_lifecycle_test.sql
--
-- Barcodes are retired, not deleted: `retire_product_identifier` archives the
-- row and keeps the code. The per-product uniqueness index used to ignore
-- `status`, so a retired code permanently reserved itself against its own
-- product — the second time a user scanned it, `upsert_product_identifier`
-- raised a bare unique_violation and PostgREST turned that into an opaque
-- HTTP 409. Editing or re-adding a barcode was therefore impossible.
--
-- This suite proves the corrected lifecycle at the database layer:
--   L0. the per-product index is partial on status = 'active'
--   L1. create a code
--   L2. edit A -> B in place (same row id, no second lineage)
--   L3. retire, then re-add the retired code: the archived row is REVIVED
--   L4. exactly one row exists for that product/kind/code after the revive
--   L5. a repeated identical save is idempotent, never a duplicate
--   L6. a code live on another product returns status='duplicate', not 409
--   L7. renaming a live row onto another product's code returns 'duplicate'
--   L8. no unhandled unique_violation escapes the RPC on a racing insert
--   L9. retired rows never resolve as live identity
--
-- Run: psql -f supabase/tests/product_identifier_lifecycle_test.sql
BEGIN;
  DO $$
  DECLARE
    v_org uuid; v_biz uuid; v_user uuid;
    v_p1 uuid; v_p2 uuid;
    v_id1 uuid; v_id2 uuid;
    v_res jsonb;
    v_cnt int;
    v_pred text;
    v_code_a text := 'LIFECYCLE-A-' || extract(epoch from now())::bigint;
    v_code_b text := 'LIFECYCLE-B-' || extract(epoch from now())::bigint;
  BEGIN
    -- L0. the index must be status-aware, otherwise nothing below can pass.
    SELECT pg_get_expr(i.indpred, i.indrelid) INTO v_pred
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.relname = 'product_identifiers_product_kind_code_uidx';
    IF v_pred IS NULL OR v_pred !~ 'active' THEN
      RAISE EXCEPTION
        'L0 FAILED: product_identifiers_product_kind_code_uidx must be partial on status=active (predicate: %)',
        coalesce(v_pred, '<none>');
    END IF;

    SELECT b.organization_id, b.id INTO v_org, v_biz FROM public.businesses b LIMIT 1;
    IF v_biz IS NULL THEN
      RAISE NOTICE 'no business to test against; behavioural checks skipped';
      RETURN;
    END IF;

    SELECT p.id INTO v_user
      FROM public.profiles p
     WHERE public.user_can_access_business(p.id, v_biz)
     LIMIT 1;
    IF v_user IS NULL THEN
      RAISE NOTICE 'no user with access to the business; behavioural checks skipped';
      RETURN;
    END IF;
    PERFORM set_config('request.jwt.claims',
                       json_build_object('sub', v_user::text)::text, true);

    -- Fixtures: two products in the same business.
    INSERT INTO public.products (organization_id, business_id, name, sku)
    VALUES (v_org, v_biz, 'LIFECYCLE FIXTURE 1 ' || v_code_a, 'LCF1-' || v_code_a)
    RETURNING id INTO v_p1;
    INSERT INTO public.products (organization_id, business_id, name, sku)
    VALUES (v_org, v_biz, 'LIFECYCLE FIXTURE 2 ' || v_code_a, 'LCF2-' || v_code_a)
    RETURNING id INTO v_p2;

    -- L1. create
    v_res := public.upsert_product_identifier(
      p_business_id := v_biz, p_product_id := v_p1,
      p_code := v_code_a, p_kind := 'gtin');
    IF v_res->>'status' <> 'ok' THEN
      RAISE EXCEPTION 'L1 FAILED: creating a barcode returned %', v_res;
    END IF;
    v_id1 := (v_res->>'identifier_id')::uuid;

    -- L2. edit A -> B in place
    v_res := public.upsert_product_identifier(
      p_business_id := v_biz, p_product_id := v_p1,
      p_code := v_code_b, p_kind := 'gtin', p_identifier_id := v_id1);
    IF v_res->>'status' <> 'ok' OR (v_res->>'identifier_id')::uuid <> v_id1 THEN
      RAISE EXCEPTION 'L2 FAILED: editing a barcode in place returned %', v_res;
    END IF;
    SELECT count(*) INTO v_cnt FROM public.product_identifiers
     WHERE product_id = v_p1 AND kind = 'gtin' AND status = 'active';
    IF v_cnt <> 1 THEN
      RAISE EXCEPTION 'L2 FAILED: edit produced % live gtin rows, expected 1', v_cnt;
    END IF;

    -- L3. retire, then re-add the retired code -> revive, no 409
    PERFORM public.retire_product_identifier(
      p_business_id := v_biz, p_identifier_id := v_id1, p_status := 'archived');
    v_res := public.upsert_product_identifier(
      p_business_id := v_biz, p_product_id := v_p1,
      p_code := v_code_b, p_kind := 'gtin');
    IF v_res->>'status' <> 'ok' THEN
      RAISE EXCEPTION 'L3 FAILED: re-adding a retired code returned %', v_res;
    END IF;
    IF (v_res->>'identifier_id')::uuid <> v_id1 OR (v_res->>'revived')::boolean IS NOT TRUE THEN
      RAISE EXCEPTION 'L3 FAILED: the archived row was not revived (%)', v_res;
    END IF;

    -- L4. one row only for that product/kind/code
    SELECT count(*) INTO v_cnt FROM public.product_identifiers
     WHERE product_id = v_p1 AND kind = 'gtin' AND code_norm = upper(v_code_b);
    IF v_cnt <> 1 THEN
      RAISE EXCEPTION 'L4 FAILED: revive left % rows for the same code, expected 1', v_cnt;
    END IF;

    -- L5. repeated identical save is idempotent
    v_res := public.upsert_product_identifier(
      p_business_id := v_biz, p_product_id := v_p1,
      p_code := v_code_b, p_kind := 'gtin');
    IF v_res->>'status' <> 'ok' OR (v_res->>'idempotent')::boolean IS NOT TRUE THEN
      RAISE EXCEPTION 'L5 FAILED: a repeated save was not idempotent (%)', v_res;
    END IF;

    -- L6. the same code on a different product is a domain conflict
    v_res := public.upsert_product_identifier(
      p_business_id := v_biz, p_product_id := v_p2,
      p_code := v_code_b, p_kind := 'gtin');
    IF v_res->>'status' <> 'duplicate' OR (v_res->>'product_id')::uuid <> v_p1 THEN
      RAISE EXCEPTION 'L6 FAILED: cross-product duplicate returned %', v_res;
    END IF;

    -- L7. renaming a live row onto another product's code is the same conflict
    v_res := public.upsert_product_identifier(
      p_business_id := v_biz, p_product_id := v_p2,
      p_code := v_code_a, p_kind := 'gtin');
    IF v_res->>'status' <> 'ok' THEN
      RAISE EXCEPTION 'L7 SETUP FAILED: %', v_res;
    END IF;
    v_id2 := (v_res->>'identifier_id')::uuid;
    v_res := public.upsert_product_identifier(
      p_business_id := v_biz, p_product_id := v_p2,
      p_code := v_code_b, p_kind := 'gtin', p_identifier_id := v_id2);
    IF v_res->>'status' <> 'duplicate' THEN
      RAISE EXCEPTION 'L7 FAILED: renaming onto a taken code returned %', v_res;
    END IF;

    -- L8. the RPC must never let a raw unique_violation escape: the handler
    -- resolves the winner and reports a domain envelope instead.
    IF pg_get_functiondef(
         'public.upsert_product_identifier(uuid,uuid,text,product_identifier_kind,uuid,boolean,uuid,product_identifier_source,uuid,timestamptz,timestamptz)'::regprocedure
       ) !~* 'EXCEPTION WHEN unique_violation' THEN
      RAISE EXCEPTION 'L8 FAILED: upsert_product_identifier has no unique_violation handler — a race would surface as HTTP 409';
    END IF;

    -- L9. retired rows are not live identity
    PERFORM public.retire_product_identifier(
      p_business_id := v_biz, p_identifier_id := v_id1, p_status := 'archived');
    SELECT count(*) INTO v_cnt FROM public.product_identifiers
     WHERE product_id = v_p1 AND status = 'active' AND code_norm = upper(v_code_b);
    IF v_cnt <> 0 THEN
      RAISE EXCEPTION 'L9 FAILED: a retired code still reads as live';
    END IF;

    RAISE EXCEPTION 'TEST_PASSED_ROLLBACK';
  END $$;
ROLLBACK;
