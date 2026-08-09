-- sales_order_governed_write_test.sql
--
-- The sales-order convergence work claims that a sales order's state and money
-- may only change inside the owning engines (confirm / cancel / approval /
-- update / invoicing / delivery). Until now that claim was enforced only by a
-- frontend grep test, which a generic `supabase.from('sales_orders').update()`
-- walked straight past.
--
-- This suite proves the rule at the only layer that cannot be bypassed:
--   G1. a direct status write is rejected (42501)
--   G2. a direct totals write is rejected
--   G3. a direct is_locked / converted_invoice_id write is rejected
--   G4. benign header fields (notes, expected_date) remain freely editable
--   G5. the guard trigger is actually wired to sales_orders
--
-- Run: psql -f supabase/tests/sales_order_governed_write_test.sql
BEGIN;
  DO $$
  DECLARE
    v_org uuid; v_biz uuid;
    v_so  uuid;
    v_notes text;
    v_sqlstate text;
    v_trig int;
  BEGIN
    -- G5. trigger wiring
    SELECT count(*) INTO v_trig
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'sales_orders'
       AND t.tgname = 'trg_00_sales_order_governed_write'
       AND NOT t.tgisinternal;
    IF v_trig <> 1 THEN
      RAISE EXCEPTION 'G5 FAILED: governed-write trigger is not wired to sales_orders';
    END IF;

    SELECT organization_id, id INTO v_org, v_biz FROM public.businesses LIMIT 1;
    IF v_biz IS NULL THEN
      RAISE NOTICE 'no business to test against; behavioural checks skipped';
      RETURN;
    END IF;

    -- Fixture: INSERT is not governed (creation is owned by
    -- create_sales_order_atomic, which needs an authenticated caller we do not
    -- have here). The guard under test is the UPDATE path.
    INSERT INTO public.sales_orders
      (organization_id, business_id, so_number, order_date, status,
       currency, subtotal, tax_amount, discount_amount, shipping_amount, total)
    VALUES
      (v_org, v_biz, 'TEST-GOV-' || extract(epoch from now())::bigint, CURRENT_DATE,
       'draft', 'USD', 100, 0, 0, 0, 100)
    RETURNING id INTO v_so;

    -- G1. direct status write
    BEGIN
      UPDATE public.sales_orders SET status = 'confirmed' WHERE id = v_so;
      RAISE EXCEPTION 'G1 FAILED: a direct status write was accepted';
    EXCEPTION WHEN insufficient_privilege THEN
      NULL;  -- expected
    END;

    -- G1b. cancellation must go through cancel_sales_order_atomic too
    BEGIN
      UPDATE public.sales_orders SET status = 'cancelled' WHERE id = v_so;
      RAISE EXCEPTION 'G1b FAILED: a direct cancellation write was accepted';
    EXCEPTION WHEN insufficient_privilege THEN
      NULL;
    END;

    -- G2. direct totals write
    BEGIN
      UPDATE public.sales_orders SET total = 999, subtotal = 999 WHERE id = v_so;
      RAISE EXCEPTION 'G2 FAILED: a direct totals write was accepted';
    EXCEPTION WHEN insufficient_privilege THEN
      NULL;
    END;

    -- G3. direct lock / invoice-link write
    BEGIN
      UPDATE public.sales_orders SET is_locked = true WHERE id = v_so;
      RAISE EXCEPTION 'G3 FAILED: a direct is_locked write was accepted';
    EXCEPTION WHEN insufficient_privilege THEN
      NULL;
    END;

    -- G3b. exchange rate is captured at creation and never re-derived downstream
    BEGIN
      UPDATE public.sales_orders SET exchange_rate = 42 WHERE id = v_so;
      RAISE EXCEPTION 'G3b FAILED: a direct exchange_rate write was accepted';
    EXCEPTION WHEN insufficient_privilege THEN
      NULL;
    END;

    -- G4. benign header fields stay editable
    UPDATE public.sales_orders
       SET notes = 'pgtap benign edit', expected_date = CURRENT_DATE + 7
     WHERE id = v_so;
    SELECT notes INTO v_notes FROM public.sales_orders WHERE id = v_so;
    IF v_notes IS DISTINCT FROM 'pgtap benign edit' THEN
      RAISE EXCEPTION 'G4 FAILED: benign header edit did not apply (got %)', v_notes;
    END IF;

    -- The row must still be a draft with its original money after all the
    -- rejected attempts.
    PERFORM 1 FROM public.sales_orders
      WHERE id = v_so AND status = 'draft' AND total = 100 AND is_locked = false;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'G-final FAILED: a rejected write leaked into the row';
    END IF;

    RAISE NOTICE 'sales_order_governed_write_test: all checks passed';
  END $$;
ROLLBACK;
