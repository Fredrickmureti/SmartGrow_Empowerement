DO $do$
DECLARE
  v_def text;
  v_old text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'generate_recurring_invoice_occurrence';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'generate_recurring_invoice_occurrence not found';
  END IF;

  v_old := $old$          SELECT COALESCE(p.sales_account_id, v_rev_default) AS acct,
                 ROUND(SUM(i.quantity * i.unit_price * (1 - COALESCE(i.discount_percent,0)/100.0)), 2) AS amt
            FROM public.recurring_invoice_items i
            LEFT JOIN public.products p ON p.id = i.product_id
           WHERE i.recurring_invoice_id = _recurring_id
           GROUP BY COALESCE(p.sales_account_id, v_rev_default)$old$;

  v_new := $new$          -- Canonical ladder: product -> category -> company default.
          SELECT COALESCE(
                   public.resolve_product_gl_account(
                     v_ri.organization_id, v_ri.business_id, i.product_id, 'sales_revenue'),
                   v_rev_default) AS acct,
                 ROUND(SUM(i.quantity * i.unit_price * (1 - COALESCE(i.discount_percent,0)/100.0)), 2) AS amt
            FROM public.recurring_invoice_items i
           WHERE i.recurring_invoice_id = _recurring_id
           GROUP BY 1$new$;

  IF position(v_old IN v_def) = 0 THEN
    RAISE EXCEPTION 'recurring invoice revenue block does not match expected source; refusing to patch blindly';
  END IF;

  EXECUTE replace(v_def, v_old, v_new);
END $do$;