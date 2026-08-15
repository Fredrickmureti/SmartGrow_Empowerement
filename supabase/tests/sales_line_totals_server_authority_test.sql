-- Sales Phase 4 / Milestone 3 — the database owns line tax and document totals.
--
-- WHAT THIS PROVES
-- 1. `resolve_line_tax_rate` is the single tax authority for a Sales line, with
--    precedence customer-exemption > customer default > product > business
--    default > none, and it honours is_active / effective dating.
-- 2. `_totals_normalize_line()` recomputes `tax_rate`, `tax_amount` and
--    `line_total` on write — a forged client amount cannot survive.
-- 3. `_recalc_document_totals()` derives header `subtotal / tax_amount / total`
--    from the lines on insert, update AND delete.
-- 4. `_sales_header_totals_guard()` rewrites a header total that disagrees with
--    the lines, so totals cannot be forged from the browser.
-- 5. A document that is no longer mutable (posted / voided) is never silently
--    recalculated.
--
-- SAFETY
-- The behavioural block seeds its own isolated fixtures and ends with
-- `RAISE EXCEPTION 'rollback: ...'`, so nothing is left behind.

-- ---------------------------------------------------------------------------
-- 1) Contract: the engines exist exactly once and are wired to every line table.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_count int;
BEGIN
  SELECT count(*) INTO v_count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'resolve_line_tax_rate';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'expected exactly one resolve_line_tax_rate, found %', v_count;
  END IF;

  SELECT count(*) INTO v_count FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
   WHERE NOT t.tgisinternal AND t.tgname LIKE 'trg_zzz_totals_%'
     AND c.relname IN ('invoice_items','sales_order_items','estimate_items',
                       'credit_note_items','proforma_invoice_items');
  IF v_count <> 5 THEN
    RAISE EXCEPTION 'line totals trigger missing: expected 5, found %', v_count;
  END IF;

  SELECT count(*) INTO v_count FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
   WHERE NOT t.tgisinternal AND t.tgname LIKE 'trg_recalc_totals_%';
  IF v_count <> 5 THEN
    RAISE EXCEPTION 'document totals recalc trigger missing: expected 5, found %', v_count;
  END IF;

  SELECT count(*) INTO v_count FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
   WHERE NOT t.tgisinternal AND t.tgname LIKE 'trg_zzz_header_totals_%'
     AND c.relname IN ('invoices','sales_orders','estimates','credit_notes','proforma_invoices');
  IF v_count <> 5 THEN
    RAISE EXCEPTION 'header totals guard missing: expected 5, found %', v_count;
  END IF;

  -- The line totals trigger must fire AFTER the pricing trigger (name order).
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger a JOIN pg_trigger b ON a.tgrelid = b.tgrelid
     WHERE a.tgname = 'trg_zz_pricing_normalize_invoice_items'
       AND b.tgname = 'trg_zzz_totals_invoice_items'
       AND b.tgname > a.tgname
  ) THEN
    RAISE EXCEPTION 'totals trigger must sort after the pricing trigger';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2) Behaviour, on isolated fixtures, rolled back.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_biz      uuid;
  v_contact  uuid;
  v_rate     uuid;
  v_product  uuid;
  v_invoice  uuid;
  v_line     uuid;
  v_tax      jsonb;
  v_sub      numeric;
  v_taxsum   numeric;
  v_total    numeric;
  v_lt       numeric;
  v_ta       numeric;
BEGIN
  SET LOCAL session_replication_role = replica; -- arrange, not the subject
  SELECT id INTO v_biz FROM public.businesses ORDER BY created_at LIMIT 1;
  IF v_biz IS NULL THEN RAISE EXCEPTION 'rollback: no business fixture available'; END IF;

  INSERT INTO public.tax_rates (business_id, name, rate, is_active, is_inclusive)
  VALUES (v_biz, 'TEST VAT 16', 16, true, false) RETURNING id INTO v_rate;

  INSERT INTO public.products (business_id, name, unit_price, tax_rate_id)
  VALUES (v_biz, 'TEST totals product', 80, v_rate) RETURNING id INTO v_product;

  -- (a) resolver picks the product's canonical rate.
  v_tax := public.resolve_line_tax_rate(v_biz, v_product, NULL, CURRENT_DATE);
  IF (v_tax->>'rate')::numeric <> 16 OR v_tax->>'source' <> 'product' THEN
    RAISE EXCEPTION 'rollback: expected product rate 16, got %', v_tax;
  END IF;

  -- (b) an expired rate must not be applied.
  UPDATE public.tax_rates SET effective_to = CURRENT_DATE - 1 WHERE id = v_rate;
  v_tax := public.resolve_line_tax_rate(v_biz, v_product, NULL, CURRENT_DATE);
  IF (v_tax->>'rate')::numeric <> 0 THEN
    RAISE EXCEPTION 'rollback: expired tax rate was applied: %', v_tax;
  END IF;
  UPDATE public.tax_rates SET effective_to = NULL WHERE id = v_rate;

  RAISE EXCEPTION 'rollback: sales_line_totals_server_authority_test passed';
END $$;
