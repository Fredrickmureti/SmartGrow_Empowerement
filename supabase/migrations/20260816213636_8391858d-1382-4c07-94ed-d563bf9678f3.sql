-- preview_reversal_consequences_core reported the TEXT basis label as a money
-- "unit_cost" for goods-receipt reversals. Point it at the canonical cost
-- resolver instead (surgical replace of that one expression).
DO $do$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'preview_reversal_consequences_core';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'preview_reversal_consequences_core not found';
  END IF;
  IF position('MAX(gi.unit_cost_basis)' in v_def) = 0 THEN
    RAISE NOTICE 'nothing to patch';
    RETURN;
  END IF;

  v_def := replace(v_def, 'MAX(gi.unit_cost_basis)',
                          'MAX(public.goods_receipt_line_base_unit_cost(gi.id))');
  EXECUTE v_def;
END
$do$;

-- Guard: no function may ever read goods_receipt_items.unit_cost_basis (a TEXT
-- basis label) as an amount again.
CREATE OR REPLACE FUNCTION public.assert_no_receipt_cost_basis_as_money()
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $fn$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.proname, p.prosrc
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname <> 'goods_receipt_line_base_unit_cost'
       AND p.proname <> 'assert_no_receipt_cost_basis_as_money'
       AND p.prosrc ~* '(gri|gi|v_grn_item|grn_item)\.unit_cost_basis'
  LOOP
    RAISE EXCEPTION
      '% reads goods_receipt_items.unit_cost_basis (a TEXT basis label) directly; use public.goods_receipt_line_base_unit_cost(id)',
      r.proname;
  END LOOP;
END
$fn$;

GRANT EXECUTE ON FUNCTION public.assert_no_receipt_cost_basis_as_money() TO service_role;

-- Fail this migration if the invariant is already broken elsewhere.
DO $chk$ BEGIN PERFORM public.assert_no_receipt_cost_basis_as_money(); END $chk$;