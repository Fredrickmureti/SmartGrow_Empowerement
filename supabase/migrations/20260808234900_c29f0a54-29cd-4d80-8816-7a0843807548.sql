DO $$
DECLARE d text; r record;
BEGIN
  FOR r IN
    SELECT oid FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace
      AND proname IN ('create_proforma_atomic','set_proforma_status_atomic','convert_proforma_to_invoice_atomic','proforma_block_converted_delete')
  LOOP
    d := pg_get_functiondef(r.oid);
    d := replace(d, '''create'', ''proforma_invoice''', '''created'', ''proforma_invoice''');
    d := replace(d, '''status_change'', ''proforma_invoice''', '''status_changed'', ''proforma_invoice''');
    d := replace(d, '''convert'', ''proforma_invoice''', '''converted'', ''proforma_invoice''');
    d := replace(d, '''delete'', ''proforma_invoice''', '''deleted'', ''proforma_invoice''');
    EXECUTE d;
  END LOOP;
END $$;