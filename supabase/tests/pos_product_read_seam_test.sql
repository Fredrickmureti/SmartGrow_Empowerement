-- POS Phase 1 — product read seam (F10 regression guard).
--
-- `list_products_with_branch_stock` is the ONLY seam POS reads its catalogue
-- from. A plpgsql `RETURN QUERY` must produce the declared row type exactly:
-- a `character varying` source column under a `text` declared column makes
-- EVERY call fail at execution time with
--   "structure of query does not match function result type"
-- and no product can ever reach a terminal. That is what happened when the
-- eTIMS tax columns were added, so the casts are asserted here.

DO $$
DECLARE
  v_src  text;
  v_args text;
  v_col  text;
BEGIN
  -- 1) Exactly one overload, five arguments, unchanged signature.
  SELECT pg_get_function_identity_arguments(p.oid) INTO v_args
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'list_products_with_branch_stock';
  IF v_args IS DISTINCT FROM
     'p_org_id uuid, p_business_id uuid, p_branch_id uuid, p_include_variant_parents boolean, p_warehouse_id uuid' THEN
    RAISE EXCEPTION 'list_products_with_branch_stock signature drifted: %', v_args;
  END IF;

  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'list_products_with_branch_stock') <> 1 THEN
    RAISE EXCEPTION 'more than one list_products_with_branch_stock overload exists';
  END IF;

  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'list_products_with_branch_stock';

  -- 2) Every text-declared column sourced from a possibly-varchar table column
  --    must be explicitly cast in the body.
  FOREACH v_col IN ARRAY ARRAY[
    'p.name::text', 'p.description::text', 'p.sku::text', 'p.image_url::text',
    'p.plu_code::text', 'bu.code::text', 'bu.name::text', 'su.code::text',
    'su.name::text', 'pc.name::text', 'tr.name::text', 'tr.etims_tax_code::text'
  ] LOOP
    IF position(v_col IN v_src) = 0 THEN
      RAISE EXCEPTION 'catalogue seam is missing the explicit cast %', v_col;
    END IF;
  END LOOP;

  -- 3) Authenticated-only surface (SECURITY DEFINER, RLS-bypassing).
  IF has_function_privilege('anon',
       'public.list_products_with_branch_stock(uuid,uuid,uuid,boolean,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute the POS catalogue seam';
  END IF;
  IF NOT has_function_privilege('authenticated',
       'public.list_products_with_branch_stock(uuid,uuid,uuid,boolean,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated cannot execute the POS catalogue seam';
  END IF;

  -- 4) The tenant gate stays: an unauthenticated caller (auth.uid() IS NULL)
  --    must be refused with 42501, never served rows.
  IF position('42501' IN v_src) = 0 OR position('user_has_business_access' IN v_src) = 0 THEN
    RAISE EXCEPTION 'catalogue seam lost its business-access gate';
  END IF;
END $$;
