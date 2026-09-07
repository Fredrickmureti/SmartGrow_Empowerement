DO $$
DECLARE r record; kept int := 0; dropped int := 0;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure::text AS sig, p.proname
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind = 'f'
      AND p.proname !~ '^_?mf_'
      AND p.proname ~ '(^|_)(wms|pos|payroll|payslip|physical_count|uom|leave|attendance)($|_)|sales_order|sales_return|delivery_note|goods_receipt|purchase_order|(^|_)invoice|estimate|credit_note|proforma|(^|_)product|(^|_)stock|inventory|warehouse|picking|putaway|crossdock|lpn|serial|lot_'
      AND p.proname NOT IN (
        'check_low_stock_products',
        'payroll_payment_item_mark_failed',
        'payroll_payment_item_mark_paid',
        'payslip_header',
        'reconcile_inventory_subledger_to_gl',
        'record_multi_invoice_payment',
        'seed_pos_defaults_for_business'
      )
      AND NOT EXISTS (
        SELECT 1 FROM pg_trigger tg WHERE tg.tgfoid = p.oid AND NOT tg.tgisinternal
      )
  LOOP
    BEGIN
      EXECUTE format('DROP FUNCTION %s', r.sig);
      dropped := dropped + 1;
    EXCEPTION WHEN dependent_objects_still_exist OR undefined_function THEN
      kept := kept + 1;
    END;
  END LOOP;
  RAISE NOTICE 'legacy function cleanup: dropped=%, kept=%', dropped, kept;
END $$;