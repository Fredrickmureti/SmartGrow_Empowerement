-- Phase 5B guard: supplier_item_terms is the canonical owner of purchasing
-- terms; products.min_order_quantity / order_quantity_increment are only
-- deprecated fallbacks; the arithmetic lives in SQL, not the browser.
--
-- Structural probes run unconditionally. Behavioural probes call the resolver
-- internals directly where auth.uid() is unavailable in a test session, so the
-- tenant gate is asserted separately by shape rather than by execution.

BEGIN;

-- 1. Columns and constraint exist.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='supplier_item_terms'
                    AND column_name='order_increment') THEN
    RAISE EXCEPTION 'supplier_item_terms.order_increment is missing';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='supplier_item_terms'
                    AND column_name='purchase_uom_id') THEN
    RAISE EXCEPTION 'supplier_item_terms.purchase_uom_id is missing';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname='supplier_item_terms_order_increment_positive') THEN
    RAISE EXCEPTION 'order_increment positivity constraint is missing';
  END IF;
END $$;

-- 2. purchase_uom_id references the existing UoM table (no second UoM concept).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class ft ON ft.oid = c.confrelid
    WHERE c.conrelid = 'public.supplier_item_terms'::regclass
      AND c.contype = 'f'
      AND ft.relname = 'units_of_measure'
  ) THEN
    RAISE EXCEPTION 'purchase_uom_id must FK units_of_measure';
  END IF;
END $$;

-- 3. Both functions exist, are SECURITY DEFINER, tenant-gated, and not
--    executable by anon/PUBLIC.
DO $$
DECLARE
  v_def text;
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY['resolve_supplier_purchasing_terms',
                            'validate_supplier_order_quantity'] LOOP
    SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname='public' AND p.proname = fn;

    IF v_def IS NULL THEN
      RAISE EXCEPTION 'function public.% is missing', fn;
    END IF;
    IF v_def !~ 'SECURITY DEFINER' THEN
      RAISE EXCEPTION '% must be SECURITY DEFINER', fn;
    END IF;

    IF has_function_privilege('anon', format('public.%s(%s)', fn,
         pg_get_function_identity_arguments(
           (SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
             WHERE n.nspname='public' AND p.proname=fn LIMIT 1))), 'EXECUTE') THEN
      RAISE EXCEPTION '% must not be executable by anon', fn;
    END IF;
  END LOOP;

  -- The tenant gate must be inside the resolver, not left to the caller.
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='resolve_supplier_purchasing_terms';
  IF v_def !~ 'user_has_business_access' THEN
    RAISE EXCEPTION 'resolve_supplier_purchasing_terms is not tenant-gated';
  END IF;
  IF v_def !~ 'SUPPLIER_TERMS_PRODUCT_NOT_FOUND' THEN
    RAISE EXCEPTION 'resolver must refuse a product outside the business';
  END IF;
END $$;

-- 4. Provenance: the resolver must prefer supplier values and label the source.
DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='resolve_supplier_purchasing_terms';

  IF v_def !~ 'COALESCE\(v_t\.min_order_qty, v_p\.min_order_quantity' THEN
    RAISE EXCEPTION 'supplier MOQ must win over the product default';
  END IF;
  IF v_def !~ 'COALESCE\(v_t\.order_increment, v_p\.order_quantity_increment' THEN
    RAISE EXCEPTION 'supplier increment must win over the product default';
  END IF;
  IF v_def !~ 'product_default' THEN
    RAISE EXCEPTION 'resolver must report value provenance';
  END IF;
  -- Effective dating is mandatory: expired terms must fall back.
  IF v_def !~ 'effective_from <= p_on_date' OR v_def !~ 'effective_to IS NULL OR' THEN
    RAISE EXCEPTION 'resolver must honour effective dating';
  END IF;
END $$;

-- 5. Validation arithmetic lives in SQL, with the three named refusals.
DO $$
DECLARE
  v_def text;
  code text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='validate_supplier_order_quantity';

  FOREACH code IN ARRAY ARRAY['QUANTITY_NOT_POSITIVE',
                              'BELOW_MIN_ORDER_QTY',
                              'NOT_ON_ORDER_INCREMENT'] LOOP
    IF v_def !~ code THEN
      RAISE EXCEPTION 'validate_supplier_order_quantity is missing refusal %', code;
    END IF;
  END LOOP;

  IF v_def !~ 'resolve_supplier_purchasing_terms' THEN
    RAISE EXCEPTION 'validation must read terms through the single resolver';
  END IF;
END $$;

-- 6. Live data sanity: no active terms row carries a non-positive increment,
--    and no terms row points at another tenant's UoM.
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.supplier_item_terms
   WHERE order_increment IS NOT NULL AND order_increment <= 0;
  IF n > 0 THEN
    RAISE EXCEPTION '% supplier terms rows carry a non-positive order increment', n;
  END IF;

  SELECT count(*) INTO n
  FROM public.supplier_item_terms t
  JOIN public.units_of_measure u ON u.id = t.purchase_uom_id
  WHERE u.business_id IS NOT NULL AND u.business_id <> t.business_id;
  IF n > 0 THEN
    RAISE EXCEPTION '% supplier terms rows reference a foreign-tenant UoM', n;
  END IF;
END $$;

-- 7. Phase 3: the resolver accepts a purchasing party (contacts.id) as well as
--    the supplier role, so Purchases documents (vendor_id -> contacts.id,
--    ADR-0079) never map party -> role in the browser.
DO $$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='_resolve_supplier_role_id';
  IF v_def IS NULL THEN
    RAISE EXCEPTION '_resolve_supplier_role_id is missing';
  END IF;
  IF v_def !~ 'contact_id' THEN
    RAISE EXCEPTION '_resolve_supplier_role_id must accept a party contact id';
  END IF;
  IF has_function_privilege('anon', 'public._resolve_supplier_role_id(uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '_resolve_supplier_role_id must not be executable by anon';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='resolve_supplier_purchasing_terms';
  IF v_def !~ '_resolve_supplier_role_id' THEN
    RAISE EXCEPTION 'resolver must translate a supplier party into the supplier role';
  END IF;
END $$;

ROLLBACK;
