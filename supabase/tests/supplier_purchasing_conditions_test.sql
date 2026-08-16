-- Guard: supplier purchasing CONDITIONS (price + quantity policy) have one
-- server-side owner, one price precedence, and governance/provenance wiring.
--
-- Run: psql -f supabase/tests/supplier_purchasing_conditions_test.sql

BEGIN;

-- 1. The terms resolver applies price breaks (it must read price_break_tiers)
--    and accepts the quantity that selects the tier.
DO $$
DECLARE v_src text; v_args text;
BEGIN
  SELECT p.prosrc, pg_get_function_identity_arguments(p.oid)
    INTO v_src, v_args
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'resolve_supplier_purchasing_terms';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'resolve_supplier_purchasing_terms is missing';
  END IF;
  IF v_src NOT LIKE '%price_break_tiers%' THEN
    RAISE EXCEPTION 'the terms resolver ignores price_break_tiers again';
  END IF;
  IF v_args NOT LIKE '%p_quantity%' THEN
    RAISE EXCEPTION 'the terms resolver cannot select a tier without a quantity';
  END IF;
  IF v_args NOT LIKE '%p_branch_id%' THEN
    RAISE EXCEPTION 'the terms resolver is not branch-aware';
  END IF;
END $$;

-- 2. ONE purchase price authority, with contract precedence inside it.
DO $$
DECLARE v_src text; v_secdef boolean; v_acl text;
BEGIN
  SELECT p.prosrc, p.prosecdef, COALESCE(array_to_string(p.proacl, ','), '')
    INTO v_src, v_secdef, v_acl
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = '_resolve_purchase_line_price';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'the purchase price authority is missing';
  END IF;
  IF v_src NOT LIKE '%procurement_contract_lines%' THEN
    RAISE EXCEPTION 'the price authority does not consider contract lines';
  END IF;
  IF v_src NOT LIKE '%resolve_supplier_purchasing_terms%' THEN
    RAISE EXCEPTION 'the price authority re-derives supplier terms instead of reusing the resolver';
  END IF;
  IF position('procurement_contract_lines' in v_src)
     > position('resolve_supplier_purchasing_terms' in v_src) THEN
    RAISE EXCEPTION 'contract price no longer outranks standing supplier terms';
  END IF;
  IF NOT v_secdef THEN
    RAISE EXCEPTION 'the price authority must be SECURITY DEFINER';
  END IF;
  IF v_acl LIKE '%anon=%' THEN
    RAISE EXCEPTION 'the price authority is executable by anon';
  END IF;
END $$;

-- 3. Exactly one write path, and it is governed: approvals, audit, events.
DO $$
DECLARE v_count int; v_src text;
BEGIN
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'upsert_supplier_item_terms';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'expected exactly one upsert_supplier_item_terms, found %', v_count;
  END IF;

  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'upsert_supplier_item_terms';

  IF v_src NOT LIKE '%approval_route%' THEN
    RAISE EXCEPTION 'supplier condition writes bypass the approval engine';
  END IF;
  IF v_src NOT LIKE '%audit_logs%' THEN
    RAISE EXCEPTION 'supplier condition writes are not audited';
  END IF;
  IF v_src NOT LIKE '%_sit_emit%' THEN
    RAISE EXCEPTION 'supplier condition writes publish no business event';
  END IF;
END $$;

-- 4. The action key is registered, otherwise approval_route raises.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.governance_action_registry
     WHERE action_key = 'supplier_terms.amend' AND is_active
  ) THEN
    RAISE EXCEPTION 'supplier_terms.amend is not registered as a governed action';
  END IF;
END $$;

-- 5. Purchase order lines keep price provenance.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'purchase_order_items'
       AND column_name IN ('supplier_terms_id','price_source')
     GROUP BY table_name HAVING count(*) = 2
  ) THEN
    RAISE EXCEPTION 'purchase_order_items lost its price provenance columns';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger tg
      JOIN pg_class c ON c.oid = tg.tgrelid
      JOIN pg_proc p  ON p.oid = tg.tgfoid
     WHERE NOT tg.tgisinternal
       AND c.relname = 'purchase_order_items'
       AND p.proname = '_po_item_stamp_price_provenance'
  ) THEN
    RAISE EXCEPTION 'purchase order lines are no longer stamped with price provenance';
  END IF;
END $$;

-- 6. Branch scope is part of the overlap guard.
DO $$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = '_validate_supplier_item_terms';
  IF v_src NOT LIKE '%branch_id IS NOT DISTINCT FROM NEW.branch_id%' THEN
    RAISE EXCEPTION 'the overlap guard ignores branch scope again';
  END IF;
END $$;

-- 7. Effective status is derived on the server and closed to anon.
DO $$
DECLARE v_acl text; v_kind char;
BEGIN
  SELECT COALESCE(array_to_string(p.proacl, ','), ''), p.prokind
    INTO v_acl, v_kind
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'effective_status'
     AND p.proargtypes::regtype[] = ARRAY['public.supplier_item_terms'::regtype];

  IF v_kind IS NULL THEN
    RAISE EXCEPTION 'public.effective_status(supplier_item_terms) is missing — the browser would recompute validity';
  END IF;
  IF v_acl LIKE '%anon=%' THEN
    RAISE EXCEPTION 'effective_status is executable by anon';
  END IF;
END $$;

ROLLBACK;
