DO $mig$
DECLARE
  r record;
  d text;
  nd text;
  fixed int := 0;
  skipped text[] := ARRAY[]::text[];
BEGIN
  FOR r IN
    SELECT p.oid, p.oid::regprocedure::text AS sig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('void_invoice_atomic','void_payment_atomic','get_document_settlement_lineage','preview_reversal_consequences_core')
  LOOP
    d := pg_get_functiondef(r.oid);
    nd := d;
    nd := replace(nd, 'je.status NOT IN (''voided'', ''reversed'')', 'je.status <> ''void''');
    nd := replace(nd, 'je.status NOT IN (''voided'',''reversed'')', 'je.status <> ''void''');
    nd := replace(nd, 'je.status::text NOT IN (''voided'', ''reversed'')', 'je.status::text <> ''void''');
    nd := replace(nd, 'COALESCE(je.status, '''') <> ''voided''', 'je.status <> ''void''');
    IF nd <> d THEN
      BEGIN
        EXECUTE nd;
        fixed := fixed + 1;
        RAISE NOTICE 'patched %', r.sig;
      EXCEPTION WHEN others THEN
        skipped := skipped || (r.sig || ' -> ' || SQLERRM);
      END;
    END IF;
  END LOOP;

  RAISE NOTICE 'corrected % routine(s); skipped: %', fixed, skipped;
END
$mig$;